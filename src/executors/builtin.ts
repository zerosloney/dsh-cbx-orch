import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { syncEnvForChild } from "../subprocess-adapter.js";

// 内置执行器适配层：把 codebuddy / opencode / omp / cline / qwen 等编码 CLI 收敛到统一的调用契约。
// 每个 adapter 描述：发现二进制的方式 + 如何把 (prompt, permissionMode, maxTurns) 翻译成 CLI 参数。

export interface BuildArgsOptions {
  prompt: string;
  permissionMode: string;
  maxTurns: number;
}

/** 组装最终参数序列：内置翻译 + 工作区覆盖（executors.cliArgs，追加在末尾）。
 *  覆盖参数通常为 flag/value 形式（如 ["--model","x"]）；追加位置在末尾，
 *  若 CLI 对位置参数敏感请用 flag 形式。 */
export function buildArgsWithExtras(
  spec: BuiltinExecutor,
  opts: BuildArgsOptions,
  extraArgs: readonly string[] | undefined,
): string[] {
  return [...spec.buildArgs(opts), ...(extraArgs ?? [])];
}

/** 执行器能力声明：路由层据此过滤"不满足任务需求"的执行器（如需要 autoApprove 时排除 omp）。 */
export interface ExecutorCapabilities {
  /** 支持非交互式自动放行（auto/dontAsk）。omp 无此 flag，故为 false。 */
  autoApprove: boolean;
  /** 支持 plan 模式（仅产出计划不落地改动）。 */
  planMode: boolean;
  /** 支持沙箱隔离执行。 */
  sandbox: boolean;
  /** 支持无头/JSON 输出（cbx 依赖 stream-json / --format json 解析）。 */
  headless: boolean;
  /** 支持轮次预算参数（--max-turns / --max-session-turns）。 */
  maxTurnsSupport: boolean;
  /** 支持流式输出（便于实时采集 agent.log）。 */
  streaming: boolean;
}

export interface BuiltinExecutor {
  /** 注册名，写入 .cbx.json 的 executor 字段或 --executor */
  name: "codebuddy" | "opencode" | "omp" | "cline" | "qwen";
  /** 别名，resolveExecutor 同样命中（oh-my-pi 指向 omp，非独立二进制） */
  aliases: string[];
  /** 显示名，注入到提示词与用户可见的错误消息中 */
  label: string;
  /** 覆盖二进制路径的环境变量，与 bin 名一一对应 */
  envVar: string;
  /** PATH 上依次尝试的二进制名 */
  candidates: string[];
  /** 能力声明，供路由层做需求匹配与能力打分。 */
  capabilities: ExecutorCapabilities;
  /** 成本档位 1(低)~3(高)，供 cost-aware 策略。 */
  costTier: number;
  /** 速度档位 1(慢)~3(快)，供 fastest 策略。 */
  speedTier: number;
  /** 把统一入参翻译成该 CLI 的具体参数序列（不含二进制本身） */
  buildArgs(opts: BuildArgsOptions): string[];
}

// permissionMode 中表示「自动放行」的语义值：opencode 用 --auto、cline 用 --auto-approve true 表达。
const AUTO_MODES = new Set(["auto", "dontAsk"]);

