import path from "node:path";
import { defineTool, type JsonValue } from "@deepseek-ai/dsh-tools";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { Context } from "@deepseek-ai/cordis";
import { approveJob } from "./approval.js";
import {
  discoverWorkspaces,
  listArtifacts,
  listJobs,
  readArtifact,
} from "./artifacts.js";
import { cancelJob, startBackground } from "./lifecycle.js";
import { createJob } from "./jobs.js";
import {
  dispatchQueue,
  health,
  listQueue,
  pauseQueue,
  resumeQueue,
  retryQueueJob,
} from "./queue-api.js";
import { runReviewGate } from "./review-gate.js";
import { readAgentLogIncremental } from "./ui.js";
import { forgetJobKeepWorktree, loadConfig, loadState, mergeConfig, purgeJob } from "./state.js";

/** Plugin-level defaults that seed jobs when the tool call omits the field. */
export interface CbxDefaults {
  executor?: string;
  review?: boolean;
  isolated?: boolean;
}

function jsonContent(value: unknown): ContentBlock[] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

/** Engine types (some `unknown` fields, no index signature) are real JSON at runtime. */
const toJson = (value: unknown): JsonValue => value as unknown as JsonValue;

function jsonOutput() {
  return {
    schema: { type: "json" as const },
    render: (_args: Record<string, unknown>, value: unknown): ContentBlock[] =>
      jsonContent(value),
  };
}

/** Resolve the target workspace: explicit arg wins, else the invoking directory. */
function workspaceOf(input: string | undefined): string {
  return path.resolve(input ?? process.cwd());
}

