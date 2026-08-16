import path from "node:path";
import * as queue from "./queue.js";
import type { QueueEntry, QueueFile, QueueRuntime, WorkspaceIdentityGuard } from "./queue.js";
import {
  loadPersistedQueue,
  savePersistedStateAndFinishQueue,
  savePersistedStateAndQueue,
  savePersistedStateAndResolveApprovalQueue,
  persistedMetrics,
  prunePersistedData,
  withFileLock,
} from "./storage.js";
import {
  loadConfig,
  loadState,
  writeState,
  jobDir,
  logJobEvent,
} from "./state.js";
import { saveJson } from "./storage.js";
import { publishEvent } from "./observability.js";
import { isCbxError } from "./errors.js";
import type { JobState } from "./types.js";
import { WorkspacePolicy } from "./workspace-policy.js";

async function saveStateAndQueue(
  workspace: string,
  jobId: string,
  state: Record<string, unknown>,
  queueFile: QueueFile,
): Promise<void> {
  const previousStatus = (await loadState(workspace, jobId)).status;
  await savePersistedStateAndQueue(workspace, jobId, state, queueFile);
  try {
    await saveJson(path.join(jobDir(workspace, jobId), "state.json"), state);
  } catch (error) {
    // state.json 是镜像（权威在 SQLite）：镜像失败只落事件，不让已提交的
    // 状态+队列事务向上抛错。
    logJobEvent(workspace, jobId, "state_mirror_write_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    await publishEvent(workspace, "job.state_changed", {
      jobId,
      previousStatus,
      status: state.status,
      phase: state.phase,
      attempt: state.attempt,
    });
  } catch {
    /* durable state and queue transaction must not depend on delivery */
  }
}

const queueRuntime: QueueRuntime = {
  loadConfig,
  loadState,
  writeState,
  saveStateAndQueue,
  finishQueueEntryPersisted: savePersistedStateAndFinishQueue,
  jobDir,
};

/** 每工作区常驻调度器（serveQueue：30s 定时 dispatch，含死 worker 回收）。 */
interface SchedulerEntry {
  readonly key: string;
  readonly workspace: string;
  readonly started: Promise<queue.QueueService | undefined>;
  owners: number;
}

/**
 * 调度器生命周期句柄。ready 允许调用方观察启动结果，同时 release 不必
 * 等待启动完成才可调用，从而覆盖插件 HMR/卸载与启动并发的窗口。
 */
export interface SchedulerHandle {
  readonly workspace: string;
  readonly ready: Promise<queue.QueueService | undefined>;
  release(): Promise<void>;
}

const schedulers = new Map<string, SchedulerEntry>();

