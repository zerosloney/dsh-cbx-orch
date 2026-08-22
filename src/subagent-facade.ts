import type { Context } from "@deepseek-ai/cordis";
import type { AssistantMessage, MessageId, UserMessage } from "@deepseek-ai/dsh-llm";
import type { Session, SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import type { ToolRestriction } from "@deepseek-ai/dsh-tools";
import { randomUUID } from "node:crypto";
import { readArtifact } from "./artifacts.js";
import { resolveAgent, tailAgentLog } from "./jobs-bridge.js";
import { buildSessionMessage, progressLine, routeNote, type RouterInfoLike } from "./session-message.js";
import { jobDir, loadState } from "./state.js";
import { TERMINAL_STATUSES, type JobState } from "./types.js";

/**
 * `subagent/descriptor` 会话事件类型增补（与 @deepseek-ai/dsh-subagent 的
 * descriptor.d.ts 声明**逐字段同构**——版本、模式、provider、label 与可继续
 * 组合字段。本插件不依赖 dsh-subagent 包，这里按同一 schema 本地声明，避免
 * 双方增补在消费方程序里冲突（TS 合并要求同名属性类型一致）。
 */
declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "subagent/descriptor": CbxSubagentDescriptorData;
  }
}

/** 与 dsh-subagent `SubagentDescriptorData` 结构相同的本地声明。 */
export type CbxSubagentDescriptorData = {
  readonly version: number;
  readonly mode: "one-shot";
  readonly provider: string;
  readonly label?: string;
} | {
  readonly version: number;
  readonly mode: "continuable";
  readonly provider: string;
  readonly label: string;
  readonly agentProvider?: string;
  readonly agentModel?: string;
  readonly persona?: string;
  readonly toolFilter?: ToolRestriction;
};

/**
 * cbx 子代理外观层（subagent facade）：把 cbx 委派发布为 harness 子代理镜像会话，
 * 让任务在 Web 侧边栏「任务管理」页的**子代理树（前台）**里像子代理一样显示。
 *
 * 背景：cbx 委派运行外部编码 CLI（opencode/codebuddy/...），经 jobs-bridge 注册为
 * harness 原生后台任务（`ctx.jobs`），所以只出现在该页的「后台任务」区。子代理目录
 * 只认 `origin:'subagent'` 的会话 + `subagent/descriptor` 事件 —— 此前 cbx 任务永远
 * 进不了前台子代理树（docs/alignment.md §4.3 的既有边界）。
 *
 * 本模块实现该边界上的薄层：
 * - 用 `ctx.sessions.prepare/enter/announce` 创建镜像会话（header: origin='subagent'、
 *   parentSession=发起 agent、delegationDepth=父级+1、cwd=workspace）；
 * - 追加大写 `subagent/descriptor`（one-shot，provider='cbx'，label=任务摘要）——
 *   子代理目录据此渲染卡片（模式/标签），点击卡片进入 transcript；
 * - 把 agent.log 增量镜像为 `assistant/message` 事件（与子代理实时输出体验一致）；
 * - cbx job 进入终态时追加结果摘要 + `turn/end`，然后 detach 会话：live store 移除、
 *   持久化层收尾 → 目录里该卡片转为 inactive 的已完成子代理；无持久化时卡片消失。
 *
 * 与 jobs-bridge 的关系：两条通道并存、互不干扰——桥接「后台任务」，外观层接
 * 「前台子代理树」。任一失败都不影响 cbx 本体执行。
 *
 * 已知边界（沿用 alignment.md §4.3 的权衡）：镜像会话没有真实 harness agent，
 * 因此不可冷恢复/续跑（one-shot 镜像）；运行期间的状态灯由服务端目录对 live
 * 子会话统一标 running，终态后靠 detach 转 inactive。
 */

/** 本层的"终态"集合 = 共享终态 + needs_fix（与 jobs-bridge 收口口径一致）。 */
const FACADE_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  ...TERMINAL_STATUSES,
  "needs_fix",
]);

