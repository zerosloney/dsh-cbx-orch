import { appendFileSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import { loadRuntimeExecutorsAllowlist } from "./storage.js";
import { jobContext, type ActiveProcessHandle } from "./job-runtime.js";
import { writePidRecord } from "./pid-guard.js";
import {
  MAX_CAPTURE_BYTES,
  ProcessTreeTerminationError,
  type ProcessResult,
  type ProcessSpawn,
} from "./process-runner.js";

const TREE_QUIESCE_TIMEOUT_MS = 7_000;

/**
 * 执行器/测试子进程的环境变量继承策略。
 *
 * 默认（全局未设置 + 工作区未配置）= 完整继承宿主的 process.env（与终端直接运行一致，
 * 这是 cbx 的有意设计：编码 CLI 依赖环境里的 API 凭据才能工作）。安全硬化的 operator 可以
 * 显式设置白名单——这会把拉起的 codebuddy/opencode/omp/cline/qwen 子进程的可见环境裁剪
 * 到白名单 + 一组不可缺的系统变量（PATH/HOME 等），降低"受损执行器可读取宿主全部凭据"
 * 的暴露面。优先级（自上而下）：
 *   1. 当前任务工作区的 `.cbx.json` 顶层 `executors.envAllowlist`（最具体，优先）；
 *   2. 插件 config 的全局 `executors.envAllowlist`（缺省回落）；
 *   3. `undefined` = 完整继承宿主 env。
 * 工作区显式配置（含空数组 = 显式只继承系统变量）会覆盖全局；工作区未配置则回落到全局。
 */
let executorEnvAllowlist: readonly string[] | undefined;

/** 设置全局（插件 config）执行器/测试子进程的环境变量白名单；传 undefined 恢复完整继承。
 *  该值作为工作区未显式配置时的缺省。返回还原函数；还原只清掉仍是本调用设置的值——
 *  HMR/多实例下后装实例的还原不会误清前装实例的设置（与 setProcessSpawnProvider 同约定）。 */
export function setExecutorEnvAllowlist(
  allowlist: readonly string[] | undefined,
): () => void {
  executorEnvAllowlist = allowlist;
  return () => {
    if (executorEnvAllowlist === allowlist) executorEnvAllowlist = undefined;
  };
}

/** 白名单 + 不可缺的系统变量。系统变量无论是否在白名单都会保留，避免裁掉 PATH
 *  等导致子进程连可执行文件都找不到（那不是安全目标，是搬起石头砸自己脚）。 */
const ALWAYS_PRESERVE_ENV = new Set([
  "PATH",
  "PATHEXT",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMSPEC",
  "WINDIR",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "NODE_ENV",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
]);

/** 工作区级白名单短缓存（TTL 5s，与 observability 的 configCache 同约定）：spawn 高频
 *  （git 操作、executor），不能每次读盘；`.cbx.json` 编辑最多 5s 后生效，对安全硬化可接受。 */
interface WorkspaceAllowlistCacheEntry {
  configured: boolean;
  allowlist: string[] | undefined;
  at: number;
}
const workspaceAllowlistCache = new Map<string, WorkspaceAllowlistCacheEntry>();
const WORKSPACE_ALLOWLIST_TTL_MS = 5_000;

/** 从 cwd 向上定位最近含 `.cbx/` 或 `.cbx.json` 的工作区根（限深，防跳到系统根）。
 *  返回 undefined 表示无法定位（如 review-gate 的临时目录、非 cbx 目录）。最深层向上 6 层。 */
function resolveWorkspaceRoot(cwd: string): string | undefined {
  let current = path.resolve(cwd);
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      if (statSync(path.join(current, ".cbx")).isDirectory()) return current;
    } catch { /* 向上 */ }
    try {
      if (statSync(path.join(current, ".cbx.json")).isFile()) return current;
    } catch { /* 向上 */ }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/** 从 worktree 路径反解主工作区根（导出供测试覆盖各分支）。
 *
 * cbx 的隔离 worktree 布局（见 git-ops.ts）：主工作区 `<root>` 的 worktree 位于
 * `parent(<root>)/.<basename(root)>.cbx-worktrees/<jobId>`，即主工作区的**兄弟目录**。
 * 因此在 worktree 内、且无 jobContext（主进程非任务调用）时，向上遍历找不到含 `.cbx/`
 * 的祖先。这里在路径片段中定位 `.<basename>.cbx-worktrees/<jobId>` 标记：
 *   - 命中 → 主工作区 = 该标记上一级目录 + 捕获的 `<basename>`；
 *   - 校验主工作区确实含 `.cbx/` 或 `.cbx.json`，否则不认（防误匹配）；
 *   - windows 折叠大小写比较。
 * 未命中或无 `.cbx` 标记返回 undefined（交回上级调用走全局回落）。 */
export function resolveWorktreeWorkspace(cwd: string): string | undefined {
  const parts = path.resolve(cwd).split(/[\\/]/);
  const markerIndex = parts.findIndex((segment) => /^\.(.+)\.cbx-worktrees$/.test(segment));
  if (markerIndex < 1) return undefined; // 需要至少一个上层目录（主工作区父目录）
  const match = /^\.(.+)\.cbx-worktrees$/.exec(parts[markerIndex]!);
  const base = match?.[1];
  if (!base) return undefined;
  // 构造候选主工作区根：[父目录, `<basename>`]。用 join(path.sep) 还原父路径再 resolve：
  // 直接 path.resolve(...parentParts, base) 在 POSIX 上会把 split 产生的首段空串
  // 锚定到进程 cwd（'/tmp/...' 变成 '<cwd>/tmp/...'），Windows 上依赖驱动器相对解析
  // 才碰巧正确。join 后首段空串天然得到 '/tmp/...'，Windows 多余分隔符由 resolve 归一化。
  const parentPath = parts.slice(0, markerIndex).join(path.sep);
  const candidate = path.resolve(parentPath, base);
  try {
    if (statSync(path.join(candidate, ".cbx")).isDirectory()) return candidate;
  } catch { /* 不是 cbx 主工作区 */ }
  try {
    if (statSync(path.join(candidate, ".cbx.json")).isFile()) return candidate;
  } catch { /* 不是 cbx 主工作区 */ }
  return undefined;
}

/** 取某 workspace 的工作区级白名单（缓存 + TTL）。失败（读/校验异常）时按"未配置"
 *  回落，绝不因 `.cbx.json` 坏配置让整个 spawn 挂掉——白名单是硬化，不是执行的前置。
 *  但降级必须可见：operator 依赖白名单收窄暴露面时，坏配置静默放宽会留下隐患，告警提示排查。 */
async function workspaceAllowlist(
  workspace: string,
): Promise<{ configured: boolean; allowlist: string[] | undefined }> {
  const key = process.platform === "win32" ? workspace.toLowerCase() : workspace;
  const hit = workspaceAllowlistCache.get(key);
  if (hit && Date.now() - hit.at < WORKSPACE_ALLOWLIST_TTL_MS) return hit;
  let result: { configured: boolean; allowlist: string[] | undefined };
  try {
    result = await loadRuntimeExecutorsAllowlist(workspace);
  } catch (error) {
    console.warn(
      `cbx: 工作区 ${workspace} 的 executors.envAllowlist 读取/校验失败，白名单未生效（回落全局配置；全局未配置则完整继承宿主 env）。错误：${error instanceof Error ? error.message : String(error)}`,
    );
    result = { configured: false, allowlist: undefined };
  }
  workspaceAllowlistCache.set(key, { ...result, at: Date.now() });
  return result;
}

/** 解析一次 spawn 的有效白名单，按优先级：
 *   1. jobContext 的任务工作区（覆盖隔离 worktree 场景，权威）；
 *   2. cwd 所在的 worktree → 主工作区（`.cbx-worktrees` 反解，覆盖主进程非任务隔离调用）；
 *   3. cwd 向上定位的含 `.cbx/` 工作区；
 *   4. 全局（插件 config）缺省；
 *   5. undefined = 完整继承宿主 env。
 * 逐级取第一个"工作区已显式配置"的结果；全未配置才回落全局。 */
async function effectiveAllowlist(cwd: string): Promise<readonly string[] | undefined> {
  const jobStore = jobContext.getStore();
  const jobWorkspace = jobStore?.workspace;
  if (jobWorkspace) {
    const ws = await workspaceAllowlist(jobWorkspace);
    if (ws.configured) return ws.allowlist;
  }
  const worktreeWorkspace = resolveWorktreeWorkspace(cwd);
  if (worktreeWorkspace) {
    const ws = await workspaceAllowlist(worktreeWorkspace);
    if (ws.configured) return ws.allowlist;
  }
  const cwdWorkspace = resolveWorkspaceRoot(cwd);
  if (cwdWorkspace) {
    const ws = await workspaceAllowlist(cwdWorkspace);
    if (ws.configured) return ws.allowlist;
  }
  return executorEnvAllowlist;
}

/** 按有效白名单裁剪环境；undefined = 原样返回 process.env（避免复制开销与语义变化）。 */
function envForChild(filter: readonly string[] | undefined): (typeof process.env) | undefined {
  if (!filter) return process.env;
  const allowed = new Set(filter.map((key) => key.toUpperCase()));
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (allowed.has(upper) || ALWAYS_PRESERVE_ENV.has(upper)) {
      if (value !== undefined) filtered[key] = value;
    }
  }
  return filtered;
}

