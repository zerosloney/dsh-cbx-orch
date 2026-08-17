import { defineTool, type JsonValue } from "@deepseek-ai/dsh-tools";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { Context } from "@deepseek-ai/cordis";
import { approveJob } from "./approval.js";
import {
  listArtifacts,
  listJobs,
  readArtifact,
} from "./artifacts.js";
import type { JobState } from "./types.js";
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
import { bridgeCbxJob, type CbxBridgeResult } from "./jobs-bridge.js";
import { formatTaskList } from "./format.js";
import { forgetJobKeepWorktree, loadConfig, loadState, mergeConfig, purgeJob } from "./state.js";
import { WorkspacePolicy } from "./workspace-policy.js";

/** Plugin-level defaults that seed jobs when the tool call omits the field. */
export interface CbxDefaults {
  executor?: string;
  review?: boolean;
  isolated?: boolean;
  /** Reuse a host-owned policy when one is supplied; otherwise only cwd is allowed. */
  workspacePolicy?: WorkspacePolicy;
}

function jsonContent(value: unknown): ContentBlock[] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

/** 工具执行上下文的最小结构：只取 agent 会话的 cwd，避免引入 dsh-agent 类型依赖。 */
export interface SessionCwdContext {
  agent?: {
    session?: {
      header?: { cwd?: string };
    };
  };
}

/**
 * 默认工作区 = 当前 agent 会话的工作目录（目录委派时设定），回落 process.cwd()。
 * 显式传 workspace 参数时仍以参数为准（受白名单约束）。
 */
function sessionCwdOf(exec: SessionCwdContext | undefined): string | undefined {
  return exec?.agent?.session?.header?.cwd;
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

/** 工具文本输出上限：agent.log/test.log/result.json 可达数十 MB，全量回给 LLM 会撑爆上下文。 */
const MAX_TOOL_TEXT_CHARS = 64_000;

function clampText(text: string): string {
  if (text.length <= MAX_TOOL_TEXT_CHARS) return text;
  const head = Math.floor(MAX_TOOL_TEXT_CHARS * 0.7);
  const tail = Math.floor(MAX_TOOL_TEXT_CHARS * 0.2);
  return `${text.slice(0, head)}\n\n…[cbx: 输出共 ${text.length} 字符，已截断保留头尾]…\n\n${text.slice(-tail)}`;
}

/** JSON 工具输出的深截断：state/adaptiveRounds 里的超长字符串（error、retryReason 等）同样会爆上下文。 */
function clampJson(value: unknown): unknown {
  if (typeof value === "string")
    return value.length > 8_000
      ? `${value.slice(0, 8_000)}…(${value.length} chars)`
      : value;
  if (Array.isArray(value)) return value.map(clampJson);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        clampJson(item),
      ]),
    );
  return value;
}

/**
 * cbx 仪表盘相对路径。cbx-orch-web 把仪表盘挂在 harness webServer 的 /cbx 前缀
 * （见 src/web.ts CBX_MOUNT）；端口由 webServer 决定，工具层拿不到，UI 默认打开
 * 同源 3080 端口。带 workspace query 让仪表盘跳到当前工作区。
 */
function dashboardUrl(workspace: string | undefined): string | undefined {
  if (!workspace) return undefined;
  return `/cbx/?workspace=${encodeURIComponent(workspace)}`;
}

/** 把仪表盘链接作为附注追加到工具渲染输出。 */
function withDashboardFooter(text: string, workspace: string | undefined): string {
  const url = dashboardUrl(workspace);
  return url ? `${text}\n\n仪表盘：${url}` : text;
}

/**
 * 把会话桥注册结果格式化成一行提示，附到 cbx_run / cbx_continue 的工具渲染文本。
 * 让用户**看到为什么没接到会话任务总线**——原版静默吞错导致任务"消失"。
 */
