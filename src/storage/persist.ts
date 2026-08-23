/**
 * storage/persist —— 任务状态与队列的 SQLite 持久化。
 *
 * 从原 storage.ts 抽出。jobs 表（权威 state）+ queue_state 单行 blob 的容错读写、
 * CAS 乐观并发写、终态双写与审批重入队（全部与调度器共用队列锁）。
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { now, isMissing } from "./io.js";
import { withQueueLock } from "./locks.js";
import { database, databaseReadonly, type CbxDatabase } from "./db.js";

function readQueueBlob(
  db: CbxDatabase,
): { entries?: Array<Record<string, unknown>> } & Record<string, unknown> {
  const row = db
    .prepare("SELECT state_json FROM queue_state WHERE singleton = 1")
    .get() as { state_json: string } | undefined;
  if (row) {
    try {
      return JSON.parse(row.state_json) as ReturnType<typeof readQueueBlob>;
    } catch (error) {
      console.error(
        `cbx: queue_state 损坏（${error instanceof Error ? error.message : String(error)}），重置为空队列。`,
      );
    }
  }
  const fresh = { maxConcurrent: 2, paused: false, entries: [], updatedAt: now() };
  db.prepare(
    "INSERT INTO queue_state(singleton, state_json, updated_at) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
  ).run(JSON.stringify(fresh), now());
  return fresh;
}

async function legacyQueue(
  workspace: string,
  db: CbxDatabase,
  fallback: unknown,
): Promise<unknown> {
  const existing = db
    .prepare("SELECT state_json FROM queue_state WHERE singleton = 1")
    .get() as { state_json: string } | undefined;
  if (!existing) {
    // 首次开库：尝试从 legacy queue.json 种子；文件损坏（非 ENOENT 的解析失败）
    // 落回默认值而不是抛错，否则整个工作区的队列操作被一个坏文件砖死。
    const file = path.join(workspace, ".cbx", "queue.json");
    let value = fallback;
    try {
      value = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (!isMissing(error))
        console.error(
          `cbx: legacy queue.json 损坏（${error instanceof Error ? error.message : String(error)}），使用默认空队列。`,
        );
    }
    db.prepare(
      "INSERT OR IGNORE INTO queue_state(singleton, state_json, updated_at) VALUES (1, ?, ?)",
    ).run(JSON.stringify(value), now());
  }
  // 统一走容错读取：种子竞态中抢到的行、或已存在的损坏 blob 都在此归一。
  return readQueueBlob(db);
}

export async function loadPersistedState<T>(
  workspace: string,
  jobId: string,
): Promise<T | undefined> {
  const db = await databaseReadonly(workspace);
  const row = db
    .prepare("SELECT state_json FROM jobs WHERE job_id = ?")
    .get(jobId) as { state_json: string } | undefined;
  return row ? (JSON.parse(row.state_json) as T) : undefined;
}
export async function savePersistedState(
  workspace: string,
  jobId: string,
  value: unknown,
): Promise<void> {
  const db = await database(workspace);
  db.prepare(
    "INSERT INTO jobs(job_id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
  ).run(jobId, JSON.stringify(value), now());
}
/**
 * 乐观并发写（CAS）：仅当 jobs 行内容仍是 `expected` 的序列化形态时才写入，
 * 否则返回 false——调用方应重读最新状态、重放自己的 updates 后重试。
 * 用于非终态的解锁写路径（writeState/bumpInvocationCount 等）：这些路径不走
 * 队列锁，与调度器/其他写者的整 blob 写回并发时按 CAS 收敛，不再互相回退
 * 对方快照。行不存在时（首个写者）直接插入并返回 true。
 */
