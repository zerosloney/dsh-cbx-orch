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
import type { JobState } from "./types.js";

async function saveStateAndQueue(
  workspace: string,
  jobId: string,
  state: Record<string, unknown>,
  queueFile: QueueFile,
): Promise<void> {
  const previousStatus = (await loadState(workspace, jobId)).status;
  await savePersistedStateAndQueue(workspace, jobId, state, queueFile);
  await saveJson(path.join(jobDir(workspace, jobId), "state.json"), state);
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

export async function dispatchQueue(
  workspaceInput: string,
): Promise<QueueFile> {
  return queue.dispatchQueue(queueRuntime, workspaceInput);
}

export async function health(
  workspaceInput: string,
): Promise<{
  status: "ok";
  metrics: Awaited<ReturnType<typeof persistedMetrics>>;
}> {
  const workspace = path.resolve(workspaceInput);
  const config = await loadConfig(workspace);
  await prunePersistedData(workspace, config.governance?.retentionDays);
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
  return queue.enqueueJob(queueRuntime, workspaceInput, jobId, extra, priority);
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
