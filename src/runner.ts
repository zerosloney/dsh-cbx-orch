import { appendFileSync, existsSync } from "node:fs";
import { appendFile, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectExecutorPlugin, type ExecutorResult, type ExecutorRequest } from "./executor.js";
import { findExecutable, buildArgsWithExtras, resolveExecutor } from "./executors/builtin.js";
import { recordExecutorOutcome } from "./executor-health.js";
import { bumpInvocationCount, loadConfig, loadState, mirrorJobEventToSqlite } from "./state.js";
import { loadJobContext, securityPolicyFingerprint } from "./storage.js";
import { validateTestCommand } from "./validation.js";
import { runProcess, runShell, type ProcessResult } from "./process-runner.js";
import { ExecutorCostLimitError, ExecutorPolicyDriftError, GlobalCostLimitError, isUnretryableInvocationError } from "./errors.js";
import { tryConsumeInvocation as consumeGlobalInvocation } from "./global-gate.js";
import { redactText, saveJson } from "./storage.js";
import { APP_VERSION } from "./version.js";
import { jobContext } from "./job-runtime.js";

export type InvocationRole = "stage" | "review" | "manager" | "gate";

/** 事件载荷中的长字符串（内嵌 prompt 的 argv、输出片段）截断后落盘：审计要可读头部，不要全文。 */
function truncateDeep(value: unknown, maxChars = 500): unknown {
  if (typeof value === "string") {
    return value.length > maxChars ? `${value.slice(0, maxChars)}…(${value.length} chars)` : value;
  }
  if (Array.isArray(value)) return value.map((item) => truncateDeep(item, maxChars));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, truncateDeep(item, maxChars)]),
    );
  }
  return value;
}

/**
 * 事件流写入统一边界：内置凭据形状脱敏 + 长字段截断。prompt 经 argv 内嵌在
 * process_started 的 command 里，原样落盘会把任务全文（含用户指令/handback 与
 * 内联凭据）持久化并随 SSE / events artifact 暴露——agent.log/test.log 的脱敏
 * 约束同样适用于事件流。
 */
/** 从 job 事件文件路径解析 workspace 与 jobId（`<ws>/.cbx/jobs/<jobId>/events.ndjson`）。
 *  供 appendEvent 镜像 SQLite 时使用；解析失败返回 undefined（镜像跳过）。 */
function jobIdentityFromEventsFile(eventsFile: string): { workspace: string; jobId: string } | undefined {
  const normalized = path.normalize(eventsFile);
  const parts = normalized.split(path.sep);
  // 定位 ".cbx/jobs/<jobId>/events.ndjson"
  const jobsIndex = parts.lastIndexOf("jobs");
  if (jobsIndex < 0 || jobsIndex + 2 >= parts.length) return undefined;
  const jobId = parts[jobsIndex + 1];
  const workspace = parts.slice(0, jobsIndex - 1).join(path.sep); // 去掉 .cbx
  if (!jobId || !workspace) return undefined;
  return { workspace, jobId };
}

function appendEvent(eventsFile: string, payload: Record<string, unknown>): void {
  // 与 logJobEvent 同一边界：先脱敏（redactText 全文凭据形状 + truncateDeep 长字段
  // 截断）再落盘；SQLite 镜像复用同一份脱敏结果——执行器可改 ndjson 但改不了
  // events 表（审计权威），若镜像存原始 payload，凭据会从权威副本经 SSE/timeline
  // 原样读出，绕过 ndjson 侧脱敏。
  const redacted = JSON.parse(
    redactText(JSON.stringify(truncateDeep(payload))),
  ) as Record<string, unknown>;
  appendFileSync(eventsFile, JSON.stringify(redacted) + "\n", "utf8");
  // SQLite 镜像（审计权威）：执行器可改 ndjson，改不了 events 表。
  const identity = jobIdentityFromEventsFile(eventsFile);
  if (identity) {
    mirrorJobEventToSqlite(identity.workspace, identity.jobId, String(payload.event ?? "event"), redacted);
  }
}

