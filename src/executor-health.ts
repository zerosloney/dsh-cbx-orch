import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 执行器健康度追踪：按 workspace 记录每个执行器的成功/失败/延迟/最近使用时间，
 * 供路由层（健康度降权、LRU、round-robin 策略）做多因子决策。
 *
 * 设计：进程内以 Map 缓存（路由/记录都走内存，零阻塞）；变更后最佳努力异步落盘到
 * `<workspace>/.cbx/executor-health.json`（重启后仍可复用，但也接受丢失——健康度只是增强项，
 * 落盘失败绝不阻塞主流程）。
 */

export interface ExecutorHealthRecord {
  /** 累计成功次数。 */
  successes: number;
  /** 累计失败次数（超时与非零退出/启动失败都计入）。 */
  failures: number;
  /** 连续失败计数：路由层据此降权，成功一次即清零。 */
  consecutiveFailures: number;
  /** 累计超时次数。超时与崩溃语义不同：超时可能是任务过大/执行器慢，崩溃更可能意味着执行器坏了。 */
  timeouts?: number;
  /** 连续超时计数：成功或非超时失败即清零；路由层对它施加与崩溃不同档位的降权。 */
  consecutiveTimeouts?: number;
  /** 最近一次失败的语义："timeout" = 撞墙钟被杀；"failure" = 非零退出/启动失败。 */
  lastFailureKind?: "timeout" | "failure";
  /** 累计延迟观测数（成功与失败都算）：目录层据此判断档位能否进入"实测校准"。 */
  latencySamples?: number;
  /** 累计延迟总和（毫秒），avg = totalLatencyMs / latencySamples。 */
  totalLatencyMs?: number;
  /** 最近一次调用延迟（毫秒）。 */
  lastLatencyMs?: number;
  /**
   * 最近 HEALTH_WINDOW_SIZE 次结果窗口（旧→新序）：路由降权与档位校准的依据。
   * 有了窗口，一个月前的成功不再永久托底、历史连败会随新证据老化出局、
   * 实测档位跟得上机器状态漂移。缺省（旧落盘文件）= 无窗口，读方回退累计字段。
   */
  recent?: ExecutorOutcomeSample[];
  /** 最近一次使用时间（ISO），LRU / round-robin 用。 */
  lastUsedAt?: string;
}

/** 单次结果的窗口样本（字段压缩以控制落盘体积：20 样本 × 5 执行器 ≈ 数 KB）。 */
export interface ExecutorOutcomeSample {
  /** 1 = 成功，0 = 失败。 */
  s: 0 | 1;
  /** 失败语义：1 = 超时（仅 s=0 时有意义）。 */
  t?: 1;
  /** 本次延迟毫秒；缺省 = 未观测到延迟。 */
  ms?: number;
}

/** 窗口容量：路由与校准只看最近这么多次真实调用。 */
export const HEALTH_WINDOW_SIZE = 20;

export interface HealthWindowStats {
  /** 窗口样本数（旧格式回退时为近似值，见 windowStats）。 */
  samples: number;
  successes: number;
  failures: number;
  timeouts: number;
  /** 窗口尾部连续崩溃（非超时失败）长度：路由重罚输入。 */
  crashStreak: number;
  /** 窗口尾部连续超时长度：路由中罚输入。 */
  timeoutStreak: number;
  latencySamples: number;
  totalLatencyMs: number;
}

/**
 * 从健康记录推导窗口统计。有 recent 窗口时一切以窗口为准：
 * - 连败从窗口尾反向推导（成功即断），天然随新证据老化；
 * - 延迟取窗口内观测的合计。
 * 旧格式（无 recent，升级前的落盘文件）回退累计字段：连败用既有计数器，
 * 延迟若只有 lastLatencyMs 则 latencySamples=0（调用方自行回退 last 值），
 * 成功奖沿用终身计数——旧行为的忠实近似，随新写入逐步迁移到窗口口径。
 */