/** 单条镜像消息的文本上限（避免一条超长日志撑爆事件）。 */
const MESSAGE_TEXT_MAX = 4_000;
/** 单个 job 镜像进 transcript 的累计字符上限；超出后停更内容并提示截断。 */
const MIRROR_CHARS_CAP = 120_000;
/** 首轮镜像仅回放日志尾部（续跑/大日志时避免洪水），初始回放上限。 */
const INITIAL_TAIL_CHARS = 8_000;
/** 终态摘要文本上限。 */
const FINAL_SUMMARY_MAX = 8_000;
/** 轮询 cbx 状态/agent.log 的间隔。 */
const POLL_MS = 1_000;

/** 子代理外观层注册结果——结构化返回，让调用方可以告诉用户"为什么没接到前台"。 */
export interface CbxFacadeResult {
  /** 镜像子代理会话 id（`cbx-<jobId>`）；未发布成功时缺省。 */
  sessionId?: string;
  /** 该 job 已有存活外观会话（cbx_continue 场景复用），非新建。 */
  existing?: boolean;
  /** 失败原因分类；成功时缺省。 */
  reason?: "no-agent-context" | "no-sessions-service" | "registration-rejected";
  /** 失败细节（异常 message / 错误描述），仅用于诊断日志。 */
  detail?: string;
}

/** 外观层接入参。 */
export interface CbxFacadeOptions {
  workspace: string;
  jobId: string;
  task: string;
  /** 发起委派的 harness agent；缺省时经 ctx.agents.currentInitiator() 兜底。 */
  agent?: unknown;
  /** 执行器名（assistant 消息 source.model 用），缺省 'external-cli'。 */
  executor?: string;
  /**
   * 创建时的路由决策（RouteDecision 的最小视图）：发布首条消息与终态摘要据此
   * 显示「委派给了哪个执行器、为什么」——前台子代理树在委派那一刻即可见。
   */
  router?: RouterInfoLike;
  /** 失败诊断日志 logger；缺省不打印。 */
  logger?: (message: string) => void;
  /** 状态轮询间隔（测试注入小值用）；缺省 POLL_MS。 */
  pollMs?: number;
}

/** 一个存活外观会话的句柄（registry 条目）。 */
interface FacadeHandle {
  id: SessionId;
  session: Session;
  /** 会话 store：终态 detach 前必须经它完成 durability checkpoint。 */
  sessions: SessionStore;
  /** enter() 返回的 detach disposer：移除 live store 并触发 session/disposed 收尾。 */
  detach: () => void;
  /** 所属 registry（settle 时精确删除自身条目）。 */
  registry: Map<SessionId, FacadeHandle>;
  /** 委派时路由选定的执行器（assistant 消息 source.model 用）。 */
  executor?: string;
  /** 创建时的路由决策（发布首条消息与终态摘要用）。 */
  router?: RouterInfoLike;
  timer?: NodeJS.Timeout;
  /** agent.log 字节游标。 */
  since: number;
  lastStatus?: string;
  /** 已镜像字符数（MIRROR_CHARS_CAP 上限）。 */
  mirrored: number;
  settled: boolean;
  /** 终态收尾中的单飞 promise，防止并发轮询重复 flush/detach。 */
  settling?: Promise<void>;
}

/** 每个 context 一份存活 registry（会话 id → 外观句柄），随 context 生命周期清理。 */
const registries = new WeakMap<Context, Map<SessionId, FacadeHandle>>();

function registryOf(ctx: Context): Map<SessionId, FacadeHandle> {
  let registry = registries.get(ctx);
  if (registry === undefined) {
    registry = new Map();
    registries.set(ctx, registry);
    // context 销毁时清理全部存活外观会话（detach 幂等，settled 为 no-op 兜底）。
    try {
      ctx.effect(() => () => {
        for (const handle of [...registry!.values()]) disposeFacade(handle);
        registry!.clear();
      });
    } catch {
      /* ctx.effect 缺位（瘦 profile）：各 handle 的 settle 路径自行收口 */
    }
  }
  return registry;
}

