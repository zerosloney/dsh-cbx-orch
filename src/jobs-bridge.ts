import type { Context } from "@deepseek-ai/cordis";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { listJobs } from "./artifacts.js";
import { formatTaskList } from "./format.js";
import { cancelJob } from "./lifecycle.js";
import { jobDir, loadState } from "./state.js";
import { readArtifact } from "./artifacts.js";
import { buildSessionMessage, progressLine } from "./session-message.js";
import { TERMINAL_STATUSES, type JobState } from "./types.js";

/**
 * 会话内后台任务桥（docs/alignment.md §4.2 事件桥的实现）。
 *
 * 背景：cbx 任务在自有 SQLite/状态文件体系里运行，此前 `cbx_run`/`/cbx-run`
 * 只返回一行 "job queued"，执行过程与结果都不进 harness 的会话视图——当前会话
 * 看不到委派任务的响应内容。harness 原生有 `ctx.jobs` 后台任务注册表（dsh-jobs-local
 * 在 dsh-base 中提供），配合 agent preset 挂载的 `dsh-tool-jobs`：注册到该表且
 * 归属当前 agent 的任务会出现在会话 UI（实时状态），完成后 `tool-jobs` 会把完成通知
 * 与输出投递到当前会话（job_output/job_wait/job_kill 工具可用）。
 *
 * 本模块把一次 cbx 委派（创建/继续）注册为 `kind: "cbx"` 的原生后台任务：
 * - `label`：`cbx <jobId>: <task 摘要>`；
 * - `readOutput()`：增量返回 agent.log 尾部 + 状态迁移行 + 任务清单快照；
 * - `done`：cbx job 进入终态时 resolve，输出为 result.json/state 摘要 + 当前任务清单；
 * - `cancel(reason)`：转发为 `cancelJob`（幂等）。
 *
 * 任务清单（工作区全部 job 的状态表格）随首轮快照与最终通知直接显示在当前会话，
 * 用户不用再单独调 cbx_list 就能看到编排全局。
 *
 * 桥是 best-effort：通过 ctx.agents.currentInitiator() 兜底获取发起会话的
 * agent；ctx.jobs 不可用、无 agent 上下文或 `start` 抛错时返回带 reason 的
 * 结构化结果，调用方可向会话输出**为什么没接到会话任务总线**——这是修复
 * "委派任务在前台看不到"的关键：原来静默吞错的三个分支都会产生可见提示。
 * 桥失败**不影响** cbx 本身的执行（任务照常入队跑，只是会话侧看不到实时进度）。
 */

/**
 * 本桥的"终态"集合 = 共享终态（done/failed/review_failed/cancelled）+ needs_fix。
 * needs_fix 在共享终态中故意排除（cbx job 可经 cbx_continue 续跑），但会话桥在这里
 * 收口：任务停在"待修复"时，对当前会话而言委派已结束，readOutput/完成通知应给出
 * 结果，而不是无限轮询等 cbx_continue。队列视图的 needs_fix 语义不受影响。
 */
const BRIDGE_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  ...TERMINAL_STATUSES,
  "needs_fix",
]);

/** 单次会话内输出的字节上限（完成通知与 job_output 读取都受此约束）。 */
const OUTPUT_LIMIT_BYTES = 64_000;
/** 轮询 cbx 状态的最小间隔。 */
const POLL_MS = 1_000;

/** harness `ctx.jobs` 的结构化最小视图（避免引入 @deepseek-ai/dsh-jobs 类型依赖）。 */
export interface JobsRegistryLike {
  start(spec: {
    kind: string;
    label: string;
    owner?: unknown;
    outputLimitBytes?: number;
    run(): {
      cancel?(reason?: string): void;
      done: Promise<{ status: "completed" | "killed" | "failed"; detail?: string; output?: string }>;
      readOutput?(): string;
    };
  }): string;
}

/** 桥注册结果——结构化返回，让调用方可以告诉用户"为什么没接到会话任务总线"。 */
export interface CbxBridgeResult {
  /** Harness 原生 job id（`job_output` / `job_kill` 用），未注册成功时缺省。 */
  id?: string;
  /** 失败原因分类；成功时缺省。调用方根据 reason 决定如何在 UI 上提示。 */
  reason?:
    | "no-agent-context"
    | "no-jobs-service"
    | "registration-rejected";
  /** 失败细节（异常 message / 错误描述），仅用于诊断日志。 */
  detail?: string;
}

/** 桥接入参。 */
export interface CbxBridgeOptions {
  workspace: string;
  jobId: string;
  task: string;
  /** 发起委派的 harness agent；缺省时通过 ctx.agents.currentInitiator() 兜底。 */
  agent?: unknown;
  /**
   * 桥注册失败的诊断日志 logger；缺省不打印（保持工具层的纯函数语义）。
   * 测试时传 spy，生产传 `ctx.logger('cbx')`。
   */
  logger?: (message: string) => void;
}