function bridgeNote(result: CbxBridgeResult): string {
  if (result.id) {
    return `已注册为会话后台任务（harness job id: ${result.id}）；可用 job_output / job_wait / job_kill 跟踪进度。`;
  }
  switch (result.reason) {
    case "no-agent-context":
      return "未注册为会话后台任务（无 agent 上下文——非 chat 场景正常）。请用 cbx_status / cbx_logs 查看进度，或打开仪表盘。";
    case "no-jobs-service":
      return "未注册为会话后台任务（ctx.jobs 服务不可用——profile 未挂 dsh-jobs-local 或 agent preset 未挂 dsh-tool-jobs）。请用 cbx_status / cbx_logs 查看进度，或打开仪表盘。";
    case "registration-rejected":
      return `未注册为会话后台任务（jobs.start 被拒绝${result.detail ? `：${result.detail}` : ""}——并发上限或 controller 缺失）。请用 cbx_status / cbx_logs 查看进度，或打开仪表盘。`;
    default:
      return "未注册为会话后台任务。请用 cbx_status / cbx_logs 查看进度，或打开仪表盘。";
  }
}

/**
 * 把 cbx 状态对象格式化成可读短报告（chat UI 渲染）。
 * 与 jsonOutput() 不同：这里给 UI 看，state 全量仍是 JSON value 留给模型。
 */
function renderJobStatus(args: Record<string, unknown>, value: unknown): ContentBlock[] {
  const state = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const ws = typeof args.workspace === "string" ? args.workspace : undefined;
  const jobId = String(state.jobId ?? args.job_id ?? "—");
  const status = String(state.status ?? "—");
  const phase = typeof state.phase === "string" && state.phase ? state.phase : "—";
  const attempt = typeof state.attempt === "number" ? state.attempt : undefined;
  const stage = typeof state.stage === "string" && state.stage ? state.stage : undefined;
  const maxTurns = typeof state.configuredMaxTurns === "number" ? state.configuredMaxTurns : undefined;
  const executorInvocations = typeof state.executorInvocations === "number" ? state.executorInvocations : undefined;
  const updatedAt = typeof state.updatedAt === "string" ? state.updatedAt : undefined;
  const createdAt = typeof state.createdAt === "string" ? state.createdAt : undefined;
  const error = typeof state.error === "string" ? state.error : undefined;
  const reviewVerdict = typeof state.reviewVerdict === "string" ? state.reviewVerdict : undefined;

  const lines: string[] = [];
  lines.push(`cbx ${jobId}`);
  lines.push(`  status:   ${status}`);
  if (status === "running") lines.push(`  phase:    ${phase}`);
  if (stage) lines.push(`  stage:    ${stage}`);
  if (attempt !== undefined) {
    const turns = maxTurns !== undefined ? ` (maxTurns ${maxTurns})` : "";
    lines.push(`  attempt:  ${attempt}${turns}`);
  }
  if (typeof executorInvocations === "number") {
    lines.push(`  execs:    ${executorInvocations} 次调用`);
  }
  if (createdAt) lines.push(`  created:  ${createdAt}`);
  if (updatedAt) lines.push(`  updated:  ${updatedAt}`);
  if (reviewVerdict) lines.push(`  review:   ${reviewVerdict}`);
  if (error) lines.push(`  error:    ${error}`);
  return jsonContent(withDashboardFooter(lines.join("\n"), ws));
}

/** cbx_list 的可读渲染：任务清单表格 + 仪表盘链接；JSON value 仍是全量 job 列表。 */
function renderJobList(args: Record<string, unknown>, value: unknown): ContentBlock[] {
  const ws = typeof args.workspace === "string" ? args.workspace : undefined;
  const jobs = Array.isArray(value) ? value : [];
  return jsonContent(withDashboardFooter(formatTaskList(jobs as JobState[]), ws));
}