function schedulerKey(workspaceInput: string): string {
  const resolved = path.normalize(path.resolve(workspaceInput));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

interface WorkspaceIdentity {
  workspace: string;
  policy: WorkspacePolicy;
}

async function resolveWorkspaceIdentity(workspaceInput: string): Promise<WorkspaceIdentity> {
  const policy = new WorkspacePolicy([workspaceInput]);
  const workspace = await policy.resolveWorkspace(workspaceInput);
  return { workspace, policy };
}

async function startScheduler(
  workspaceInput: string,
  identity?: WorkspaceIdentity,
): Promise<SchedulerEntry> {
  const resolved = identity ?? await resolveWorkspaceIdentity(workspaceInput);
  const workspace = resolved.workspace;
  const policy = resolved.policy;
  const key = schedulerKey(workspace);
  const existing = schedulers.get(key);
  if (existing) return existing;

  let entry!: SchedulerEntry;
  const workspaceIdentityGuard: WorkspaceIdentityGuard = async () => {
    try {
      const actual = await policy.resolveWorkspace(workspace);
      if (actual === workspace) return;
      throw new Error(`工作区身份已变化：${workspace} -> ${actual}`);
    } catch (error) {
      if (schedulers.get(key) === entry) schedulers.delete(key);
      throw error;
    }
  };
  const started = queue.serveQueue(queueRuntime, workspace, 30_000, workspaceIdentityGuard).catch((error) => {
    if (schedulers.get(key) === entry) schedulers.delete(key);
    // 另一进程持有租约：按错误码判定（按消息文案匹配会因一次文案改动静默失效）。
    if (isCbxError(error, "E_LEASE_HELD")) {
      console.debug(`cbx: ${workspace} 已有外部调度器，跳过本进程 serve。`);
    } else {
      console.error(`cbx: ${workspace} 常驻调度器启动失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  });
  entry = { key, workspace, started, owners: 0 };
  schedulers.set(key, entry);
  return entry;
}

async function stopSchedulerEntry(entry: SchedulerEntry): Promise<void> {
  if (schedulers.get(entry.key) !== entry) return;
  // 先移除当前 generation，允许新的 owner 启动下一代，不与正在停止的
  // service 共享 map 项；旧 handle 的 release 会因 generation 不同而失效。
  schedulers.delete(entry.key);
  entry.owners = 0;
  try {
    const service = await entry.started;
    if (service) await service.stop();
  } catch {
    /* stop 失败不影响卸载；租约过期后其他实例可接管 */
  }
}

/**
 * 确保某工作区有常驻调度器在跑（幂等）。serveQueue 自带 service lease：
 * 同工作区另一进程已在服务时租约被拒——这不算故障（对方在调度），静默跳过。
 * 崩溃恢复不再依赖"下一次任意队列活动"：插件启动 / 每次入队都会走到这里。
 */
export function ensureScheduler(workspaceInput: string): Promise<queue.QueueService | undefined> {
  return startScheduler(workspaceInput)
    .then((entry) => entry.started)
    .catch((error) => {
      console.error(`cbx: ${path.resolve(workspaceInput)} 常驻调度器启动失败：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    });
}

/**
 * 为 canonical workspace 获取一个计数的生命周期 owner。多个 owner 共享
 * 同一 scheduler generation；只有最后一个幂等 release 才会停止它。
 */
export async function acquireScheduler(workspaceInput: string): Promise<SchedulerHandle> {
  const identity = await resolveWorkspaceIdentity(workspaceInput);
  const entry = await startScheduler(identity.workspace, identity);
  entry.owners += 1;
  let released = false;
  return {
    workspace: identity.workspace,
    ready: entry.started,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      // 启动失败或旧 stopScheduler 强制停止后，entry 已从 map 清理。
      if (schedulers.get(entry.key) !== entry) return;
      if (entry.owners <= 0) return;
      entry.owners -= 1;
      if (entry.owners === 0) await stopSchedulerEntry(entry);
    },
  };
}

/** 停止某工作区的常驻调度器（插件卸载时调用）。 */
export async function stopScheduler(workspaceInput: string): Promise<void> {
  const entry = schedulers.get(schedulerKey(workspaceInput));
  if (!entry) return;
  await stopSchedulerEntry(entry);
}

export async function dispatchQueue(
  workspaceInput: string,
): Promise<QueueFile> {
  return queue.dispatchQueue(queueRuntime, workspaceInput);
}

export async function health(
  workspaceInput: string,
  options: { prune?: boolean } = {},
): Promise<{
  status: "ok";
  metrics: Awaited<ReturnType<typeof persistedMetrics>>;
}> {
  const workspace = path.resolve(workspaceInput);
  // prune 含全表扫描 + 目录删除；公开探针（/healthz）应传 { prune: false } 只读指标，
  // 避免被匿名高频调用当成 DoS 放大器。
  if (options.prune !== false) {
    const config = await loadConfig(workspace);
    await prunePersistedData(workspace, config.governance?.retentionDays);
  }
  return { status: "ok", metrics: await persistedMetrics(workspace) };
}

export async function serveQueue(
  workspaceInput: string,
  intervalMs = 30_000,
): Promise<queue.QueueService> {
  return queue.serveQueue(queueRuntime, workspaceInput, intervalMs);
}

export async function enqueueJob(
  workspaceInput: string,
  jobId: string,
  extra = "",
  priority = 0,
): Promise<QueueEntry> {
  const entry = await queue.enqueueJob(queueRuntime, workspaceInput, jobId, extra, priority);
  // 入队即确保该工作区有常驻调度器（回收/补派的 30s 心跳），崩溃恢复不再依赖后续活动。
  void ensureScheduler(workspaceInput);
  return entry;
}

export async function finishQueueEntry(
  workspaceInput: string,
  queueId: string,
): Promise<void> {
  return queue.finishQueueEntry(queueRuntime, workspaceInput, queueId);
}

export async function listQueue(workspaceInput: string): Promise<QueueFile> {
  return queue.listQueue(queueRuntime, workspaceInput);
}

export async function pauseQueue(workspaceInput: string): Promise<QueueFile> {
  return queue.pauseQueue(queueRuntime, workspaceInput);
}

export async function resumeQueue(workspaceInput: string): Promise<QueueFile> {
  return queue.resumeQueue(queueRuntime, workspaceInput);
}

export async function cancelQueueEntries(
  workspaceInput: string,
  jobId: string,
): Promise<QueueFile> {
  return queue.cancelQueueEntries(queueRuntime, workspaceInput, jobId);
}

/** 单锁内原子完成取消终态（标记队列条目 cancelled + 写 state），供 cancelJob 使用。 */
export async function cancelJobState(
  workspaceInput: string,
  jobId: string,
  updates: Record<string, unknown>,
): Promise<JobState> {
  return (await queue.cancelQueueEntriesWithState(
    queueRuntime,
    workspaceInput,
    jobId,
    updates,
  )) as unknown as JobState;
}

export async function retryQueueJob(
  workspaceInput: string,
  jobId: string,
  priority = 0,
): Promise<QueueEntry> {
  return queue.retryQueueJob(queueRuntime, workspaceInput, jobId, priority);
}