export function registerCbxTools(ctx: Context, defaults: CbxDefaults): void {
  const tools = ctx.tools;

  tools.register(defineTool({
    name: "cbx_run",
    description:
      "Create and enqueue a durable cbx job: dispatch a task to a coding-agent CLI (codebuddy/opencode/omp/cline/qwen) in an isolated git worktree, run the test command, review, and persist all state/artifacts. Returns the job id.",
    parameters: {
      task: { type: "string", required: true, description: "The task to delegate to the executor." },
      workspace: { type: "string", description: "Target project directory. Defaults to the invoking directory." },
      executor: { type: "string", description: "Executor: codebuddy / opencode / omp / cline / qwen, or a plugin path." },
      test: { type: "string", description: "Test command run after the executor finishes." },
      review: { type: "boolean", description: "Run an independent review phase after tests pass." },
      isolated: { type: "boolean", description: "Run in an isolated git worktree." },
      timeout_ms: { type: "integer", description: "Per-execution timeout in ms." },
      max_retries: { type: "integer", description: "Automatic retry budget." },
      max_turns: { type: "integer", description: "Executor turn budget." },
      permission_mode: { type: "string", description: "default / acceptEdits / auto / dontAsk." },
      approval_before_run: { type: "boolean", description: "Stop for approval before starting the executor." },
      approval_before_complete: { type: "boolean", description: "Stop for approval before landing done." },
      dependency_guard: { type: "boolean", description: "Lockfile hash guard." },
      keep_worktree: { type: "boolean", description: "Keep the isolated worktree on completion." },
      review_rules: { type: "string", description: "Review focus instructions." },
      review_executor: { type: "string", description: "Executor for the review phase (defaults to executor)." },
    },
    output: jsonOutput(),
    async execute(args) {
      const ws = workspaceOf(args.workspace);
      const config = await loadConfig(ws);
      const merged = mergeConfig(config, {
        testCommand: args.test,
        review: args.review ?? defaults.review,
        isolated: args.isolated ?? defaults.isolated,
        timeoutMs: args.timeout_ms === undefined ? undefined : Number(args.timeout_ms),
        maxRetries: args.max_retries === undefined ? undefined : Number(args.max_retries),
        maxTurns: args.max_turns === undefined ? undefined : Number(args.max_turns),
        permissionMode: args.permission_mode,
        approvalBeforeRun: args.approval_before_run,
        approvalBeforeComplete: args.approval_before_complete,
        dependencyGuard: args.dependency_guard,
        keepWorktree: args.keep_worktree,
        executor: args.executor ?? defaults.executor,
        reviewExecutor: args.review_executor,
      });
      const created = await createJob({
        workspace: ws,
        task: args.task,
        testCommand: merged.testCommand,
        review: merged.review,
        isolated: merged.isolated,
        permissionMode: merged.permissionMode,
        maxTurns: merged.maxTurns,
        timeoutMs: merged.timeoutMs,
        maxRetries: merged.maxRetries,
        keepWorktree: merged.keepWorktree,
        reviewRules: args.review_rules ?? config.reviewRules,
        approvalBeforeRun: merged.approvalBeforeRun,
        approvalBeforeComplete: merged.approvalBeforeComplete,
        autoBranch: merged.autoBranch,
        autoCommit: merged.autoCommit,
        commitMessage: merged.commitMessage,
        executor: merged.executor,
        reviewExecutor: merged.reviewExecutor,
        adaptive: merged.adaptive,
        trustMode: merged.trustMode,
        dependencyGuard: merged.dependencyGuard,
      });
      await startBackground(ws, created.jobId, "", 0);
      return { job_id: created.jobId, status: "queued" };
    },
  }));

  tools.register(defineTool({
    name: "cbx_status",
    description: "Show the current state, stage, and attempts of one cbx job.",
    parameters: {
      job_id: { type: "string", required: true, description: "The cbx job id." },
      workspace: { type: "string", description: "Project directory holding the job." },
    },
    output: jsonOutput(),
    async execute(args) {
      return toJson(await loadState(workspaceOf(args.workspace), args.job_id));
    },
  }));

  tools.register(defineTool({
    name: "cbx_list",
    description: "List all cbx jobs in a workspace (most recent first).",
    parameters: {
      workspace: { type: "string", description: "Project directory holding the jobs." },
    },
    output: jsonOutput(),
    async execute(args) {
      return toJson(await listJobs(workspaceOf(args.workspace)));
    },
  }));

  tools.register(defineTool({
    name: "cbx_queue",
    description: "Inspect the cbx job queue state.",
    parameters: {
      workspace: { type: "string", description: "Project directory." },
    },
    output: jsonOutput(),
    async execute(args) {
      return toJson(await listQueue(workspaceOf(args.workspace)));
    },
  }));

  tools.register(defineTool({
    name: "cbx_queue_pause",
    description: "Pause the cbx job queue (no new jobs start until resumed).",
    parameters: {
      workspace: { type: "string", description: "Project directory." },
    },
    output: jsonOutput(),
    async execute(args) {
      return toJson(await pauseQueue(workspaceOf(args.workspace)));
    },
  }));

  tools.register(defineTool({
    name: "cbx_queue_resume",
    description: "Resume the cbx job queue.",
    parameters: {
      workspace: { type: "string", description: "Project directory." },
    },
    output: jsonOutput(),
    async execute(args) {
      return toJson(await resumeQueue(workspaceOf(args.workspace)));
    },
  }));

  tools.register(defineTool({
    name: "cbx_dispatch",
    description: "Dispatch the queue: reclaim dead workers and start queued jobs up to maxConcurrent.",
    parameters: {
      workspace: { type: "string", description: "Project directory." },
    },
    output: jsonOutput(),
    async execute(args) {
      return toJson(await dispatchQueue(workspaceOf(args.workspace)));
    },
  }));

  tools.register(defineTool({
    name: "cbx_continue",
    description: "Re-enqueue a job stuck in needs_fix/review_failed with follow-up instructions (e.g. address review.md).",
    parameters: {
      job_id: { type: "string", required: true, description: "The cbx job id." },
      message: { type: "string", description: "Follow-up instructions for the executor." },
      workspace: { type: "string", description: "Project directory." },
      extra_rounds: { type: "integer", description: "Extra adaptive rounds when waiting at max_rounds." },
      refresh_baseline: { type: "boolean", description: "Refresh the baseline before continuing." },
    },
    output: jsonOutput(),
    async execute(args) {
      await startBackground(
        workspaceOf(args.workspace),
        args.job_id,
        args.message ?? "",
        0,
        undefined,
        args.refresh_baseline === true,
        args.extra_rounds === undefined ? 0 : Number(args.extra_rounds),
      );
      return { job_id: args.job_id, status: "queued" };
    },
  }));

  tools.register(defineTool({
    name: "cbx_cancel",
    description: "Cancel a running or queued cbx job and terminate its executor process tree.",
    parameters: {
      job_id: { type: "string", required: true, description: "The cbx job id." },
      workspace: { type: "string", description: "Project directory." },
    },
    output: jsonOutput(),
    async execute(args) {
      return toJson(await cancelJob(workspaceOf(args.workspace), args.job_id));
    },
  }));

  tools.register(defineTool({
    name: "cbx_retry",
    description: "Re-enqueue a failed cbx job for another attempt.",
    parameters: {
      job_id: { type: "string", required: true, description: "The cbx job id." },
      workspace: { type: "string", description: "Project directory." },
      priority: { type: "integer", description: "Queue priority (higher first)." },
    },
    output: jsonOutput(),
    async execute(args) {
      return toJson(await retryQueueJob(
        workspaceOf(args.workspace),
        args.job_id,
        args.priority === undefined ? 0 : Number(args.priority),
      ));
    },
  }));

  tools.register(defineTool({
    name: "cbx_approve",
    description: "Approve a job waiting at an approval gate (before_run/before_complete).",
    parameters: {
      job_id: { type: "string", required: true, description: "The cbx job id." },
      workspace: { type: "string", description: "Project directory." },
    },
    output: jsonOutput(),
    async execute(args) {
      const ws = workspaceOf(args.workspace);
      const state = await approveJob(ws, args.job_id);
      if (state.status === "queued") await startBackground(ws, args.job_id);
      return toJson(state);
    },
  }));

  tools.register(defineTool({
    name: "cbx_result",
    description: "Read a job's result.json: changed files, handback, stages, test/acceptance summary, baseline, human gate.",
    parameters: {
      job_id: { type: "string", required: true, description: "The cbx job id." },
      workspace: { type: "string", description: "Project directory." },
    },
    output: { schema: { type: "string" }, render: (_a, v: string) => jsonContent(v) },
    async execute(args) {
      return await readArtifact(workspaceOf(args.workspace), args.job_id, "result.json");
    },
  }));

  tools.register(defineTool({
    name: "cbx_artifact",
    description: "Read a job artifact: handback.md, complete.patch, test.log, review.md, diff.patch, state.json, etc.",
    parameters: {
      job_id: { type: "string", required: true, description: "The cbx job id." },
      artifact: { type: "string", required: true, description: "Artifact name, e.g. handback.md." },
      workspace: { type: "string", description: "Project directory." },
    },
    output: { schema: { type: "string" }, render: (_a, v: string) => jsonContent(v) },
    async execute(args) {
      return await readArtifact(workspaceOf(args.workspace), args.job_id, args.artifact);
    },
  }));

  tools.register(defineTool({
    name: "cbx_artifacts",
    description: "List the artifact files available for a cbx job.",
    parameters: {
      job_id: { type: "string", required: true, description: "The cbx job id." },
      workspace: { type: "string", description: "Project directory." },
    },
    output: jsonOutput(),
    async execute(args) {
      return toJson(await listArtifacts(workspaceOf(args.workspace), args.job_id));
    },
  }));

  tools.register(defineTool({
    name: "cbx_logs",
    description: "Read a job's executor agent.log incrementally.",
    parameters: {
      job_id: { type: "string", required: true, description: "The cbx job id." },
      workspace: { type: "string", description: "Project directory." },
      since: { type: "integer", description: "Byte offset to resume from." },
    },
    output: jsonOutput(),
    async execute(args) {
      return toJson(await readAgentLogIncremental(
        workspaceOf(args.workspace),
        args.job_id,
        args.since === undefined ? 0 : Number(args.since),
      ));
    },
  }));

  tools.register(defineTool({
    name: "cbx_health",
    description: "Queue depth, job status counts, failures/retries, pending deliveries, dead letters (no job bodies).",
    parameters: {
      workspace: { type: "string", description: "Project directory." },
    },
    output: jsonOutput(),
    async execute(args) {
      return toJson(await health(workspaceOf(args.workspace)));
    },
  }));

  tools.register(defineTool({
    name: "cbx_clean",
    description: "Forget a job and optionally purge its git worktree (forget keeps the worktree; purge removes it).",
    parameters: {
      job_id: { type: "string", required: true, description: "The cbx job id." },
      workspace: { type: "string", description: "Project directory." },
      purge: { type: "boolean", description: "Also remove the isolated worktree (true = purge)." },
    },
    output: jsonOutput(),
    async execute(args) {
      const ws = workspaceOf(args.workspace);
      if (args.purge === true) {
        return toJson(await purgeJob(ws, args.job_id, "tool:purge"));
      }
      return toJson(await forgetJobKeepWorktree(ws, args.job_id, "tool:forget"));
    },
  }));

  tools.register(defineTool({
    name: "cbx_list_workspaces",
    description: "Scan a root directory for subdirectories containing a .cbx/ store and list their jobs.",
    parameters: {
      root: { type: "string", required: true, description: "Directory to scan one level deep." },
    },
    output: jsonOutput(),
    async execute(args) {
      const roots = await discoverWorkspaces(args.root);
      const jobs = [];
      for (const ws of roots) {
        jobs.push({ workspace: ws, jobs: await listJobs(ws) });
      }
      return toJson({ workspaces: roots, jobs });
    },
  }));

  tools.register(defineTool({
    name: "cbx_review_gate",
    description: "Run an independent review of the workspace's uncommitted changes; the review.md summarizes findings.",
    parameters: {
      workspace: { type: "string", description: "Project directory." },
      executor: { type: "string", description: "Review executor (defaults to configured executor)." },
      review_rules: { type: "string", description: "Review focus instructions." },
    },
    output: jsonOutput(),
    async execute(args) {
      return toJson(await runReviewGate(workspaceOf(args.workspace), {
        executor: args.executor,
        reviewRules: args.review_rules,
      }));
    },
  }));
}
