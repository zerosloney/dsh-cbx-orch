import { existsSync } from "node:fs";
import path from "node:path";
import { loadJobContext, loadJson, saveJson, updateJobContext } from "./storage.js";
import {
  snapshotGitBaseline,
  gitDirtyFingerprint,
  gitDirtyFingerprintTracked,
  snapshotDiff,
  gitRoot,
} from "./git-ops.js";
import { loadState, writeState, logJobEvent } from "./state.js";
import { invokeExecutor, promptFor } from "./runner.js";
import { writeResult } from "./result.js";
import { createExecutorContextPack } from "./context-pack.js";
import { createHumanGate } from "./human-gate.js";
import { ExecutorCostLimitError, isUnretryableInvocationError } from "./errors.js";
import { contextArtifacts } from "./artifacts.js";
import { resolveExecutor } from "./executors/builtin.js";
import { captureAsync } from "./process-runner.js";
import type {
  JobContext,
  JobState,
  Json,
  Understanding,
  BaselineDrift,
} from "./types.js";
import type { ProcessResult } from "./process-runner.js";

export function semanticReviewFailure(review: string): boolean {
  return review
    .split(/\r?\n/)
    .slice(1, 4)
    .some((line) =>
      /^CLASSIFICATION\s*:\s*(SEMANTIC|CONTRACT|BASELINE)$/i.test(line.trim()),
    );
}

/** 按任务记录的指纹版本选择算法：v2（仅跟踪文件）消除"未跟踪 scratch 文件引发
 *  脏漂移误报"；旧任务（无版本字段）保持 v1 比对，避免升级即全员漂移。 */
async function dirtyFingerprintFor(
  context: Pick<JobContext, "dirtyFingerprintVersion">,
  workspace: string,
): Promise<string | undefined> {
  return context.dirtyFingerprintVersion === 2
    ? gitDirtyFingerprintTracked(workspace)
    : gitDirtyFingerprint(workspace);
}

export async function evaluateBaselineDrift(
  context: JobContext,
  workspace: string,
): Promise<BaselineDrift> {
  const currentBaseline = await snapshotGitBaseline(workspace);
  const currentDirtyFingerprint = await dirtyFingerprintFor(context, workspace);
  return {
    currentBaseline,
    currentDirtyFingerprint,
    commitDrift: Boolean(
      context.baseCommit &&
      currentBaseline?.commit &&
      context.baseCommit !== currentBaseline.commit,
    ),
    dirtyDrift: Boolean(
      context.dirtyFingerprint &&
      currentDirtyFingerprint &&
      context.dirtyFingerprint !== currentDirtyFingerprint,
    ),
  };
}

export async function refreshBaseline(
  workspace: string,
  jobId: string,
  directory: string,
): Promise<JobState> {
  const baseline = await snapshotGitBaseline(workspace);
  const context = await loadJobContext(directory);
  // 刷新即升级到 v2 指纹：用户显式确认当前状态为新基线，此后未跟踪文件不再参与漂移判定。
  const dirtyFingerprint = await gitDirtyFingerprintTracked(workspace);
  Object.assign(context, {
    gitRoot: baseline?.root,
    baseCommit: baseline?.commit,
    baseBranch: baseline?.branch,
    baseDirty: baseline?.dirty,
    baseStatus: baseline?.status,
    dirtyFingerprint,
    dirtyFingerprintVersion: 2,
  });
  await saveJson(path.join(directory, "context.json"), context, {
    fsync: false,
  });
  const refreshedState = await writeState(workspace, jobId, {
    baselineDrift: false,
    dirtyBaselineDrift: false,
    currentCommit: null,
    error: null,
  });
  await writeResult(workspace, jobId, refreshedState);
  logJobEvent(workspace, jobId, "baseline_refreshed", {
    baseCommit: baseline?.commit,
    baseBranch: baseline?.branch,
    baseDirty: baseline?.dirty,
  });
  return refreshedState;
}

/**
 * context.json schema 迁移基础设施（首个迁移）：旧任务（无 dirtyFingerprintVersion，
 * 即 v1 指纹）在下次执行时懒升级到 v2——未跟踪 scratch 文件不再参与漂移判定。
 *
 * 迁移守卫：仅在"已跟踪改动为空"时才升级。工作区存在真实已跟踪改动时保留 v1
 * 语义（继续按 v1 比对、让脏漂移照常拦截），由用户显式 refreshBaseline 才升级——
 * 否则懒迁移会把未提交改动静默洗成新基线。
 */
