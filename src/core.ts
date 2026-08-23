// CBX Orchestrator core module — re-export barrel for backward compatibility.
// The original monolithic core.ts has been split into focused modules:
//   types.ts, state.ts, artifacts.ts, result.ts, runner.ts, baseline.ts,
//   stage-runner.ts, execution.ts, approval.ts, lifecycle.ts, queue-api.ts,
//   worktree.ts, jobs.ts

// Types
export type { Json, JobStatus, CbxConfig, JobContext, TaskStage, TaskContract, JobState, StageReport, StageOutcome, Understanding, BaselineDrift } from "./types.js";

// Errors
export { CbxError, isCbxError } from "./errors.js";
export type { CbxErrorCode } from "./errors.js";

// State management
export { jobDir, loadState, loadConfig, mergeConfig, writeState, writeApprovalState, logJobEvent, forgetJob, forgetJobKeepWorktree, purgeJob, flushJobEventMirrors } from "./state.js";
export type { ForgetOptions, ForgetResult } from "./state.js";

// Job creation
export { createJob } from "./jobs.js";

// Artifacts
export { ARTIFACTS, AUDIT_CANDIDATE, contextArtifacts, contextRedactor, listJobs, listJobsWithAudit, readArtifact, readEventsIncremental, listArtifacts, discoverWorkspaces, dedupWorkspaces, listJobsAcrossWorkspaces } from "./artifacts.js";

// Result writing
export { writeResult } from "./result.js";

// Executor invocation
export { promptFor, invokeExecutor, runTest } from "./runner.js";

// Baseline drift & handshake
export { semanticReviewFailure, evaluateBaselineDrift, refreshBaseline, performContextHandshake } from "./baseline.js";

// Stage execution
export { ManagerWorktreeMutationError, ManagerDecisionError, ManagerInvocationError, requestAdaptiveAction, runStage } from "./stage-runner.js";

// Job execution orchestration
export { executeJob, prepareContinuation } from "./execution.js";

// Approval
export { approveJob } from "./approval.js";

// Lifecycle (background start & cancel)
export { startBackground, cancelJob } from "./lifecycle.js";

// Worktree cleanup
export { cleanupWorktree } from "./worktree.js";

// Queue operations facade
export { dispatchQueue, health, serveQueue, enqueueJob, finishQueueEntry, listQueue, pauseQueue, resumeQueue, cancelQueueEntries, cancelJobState, retryQueueJob } from "./queue-api.js";

// Re-export types from queue.js for convenience
export type { QueueEntry, QueueEntryStatus, QueueFile } from "./queue.js";

// Re-export validation functions that were previously exported from core
export { assertJobId, normalizeJobId, validateWorkspace, validateTestCommand, validatePermissionMode, assertExecutionPolicy, normalizeTaskContract } from "./validation.js";

// Re-export evidence functions that were previously exported from core
export { AUDIT_EVIDENCE_ARTIFACTS, evidenceHashes, completionEvidenceValid, parsePendingCompletion, worktreeSha256, structuredAuditRequested } from "./evidence.js";
export type { PendingCompletion } from "./evidence.js";