export const BUILTIN_EXECUTORS: readonly BuiltinExecutor[] = [
  {
    name: "codebuddy",
    aliases: ["cbc"],
    label: "CodeBuddy",
    envVar: "CBX_CODEBUDDY",
    candidates: ["codebuddy", "cbc"],
    capabilities: { autoApprove: true, planMode: false, sandbox: false, headless: true, maxTurnsSupport: true, streaming: true },
    costTier: 2,
    speedTier: 2,
    buildArgs: ({ prompt, permissionMode, maxTurns }) => [
      "-p",
      "--output-format", "stream-json",
      "--max-turns", String(maxTurns),
      "--permission-mode", permissionMode,
      prompt,
    ],
  },
  {
    name: "opencode",
    aliases: [],
    label: "OpenCode",
    envVar: "CBX_OPENCODE",
    candidates: ["opencode"],
    capabilities: { autoApprove: true, planMode: false, sandbox: false, headless: true, maxTurnsSupport: false, streaming: true },
    costTier: 2,
    speedTier: 2,
    buildArgs: ({ prompt, permissionMode }) => {
      const args = ["run", "--format", "json", prompt];
      if (AUTO_MODES.has(permissionMode)) args.push("--auto");
      return args;
    },
  },
  {
    name: "omp",
    aliases: ["oh-my-pi"], // oh-my-pi 是 omp 的扩展框架，仍由 omp 二进制执行
    label: "Oh My Pi",
    envVar: "CBX_OMP",
    candidates: ["omp"],
    // omp 官方 CLI 文档未公开 permission/auto flag；非交互 -p 默认按 omp 自身权限行事。
    // intentional-simple: 不追加 auto flag，缺已知天花板——待 omp 暴露权限 flag 后补 `-a` 类参数。
    // 能力声明里 autoApprove:false 让路由层在 permission_mode=auto 时主动排除它，避免卡在交互授权。
    capabilities: { autoApprove: false, planMode: false, sandbox: false, headless: true, maxTurnsSupport: false, streaming: true },
    costTier: 1,
    speedTier: 2,
    buildArgs: ({ prompt }) => ["-p", "--mode", "json", prompt],
  },
  {
    name: "cline",
    aliases: [],
    label: "Cline",
    envVar: "CBX_CLINE",
    candidates: ["cline"],
    capabilities: { autoApprove: true, planMode: true, sandbox: false, headless: true, maxTurnsSupport: false, streaming: true },
    costTier: 3,
    speedTier: 2,
    buildArgs: ({ prompt, permissionMode }) => {
      const args = ["--json", prompt, "--auto-approve", String(AUTO_MODES.has(permissionMode))];
      if (permissionMode === "plan") args.push("--plan");
      return args;
    },
  },
  {
    name: "qwen",
    aliases: [],
    label: "Qwen Code",
    envVar: "CBX_QWEN",
    candidates: ["qwen"],
    // qwen 非交互模式（--prompt）按官方 headless 文档映射（https://qwenlm.github.io/qwen-code-docs/zh/users/features/headless/）：
    // - maxTurns → --max-session-turns（交互轮数预算）
    // - plan → --approval-mode plan；auto/dontAsk → --yolo（auto-approve all）
    // 不传 --sandbox：cbx 需执行器在 worktree 内自由读写，沙箱会阻碍任务执行。
    // 无人值守场景建议在宿主环境设 QWEN_CODE_UNATTENDED_RETRY=1（子进程经 runProcess 继承 process.env）。
    capabilities: { autoApprove: true, planMode: true, sandbox: false, headless: true, maxTurnsSupport: true, streaming: true },
    costTier: 2,
    speedTier: 3,
    buildArgs: ({ prompt, permissionMode, maxTurns }) => {
      const args = ["--prompt", prompt, "--output-format", "stream-json", "--max-session-turns", String(maxTurns)];
      if (permissionMode === "plan") args.push("--approval-mode", "plan");
      else if (AUTO_MODES.has(permissionMode)) args.push("--yolo");
      return args;
    },
  },
];

const BY_NAME: ReadonlyMap<string, BuiltinExecutor> = (() => {
  const map = new Map<string, BuiltinExecutor>();
  for (const spec of BUILTIN_EXECUTORS) {
    map.set(spec.name, spec);
    for (const alias of spec.aliases) map.set(alias, spec);
  }
  return map;
})();

/** 按注册名或别名解析内置执行器；未命中返回 undefined（调用方再当插件路径处理）。 */
export function resolveExecutor(name: string): BuiltinExecutor | undefined {
  return BY_NAME.get(name);
}

// 进程级 Get-Command 解析缓存，带 TTL：正结果（解析成功）缓存较长，负结果
// （解析失败/未安装）缓存很短——运行期新装 CLI 后能较快重新探测到，不再
// 永久冻结"未安装"（旧实现负结果无条件缓存，30s 探测 TTL 到期也拿不到新值）。
// 键同时含主候选名，避免不同执行器共用解析结果。
const resolvedPathCache = new Map<
  string,
  { command: string; at: number; negative: boolean }
>();
/** 正结果缓存 TTL（安装后通常不再变，取 5 分钟减少 Get-Command 同步开销）。 */
const RESOLVED_POSITIVE_TTL_MS = 5 * 60_000;
/** 负结果缓存 TTL（未安装时短缓存，允许运行期安装后较快生效）。 */
const RESOLVED_NEGATIVE_TTL_MS = 30_000;

