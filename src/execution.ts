import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  loadJobContext,
  loadJson,
  saveJson,
  now,
  updateJobContext,
  withFileLock,
} from "./storage.js";
import { finishSpan, startSpan } from "./observability.js";
import {
  loadState,
  writeState,
  loadConfig,
  pruneAfterTerminal,
  jobDir,
  logJobEvent,
} from "./state.js";
import { writeResult } from "./result.js";
import {
  evaluateBaselineDrift,
  refreshBaseline,
  performContextHandshake,
} from "./baseline.js";
import {
  runStage,
  requestAdaptiveAction,
  ManagerWorktreeMutationError,
  ManagerDecisionError,
} from "./stage-runner.js";
import { contextRedactor, contextArtifacts } from "./artifacts.js";
import { prepareWorktree, snapshotDiff, commitWorktree } from "./git-ops.js";
import { tryMigrateDirtyFingerprintV2 } from "./baseline.js";
import { assertExecutionPolicy } from "./validation.js";
import { ExecutorCostLimitError, isUnretryableInvocationError } from "./errors.js";
import {
  createHumanGate,
  parseHumanGate,
  resolveHumanGate,
  extendRoundLimit,
  trackFailure,
} from "./human-gate.js";
import {
  evidenceHashes,
  completionEvidenceValid,
  parsePendingCompletion,
  worktreeSha256,
  structuredAuditRequested,
  reviewEffectivelyRequired,
  type PendingCompletion,
} from "./evidence.js";
import {
  auditAllowsCompletion,
  criterionDefinitions,
  reconcileVerifiedProgress,
  type StructuredAudit,
  type VerifiedProgress,
} from "./progress.js";
import type { NextAction } from "./adaptive-manager.js";
import { resolveExecutor } from "./executors/builtin.js";
import { cancelJobState, dispatchQueue, finishQueueEntry } from "./queue-api.js";
import { cleanupWorktree } from "./worktree.js";
import { APP_VERSION } from "./version.js";
import type { JobState, Json, TaskStage, StageReport } from "./types.js";

/** 按 stage 依赖分层：同一层内的 stage 无相互依赖（理论上可并行），跨层有依赖。
 *  本实现层内仍串行执行（单 worktree 安全），分层主要用于依赖声明 + 失败传播 + handback 聚合。
 *  依赖校验（悬空/循环）已在 normalizeTaskContract 完成，此处不重复检测。 */
export function groupStagesByDependency(stages: TaskStage[]): TaskStage[][] {
  if (stages.length <= 1) return [stages];
  const hasDeps = stages.some(
    (stage) => stage.dependsOn && stage.dependsOn.length > 0,
  );
  if (!hasDeps) return [stages]; // 无任何依赖：单层，保持原线性顺序
  const completed = new Set<string>();
  const remaining = [...stages];
  const layers: TaskStage[][] = [];
  while (remaining.length > 0) {
    const ready = remaining.filter((stage) =>
      (stage.dependsOn ?? []).every((dep) => completed.has(dep)),
    );
    if (ready.length === 0) {
      // 不应发生（循环依赖已拒绝），兜底防死循环
      layers.push(remaining);
      break;
    }
    layers.push(ready);
    for (const stage of ready) completed.add(stage.name);
    for (const stage of ready) remaining.splice(remaining.indexOf(stage), 1);
  }
  return layers;
}

/** 收集一个 stage 的所有 dependsOn stage 的 handback 内容，按完成顺序拼接。 */
async function collectDependencyHandbacks(
  directory: string,
  stages: TaskStage[],
  stage: TaskStage,
): Promise<string> {
  const deps = stage.dependsOn ?? [];
  if (deps.length === 0) return "";
  const parts: string[] = [];
  for (const dep of deps) {
    const depIndex = stages.findIndex((s) => s.name === dep);
    if (depIndex < 0) continue;
    const safeName = dep.replace(/[^A-Za-z0-9._-]+/g, "-");
    const handbackFile = path.join(
      directory,
      `stage-${depIndex}-${safeName}-handback.md`,
    );
    if (existsSync(handbackFile)) {
      const content = await readFile(handbackFile, "utf8");
      parts.push(`## 前置阶段 ${dep} 的交接\n\n${content}`);
    }
  }
  return parts.join("\n\n");
}

