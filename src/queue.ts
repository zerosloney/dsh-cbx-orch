import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { acquireServiceLease, loadPersistedQueue, now, processAlive, savePersistedQueue, withQueueLock } from "./storage.js";
import { isCbxError } from "./errors.js";
import { terminateTree } from "./process-runner.js";
import { startInProcessJob } from "./worker.js";

/** 队列降级路径失败原因落到 job 事件流。 */
function logJobEvent(runtime: QueueRuntime, workspace: string, jobId: string, event: string, detail: Record<string, unknown> = {}): void {
  try { appendFileSync(path.join(runtime.jobDir(workspace, jobId), "events.ndjson"), JSON.stringify({ event, jobId, ...detail, at: now() }) + "\n", "utf8"); }
  catch { /* events file unreachable */ }
}

export type QueueEntryStatus = "queued" | "running" | "done" | "failed" | "awaiting_approval" | "cancelled";
export interface QueueEntry {
  queueId: string; jobId: string; workspace: string; extra: string; status: QueueEntryStatus;
  createdAt: string; startedAt?: string; finishedAt?: string; pid?: number; error?: string; priority: number;
  /** 死 worker 被回收重派的累计次数；超过上限熔断为 failed，避免损坏状态引发无限重派。 */
  reclaimCount?: number;
}
export interface QueueFile { maxConcurrent: number; paused: boolean; entries: QueueEntry[]; updatedAt: string; }

export interface QueueRuntime {
  loadConfig(workspace: string): Promise<{ maxConcurrent?: number }>;
  loadState(workspace: string, jobId: string): Promise<{ status: string; [key: string]: unknown }>;
  writeState(workspace: string, jobId: string, updates: Record<string, unknown>): Promise<unknown>;
  saveStateAndQueue(workspace: string, jobId: string, state: Record<string, unknown>, queue: QueueFile): Promise<void>;
  finishQueueEntryPersisted(workspace: string, jobId: string, state: Record<string, unknown>, queueId: string): Promise<void>;
  jobDir(workspace: string, jobId: string): string;
}

export interface QueueService { done: Promise<void>; stop(): Promise<void>; }

async function loadQueue(workspace: string): Promise<QueueFile> {
  const queue = await loadPersistedQueue<QueueFile>(workspace, { maxConcurrent: 2, paused: false, entries: [], updatedAt: now() });
  if (!queue || !Array.isArray(queue.entries)) throw new Error("queue.json 结构无效。");
  queue.paused ??= false;
  for (const entry of queue.entries) entry.priority ??= 0;
  return queue;
}

async function saveQueue(workspace: string, queue: QueueFile): Promise<void> {
  queue.updatedAt = now();
  await savePersistedQueue(workspace, queue);
}

function configuredConcurrency(value: number | undefined): number {
  const maximum = Number(value ?? 2);
  if (!Number.isInteger(maximum) || maximum < 1) throw new Error("maxConcurrent 必须是正整数。");
  return maximum;
}

// intentional-simple: worker 起步 + worktree 创建 + executor spawn 应 < 60s。超过仍无 heartbeat 视为僵尸（pid 复用或 spawn ENOENT 后 pid 被复用）。
const WORKER_HEARTBEAT_GRACE_MS = 60_000;
const WORKER_HEARTBEAT_STALE_MS = 45_000;
// 死 worker 回收重派的上限：超过即熔断为 failed，避免状态永久损坏时无限 spawn。
const MAX_RECLAIMS = 3;
const SERVICE_LEASE_TTL_MS = 45_000;

async function spawnQueueWorker(runtime: QueueRuntime, workspace: string, entry: QueueEntry): Promise<number> {
  // DeepSeek Harness plugin: jobs run in-process (no detached `cli.js` worker
  // binary). Orchestration is pure TS; executors/tests are tree-scoped
  // subprocesses the job-runtime registry can terminate on cancel. The worker
  // writes `pid`/`worker.heartbeat` itself.
  return startInProcessJob(workspace, entry.jobId, entry.queueId, entry.extra);
}