/** Remove a per-invocation plugin artifact, surfacing errors other than a missing file. */
async function unlinkIfPresent(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

interface CombinedAbortSignal {
  signal?: AbortSignal;
  dispose(): void;
}

/** Caller cancellation wins over the ambient job cancellation when both fire. */
function combineAbortSignals(
  callerSignal: AbortSignal | undefined,
  jobSignal: AbortSignal | undefined,
): CombinedAbortSignal {
  if (!callerSignal || !jobSignal || callerSignal === jobSignal) {
    return { signal: callerSignal ?? jobSignal, dispose: () => undefined };
  }
  const controller = new AbortController();
  let disposed = false;
  const onCallerAbort = (): void => {
    if (!controller.signal.aborted) controller.abort(callerSignal.reason);
  };
  const onJobAbort = (): void => {
    if (controller.signal.aborted) return;
    queueMicrotask(() => {
      if (disposed || controller.signal.aborted) return;
      controller.abort(callerSignal.aborted ? callerSignal.reason : jobSignal.reason);
    });
  };
  callerSignal.addEventListener("abort", onCallerAbort);
  jobSignal.addEventListener("abort", onJobAbort);
  if (callerSignal.aborted) onCallerAbort();
  else if (jobSignal.aborted) onJobAbort();
  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      callerSignal.removeEventListener("abort", onCallerAbort);
      jobSignal.removeEventListener("abort", onJobAbort);
    },
  };
}

function throwIfAborted(
  callerSignal: AbortSignal | undefined,
  jobSignal: AbortSignal | undefined,
): void {
  if (callerSignal?.aborted) throw callerSignal.reason;
  if (jobSignal?.aborted) throw jobSignal.reason;
}

function rethrowPreferredAbort(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  jobSignal: AbortSignal | undefined,
): never {
  if (callerSignal?.aborted) throw callerSignal.reason;
  if (jobSignal?.aborted) throw jobSignal.reason;
  throw error;
}

async function cleanupPluginArtifacts(
  directory: string,
  requestFile: string,
  resultFile: string,
): Promise<void> {
  const files = [requestFile, resultFile];
  const outcomes = await Promise.allSettled(files.map(unlinkIfPresent));
  const failures = outcomes.flatMap((outcome, index) =>
    outcome.status === "rejected"
      ? [{ file: files[index], error: outcome.reason }]
      : [],
  );
  if (failures.length === 0) return;
  try {
    appendEvent(path.join(directory, "events.ndjson"), {
      event: "plugin_artifact_cleanup_failed",
      files: failures.map(({ file }) => file),
      errors: failures.map(({ error }) =>
        error instanceof Error ? error.message : String(error),
      ),
      at: new Date().toISOString(),
    });
  } catch {
    /* cleanup diagnostics are best effort and must not mask the original result */
  }
}

export interface InvocationMeta {
  role: InvocationRole;
  jobId: string;
  stageIndex?: number;
}

export function promptFor(phase: string, extra = "", _label: string, contextPack: string): string {
  return `你是任务执行代理。\n\n只读取当前角色上下文包：\n- ${contextPack}\n\n上下文包是编排器生成的最小化脱敏投影；只可额外读取其中 artifacts 明确列出的文件，不要读取任何未列材料或历史轨迹。\n当前阶段：${phase}\n\n${extra}`;
}

async function invokeBuiltin(spec: ReturnType<typeof resolveExecutor> & {}, directory: string, workdir: string, prompt: string, permissionMode: string, maxTurns: number, timeoutMs: number, signal?: AbortSignal, extraArgs?: readonly string[]): Promise<ProcessResult> {
  signal?.throwIfAborted();
  const executable = findExecutable(spec);
  const args = [...executable.slice(1), ...buildArgsWithExtras(spec, { prompt, permissionMode, maxTurns }, extraArgs)];
  const command = executable[0];
  const eventsFile = path.join(directory, "events.ndjson");
  const outputLog = path.join(directory, "agent.log");
  appendEvent(eventsFile, { event: "executor_metadata", source: "builtin", name: spec.name, version: APP_VERSION, at: new Date().toISOString() });
  appendEvent(eventsFile, { event: "process_started", command: [command, ...args], cwd: workdir, at: new Date().toISOString() });
  const result = await runProcess(command, args, workdir, timeoutMs, outputLog, path.join(directory, "active.pid"), signal);
  signal?.throwIfAborted();
  appendEvent(eventsFile, { event: "process_finished", returncode: result.code, timedOut: result.timedOut, at: new Date().toISOString() });
  return result;
}

