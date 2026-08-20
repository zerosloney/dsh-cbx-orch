import {
  BUILTIN_EXECUTORS,
  probeAllExecutors,
  resolveExecutor,
  type BuiltinExecutor,
  type ExecutorProbe,
} from "./executors/builtin.js";
import type { HealthSnapshot } from "./executor-health.js";

/**
 * 本机 agent CLI 路由（"先检测本机有哪些 harness agent CLI，再把委派路由到最合适的一个"）。
 *
 * 能力模型（v2，本次增强）：
 * - 每个内置执行器声明 `capabilities`（autoApprove/planMode/sandbox/headless/maxTurnsSupport/streaming）
 *   与成本/速度档位（costTier/speedTier）；
 * - 任务可表达 `requirements`（并能从 permissionMode/plan 自动推导），路由层**先过滤掉不满足需求**
 *   的执行器（例如 permission_mode=auto 时排除 omp，因为它没有 auto-approve flag，会卡在交互授权）；
 * - 在候选集内按 `strategy`（first-available / capability-best / cost-aware / fastest / round-robin /
 *   least-recently-used）做**多因子打分**选最优，健康度（连续失败/延迟/最近使用）作为降权与 LRU 的输入；
 * - 探测结果带短 TTL 缓存（probeAllExecutors），路由本身无状态、可纯函数测试。
 *
 * 旧行为（auto 选偏好顺序第一个已安装 + 未装回退）在 `first-available` 策略下保留，
 * 只是额外叠加了需求过滤——这是修复"选了不支持 auto 的执行器导致卡死"这类静默错配。
 */

/** 任务对执行器的需求；任一字段为 true 时，不满足该能力的执行器将被过滤掉。 */
export interface ExecutorRequirements {
  autoApprove?: boolean;
  planMode?: boolean;
  sandbox?: boolean;
  headless?: boolean;
  maxTurnsSupport?: boolean;
  streaming?: boolean;
  /** 显式排除的执行器注册名（即使可用也不选）。 */
  exclude?: string[];
}

/** 路由策略。 */
export type ExecutorStrategy =
  | "first-available"
  | "capability-best"
  | "cost-aware"
  | "fastest"
  | "round-robin"
  | "least-recently-used";

export const EXECUTOR_STRATEGIES: readonly ExecutorStrategy[] = [
  "first-available",
  "capability-best",
  "cost-aware",
  "fastest",
  "round-robin",
  "least-recently-used",
];

export interface RouterOptions {
  /** 优先顺序（内置名或别名）；缺省 = BUILTIN_EXECUTORS 顺序。未知项被忽略。 */
  preference?: readonly string[];
  /** 显式指定但未安装时是否自动回退到可用执行器。缺省 true。 */
  autoFallback?: boolean;
  /** 探测快照（测试注入用）；缺省走 probeAllExecutors（带缓存）。 */
  probes?: ExecutorProbe[];
  /** 任务需求：路由层先过滤不满足的执行器。 */
  requirements?: ExecutorRequirements;
  /** 选择策略（缺省 first-available）。 */
  strategy?: ExecutorStrategy;
  /** 健康度快照（按 workspace 加载），用于降权 / LRU / round-robin。 */
  health?: HealthSnapshot;
  /** 当前时间戳（ms），用于 LRU/round-robin 打分；测试可注入。 */
  now?: number;
}

export interface RouteDecision {
  /** 选中的执行器（内置注册名）；插件路径原样返回；无可用时 undefined。 */
  executor: string | undefined;
  /** 请求的规范名（"auto"/缺省时为 undefined）。 */
  requested?: string;
  /** 决策是否发生了"自动挑选/回退"（false = 请求的执行器直接用）。 */
  routed: boolean;
  /** 人类可读原因（中文）。 */
  reason: string;
  /** 探测快照（供 cbx_executors / 错误消息复用）。 */
  available: ExecutorProbe[];
  /** 实际采用的策略。 */
  strategy?: ExecutorStrategy;
  /** 实际生效的需求。 */
  requirements?: ExecutorRequirements;
}

/** 缺省偏好顺序：与 BUILTIN_EXECUTORS 声明一致。 */
export const DEFAULT_EXECUTOR_PREFERENCE: readonly string[] = BUILTIN_EXECUTORS.map(
  (spec) => spec.name,
);

/** 把偏好列表（可含别名/未知名）归一化为内置注册名数组，未知项丢弃。 */
export function normalizePreference(
  preference: readonly string[] | undefined,
): string[] {
  if (!preference || preference.length === 0) return [...DEFAULT_EXECUTOR_PREFERENCE];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of preference) {
    const spec = resolveExecutor(item);
    if (!spec || seen.has(spec.name)) continue;
    seen.add(spec.name);
    names.push(spec.name);
  }
  // 偏好未覆盖的内置执行器追加到尾部（保证 auto 永远有完整候选集）。
  for (const spec of BUILTIN_EXECUTORS) {
    if (!seen.has(spec.name)) names.push(spec.name);
  }
  return names;
}

