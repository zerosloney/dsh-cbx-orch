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
  /** 累计失败次数。 */
  failures: number;
  /** 连续失败计数：路由层据此降权，成功一次即清零。 */
  consecutiveFailures: number;
  /** 最近一次调用的延迟（毫秒）。 */
  lastLatencyMs?: number;
  /** 最近一次使用时间（ISO），LRU / round-robin 用。 */
  lastUsedAt?: string;
}

export type HealthSnapshot = Record<string, ExecutorHealthRecord>;

export interface Outcome {
  success: boolean;
  latencyMs?: number;
}

const MEM = new Map<string, HealthSnapshot>();
const DIRTY = new Set<string>();

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
  } else {
    rec.failures += 1;
    rec.consecutiveFailures = (rec.consecutiveFailures ?? 0) + 1;
  }
  if (outcome.latencyMs != null && outcome.latencyMs >= 0) {
    rec.lastLatencyMs = Math.round(outcome.latencyMs);
  }
  rec.lastUsedAt = new Date().toISOString();
  snap[executor] = rec;
  scheduleFlush(workspace);
}

function scheduleFlush(workspace: string): void {
  if (DIRTY.has(workspace)) return;
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
  // 后台最佳努力落盘：失败静默忽略。
  writeFile(file, JSON.stringify(snap, null, 2), "utf8")
    .catch(() => undefined)
    .finally(() => DIRTY.delete(workspace));
}

/** 测试/重置用：清空进程内缓存（落盘文件不受影响）。 */
export function resetHealthStore(): void {
  MEM.clear();
  DIRTY.clear();
}