export async function tryMigrateDirtyFingerprintV2(
  workspace: string,
  jobId: string,
  directory: string,
  context: JobContext,
): Promise<void> {
  if (context.dirtyFingerprintVersion || context.isolated) return;
  const trackedStatus = await captureAsync(
    ["git", "status", "--porcelain", "--untracked-files=no", "--", ".", ":(exclude).cbx", ":(exclude).cbx/**"],
    workspace,
  );
  if (trackedStatus.code !== 0 || trackedStatus.stdout.trim()) return;
  const dirtyFingerprint = await gitDirtyFingerprintTracked(workspace);
  if (dirtyFingerprint === undefined) return;
  await updateJobContext(workspace, jobId, {
    dirtyFingerprint,
    dirtyFingerprintVersion: 2,
  });
  context.dirtyFingerprint = dirtyFingerprint;
  context.dirtyFingerprintVersion = 2;
  logJobEvent(workspace, jobId, "context_schema_migrated", {
    from: 1,
    to: 2,
    reason: "dirty fingerprint v2",
  });
}

export async function performContextHandshake(
  workspace: string,
  directory: string,
  context: JobContext,
  workdir: string,
  extra: string,
  redact: (text: string) => string,
  finish: (updates: Json) => Promise<JobState>,
): Promise<JobState | undefined> {
  const beforeHandshake = await snapshotDiff(workdir);
  const executor =
    context.taskContract?.stages?.[0]?.executor ?? context.executor;
  const label = resolveExecutor(executor)?.label ?? "编码代理";
  const handshakeStage = context.taskContract?.stages?.[0] ?? {
    name: "context-handshake",
    executor,
    task: "确认任务理解",
  };
  const currentState = await loadState(workspace, context.jobId);
  const contextPack = await createExecutorContextPack({
    directory,
    taskContract: context.taskContract,
    verifiedProgress: currentState.verifiedProgress,
    audit: currentState.audit,
    recentFailure: {
      phase: currentState.phase,
      error: currentState.error,
      retryReason: currentState.retryReason as string | undefined,
    },
    userInstructions: extra,
    artifactNames: contextArtifacts(directory, ["context-snapshot.md"]),
    redact,
    budget: context.contextBudget,
    stage: handshakeStage,
    attempt: Number(currentState.attempt ?? 0),
  });
  const handshakePrompt = promptFor(
    "context handshake",
    `只确认上下文包中的任务理解，不要修改代码。将 JSON 写入 ${path.join(directory, "understanding.json")}，字段为 interpretedGoal、plannedFiles、acceptanceCriteria、assumptions、blockingQuestions。没有阻塞问题时 blockingQuestions 必须是空数组；需要产品决策、公共契约选择或上下文冲突时写入问题并停止。`,
    label,
    contextPack.path,
  );
  let handshake: ProcessResult;
  try {
    handshake = await invokeExecutor(
      executor,
      workspace,
      directory,
      workdir,
      handshakePrompt,
      context.permissionMode,
      context.maxTurns,
      context.timeoutMs,
      { role: "gate", jobId: context.jobId },
    );
  } catch (error) {
    // 成本硬闸/策略漂移：握手阶段的执行器调用已达上限或配置被改——转 needs_fix 而非普通握手失败。
    if (isUnretryableInvocationError(error)) {
      return finish({
        status: "needs_fix",
        phase: error instanceof ExecutorCostLimitError ? "cost_limit" : "policy_drift",
        contextIssue: true,
        error: error.message,
        humanGate: createHumanGate("needs_input", {
          detail: error.message,
          questions: ["确认 .cbx.json 配置变更意图后继续，或取消任务。"],
        }),
      });
    }
    return finish({
      status: "needs_fix",
      phase: "context_handshake",
      contextIssue: true,
      error: String(error),
    });
  }
  const afterHandshake = await snapshotDiff(workdir);
  if (JSON.stringify(beforeHandshake) !== JSON.stringify(afterHandshake))
    return finish({
      status: "needs_fix",
      phase: "context_handshake",
      contextIssue: true,
      error: "上下文握手阶段修改了工作区。",
    });
  if (
    handshake.code !== 0 ||
    handshake.timedOut ||
    !existsSync(path.join(directory, "understanding.json"))
  )
    return finish({
      status: "needs_fix",
      phase: "context_handshake",
      contextIssue: true,
      error: "执行代理未能生成有效的 understanding.json。",
    });
  const understanding = await loadJson<Understanding>(
    path.join(directory, "understanding.json"),
  );
  if (!Array.isArray(understanding.blockingQuestions))
    return finish({
      status: "needs_fix",
      phase: "context_handshake",
      contextIssue: true,
      error: "understanding.json 缺少 blockingQuestions 数组。",
    });
  if (understanding.blockingQuestions.length) {
    const questions = understanding.blockingQuestions.map((question) =>
      redact(String(question)).slice(0, 1_000),
    );
    return finish({
      status: "needs_fix",
      phase: "awaiting_clarification",
      contextIssue: true,
      blockingQuestions: questions,
      humanGate: createHumanGate("needs_input", {
        questions,
        detail: "任务存在阻塞性歧义，需要主 Agent 纠偏。",
      }),
      error: "任务存在阻塞性歧义，需要主 Agent 纠偏。",
    });
  }
  return undefined;
}