export function windowStats(rec: ExecutorHealthRecord | undefined): HealthWindowStats {
  const recent = rec?.recent;
  if (Array.isArray(recent) && recent.length > 0) {
    let successes = 0;
    let failures = 0;
    let timeouts = 0;
    let latencySamples = 0;
    let totalLatencyMs = 0;
    for (const sample of recent) {
      if (sample.s === 1) successes += 1;
      else failures += 1;
      if (sample.t === 1) timeouts += 1;
      if (typeof sample.ms === "number" && sample.ms >= 0) {
        latencySamples += 1;
        totalLatencyMs += sample.ms;
      }
    }
    // 尾部连败构成：从最新往回走完整个失败段（遇成功即停），段内分别累计
    // 超时与崩溃。比旧计数器更精确——旧口径下一段 [超时,超时,崩溃] 会因崩溃
    // 清零连续超时而被整体按崩溃计罚，窗口能保留段内的真实构成。
    let timeoutStreak = 0;
    let crashStreak = 0;
    let idx = recent.length - 1;
    while (idx >= 0 && recent[idx].s === 0) {
      if (recent[idx].t === 1) timeoutStreak += 1;
      else crashStreak += 1;
      idx -= 1;
    }
    return {
      samples: recent.length,
      successes,
      failures,
      timeouts,
      crashStreak,
      timeoutStreak,
      latencySamples,
      totalLatencyMs,
    };
  }
  // 旧格式回退：无窗口证据，按累计字段近似。
  const totalStreak = rec?.consecutiveFailures ?? 0;
  const timeoutStreak = Math.min(rec?.consecutiveTimeouts ?? 0, totalStreak);
  return {
    samples: (rec?.successes ?? 0) + (rec?.failures ?? 0),
    successes: rec?.successes ?? 0,
    failures: rec?.failures ?? 0,
    timeouts: rec?.timeouts ?? 0,
    crashStreak: totalStreak - timeoutStreak,
    timeoutStreak,
    latencySamples: rec?.latencySamples ?? 0,
    totalLatencyMs: rec?.totalLatencyMs ?? 0,
  };
}

export type HealthSnapshot = Record<string, ExecutorHealthRecord>;

export interface Outcome {
  success: boolean;
  latencyMs?: number;
  /**
   * 失败语义细分（仅 success=false 时有意义）：
   * - "timeout"：执行器撞到 timeoutMs 被整树终止——每次都烧满整个超时预算，但原因可能是任务过大而非执行器损坏；
   * - "failure"：非零退出或启动失败——fail-fast，通常指示执行器缺失/配置坏。
   * 缺省按 "failure" 记（兼容旧调用方）。
   */
  kind?: "timeout" | "failure";
}

const MEM = new Map<string, HealthSnapshot>();
const DIRTY = new Set<string>();
// 落盘防抖定时器：窗口内多次 recordExecutorOutcome 合并成一次写盘。
// 高频执行器调用（stage/review/manager/gate 每次调用都记录）时，原实现每次
// 都触发 writeFile——慢盘上连续写放大。防抖后最多 FLUSH_DEBOUNCE_MS 一次。
const FLUSH_DEBOUNCE_MS = 500;
const flushTimers = new Map<string, NodeJS.Timeout>();

function fileFor(workspace: string): string {
  return path.join(workspace, ".cbx", "executor-health.json");
}

export function loadHealth(workspace: string): HealthSnapshot {
  let snap = MEM.get(workspace);
  if (snap) return snap;
  const file = fileFor(workspace);
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as HealthSnapshot;
      if (parsed && typeof parsed === "object") snap = parsed;
    } catch {
      snap = {};
    }
  }
  if (!snap) snap = {};
  MEM.set(workspace, snap);
  return snap;
}

export function getRecord(workspace: string, executor: string): ExecutorHealthRecord | undefined {
  return loadHealth(workspace)[executor];
}