export async function dispatchQueue(runtime: QueueRuntime, workspaceInput: string): Promise<QueueFile> {
  const workspace = path.resolve(workspaceInput);
  try {
    return await withQueueLock(workspace, async () => {
      const maxConcurrent = configuredConcurrency((await runtime.loadConfig(workspace)).maxConcurrent);
      const queue = await loadQueue(workspace);
      queue.maxConcurrent = maxConcurrent;
      for (const entry of queue.entries.filter(item => item.status === "running")) {
        // 双重回收校验：pid 不存活 OR 有 pid 但无 heartbeat 且超 grace（pid 复用 / spawn ENOENT 后 pid 被复用）。
        const heartbeatFile = path.join(runtime.jobDir(workspace, entry.jobId), "worker.heartbeat");
        let heartbeatModifiedAt: number | undefined;
        try { heartbeatModifiedAt = (await stat(heartbeatFile)).mtimeMs; } catch { /* worker may not have started */ }
        const startedAt = Date.parse(entry.startedAt ?? entry.createdAt);
        const stale = !processAlive(entry.pid)
          || (heartbeatModifiedAt === undefined && Number.isFinite(startedAt) && Date.now() - startedAt > WORKER_HEARTBEAT_GRACE_MS)
          || (heartbeatModifiedAt !== undefined && Date.now() - heartbeatModifiedAt > WORKER_HEARTBEAT_STALE_MS);
        if (!stale) continue;
        let reclaimed: QueueEntryStatus;
        try {
          const state = await runtime.loadState(workspace, entry.jobId);
          reclaimed = state.status === "done" ? "done" : state.status === "cancelled" ? "cancelled" : "queued";
        } catch (error) { logJobEvent(runtime, workspace, entry.jobId, "queue_reclaim_failed", { error: error instanceof Error ? error.message : String(error) }); reclaimed = "queued"; }
        if (reclaimed === "queued") {
          // 区分瞬时崩溃与运行中崩溃：产出过 heartbeat 的回收视为正常运行后崩溃（OOM/被杀），归零 reclaimCount；
          // 从未产出 heartbeat（spawn 后 grace 期内即失活）才是瞬时失败链，累计计数以触发熔断。
          entry.reclaimCount = heartbeatModifiedAt !== undefined ? 0 : (entry.reclaimCount ?? 0) + 1;
          if (entry.reclaimCount > MAX_RECLAIMS) {
            // 熔断：worker 反复无法恢复（多为状态永久损坏），停止重派避免无限 spawn。
            entry.status = "failed";
            entry.error = `worker 反复无法恢复（已回收 ${entry.reclaimCount} 次），停止自动重派；请检查任务状态后用 retry 手动重跑。`;
            entry.finishedAt = now();
            logJobEvent(runtime, workspace, entry.jobId, "queue_reclaim_circuit_breaker", { reclaimCount: entry.reclaimCount });
          } else {
            entry.status = "queued";
          }
        } else {
          entry.status = reclaimed;
        }
        entry.pid = undefined;
      }
      let active = queue.entries.filter(entry => entry.status === "running" && processAlive(entry.pid)).length;
      if (!queue.paused) {
        for (const entry of queue.entries.filter(item => item.status === "queued").sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))) {
          if (active >= maxConcurrent) break;
          try { entry.pid = await spawnQueueWorker(runtime, workspace, entry); entry.status = "running"; entry.startedAt = now(); active += 1; }
          catch (error) { entry.status = "failed"; entry.error = String(error); entry.finishedAt = now(); }
        }
      }
      const activeEntries = queue.entries.filter(entry => ["queued", "running", "awaiting_approval"].includes(entry.status));
      const finishedEntries = queue.entries.filter(entry => !activeEntries.includes(entry)).slice(-Math.max(0, 200 - activeEntries.length));
      queue.entries = [...finishedEntries, ...activeEntries];
      await saveQueue(workspace, queue);
      return queue;
    });
  } catch (error) {
    if (isCbxError(error, "E_QUEUE_BUSY")) return loadQueue(workspace);
    throw error;
  }
}

