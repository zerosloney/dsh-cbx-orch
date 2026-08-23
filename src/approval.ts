import { existsSync } from "node:fs";
import path from "node:path";
import {
  loadJson,
  loadJobContext,
  now,
  withFileLock,
} from "./storage.js";
import {
  loadState,
  loadConfig,
  pruneAfterTerminal,
  writeState,
  writeApprovalState,
  writeApprovalRequeueState,
  jobDir,
} from "./state.js";
import { contextRedactor } from "./artifacts.js";
import { writeResult } from "./result.js";
import {
  createHumanGate,
  parseHumanGate,
  resolveHumanGate,
} from "./human-gate.js";
import {
  parsePendingCompletion,
  evidenceHashes,
  completionEvidenceValid,
  worktreeSha256,
} from "./evidence.js";
import { snapshotDiff, commitWorktree } from "./git-ops.js";
import { cleanupWorktree } from "./worktree.js";
import { dispatchQueue } from "./queue-api.js";
import { CbxError } from "./errors.js";
import type { JobState, Json } from "./types.js";

async function approveJobLocked(
  workspaceInput: string,
  jobId: string,
): Promise<JobState> {
  const workspace = path.resolve(workspaceInput);
  const state = await loadState(workspace, jobId);
  // 审批与取消不共享 run.lock（取消走 abortRunningJob 而非持锁），入口先核一次
  // 取消标记与状态；写盘前还有二次核验（见各 writeApprovalState 前）。
  // 业务校验错误统一为 E_INVALID_STATE（HTTP 层映射 409 冲突）。
  if (state.status === "cancelled")
    throw new CbxError("E_INVALID_STATE", `任务已取消，不能批准：${jobId}`);
  if (state.status !== "awaiting_approval")
    throw new CbxError("E_INVALID_STATE", `任务当前不需要批准：${jobId}`);
  if (existsSync(path.join(jobDir(workspace, jobId), "cancel.requested")))
    throw new CbxError("E_INVALID_STATE", `任务已取消，不能批准：${jobId}`);
  const gate = state.humanGate
    ? parseHumanGate(state.humanGate)
    : state.phase === "before_run"
      ? createHumanGate("before_run", { detail: "任务执行前需要人工批准。" })
      : state.phase === "before_complete"
        ? createHumanGate("completion", { detail: "等待完成审批。" })
        : (() => {
            throw new CbxError("E_INVALID_STATE", "等待审批的任务缺少 Human Gate。");
          })();
  if (gate.status !== "waiting")
    throw new CbxError("E_INVALID_STATE", "Human Gate 已解决，不能重复批准。");
  const config = await loadConfig(workspace);
  const redact = contextRedactor(config.governance);
  if (state.phase === "before_run" && gate.reason === "before_run") {
    // 写盘前再核取消标记：避免把已取消任务写回 queued 造成状态撕裂（队列条目已被取消）。
    if (existsSync(path.join(jobDir(workspace, jobId), "cancel.requested")))
      throw new Error(`任务已取消，不能批准：${jobId}`);
    // 原子重入队：状态回 queued 与 awaiting_approval 队列条目重新激活同事务落盘，
    // 不再依赖调用方补 startBackground（两段式中间崩溃 = 永不调度的 queued 任务）。
    const requeued = await writeApprovalRequeueState(
      workspace,
      jobId,
      {
        status: "queued",
        phase: "queued",
        approved: true,
        approvalRequired: false,
        humanGate: resolveHumanGate(gate, "approved", redact),
      },
    );
    // 立即触发一次调度，新 entry 不必等 30s 调度心跳。
    await dispatchQueue(workspace).catch(() => undefined);
    return requeued;
  }
  if (state.phase !== "before_complete" || gate.reason !== "completion")
    throw new Error("审批状态与 Human Gate 不一致。");
  const directory = jobDir(workspace, jobId);
  const context = await loadJobContext(directory);
  const pending = parsePendingCompletion(state.pendingCompletion);
  const worktreeFile = path.join(directory, "worktree.json");
  const recorded = existsSync(worktreeFile)
    ? await loadJson<{ path: string }>(worktreeFile)
    : undefined;
  const workdir = context.isolated ? recorded?.path : workspace;
  const hashes = await evidenceHashes(directory);
  const evidenceMatches =
    JSON.stringify(hashes) === JSON.stringify(pending.evidenceHashes);
  // workdir !== undefined && existsSync(workdir) 同时充当窄化守卫：第三操作数里 TS 已知 workdir 为非空 string，
  // 不再需要 `workdir!`。隔离任务缺 worktree（recorded 缺失）或 worktree 目录被删 → snapshotMatches=false，
  // 走下方 completion_evidence_stale 拒绝路径，与"证据变化"同等处理。
  const snapshotMatches =
    workdir !== undefined &&
    existsSync(workdir) &&
    worktreeSha256(await snapshotDiff(workdir)) === pending.worktreeSha256;
  if (
    !evidenceMatches ||
    !snapshotMatches ||
    !completionEvidenceValid(context, state, hashes)
  ) {
    const humanGate = resolveHumanGate(
      gate,
      "approval rejected because completion evidence changed",
      redact,
    );
    const stale = await writeApprovalState(
      workspace,
      jobId,
      {
        status: "needs_fix",
        phase: "completion_evidence_stale",
        approvalRequired: false,
        pendingCompletion: null,
        humanGate,
        error: "完成审批证据或 worktree 已变化；拒绝完成，请重新执行验证。",
      },
      "failed",
    );
    await writeResult(workspace, jobId, stale);
    await pruneAfterTerminal(workspace);
    return stale;
  }
  const updates: Json = {
    status: "done",
    phase: "done",
    approvalRequired: false,
    completionApproved: true,
    approvedAt: now(),
    pendingCompletion: null,
    humanGate: resolveHumanGate(gate, "approved", redact),
    error: null,
  };
  // 提交前核取消：原实现 commit 之后才复查，窗口内取消的任务会留下已提交的
  // commit（autoBranch 分支存活，与用户"取消"意图相反）。落盘前还有最后一道复验。
  if (existsSync(path.join(jobDir(workspace, jobId), "cancel.requested")))
    throw new Error(`任务已取消，不能批准：${jobId}`);
  if (context.autoCommit) {
    // 到达此处必然已通过证据门（snapshotMatches 为 true ⇒ workdir 存在）。
    // 显式守卫代替 `workdir!`：若未来门管线改动破坏了这一不变量，这里给出可诊断的错误而非静默的 undefined 传参。
    if (!workdir) {
      throw new Error(`隔离任务缺少 worktree 路径，无法提交：${jobId}`);
    }
    try {
      updates.gitCommit =
        (await commitWorktree(workdir, context.commitMessage)) ?? null;
    } catch (error) {
      const failed = await writeApprovalState(
        workspace,
        jobId,
        {
          status: "failed",
          phase: "git_commit",
          approvalRequired: false,
          pendingCompletion: null,
          humanGate: resolveHumanGate(
            gate,
            "approval accepted; commit failed",
            redact,
          ),
          error: String(error),
          gitCommit: null,
        },
        "failed",
      );
      await writeResult(workspace, jobId, failed);
      await pruneAfterTerminal(workspace);
      return failed;
    }
  }
  // 完成态写盘前最后一次取消核验（竞态窗口最小化；窗口内取消先落盘则 cancelled 获胜）。
  if (existsSync(path.join(jobDir(workspace, jobId), "cancel.requested")))
    throw new Error(`任务已取消，不能批准：${jobId}`);
  await writeApprovalState(workspace, jobId, updates, "done");
  if (!context.keepWorktree) {
    try {
      await cleanupWorktree(workspace, jobId);
      await writeState(workspace, jobId, { worktreeCleaned: true });
    } catch (error) {
      await writeState(workspace, jobId, { cleanupError: String(error) });
    }
  }
  const completed = await loadState(workspace, jobId);
  await writeResult(workspace, jobId, completed);
  await pruneAfterTerminal(workspace);
  return completed;
}

export async function approveJob(
  workspaceInput: string,
  jobId: string,
): Promise<JobState> {
  const workspace = path.resolve(workspaceInput);
  return withFileLock(
    path.join(jobDir(workspace, jobId), "run.lock"),
    () => approveJobLocked(workspace, jobId),
    { retries: 0, busyMessage: `任务正在运行中：${jobId}` },
  );
}