export async function invokeExecutor(
  executor: string,
  workspace: string,
  directory: string,
  workdir: string,
  prompt: string,
  permissionMode: string,
  maxTurns: number,
  timeoutMs: number,
  invocationMeta?: InvocationMeta,
  callerSignal?: AbortSignal,
): Promise<ProcessResult> {
  const jobSignal = jobContext.getStore()?.controller.signal;
  const combined = combineAbortSignals(callerSignal, jobSignal);
  const start = Date.now();
  try {
    throwIfAborted(callerSignal, jobSignal);
    const result = await invokeExecutorCore(
      executor,
      workspace,
      directory,
      workdir,
      prompt,
      permissionMode,
      maxTurns,
      timeoutMs,
      invocationMeta,
      combined.signal,
    );
    // 回写健康度，失败语义细分：超时（撞墙钟被杀）与崩溃（非零退出）分开计数，
    // 路由层据此施加不同档位的降权——超时可能只是任务过大，崩溃更可能是执行器坏了。
    try {
      recordExecutorOutcome(
        workspace,
        executor,
        result.timedOut
          ? { success: false, kind: "timeout", latencyMs: Date.now() - start }
          : result.code === 0
            ? { success: true, latencyMs: Date.now() - start }
            : { success: false, kind: "failure", latencyMs: Date.now() - start },
      );
    } catch {
      /* 健康度记录失败不影响主流程 */
    }
    return result;
  } catch (error) {
    // 取消/中止不算执行器的账；真实启动错误（二进制缺失、pid 记录失败等）按 failure 记录，
    // 否则"选了没装的执行器"永远学不到教训，下次路由还会撞同一堵墙。
    if (!callerSignal?.aborted && !jobSignal?.aborted) {
      try {
        recordExecutorOutcome(workspace, executor, {
          success: false,
          kind: "failure",
          latencyMs: Date.now() - start,
        });
      } catch {
        /* 健康度记录失败不影响主流程 */
      }
    }
    rethrowPreferredAbort(error, callerSignal, jobSignal);
  } finally {
    combined.dispose();
  }
}