export async function savePersistedStateCas(
  workspace: string,
  jobId: string,
  expected: unknown,
  value: unknown,
): Promise<boolean> {
  const db = await database(workspace);
  const expectedJson = JSON.stringify(expected);
  const updated = db
    .prepare(
      "UPDATE jobs SET state_json = ?, updated_at = ? WHERE job_id = ? AND state_json = ?",
    )
    .run(JSON.stringify(value), now(), jobId, expectedJson);
  if (updated.changes === 1) return true;
  const exists = db.prepare("SELECT 1 FROM jobs WHERE job_id = ?").get(jobId);
  if (!exists) {
    db.prepare(
      "INSERT INTO jobs(job_id, state_json, updated_at) VALUES (?, ?, ?)",
    ).run(jobId, JSON.stringify(value), now());
    return true;
  }
  return false;
}
/**
 * 列出持久化任务状态（按 updated_at 倒序）。
 *
 * 分页：`limit` 缺省不限（保持既有行为——终态删除、跨任务聚合等调用方需要全量）；
 * `limit` 给定正整数时按 limit/offset 分页取最近 N 条，避免大工作区（上千任务）
 * 每次全表扫描 + 逐行 JSON.parse。`offset` 仅在给定 limit 时有意义。
 * 索引：v5 迁移为 jobs.updated_at 建索引（ORDER BY updated_at DESC 走索引）。
 */
export async function listPersistedStates<T>(
  workspace: string,
  options: { limit?: number; offset?: number } = {},
): Promise<T[]> {
  const db = await databaseReadonly(workspace);
  let rows: Array<{ state_json: string }>;
  const limit = options.limit;
  if (limit !== undefined && Number.isInteger(limit) && limit > 0) {
    const offset = Number.isInteger(options.offset) && (options.offset ?? 0) > 0
      ? options.offset!
      : 0;
    rows = db
      .prepare(
        "SELECT state_json FROM jobs ORDER BY updated_at DESC LIMIT ? OFFSET ?",
      )
      .all(limit, offset) as Array<{ state_json: string }>;
  } else {
    rows = db
      .prepare("SELECT state_json FROM jobs ORDER BY updated_at DESC")
      .all() as Array<{ state_json: string }>;
  }
  // 单条损坏的 state_json 不应拖垮整个 listJobs/health：跳过坏行保持其他 job 可见，
  // 与 importLegacyData 的损坏行跳过策略一致；恢复需 cbx forget 后重建。
  const out: T[] = [];
  for (const row of rows) {
    try {
      out.push(JSON.parse(row.state_json) as T);
    } catch {
      /* skip corrupt row */
    }
  }
  return out;
}

/**
 * 单事务删除 jobId 在持久化层（jobs 表 + queue_state entries）的全部记录。
 *
 * 与 `queue.cancelQueueEntries` 不同：cancel 是把 active entries 标 cancelled（审计可见），
 * forget 是把同 jobId 的所有 entries 物理过滤掉。两者串联——上层先 cancel 杀活 worker
 * 并持久化 cancelled 状态，再 forget 清掉 entries 残留，**单事务**确保 jobs 行删和
 * queue entries 删要么都成功要么都回滚，避免 listJobs 看不见但 queue 还残留的撕裂状态。
 *
 * 返回剩余 queue 长度供上层做断言与日志。
 */
export async function forgetPersistedJob(
  workspaceInput: string,
  jobId: string,
): Promise<{ deletedJob: boolean; remainingEntries: number }> {
  const workspace = path.resolve(workspaceInput);
  const db = await database(workspace);
  return withQueueLock(workspace, async () => {
    let deletedJob = false;
    let remainingEntries = 0;
    db.transaction(() => {
      const result = db
        .prepare("DELETE FROM jobs WHERE job_id = ?")
        .run(jobId);
      deletedJob = result.changes > 0;
      const row = db
        .prepare("SELECT state_json FROM queue_state WHERE singleton = 1")
        .get() as { state_json: string } | undefined;
      if (row) {
        const queue = JSON.parse(row.state_json) as {
          entries?: Array<{ jobId?: string; [k: string]: unknown }>;
        };
        const before = queue.entries?.length ?? 0;
        const filtered = (queue.entries ?? []).filter(
          (entry) => entry.jobId !== jobId,
        );
        remainingEntries = filtered.length;
        if (before !== filtered.length) {
          db.prepare(
            "UPDATE queue_state SET state_json = ?, updated_at = ? WHERE singleton = 1",
          ).run(JSON.stringify({ ...queue, entries: filtered }), now());
        }
      }
    })();
    return { deletedJob, remainingEntries };
  });
}

