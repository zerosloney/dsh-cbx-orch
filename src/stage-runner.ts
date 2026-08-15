import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadJson } from "./storage.js";
import { snapshotDiff, collectDiff } from "./git-ops.js";
import { loadState, writeState, logJobEvent } from "./state.js";
import { invokeExecutor, promptFor, runTest } from "./runner.js";
import {
  createExecutorContextPack,
  createAuditorContextPack,
} from "./context-pack.js";
import {
  managerPrompt,
  parseNextAction,
  type AdaptiveOptions,
  type NextAction,
} from "./adaptive-manager.js";
import { createManagerContextPack } from "./context-pack.js";
import {
  criterionDefinitions,
  parseStructuredAudit,
  reconcileVerifiedProgress,
  type StructuredAudit,
  type VerifiedProgress,
} from "./progress.js";
import { evidenceHashes, structuredAuditRequested } from "./evidence.js";
import { createHumanGate } from "./human-gate.js";
import { resolveExecutor } from "./executors/builtin.js";
import { contextArtifacts, AUDIT_CANDIDATE } from "./artifacts.js";
import type {
  JobContext,
  JobState,
  Json,
  TaskStage,
  StageReport,
  StageOutcome,
} from "./types.js";
import type { ProcessResult } from "./process-runner.js";

export class ManagerWorktreeMutationError extends Error {}
export class ManagerDecisionError extends Error {}
export class ManagerInvocationError extends Error {}