async function invokeExecutorCore(executor: string, workspace: string, directory: string, workdir: string, prompt: string, permissionMode: string, maxTurns: number, timeoutMs: number, invocationMeta?: InvocationMeta, signal?: AbortSignal): Promise<ProcessResult> {
  signal?.throwIfAborted();
  if (invocationMeta?.jobId) {
    // 成本硬闸：发起调用前检查累计执行器调用是否已达上限。达到上限即抛
    // ExecutorCostLimitError——调用方（stage-runner/review-gate/handshake/adaptive）
    // 识别后转 needs_fix + human gate，绝不当作普通失败走重试（重试会继续烧配额）。
    // 上限优先级：创建时工具/Web 参数写入的 context.cost > `.cbx.json` 的 cost.maxExecutorInvocations；
    // 均未配置 = 无上限（向后兼容）。
    try {
      const [state, config, context] = await Promise.all([
        loadState(workspace, invocationMeta.jobId),
        loadConfig(workspace),
        loadJobContext(path.join(workspace, ".cbx", "jobs", invocationMeta.jobId)).catch(
          () => undefined,
        ),
      ]);
      // 安全策略指纹校验（fail-closed）：任务创建时固定的 .cbx.json 安全指纹
      // （成本闸/插件白名单/reviewGate/环境白名单，存 SQLite 权威）与执行期现读值
      // 比对。非隔离执行器 cwd=workspace 可中途改写 .cbx.json（调高成本上限、拆
      // 插件白名单、设 reviewGate.failOpen=true 等）——指纹漂移即拒绝调用，
      // 防静默拆掉安全/成本控制。旧任务（无 securityFingerprint 字段）跳过校验。
      if (typeof state.securityFingerprint === "string") {
        const currentFingerprint = securityPolicyFingerprint(config);
        if (currentFingerprint !== state.securityFingerprint)
          throw new ExecutorPolicyDriftError();
      }
      const limit =
        context?.cost?.maxExecutorInvocations ??
        config.cost?.maxExecutorInvocations;
      if (limit !== undefined) {
        const current =
          typeof state.executorInvocations === "number" &&
          Number.isInteger(state.executorInvocations)
            ? state.executorInvocations
            : 0;
        if (current >= limit) throw new ExecutorCostLimitError(limit, current);
      }
      // 进程级全局预算（governance.maxGlobalInvocations，全工作区累计）：同步原子
      // 消费（JS 单线程使 check + bump 原子），超限抛 GlobalCostLimitError——
      // extends ExecutorCostLimitError，调用方自动按 cost_limit + human gate 处理。
      // 轻微超跑语义与 per-job 闸一致：消费先于 bumpInvocationCount，计数失败不阻塞调用。
      const globalCheck = consumeGlobalInvocation();
      if (!globalCheck.allowed) {
        throw new GlobalCostLimitError(globalCheck.limit!, globalCheck.used);
      }
    } catch (error) {
      // 只有成本闸/策略漂移本身抛错才向上传播；读取/配置失败不能阻塞执行器调用（既有语义）。
      if (isUnretryableInvocationError(error)) throw error;
    }
    try {
      await bumpInvocationCount(
        workspace,
        invocationMeta.jobId,
        invocationMeta.role,
        invocationMeta.stageIndex,
      );
    } catch (error) {
      // 计数失败不应阻塞执行器调用；落审计事件便于排障。
      appendEvent(path.join(directory, "events.ndjson"), {
        event: "invocation_count_failed",
        role: invocationMeta.role,
        stageIndex: invocationMeta.stageIndex,
        error: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      });
    }
  }
  signal?.throwIfAborted();
  const config = await loadConfig(workspace);
  signal?.throwIfAborted();
  const builtin = resolveExecutor(executor);
  if (builtin) {
    // 工作区级 CLI 参数覆盖（executors.cliArgs）：键可为注册名、别名或请求串本身，
    // 命中即追加到内置参数之后——外部 CLI 版本参数漂移时的逃生门，无需发版插件。
    const cliArgs = config.executors?.cliArgs;
    let extraArgs: readonly string[] | undefined;
    if (cliArgs) {
      for (const key of [executor, builtin.name, ...builtin.aliases]) {
        if (key && cliArgs[key] !== undefined) {
          extraArgs = cliArgs[key];
          break;
        }
      }
    }
    return invokeBuiltin(builtin, directory, workdir, prompt, permissionMode, maxTurns, timeoutMs, signal, extraArgs);
  }
  // 安全默认：`.cbx.json` 未显式配置 plugins.enforce 时按 enforce=true 处理（fail-closed）——
  // 插件路径 = 任意代码执行面，未经路径/SHA 白名单校验的插件默认拒绝加载。显式
  // `enforce: false` 可显式放行（遗留工作区逃生门），显式 `enforce: true` 维持严格。
  const pluginPolicy = config.plugins
    ? { ...config.plugins, defaultEnforce: true }
    : { defaultEnforce: true };
  const identity = await inspectExecutorPlugin(executor, workspace, pluginPolicy);
  signal?.throwIfAborted();
  if (config.plugins?.enforce === false) {
    // 显式关闭强制：告警并落审计事件，让"跳过白名单"始终可见。
    const warning = `executor 指向插件 ${identity.path}，但 plugins.enforce=false 已显式关闭白名单校验，插件未经路径/SHA 校验即被加载；生产环境请配置 plugins.enforce=true 与 allowPaths/allowSha256。`;
    console.error(`cbx: ${warning}`);
    appendEvent(path.join(directory, "events.ndjson"), { event: "plugin_policy_warning", executor: identity.name, path: identity.path, sha256: identity.sha256, enforce: false, at: new Date().toISOString() });
  }
  const request: ExecutorRequest = { directory, workdir, prompt, permissionMode, maxTurns, timeoutMs, executor, plugin: { policy: pluginPolicy, sha256: identity.sha256 } };
  appendEvent(path.join(directory, "events.ndjson"), { event: "executor_metadata", source: identity.source, name: identity.name, version: identity.version, apiVersion: identity.apiVersion, capabilities: identity.capabilities, sha256: identity.sha256, at: new Date().toISOString() });
  appendEvent(path.join(directory, "events.ndjson"), { event: "plugin_started", executor: identity.name, at: new Date().toISOString() });
  const requestFile = path.join(directory, "plugin-request.json");
  const resultFile = path.join(directory, "plugin-result.json");
  const host = path.join(path.dirname(fileURLToPath(import.meta.url)), "plugin-host.js");
  // plugin-request.json 内嵌完整 prompt（用户指令，可能携带内联凭据），是 job 目录里
  // 唯一未经脱敏的明文落盘面——插件宿主读取完毕后立即删除，不留持久副本。
  try {
    // 同一 job 目录可能是上次崩溃/超时留下的；先清掉两类文件，避免旧结果被误当成本次结果。
    await unlinkIfPresent(requestFile);
    await unlinkIfPresent(resultFile);
    signal?.throwIfAborted();
    await saveJson(requestFile, request, { fsync: false });
    signal?.throwIfAborted();
    const processResult = await runProcess(process.execPath, [host, executor, workspace, requestFile, resultFile], workdir, timeoutMs, path.join(directory, "agent.log"), path.join(directory, "active.pid"), signal);
    signal?.throwIfAborted();
    let pluginResult: ExecutorResult = { code: processResult.code, timedOut: processResult.timedOut, output: processResult.output };
    if (!processResult.timedOut && existsSync(resultFile)) {
      try { pluginResult = JSON.parse(await readFile(resultFile, "utf8")) as ExecutorResult; }
      catch { pluginResult = { code: -1, output: "executor plugin returned an invalid result" }; }
    } else {
      // Compatibility fallback for an older plugin-host.js left in a development dist directory.
      const marker = /CBX_PLUGIN_RESULT=([A-Za-z0-9+/=]+)/g;
      const matches = [...processResult.output.matchAll(marker)];
      if (!processResult.timedOut && matches.length) {
        try { pluginResult = JSON.parse(Buffer.from(matches.at(-1)![1], "base64").toString("utf8")) as ExecutorResult; }
        catch { pluginResult = { code: -1, output: "executor plugin returned an invalid result" }; }
      }
    }
    signal?.throwIfAborted();
    const normalized = { code: Number(pluginResult.code ?? processResult.code), timedOut: processResult.timedOut || Boolean(pluginResult.timedOut), output: String(pluginResult.output ?? processResult.output) };
    appendEvent(path.join(directory, "events.ndjson"), { event: "plugin_finished", executor, code: normalized.code, timedOut: normalized.timedOut, at: new Date().toISOString() });
    return normalized;
  } finally {
    await cleanupPluginArtifacts(directory, requestFile, resultFile);
  }
}