/**
 * 解析当前会话的 agent：exec.agent 优先；缺省时回落到 ctx.agents.currentInitiator()
 * （agent loop 启动的 driver chain 在异步上下文里始终带发起方）。这是修复
 * "委派任务在前台看不到"的关键兜底——原版只读 exec.agent，而 exec.agent
 * 在很多上下文里是 undefined，导致桥永远不接。
 */
function resolveAgent(ctx: Context, execAgent: unknown): unknown {
  if (execAgent) return execAgent;
  try {
    const agents = ctx.get("agents") as
      | { currentInitiator?: () => unknown }
      | undefined;
    const initiator = agents?.currentInitiator?.();
    if (initiator) return initiator;
  } catch {
    /* ctx.agents 服务不在（瘦 profile / 命令行调用），静默回落 */
  }
  return undefined;
}

/**
 * 把一次 cbx 委派注册为 harness 原生后台任务；返回结构化结果（成功带 id，
 * 失败带 reason）。cbx 本身的执行不受桥影响。
 */
export function bridgeCbxJob(
  ctx: Context,
  options: CbxBridgeOptions,
): CbxBridgeResult {
  const agent = resolveAgent(ctx, options.agent);
  if (!agent) {
    const reason = "no-agent-context" as const;
    options.logger?.(
      `cbx jobs-bridge: 跳过注册 (${options.jobId}) — 无 agent 上下文（exec.agent 与 ctx.agents.currentInitiator() 都为空；非 chat 场景的命令行/cron 调用预期行为）。`,
    );
    return { reason };
  }
  let jobs: JobsRegistryLike | undefined;
  try {
    jobs = ctx.get("jobs") as JobsRegistryLike | undefined;
  } catch {
    jobs = undefined;
  }
  if (!jobs || typeof jobs.start !== "function") {
    const reason = "no-jobs-service" as const;
    options.logger?.(
      `cbx jobs-bridge: 跳过注册 (${options.jobId}) — ctx.jobs 服务不可用（profile 未挂 dsh-jobs-local 或 agent preset 未挂 dsh-tool-jobs）。`,
    );
    return { reason };
  }
  const label = `cbx ${options.jobId}: ${options.task.replace(/\s+/g, " ").trim().slice(0, 80)}`;
  try {
    const id = jobs.start({
      kind: "cbx",
      label,
      owner: agent,
      outputLimitBytes: OUTPUT_LIMIT_BYTES,
      run: () => monitorCbxJob(options.workspace, options.jobId),
    });
    return { id };
  } catch (error) {
    const reason = "registration-rejected" as const;
    const detail = error instanceof Error ? error.message : String(error);
    options.logger?.(
      `cbx jobs-bridge: 注册被拒绝 (${options.jobId}) — ${detail}（并发上限/preset 未挂 controller 等）。`,
    );
    return { reason, detail };
  }
}

/** 轮询状态变更 + agent.log 尾部（内存游标，不碰 agent.log.cursor 共享文件）。 */
export async function tailAgentLog(workspace: string, jobId: string, since: number): Promise<{ text: string; next: number }> {
  let raw: Buffer;
  try {
    raw = await readFile(path.join(jobDir(workspace, jobId), "agent.log"));
  } catch {
    return { text: "", next: since };
  }
  // 旋转/截断自愈：文件比游标短说明被重建，回到文件头重新对齐。
  let start = since;
  if (start > raw.length) start = 0;
  const text = raw.subarray(start).toString("utf8");
  return { text, next: raw.length };
}

/** 终态 → harness outcome 状态映射。 */
function mapOutcomeStatus(state: JobState): "completed" | "killed" | "failed" {
  if (state.status === "done") return "completed";
  if (state.status === "cancelled") return "killed";
  return "failed";
}

/**
 * 任务清单块：状态行之后紧跟当前工作区全量 job 列表（best-effort，失败返回空串）。
 * 放在摘要头部，保证长 handback 撑满 64K 截断时清单仍保留。
 */
async function loadTaskList(workspace: string): Promise<JobState[]> {
  try {
    return await listJobs(workspace);
  } catch {
    return [];
  }
}

/** 完成通知中附带的 agent.log 尾部上限：处理消息是原始转录，控制体积避免撑爆 64K 输出。 */
const LOG_TAIL_MAX_CHARS = 8_000;