/** Keeps a single dispatcher alive; startup dispatch also reclaims workers left by a prior crash. */
export async function serveQueue(runtime: QueueRuntime, workspaceInput: string, intervalMs = 30_000): Promise<QueueService> {
  if (!Number.isInteger(intervalMs) || intervalMs < 50) throw new Error("serve intervalMs 必须是不小于 50ms 的整数。");
  let stopping = false;
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  const lease = await acquireServiceLease(workspaceInput, "queue-serve", SERVICE_LEASE_TTL_MS);
  let inFlight: Promise<void> | undefined;
  const tick = (): Promise<void> => {
    if (stopping || inFlight) return inFlight ?? Promise.resolve();
    inFlight = dispatchQueue(runtime, workspaceInput)
      .then(() => undefined)
      .catch(error => console.error(`cbx: 调度器执行失败：${error instanceof Error ? error.message : error}`))
      .finally(() => { inFlight = undefined; });
    return inFlight;
  };
  await tick();
  const timer = setInterval(() => { void tick(); }, intervalMs);
  const leaseTimer = setInterval(() => {
    void lease.renew().then(owned => {
      if (owned || stopping) return;
      stopping = true;
      clearInterval(timer);
      clearInterval(leaseTimer);
      console.error("cbx: serve 租约已丢失，停止调度以避免双主。");
      resolveDone();
    }).catch(error => console.error(`cbx: serve 租约续期失败：${error instanceof Error ? error.message : error}`));
  }, Math.floor(SERVICE_LEASE_TTL_MS / 3));
  leaseTimer.unref();
  return { done, async stop(): Promise<void> { stopping = true; clearInterval(timer); clearInterval(leaseTimer); await inFlight; await lease.release(); resolveDone(); } };
}

export async function enqueueJob(runtime: QueueRuntime, workspaceInput: string, jobId: string, extra = "", priority = 0): Promise<QueueEntry> {
  const workspace = path.resolve(workspaceInput);
  if (!Number.isFinite(priority)) throw new Error("priority 必须是数字。");
  const entry = await withQueueLock(workspace, async () => {
    const maxConcurrent = configuredConcurrency((await runtime.loadConfig(workspace)).maxConcurrent);
    const queue = await loadQueue(workspace);
    queue.maxConcurrent = maxConcurrent;
    // awaiting_approval 也是活跃状态：等待审批的任务不应被再次入队（否则双 entry 会旁路审批门）。
    const duplicate = queue.entries.find(
      (item) =>
        item.jobId === jobId &&
        ["queued", "running", "awaiting_approval"].includes(item.status),
    );
    if (duplicate) throw new Error(`任务已经在队列中：${jobId}`);
    const created: QueueEntry = { queueId: `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`, jobId, workspace, extra, status: "queued", createdAt: now(), priority };
    queue.entries.push(created);
    await saveQueue(workspace, queue);
    return created;
  });
  await dispatchQueue(runtime, workspace);
  return entry;
}

export async function finishQueueEntry(runtime: QueueRuntime, workspaceInput: string, queueId: string): Promise<void> {
  const workspace = path.resolve(workspaceInput);
  await withQueueLock(workspace, async () => {
    const queue = await loadQueue(workspace);
    const entry = queue.entries.find(item => item.queueId === queueId);
    if (!entry) return;
    let state: Record<string, unknown>;
    try { state = await runtime.loadState(workspace, entry.jobId); }
    catch (error) {
      // loadState 失败时降级手写 failed，与历史行为一致；映射逻辑权威来源仍是 finishQueueEntryPersisted。
      entry.status = "failed"; entry.error = String(error); entry.finishedAt = now(); entry.pid = undefined;
      await saveQueue(workspace, queue);
      return;
    }
    // 状态映射收敛到 storage 层 finishQueueEntryPersisted，queue 层不再存副本。
    await runtime.finishQueueEntryPersisted(workspace, entry.jobId, state, queueId);
  });
  await dispatchQueue(runtime, workspace);
}

export function listQueue(_runtime: QueueRuntime, workspaceInput: string): Promise<QueueFile> { return loadQueue(path.resolve(workspaceInput)); }

export async function pauseQueue(_runtime: QueueRuntime, workspaceInput: string): Promise<QueueFile> {
  const workspace = path.resolve(workspaceInput);
  return withQueueLock(workspace, async () => { const queue = await loadQueue(workspace); queue.paused = true; await saveQueue(workspace, queue); return queue; });
}

/** 把某任务仍处于 queued/running/awaiting_approval 的队列条目标记为 cancelled。 */
export async function cancelQueueEntries(runtime: QueueRuntime, workspaceInput: string, jobId: string): Promise<QueueFile> {
  const workspace = path.resolve(workspaceInput);
  return withQueueLock(workspace, async () => {
    const queue = await loadQueue(workspace);
    for (const entry of queue.entries.filter(item => item.jobId === jobId && ["queued", "running", "awaiting_approval"].includes(item.status))) {
      entry.status = "cancelled";
      entry.finishedAt = now();
      entry.pid = undefined;
    }
    await saveQueue(workspace, queue);
    return queue;
  });
}