/** 可用执行器名的紧凑列表（如 "opencode, qwen"），供提示消息使用。 */
export function availableNames(probes: ExecutorProbe[]): string {
  const names = probes.filter((probe) => probe.available).map((probe) => probe.name);
  return names.length > 0 ? names.join(", ") : "（无）";
}

/** 无任何可用执行器时的安装指引错误（创建期 fail-fast 用）。 */
export function noExecutorError(probes: ExecutorProbe[]): Error {
  const lines = [
    "本机未安装任何可用的编码 agent CLI，无法委派执行。请安装其一（或设置对应环境变量指向可执行文件）：",
    ...BUILTIN_EXECUTORS.map(
      (spec) => `- ${spec.label}（命令 ${spec.candidates.join("/")}${spec.envVar ? `；或设置 ${spec.envVar}` : ""}）`,
    ),
  ];
  const partial = probes.find((probe) => probe.available);
  if (!partial) lines.push("", "安装后可用 cbx_executors 验证探测结果，或用 cbx_run 的 executor 参数显式指定。");
  return new Error(lines.join("\n"));
}

/** 从任务提示（permissionMode / plan）推导需求：auto/dontAsk → 需要 autoApprove；plan → 需要 planMode。 */
export function deriveRequirements(opts: { permissionMode?: string; plan?: boolean }): ExecutorRequirements {
  const reqs: ExecutorRequirements = {};
  if (opts.permissionMode === "auto" || opts.permissionMode === "dontAsk") reqs.autoApprove = true;
  if (opts.plan || opts.permissionMode === "plan") reqs.planMode = true;
  return reqs;
}

/** 执行器是否满足给定需求（无需求时恒满足）。 */
export function meetsRequirements(spec: BuiltinExecutor, reqs?: ExecutorRequirements): boolean {
  if (!reqs) return true;
  const c = spec.capabilities;
  if (reqs.autoApprove && !c.autoApprove) return false;
  if (reqs.planMode && !c.planMode) return false;
  if (reqs.sandbox && !c.sandbox) return false;
  if (reqs.headless && !c.headless) return false;
  if (reqs.maxTurnsSupport && !c.maxTurnsSupport) return false;
  if (reqs.streaming && !c.streaming) return false;
  if (reqs.exclude?.includes(spec.name)) return false;
  return true;
}

/** 列出执行器未满足的需求名（用于显式指定但不匹配时的告警原因）。 */
function unmetList(spec: BuiltinExecutor, reqs?: ExecutorRequirements): string {
  if (!reqs) return "";
  const c = spec.capabilities;
  const parts: string[] = [];
  if (reqs.autoApprove && !c.autoApprove) parts.push("autoApprove");
  if (reqs.planMode && !c.planMode) parts.push("planMode");
  if (reqs.sandbox && !c.sandbox) parts.push("sandbox");
  if (reqs.headless && !c.headless) parts.push("headless");
  if (reqs.maxTurnsSupport && !c.maxTurnsSupport) parts.push("maxTurnsSupport");
  if (reqs.streaming && !c.streaming) parts.push("streaming");
  if (reqs.exclude?.includes(spec.name)) parts.push("被 exclude 排除");
  return parts.join("/") || "未知";
}

function capabilityCount(spec: BuiltinExecutor): number {
  const c = spec.capabilities;
  return (
    (c.autoApprove ? 1 : 0) +
    (c.planMode ? 1 : 0) +
    (c.sandbox ? 1 : 0) +
    (c.headless ? 1 : 0) +
    (c.maxTurnsSupport ? 1 : 0) +
    (c.streaming ? 1 : 0)
  );
}

interface ScoreContext {
  preference: string[];
  strategy: ExecutorStrategy;
  health?: HealthSnapshot;
  now: number;
}

/** 多因子打分：偏好顺序 + 能力 + 健康度 + 策略项。分数越高越优先。 */
function scoreExecutor(spec: BuiltinExecutor, ctx: ScoreContext): number {
  let s = 0;
  const pidx = ctx.preference.indexOf(spec.name);
  const pBonus = pidx >= 0 ? ctx.preference.length - pidx : 0;
  s += pBonus * 10; // 偏好顺序基础分
  const cap = capabilityCount(spec);
  s += cap * 2; // 能力越多略加分
  const h = ctx.health?.[spec.name];
  if (h) {
    s -= (h.consecutiveFailures ?? 0) * 15; // 连续失败重罚
    if (h.lastLatencyMs != null) s -= Math.min(h.lastLatencyMs / 1000, 30) * 0.3; // 延迟轻罚
    s += Math.min(h.successes ?? 0, 30) * 0.15; // 成功轻奖
  }
  switch (ctx.strategy) {
    case "cost-aware":
      s += (4 - spec.costTier) * 30; // 成本越低分越高
      break;
    case "fastest":
      s += spec.speedTier * 30; // 速度越快分越高
      break;
    case "capability-best":
      s += cap * 20; // 能力主导
      break;
    case "round-robin":
    case "least-recently-used": {
      const used = h?.lastUsedAt ? Date.parse(h.lastUsedAt) : 0;
      s += ((ctx.now - used) / 60_000) * 4; // 越久未用分越高
      break;
    }
    case "first-available":
    default:
      s += pBonus * 50; // 严格按偏好顺序
      break;
  }
  return s;
}

