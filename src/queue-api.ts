import path from "node:path";
import * as queue from "./queue.js";
import type { QueueEntry, QueueFile, QueueRuntime } from "./queue.js";
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
const schedulers = new Map<string, Promise<queue.QueueService | undefined>>();

/**
 * 确保某工作区有常驻调度器在跑（幂等）。serveQueue 自带 service lease：
 * 同工作区另一进程已在服务时租约被拒——这不算故障（对方在调度），静默跳过。
 * 崩溃恢复不再依赖"下一次任意队列活动"：插件启动 / 每次入队都会走到这里。
 */
export function ensureScheduler(workspaceInput: string): Promise<queue.QueueService | undefined> {
  const key = path.resolve(workspaceInput);
  const existing = schedulers.get(key);
  if (existing) return existing;
  const started = queue.serveQueue(queueRuntime, key).catch((error) => {
    schedulers.delete(key);
    // 另一进程持有租约：按错误码判定（按消息文案匹配会因一次文案改动静默失效）。
    if (isCbxError(error, "E_LEASE_HELD")) {
      console.debug(`cbx: ${key} 已有外部调度器，跳过本进程 serve。`);
    } else {
      console.error(`cbx: ${key} 常驻调度器启动失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  });
  schedulers.set(key, started);
  return started;
}

/** 停止某工作区的常驻调度器（插件卸载时调用）。 */
export async function stopScheduler(workspaceInput: string): Promise<void> {
  const key = path.resolve(workspaceInput);
  const started = schedulers.get(key);
  if (!started) return;
  schedulers.delete(key);
  try {
    const service = await started;
    if (service) await service.stop();
  } catch {
    /* stop 失败不影响卸载；租约过期后其他实例可接管 */
  }
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