/**
 * 单锁内原子完成取消终态：把 jobId 所有活跃队列条目标记 cancelled，并同时写入最终 state。
 * 与 worker 终态双写（writeState 携带 queueEntryId 的路径）共用同一把队列锁，二者串行化，
 * 避免并发时 state 与 queue entry 撕裂——典型场景：任务恰好自然完成写了 done，
 * cancelJob 随后单独写 cancelled，导致 state=cancelled 而 entry=done 的不一致残留。
 * 幂等：已 cancelled/done 的条目不会被再次改写。
 */
export async function cancelQueueEntriesWithState(
  runtime: QueueRuntime,
  workspaceInput: string,
  jobId: string,
  updates: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const workspace = path.resolve(workspaceInput);
  return withQueueLock(workspace, async () => {
    const queue = await loadQueue(workspace);
    for (const entry of queue.entries.filter(
      (item) =>
        item.jobId === jobId &&
        ["queued", "running", "awaiting_approval"].includes(item.status),
    )) {
      entry.status = "cancelled";
      entry.finishedAt = now();
      entry.pid = undefined;
    }
    const current = (await runtime.loadState(
      workspace,
      jobId,
    )) as Record<string, unknown>;
    const state = { ...current, ...updates, updatedAt: now() };
    await runtime.saveStateAndQueue(workspace, jobId, state, queue);
    return state;
  });
}

export async function resumeQueue(runtime: QueueRuntime, workspaceInput: string): Promise<QueueFile> {
  const workspace = path.resolve(workspaceInput);
  await withQueueLock(workspace, async () => { const queue = await loadQueue(workspace); queue.paused = false; await saveQueue(workspace, queue); });
  return dispatchQueue(runtime, workspace);
}

export async function retryQueueJob(runtime: QueueRuntime, workspaceInput: string, jobId: string, priority = 0): Promise<QueueEntry> {
  const workspace = path.resolve(workspaceInput);
  const state = await runtime.loadState(workspace, jobId);
  if (["running", "queued", "awaiting_approval"].includes(state.status)) throw new Error(`任务当前仍在执行、排队或等待审批：${jobId}`);
  const directory = runtime.jobDir(workspace, jobId);
  // 单事务完成：老 entry 标 cancelled + 终止僵尸进程 + 插新 entry + 状态重置。
  // terminateTree 与 entry 状态变更必须同在队列锁内，否则与 dispatchQueue 回收并发时会误杀新 worker 或互相覆盖。
  const replacement = await withQueueLock(workspace, async () => {
    // 旧 worker 可能仍是僵尸进程(已被回收但进程未退出)：写取消标记 + 终止进程树，
    // 避免新 entry 启动时 run.lock 被旧进程持有而 E_LOCK_BUSY 失败。
    await writeFile(path.join(directory, "cancel.requested"), now(), "utf8").catch(() => undefined);
    const oldPid = Number(await readFile(path.join(directory, "active.pid"), "utf8").catch(() => ""));
    if (Number.isSafeInteger(oldPid) && oldPid > 0) await terminateTree(oldPid);
    // 清除取消标记，避免 executeJob 把新 entry 直接判为 cancelled。
    try { await unlink(path.join(directory, "cancel.requested")); } catch { /* 无待取消标记 */ }
    const queue = await loadQueue(workspace);
    for (const entry of queue.entries.filter(item => item.jobId === jobId && ["queued", "running"].includes(item.status))) {
      entry.status = "cancelled"; entry.finishedAt = now(); entry.error = "被新的 retry 请求取代"; entry.pid = undefined;
    }
    const current = await runtime.loadState(workspace, jobId);
    const created: QueueEntry = { queueId: `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`, jobId, workspace, extra: "请读取已有的 test.log、review.md 和 result.json，修复失败原因后重新执行。", status: "queued", createdAt: now(), priority };
    queue.entries.push(created);
    queue.updatedAt = now();
    await runtime.saveStateAndQueue(workspace, jobId, { ...current, status: "queued", phase: "queued", error: null, timedOut: false, updatedAt: now(), executionUsed: 0, fixUsed: 0, stageRetries: {} }, queue);
    return created;
  });
  await dispatchQueue(runtime, workspace);
  return replacement;
}