export async function runTest(
  directory: string,
  workdir: string,
  command: string | undefined,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<ProcessResult> {
  const jobSignal = jobContext.getStore()?.controller.signal;
  const combined = combineAbortSignals(callerSignal, jobSignal);
  try {
    throwIfAborted(callerSignal, jobSignal);
    return await runTestCore(directory, workdir, command, timeoutMs, combined.signal);
  } catch (error) {
    rethrowPreferredAbort(error, callerSignal, jobSignal);
  } finally {
    combined.dispose();
  }
}

async function runTestCore(directory: string, workdir: string, command: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult> {
  signal?.throwIfAborted();
  if (!command) {
    signal?.throwIfAborted();
    await writeFile(path.join(directory, "test.log"), "未指定测试命令。\n", "utf8");
    signal?.throwIfAborted();
    return { code: 0, timedOut: false, output: "" };
  }
  // 执行期复验：context.json 是执行器可写文件，测试命令可能在创建校验之后被篡改。
  // 这里失败直接按执行失败处理（非零退出），不跑 shell。
  try {
    validateTestCommand(command);
  } catch (error) {
    signal?.throwIfAborted();
    const message = error instanceof Error ? error.message : String(error);
    await writeFile(path.join(directory, "test.log"), `$ ${command}\n\n拒绝执行：${message}\n`, "utf8");
    signal?.throwIfAborted();
    return { code: 1, timedOut: false, output: `测试命令被拒绝：${message}` };
  }
  const logFile = path.join(directory, "test.log");
  signal?.throwIfAborted();
  await writeFile(logFile, `$ ${command}\n\n`, "utf8");
  signal?.throwIfAborted();
  const result = await runShell(command, workdir, timeoutMs, logFile, path.join(directory, "active.pid"), signal);
  signal?.throwIfAborted();
  await appendFile(logFile, `\n退出码：${result.code}\n超时：${result.timedOut}\n内存输出已截断：${Boolean(result.outputTruncated)}\n`, "utf8");
  signal?.throwIfAborted();
  return result;
}
