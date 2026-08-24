import { defineTool, type JsonValue } from "@deepseek-ai/dsh-tools";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { Context } from "@deepseek-ai/cordis";
import { approveJob } from "./approval.js";
import {
  listArtifacts,
  listJobs,
  listJobsWithAudit,
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
import { readAgentLogIncremental } from "./log-tail.js";
import { bridgeCbxJob, tailAgentLog, type CbxBridgeResult } from "./jobs-bridge.js";
import { publishCbxFacade, type CbxFacadeResult } from "./subagent-facade.js";
import {
  deriveRequirements,
  noExecutorError,
  routeExecutor,
  type ExecutorRequirements,
  type ExecutorStrategy,
  type RouteDecision,
} from "./executor-router.js";
import { loadHealth } from "./executor-health.js";
import { buildTierCatalog } from "./executor-catalog.js";
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  abortIdempotentCreate,
  beginIdempotentCreate,
  commitIdempotentCreate,
  hashIdempotentRequest,
} from "./idempotency.js";
import { probeAllExecutors, resolveExecutor } from "./executors/builtin.js";
import { formatTaskList } from "./format.js";
import { forgetJobKeepWorktree, jobDir, loadConfig, loadState, mergeConfig, purgeJob } from "./state.js";
import { verifyJobAudit } from "./storage.js";
import { buildSessionMessage, progressLine } from "./session-message.js";
import { WorkspacePolicy } from "./workspace-policy.js";

/** Plugin-level defaults that seed jobs when the tool call omits the field. */
export interface CbxDefaults {
  executor?: string;
  review?: boolean;
  isolated?: boolean;
  /** 隔离任务携带未提交改动（插件配置默认；工具参数 carry_dirty / .cbx.json 覆盖）。 */
  carryDirty?: boolean;
  /** Reuse a host-owned policy when one is supplied; otherwise only cwd is allowed. */
  workspacePolicy?: WorkspacePolicy;
}

function jsonContent(value: unknown): ContentBlock[] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

/** executor_requirements 的有效键：拼错的字段必须被显式拒绝/告警，不能静默忽略后按更弱需求路由。 */
const KNOWN_EXECUTOR_REQUIREMENT_KEYS: ReadonlySet<string> = new Set([
  "autoApprove",
  "planMode",
  "sandbox",
  "headless",
  "maxTurnsSupport",
  "streaming",
  "exclude",
]);

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

/** Engine types (some `unknown` fields, no index signature) are real JSON at runtime.
 *  统一经过 clampJson：剔除 undefined / 非有限数，保证工具返回值是无损 JSON
 *  （harness 会拒绝任何无法 JSON 无损往返的值，曾导致 cbx_run / cbx_executors 等报错）。 */
const toJson = (value: unknown): JsonValue => clampJson(value) as unknown as JsonValue;

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
  if (value && typeof value === "object") {
    // 跳过 undefined / NaN / ±Infinity：这些值无法无损 JSON 往返（JSON.stringify
    // 会丢成 null 或直接丢弃键），harness 工具返回值校验会因此拒绝整个输出。
    // 集中在此剔除，避免每个工具逐个 `?? null` 补丁。
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      if (typeof item === "number" && !Number.isFinite(item)) continue;
      out[key] = clampJson(item);
    }
    return out;
  }
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
  const text = buildSessionMessage({
    jobId: String(state.jobId ?? args.job_id ?? "—"),
    status: String(state.status ?? "—"),
    phase: typeof state.phase === "string" && state.phase ? state.phase : undefined,
    attempt: typeof state.attempt === "number" ? state.attempt : undefined,
    executor: typeof state.__executor === "string" ? state.__executor : undefined,
    error: typeof state.error === "string" ? state.error : undefined,
    reviewVerdict: typeof state.reviewVerdict === "string" ? state.reviewVerdict : undefined,
    changedFilesCount: typeof state.__changedFiles === "number" ? state.__changedFiles : undefined,
    jobDir: typeof state.__jobDir === "string" ? state.__jobDir : undefined,
    statusEvents: Array.isArray(state.status_events) ? (state.status_events as string[]) : undefined,
  });
  return jsonContent(withDashboardFooter(text, ws));
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

