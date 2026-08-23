import { BUILTIN_EXECUTORS, type BuiltinExecutor } from "./executors/builtin.js";
import { windowStats, type HealthSnapshot } from "./executor-health.js";

/**
 * 执行器档位目录：costTier / speedTier 的"出处与校准"层。
 *
 * 问题：builtin.ts 里声明的 costTier/speedTier 是拍脑袋的静态估值，路由的
 * cost-aware / fastest 策略却把它们当事实用——选型理由经不起追问。
 *
 * HR 式 fail-closed 目录语义（借鉴 harnessrouter 的 vendor model 表）：
 * 1. **实测优先**：某执行器累计延迟样本 ≥ MIN_TIER_CALIBRATION_SAMPLES 时，
 *    speed 档改由本机实测平均延迟相对排名推导（best=3，按 best/my 线性映射到
 *    1~3），声明值被覆盖——档位反映这台机器的真实表现，而非上游猜测。
 * 2. **出处必须可见**：每个有效档位都带 tierSource——measured（实测）/ declared
 *    （声明估值）/ configured（人工覆盖）。样本不足时保持 declared 并如实标注，
 *    绝不让估值冒充实测；tier 驱动的路由决策会把出处写进 reason。
 * 3. **覆盖是显式的一行配置**：`.cbx.json` 的 `executorTiers` 可人工校准
 *    （本机硬件、代理网络等原因导致的偏差）。拼错的执行器名绝不静默忽略——
 *    返回 warning 由调用方响亮呈现（与 normalizePreference 丢未知项不同，
 *    覆盖表是精确意图，错字必须被看见）。
 * 4. cost 无法本地测量（无定价数据源），只有 declared/configured 两种出处；
 *    这条边界本身就是目录的一部分，不假装能测。
 */

/** 有效速度档进入实测校准所需的最小延迟样本数。 */
export const MIN_TIER_CALIBRATION_SAMPLES = 3;

export type TierSource = "declared" | "measured" | "configured";

export interface ExecutorTiersOverride {
  costTier?: number;
  speedTier?: number;
}

/** 单个执行器的有效档位视图（打分与展示共用）。 */
export interface ExecutorTierView {
  costTier: number;
  speedTier: number;
  costSource: TierSource;
  speedSource: TierSource;
  /** 参与校准判定的窗口内延迟样本数（滑动窗口口径，非终身累计）。 */
  samples: number;
  /** 窗口内实测平均延迟（有样本时才有）。 */
  avgLatencyMs?: number;
}

export type TierCatalog = Record<string, ExecutorTierView>;

export interface BuiltTierCatalog {
  catalog: TierCatalog;
  /** 覆盖表中无法识别的执行器名（含别名归一后的重复项）；调用方必须呈现，不得吞掉。 */
  warnings: string[];
}

function clampTier(value: number): number {
  return Math.min(3, Math.max(1, value));
}

/**
 * 构建有效档位目录。纯函数：health/overrides 注入，便于测试与多工作区复用。
 *
 * 实测推导规则（显式写死，不做隐式推断）：在有足够样本的执行器集合内取最小
 * 平均延迟为基准 best，其余按 `1 + 2*best/my` 向下取整并夹在 [1,3]——基准得 3，
 * 2 倍慢得 2，3 倍及以上慢得 1。样本不足以参与校准的执行器保持声明值。
 */