/** cbx_queue 的可读渲染：调度状态摘要 + 仪表盘链接。 */
function renderQueue(args: Record<string, unknown>, value: unknown): ContentBlock[] {
  const ws = typeof args.workspace === "string" ? args.workspace : undefined;
  const queue = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const maxConcurrent = typeof queue.maxConcurrent === "number" ? queue.maxConcurrent : "—";
  const paused = Boolean(queue.paused);
  const entries = Array.isArray(queue.entries) ? queue.entries : [];
  const lines: string[] = [];
  lines.push(`queue: ${paused ? "paused" : "running"}, maxConcurrent=${maxConcurrent}, entries=${entries.length}`);
  if (entries.length > 0) {
    lines.push("");
    lines.push("| Queue ID           | Job ID              | Status   | Priority | Reclaims |");
    lines.push("|--------------------|---------------------|----------|----------|----------|");
    for (const entry of entries) {
      const e = entry as Record<string, unknown>;
      const qid = String(e.queueId ?? "—");
      const jid = String(e.jobId ?? "—");
      const st = String(e.status ?? "—");
      const pri = typeof e.priority === "number" ? String(e.priority) : "0";
      const rec = typeof e.reclaimCount === "number" ? String(e.reclaimCount) : "0";
      lines.push(`| ${qid.padEnd(18)} | ${jid.padEnd(19)} | ${st.padEnd(8)} | ${pri.padEnd(8)} | ${rec.padEnd(8)} |`);
    }
  }
  return jsonContent(withDashboardFooter(lines.join("\n"), ws));
}

/**
 * 构造给 cbx_run / cbx_continue / cbx_watch 用的渲染器。
 * 把 bridge 结果 + 仪表盘链接附在 JSON value 之外，确保用户**看到**任务在前台的状态；
 * execute 返回的 `__taskList`（工作区任务清单）也直接渲染进会话，不再需要单独调 cbx_list。
 */
function runJobOutput(args: Record<string, unknown>, value: unknown): ContentBlock[] {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const ws = typeof args.workspace === "string" ? args.workspace : undefined;
  const bridge = (v.__bridge && typeof v.__bridge === "object" ? v.__bridge : {}) as CbxBridgeResult;
  const jobId = String(v.job_id ?? "—");
  const status = String(v.status ?? "queued");
  const lines: string[] = [];
  lines.push(`cbx ${jobId} ${status}`);
  lines.push(bridgeNote(bridge));
  // 任务清单直接显示在当前会话；列表来自 execute 落库后的实时快照。
  if (Array.isArray(v.__taskList)) {
    lines.push("");
    lines.push(`任务清单（${ws ?? "当前工作区"}）:`);
    lines.push(formatTaskList(v.__taskList as JobState[]));
  }
  return jsonContent(withDashboardFooter(lines.join("\n"), ws));
}