/** 把能力对象压成短标签（仅列出为 true 的能力）。 */
function capSummary(caps?: Record<string, unknown>): string {
  if (!caps) return "—";
  const map: Array<[string, string]> = [
    ["autoApprove", "auto"],
    ["planMode", "plan"],
    ["sandbox", "sbx"],
    ["headless", "headless"],
    ["maxTurnsSupport", "turns"],
    ["streaming", "stream"],
  ];
  const on = map.filter(([k]) => caps[k] === true).map(([, short]) => short);
  return on.length ? on.join(",") : "—";
}

/** 健康度摘要：successes/failures，连续失败标 !n，附最近延迟。 */
function healthSummary(h?: Record<string, unknown>): string {
  if (!h) return "—";
  const s = Number(h.successes ?? 0);
  const f = Number(h.failures ?? 0);
  const cf = Number(h.consecutiveFailures ?? 0);
  const lat = h.lastLatencyMs != null ? ` ${Math.round(Number(h.lastLatencyMs))}ms` : "";
  const flag = cf > 0 ? `!${cf}` : "";
  return `${s}/${f}${flag}${lat}`;
}

/** cbx_executors 的可读渲染：本机 agent CLI 探测表格（含能力/档位出处/健康度）+ 覆盖告警。 */
function renderExecutors(_args: Record<string, unknown>, value: unknown): ContentBlock[] {
  const v = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const probes = Array.isArray(v.executors) ? v.executors : [];
  const lines: string[] = [];
  lines.push("本机编码 agent CLI（cbx 执行器探测）:");
  lines.push("");
  lines.push("| Executor | Avail | Source | Capabilities | Cost/Spd(出处) | Health(s/f/样本) | Command |");
  lines.push("|----------|-------|--------|--------------|----------------|------------------|---------|");
  for (const probe of probes) {
    const p = (probe && typeof probe === "object" ? probe : {}) as Record<string, unknown>;
    const tiers = (p.tiers ?? null) as Record<string, unknown> | null;
    const costSrc = String(tiers?.costSource ?? "—");
    const spdSrc = String(tiers?.speedSource ?? "—");
    const samples = tiers && typeof tiers.samples === "number" ? tiers.samples : "—";
    lines.push(
      `| ${String(p.name ?? "—").padEnd(8)} | ${String(p.available ? "yes" : "no").padEnd(5)} | ${String(p.source ?? "—").padEnd(6)} | ${String(capSummary(p.capabilities as Record<string, unknown>)).padEnd(12)} | ${String(`${p.costTier ?? "—"}/${p.speedTier ?? "—"} (${costSrc}/${spdSrc}, n=${samples})`).padEnd(14)} | ${String(healthSummary(p.health as Record<string, unknown>)).padEnd(16)} | ${String(p.command ?? "—")} |`,
    );
  }
  const tierWarnings = Array.isArray(v.tierWarnings) ? (v.tierWarnings as string[]) : [];
  if (tierWarnings.length > 0) {
    lines.push("");
    for (const warning of tierWarnings) lines.push(`⚠ ${warning}`);
  }
  lines.push("");
  lines.push("cbx_run 未指定 executor 时按策略路由（先过滤不满足需求的执行器，再打分选最优）；显式指定但未安装会自动回退并注明。速度/成本档出处：measured=实测校准、configured=人工覆盖、declared=声明估值。");
  return jsonContent(lines.join("\n"));
}

/** cbx_watch 的可读渲染：状态迁移 + 处理消息（agent.log 尾部）+ 仪表盘链接。 */
function renderWatchReport(args: Record<string, unknown>, value: unknown): ContentBlock[] {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const ws = typeof args.workspace === "string" ? args.workspace : undefined;
  const state = (v.state && typeof v.state === "object" ? v.state : {}) as Record<string, unknown>;
  const text = buildSessionMessage({
    jobId: String(state.jobId ?? args.job_id ?? "—"),
    status: String(state.status ?? "—"),
    phase: typeof state.phase === "string" && state.phase ? state.phase : undefined,
    attempt: typeof state.attempt === "number" ? state.attempt : undefined,
    error: typeof state.error === "string" ? state.error : undefined,
    reviewVerdict: typeof state.reviewVerdict === "string" ? state.reviewVerdict : undefined,
    jobDir: typeof state.__jobDir === "string" ? state.__jobDir : undefined,
    statusEvents: Array.isArray(v.status_events) ? (v.status_events as string[]) : undefined,
    logTail: typeof v.log_tail === "string" ? v.log_tail : undefined,
    logChars: typeof v.log_chars === "number" ? v.log_chars : undefined,
  });
  return jsonContent(withDashboardFooter(text, ws));
}