async function executeJobLocked(
  workspace: string,
  jobId: string,
  extra = "",
  queueEntryId?: string,
): Promise<JobState> {
  const directory = jobDir(workspace, jobId);
  const initial = await loadState(workspace, jobId);
  const context = await loadJobContext(directory);
  // context schema 懒迁移（v1→v2 脏指纹等）：在漂移评估与审批门之前执行，
  // 迁移失败不阻断执行（带守卫，见 baseline.ts）。
  await tryMigrateDirtyFingerprintV2(workspace, jobId, directory, context)
    .catch((error) =>
      logJobEvent(workspace, jobId, "context_schema_migrate_failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  // intentional-simple: 旧 job 跨版本续跑时新增字段走可选校验与 ?? 兜底，不硬阻断；schema 损坏才拒绝。
  // 新功能字段（如 dependencyGuard）从 .cbx.json 同步到已持久化 context，避免旧任务遗漏。
  const runtimeConfig = await loadConfig(workspace);
  if (runtimeConfig.dependencyGuard && !context.dependencyGuard) {
    await updateJobContext(workspace, jobId, { dependencyGuard: true });
    context.dependencyGuard = true;
  }
  const jobMajor = String(context.appVersion ?? "").split(".")[0];
  if (jobMajor && jobMajor !== APP_VERSION.split(".")[0]) {
    const warning = `任务由 cbx v${context.appVersion} 创建，当前运行 v${APP_VERSION}；context schema 可能不兼容。`;
    logJobEvent(workspace, jobId, "version_mismatch", {
      jobVersion: context.appVersion,
      runtimeVersion: APP_VERSION,
      warning,
    });
    console.error(`cbx: ${warning}`);
  }
  assertExecutionPolicy(context.trustMode ?? "trusted", context.isolated);
  const governance = (await loadConfig(workspace)).governance;
  const redact = contextRedactor(governance);
  if (
    initial.status === "awaiting_approval" &&
    initial.phase === "before_complete"
  )
    return initial;
  if (context.approvalBeforeRun && initial.approved !== true) {
    const existingGate = initial.humanGate
      ? parseHumanGate(initial.humanGate)
      : undefined;
    const humanGate =
      existingGate?.status === "waiting" && existingGate.reason === "before_run"
        ? existingGate
        : createHumanGate("before_run", { detail: "任务执行前需要人工批准。" });
    return writeState(
      workspace,
      jobId,
      {
        status: "awaiting_approval",
        phase: "before_run",
        approvalRequired: true,
        humanGate,
      },
      queueEntryId,
    );
  }
  const drift = await evaluateBaselineDrift(context, workspace);
  if (context.isolated && context.baseDirty && !context.carryDirty) {
    const state = await writeState(
      workspace,
      jobId,
      {
        status: "needs_fix",
        phase: "dirty_baseline",
        dirtyBaselineDrift: false,
        error:
          "隔离任务无法携带创建时的未提交内容；请先提交或清理工作区，或改用 carryDirty 把未提交改动带进 worktree。",
      },
      queueEntryId,
    );
    await writeResult(workspace, jobId, state);
    return state;
  }
  if (!context.isolated && drift.dirtyDrift) {
    const state = await writeState(
      workspace,
      jobId,
      {
        status: "needs_fix",
        phase: "dirty_baseline",
        dirtyBaselineDrift: true,
        error:
          "非隔离工作区未提交内容已偏离任务创建基线；请刷新上下文/基线后继续。",
      },
      queueEntryId,
    );
    await writeResult(workspace, jobId, state);
    return state;
  }
  if (drift.commitDrift) {
    logJobEvent(workspace, jobId, "baseline_drift", {
      baseCommit: context.baseCommit,
      currentCommit: drift.currentBaseline?.commit,
      isolated: context.isolated,
    });
    if (!context.isolated) {
      const state = await writeState(
        workspace,
        jobId,
        {
          status: "needs_fix",
          phase: "baseline_drift",
          baselineDrift: true,
          currentCommit: drift.currentBaseline?.commit,
          error:
            "非隔离工作区 HEAD 已偏离任务创建基线；请刷新上下文/基线后继续。",
        },
        queueEntryId,
      );
      await writeResult(workspace, jobId, state);
      return state;
    }
    await writeState(workspace, jobId, {
      baselineDrift: true,
      currentCommit: drift.currentBaseline?.commit,
    });
  }
  const worktreeFile = path.join(directory, "worktree.json");
  const recordedWorkdir = existsSync(worktreeFile)
    ? (await loadJson<{ path: string }>(worktreeFile)).path
    : "";
  const workdir =
    recordedWorkdir && existsSync(recordedWorkdir)
      ? recordedWorkdir
      : await prepareWorktree(
          workspace,
          directory,
          jobId,
          context.isolated,
          context.autoBranch,
          context.baseCommit ?? "HEAD",
          Boolean(context.carryDirty),
        );
  const maxAttempts = Math.max(1, context.maxRetries + 1);
  let attempt = Number(initial.attempt ?? 0);
  let attemptExtra = extra;
  const cancelMarker = path.join(directory, "cancel.requested");

  const finish = async (updates: Json): Promise<JobState> => {
    // 完成收口前核取消：证据哈希/审批/提交可耗时数秒，窗口内用户取消的 done 会
    // 与 cancelJob 的覆写交错（state=done 而 entry=cancelled 的撕裂）。有标记的
    // done 一律改走取消收口，保持 state 与 entry 一致。
    if (String(updates.status ?? "") === "done" && existsSync(cancelMarker)) {
      return finishCancelled();
    }
    const currentState = await loadState(workspace, jobId);
    let finalUpdates = { ...updates };
    if (structuredAuditRequested(context)) {
      const definitions = criterionDefinitions(
        context.taskContract?.acceptanceCriteria ?? [],
      );
      const hashes = await evidenceHashes(directory);
      const audit = (finalUpdates.audit ?? currentState.audit) as
        StructuredAudit | undefined;
      const verifiedProgress = reconcileVerifiedProgress(
        definitions,
        (finalUpdates.verifiedProgress ?? currentState.verifiedProgress) as
          VerifiedProgress | undefined,
        audit,
        hashes,
      );
      finalUpdates = {
        ...finalUpdates,
        audit: audit ?? null,
        verifiedProgress,
      };
      if (finalUpdates.status === "done") {
        const candidateState = { ...currentState, ...finalUpdates };
        // 与 completionEvidenceValid 同口径：全部 stage skipReview 时不再把
        // review.md / VERDICT: PASS 当作完成前提（否则 skipReview 任务永远过不了门）。
        const reviewRequired = reviewEffectivelyRequired(context);
        const requiredEvidence = reviewRequired
          ? ["complete.patch", "test.log", "review.md"]
          : ["complete.patch", "test.log"];
        const verified =
          candidateState.testExitCode === 0 &&
          (!reviewRequired || candidateState.reviewVerdict === "PASS") &&
          auditAllowsCompletion(
            audit,
            verifiedProgress,
            requiredEvidence,
            hashes,
          );
        if (!verified)
          finalUpdates = {
            ...finalUpdates,
            status: "needs_fix",
            phase: "verification_gate",
            error:
              "结构化完成门未通过：需要 complete + clean + aligned、全部验收标准已验证，且测试/审查证据齐全。",
          };
      }
    }
    const status = String(finalUpdates.status ?? currentState.status);
    const phase = String(finalUpdates.phase ?? currentState.phase);
    if (finalUpdates.status === "done" && context.approvalBeforeComplete) {
      const hashes = await evidenceHashes(directory);
      const candidateState = { ...currentState, ...finalUpdates };
      if (!completionEvidenceValid(context, candidateState, hashes)) {
        finalUpdates = {
          ...finalUpdates,
          status: "needs_fix",
          phase: "verification_gate",
          error: "完成审批前证据门未通过。",
        };
      } else {
        const pendingCompletion: PendingCompletion = {
          version: 1,
          evidenceHashes: hashes,
          worktreeSha256: worktreeSha256(await snapshotDiff(workdir)),
          createdAt: now(),
        };
        finalUpdates = {
          ...finalUpdates,
          status: "awaiting_approval",
          phase: "before_complete",
          approvalRequired: true,
          pendingCompletion,
          humanGate: createHumanGate("completion", {
            detail: "证据门已通过，等待完成审批。",
          }),
        };
      }
    }
    // repeated_failure 检测放在结构化审计门与审批门之后，确保 verification_gate 失败也被计入。
    const finalStatus = String(finalUpdates.status ?? status);
    const finalPhase = String(finalUpdates.phase ?? phase);
    const error =
      typeof finalUpdates.error === "string" ? finalUpdates.error : undefined;
    const gateExcluded =
      [
        "awaiting_clarification",
        "adaptive_ask",
        "adaptive_blocked",
        "adaptive_max_rounds",
      ].includes(finalPhase) || finalPhase.includes("safety");
    if (
      error &&
      !finalUpdates.humanGate &&
      !gateExcluded &&
      ["failed", "needs_fix", "review_failed"].includes(finalStatus)
    ) {
      const failureTracker = trackFailure(currentState.failureTracker, error);
      finalUpdates = { ...finalUpdates, failureTracker };
      if (failureTracker.count >= 3)
        finalUpdates = {
          ...finalUpdates,
          status: "needs_fix",
          phase: "repeated_failure",
          humanGate: createHumanGate("repeated_failure", {
            detail: redact(error).slice(0, 2_000),
          }),
        };
    }
    if (finalUpdates.status === "done" && context.autoCommit) {
      try {
        const commitHash = await commitWorktree(workdir, context.commitMessage);
        if (commitHash) finalUpdates.gitCommit = commitHash;
      } catch (error) {
        finalUpdates = {
          ...finalUpdates,
          status: "failed",
          phase: "git_commit",
          error: String(error),
          gitCommit: null,
        };
      }
    }
    const result = await writeState(
      workspace,
      jobId,
      finalUpdates,
      queueEntryId,
    );
    const waitingHumanGate = result.humanGate
      ? parseHumanGate(result.humanGate).status === "waiting"
      : false;
    const recoverablePause =
      (context.adaptive?.enabled && result.status === "needs_fix") ||
      waitingHumanGate ||
      result.phase === "verification_gate";
    if (
      !context.keepWorktree &&
      !recoverablePause &&
      ["done", "failed", "needs_fix", "review_failed"].includes(
        String(result.status),
      )
    ) {
      try {
        await cleanupWorktree(workspace, jobId);
        await writeState(workspace, jobId, { worktreeCleaned: true });
      } catch (error) {
        await writeState(workspace, jobId, { cleanupError: String(error) });
      }
    }
    const finalState = await loadState(workspace, jobId);
    await writeResult(workspace, jobId, finalState);
    return finalState;
  };
  const finishCancelled = async (): Promise<JobState> => {
    try {
      await cleanupWorktree(workspace, jobId);
    } catch (error) {
      await writeState(workspace, jobId, { cleanupError: String(error) });
    }
    const finalState = await writeState(
      workspace,
      jobId,
      { status: "cancelled", phase: "cancelled", cancelledAt: now() },
      queueEntryId,
    );
    await writeResult(workspace, jobId, finalState);
    return finalState;
  };

  if (
    context.taskContract &&
    !existsSync(path.join(directory, "understanding.json"))
  ) {
    const handshakeOutcome = await performContextHandshake(
      workspace,
      directory,
      context,
      workdir,
      extra,
      redact,
      finish,
    );
    if (handshakeOutcome) return handshakeOutcome;
  }

  if (context.adaptive?.enabled) {
    const persistedRound = Number(initial.adaptiveRound ?? 0);
    if (!Number.isInteger(persistedRound) || persistedRound < 0)
      return finish({
        status: "needs_fix",
        phase: "adaptive_state",
        error: "adaptiveRound 持久状态无效。",
      });
    let round = persistedRound;
    let adaptiveRounds = Array.isArray(initial.adaptiveRounds)
      ? initial.adaptiveRounds
      : [];
    const stageReports = Array.isArray(initial.stages) ? initial.stages : [];
    const userSupplement = redact(extra);
    // done 决策缓存：连续 done 但证据门未过时，跳过后续 Manager 调用直接重试证据门，省一次 executor spawn。
    let managerDoneStreak = Number(initial.managerDoneStreak ?? 0);
    const MANAGER_SKIP_LIMIT = 2;
    while (round < context.adaptive.maxRounds) {
      if (existsSync(cancelMarker)) return finishCancelled();
      round += 1;
      const priorManagerState = await loadState(workspace, jobId);
      await writeState(workspace, jobId, {
        status: "running",
        phase: "adaptive_manager",
        adaptiveRound: round,
        workdir,
      });
      // done 缓存命中：上轮 done 但证据门没过，且未超跳过上限 → 跳过 Manager，直接用 done 决策走证据门。
      const skipManager =
        managerDoneStreak >= 1 && managerDoneStreak <= MANAGER_SKIP_LIMIT;
      let decision: NextAction;
      try {
        decision = skipManager
          ? { action: "done" }
          : await requestAdaptiveAction({
              workspace,
              directory,
              workdir,
              context,
              round,
              state: priorManagerState,
              userSupplement,
              redact,
            });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 成本硬闸/策略漂移：adaptive manager 调用已达上限或配置被改——转 needs_fix + human gate。
        if (isUnretryableInvocationError(error)) {
          const driftPhase =
            error instanceof ExecutorCostLimitError ? "cost_limit" : "policy_drift";
          adaptiveRounds = [
            ...adaptiveRounds,
            { round, action: "error", phase: driftPhase, error: message },
          ];
          return finish({
            status: "needs_fix",
            phase: driftPhase,
            adaptiveRound: round,
            adaptiveRounds,
            error: message,
            humanGate: createHumanGate("needs_input", {
              detail: message,
              questions: ["确认 .cbx.json 配置变更意图后继续，或取消任务。"],
            }),
          });
        }
        const phase =
          error instanceof ManagerWorktreeMutationError
            ? "adaptive_manager_safety"
            : error instanceof ManagerDecisionError
              ? "adaptive_manager_decision"
              : "adaptive_manager";
        const status =
          error instanceof ManagerDecisionError ? "needs_fix" : "failed";
        adaptiveRounds = [
          ...adaptiveRounds,
          { round, action: "error", phase, error: message },
        ];
        return finish({
          status,
          phase,
          adaptiveRound: round,
          adaptiveRounds,
          error: message,
        });
      }
      if (existsSync(cancelMarker)) return finishCancelled();
      if (skipManager)
        logJobEvent(workspace, jobId, "adaptive_manager_skipped", {
          round,
          managerDoneStreak,
        });
      else
        logJobEvent(workspace, jobId, "adaptive_decision", {
          round,
          action: decision.action,
        });
      // 非 done 决策重置 done 缓存计数
      if (decision.action !== "done") managerDoneStreak = 0;
      if (decision.action === "ask") {
        const questions = decision.questions.map((question) =>
          redact(question).slice(0, 1_000),
        );
        adaptiveRounds = [
          ...adaptiveRounds,
          { round, action: decision.action, questions },
        ];
        return finish({
          status: "needs_fix",
          phase: "adaptive_ask",
          adaptiveRound: round,
          adaptiveRounds,
          blockingQuestions: questions,
          humanGate: createHumanGate("needs_input", {
            questions,
            detail: "Adaptive Manager 需要用户补充信息。",
          }),
          error: "Adaptive Manager 需要用户补充信息。",
        });
      }
      if (decision.action === "blocked") {
        const reason = redact(decision.reason).slice(0, 1_000);
        adaptiveRounds = [
          ...adaptiveRounds,
          { round, action: decision.action, reason },
        ];
        return finish({
          status: "needs_fix",
          phase: "adaptive_blocked",
          adaptiveRound: round,
          adaptiveRounds,
          blockedReason: reason,
          humanGate: createHumanGate("needs_input", {
            questions: [reason],
            detail: reason,
          }),
          error: reason,
        });
      }
      if (decision.action === "done") {
        adaptiveRounds = [
          ...adaptiveRounds,
          { round, action: decision.action, cached: skipManager || undefined },
        ];
        const lastReview = stageReports.at(-1)?.reviewVerdict ?? null;
        const lastTest = stageReports.length
          ? (stageReports.at(-1)?.testExitCode ?? 0)
          : 0;
        const doneState = await finish({
          status: "done",
          phase: "done",
          adaptiveRound: round,
          adaptiveRounds,
          stages: stageReports,
          reviewVerdict: lastReview === "skipped" ? null : lastReview,
          reviewExitCode: 0,
          testExitCode: lastTest,
        });
        // 证据门通过 → 真 done，返回。
        if (doneState.status === "done") return doneState;
        // finish 可能因 approvalBeforeComplete 改为 awaiting_approval、因 autoCommit 失败改为 failed，
        // 或因证据门改为 needs_fix/verification_gate。仅 verification_gate 才可重试；其余终态立即返回，不得被下一轮覆盖。
        if (
          doneState.status !== "needs_fix" ||
          doneState.phase !== "verification_gate"
        )
          return doneState;
        // verification_gate 且无已执行 stage：done 无修复材料，直接返回，不空转耗 maxRounds。
        if (stageReports.length === 0) return doneState;
        managerDoneStreak += 1;
        await writeState(workspace, jobId, { managerDoneStreak });
        // 超过跳过上限：下一轮强制调用 Manager 重新评估，避免无限缓存 done 卡死。
        if (managerDoneStreak > MANAGER_SKIP_LIMIT)
          logJobEvent(workspace, jobId, "adaptive_manager_skip_exhausted", {
            round,
            managerDoneStreak,
          });
        continue;
      }

      const stage = decision.stage as TaskStage;
      const stageIndex = stageReports.length;
      const stageLabel = resolveExecutor(stage.executor)?.label ?? "编码代理";
      logJobEvent(workspace, jobId, "stage_started", {
        stage: stage.name,
        executor: stage.executor,
        index: stageIndex,
        adaptiveRound: round,
      });
      const outcome = await runStage({
        workspace,
        jobId,
        directory,
        workdir,
        context,
        stage,
        stageIndex,
        stageLabel,
        stageExtra: [extra, stage.task].filter(Boolean).join("\n\n"),
        attempt,
        attemptExtra,
        maxAttempts,
        cancelMarker,
        redact,
        finish,
        finishCancelled,
      });
      stageReports.push(outcome.report);
      adaptiveRounds = [
        ...adaptiveRounds,
        { round, action: decision.action, stage, report: outcome.report },
      ];
      if (outcome.terminal) {
        const finalState = await writeState(workspace, jobId, {
          adaptiveRound: round,
          adaptiveRounds,
          stages: stageReports,
        });
        await writeResult(workspace, jobId, finalState);
        return finalState;
      }
      // attemptExtra 是"本 stage 重试修复指令"，不跨 stage/轮次传播——泄漏进下一
      // stage 的 prompt 会让执行器去修上一个阶段的问题。stage 内重试仍在 runStage
      // 自身的循环内生效。
      attempt = outcome.attempt;
      attemptExtra = "";
      const handbackFile = path.join(directory, "handback.md");
      if (existsSync(handbackFile)) {
        const safeName = stage.name.replace(/[^A-Za-z0-9._-]+/g, "-");
        await writeFile(
          path.join(directory, `stage-${stageIndex}-${safeName}-handback.md`),
          await readFile(handbackFile, "utf8"),
          "utf8",
        );
      }
      await writeState(workspace, jobId, {
        phase: "adaptive_manager_next",
        adaptiveRound: round,
        adaptiveRounds,
        stages: stageReports,
        reviewVerdict: outcome.report.reviewVerdict,
        testExitCode: outcome.report.testExitCode,
        error: null,
        retryReason: null,
      });
      logJobEvent(workspace, jobId, "stage_finished", {
        stage: stage.name,
        executor: stage.executor,
        index: stageIndex,
        adaptiveRound: round,
        exitCode: outcome.report.exitCode,
        reviewVerdict: outcome.report.reviewVerdict ?? "skipped",
      });
    }
    const maxRoundsError = `Adaptive Manager 已达累计轮次上限 ${context.adaptive.maxRounds}。`;
    return finish({
      status: "needs_fix",
      phase: "adaptive_max_rounds",
      adaptiveRound: round,
      adaptiveRounds,
      stages: stageReports,
      humanGate: createHumanGate("max_rounds", { detail: maxRoundsError }),
      error: maxRoundsError,
    });
  }

  // Stage chain: stages from taskContract, or single synthetic stage for backward compat.
  const stages: TaskStage[] = context.taskContract?.stages ?? [
    {
      name: "implementation",
      executor: context.executor,
      task: "实现 request.md 中的目标",
      reviewExecutor: context.reviewExecutor,
    },
  ];
  // 崩溃续跑恢复：worker 崩溃时 state.status 仍是 running，队列回收重入后跳过
  // 已完成的 stage（报告已持久化）。显式 retry/continue 的入口状态是 failed 等
  // 终态，不在此列——它们语义上就是全量重跑。
  const resumingCrashedChain = initial.status === "running";
  const stageReports: StageReport[] = resumingCrashedChain && Array.isArray(initial.stages)
    ? (initial.stages as StageReport[])
    : [];

  // 分组调度：按依赖拓扑层执行（groupStagesByDependency），保证依赖 stage 先完成并产出 handback。
  // stageIndex 映射回原始 stages 数组，使 handback 文件名（stage-<index>-<name>-handback.md）与依赖查找一致。
  // 失败传播：stage 进入失败终态时，其所有下游依赖 stage 标记 skipped（记 stage_skipped 事件 + 报告），不再执行。
  const failedStageNames = new Set<string>();
  const nameToIndex = new Map(
    stages.map((stage, index) => [stage.name, index]),
  );
  // 按拓扑层展平执行顺序，层内保持声明顺序。
  const executionOrder = groupStagesByDependency(stages).flat();
  const executedNames = new Set<string>();
  for (const stage of executionOrder) {
    const stageIndex = nameToIndex.get(stage.name) ?? 0;
    // 崩溃续跑：该 stage 上次已跑完（非终态才会留下报告），直接跳过，避免整链从
    // stage 0 重放烧预算、且重跑失败会继承已持久化的重试计数直接终败。
    if (resumingCrashedChain && stageReports.some((report) => report.name === stage.name)) {
      executedNames.add(stage.name);
      logJobEvent(workspace, jobId, "stage_resumed_skip", {
        stage: stage.name,
        index: stageIndex,
      });
      continue;
    }
    const stageExecutor = stage.executor;
    const stageLabel = resolveExecutor(stageExecutor)?.label ?? "编码代理";
    executedNames.add(stage.name);
    // 失败传播：任一 dependsOn stage 已失败则跳过当前 stage。
    const failedDeps = (stage.dependsOn ?? []).filter((dep) =>
      failedStageNames.has(dep),
    );
    if (failedDeps.length > 0) {
      logJobEvent(workspace, jobId, "stage_skipped", {
        stage: stage.name,
        executor: stageExecutor,
        index: stageIndex,
        reason: `前置阶段失败：${failedDeps.join(", ")}`,
      });
      stageReports.push({
        name: stage.name,
        executor: stageExecutor,
        exitCode: -1,
        testExitCode: null,
        reviewVerdict: null,
        attempts: 0,
      });
      failedStageNames.add(stage.name);
      continue;
    }
    // handback 注入：聚合所有 dependsOn stage 的交接（依赖模式），或上一阶段的 handback（线性模式）。
    const depHandback = await collectDependencyHandbacks(
      directory,
      stages,
      stage,
    );
    const linearHandback =
      stageIndex > 0 &&
      !stage.dependsOn?.length &&
      existsSync(path.join(directory, "handback.md"))
        ? await readFile(path.join(directory, "handback.md"), "utf8")
        : "";
    const handbackContext =
      depHandback ||
      (linearHandback ? `上一阶段交接：\n${linearHandback}` : "");
    const stageExtra = [extra, handbackContext, stage.task]
      .filter(Boolean)
      .join("\n\n");
    logJobEvent(workspace, jobId, "stage_started", {
      stage: stage.name,
      executor: stageExecutor,
      index: stageIndex,
      total: stages.length,
      dependsOn: stage.dependsOn ?? [],
    });
    const outcome = await runStage({
      workspace,
      jobId,
      directory,
      workdir,
      context,
      stage,
      stageIndex,
      stageLabel,
      stageExtra,
      attempt,
      attemptExtra,
      maxAttempts,
      cancelMarker,
      redact,
      finish,
      finishCancelled,
    });
    if (outcome.terminal) {
      stageReports.push(outcome.report);
      failedStageNames.add(stage.name);
      // 失败传播：terminal 失败后，剩余未执行的下游依赖 stage 批量标记 skipped，
      // 使 stage_skipped 事件可达且 result.json 的 stages 完整反映依赖链状态。
      for (const remaining of executionOrder) {
        if (executedNames.has(remaining.name)) continue;
        const downDeps = (remaining.dependsOn ?? []).filter((dep) =>
          failedStageNames.has(dep),
        );
        if (downDeps.length > 0) {
          const remIndex = nameToIndex.get(remaining.name) ?? 0;
          logJobEvent(workspace, jobId, "stage_skipped", {
            stage: remaining.name,
            executor: remaining.executor,
            index: remIndex,
            reason: `前置阶段失败：${downDeps.join(", ")}`,
          });
          stageReports.push({
            name: remaining.name,
            executor: remaining.executor,
            exitCode: -1,
            testExitCode: null,
            reviewVerdict: null,
            attempts: 0,
          });
          failedStageNames.add(remaining.name);
          executedNames.add(remaining.name);
        }
      }
      const finalState = await writeState(workspace, jobId, {
        stages: stageReports,
      });
      await writeResult(workspace, jobId, finalState);
      return finalState;
    }
    stageReports.push(outcome.report);
    attempt = outcome.attempt;
    attemptExtra = outcome.attemptExtra;
    // 每个 stage 完成后持久化报告：崩溃续跑据此跳过已完成 stage（见上方恢复逻辑）。
    await writeState(workspace, jobId, { stages: stageReports });
    // 失败传播标记：review FAIL 或非零退出记入 failedStageNames，后继 stage 会跳过。
    if (
      outcome.report.reviewVerdict === "FAIL" ||
      outcome.report.exitCode !== 0
    )
      failedStageNames.add(stage.name);
    // Preserve a per-stage copy of handback for the audit trail.
    const handbackFile = path.join(directory, "handback.md");
    if (existsSync(handbackFile)) {
      // stage.name 来自 task_contract，不可信：清洗后再拼文件名，防路径穿越。
      const safeName = stage.name.replace(/[^A-Za-z0-9._-]+/g, "-");
      const stageCopy = path.join(
        directory,
        `stage-${stageIndex}-${safeName}-handback.md`,
      );
      await writeFile(stageCopy, await readFile(handbackFile, "utf8"), "utf8");
    }
    logJobEvent(workspace, jobId, "stage_finished", {
      stage: stage.name,
      executor: stageExecutor,
      index: stageIndex,
      exitCode: outcome.report.exitCode,
      reviewVerdict: outcome.report.reviewVerdict ?? "skipped",
    });
  }

  const lastReview = stageReports.at(-1)?.reviewVerdict ?? null;
  return finish({
    status: "done",
    phase: "done",
    stages: stageReports,
    reviewVerdict: lastReview === "skipped" ? null : lastReview,
    reviewExitCode: 0,
    testExitCode: 0,
  });
}

async function prepareContinuationUnlocked(
  workspace: string,
  jobId: string,
  instructions: string,
  extraRounds = 0,
): Promise<{ instructions: string; blocked?: JobState }> {
  if (!Number.isInteger(extraRounds) || extraRounds < 0)
    throw new Error("extra_rounds 必须是非负整数。");
  const state = await loadState(workspace, jobId);
  const config = await loadConfig(workspace);
  const redact = contextRedactor(config.governance);
  const safeInstructions = redact(instructions);
  if (!state.humanGate) {
    if (extraRounds) throw new Error("当前任务没有等待追加轮次的 Human Gate。");
    return { instructions: safeInstructions };
  }
  const gate = parseHumanGate(state.humanGate);
  if (gate.status === "resolved") {
    if (extraRounds) throw new Error("当前 Human Gate 已解决，不能追加轮次。");
    return { instructions: safeInstructions };
  }
  if (gate.reason === "before_run" || gate.reason === "completion")
    return { instructions: safeInstructions, blocked: state };
  if (gate.reason === "max_rounds") {
    if (!extraRounds) return { instructions: safeInstructions, blocked: state };
    const directory = jobDir(workspace, jobId);
    const context = await loadJobContext(directory);
    if (!context.adaptive?.enabled)
      throw new Error("max_rounds gate 缺少 Adaptive 配置。");
    context.adaptive.maxRounds = extendRoundLimit(
      context.adaptive.maxRounds,
      extraRounds,
    );
    await saveJson(path.join(directory, "context.json"), context, {
      fsync: false,
    });
  } else if (extraRounds) {
    throw new Error("extra_rounds 只能用于 max_rounds Human Gate。");
  }
  const humanGate = resolveHumanGate(gate, safeInstructions, redact);
  // 用户已针对 gate 给出纠偏：重置失败计数与重试预算，避免旧 error/旧计数在续跑时被重复计入或预算过早耗尽。
  await writeState(workspace, jobId, {
    humanGate,
    continuationInstructions: humanGate.instructions ?? null,
    blockingQuestions: null,
    blockedReason: null,
    failureTracker: null,
    executionUsed: 0,
    fixUsed: 0,
    stageRetries: {},
  });
  return { instructions: safeInstructions };
}

async function prepareContinuation(
  workspace: string,
  jobId: string,
  instructions: string,
  extraRounds = 0,
): Promise<{ instructions: string; blocked?: JobState }> {
  return withFileLock(
    path.join(jobDir(workspace, jobId), "gate.lock"),
    () =>
      prepareContinuationUnlocked(workspace, jobId, instructions, extraRounds),
    { retries: 0, busyMessage: `Human Gate 正在更新：${jobId}` },
  );
}

export async function executeJob(
  workspaceInput: string,
  jobId: string,
  extra = "",
  queueEntryId?: string,
  extraRounds = 0,
): Promise<JobState> {
  const workspace = path.resolve(workspaceInput);
  const continuation = await prepareContinuation(
    workspace,
    jobId,
    extra,
    extraRounds,
  );
  if (continuation.blocked) return continuation.blocked;
  const lock = path.join(jobDir(workspace, jobId), "run.lock");
  return withFileLock(
    lock,
    async () => {
      // span 在锁内开启：E_LOCK_BUSY 直接抛出时不进入本回调，锁外开的 span 永远
      // 不会被 finish（遥测里只留半条记录）。
      const span = startSpan("cbx.job", { jobId });
      try {
        // 排队中/前台被取消的任务不得启动：保留取消标记并返回终态。
        // 有标记而状态未及落定（cancelJob 中途宿主崩溃 / 僵尸接管）时按取消收口，
        // 不能带着标记进 executeJobLocked——握手等不检查标记的路径会把执行器
        // 完整跑满一个超时。已是终态（如 retry 崩溃残留）原样返回。
        // 重新执行必须走 continue/retry（入队时清除取消标记）。
        const marker = path.join(jobDir(workspace, jobId), "cancel.requested");
        if (existsSync(marker)) {
          const current = await loadState(workspace, jobId);
          const settled = ["cancelled", "done", "failed", "review_failed", "needs_fix"].includes(current.status);
          const cancelled = settled
            ? current
            : await cancelJobState(workspace, jobId, { status: "cancelled", phase: "cancelled", cancelledAt: now() });
          if (queueEntryId) await finishQueueEntry(workspace, queueEntryId);
          await writeResult(workspace, jobId, cancelled);
          await pruneAfterTerminal(workspace);
          return cancelled;
        }
        const result = await executeJobLocked(
          workspace,
          jobId,
          continuation.instructions,
          queueEntryId,
        );
        if (queueEntryId) await dispatchQueue(workspace);
        // 保留期清理收敛到任务终态（含 early-return 的基线漂移/取消路径），避免每次 writeState 都触发。
        await pruneAfterTerminal(workspace);
        return result;
      } finally {
        try {
          const finalState = await loadState(workspace, jobId);
          await finishSpan(
            workspace,
            span,
            finalState.status === "done" ? "ok" : "error",
            { status: finalState.status, attempt: finalState.attempt },
          );
        } catch (error) {
          logJobEvent(workspace, jobId, "telemetry_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
    { retries: 0, busyMessage: `任务正在运行中：${jobId}` },
  );
}

export { prepareContinuation };
