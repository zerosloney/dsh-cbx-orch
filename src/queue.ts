import { randomBytes } from "node:crypto";
import { stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { acquireServiceLease, forceReleaseOwnLock, loadPersistedQueue, now, processAlive, savePersistedQueue, withQueueLock } from "./storage.js";
import { isCbxError } from "./errors.js";
import { logJobEvent } from "./state.js";
import { terminateTree } from "./process-runner.js";
import { pidRecordOwnsProcess, readPidRecord } from "./pid-guard.js";
import { abortRunningJob, getRunningJob } from "./job-runtime.js";
import { startInProcessJob } from "./worker.js";

export type QueueEntryStatus = "queued" | "running" | "done" | "failed" | "awaiting_approval" | "cancelled" | "needs_fix";
export interface QueueEntry {
  queueId: string; jobId: string; workspace: string; extra: string; status: QueueEntryStatus;
  createdAt: string; startedAt?: string; finishedAt?: string; pid?: number; error?: string; priority: number;
  /** 死 worker 被回收重派的累计次数；超过上限熔断为 failed，避免损坏状态引发无限重派。连续计数，不因 heartbeat 归零。 */
  reclaimCount?: number;
  /** 最近一次回收时间（ISO）；重派按 reclaimCount 指数退避，避免熔断前高频重放执行器。 */
  lastReclaimAt?: string;
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
export type WorkspaceIdentityGuard = () => Promise<void>;

async function loadQueue(workspace: string): Promise<QueueFile> {
  const queue = await loadPersistedQueue<QueueFile>(workspace, { maxConcurrent: 2, paused: false, entries: [], updatedAt: now() });
  // 损坏结构（entries 非数组等）重置为空队列而非抛错：任务状态在 jobs 表，
  // 队列视图可重建；一条坏数据打挂全部队列操作代价更高。
  if (!queue || typeof queue !== "object" || !Array.isArray(queue.entries)) {
    console.error("cbx: 队列数据结构无效，重置为空队列。");
    return { maxConcurrent: 2, paused: false, entries: [], updatedAt: now() };
  }
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

/** 回收重派退避：第 n 次回收后须等待 60s * 2^(n-1)（封顶 30min）才允许再次 spawn。
 *  损坏的 lastReclaimAt（NaN）按满额退避处理——静默当作"无需等待"会让坏状态高频重放执行器。 */
export function reclaimBackoffRemainingMs(entry: QueueEntry): number {
  if (!entry.reclaimCount || !entry.lastReclaimAt) return 0;
  const waitMs = Math.min(60_000 * 2 ** (entry.reclaimCount - 1), 30 * 60_000);
  const since = Date.now() - Date.parse(entry.lastReclaimAt);
  if (!Number.isFinite(since)) return waitMs;
  return since >= waitMs ? 0 : waitMs - since;
}

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
        // 进程内条目（pid 恒为本进程 pid）追加一条即刻判死：registry 注销发生在 worker
        // 的 finally（同步于 startInProcessJob 返回前完成注册），注销即证明 worker 已
        // 终止——无需等 45s 心跳超时，死 worker 不再白占并发槽。
        const inProcessDead = entry.pid === process.pid && !getRunningJob(workspace, entry.jobId);
        const heartbeatFile = path.join(runtime.jobDir(workspace, entry.jobId), "worker.heartbeat");
        let heartbeatModifiedAt: number | undefined;
        try { heartbeatModifiedAt = (await stat(heartbeatFile)).mtimeMs; } catch { /* worker may not have started */ }
        const startedAt = Date.parse(entry.startedAt ?? entry.createdAt);
        const stale = !processAlive(entry.pid)
          || inProcessDead
          || (heartbeatModifiedAt === undefined && Number.isFinite(startedAt) && Date.now() - startedAt > WORKER_HEARTBEAT_GRACE_MS)
          || (heartbeatModifiedAt !== undefined && Date.now() - heartbeatModifiedAt > WORKER_HEARTBEAT_STALE_MS);
        if (!stale) continue;
        if (entry.pid === process.pid && !inProcessDead) {
          // 进程内僵尸接管（事件循环阻塞：registry 仍在但心跳停更）。旧路径只重排队，
          // 新 worker 会撞上仍被"活 pid 持锁"保护的 run.lock，E_LOCK_BUSY 直到熔断——
          // 任务永久卡死且原 worker 与子进程继续跑。接管序列：写取消标记（旧 worker
          // 恢复后在每个检查点自行退出；新 worker 在 executeJob 入口按取消收口）→
          // 终止其注册的子进程句柄 → 强制释放本进程持有的 run.lock/gate.lock → 重排队。
          const zombieDir = runtime.jobDir(workspace, entry.jobId);
          logJobEvent(workspace, entry.jobId, "queue_reclaim_takeover", {});
          await writeFile(path.join(zombieDir, "cancel.requested"), now(), "utf8").catch(() => undefined);
          abortRunningJob(workspace, entry.jobId);
          await forceReleaseOwnLock(path.join(zombieDir, "run.lock"));
          await forceReleaseOwnLock(path.join(zombieDir, "gate.lock"));
        }
        let reclaimed: QueueEntryStatus;
        try {
          const state = await runtime.loadState(workspace, entry.jobId);
          reclaimed = state.status === "done" ? "done" : state.status === "cancelled" ? "cancelled" : "queued";
        } catch (error) { logJobEvent(workspace, entry.jobId, "queue_reclaim_failed", { error: error instanceof Error ? error.message : String(error) }); reclaimed = "queued"; }
        if (reclaimed === "queued") {
          // 连续计数，不因 heartbeat 归零：产出过 heartbeat 只说明 worker 活到过运行中
          // （OOM/被杀），不代表任务能收敛——确定性崩溃（如损坏的 audit.json 让
          // writeResult 每次必抛）同样每次都产出 heartbeat，归零会让熔断永不触发，
          // 每 60-90s 完整重放一遍执行器、烧 API 配额。重派退避由
          // reclaimBackoffRemainingMs 在派发侧执行。
          entry.reclaimCount = (entry.reclaimCount ?? 0) + 1;
          entry.lastReclaimAt = now();
          if (entry.reclaimCount > MAX_RECLAIMS) {
            // 熔断：worker 反复无法恢复（多为状态永久损坏），停止重派避免无限 spawn。
            entry.status = "failed";
            entry.error = `worker 反复无法恢复（已回收 ${entry.reclaimCount} 次），停止自动重派；请检查任务状态后用 retry 手动重跑。`;
            entry.finishedAt = now();
            logJobEvent(workspace, entry.jobId, "queue_reclaim_circuit_breaker", { reclaimCount: entry.reclaimCount });
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
          // 回收退避中的条目本轮跳过：给上次崩溃留出指数退避窗口再重放执行器。
          if (reclaimBackoffRemainingMs(entry) > 0) continue;
          try { entry.pid = await spawnQueueWorker(runtime, workspace, entry); entry.status = "running"; entry.startedAt = now(); active += 1; }
          catch (error) {
            entry.status = "failed"; entry.error = String(error); entry.finishedAt = now();
            logJobEvent(workspace, entry.jobId, "queue_spawn_failed", { error: String(error) });
          }
        }
      }
      const activeEntries = queue.entries.filter(entry => ["queued", "running", "awaiting_approval"].includes(entry.status));
      // 保留最近 (200 - active) 条终态记录：active ≥ 200 时旧的 slice(-0) 会退化为
      // "全部保留"（无限增长），显式按目标条数从尾部截取。
      const keepFinished = Math.max(0, 200 - activeEntries.length);
      const allFinished = queue.entries.filter(entry => !activeEntries.includes(entry));
      const finishedEntries = allFinished.slice(Math.max(0, allFinished.length - keepFinished));
      queue.entries = [...finishedEntries, ...activeEntries];
      await saveQueue(workspace, queue);
      return queue;
    });
  } catch (error) {
    if (isCbxError(error, "E_QUEUE_BUSY")) {
      // 锁忙时返回当前磁盘队列状态（loadQueue 读实时文件，非缓存）：记录以便排查，
      // 但不抛错——调度重试由调用方（enqueueJob / serveQueue 定时器）负责。
      console.debug(
        `cbx: 队列锁忙，返回当前队列状态（${(error as Error).message}）。`,
      );
      return loadQueue(workspace);
    }
    throw error;
  }
}