/** 工作区白名单的同步查询：仅命中短缓存；未命中/过期返回 undefined（调用方回落全局）。
 *  供少量必须保持同步 spawn 的内部调用（git hash-object、可执行文件探测）复用白名单，
 *  与异步 effectiveAllowlist 共享同一份缓存与 TTL 语义。 */
function workspaceAllowlistCached(workspace: string): { configured: boolean; allowlist: string[] | undefined } | undefined {
  const key = process.platform === "win32" ? workspace.toLowerCase() : workspace;
  const hit = workspaceAllowlistCache.get(key);
  if (hit && Date.now() - hit.at < WORKSPACE_ALLOWLIST_TTL_MS) return hit;
  return undefined;
}

/** 同步 spawn 路径的有效白名单（jobContext 同步可得，其余候选回落全局）。
 *  与异步 effectiveAllowlist 的差异：不读盘、不反解 worktree——仅当工作区缓存已有
 *  新鲜条目时采用工作区级覆盖，否则用全局（插件 config）白名单。这些内部调用不面向
 *  不可信执行器，5s TTL 内的工作区配置延迟生效是可接受的。 */
function syncEffectiveAllowlist(cwd: string): readonly string[] | undefined {
  const jobWorkspace = jobContext.getStore()?.workspace;
  if (jobWorkspace) {
    const cached = workspaceAllowlistCached(jobWorkspace);
    if (cached?.configured) return cached.allowlist;
  }
  return executorEnvAllowlist;
}