/** 从 result.json / state 生成终态摘要（有限长度，供 job_output 与完成通知使用）。 */
async function buildFinalSummary(workspace: string, jobId: string, state: JobState): Promise<string> {
  // 统一消息：状态 + 阶段人话 + 下一步行动 + 执行器 + 产物指针 + 全量任务清单 + agent.log 处理消息。
  let executor: string | undefined;
  let error: string | undefined;
  let reviewVerdict: string | undefined;
  let changedFilesCount: number | undefined;
  let handback: string | undefined;
  try {
    const result = JSON.parse(await readArtifact(workspace, jobId, "result.json")) as Record<string, unknown>;
    executor = typeof result.executor === "string" ? result.executor : undefined;
    error = typeof result.error === "string" && result.error ? result.error : undefined;
    reviewVerdict = typeof result.reviewVerdict === "string" && result.reviewVerdict ? result.reviewVerdict : undefined;
    changedFilesCount = Array.isArray(result.changedFiles) ? result.changedFiles.length : undefined;
    handback = typeof result.handback === "string" && result.handback ? result.handback : undefined;
  } catch {
    /* result.json 未就绪 */
  }
  const errorMsg = error ?? (typeof state.error === "string" ? state.error : undefined);
  const taskList = await loadTaskList(workspace);
  let logTail = "";
  try {
    const log = await tailAgentLog(workspace, jobId, 0);
    if (log.text) {
      logTail =
        log.text.length > LOG_TAIL_MAX_CHARS
          ? `…（agent.log 共 ${log.text.length} 字符，截断保留尾部）\n${log.text.slice(-LOG_TAIL_MAX_CHARS)}`
          : log.text;
    }
  } catch {
    /* agent.log 不可读：跳过处理消息，摘要本身仍有效 */
  }
  return buildSessionMessage({
    jobId,
    status: state.status,
    phase: state.phase,
    attempt: state.attempt,
    executor,
    error: errorMsg,
    reviewVerdict,
    changedFilesCount,
    handback,
    jobDir: jobDir(workspace, jobId),
    taskList,
    logTail,
  }).slice(0, OUTPUT_LIMIT_BYTES);
}

/**
 * 注册后的监视器：轮询 cbx 状态与 agent.log，直到终态。
 * `pollMs` 可注入（测试用），生产默认 POLL_MS。
 */
export function monitorCbxJob(
  workspace: string,
  jobId: string,
  pollMs = POLL_MS,
): {
  cancel(reason?: string): void;
  done: Promise<{ status: "completed" | "killed" | "failed"; detail?: string; output?: string }>;
  readOutput(): string;
} {
  let buffer = "";
  let since = 0;
  let executor: string | undefined;
  let lastStatus: string | undefined;
  let cancelled = false;
  let snapshotted = false;
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  let resolveDone!: (outcome: { status: "completed" | "killed" | "failed"; detail?: string; output?: string }) => void;
  const done = new Promise<{ status: "completed" | "killed" | "failed"; detail?: string; output?: string }>((resolve) => {
    resolveDone = resolve;
  });

  const settle = (outcome: { status: "completed" | "killed" | "failed"; detail?: string; output?: string }): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolveDone(outcome);
  };

  const tick = async (): Promise<void> => {
    if (settled) return;
    try {
      await tickOnce();
    } catch (error) {
      // 契约要求 done 永不 reject：任何意外错误都收口为 failed 并 settle。
      settle({ status: "failed", detail: error instanceof Error ? error.message : String(error) });
    }
  };

  const tickOnce = async (): Promise<void> => {
    let state: JobState | undefined;
    try {
      state = await loadState(workspace, jobId);
    } catch {
      state = undefined;
    }
    if (state) {
      // 首轮快照：任务还在跑时，job_output 里直接看到执行器与当前全量任务清单（只打一次）。
      if (!snapshotted && !BRIDGE_TERMINAL_STATUSES.has(state.status)) {
        snapshotted = true;
        if (!executor) {
          try {
            const ctx = JSON.parse(await readFile(path.join(jobDir(workspace, jobId), "context.json"), "utf8")) as { executor?: string };
            executor = typeof ctx.executor === "string" ? ctx.executor : undefined;
          } catch {
            /* context 未就绪 */
          }
        }
        const jobs = await loadTaskList(workspace);
        if (jobs.length > 0) buffer += `任务清单（${jobs.length} 个 cbx job）:\n${formatTaskList(jobs)}\n`;
      }
      if (state.status !== lastStatus) {
        lastStatus = state.status;
        buffer += `${progressLine({ status: state.status, phase: state.phase, attempt: state.attempt, executor })}\n`;
      }
      if (BRIDGE_TERMINAL_STATUSES.has(state.status)) {
        const output = await buildFinalSummary(workspace, jobId, state).catch(() => `[${state.status}]`);
        buffer += output;
        settle({
          status: mapOutcomeStatus(state),
          detail: cancelled ? "cancelled" : state.phase ?? state.status,
          output,
        });
        return;
      }
    } else {
      // job 目录消失（forget/purge）：视为已终止。
      settle({ status: "killed", detail: "job directory removed" });
      return;
    }
    try {
      const chunk = await tailAgentLog(workspace, jobId, since);
      if (chunk.text) buffer += chunk.text;
      since = chunk.next;
    } catch {
      /* agent.log 暂不可读：跳过本轮 */
    }
    if (buffer.length > OUTPUT_LIMIT_BYTES) {
      buffer = buffer.slice(buffer.length - OUTPUT_LIMIT_BYTES);
    }
    timer = setTimeout(() => void tick(), pollMs);
  };

  void tick();

  return {
    cancel(reason?: string) {
      cancelled = true;
      buffer += `[cancel requested${reason ? `: ${reason}` : ""}]\n`;
      // cancelJob 幂等；终态任务取消是 no-op。fire-and-forget 满足 registry 的同步契约。
      void cancelJob(workspace, jobId).catch(() => undefined);
    },
    done,
    readOutput() {
      const text = buffer;
      buffer = "";
      return text;
    },
  };
}