export function buildTierCatalog(
  health: HealthSnapshot = {},
  overrides: Record<string, ExecutorTiersOverride> = {},
): BuiltTierCatalog {
  const warnings: string[] = [];
  // 覆盖键按注册名/别名归一；未知名进 warnings（fail-closed 可见性）。
  const overrideByName = new Map<string, ExecutorTiersOverride>();
  const firstKeyByCanonical = new Map<string, string>();
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!value || typeof value !== "object") {
      warnings.push(`executorTiers.${key} 必须是对象，已忽略该覆盖。`);
      continue;
    }
    const spec = BUILTIN_EXECUTORS.find(
      (s) => s.name === key || s.aliases.includes(key),
    );
    if (!spec) {
      warnings.push(
        `executorTiers."${key}" 不是内置执行器名或别名（可用：${BUILTIN_EXECUTORS.map((s) => s.name).join(", ")}），覆盖未生效。`,
      );
      continue;
    }
    const firstKey = firstKeyByCanonical.get(spec.name);
    if (firstKey !== undefined) {
      warnings.push(`executorTiers."${key}" 与先前的 "${firstKey}" 指向同一执行器（${spec.name}），仅保留 "${firstKey}" 的覆盖。`);
      continue;
    }
    firstKeyByCanonical.set(spec.name, key);
    overrideByName.set(spec.name, value);
  }

  // 先算实测平均延迟，再定谁参与校准。一律走滑动窗口口径（windowStats 对旧格式
  // 记录自动回退累计字段）：机器变慢/换执行器版本后，校准跟着最近几次调用走，
  // 而不是被历史平均稀释。
  const measured = new Map<string, { avg: number; samples: number }>();
  for (const spec of BUILTIN_EXECUTORS) {
    const stats = windowStats(health[spec.name]);
    if (stats.latencySamples >= MIN_TIER_CALIBRATION_SAMPLES && stats.totalLatencyMs > 0) {
      measured.set(spec.name, {
        avg: stats.totalLatencyMs / stats.latencySamples,
        samples: stats.latencySamples,
      });
    }
  }
  let bestAvg = Number.POSITIVE_INFINITY;
  for (const { avg } of measured.values()) {
    if (avg < bestAvg) bestAvg = avg;
  }

  const catalog: TierCatalog = {};
  for (const spec of BUILTIN_EXECUTORS) {
    catalog[spec.name] = tierViewFor(spec, health, measured, bestAvg, overrideByName.get(spec.name));
  }
  return { catalog, warnings };
}

function tierViewFor(
  spec: BuiltinExecutor,
  health: HealthSnapshot,
  measured: Map<string, { avg: number; samples: number }>,
  bestAvg: number,
  override?: ExecutorTiersOverride,
): ExecutorTierView {
  // 视图里的 samples/avg 与校准同口径：滑动窗口内的观测（非终身累计）。
  const stats = windowStats(health[spec.name]);
  const samples = stats.latencySamples;
  const avgLatencyMs =
    samples > 0 ? Math.round(stats.totalLatencyMs / samples) : undefined;

  // cost：无本地可测量来源，只有 configured > declared 两档。
  const costOverride = override?.costTier;
  const costTier = clampTier(costOverride ?? spec.costTier);

  // speed：configured > measured（样本足够时相对排名推导）> declared。
  const speedOverride = override?.speedTier;
  let speedTier: number;
  let speedSource: TierSource;
  if (speedOverride != null) {
    speedTier = clampTier(speedOverride);
    speedSource = "configured";
  } else {
    const m = measured.get(spec.name);
    if (m && Number.isFinite(bestAvg) && m.avg > 0) {
      speedTier = clampTier(1 + Math.floor((2 * bestAvg) / m.avg));
      speedSource = "measured";
    } else {
      speedTier = spec.speedTier;
      speedSource = "declared";
    }
  }

  return {
    costTier,
    speedTier,
    costSource: costOverride != null ? "configured" : "declared",
    speedSource,
    samples,
    ...(avgLatencyMs !== undefined ? { avgLatencyMs } : {}),
  };
}

/** 档位出处的人类可读摘要（路由决策 reason 用）：只点名非 declared 的来源与未校准事实。 */
export function tierSourcesNote(catalog: TierCatalog | undefined, picked: string | undefined): string {
  if (!catalog || !picked || !catalog[picked]) return "";
  const view = catalog[picked]!;
  const parts: string[] = [];
  if (view.speedSource === "measured") {
    const calibrated = Object.values(catalog).filter((v) => v.speedSource === "measured").length;
    parts.push(`速度档实测（${view.samples} 样本，${calibrated} 个执行器参与校准）`);
  } else if (view.speedSource === "configured") {
    parts.push("速度档人工配置");
  } else {
    parts.push("速度档为声明估值（无足够实测样本）");
  }
  if (view.costSource === "configured") parts.push("成本档人工配置");
  return parts.length ? `；档位出处：${parts.join("，")}` : "";
}