export function recordExecutorOutcome(workspace: string, executor: string, outcome: Outcome): void {
  const snap = loadHealth(workspace);
  const rec = snap[executor] ?? { successes: 0, failures: 0, consecutiveFailures: 0 };
  if (outcome.success) {
    rec.successes += 1;
    rec.consecutiveFailures = 0;
    rec.consecutiveTimeouts = 0;
    rec.lastFailureKind = undefined;
  } else if (outcome.kind === "timeout") {
    rec.failures += 1;
    rec.timeouts = (rec.timeouts ?? 0) + 1;
    rec.consecutiveFailures = (rec.consecutiveFailures ?? 0) + 1;
    rec.consecutiveTimeouts = (rec.consecutiveTimeouts ?? 0) + 1;
    rec.lastFailureKind = "timeout";
  } else {
    // 非超时失败：计入连续失败，但打断连续超时（执行器能 fail-fast 说明进程本身活着）。
    rec.failures += 1;
    rec.consecutiveFailures = (rec.consecutiveFailures ?? 0) + 1;
    rec.consecutiveTimeouts = 0;
    rec.lastFailureKind = "failure";
  }
  if (outcome.latencyMs != null && outcome.latencyMs >= 0) {
    const latency = Math.round(outcome.latencyMs);
    rec.lastLatencyMs = latency;
    rec.latencySamples = (rec.latencySamples ?? 0) + 1;
    rec.totalLatencyMs = (rec.totalLatencyMs ?? 0) + latency;
  }
  // 窗口样本：路由降权与档位校准的统一依据（终身计数保留为审计口径）。
  const sample: ExecutorOutcomeSample = { s: outcome.success ? 1 : 0 };
  if (!outcome.success && outcome.kind === "timeout") sample.t = 1;
  if (outcome.latencyMs != null && outcome.latencyMs >= 0) {
    sample.ms = Math.round(outcome.latencyMs);
  }
  rec.recent = [...(rec.recent ?? []), sample].slice(-HEALTH_WINDOW_SIZE);
  rec.lastUsedAt = new Date().toISOString();
  snap[executor] = rec;
  scheduleFlush(workspace);
}

function scheduleFlush(workspace: string): void {
  // 防抖：同一 workspace 的多次更新合并进一个窗口，窗口结束只写一次最新快照。
  // 窗口内持续更新会重置定时器（最后一次写入覆盖中间状态——snap 是引用，
  // 落盘时读到的总是最新内存状态，不丢数据）。
  const existing = flushTimers.get(workspace);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    flushTimers.delete(workspace);
    void flushWorkspace(workspace);
  }, FLUSH_DEBOUNCE_MS);
  timer.unref();
  flushTimers.set(workspace, timer);
}

async function flushWorkspace(workspace: string): Promise<void> {
  if (DIRTY.has(workspace)) return; // 上一次 flush 仍在写
  DIRTY.add(workspace);
  const snap = MEM.get(workspace);
  if (!snap) {
    DIRTY.delete(workspace);
    return;
  }
  const file = fileFor(workspace);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    /* 目录已存在或不可写，忽略 */
  }
  try {
    // 后台最佳努力落盘：失败静默忽略（健康度只是增强项）。
    await writeFile(file, JSON.stringify(snap, null, 2), "utf8");
  } catch {
    /* 落盘失败不阻塞主流程 */
  } finally {
    DIRTY.delete(workspace);
  }
}

/** 测试/重置用：清空进程内缓存与排定的 flush（落盘文件不受影响）。 */
export function resetHealthStore(): void {
  MEM.clear();
  DIRTY.clear();
  for (const timer of flushTimers.values()) clearTimeout(timer);
  flushTimers.clear();
}

/** 立即冲刷某 workspace 的挂起写入（测试/关闭用）：等待防抖窗口内的更新落盘。 */
export async function flushHealthStore(workspace: string): Promise<void> {
  const timer = flushTimers.get(workspace);
  if (timer) clearTimeout(timer);
  flushTimers.delete(workspace);
  await flushWorkspace(workspace);
}