/**
 * 把前台子代理外观层结果格式化成一行提示，附到 cbx_run / cbx_continue 的渲染文本。
 * 成功时告诉用户去「任务管理」页的子代理树（前台）查看；失败时说明为什么没接到前台。
 */
function facadeNote(result: CbxFacadeResult): string {
  if (result.sessionId) {
    const extra = result.existing ? "（复用既有前台镜像）" : "";
    return `已在前台子代理区显示（子代理会话 ${result.sessionId}${extra}；点击卡片可实时查看执行输出）。`;
  }
  switch (result.reason) {
    case "no-agent-context":
      return "未在前台子代理区显示（无 agent 上下文——命令行/定时调用正常）。";
    case "no-sessions-service":
      return "未在前台子代理区显示（ctx.sessions 服务不可用——profile 未挂 dsh-session）。";
    case "registration-rejected":
      return `未在前台子代理区显示（会话创建被拒${result.detail ? `：${result.detail}` : ""}）。`;
    default:
      return "未在前台子代理区显示。";
  }
}

/**
 * 构造给 cbx_run / cbx_continue 用的渲染器。
 * 把 bridge 结果 + 路由决策 + 仪表盘链接附在 JSON value 之外，确保用户**看到**任务在前台的状态；
 * execute 返回的 `__taskList`（工作区任务清单）也直接渲染进会话，不再需要单独调 cbx_list。
 */
