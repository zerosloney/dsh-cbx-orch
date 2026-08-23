/**
 * storage/metrics —— 健康指标聚合。
 *
 * 从原 storage.ts 抽出。persistedMetrics 供 /healthz 与仪表盘：按状态计数、队列深度、
 * 投递失败/挂起数、事件镜像失败计数（进程内存态，重启归零）。
 */
import { database, type CbxDatabase } from "./db.js";
import { peekQueueBlob } from "./prune.js";
const eventMirrorFailures = new Map<string, number>();
/** 有界：防止长期运行/大量工作区时该诊断 Map 无限增长。超过上限丢弃最旧条目。 */
const EVENT_MIRROR_FAILURES_MAX = 64;

/** 累计一次某 workspace 的事件镜像失败（幂等计数）。 */
export function recordEventMirrorFailure(workspace: string): void {
  eventMirrorFailures.set(workspace, (eventMirrorFailures.get(workspace) ?? 0) + 1);
  // intentional-simple: 线性淘汰最旧条目，条目数远小于 64 时无感知；需按 LRU 淘汰时再升级。
  if (eventMirrorFailures.size > EVENT_MIRROR_FAILURES_MAX) {
    const oldest = eventMirrorFailures.keys().next().value as string | undefined;
    if (oldest !== undefined) eventMirrorFailures.delete(oldest);
  }
}

export async function persistedMetrics(workspace: string): Promise<{
  jobsByStatus: Record<string, number>;
  queueDepth: number;
  failedJobs: number;
  retryingJobs: number;
  deliveryFailures: number;
  pendingDeliveries: number;
  /** 事件 SQLite 镜像写入失败累计次数（本进程内存态）；>0 说明 SSE 回放可能
   *  与 events.ndjson 审计轨迹漂移。跨进程/重启后归零，仅作近期漂移信号。 */
  eventMirrorFailures: number;
}> {
  const db = await database(workspace);
  const rows = db.prepare("SELECT state_json FROM jobs").all() as Array<{
    state_json: string;
  }>;
  const jobsByStatus: Record<string, number> = {};
  let retryingJobs = 0;
  for (const row of rows) {
    // 单条损坏的 state_json 不应打挂 metrics/health：与 listPersistedStates 相同的
    // 容错策略跳过坏行，计数归入 unknown 保持总数可见。
    let state: { status?: string; phase?: string };
    try {
      state = JSON.parse(row.state_json) as { status?: string; phase?: string };
    } catch {
      jobsByStatus.unknown = (jobsByStatus.unknown ?? 0) + 1;
      continue;
    }
    const status = state.status ?? "unknown";
    jobsByStatus[status] = (jobsByStatus[status] ?? 0) + 1;
    if (state.phase === "retrying") retryingJobs += 1;
  }
  const queue = peekQueueBlob(db);
  return {
    jobsByStatus,
    queueDepth: (queue.entries ?? []).filter((entry) =>
      ["queued", "running", "awaiting_approval"].includes(String(entry.status)),
    ).length,
    failedJobs: jobsByStatus.failed ?? 0,
    retryingJobs,
    deliveryFailures: Number(
      (
        db.prepare("SELECT COUNT(*) AS count FROM delivery_failures").get() as {
          count: number;
        }
      ).count,
    ),
    pendingDeliveries: Number(
      (
        db.prepare("SELECT COUNT(*) AS count FROM delivery_outbox").get() as {
          count: number;
        }
      ).count,
    ),
    eventMirrorFailures: eventMirrorFailures.get(workspace) ?? 0,
  };
}