export function registerCbxTools(ctx: Context, defaults: CbxDefaults): void {
  const tools = ctx.tools;
  const workspacePolicy = defaults.workspacePolicy ?? new WorkspacePolicy();
  const workspaceOf = (input: string | undefined, exec?: SessionCwdContext): Promise<string> =>
    workspacePolicy.resolveWorkspace(input, sessionCwdOf(exec));
  // 桥注册失败时打 warning 到 ctx.logger('cbx')，让 "委派任务在前台看不到" 的根因可见。
  const bridgeLog = (message: string): void => {
    try {
      ctx.logger("cbx")?.warn(message);
    } catch {
      /* logger 服务缺位时不影响桥本身 */
    }
  };

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
    output: {
      schema: { type: "json" },
      render: runJobOutput,
    },
    async execute(args, exec) {
      const ws = await workspaceOf(args.workspace, exec);
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
      // 会话内可见：把委派注册为 harness 原生后台任务（kind=cbx，归属当前 agent）。
      // 当前会话随即能在 UI/工具中看到执行情况（job_output/job_kill/job_wait），
      // 完成后 tool-jobs 会把最终输出投递回会话。桥不可用时返回 reason，
      // 渲染层向用户明示**为什么没接到前台**——不再静默吞错。
      const bridge = bridgeCbxJob(ctx, {
        workspace: ws,
        jobId: created.jobId,
        task: args.task,
        agent: exec?.agent,
        logger: bridgeLog,
      });
      // 任务清单直接显示在当前会话：实时读取全量 job 列表附到返回值（渲染层输出表格）。
      const taskList = clampJson(await listJobs(ws));
      return toJson({
        job_id: created.jobId,
        status: "queued",
        __bridge: bridge,
        __taskList: taskList,
        ...(bridge.id !== undefined ? { jobId: bridge.id } : {}),
      });
    },
  }));

  tools.register(defineTool({
    name: "cbx_status",
    description: "Show the current state, stage, and attempts of one cbx job.",
    parameters: {
      job_id: { type: "string", required: true, description: "The cbx job id." },
      workspace: { type: "string", description: "Project directory holding the job." },
    },
    output: {
      schema: { type: "json" },
      render: renderJobStatus,
    },
    async execute(args, exec) {
      return toJson(clampJson(await loadState(await workspaceOf(args.workspace, exec), args.job_id)));
    },
  }));

  tools.register(defineTool({
    name: "cbx_list",
    description: "List all cbx jobs in a workspace (most recent first).",
    parameters: {
      workspace: { type: "string", description: "Project directory holding the jobs." },
    },
    output: {
      schema: { type: "json" },
      render: renderJobList,
    },
    async execute(args, exec) {
      return toJson(await listJobs(await workspaceOf(args.workspace, exec)));
    },
  }));

  tools.register(defineTool({
    name: "cbx_queue",
    description: "Inspect the cbx job queue state.",
    parameters: {
      workspace: { type: "string", description: "Project directory." },
    },
    output: {
      schema: { type: "json" },
      render: renderQueue,
    },
    async execute(args, exec) {
      return toJson(await listQueue(await workspaceOf(args.workspace, exec)));
    },
  }));

  tools.register(defineTool({
    name: "cbx_queue_pause",
    description: "Pause the cbx job queue (no new jobs start until resumed).",
    parameters: {
      workspace: { type: "string", description: "Project directory." },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      return toJson(await pauseQueue(await workspaceOf(args.workspace, exec)));
    },
  }));

  tools.register(defineTool({
    name: "cbx_queue_resume",
    description: "Resume the cbx job queue.",
    parameters: {
      workspace: { type: "string", description: "Project directory." },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      return toJson(await resumeQueue(await workspaceOf(args.workspace, exec)));
    },
  }));

  tools.register(defineTool({
    name: "cbx_dispatch",
    description: "Dispatch the queue: reclaim dead workers and start queued jobs up to maxConcurrent.",
    parameters: {
      workspace: { type: "string", description: "Project directory." },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      return toJson(await dispatchQueue(await workspaceOf(args.workspace, exec)));
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
    output: {
      schema: { type: "json" },
      render: runJobOutput,
    },
    async execute(args, exec) {
      const ws = await workspaceOf(args.workspace, exec);
      await startBackground(
        ws,
        args.job_id,
        args.message ?? "",
        0,
        undefined,
        args.refresh_baseline === true,
        args.extra_rounds === undefined ? 0 : Number(args.extra_rounds),
      );
      const bridge = bridgeCbxJob(ctx, {
        workspace: ws,
        jobId: args.job_id,
        task: args.message ?? "continue",
        agent: exec?.agent,
        logger: bridgeLog,
      });
      const taskList = clampJson(await listJobs(ws));
      return toJson({
        job_id: args.job_id,
        status: "queued",
        __bridge: bridge,
        __taskList: taskList,
        ...(bridge.id !== undefined ? { jobId: bridge.id } : {}),
      });
    },
  }));

  tools.register(defineTool({
    name: "cbx_watch",
    description:
      "Poll a cbx job until it reaches terminal state (done/failed/review_failed/cancelled/needs_fix) and return the final summary. Streams progress as additional chat context so the user sees status changes during the wait. Use this when no session job id was registered and you want live progress in the chat.",
    parameters: {
      job_id: { type: "string", required: true, description: "The cbx job id." },
      workspace: { type: "string", description: "Project directory holding the job." },
      poll_ms: { type: "integer", description: "Status poll interval in ms (default 2000)." },
      timeout_ms: { type: "integer", description: "Max wait in ms (default 600000 = 10 min)." },
    },
    output: {
      schema: { type: "json" },
      render: renderJobStatus,
    },
    async execute(args, exec) {
      const ws = await workspaceOf(args.workspace, exec);
      const jobId = args.job_id;
      const pollMs = args.poll_ms === undefined ? 2000 : Math.max(250, Number(args.poll_ms));
      const timeoutMs = args.timeout_ms === undefined ? 600_000 : Math.max(1_000, Number(args.timeout_ms));
      const signal = exec?.signal;
      const start = Date.now();
      let lastStatus: string | undefined;
      // 简单轮询：state.json 是镜像，SQLite 是权威；loadState 内部统一读 SQLite。
      while (true) {
        if (signal?.aborted) throw signal.reason;
        if (Date.now() - start > timeoutMs) {
          throw new Error(
            `cbx_watch: 等待 ${jobId} 超过 ${timeoutMs}ms 上限（最后状态：${lastStatus ?? "未知"}）。`,
          );
        }
        let state;
        try {
          state = await loadState(ws, jobId);
        } catch (error) {
          throw new Error(
            `cbx_watch: 读取 job 状态失败 — ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const status = String(state.status ?? "");
        if (status !== lastStatus) {
          lastStatus = status;
        }
        const TERMINAL = new Set(["done", "failed", "review_failed", "cancelled", "needs_fix"]);
        if (TERMINAL.has(status)) {
          return toJson(clampJson(state));
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
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
    async execute(args, exec) {
      return toJson(clampJson(await cancelJob(await workspaceOf(args.workspace, exec), args.job_id)));
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
    async execute(args, exec) {
      return toJson(await retryQueueJob(
        await workspaceOf(args.workspace, exec),
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
    async execute(args, exec) {
      // before_run 审批通过即原子重入队（approval 内完成 + 立即 dispatch），无需再补启动。
      const state = await approveJob(await workspaceOf(args.workspace, exec), args.job_id);
      return toJson(clampJson(state));
    },
  }));

  tools.register(defineTool({
    name: "cbx_result",
    description: "Read a job's result.json: changed files, handback, stages, test/acceptance summary, baseline, human gate.",
    parameters: {
      job_id: { type: "string", required: true, description: "The cbx job id." },
      workspace: { type: "string", description: "Project directory holding the job." },
    },
    output: { schema: { type: "string" }, render: (_a, v: string) => jsonContent(v) },
    async execute(args, exec) {
      return clampText(await readArtifact(await workspaceOf(args.workspace, exec), args.job_id, "result.json"));
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
    async execute(args, exec) {
      return clampText(await readArtifact(await workspaceOf(args.workspace, exec), args.job_id, args.artifact));
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
    async execute(args, exec) {
      return toJson(await listArtifacts(await workspaceOf(args.workspace, exec), args.job_id));
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
    async execute(args, exec) {
      return toJson(await readAgentLogIncremental(
        await workspaceOf(args.workspace, exec),
        args.job_id,
        args.since === undefined ? 0 : Number(args.since),
      ));
    },
  }));

  tools.register(defineTool({
    name: "cbx_health",
    description: "Queue depth, job status counts, failures/retries, pending deliveries, dead letters (no job bodies). Read-only by default; set prune=true to also apply retention cleanup.",
    parameters: {
      workspace: { type: "string", description: "Project directory." },
      prune: { type: "boolean", description: "Also run retention cleanup (deletes terminal jobs older than governance.retentionDays). Default false (read-only)." },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      return toJson(await health(await workspaceOf(args.workspace, exec), { prune: args.prune === true }));
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
    async execute(args, exec) {
      const ws = await workspaceOf(args.workspace, exec);
      if (args.purge === true) {
        return toJson(await purgeJob(ws, args.job_id, "tool:purge"));
      }
      return toJson(await forgetJobKeepWorktree(ws, args.job_id, "tool:forget"));
    },
  }));

  tools.register(defineTool({
    name: "cbx_list_workspaces",
    description: "List jobs in an explicitly authorized workspace; does not discover child directories.",
    parameters: {
      root: { type: "string", required: true, description: "Authorized workspace to list." },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const root = await workspaceOf(args.root, exec);
      const roots = (await workspacePolicy.listAllowedWorkspaces(sessionCwdOf(exec)))
        .filter((workspace) => workspace === root);
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
    async execute(args, exec) {
      const signal = exec?.signal;
      signal?.throwIfAborted();
      const workspace = await workspaceOf(args.workspace, exec);
      signal?.throwIfAborted();
      return toJson(await runReviewGate(workspace, {
        executor: args.executor,
        reviewRules: args.review_rules,
        signal,
      }));
    },
  }));
}