function messageId(): MessageId {
  return `msg-${randomUUID()}` as MessageId;
}

/** 外观会话的持久标签：`cbx <jobId>: <任务摘要>`（与 jobs-bridge label 同构）。 */
function facadeLabel(jobId: string, task: string): string {
  return `cbx ${jobId}: ${task.replace(/\s+/g, " ").trim().slice(0, 80)}`;
}

/**
 * 把一次 cbx 委派发布为前台子代理镜像会话。失败返回 reason（不影响 cbx 执行）。
 * 幂等：同一 job 已存在存活外观会话时复用（返回 existing: true）。
 */
export function publishCbxFacade(
  ctx: Context,
  options: CbxFacadeOptions,
): CbxFacadeResult {
  const agent = resolveAgent(ctx, options.agent);
  if (!agent) {
    const reason = "no-agent-context" as const;
    options.logger?.(
      `cbx subagent-facade: 跳过发布 (${options.jobId}) — 无 agent 上下文（非 chat 场景的命令行/cron 调用预期行为）。`,
    );
    return { reason };
  }
  const parentSessionId = (agent as { id?: unknown }).id;
  if (typeof parentSessionId !== "string" || parentSessionId.length === 0) {
    const reason = "no-agent-context" as const;
    options.logger?.(
      `cbx subagent-facade: 跳过发布 (${options.jobId}) — 发起 agent 缺少 session id。`,
    );
    return { reason };
  }
  let sessions: SessionStore | undefined;
  try {
    sessions = ctx.get("sessions") as SessionStore | undefined;
  } catch {
    sessions = undefined;
  }
  if (!sessions || typeof sessions.prepare !== "function" || typeof sessions.enter !== "function") {
    const reason = "no-sessions-service" as const;
    options.logger?.(
      `cbx subagent-facade: 跳过发布 (${options.jobId}) — ctx.sessions 服务不可用（profile 未挂 dsh-session）。`,
    );
    return { reason };
  }

  const id = `cbx-${options.jobId}` as SessionId;
  const registry = registryOf(ctx);
  const existing = registry.get(id);
  if (existing !== undefined && !existing.settled) {
    return { sessionId: id, existing: true };
  }

  // 父级 delegationDepth + 1（best-effort：读不到就不写，目录不依赖深度）。
  const parentDepth = (agent as { session?: { header?: { delegationDepth?: number } } })
    .session?.header?.delegationDepth;
  const delegationDepth = typeof parentDepth === "number" ? parentDepth + 1 : undefined;

  let detach: (() => void) | undefined;
  try {
    const session = sessions.prepare(id, {
      meta: {
        origin: "subagent",
        parentSession: parentSessionId as SessionId,
        cwd: options.workspace,
        ...(delegationDepth === undefined ? {} : { delegationDepth }),
      },
    });
    // `enter()` 后立即保留 detach：`announce()` 或初始 append 失败时必须回滚 live session。
    detach = sessions.enter(session);
    sessions.announce(session);

    const handle: FacadeHandle = {
      id,
      session,
      detach,
      sessions,
      registry,
      executor: options.executor,
      router: options.router,
      since: 0,
      mirrored: 0,
      settled: false,
    };

    // 初始事件：turn 边界 + 身份描述符 + 委派任务（user 消息）。
    session.append("turn/start", { turn: 0 });
    const descriptor: CbxSubagentDescriptorData = {
      version: 2,
      mode: "one-shot",
      provider: "cbx",
      label: facadeLabel(options.jobId, options.task),
    };
    session.append("subagent/descriptor", descriptor);
    const userMessage: UserMessage = {
      id: messageId(),
      role: "user",
      content: [{ type: "text", text: options.task.slice(0, 2_000) }],
      source: { kind: "user" },
    };
    session.append("user/message", userMessage, { surfaceOp: "append" });
    // 委派那一刻的路由可见性：镜像首条 assistant 消息即声明执行器与原因，
    // 与后台任务桥的首轮快照同款（不等轮询/终态）。
    const note = routeNote(options.router);
    if (note) appendAssistant(handle, `[${note}]`);

    registry.set(id, handle);
    handle.timer = scheduleMirror(options, handle, options.pollMs ?? POLL_MS);
    return { sessionId: id };
  } catch (error) {
    detach?.();
    const reason = "registration-rejected" as const;
    const detail = error instanceof Error ? error.message : String(error);
    options.logger?.(
      `cbx subagent-facade: 发布被拒 (${options.jobId}) — ${detail}`,
    );
    return { reason, detail };
  }
}

