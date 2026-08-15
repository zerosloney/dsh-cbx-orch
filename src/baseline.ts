import { existsSync } from "node:fs";
import path from "node:path";
import { loadJobContext, loadJson, saveJson } from "./storage.js";
import {
  snapshotGitBaseline,
  gitDirtyFingerprint,
  snapshotDiff,
  gitRoot,
} from "./git-ops.js";
import { loadState, writeState, logJobEvent } from "./state.js";
import { invokeExecutor, promptFor } from "./runner.js";
import { writeResult } from "./result.js";
import { createExecutorContextPack } from "./context-pack.js";
import { createHumanGate } from "./human-gate.js";
import { contextArtifacts } from "./artifacts.js";
import { resolveExecutor } from "./executors/builtin.js";
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

export function evaluateBaselineDrift(
  context: JobContext,
  workspace: string,
): BaselineDrift {
  const currentBaseline = snapshotGitBaseline(workspace);
  const currentDirtyFingerprint = gitDirtyFingerprint(workspace);
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
  const baseline = snapshotGitBaseline(workspace);
  const dirtyFingerprint = gitDirtyFingerprint(workspace);
  const context = await loadJobContext(directory);
  Object.assign(context, {
    gitRoot: baseline?.root,
    baseCommit: baseline?.commit,
    baseBranch: baseline?.branch,
    baseDirty: baseline?.dirty,
    baseStatus: baseline?.status,
    dirtyFingerprint,
  });
  await saveJson(path.join(directory, "context.json"), context);
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