/** 同步 spawn 路径的环境裁剪入口（git-ops 的 hash-object、builtin 的可执行文件探测）。 */
export function syncEnvForChild(cwd: string): (typeof process.env) | undefined {
  return envForChild(syncEffectiveAllowlist(cwd));
}

/** 清空工作区白名单缓存（测试用；编辑 `.cbx.json` 后如需立即生效可调用）。 */
export function resetWorkspaceAllowlistCache(): void {
  workspaceAllowlistCache.clear();
}

async function waitForTreeExit(
  handle: ReturnType<SubprocessRuntime["spawn"]>,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TREE_QUIESCE_TIMEOUT_MS);
  timer.unref();
  try {
    return await handle.waitForExit(controller.signal);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function terminateAndWait(
  handle: ReturnType<SubprocessRuntime["spawn"]>,
): Promise<{ stopped: boolean; error?: unknown }> {
  let error: unknown;
  try {
    handle.terminate();
  } catch (caught) {
    error = caught;
  }
  const stopped = await waitForTreeExit(handle);
  return error === undefined ? { stopped } : { stopped, error };
}

class BoundedOutput {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private readonly maximumBytes: number;
  truncated = false;

  constructor(maximumBytes = MAX_CAPTURE_BYTES) {
    this.maximumBytes = maximumBytes;
  }

  append(chunk: Buffer): void {
    const copy = Buffer.from(chunk);
    this.chunks.push(copy);
    this.bytes += copy.length;
    while (this.bytes > this.maximumBytes && this.chunks.length > 0) {
      const excess = this.bytes - this.maximumBytes;
      const first = this.chunks[0];
      if (first.length <= excess) {
        this.chunks.shift();
        this.bytes -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.bytes -= excess;
      }
      this.truncated = true;
    }
  }

  text(): string {
    return Buffer.concat(this.chunks, this.bytes).toString("utf8");
  }
}

// 凭据形状的落盘脱敏：执行器/测试命令输出可能回显其环境中的 API key/私钥
// （子进程继承宿主完整 env，见下方注释），原样写入 agent.log/test.log 会形成持久的
// 凭据泄漏面。这里只在写盘边界做正则脱敏；内存 output 保持原样，供上层
// contextRedactor/redactText 按 governance 配置二次处理。
const CREDENTIAL_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_\-]{16,}\b/g, // OpenAI 系
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub PAT / SSH key
  /\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/g, // Slack
  /\bAIza[0-9A-Za-z_\-]{30,}\b/g, // Google API key
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+\/\-=]{20,}\b/gi,
];
const REDACTED_TOKEN = "[redacted]";