/** 用 setTimeout 链跑镜像轮询（与 jobs-bridge 一致：不绑调用 fiber）。 */
function scheduleMirror(options: CbxFacadeOptions, handle: FacadeHandle, pollMs: number): NodeJS.Timeout {
  const loop = async (): Promise<void> => {
    if (handle.settled) return;
    try {
      await mirrorOnce(options, handle);
    } catch (error) {
      // 契约：镜像循环永不抛出——意外错误收口为提示 + 结算。
      appendAssistant(
        handle,
        `[cbx ${options.jobId}] 镜像轮询异常：${error instanceof Error ? error.message : String(error)}`,
      );
      await settleFacade(options, handle);
    }
    // 仅在本轮异步读取完成后安排下一轮，避免并发读取同一 since 游标。
    if (!handle.settled) handle.timer = setTimeout(() => void loop(), pollMs);
  };
  return setTimeout(() => void loop(), pollMs);
}

/** 单轮镜像：状态迁移 + agent.log 增量 → 事件；终态 → 摘要 + 结算。 */
async function mirrorOnce(options: CbxFacadeOptions, handle: FacadeHandle): Promise<void> {
  const { workspace, jobId } = options;
  let state: JobState | undefined;
  try {
    state = await loadState(workspace, jobId);
  } catch {
    state = undefined;
  }
  if (state === undefined) {
    // job 目录消失（forget/purge）：视为已终止。
    appendAssistant(handle, `[cbx ${jobId}] job 目录已移除，前台镜像结束。`);
    await settleFacade(options, handle);
    return;
  }

  const terminal = FACADE_TERMINAL_STATUSES.has(state.status);
  const executor = typeof state.executor === "string" ? state.executor : undefined;
  if (state.status !== handle.lastStatus) {
    handle.lastStatus = state.status;
    if (!terminal) {
      appendAssistant(handle, `[${progressLine({ status: state.status, phase: state.phase, attempt: state.attempt, executor })}]`);
    }
  }

  // agent.log 增量镜像（截断自愈：文件比游标短说明被重建，回到文件头）。
  if (!terminal && handle.mirrored < MIRROR_CHARS_CAP) {
    const chunk = await tailAgentLog(workspace, jobId, handle.since);
    handle.since = chunk.next;
    if (chunk.text.length > 0) {
      let text = chunk.text;
      // 首轮仅回放尾部：续跑/超大日志避免把整段历史洪水进 transcript。
      if (handle.mirrored === 0 && text.length > INITIAL_TAIL_CHARS) {
        text = text.slice(-INITIAL_TAIL_CHARS);
      }
      for (const piece of splitText(text, MESSAGE_TEXT_MAX)) {
        if (handle.mirrored >= MIRROR_CHARS_CAP) break;
        appendAssistant(handle, piece);
        handle.mirrored += piece.length;
      }
      if (handle.mirrored >= MIRROR_CHARS_CAP) {
        appendAssistant(handle, `[cbx ${jobId}] 输出已超过 ${MIRROR_CHARS_CAP} 字符上限，前台镜像停止更新内容（后台任务区/仪表盘仍完整）。`);
      }
    }
  }

  if (terminal) {
    appendAssistant(handle, await finalSummary(options, state));
    await settleFacade(options, handle);
  }
}