export async function requestAdaptiveAction(params: {
  workspace: string;
  directory: string;
  workdir: string;
  context: JobContext;
  round: number;
  state: JobState;
  userSupplement: string;
  redact: (text: string) => string;
}): Promise<NextAction> {
  const {
    workspace,
    directory,
    workdir,
    context,
    round,
    state,
    userSupplement,
    redact,
  } = params;
  const candidate = path.join(directory, "manager-decision-candidate.json");
  if (existsSync(candidate)) await unlink(candidate);
  const before = await snapshotDiff(workdir);
  const adaptive = context.adaptive!;
  const contextPack = await createManagerContextPack({
    directory,
    taskContract: context.taskContract,
    verifiedProgress: state.verifiedProgress,
    audit: state.audit,
    recentFailure: {
      phase: state.phase,
      error: state.error as string | undefined,
      retryReason: state.retryReason as string | undefined,
      count: (state.failureTracker as { count?: number } | undefined)?.count,
    },
    userInstructions: userSupplement,
    artifactNames: contextArtifacts(directory, [
      "context-snapshot.md",
      "complete.patch",
      "test.log",
      "review.md",
      "handback.md",
      "audit.json",
      "verified-progress.json",
    ]),
    redact,
    budget: context.contextBudget,
    round,
    maxRounds: adaptive.maxRounds,
  });
  let result: ProcessResult | undefined;
  let invocationError: unknown;
  try {
    result = await invokeExecutor(
      adaptive.managerExecutor ?? context.executor,
      workspace,
      directory,
      workdir,
      managerPrompt(candidate, contextPack.path),
      context.permissionMode,
      context.maxTurns,
      context.timeoutMs,
      { role: "manager", jobId: context.jobId },
    );
  } catch (error) {
    invocationError = error;
  }
  const after = await snapshotDiff(workdir);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await collectDiff(directory, workdir);
    throw new ManagerWorktreeMutationError(
      "Adaptive Manager 修改了工作区，任务已安全停止。",
    );
  }
  if (invocationError)
    throw new ManagerInvocationError(
      invocationError instanceof Error
        ? invocationError.message
        : String(invocationError),
    );
  if (!result)
    throw new ManagerInvocationError("Adaptive Manager 未返回执行结果。");
  if (result.code !== 0 || result.timedOut)
    throw new ManagerInvocationError(
      result.timedOut
        ? `Adaptive Manager 超时（${context.timeoutMs}ms）`
        : "Adaptive Manager 执行失败。",
    );
  if (!existsSync(candidate))
    throw new ManagerDecisionError(
      "Adaptive Manager 未生成 manager-decision-candidate.json。",
    );
  let raw: unknown;
  try {
    raw = await loadJson<unknown>(candidate);
  } catch (error) {
    await unlink(candidate);
    throw new ManagerDecisionError(
      error instanceof Error ? error.message : String(error),
    );
  }
  await unlink(candidate);
  try {
    return parseNextAction(raw);
  } catch (error) {
    throw new ManagerDecisionError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function runStage(params: {
  workspace: string;
  jobId: string;
  directory: string;
  workdir: string;
  context: JobContext;
  stage: TaskStage;
  stageIndex: number;
  stageLabel: string;
  stageExtra: string;
  attempt: number;
  attemptExtra: string;
  maxAttempts: number;
  cancelMarker: string;
  redact: (text: string) => string;
  finish: (updates: Json) => Promise<JobState>;
  finishCancelled: () => Promise<JobState>;
}): Promise<StageOutcome> {
  const {
    workspace,
    jobId,
    directory,
    workdir,
    context,
    stage,
    stageIndex,
    stageLabel,
    stageExtra,
    maxAttempts,
    cancelMarker,
    redact,
    finish,
    finishCancelled,
  } = params;
  let attempt = params.attempt;
  let attemptExtra = params.attemptExtra;
  let lastError = "";
  let executorExitCode = 0;
  let testExitCode: number | null = null;
  let reviewVerdict: string | null = null;
  const executionRetries = context.executionRetries ?? maxAttempts;
  const fixRetries = context.fixRetries ?? maxAttempts;
  // 重试计数器持久化于 state.json：崩溃后被队列回收重入 runStage 时按持久值恢复，避免每次 resume 都拿满预算绕过 maxRetries；
  // 显式 retry / 用户 resolve Human Gate 时由 prepareContinuation、retryQueueJob 归零。
  const persistedUsage = await loadState(workspace, jobId);
  // 每 stage 独立重试预算: stageRetries 是 { [stageIndex]: { execution, fix } } 映射。
  // 崩溃后队列回收重入时读持久化值恢复，不拿满预算绕过 maxRetries。
  const stageRetries =
    (persistedUsage.stageRetries as
      Record<string, { execution: number; fix: number }> | undefined) ?? {};
  const stageKey = String(stageIndex);
  const stageEntry = stageRetries[stageKey] ?? { execution: 0, fix: 0 };
  let executionUsed = Math.max(
    0,
    Math.floor(Number(stageEntry.execution) || 0),
  );
  let fixUsed = Math.max(0, Math.floor(Number(stageEntry.fix) || 0));
  const persistRetries = async (): Promise<void> => {
    const current = await loadState(workspace, jobId);
    const currentRetries =
      (current.stageRetries as
        Record<string, { execution: number; fix: number }> | undefined) ?? {};
    await writeState(workspace, jobId, {
      stageRetries: {
        ...currentRetries,
        [stageKey]: { execution: executionUsed, fix: fixUsed },
      },
    });
  };
  const useExecutionRetry = async (): Promise<void> => {
    executionUsed += 1;
    await persistRetries();
  };
  const useFixRetry = async (): Promise<void> => {
    fixUsed += 1;
    await persistRetries();
  };
  // 依赖守卫的受监控清单：覆盖主流语言生态的依赖声明 + 锁文件。
  // executor（codebuddy/opencode 等）是多语言通用编码 CLI，仅覆盖 JS 会让 Go/Rust/Python 项目裸奔。
  const DEP_FILES = [
    // JS / Node
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    // Python
    "requirements.txt",
    "pyproject.toml",
    "poetry.lock",
    "Pipfile.lock",
    // Rust
    "Cargo.toml",
    "Cargo.lock",
    // Go
    "go.mod",
    "go.sum",
    // Ruby
    "Gemfile",
    "Gemfile.lock",
    // Java / JVM
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
  ];
  const depBaseline: Record<string, string> = {};
  if (context.dependencyGuard) {
    for (const file of DEP_FILES) {
      const fullPath = path.join(workdir, file);
      if (existsSync(fullPath)) {
        depBaseline[file] = createHash("sha256")
          .update(await readFile(fullPath))
          .digest("hex");
      }
    }
  }

  // intentional-simple: 闭包内构造辅助。report.name/executor/attempts 与 attempt/attemptExtra 在所有 16 个返回点取值相同，
  // 仅 terminal/state/exitCode/testExitCode/reviewVerdict 因分支而异；闭包按引用读取重试预算变量，useXxxRetry 后自动累加。
  const outcome = (
    terminal: boolean,
    state: JobState,
    exitCode: number,
    testExitCode: number | null,
    reviewVerdict: string | null,
  ): StageOutcome => ({
    terminal,
    state,
    report: {
      name: stage.name,
      executor: stage.executor,
      exitCode,
      testExitCode,
      reviewVerdict,
      attempts: executionUsed + fixUsed,
      // P0-2: 把 context.maxTurns 透传到 StageReport；当前 TaskStage 未支持 per-stage 覆盖，
      // 所以 per-stage 预算恒等于 context.maxTurns。预留字段，未来 stage 加 maxTurns 时只改这里。
      configuredMaxTurns: context.maxTurns,
    },
    attempt,
    attemptExtra,
  });
  const cancelOutcome = async (
    exitCode: number,
    testExitCode: number | null,
  ): Promise<StageOutcome> =>
    outcome(true, await finishCancelled(), exitCode, testExitCode, null);

  for (;;) {
    if (existsSync(cancelMarker)) return await cancelOutcome(-1, null);
    attempt += 1;
    await writeState(workspace, jobId, {
      status: "running",
      phase: "executing",
      stage: stage.name,
      stageIndex,
      attempt,
      workdir,
      error: lastError || null,
    });
    const executorState = await loadState(workspace, jobId);
    const executorPack = await createExecutorContextPack({
      directory,
      taskContract: context.taskContract,
      verifiedProgress: executorState.verifiedProgress,
      audit: executorState.audit,
      recentFailure: {
        phase: executorState.phase,
        error: lastError || undefined,
        retryReason: executorState.retryReason as string | undefined,
        count: (executorState.failureTracker as { count?: number } | undefined)
          ?.count,
      },
      userInstructions: [stageExtra, attemptExtra].filter(Boolean).join("\n\n"),
      artifactNames: contextArtifacts(directory, [
        "context-snapshot.md",
        "complete.patch",
        "test.log",
        "review.md",
        "handback.md",
        "audit.json",
        "verified-progress.json",
      ]),
      redact,
      budget: context.contextBudget,
      stage,
      attempt,
    });
    let agent: ProcessResult;
    try {
      agent = await invokeExecutor(
        stage.executor,
        workspace,
        directory,
        workdir,
        promptFor(
          `stage ${stageIndex}: ${stage.name}`,
          `按上下文包 current.stage 与 userInstructions 执行。完成后将修改摘要、测试结果和遗留问题写入 ${path.join(directory, "handback.md")}。`,
          stageLabel,
          executorPack.path,
        ),
        context.permissionMode,
        context.maxTurns,
        context.timeoutMs,
        { role: "stage", jobId, stageIndex },
      );
    } catch (error) {
      lastError = String(error);
      if (executionUsed < executionRetries) {
        await useExecutionRetry();
        await writeState(workspace, jobId, {
          phase: "retrying",
          stage: stage.name,
          retryReason: lastError,
        });
        continue;
      }
      const state = await finish({
        status: "failed",
        phase: "executing",
        stage: stage.name,
        error: lastError,
      });
      return outcome(true, state, -1, null, null);
    }
    if (existsSync(cancelMarker))
      return await cancelOutcome(agent.code, null);
    await collectDiff(directory, workdir);
    if (context.dependencyGuard) {
      let depChanged = false;
      const changedDepFiles: string[] = [];
      for (const file of DEP_FILES) {
        const fullPath = path.join(workdir, file);
        if (existsSync(fullPath) && depBaseline[file]) {
          const currentHash = createHash("sha256")
            .update(await readFile(fullPath))
            .digest("hex");
          if (currentHash !== depBaseline[file]) {
            depChanged = true;
            changedDepFiles.push(file);
          }
        }
      }
      if (depChanged) {
        lastError = `依赖守卫：未经授权修改了依赖文件：${changedDepFiles.join(", ")}。`;
        if (fixUsed < fixRetries) {
          await useFixRetry();
          attemptExtra = `请恢复 ${changedDepFiles.join("、")} 至任务开始前的状态，或通过 --no-dependency-guard 禁用依赖守卫。`;
          await writeState(workspace, jobId, {
            phase: "retrying",
            stage: stage.name,
            retryReason: lastError,
          });
          continue;
        }
        const state = await finish({
          status: "needs_fix",
          phase: "dependency_guard",
          stage: stage.name,
          error: lastError,
        });
        return outcome(true, state, 0, null, null);
      }
    }
    if (agent.code !== 0 || agent.timedOut) {
      lastError = agent.timedOut
        ? `${stageLabel} 超时（${context.timeoutMs}ms）`
        : `${stageLabel} 执行失败`;
      executorExitCode = agent.code;
      if (executionUsed < executionRetries) {
        await useExecutionRetry();
        await writeState(workspace, jobId, {
          phase: "retrying",
          stage: stage.name,
          retryReason: lastError,
          executorExitCode: agent.code,
        });
        continue;
      }
      const state = await finish({
        status: "failed",
        phase: "executing",
        stage: stage.name,
        executorExitCode: agent.code,
        timedOut: agent.timedOut,
        error: lastError,
      });
      return outcome(true, state, agent.code, null, null);
    }
    executorExitCode = 0;
    await writeState(workspace, jobId, {
      phase: "testing",
      stage: stage.name,
      executorExitCode: 0,
    });
    const test = await runTest(
      directory,
      workdir,
      context.testCommand,
      context.timeoutMs,
    );
    if (existsSync(cancelMarker))
      return await cancelOutcome(0, test.code);
    const reviewedSnapshot = await collectDiff(directory, workdir);
    if (test.code !== 0 || test.timedOut) {
      lastError = test.timedOut
        ? `验收命令超时（${context.timeoutMs}ms）`
        : "验收命令失败";
      testExitCode = test.code;
      if (fixUsed < fixRetries) {
        await useFixRetry();
        attemptExtra = `请读取 ${path.join(directory, "test.log")}，修复失败原因后重新执行。`;
        await writeState(workspace, jobId, {
          phase: "retrying",
          stage: stage.name,
          retryReason: lastError,
          testExitCode: test.code,
        });
        continue;
      }
      const state = await finish({
        status: "needs_fix",
        phase: "testing",
        stage: stage.name,
        testExitCode: test.code,
        timedOut: test.timedOut,
        error: lastError,
      });
      return outcome(true, state, 0, test.code, null);
    }
    testExitCode = 0;
    if (stage.skipReview || !context.reviewRequested) {
      reviewVerdict = stage.skipReview ? "skipped" : null;
      return outcome(
        false,
        await loadState(workspace, jobId),
        executorExitCode,
        testExitCode,
        reviewVerdict,
      );
    }
    await writeState(workspace, jobId, {
      status: "running",
      phase: "reviewing",
      stage: stage.name,
      testExitCode: 0,
    });
    const definitions = criterionDefinitions(
      context.taskContract?.acceptanceCriteria ?? [],
    );
    const structuredAuditExtra = structuredAuditRequested(context)
      ? `\n同时将严格 JSON 写入 ${path.join(directory, AUDIT_CANDIDATE)}：{"version":1,"completion":"complete|incomplete|blocked","cleanliness":"clean|suspect|violation","alignment":"aligned|unknown|needs_revision|invalid","criteria":[{"id":"criterion id","status":"verified|unverified|blocked","evidence":["complete.patch"]}]}。criteria 必须恰好覆盖上下文包 current.criteria 的全部 ID；verified 必须引用至少一个证据；evidence 只能引用上下文包 artifacts 中实际存在的文件名。`
      : "";
    const reviewExtra = `只审查上下文包 artifacts 中列出的证据，不要修改代码。将结果写入 ${path.join(directory, "review.md")}。第一行必须是 VERDICT: PASS 或 VERDICT: FAIL。若失败源于需求歧义、公共契约冲突或基线问题，第二行写 CLASSIFICATION: SEMANTIC；普通代码缺陷无需 classification。按严重程度列出问题、文件和行号。${structuredAuditExtra}`;
    let reviewAgent: ProcessResult;
    const reviewExecutor =
      stage.reviewExecutor ?? context.reviewExecutor ?? stage.executor;
    const reviewLabel = resolveExecutor(reviewExecutor)?.label ?? "审查代理";
    const auditCandidate = path.join(directory, AUDIT_CANDIDATE);
    if (existsSync(auditCandidate)) await unlink(auditCandidate);
    if (
      structuredAuditRequested(context) &&
      existsSync(path.join(directory, "review.md"))
    )
      await unlink(path.join(directory, "review.md"));
    const auditorState = await loadState(workspace, jobId);
    const auditorPack = await createAuditorContextPack({
      directory,
      taskContract: context.taskContract,
      verifiedProgress: auditorState.verifiedProgress,
      audit: auditorState.audit,
      recentFailure: {
        phase: auditorState.phase,
        error: auditorState.error as string | undefined,
        retryReason: auditorState.retryReason as string | undefined,
        count: (auditorState.failureTracker as { count?: number } | undefined)
          ?.count,
      },
      userInstructions: "执行独立审查",
      artifactNames: contextArtifacts(directory, [
        "context-snapshot.md",
        "complete.patch",
        "test.log",
        "handback.md",
        "audit.json",
        "verified-progress.json",
      ]),
      redact,
      budget: context.contextBudget,
      stage,
      reviewRules:
        context.reviewRules ??
        "关注正确性、回归风险、安全性、测试覆盖和改动范围。",
      criteria: definitions,
    });
    try {
      reviewAgent = await invokeExecutor(
        reviewExecutor,
        workspace,
        directory,
        workdir,
        promptFor(
          "independent review",
          reviewExtra,
          reviewLabel,
          auditorPack.path,
        ),
        context.permissionMode,
        context.maxTurns,
        context.timeoutMs,
        { role: "review", jobId, stageIndex },
      );
    } catch (error) {
      lastError = String(error);
      if (fixUsed < fixRetries) {
        await useFixRetry();
        await writeState(workspace, jobId, {
          phase: "retrying",
          stage: stage.name,
          retryReason: lastError,
        });
        continue;
      }
      const state = await finish({
        status: "review_failed",
        phase: "reviewing",
        stage: stage.name,
        error: lastError,
      });
      return outcome(true, state, 0, 0, null);
    }
    if (existsSync(cancelMarker)) return await cancelOutcome(0, 0);
    const afterReview = await snapshotDiff(workdir);
    if (JSON.stringify(afterReview) !== JSON.stringify(reviewedSnapshot)) {
      await collectDiff(directory, workdir);
      lastError = "审查代理修改了工作区；为避免交付未经测试的代码，任务已停止";
      const state = await finish({
        status: "review_failed",
        phase: "reviewing",
        stage: stage.name,
        reviewExitCode: reviewAgent.code,
        reviewerModifiedWorktree: true,
        error: lastError,
      });
      return outcome(true, state, 0, 0, "FAIL");
    }
    if (reviewAgent.code !== 0 || reviewAgent.timedOut) {
      lastError = reviewAgent.timedOut
        ? `审查超时（${context.timeoutMs}ms）`
        : "审查代理执行失败";
      if (fixUsed < fixRetries) {
        await useFixRetry();
        await writeState(workspace, jobId, {
          phase: "retrying",
          stage: stage.name,
          retryReason: lastError,
        });
        continue;
      }
      const state = await finish({
        status: "review_failed",
        phase: "reviewing",
        stage: stage.name,
        reviewExitCode: reviewAgent.code,
        timedOut: reviewAgent.timedOut,
        error: lastError,
      });
      return outcome(true, state, 0, 0, null);
    }
    if (structuredAuditRequested(context)) {
      try {
        if (!existsSync(auditCandidate))
          throw new Error("审查代理未生成 audit-candidate.json。");
        const hashes = await evidenceHashes(directory);
        const audit = parseStructuredAudit(
          await loadJson<unknown>(auditCandidate),
          definitions,
          hashes,
        );
        const currentState = await loadState(workspace, jobId);
        const verifiedProgress = reconcileVerifiedProgress(
          definitions,
          currentState.verifiedProgress as VerifiedProgress | undefined,
          audit,
          hashes,
        );
        await writeState(workspace, jobId, {
          audit,
          verifiedProgress,
          auditError: null,
        });
      } catch (error) {
        lastError = `结构化审计无效：${error instanceof Error ? error.message : String(error)}`;
        if (fixUsed < fixRetries) {
          await useFixRetry();
          await writeState(workspace, jobId, {
            phase: "retrying",
            stage: stage.name,
            retryReason: lastError,
            auditError: lastError,
          });
          continue;
        }
        const state = await finish({
          status: "review_failed",
          phase: "reviewing",
          stage: stage.name,
          reviewVerdict: "FAIL",
          reviewExitCode: reviewAgent.code,
          auditError: lastError,
          error: lastError,
        });
        return outcome(true, state, 0, 0, "FAIL");
      }
    }
    const review = existsSync(path.join(directory, "review.md"))
      ? await readFile(path.join(directory, "review.md"), "utf8")
      : "";
    const firstLine = review
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/, 1)[0]
      .trim();
    const pass = /^VERDICT\s*:\s*PASS$/i.test(firstLine);
    if (pass) {
      reviewVerdict = "PASS";
      return outcome(false, await loadState(workspace, jobId), 0, 0, "PASS");
    }
    lastError = "审查发现问题";
    attemptExtra = `请读取 ${path.join(directory, "review.md")}，修复其中的问题后重新执行。`;
    const { semanticReviewFailure } = await import("./baseline.js");
    if (semanticReviewFailure(review)) {
      const detail = "审查发现语义或契约问题，需要主 Agent 纠偏。";
      const state = await finish({
        status: "needs_fix",
        phase: "awaiting_clarification",
        stage: stage.name,
        reviewVerdict: "FAIL",
        reviewExitCode: 0,
        contextIssue: true,
        humanGate: createHumanGate("semantic_conflict", { detail }),
        error: detail,
      });
      return outcome(true, state, 0, 0, "FAIL");
    }
    reviewVerdict = "FAIL";
    if (fixUsed < fixRetries) {
      await useFixRetry();
      await writeState(workspace, jobId, {
        phase: "retrying",
        stage: stage.name,
        retryReason: lastError,
      });
      continue;
    }
    const state = await finish({
      status: "needs_fix",
      phase: "reviewing",
      stage: stage.name,
      reviewVerdict: "FAIL",
      reviewExitCode: 0,
      error: lastError,
    });
    return outcome(true, state, 0, 0, "FAIL");
  }
}
