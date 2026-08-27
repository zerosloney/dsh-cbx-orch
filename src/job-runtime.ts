import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

/** One live child-process handle an in-process job owns, cancellable as a tree. */
export interface ActiveProcessHandle {
  readonly pid: number;
  /** Begin graceful tree-scoped termination (the seam's only termination verb). */
  terminate(): void;
}

/** Per-running-job execution context threaded through the engine via ALS. */
export interface JobRuntimeContext {
  workspace: string;
  jobId: string;
  /** Fired on cancel so cooperating code can observe interruption. */
  controller: AbortController;
  /** Active executor/test subprocess handles registered by the process adapter. */
  handles: Set<ActiveProcessHandle>;
}

/**
 * Threads the current in-process job identity into synchronous/async process
 * spawns so the adapter can register its handles for cancellation. Falls back to
 * `undefined` when the call runs outside a worker (e.g. the UI's own git
 * calls), where no per-job cancellation is needed.
 */
export const jobContext = new AsyncLocalStorage<JobRuntimeContext>();

/** In-process jobs keyed by workspace::jobId（归一化路径拼接）。仅按 jobId 键控会让
 *  两个工作区的同名任务共享上下文：abortRunningJob 跨工作区误杀、注销串台。 */
const runningJobs = new Map<string, JobRuntimeContext>();

function contextKey(workspace: string, jobId: string): string {
  return `${path.resolve(workspace)}::${jobId}`;
}

export function registerRunningJob(workspace: string, jobId: string): JobRuntimeContext {
  const key = contextKey(workspace, jobId);
  const existing = runningJobs.get(key);
  if (existing) return existing;
  const context: JobRuntimeContext = {
    workspace: path.resolve(workspace),
    jobId,
    controller: new AbortController(),
    handles: new Set(),
  };
  runningJobs.set(key, context);
  return context;
}

export function unregisterRunningJob(workspace: string, jobId: string): void {
  runningJobs.delete(contextKey(workspace, jobId));
}

export function getRunningJob(workspace: string, jobId: string): JobRuntimeContext | undefined {
  return runningJobs.get(contextKey(workspace, jobId));
}

/** 进程内正在运行的任务总数（全工作区合计）。全局并发闸以此计数为权威：
 *  registerRunningJob 在 spawn 返回前同步完成，取消/回收/完成经 unregisterRunningJob
 *  自动收缩——无需额外的释放钩子。 */
export function countRunningJobs(): number {
  return runningJobs.size;
}

/**
 * Cancel an in-process job: signal its controller and terminate every active
 * subprocess handle it owns. Returns whether the job was running in-process.
 */
export function abortRunningJob(workspace: string, jobId: string): boolean {
  const context = runningJobs.get(contextKey(workspace, jobId));
  if (!context) return false;
  context.controller.abort();
  for (const handle of context.handles) {
    try {
      handle.terminate();
    } catch {
      /* process already gone */
    }
  }
  return true;
}

/** Run `fn` inside a job's ALS context so spawned handles register to it. */
export function runInJobContext<T>(
  context: JobRuntimeContext,
  fn: () => Promise<T>,
): Promise<T> {
  return jobContext.run(context, fn);
}