/** 终态摘要（复用会话消息构建器，紧凑版）：状态 + 阶段 + 执行器 + 产物指针。 */
async function finalSummary(options: CbxFacadeOptions, state: JobState): Promise<string> {
  const { workspace, jobId } = options;
  let executor: string | undefined;
  let error: string | undefined;
  try {
    const result = JSON.parse(await readArtifact(workspace, jobId, "result.json")) as Record<string, unknown>;
    executor = typeof result.executor === "string" ? result.executor : undefined;
    error = typeof result.error === "string" && result.error ? result.error : undefined;
  } catch {
    /* result.json 未就绪 */
  }
  return buildSessionMessage({
    jobId,
    status: state.status,
    phase: state.phase,
    attempt: state.attempt,
    executor: executor ?? (typeof state.executor === "string" ? state.executor : undefined),
    // 路由决策随终态保留（builder 优先渲染 router 分支）。
    router: options.router?.executor ? options.router : undefined,
    error,
    jobDir: jobDir(workspace, jobId),
  }).slice(0, FINAL_SUMMARY_MAX);
}

/** 结算：追加 turn/end，完成 durability checkpoint 后 detach 会话并移除 registry。 */
async function settleFacade(options: CbxFacadeOptions, handle: FacadeHandle): Promise<void> {
  if (handle.settled) return;
  if (handle.settling) return handle.settling;
  if (handle.timer !== undefined) clearTimeout(handle.timer);
  handle.settling = (async () => {
    try {
      handle.session.append("turn/end", { turn: 0, reason: { kind: "completed" } });
    } catch {
      /* 日志已损坏/已结算：仍尝试 flush 已写入事件。 */
    }
    try {
      await handle.sessions.flush(handle.session);
    } catch (error) {
      // 持久化失败不能让 front-end session 永久滞留；日志供宿主排查。
      options.logger?.(
        `cbx subagent-facade: 持久化收尾失败 (${options.jobId}) — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    disposeFacade(handle);
    handle.registry.delete(handle.id);
    options.logger?.(`cbx subagent-facade: 前台镜像结束 (${options.jobId})。`);
  })();
  return handle.settling;
}

/** detach 会话（live store 移除 + session/disposed 持久化收尾），幂等；同时停镜像定时器。 */
function disposeFacade(handle: FacadeHandle): void {
  handle.settled = true;
  if (handle.timer !== undefined) clearTimeout(handle.timer);
  try {
    handle.detach();
  } catch {
    /* 已 detach / store 已销毁：幂等 no-op */
  }
}

/** 追加一条 assistant 文本消息到镜像会话（surface append），失败静默（镜像 best-effort）。 */
function appendAssistant(handle: FacadeHandle, text: string): void {
  if (handle.settled || text.length === 0) return;
  try {
    const message: AssistantMessage = {
      id: messageId(),
      role: "assistant",
      content: [{ type: "text", text }],
      source: { kind: "model", provider: "cbx", model: handle.executor ?? "external-cli" },
    };
    handle.session.append("assistant/message", { turn: 0, step: 0, message }, { surfaceOp: "append" });
  } catch {
    /* 日志损坏/已结算：静默跳过该条 */
  }
}

/** 把文本切成长度 ≤ limit 的片段（优先按换行切，超长硬切）。 */
export function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const head = rest.slice(0, limit);
    const newline = head.lastIndexOf("\n");
    const cut = newline > limit / 2 ? newline + 1 : limit;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

/** 导出供测试/诊断：当前 context 的存活外观会话 id 列表。 */
export function liveFacadeIds(ctx: Context): string[] {
  const registry = registries.get(ctx);
  return registry === undefined ? [] : [...registry.keys()];
}
