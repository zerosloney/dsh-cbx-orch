import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig, loadState, jobDir, logJobEvent } from "./state.js";
import { redactText, saveJson, now } from "./storage.js";
import { pruneAfterTerminal } from "./state.js";
import { refreshBaseline } from "./baseline.js";
import { prepareContinuation } from "./execution.js";
import {
  enqueueJob,
  listQueue,
  cancelQueueEntries,
  cancelJobState,
} from "./queue-api.js";
import { cleanupWorktree } from "./worktree.js";
import { terminateTree } from "./process-runner.js";
import { pidRecordOwnsProcess, readPidRecord } from "./pid-guard.js";
import { abortRunningJob } from "./job-runtime.js";
import type { JobState } from "./types.js";

export async function startBackground(workspaceInput: string, jobId: string, extra = "", priority = 0, contextSnapshot?: string, shouldRefreshBaseline = false, extraRounds = 0): Promise<void> {
  const workspace = path.resolve(workspaceInput);
  const directory = jobDir(workspace, jobId);
  const continuation = await prepareContinuation(workspace, jobId, extra, extraRounds);
  if (continuation.blocked) throw new Error(continuation.blocked.phase === "adaptive_max_rounds" ? "任务已达 max_rounds；请显式提供 extra_rounds。" : "任务等待 approve，不能通过 continue 恢复。");
  // 显式重新入队（continue/approve/start）：清除上次取消留下的标记。
  await unlink(path.join(directory, "cancel.requested")).catch(() => undefined);
  if (contextSnapshot !== undefined) {
    const governance = (await loadConfig(workspace)).governance;
    const snapshot = redactText(contextSnapshot, governance?.redactFields, governance?.redactPatterns);
    if (snapshot) await writeFile(path.join(directory, "context-snapshot.md"), snapshot, "utf8");
    else await unlink(path.join(directory, "context-snapshot.md")).catch(() => undefined);
  }
  await unlink(path.join(directory, "understanding.json")).catch(() => undefined);
  if (shouldRefreshBaseline) {
    await refreshBaseline(workspace, jobId, directory);
  }
  await enqueueJob(workspaceInput, jobId, continuation.instructions, priority);
}

export async function cancelJob(workspaceInput: string, jobId: string): Promise<JobState> {
  const workspace = path.resolve(workspaceInput);
  const directory = jobDir(workspace, jobId);
  const stateBeforeCancel = await loadState(workspace, jobId);
  // 终态任务取消是幂等 no-op：避免对已完成任务重复执行进程终止与 worktree 清理
  // （清理会误删 keepWorktree 保留的工作树）。needs_fix/queued/awaiting_approval 仍可取消。
  if (
    ["done", "failed", "review_failed", "cancelled"].includes(
      stateBeforeCancel.status,
    )
  ) {
    return stateBeforeCancel;
  }
  const survivors: number[] = [];
  // 先写取消标记再 abort：被终止的子进程会让 provider 抛错，runStage 的取消感知
  // catch 依赖标记存在才能把异常收口为 cancelled（否则会被误判为执行失败走重试）。
  // 标记写入是快速 fs 操作，执行器多跑的窗口可忽略。
  await writeFile(path.join(directory, "cancel.requested"), now(), "utf8");
  // In-process jobs: terminate every registered ctx.subprocess handle (the
  // executor/test trees) and signal the job's AbortController. NEVER call
  // terminateTree on the queue entry pid — in-process entries carry
  // process.pid and killing that would take down the whole harness.
  const terminatedInProcess = abortRunningJob(workspace, jobId);
  if (!terminatedInProcess && stateBeforeCancel.status === "running") {
    // Non-in-process fallback (e.g. a job left over from a prior run): kill the
    // recorded executor process tree directly. pid 文件可能陈旧且 pid 已被 OS 复用，
    // kill 前必须校验归属；无法确认归属时跳过 kill（取消标记 + 超时兜底），宁可
    // 留一个待人工处理的孤儿，也不冒杀掉无关进程树的风险。
    const pidRecord = await readPidRecord(path.join(directory, "active.pid"));
    const owns = pidRecord ? await pidRecordOwnsProcess(pidRecord) : undefined;
    if (pidRecord && owns === true) {
      if (!await terminateTree(pidRecord.pid)) survivors.push(pidRecord.pid);
    } else if (pidRecord) {
      logJobEvent(workspace, jobId, owns === false ? "cancel_skip_pid_kill_reused" : "cancel_skip_pid_kill_unverified", { pid: pidRecord.pid });
    }
  }
  try { await cancelQueueEntries(workspace, jobId); } catch (error) { logJobEvent(workspace, jobId, "queue_cancel_failed", { error: error instanceof Error ? error.message : String(error) }); }
  if (survivors.length > 0) {
    logJobEvent(workspace, jobId, "cancel_process_survived", { pids: survivors });
    const state = await cancelJobState(workspace, jobId, { status: "needs_fix", phase: "cancel_failed", error: `无法确认进程树已退出：${survivors.join(", ")}` });
    await pruneAfterTerminal(workspace);
    return state;
  }
  try { await cleanupWorktree(workspace, jobId); } catch (error) { logJobEvent(workspace, jobId, "cleanup_failed", { phase: "cancel", error: error instanceof Error ? error.message : String(error) }); }
  let state = await cancelJobState(workspace, jobId, { status: "cancelled", phase: "cancelled", cancelledAt: now() });
  // 终态复核：abort 与被终止 worker 的 catch 写回可能交错（先 abort、worker 随后写 retrying，
  // 再落到本行之前），导致终态被覆写回非终态。覆写一次即重写一次；仍非终态则落事件
  // （此时 worker 已终止，残留概率极低），后续 dispatch 的回收路径可兜底。
  const verified = await loadState(workspace, jobId);
  if (!["cancelled", "needs_fix", "done", "failed", "review_failed"].includes(verified.status)) {
    state = await cancelJobState(workspace, jobId, { status: "cancelled", phase: "cancelled", cancelledAt: now() });
    logJobEvent(workspace, jobId, "cancel_state_overwrite_repaired", { observed: verified.status });
  }
  await pruneAfterTerminal(workspace);
  return state;
}