function cachedResolvedPath(primary: string): { command: string; negative: boolean } | undefined {
  const entry = resolvedPathCache.get(primary);
  if (!entry) return undefined;
  const ttl = entry.negative ? RESOLVED_NEGATIVE_TTL_MS : RESOLVED_POSITIVE_TTL_MS;
  if (Date.now() - entry.at >= ttl) {
    resolvedPathCache.delete(primary);
    return undefined;
  }
  return { command: entry.command, negative: entry.negative };
}

/**
 * 返回 [command, ...rest] 形式的可执行命令：
 * - 优先采用 envVar 指定的覆盖路径；
 * - Windows 上用 PowerShell Get-Command 解析 bin 名的真实来源（结果带 TTL 缓存，
 *   避免每次 spawn 同步阻塞事件循环；负结果短 TTL 让新装 CLI 快速可见）；
 * - 兜底直接把候选名交给 spawn；
 * - .ps1/.js/.mjs/.cjs 会被包装成 powershell/node 调用。
 */
export function findExecutable(spec: BuiltinExecutor): string[] {
  const configured = process.env[spec.envVar];
  const candidates: string[] = [];
  if (configured) candidates.push(configured);
  if (process.platform === "win32") {
    const primary = spec.candidates[0];
    const cached = cachedResolvedPath(primary);
    let resolved = cached?.negative ? "" : (cached?.command ?? "");
    if (cached === undefined) {
      // 与 resolveCandidateOnSystem 同款转义：primary 是候选 bin 名（受控常量），
      // 但 envVar 覆盖路径可能含特殊字符，一律单引号字面量包裹防命令注入。
      const escaped = primary.replace(/'/g, "''");
      const ps = spawnSync("powershell.exe", ["-NoProfile", "-Command", `Get-Command -Name '${escaped}' | Select-Object -ExpandProperty Source`], { encoding: "utf8", windowsHide: true, env: syncEnvForChild(process.cwd()) });
      resolved = ps.status === 0 ? String(ps.stdout).trim() : "";
      resolvedPathCache.set(primary, {
        command: resolved,
        at: Date.now(),
        negative: resolved === "",
      });
    }
    if (resolved) candidates.push(resolved);
  }
  candidates.push(...spec.candidates);
  for (const candidate of candidates) {
    if (!candidate) continue;
    const lower = candidate.toLowerCase();
    if (lower.endsWith(".ps1")) return ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", candidate];
    if (lower.endsWith(".mjs") || lower.endsWith(".cjs") || lower.endsWith(".js")) return [process.execPath, candidate];
    return [candidate];
  }
  throw new Error(`找不到 ${spec.label} (${spec.candidates.join("/")})。请安装 ${spec.label}，或设置 ${spec.envVar}。`);
}

// ---------------------------------------------------------------------------
// 本机 agent CLI 检测（路由前置）：probe 是 findExecutable 的非抛错版，返回
// 「是否可用 + 来源」，供 cbx_executors / cbx_run 的路由层在创建期做决策。
// 与 findExecutable 的差异：绝不抛错、不把「未安装」当作致命、带短 TTL 缓存。
// ---------------------------------------------------------------------------

export interface ExecutorProbe {
  /** 内置执行器注册名（codebuddy/opencode/omp/cline/qwen）。 */
  name: string;
  /** 显示名。 */
  label: string;
  /** 本机是否可解析出可执行文件（PATH 命中或 envVar 覆盖存在）。 */
  available: boolean;
  /** 解析来源：env = envVar 覆盖；path = PATH/Get-Command 命中；none = 未安装。 */
  source: "env" | "path" | "none";
  /** 解析出的可执行路径/命令名（available=true 时才有）。 */
  command?: string;
  /** source=env 时记录覆盖用的环境变量名。 */
  envVar?: string;
}

/** PATH 上按序查找可执行文件（POSIX；Windows 走 Get-Command，扩展名由 PATHEXT 处理）。 */
function whichOnPath(name: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
  const pathVar = env.PATH ?? "";
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    try {
      const candidate = path.join(dir, name);
      const st = statSync(candidate);
      if (st.isFile() && (st.mode & 0o111) !== 0) return candidate;
    } catch {
      /* 该 PATH 项无此文件 */
    }
  }
  return undefined;
}