export async function loadPersistedQueue<T>(
  workspace: string,
  fallback: T,
): Promise<T> {
  return (await legacyQueue(
    path.resolve(workspace),
    await database(workspace),
    fallback,
  )) as T;
}
// intentional-simple: queue_state 整 blob 读写（每次入队/状态变更全量反序列化+序列化+写回）。
// 单 workspace 队列规模小（通常 <100 entry），开销可忽略；升级路径：queue 条目独立行存储 + 增量更新。
export async function savePersistedQueue(
  workspace: string,
  value: unknown,
): Promise<void> {
  const db = await database(workspace);
  db.prepare(
    "INSERT INTO queue_state(singleton, state_json, updated_at) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
  ).run(JSON.stringify(value), now());
}
export async function savePersistedStateAndQueue(
  workspace: string,
  jobId: string,
  state: unknown,
  queue: unknown,
): Promise<void> {
  const db = await database(workspace);
  await legacyQueue(path.resolve(workspace), db, { entries: [] });
  db.transaction(() => {
    db.prepare(
      "INSERT INTO jobs(job_id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
    ).run(jobId, JSON.stringify(state), now());
    db.prepare(
      "UPDATE queue_state SET state_json = ?, updated_at = ? WHERE singleton = 1",
    ).run(JSON.stringify(queue), now());
  })();
}
export async function savePersistedStateAndFinishQueue(
  workspace: string,
  jobId: string,
  state: Record<string, unknown>,
  queueId: string,
): Promise<void> {
  const db = await database(workspace);
  await legacyQueue(path.resolve(workspace), db, { entries: [] });
  db.transaction(() => {
    const queue = readQueueBlob(db);
    const entry = queue.entries?.find((item) => item.queueId === queueId);
    if (entry) {
      const status = String(state.status);
      entry.status =
        status === "done"
          ? "done"
          : status === "cancelled"
            ? "cancelled"
            : status === "awaiting_approval"
              ? "awaiting_approval"
              : status === "needs_fix" || status === "review_failed"
                ? "needs_fix"
                : "failed";
      entry.finishedAt = now();
      entry.pid = undefined;
    }
    db.prepare(
      "INSERT INTO jobs(job_id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
    ).run(jobId, JSON.stringify(state), now());
    db.prepare(
      "UPDATE queue_state SET state_json = ?, updated_at = ? WHERE singleton = 1",
    ).run(JSON.stringify(queue), now());
  })();
}
export async function savePersistedStateAndResolveApprovalQueue(
  workspace: string,
  jobId: string,
  state: Record<string, unknown>,
  queueStatus: "done" | "failed",
): Promise<void> {
  const db = await database(workspace);
  await legacyQueue(path.resolve(workspace), db, { entries: [] });
  db.transaction(() => {
    const queue = readQueueBlob(db);
    for (const entry of queue.entries ?? []) {
      if (entry.jobId === jobId && entry.status === "awaiting_approval") {
        entry.status = queueStatus;
        entry.finishedAt = now();
        entry.pid = undefined;
      }
    }
    db.prepare(
      "INSERT INTO jobs(job_id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
    ).run(jobId, JSON.stringify(state), now());
    db.prepare(
      "UPDATE queue_state SET state_json = ?, updated_at = ? WHERE singleton = 1",
    ).run(JSON.stringify(queue), now());
  })();
}
/**
 * before_run 审批通过的原子重入队：状态回 queued 与 awaiting_approval 队列条目
 * 重新激活（置 queued、清 finishedAt/pid）在同一事务落盘。原实现的"条目置 done +
 * 调用方再补 startBackground"两段式，在两步之间崩溃会留下 state=queued 但无活跃
 * 队列条目的断层——调度器只看条目，这样的任务永远不会被再次派发。
 */
export async function saveApprovalRequeue(
  workspace: string,
  jobId: string,
  state: Record<string, unknown>,
): Promise<void> {
  const db = await database(workspace);
  await legacyQueue(path.resolve(workspace), db, { entries: [] });
  db.transaction(() => {
    const queue = readQueueBlob(db);
    for (const entry of queue.entries ?? []) {
      if (entry.jobId === jobId && entry.status === "awaiting_approval") {
        entry.status = "queued";
        delete entry.finishedAt;
        entry.pid = undefined;
      }
    }
    db.prepare(
      "INSERT INTO jobs(job_id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
    ).run(jobId, JSON.stringify(state), now());
    db.prepare(
      "UPDATE queue_state SET state_json = ?, updated_at = ? WHERE singleton = 1",
    ).run(JSON.stringify(queue), now());
  })();
}