function redactCredentials(text: string): string {
  let out = text;
  for (const re of CREDENTIAL_PATTERNS) out = out.replace(re, REDACTED_TOKEN);
  return out;
}

/**
 * 流式日志落盘的凭据脱敏器：chunk 按任意边界到达，key 可能被切分在两个 chunk 之间。
 * 保留上一 chunk 末尾 TAIL_BYTES 字节与当前 chunk 拼接后再脱敏，只把属于当前 chunk
 * 的部分写盘。
 *
 * 边界语义（与注释/README 声称对齐）：
 * - 首 chunk 不立即写盘，而是完整存入 pending，与下一 chunk 头尾重叠后再落盘——
 *   否则落在首 chunk 尾部的 key 前缀（无 tail 可重叠）会原样写出，泄漏其随机熵。
 * - TAIL_BYTES 取 64，覆盖最长凭据常量前缀（PEM 头 `-----BEGIN OPENSSH PRIVATE
 *   KEY-----` 35 字符 + 余量），确保任何跨 chunk 的 key 头都能与常量前缀一起被
 *   正则识别并整体替换，不残留熵。
 */
const TAIL_BYTES = 64;

class LogRedactor {
  private tail = "";
  private pending: string | undefined;

  write(sink: (text: string) => void, text: string): void {
    if (this.pending === undefined) {
      // 首 chunk：暂存不写盘，等待与下一 chunk 头尾重叠。
      this.pending = text;
      this.tail = text.slice(-TAIL_BYTES);
      return;
    }
    const combined = this.pending + text;
    const redacted = redactCredentials(combined);
    const cut = this.pending.length;
    // 脱敏后长度可能收缩（key→占位符）或持平；pending 部分已被上一轮 tail 重叠
    // 覆盖，这里只写出当前 chunk 中未被上一轮覆盖的部分。
    if (redacted.length >= cut) sink(redacted.slice(cut));
    else sink(REDACTED_TOKEN);
    this.pending = undefined;
    this.tail = text.slice(-TAIL_BYTES);
  }

  /** 流结束：落盘最后一段（pending + 当前 tail 已无后续重叠，直接写剩余）。 */
  flush(sink: (text: string) => void): void {
    if (this.pending !== undefined) {
      sink(redactCredentials(this.pending));
      this.pending = undefined;
    }
    this.tail = "";
  }
}

/**
 * Build a `ctx.subprocess` provider for the engine's `runProcess`/`runShell`.
 * All executor/test/git child processes flow through the DeepSeek Harness
 * subprocess seam: tree-scoped termination, graceful escalation, and the
 * job-runtime registry that lets `cbx cancel` terminate live subprocesses.
 *
 * 环境变量：默认完整继承宿主的 process.env（与终端直接运行一致）。这是有意设计——
 * 用户配置的编码 CLI（codebuddy/opencode/omp/cline/qwen）依赖环境里的 API 凭据才能
 * 工作，过滤变量会破坏执行器认证。对应缓解在落盘边界：日志写入前按凭据形状正则脱敏
 * （见 LogRedactor），防止执行器输出回显凭据形成持久的磁盘泄漏。安全硬化场景可经
 * `setExecutorEnvAllowlist` 裁剪子进程可见环境（见该函数与插件 config
 * `executors.envAllowlist`）。
 */
