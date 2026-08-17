import type { AdaptiveOptions } from "./adaptive-manager.js";
import type {
  TaskStage as TaskStageType,
  TaskContract as TaskContractType,
} from "./validation.js";
import type { RuntimeConfig } from "./storage.js";
import type { ContextBudget } from "./context-pack.js";

export type Json = Record<string, unknown>;
export type JobStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "needs_fix"
  | "review_failed"
  | "failed"
  | "done"
  | "cancelled";

/** 终态判定：任务不再自动推进的状态（needs_fix 可经 cbx_continue 续跑，故不属于终态）。
 *  timeline 的 finishedAt 与"任务是否仍在推进"以此为准。 */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "done",
  "failed",
  "review_failed",
  "cancelled",
]);

export type CbxConfig = RuntimeConfig;

export interface JobContext {
  appVersion: string;
  jobId: string;
  workspace: string;
  createdAt: string;
  testCommand?: string;
  reviewRequested: boolean;
  isolated: boolean;
  permissionMode: string;
  maxTurns: number;
  timeoutMs: number;
  maxRetries: number;
  executionRetries: number;
  fixRetries: number;
  keepWorktree: boolean;
  reviewRules?: string;
  approvalBeforeRun: boolean;
  approvalBeforeComplete: boolean;
  autoBranch: boolean;
  autoCommit: boolean;
  commitMessage: string;
  executor: string;
  reviewExecutor?: string;
  taskContract?: TaskContractType;
  baseCommit?: string;
  baseBranch?: string;
  baseDirty?: boolean;
  baseStatus?: string;
  dirtyFingerprint?: string;
  /** 脏指纹算法版本：2 = 仅跟踪文件（消除未跟踪 scratch 的漂移误报）；缺省 = v1。 */
  dirtyFingerprintVersion?: number;
  trustMode: "trusted" | "untrusted";
  gitRoot?: string;
  adaptive?: AdaptiveOptions;
  dependencyGuard?: boolean;
  contextBudget?: ContextBudget;
}

export type TaskStage = TaskStageType;
export type TaskContract = TaskContractType;

export interface JobState {
  jobId: string;
  status: JobStatus;
  phase: string;
  workspace: string;
  jobDir: string;
  createdAt: string;
  updatedAt: string;
  attempt: number;
  // --- typed optional fields (reduces `as` casts) ---
  error?: string;
  retryReason?: string | null;
  approved?: boolean;
  approvalRequired?: boolean;
  humanGate?: unknown;
  pendingCompletion?: unknown;
  completionApproved?: boolean;
  approvedAt?: string;
  cancelledAt?: string;
  gitCommit?: string | null;
  baselineDrift?: boolean;
  dirtyBaselineDrift?: boolean;
  currentCommit?: string | null;
  workdir?: string;
  worktreeCleaned?: boolean;
  cleanupError?: string;
  adaptiveRound?: number;
  adaptiveRounds?: Json[];
  stages?: StageReport[];
  managerDoneStreak?: number;
  stageRetries?: Record<string, { execution: number; fix: number }>;
  /** 累计执行器调用次数（含 stage / review / adaptive manager 全部角色）。P0-2 引入。 */
  executorInvocations?: number;
  /** per-stage 调用次数，key 为 stageIndex。仅 stage executor 计入；reviewer/manager 不计。 */
  stageInvocations?: Record<string, number>;
  /** 创建时配置的 maxTurns（per stage 默认继承 context.maxTurns）。P0-2 引入，便于 UI/result 暴露实际预算。 */
  configuredMaxTurns?: number;
  stage?: string;
  executorExitCode?: number;
  testExitCode?: number;
  reviewVerdict?: string | null;
  timedOut?: boolean;
  audit?: unknown;
  verifiedProgress?: unknown;
  auditError?: string | null;
  blockingQuestions?: string[];
  continuationInstructions?: string | null;
  failureTracker?: unknown;
  stageDeps?: Record<string, string[]>;
  referenceHashes?: Record<string, string>;
  depHashes?: Record<string, string>;
  submittedAt?: string;
  [key: string]: unknown;
}

export interface StageReport {
  name: string;
  executor: string;
  exitCode: number;
  testExitCode: number | null;
  reviewVerdict: string | null;
  attempts: number;
  /** 该 stage 实际配置传入的 maxTurns（per-stage 可独立覆盖）。P0-2 引入。 */
  configuredMaxTurns?: number;
}

export interface StageOutcome {
  terminal: boolean;
  state: JobState;
  report: StageReport;
  attempt: number;
  attemptExtra: string;
}

export interface Understanding {
  interpretedGoal?: string;
  plannedFiles?: string[];
  acceptanceCriteria?: string[];
  assumptions?: string[];
  blockingQuestions?: string[];
}

export interface BaselineDrift {
  commitDrift: boolean;
  dirtyDrift: boolean;
  currentBaseline?: import("./git-ops.js").GitBaseline;
  currentDirtyFingerprint?: string;
}
