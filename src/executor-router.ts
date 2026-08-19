import {
  BUILTIN_EXECUTORS,
  probeAllExecutors,
  resolveExecutor,
  type ExecutorProbe,
} from "./executors/builtin.js";

/**
 * 本机 agent CLI 路由（"先检测本机有哪些 harness agent CLI，再把委派路由到可用 CLI"）。
 *
 * 核心语义：
 * - `requested` 为 undefined 或 "auto" → 按 preference 顺序选第一个**已安装**的执行器；
 * - `requested` 是内置执行器名/别名但**未安装** → 默认自动回退到第一个已安装的执行器
 *   （routed=true，reason 说明从谁回退到谁；可经 autoFallback:false 关闭回退改为原样返回）；
 * - `requested` 是插件路径（非内置名）→ 不参与路由，原样返回；
 * - 全部内置执行器都不可用时 → 返回 executor=undefined，调用方用 noExecutorError()
 *   给出带安装指引的清晰错误（取代现在"执行时 spawn 崩溃"的失败模式）。
 *
 * 探测结果带短 TTL 缓存（probeAllExecutors），路由本身无状态、可纯函数测试。
 */

export interface RouterOptions {
  /** 优先顺序（内置名或别名）；缺省 = BUILTIN_EXECUTORS 顺序。未知项被忽略。 */
  preference?: readonly string[];
  /** 显式指定但未安装时是否自动回退到可用执行器。缺省 true。 */
  autoFallback?: boolean;
  /** 探测快照（测试注入用）；缺省走 probeAllExecutors（带缓存）。 */
  probes?: ExecutorProbe[];
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

/**
 * 路由一次委派的执行器选择。纯函数：探测经 probeAllExecutors（带缓存），
 * preference 注入便于测试。返回的 executor=undefined 表示无可用执行器。
 */
export function routeExecutor(
  requested: string | undefined,
  options: RouterOptions = {},
): RouteDecision {
  const probes = options.probes ?? probeAllExecutors();
  const preference = normalizePreference(options.preference);
  const autoFallback = options.autoFallback !== false;
  const firstAvailable = (): string | undefined => {
    for (const name of preference) {
      if (probes.some((probe) => probe.name === name && probe.available)) return name;
    }
    return undefined;
  };

  // 插件路径/未知执行器：不参与内置路由（原样返回，执行期再按插件路径处理）。
  if (requested && requested !== "auto") {
    const spec = resolveExecutor(requested);
    if (!spec) {
      return {
        executor: requested,
        requested,
        routed: false,
        reason: `${requested} 不是内置执行器，按插件路径原样处理，不参与路由。`,
        available: probes,
      };
    }
    const probe = probes.find((item) => item.name === spec.name);
    if (probe?.available) {
      return {
        executor: spec.name,
        requested: spec.name,
        routed: false,
        reason: `${spec.label}（${spec.name}）已安装，直接使用。`,
        available: probes,
      };
    }
    // 显式指定但未安装：默认回退到可用执行器，保留 requested 供诊断。
    if (autoFallback) {
      const fallback = firstAvailable();
      if (fallback) {
        return {
          executor: fallback,
          requested: spec.name,
          routed: true,
          reason: `${spec.label}（${spec.name}）未安装，已回退到可用执行器 ${fallback}（可用：${availableNames(probes)}）。`,
          available: probes,
        };
      }
      return {
        executor: undefined,
        requested: spec.name,
        routed: false,
        reason: `${spec.label}（${spec.name}）未安装，且本机无任何可用编码 agent CLI。`,
        available: probes,
      };
    }
    return {
      executor: spec.name,
      requested: spec.name,
      routed: false,
      reason: `${spec.label}（${spec.name}）未安装（autoFallback=false，保留原指定；执行时将失败）。`,
      available: probes,
    };
  }

  // auto / 缺省：选偏好顺序中第一个已安装的执行器。
  const picked = firstAvailable();
  if (picked) {
    return {
      executor: picked,
      requested: undefined,
      routed: true,
      reason: `自动路由到可用执行器 ${picked}（可用：${availableNames(probes)}）。`,
      available: probes,
    };
  }
  return {
    executor: undefined,
    requested: undefined,
    routed: false,
    reason: "本机无任何可用编码 agent CLI。",
    available: probes,
  };
}
