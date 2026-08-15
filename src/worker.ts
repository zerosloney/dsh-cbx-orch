import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { executeJob } from "./execution.js";
import {
  jobDir,
  logJobEvent,
  pruneAfterTerminal,
} from "./state.js";
import { registerRunningJob, runInJobContext, unregisterRunningJob } from "./job-runtime.js";

const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Run one job in-process (the DeepSeek Harness plugin's replacement for cbx's
 * detached `cli.js run` worker). The orchestration logic is pure TS and safe
 * in-process; executors and tests still run as tree-scoped `ctx.subprocess`
 * children that the job-runtime registry can terminate on cancel.
 *
 * `executeJob` itself finishes the queue entry and prunes on settle, so this
 * worker only owns the heartbeat, the cancel-registration, and the pid file.
 */
export async function runWorkerJob(
  workspaceInput: string,
  jobId: string,
  queueEntryId?: string,
  extra = "",
  extraRounds = 0,
): Promise<unknown> {
  const workspace = path.resolve(workspaceInput);
  const directory = jobDir(workspace, jobId);
  const heartbeatFile = path.join(directory, "worker.heartbeat");
  const pidFile = path.join(directory, "pid");
  const context = registerRunningJob(workspace, jobId);

  await writeFile(heartbeatFile, new Date().toISOString(), "utf8").catch(
    () => undefined,
  );
  await writeFile(pidFile, String(process.pid), "utf8").catch(() => undefined);
  const heartbeat = setInterval(() => {
    void writeFile(heartbeatFile, new Date().toISOString(), "utf8").catch(
      () => undefined,
    );
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  try {
    return await runInJobContext(context, () =>
      executeJob(workspace, jobId, extra, queueEntryId, extraRounds),
    );
  } finally {
    clearInterval(heartbeat);
    await unlink(heartbeatFile).catch(() => undefined);
    await unlink(pidFile).catch(() => undefined);
    unregisterRunningJob(jobId);
  }
}

/**
 * Fire-and-forget in-process job launcher used by the queue dispatcher. Errors
 * are logged to the job event stream and the entry is left to the heartbeat
 * reclaim path so dispatch never spins on a permanently broken job.
 */
export function startInProcessJob(
  workspace: string,
  jobId: string,
  queueEntryId: string,
  extra = "",
  extraRounds = 0,
): number {
  void runWorkerJob(workspace, jobId, queueEntryId, extra, extraRounds).catch(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logJobEvent(workspace, jobId, "worker_crash", { error: message });
    },
  );
  return process.pid;
}