/** 在候选集中按（分数降序，偏好顺序升序）选最优。 */
function selectBest(candidates: BuiltinExecutor[], ctx: ScoreContext): BuiltinExecutor | undefined {
  if (candidates.length === 0) return undefined;
  const prefIndex = (spec: BuiltinExecutor): number => {
    const i = ctx.preference.indexOf(spec.name);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...candidates].sort((a, b) => {
    const sa = scoreExecutor(a, ctx);
    const sb = scoreExecutor(b, ctx);
    if (sa !== sb) return sb - sa;
    return prefIndex(a) - prefIndex(b);
  })[0];
}

/**
 * 路由一次委派的执行器选择。纯函数：探测经 probeAllExecutors（带缓存），
 * preference/health/now 注入便于测试。返回的 executor=undefined 表示无可用执行器。
 */
export function routeExecutor(
  requested: string | undefined,
  options: RouterOptions = {},
): RouteDecision {
  const probes = options.probes ?? probeAllExecutors();
  const preference = normalizePreference(options.preference);
  const strategy = options.strategy ?? "first-available";
  const reqs = options.requirements;
  const health = options.health;
  const now = options.now ?? Date.now();
  const autoFallback = options.autoFallback !== false;
  const ctx: ScoreContext = { preference, strategy, health, now };

  // 插件路径 / 未知执行器：不参与内置路由（原样返回，执行期再按插件路径处理）。
  if (requested && requested !== "auto") {
    const spec = resolveExecutor(requested);
    if (!spec) {
      return {
        executor: requested,
        requested,
        routed: false,
        reason: `${requested} 不是内置执行器，按插件路径原样处理，不参与路由。`,
        available: probes,
        strategy,
        requirements: reqs,
      };
    }
    const probe = probes.find((item) => item.name === spec.name);
    if (probe?.available) {
      const meets = meetsRequirements(spec, reqs);
      const reason = meets
        ? `${spec.label}（${spec.name}）已安装，直接使用。`
        : `${spec.label}（${spec.name}）已安装，但不满足需求（${unmetList(spec, reqs)}），仍按显式指定使用——可能行为不符预期。`;
      return {
        executor: spec.name,
        requested: spec.name,
        routed: false,
        reason,
        available: probes,
        strategy,
        requirements: reqs,
      };
    }
    // 显式指定但未安装：默认回退到满足需求的可用执行器。
    if (autoFallback) {
      const available = probes
        .filter((p) => p.available)
        .map((p) => resolveExecutor(p.name)!)
        .filter((s) => meetsRequirements(s, reqs));
      const fallback = available.length ? selectBest(available, ctx) : undefined;
      if (fallback) {
        return {
          executor: fallback.name,
          requested: spec.name,
          routed: true,
          reason: `${spec.label}（${spec.name}）未安装，已回退到可用执行器 ${fallback.name}（可用：${availableNames(probes)}）。`,
          available: probes,
          strategy,
          requirements: reqs,
        };
      }
      return {
        executor: undefined,
        requested: spec.name,
        routed: false,
        reason: `${spec.label}（${spec.name}）未安装，且本机无满足需求的可用编码 agent CLI。`,
        available: probes,
        strategy,
        requirements: reqs,
      };
    }
    return {
      executor: spec.name,
      requested: spec.name,
      routed: false,
      reason: `${spec.label}（${spec.name}）未安装（autoFallback=false，保留原指定；执行时将失败）。`,
      available: probes,
      strategy,
      requirements: reqs,
    };
  }

  // auto / 缺省：过滤满足需求的可用执行器，再按策略打分选最优。
  const available = probes
    .filter((p) => p.available)
    .map((p) => resolveExecutor(p.name)!)
    .filter((s) => meetsRequirements(s, reqs));
  if (available.length === 0) {
    return {
      executor: undefined,
      requested: undefined,
      routed: false,
      reason: reqs ? "无满足需求的可用执行器。" : "本机无任何可用编码 agent CLI。",
      available: probes,
      strategy,
      requirements: reqs,
    };
  }
  const picked = selectBest(available, ctx)!;
  const why = strategy === "first-available" ? "自动路由到可用执行器" : `按策略 ${strategy} 选中`;
  return {
    executor: picked.name,
    requested: undefined,
    routed: true,
    reason: `${why} ${picked.name}（满足需求；可用：${availableNames(probes)}）。`,
    available: probes,
    strategy,
    requirements: reqs,
  };
}