function runJobOutput(args: Record<string, unknown>, value: unknown): ContentBlock[] {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const ws = typeof args.workspace === "string" ? args.workspace : undefined;
  const bridge = (v.__bridge && typeof v.__bridge === "object" ? v.__bridge : {}) as CbxBridgeResult;
  const facade = (v.__facade && typeof v.__facade === "object" ? v.__facade : {}) as CbxFacadeResult;
  const router = (v.__router && typeof v.__router === "object" ? v.__router : {}) as RouteDecision;
  const text = buildSessionMessage({
    jobId: String(v.job_id ?? "—"),
    status: String(v.status ?? "queued"),
    router,
    bridgeNote: bridgeNote(bridge),
    facadeNote: facadeNote(facade),
    taskList: Array.isArray(v.__taskList) ? (v.__taskList as JobState[]) : undefined,
    jobDir: typeof v.__jobDir === "string" ? v.__jobDir : undefined,
  });
  // 幂等命中：显式告知没有重复创建，避免调用方误以为新任务已入队。
  const body = v.deduplicated === true
    ? `幂等键命中（deduplicated=true）：未创建新任务，返回既有任务。需要重跑请用 cbx_retry。\n\n${text}`
    : text;
  return jsonContent(withDashboardFooter(body, ws));
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
      executor: { type: "string", description: "Executor: codebuddy / opencode / omp / cline / qwen, a plugin path, or \"auto\" (default: pick the first installed CLI, falling back automatically when the requested one is missing)." },
      executor_preference: { type: "array", items: { type: "string" }, description: "Router preference order for auto selection/fallback (builtin names or aliases; unknown entries ignored)." },
      executor_requirements: { type: "object", additionalProperties: false, properties: { autoApprove: { type: "boolean" }, planMode: { type: "boolean" }, sandbox: { type: "boolean" }, headless: { type: "boolean" }, maxTurnsSupport: { type: "boolean" }, streaming: { type: "boolean" }, exclude: { type: "array", items: { type: "string" } } }, description: "Capabilities the chosen executor must satisfy: { autoApprove?, planMode?, sandbox?, headless?, maxTurnsSupport?, streaming?, exclude?: string[] }. Auto-derived from permission_mode/plan; merged over .cbx.json executorRequirements. Unknown keys are rejected/warned rather than silently ignored." },
      routing_strategy: { type: "string", description: "Executor selection strategy: first-available (default) / capability-best / cost-aware / fastest / round-robin / least-recently-used. Filters by requirements first, then scores." },
      test: { type: "string", description: "Test command run after the executor finishes." },
      review: { type: "boolean", description: "Run an independent review phase after tests pass." },
      isolated: { type: "boolean", description: "Run in an isolated git worktree." },
      carry_dirty: { type: "boolean", description: "Carry the workspace's uncommitted changes into the isolated worktree (isolated=true and the workspace is dirty). Default false — when false an isolated+dirty task fails fast at creation with remedies. Use this to safely run an isolated task on in-progress work without committing or touching the main tree." },
      timeout_ms: { type: "integer", description: "Per-execution timeout in ms." },
      max_retries: { type: "integer", description: "Automatic retry budget." },
      max_turns: { type: "integer", description: "Executor turn budget." },
      permission_mode: { type: "string", description: "default / acceptEdits / auto / dontAsk." },
      plan: { type: "boolean", description: "Require an executor with planMode capability (auto-derives a planMode executor requirement for routing; equivalent to permission_mode=\"plan\")." },
      approval_before_run: { type: "boolean", description: "Stop for approval before starting the executor." },
      approval_before_complete: { type: "boolean", description: "Stop for approval before landing done." },
      dependency_guard: { type: "boolean", description: "Lockfile hash guard." },
      keep_worktree: { type: "boolean", description: "Keep the isolated worktree on completion." },
      review_rules: { type: "string", description: "Review focus instructions." },
      review_executor: { type: "string", description: "Executor for the review phase (defaults to executor)." },
      max_executor_invocations: { type: "integer", description: "Per-job hard cap on total executor invocations (stage + review + manager + gate). Reaching it pauses the job as needs_fix/cost_limit with a human gate instead of burning more quota. Defaults to .cbx.json cost.maxExecutorInvocations; unset = no cap." },
      idempotency_key: { type: "string", description: "Optional dedup key: retrying cbx_run with the same key and the same payload returns the existing job instead of creating a duplicate (same key + different payload is rejected). A failed creation releases the reservation so a retry truly re-runs." },
    },
    output: {
      schema: { type: "json" },
      render: runJobOutput,
    },
    async execute(args, exec) {
      const ws = await workspaceOf(args.workspace, exec);
      const config = await loadConfig(ws);
      // 幂等键（可选）：同键同载荷返回既有任务，同键不同载荷显式拒绝。
      // 校验前置——坏键在路由/探测之前就失败，不浪费探测也不留半截状态。
      const idempotencyKey =
        typeof args.idempotency_key === "string" ? args.idempotency_key.trim() : undefined;
      if (args.idempotency_key !== undefined && !idempotencyKey)
        throw new Error("idempotency_key 提供时必须是非空字符串。");
      if (idempotencyKey && idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH)
        throw new Error(`idempotency_key 超过 ${IDEMPOTENCY_KEY_MAX_LENGTH} 字符上限。`);
      // 路由：先探测本机已安装的 agent CLI，再把委派路由到可用执行器。
      // - 未指定 / "auto" → 按 preference 选第一个已安装；
      // - 显式指定但未安装 → 自动回退到可用 CLI（reason 说明）；
      // - 插件路径 → 不参与路由；全部不可用 → 创建期报清晰错误。
      // 路由：先探测本机已安装的 agent CLI，再按需求过滤 + 策略打分选最合适的一个。
      // - 需求从 permission_mode（auto/dontAsk → autoApprove，plan → planMode）自动推导，
      //   叠加 .cbx.json 的 executorRequirements 与工具参数 executor_requirements（后者优先）；
      // - 策略 routing_strategy（缺省 first-available，等价于旧行为但叠加需求过滤）。
      const derived = deriveRequirements({ permissionMode: args.permission_mode, plan: args.plan });
      const requirements: ExecutorRequirements = {
        ...derived,
        ...(config.executorRequirements ?? {}),
        ...((args.executor_requirements ?? {}) as ExecutorRequirements),
      };
      // 拼错的能力名（如 auto_approve）会被 meetRequirements 静默忽略，任务按更弱需求路由——
      // 显式告警让调用方立即看到字段没生效，而不是事后发现选了行为不符的执行器。
      const unknownReqKeys = Object.keys(args.executor_requirements ?? {}).filter(
        (key) => !KNOWN_EXECUTOR_REQUIREMENT_KEYS.has(key),
      );
      if (unknownReqKeys.length > 0) {
        bridgeLog(
          `executor_requirements 含未知字段（将被忽略）：${unknownReqKeys.join(", ")}。有效键：autoApprove / planMode / sandbox / headless / maxTurnsSupport / streaming / exclude。`,
        );
      }
      const strategy = (args.routing_strategy ??
        config.routingStrategy ??
        "first-available") as ExecutorStrategy;
      // 档位目录：实测校准（样本足够时）+ executorTiers 人工覆盖 + 出处标注。
      // 覆盖表里的未知执行器名必须响亮告警——错字静默失效正是这层要消灭的。
      const workspaceHealth = loadHealth(ws);
      const { catalog: tierCatalog, warnings: tierWarnings } =
        buildTierCatalog(workspaceHealth, config.executorTiers);
      for (const warning of tierWarnings) {
        bridgeLog(`cbx 档位目录：${warning}`);
      }
      const decision = routeExecutor(args.executor ?? config.executor ?? defaults.executor, {
        preference: args.executor_preference ?? config.executorPreference,
        requirements,
        strategy,
        health: workspaceHealth,
        tierCatalog,
      });
      if (!decision.executor) throw noExecutorError(decision.available);
      if (decision.routed) {
        bridgeLog(
          `cbx 路由：${decision.reason}`,
        );
      }
      const merged = mergeConfig(config, {
        testCommand: args.test,
        // 优先级：显式参数 > 工作区 .cbx.json > 插件配置默认。用 `?? config.review`
        // 而不是直接吃 defaults——mergeConfig 的 override 必胜，若传 defaults
        // （schemastery .default(true) 保证非 undefined）会永久压制 .cbx.json 的
        // review/isolated（与 executor/carryDirty 的三级链对齐）。
        review: args.review ?? config.review ?? defaults.review,
        isolated: args.isolated ?? config.isolated ?? defaults.isolated,
        timeoutMs: args.timeout_ms === undefined ? undefined : Number(args.timeout_ms),
        maxRetries: args.max_retries === undefined ? undefined : Number(args.max_retries),
        maxTurns: args.max_turns === undefined ? undefined : Number(args.max_turns),
        permissionMode: args.permission_mode,
        approvalBeforeRun: args.approval_before_run,
        approvalBeforeComplete: args.approval_before_complete,
        dependencyGuard: args.dependency_guard,
        keepWorktree: args.keep_worktree,
        executor: decision.executor,
        reviewExecutor: args.review_executor,
      });
      // 创建参数单点构造：幂等指纹与 createJob 用同一个对象，保证"同请求"判定
      // 与实际创建内容永远一致（不会出现指纹说 A、创建的是 B 的漂移）。
      const jobOptions = {
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
        carryDirty: args.carry_dirty ?? config.carryDirty ?? defaults.carryDirty,
        adaptive: merged.adaptive,
        trustMode: merged.trustMode,
        dependencyGuard: merged.dependencyGuard,
        cost: args.max_executor_invocations === undefined
          ? undefined
          : { maxExecutorInvocations: Number(args.max_executor_invocations) },
      };
      if (idempotencyKey) {
        const outcome = await beginIdempotentCreate(
          ws,
          idempotencyKey,
          hashIdempotentRequest(jobOptions),
        );
        if (outcome.kind === "conflict") {
          throw new Error(
            `幂等键 "${idempotencyKey}" 已用于不同的创建请求（预留于 ${outcome.createdAt}）。请换一个键，或省略 idempotency_key。`,
          );
        }
        if (outcome.kind === "in-flight") {
          throw new Error(
            `幂等键 "${idempotencyKey}" 的同名创建正在进行中（${outcome.createdAt}），未重复创建。若确认上次已失败可稍后重试或换键。`,
          );
        }
        if (outcome.kind === "duplicate") {
          // 命中既有任务：不重复创建/入队/挂桥（原调用方已持有跟踪通道）。
          bridgeLog(
            `cbx 幂等命中：任务 ${outcome.jobId} 已存在（状态 ${outcome.status ?? "unknown"}），本次未重复创建。需要重跑请用 cbx_retry。`,
          );
          return toJson({
            job_id: outcome.jobId,
            status: outcome.status ?? "unknown",
            deduplicated: true,
            __router: decision,
            __jobDir: jobDir(ws, outcome.jobId),
          });
        }
      }
      let created;
      try {
        created = await createJob(jobOptions);
      } catch (error) {
        // 失败释放预留：不留毒键，同键重试可以真正重跑。abort 自身失败不能
        // 掩盖 createJob 的真实失败原因（否则排障被误导为"清理失败"）。
        if (idempotencyKey) {
          try {
            await abortIdempotentCreate(ws, idempotencyKey);
          } catch (abortError) {
            bridgeLog(
              `cbx 幂等预留释放失败（${String(abortError)}）——同键 ${idempotencyKey} 重试将按 in-flight 处理，请稍后或换键。`,
            );
          }
        }
        throw error;
      }
      if (idempotencyKey) await commitIdempotentCreate(ws, idempotencyKey, created.jobId);
      await startBackground(ws, created.jobId, "", 0);
      // 创建时的路由决策视图（RouteDecision 的最小 JSON 视图）：桥首轮快照/终态摘要
      // 与前台子代理镜像首条消息都据此显示「委派给了谁、为什么」——路由决策不再
      // 只活在工具渲染里，委派那一刻所有前台通道可见。
      const routerView = {
        executor: decision.executor,
        routed: decision.routed,
        reason: decision.reason,
      };
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
        router: routerView,
      });
      // 前台子代理外观层：把同一委派发布为 harness 子代理镜像会话，任务即出现在
      // 「任务管理」页的子代理树（前台），点击卡片可实时查看执行输出（与 jobs-bridge
      // 的「后台任务」通道并存；失败不影响 cbx 执行，渲染层会说明原因）。
      const facade = publishCbxFacade(ctx, {
        workspace: ws,
        jobId: created.jobId,
        task: args.task,
        agent: exec?.agent,
        executor: decision.executor,
        router: routerView,
        logger: bridgeLog,
      });
      // 任务清单直接显示在当前会话：实时读取全量 job 列表附到返回值（渲染层输出表格）。
      const taskList = clampJson(await listJobs(ws));
      return toJson({
        job_id: created.jobId,
        status: "queued",
        __bridge: bridge,
        __facade: facade,
        __router: decision,
        __taskList: taskList,
        __jobDir: created.directory,
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
      const ws = await workspaceOf(args.workspace, exec);
      const state = await loadState(ws, args.job_id);
      // 富化：尽力读取 result.json 取执行器与改动文件数，附产物目录指针（渲染层输出可行动消息）。
      let enriched: Record<string, unknown> = { ...state, __jobDir: jobDir(ws, args.job_id) };
      try {
        const result = JSON.parse(await readArtifact(ws, args.job_id, "result.json")) as Record<string, unknown>;
        enriched = {
          ...enriched,
          __executor: typeof result.executor === "string" ? result.executor : undefined,
          __changedFiles: Array.isArray(result.changedFiles) ? result.changedFiles.length : undefined,
        };
      } catch {
        /* result.json 尚未生成（排队/运行中）：富化字段缺省即可 */
      }
      // 审计完整性：终态 job 验证 events.ndjson 是否与 SQLite 镜像一致（检测执行器篡改）。
      // best-effort：验证失败不阻塞状态读取。
      try {
        const audit = await verifyJobAudit(ws, args.job_id);
        enriched.__audit = audit;
      } catch {
        /* 审计验证不可用（非终态/镜像缺失）：跳过 */
      }
      return toJson(clampJson(enriched));
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
      const ws = await workspaceOf(args.workspace, exec);
      // 审计完整性富化（listJobsWithAudit）：终态 job 附 __audit（ndjson vs SQLite 镜像）。
      const jobs = await listJobsWithAudit(ws);
      return toJson(clampJson(jobs));
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
    name: "cbx_executors",
    description: "Detect which coding-agent CLIs (codebuddy/opencode/omp/cline/qwen) are installed and resolvable on this machine for cbx execution, with their env-var overrides (CBX_CODEBUDDY/...) and declared capabilities. Use it before delegating when you want to confirm availability or compare executor capabilities; cbx_run routes automatically (filtered by requirements, scored by strategy) to a suitable CLI when none is explicitly requested.",
    parameters: {
      workspace: { type: "string", description: "Project directory; if given, also shows per-executor health (success/failure/latency) recorded for that workspace." },
    },
    output: {
      schema: { type: "json" },
      render: renderExecutors,
    },
    async execute(args, exec) {
      const ws = args.workspace ? await workspaceOf(args.workspace, exec) : undefined;
      const probes = probeAllExecutors();
      const health = ws ? loadHealth(ws) : {};
      // 档位目录：无 workspace 时按空健康度构建（全部 declared 估值，如实标注）；
      // 有 workspace 时展示实测校准/人工覆盖后的有效档位与出处。覆盖表未知名
      // 以 tierWarnings 结构化返回（fail-closed：错字不可静默消失）。
      const config = ws ? await loadConfig(ws) : {};
      const { catalog: tierCatalog, warnings: tierWarnings } =
        buildTierCatalog(health, config.executorTiers);
      const enriched = probes.map((p) => {
        const spec = resolveExecutor(p.name);
        return {
          ...p,
          capabilities: spec?.capabilities ?? null,
          costTier: spec?.costTier ?? null,
          speedTier: spec?.speedTier ?? null,
          // 有效档位视图：declared=声明估值 / measured=实测校准 / configured=人工覆盖。
          tiers: tierCatalog[p.name] ?? null,
          // 无健康度记录的 workspace 上 health 为 undefined，会导致工具返回值
          // 不是无损 JSON（harness 拒绝）；用 null 兜底保证可序列化。
          health: health[p.name] ?? null,
        };
      });
      return toJson(
        clampJson({
          executors: enriched,
          ...(tierWarnings.length > 0 ? { tierWarnings } : {}),
        }),
      );
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
      // 续跑场景：复用/刷新前台子代理镜像（同 job 已有存活外观会话时复用）。
      const facade = publishCbxFacade(ctx, {
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
        __facade: facade,
        __taskList: taskList,
        __jobDir: jobDir(ws, args.job_id),
        ...(bridge.id !== undefined ? { jobId: bridge.id } : {}),
      });
    },
  }));

  tools.register(defineTool({
    name: "cbx_watch",
    description:
      "Poll a cbx job until it reaches terminal state (done/failed/review_failed/cancelled/needs_fix). Unlike plain polling, it accumulates the executor's processing messages (agent.log tail) and every status transition observed while waiting, and returns them together with the final state — so the current session sees what the delegated agent actually did, not just the outcome. Use this when no session job id was registered (or you want the transcript inline in the tool result).",
    parameters: {
      job_id: { type: "string", required: true, description: "The cbx job id." },
      workspace: { type: "string", description: "Project directory holding the job." },
      poll_ms: { type: "integer", description: "Status poll interval in ms (default 2000)." },
      timeout_ms: { type: "integer", description: "Max wait in ms (default 600000 = 10 min)." },
      include_log: { type: "boolean", description: "Accumulate and return the executor agent.log tail (default true)." },
      max_log_chars: { type: "integer", description: "Cap on the returned log tail in chars (default 16000)." },
      since: { type: "integer", description: "Initial agent.log byte offset to start reading from (default 0)." },
    },
    output: {
      schema: { type: "json" },
      render: renderWatchReport,
    },
    async execute(args, exec) {
      const ws = await workspaceOf(args.workspace, exec);
      const jobId = args.job_id;
      const pollMs = args.poll_ms === undefined ? 2000 : Math.max(250, Number(args.poll_ms));
      const timeoutMs = args.timeout_ms === undefined ? 600_000 : Math.max(1_000, Number(args.timeout_ms));
      const includeLog = args.include_log !== false;
      const maxLogChars = args.max_log_chars === undefined ? 16_000 : Math.max(1_000, Math.min(64_000, Number(args.max_log_chars)));
      const signal = exec?.signal;
      const start = Date.now();
      let lastStatus: string | undefined;
      const statusEvents: string[] = [];
      let logBuffer = "";
      let logCursor = args.since === undefined ? 0 : Math.max(0, Number(args.since));
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
          statusEvents.push(`[${status}${state.phase ? ` / ${state.phase}` : ""}${state.attempt !== undefined ? ` (attempt ${state.attempt})` : ""}]`);
        }
        // 处理消息：poll 期间增量拉取 agent.log 尾部，保留最近 maxLogChars 字符——
        // 终态返回时当前会话直接看到委派代理的处理过程（工具调用/推理/文件编辑）。
        if (includeLog) {
          try {
            const chunk = await tailAgentLog(ws, jobId, logCursor);
            if (chunk.text) {
              logBuffer += chunk.text;
              if (logBuffer.length > maxLogChars) {
                logBuffer = logBuffer.slice(logBuffer.length - maxLogChars);
              }
            }
            logCursor = chunk.next;
          } catch {
            /* agent.log 暂不可读：跳过本轮 */
          }
        }
        const TERMINAL = new Set(["done", "failed", "review_failed", "cancelled", "needs_fix"]);
        if (TERMINAL.has(status)) {
          return toJson(clampJson({
            state,
            status_events: statusEvents.slice(-50),
            log_tail: includeLog ? logBuffer : undefined,
            log_chars: includeLog ? logCursor : undefined,
            since: logCursor,
          }));
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
