import { AsyncLocalStorage } from "node:async_hooks";

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
 * spawns so the adapter can register its handles for cancellation. Falls back
 * to `undefined` when the call runs outside a worker (e.g. the UI's own git
 * calls), where no per-job cancellation is needed.
 */
export const jobContext = new AsyncLocalStorage<JobRuntimeContext>();

/** In-process jobs keyed by jobId, mirroring the queue's `running` view. */
const runningJobs = new Map<string, JobRuntimeContext>();

export function registerRunningJob(workspace: string, jobId: string): JobRuntimeContext {
  const existing = runningJobs.get(jobId);
  if (existing) return existing;
  const context: JobRuntimeContext = {
    workspace,
    jobId,
    controller: new AbortController(),
    handles: new Set(),
  };
  runningJobs.set(jobId, context);
  return context;
}

export function unregisterRunningJob(jobId: string): void {
  runningJobs.delete(jobId);
}

export function getRunningJob(jobId: string): JobRuntimeContext | undefined {
  return runningJobs.get(jobId);
}

/**
 * Cancel an in-process job: signal its controller and terminate every active
 * subprocess handle it owns. Returns whether the job was running in-process.
 */
export function abortRunningJob(jobId: string): boolean {
  const context = runningJobs.get(jobId);
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