/** 解析单个候选名（PATH / Get-Command），成功返回可执行路径，失败 undefined。 */
function resolveCandidateOnSystem(
  primary: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (process.platform === "win32") {
    const cached = cachedResolvedPath(primary);
    let resolved = cached?.negative ? "" : (cached?.command ?? "");
    if (cached === undefined) {
      // 安全：envVar 覆盖的裸名是外部可控值，绝不能拼进 PowerShell 字符串再解析，
      // 否则值含 `;`、`()`、反引号等即可在本机执行任意命令（命令注入）。
      // 用单引号字面量包裹 + 内部单引号加倍，使 primary 始终被当作 Get-Command
      // 的参数名（纯字符串），而非可执行的 PowerShell 代码。
      const escaped = primary.replace(/'/g, "''");
      const ps = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-Command", `Get-Command -Name '${escaped}' | Select-Object -ExpandProperty Source`],
        { encoding: "utf8", windowsHide: true, env: syncEnvForChild(process.cwd()) },
      );
      resolved = ps.status === 0 ? String(ps.stdout).trim() : "";
      resolvedPathCache.set(primary, {
        command: resolved,
        at: Date.now(),
        negative: resolved === "",
      });
    }
    return resolved || undefined;
  }
  return whichOnPath(primary, env);
}

/** 单个内置执行器的可用性探测（非抛错）。env 可注入（测试用），缺省 process.env。 */
export function probeExecutable(
  spec: BuiltinExecutor,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ExecutorProbe {
  const configured = env[spec.envVar];
  if (configured) {
    // envVar 覆盖：路径形式直接查存在性；裸名走 PATH/Get-Command。
    const looksLikePath = configured.includes("/") || configured.includes("\\");
    const command = looksLikePath
      ? existsSync(configured)
        ? configured
        : undefined
      : resolveCandidateOnSystem(configured, env);
    if (command) {
      return { name: spec.name, label: spec.label, available: true, source: "env", command, envVar: spec.envVar };
    }
    return { name: spec.name, label: spec.label, available: false, source: "none", envVar: spec.envVar };
  }
  const command = resolveCandidateOnSystem(spec.candidates[0], env);
  if (command) {
    return { name: spec.name, label: spec.label, available: true, source: "path", command };
  }
  return { name: spec.name, label: spec.label, available: false, source: "none" };
}

/** 探测缓存 TTL：路由/工具调用不频繁，30s 内安装变更不即时可见（可接受，与文档一致）。 */
const PROBE_TTL_MS = 30_000;

interface ProbeCacheEntry {
  fingerprint: string;
  probes: ExecutorProbe[];
  at: number;
}
let probeCache: ProbeCacheEntry | undefined;

/** 探测缓存指纹：平台 + PATH + 全部覆盖变量。PATH/安装变更会自然失效。 */
function probeFingerprint(env: Readonly<Record<string, string | undefined>>): string {
  const parts = [process.platform, env.PATH ?? ""];
  for (const spec of BUILTIN_EXECUTORS) parts.push(`${spec.envVar}=${env[spec.envVar] ?? ""}`);
  return parts.join("|");
}

/** 清理探测缓存（测试用；环境/安装变更后如需立即重新探测可调用）。 */
export function resetExecutorProbeCache(): void {
  probeCache = undefined;
  resolvedPathCache.clear();
}

/**
 * 探测本机全部内置 agent CLI 的可用性。结果带短 TTL 缓存（probeFingerprint 变化即失效）。
 * env 可注入（测试用）。返回顺序与 BUILTIN_EXECUTORS 一致。
 */
export function probeAllExecutors(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ExecutorProbe[] {
  const fingerprint = probeFingerprint(env);
  const hit = probeCache;
  if (hit && hit.fingerprint === fingerprint && Date.now() - hit.at < PROBE_TTL_MS) {
    return hit.probes;
  }
  const probes = BUILTIN_EXECUTORS.map((spec) => probeExecutable(spec, env));
  probeCache = { fingerprint, probes, at: Date.now() };
  return probes;
}