export function createSubprocessProvider(subprocess: SubprocessRuntime): ProcessSpawn {
  return async (
    useShell,
    command,
    args,
    cwd,
    timeoutMs,
    logFile,
    pidFile,
    callerSignal,
  ): Promise<ProcessResult> => {
    const argv = useShell ? shellArgv(command) : [command, ...args];
    // 先取 ALS 上下文：取消可能落在"标记检查之后、spawn 之前"的窗口里（上层还有
    // 若干 await）。发现已取消就直接放弃拉起子进程——抛错沿 runStage 的取消感知
    // catch 收口，避免执行器白跑整个 timeoutMs。
    const jobStore = jobContext.getStore();
    const jobSignal = jobStore?.controller.signal;
    const throwIfCallerOrJobAborted = (): void => {
      callerSignal?.throwIfAborted();
      jobSignal?.throwIfAborted();
    };
    throwIfCallerOrJobAborted();
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    if (callerSignal) signals.push(callerSignal);
    if (jobSignal) signals.push(jobSignal);
    signals.push(controller.signal);
    const spawnSignal = AbortSignal.any(signals);
    const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);
    const output = new BoundedOutput();
    let timedOut = false;

    let handle: ReturnType<SubprocessRuntime["spawn"]>;
    try {
      // 工作区级白名单覆盖：任务上下文优先，其次 cwd 定位的工作区，回落到全局。
      const envForSpawn = envForChild(await effectiveAllowlist(cwd));
      handle = subprocess.spawn({
        argv,
        cwd,
        stdio: {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
        graceMs: 2_000,
        signal: spawnSignal,
        env: envForSpawn,
      });
    } catch (error) {
      clearTimeout(timeoutTimer);
      throwIfCallerOrJobAborted();
      throw error;
    }

    const active: ActiveProcessHandle = {
      pid: handle.pid,
      terminate: () => handle.terminate(),
    };
    if (jobStore) jobStore.handles.add(active);
    let preserveTracking = false;
    let pidWritten = false;
    try {
      throwIfCallerOrJobAborted();
      if (pidFile && handle.pid > 0) {
        writePidRecord(pidFile, handle.pid);
        pidWritten = true;
      }
    } catch (error) {
      clearTimeout(timeoutTimer);
      const callerOrJobAborted = callerSignal?.aborted || jobSignal?.aborted;
      if (callerOrJobAborted) {
        const termination = await terminateAndWait(handle);
        if (!termination.stopped) {
          preserveTracking = true;
          if (pidFile && handle.pid > 0 && !pidWritten) {
            try {
              writePidRecord(pidFile, handle.pid);
              pidWritten = true;
            } catch {
              /* retain the diagnostic error below */
            }
          }
          throw new ProcessTreeTerminationError(
            handle.pid,
            callerSignal?.aborted ? callerSignal.reason : jobSignal?.reason,
            termination.error,
          );
        }
        if (jobStore) jobStore.handles.delete(active);
        if (pidFile) {
          try {
            unlinkSync(pidFile);
          } catch {
            /* never written or already removed */
          }
        }
        throw callerSignal?.aborted ? callerSignal.reason : jobSignal?.reason;
      }
      const termination = await terminateAndWait(handle);
      if (!termination.stopped) {
        preserveTracking = true;
        throw new ProcessTreeTerminationError(handle.pid, error, termination.error);
      }
      if (jobStore) jobStore.handles.delete(active);
      if (pidFile) {
        try {
          unlinkSync(pidFile);
        } catch {
          /* never written or already removed */
        }
      }
      throw error;
    }
    // 取消落在 spawn 与句柄注册之间：abortRunningJob 遍历句柄集时还看不到本句柄，
    // 注册后立刻按已取消信号补一次树级终止。
    if (spawnSignal.aborted) {
      try {
        handle.terminate();
      } catch {
        /* the signal remains authoritative */
      }
    }

    // 落盘日志经流式脱敏（首 chunk 延迟写 + 64 字节跨 chunk 重叠，见 LogRedactor）
    // 后再写 logFile，防止执行器输出回显的凭据原样持久化；内存 output 保持原样。
    // 磁盘侧设硬上限：内存 BoundedOutput 只保尾部 4MB，但逐 chunk append 不设限
    // 会让 chatty 执行器把 agent.log/test.log 写到数百 MB（evidence 哈希、artifact
    // 读取、SSE 回放全部跟着遭殃）。超限后停止落盘并留标记，内存采集不受影响。
    const MAX_LOG_FILE_BYTES = 32 * 1024 * 1024;
    const logRedactor = new LogRedactor();
    let logBytes = 0;
    let logCapped = false;
    const append = (chunk: Buffer): void => {
      output.append(chunk);
      if (logFile && !logCapped) {
        logBytes += chunk.length;
        if (logBytes > MAX_LOG_FILE_BYTES) {
          logCapped = true;
          try {
            appendFileSync(
              logFile,
              `\n[cbx: 日志已达 ${MAX_LOG_FILE_BYTES} 字节上限，停止落盘；内存采集仍保留尾部]\n`,
              "utf8",
            );
          } catch {
            /* 磁盘已满等：静默 */
          }
          return;
        }
        logRedactor.write(
          (redacted) => appendFileSync(logFile, redacted),
          chunk.toString("utf8"),
        );
      }
    };
    handle.stdout?.on("data", append);
    handle.stderr?.on("data", append);

    let outcome: Awaited<typeof handle.done> | undefined;
    let hardDeadlineHit = false;
    // 硬死线：abort（超时/取消）触发后，若 seam 的 SIGTERM→grace→SIGKILL 升级仍
    // 无法让 done settle（不可中断 IO / 句柄泄漏），job 会永久挂起——且事件循环
    // 空闲、心跳持续刷新，连队列回收路径都不会触发。到点后再次 terminate 并以
    // 合成超时结果解除本调用阻塞；卡死子进程仍留在句柄集里由取消路径兜底。
    let hardTimerHandle: ReturnType<typeof setTimeout> | undefined;
    const hardTimer = new Promise<"hard">((resolve) => {
      hardTimerHandle = setTimeout(
        () => resolve("hard"),
        timeoutMs + 2_000 + 5_000,
      );
      hardTimerHandle.unref();
    });
    try {
      const settled = await Promise.race([
        handle.done.then((value) => ({ value })),
        hardTimer,
      ]);
      if (settled === "hard") {
        hardDeadlineHit = true;
        const termination = await terminateAndWait(handle);
        if (!termination.stopped) {
          preserveTracking = true;
          throw new ProcessTreeTerminationError(
            handle.pid,
            controller.signal.reason,
            termination.error,
          );
        }
      } else {
        outcome = settled.value;
        if (controller.signal.aborted) {
          const termination = await terminateAndWait(handle);
          if (!termination.stopped) {
            preserveTracking = true;
            throw new ProcessTreeTerminationError(
              handle.pid,
              controller.signal.reason,
              termination.error,
            );
          }
        }
      }
      throwIfCallerOrJobAborted();
    } catch (error) {
      const callerOrJobAborted = callerSignal?.aborted || jobSignal?.aborted;
      if (callerOrJobAborted) {
        const termination = await terminateAndWait(handle);
        if (!termination.stopped) {
          preserveTracking = true;
          throw new ProcessTreeTerminationError(
            handle.pid,
            callerSignal?.aborted ? callerSignal.reason : jobSignal?.reason,
            termination.error,
          );
        }
        throw callerSignal?.aborted ? callerSignal.reason : jobSignal?.reason;
      }
      throw error;
    } finally {
      clearTimeout(timeoutTimer);
      if (hardTimerHandle !== undefined) clearTimeout(hardTimerHandle);
      // 落盘最后一段（LogRedactor 首 chunk 延迟写的 pending）：任何退出路径
      // （正常/超时/取消/错误）都不能丢失已采集的日志尾部。
      if (logFile && !logCapped) {
        try {
          logRedactor.flush((redacted) => appendFileSync(logFile, redacted));
        } catch {
          /* 磁盘满等：静默 */
        }
      }
      if (!preserveTracking) {
        if (jobStore) jobStore.handles.delete(active);
        if (pidFile) {
          try {
            unlinkSync(pidFile);
          } catch {
            /* already removed */
          }
        }
      }
    }

    if (hardDeadlineHit) {
      return {
        code: -1,
        timedOut: true,
        output: output.text(),
        ...(output.truncated ? { outputTruncated: true } : {}),
      };
    }
    // 超时判定：abort 恰好在进程正常退出(0)的同一瞬间的场景不算超时——
    // 退出码 0 说明工作已完成，误判成超时会触发无意义的重试。
    timedOut = controller.signal.aborted && (outcome?.exitCode ?? -1) !== 0;
    return {
      code: outcome?.exitCode ?? -1,
      timedOut,
      output: output.text(),
      ...(output.truncated ? { outputTruncated: true } : {}),
    };
  };
}

function shellArgv(command: string): string[] {
  if (process.platform === "win32") {
    return [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", command];
  }
  return ["/bin/sh", "-c", command];
}