/** Keeps a single dispatcher alive; startup dispatch also reclaims workers left by a prior crash. */
export async function serveQueue(
  runtime: QueueRuntime,
  workspaceInput: string,
  intervalMs = 30_000,
  workspaceIdentityGuard?: WorkspaceIdentityGuard,
): Promise<QueueService> {
  if (!Number.isInteger(intervalMs) || intervalMs < 50) throw new Error("serve intervalMs 必须是不小于 50ms 的整数。");
  let stopping = false;
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  const lease = await acquireServiceLease(workspaceInput, "queue-serve", SERVICE_LEASE_TTL_MS);
  let timer: ReturnType<typeof setInterval> | undefined;
  let leaseTimer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let leaseReleased = false;
  const clearTimers = (): void => {
    if (timer !== undefined) clearInterval(timer);
    if (leaseTimer !== undefined) clearInterval(leaseTimer);
  };
  const releaseLease = async (): Promise<void> => {
    if (leaseReleased) return;
    leaseReleased = true;
    try {
      await lease.release();
    } catch (error) {
      console.error(`cbx: 调度器租约释放失败：${error instanceof Error ? error.message : error}`);
    }
  };
  const shutdown = (currentFlight?: Promise<void>): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    clearTimers();
    const flight = inFlight;
    shutdownPromise = (async () => {
      // Guard failure calls shutdown from inside its own tick. Waiting for that
      // promise would deadlock; external stop still waits for a real dispatch.
      if (flight && flight !== currentFlight) await flight;
      await releaseLease();
      resolveDone();
    })().catch(error => {
      console.error(`cbx: 调度器停止失败：${error instanceof Error ? error.message : error}`);
      resolveDone();
    });
    return shutdownPromise;
  };
  const tick = (): Promise<void> => {
    if (stopping || inFlight) return inFlight ?? Promise.resolve();
    let flight!: Promise<void>;
    flight = (async () => {
      if (workspaceIdentityGuard) {
        try {
          await workspaceIdentityGuard();
        } catch (error) {
          console.error(`cbx: 工作区身份校验失败，停止调度器：${error instanceof Error ? error.message : error}`);
          await shutdown(flight);
          return;
        }
      }
      if (stopping) return;
      try {
        await dispatchQueue(runtime, workspaceInput);
      } catch (error) {
        console.error(`cbx: 调度器执行失败：${error instanceof Error ? error.message : error}`);
      }
    })().finally(() => {
      if (inFlight === flight) inFlight = undefined;
    });
    inFlight = flight;
    return flight;
  };
  await tick();
  if (stopping) return { done, async stop(): Promise<void> { await shutdown(); } };
  timer = setInterval(() => { void tick(); }, intervalMs);
  // unref：调度器不应独立撑住进程退出（租约定时器同样 unref）；宿主进程自身的
  // 存活由 dsh 主循环保证。旧实例若因 HMR 未清理而残留，进程也能正常退出。
  timer.unref();
  leaseTimer = setInterval(() => {
    void lease.renew().then(async owned => {
      if (owned || stopping) return;
      console.error("cbx: serve 租约已丢失，停止调度以避免双主。");
      await shutdown();
    }).catch(error => console.error(`cbx: serve 租约续期失败：${error instanceof Error ? error.message : error}`));
  }, Math.floor(SERVICE_LEASE_TTL_MS / 3));
  leaseTimer.unref();
  return { done, async stop(): Promise<void> { await shutdown(); } };
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
  const directory = runtime.jobDir(workspace, jobId);
  // 单事务完成：状态预检 + 老 entry 标 cancelled + 终止僵尸进程 + 插新 entry + 状态重置。
  // 预检也收进队列锁：锁外读到的"已终态"可能与并发收口的 worker 写回交错，导致
  // retry 的重置覆盖掉刚落盘的新终态（TOCTOU）。
  // terminateTree 与 entry 状态变更必须同在队列锁内，否则与 dispatchQueue 回收并发时会误杀新 worker 或互相覆盖。
  const replacement = await withQueueLock(workspace, async () => {
    const state = await runtime.loadState(workspace, jobId);
    if (["running", "queued", "awaiting_approval"].includes(state.status)) throw new Error(`任务当前仍在执行、排队或等待审批：${jobId}`);
    // 旧 worker 可能仍是僵尸进程(已被回收但进程未退出)：写取消标记 + 终止进程树，
    // 避免新 entry 启动时 run.lock 被旧进程持有而 E_LOCK_BUSY 失败。
    await writeFile(path.join(directory, "cancel.requested"), now(), "utf8").catch(() => undefined);
    // 同进程僵尸先走注册表（句柄可信，无需 pid 文件背书）；跨进程才读 active.pid。
    if (abortRunningJob(workspace, jobId)) {
      logJobEvent(workspace, jobId, "retry_aborted_in_process", {});
    }
    // pid 文件可能是宿主崩溃留下的陈旧记录：kill 前校验归属，防止 pid 复用误杀无关进程树。
    const pidRecord = await readPidRecord(path.join(directory, "active.pid"));
    if (pidRecord) {
      const owns = await pidRecordOwnsProcess(pidRecord);
      if (owns === true) {
        await terminateTree(pidRecord.pid);
      } else {
        logJobEvent(workspace, jobId, owns === false ? "retry_skip_pid_kill_reused" : "retry_skip_pid_kill_unverified", { pid: pidRecord.pid });
      }
    }
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
