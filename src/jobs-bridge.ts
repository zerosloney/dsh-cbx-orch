import type { Context } from "@deepseek-ai/cordis";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { cancelJob } from "./lifecycle.js";
import { jobDir, loadState } from "./state.js";
import { readArtifact } from "./artifacts.js";
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
 * - `readOutput()`：增量返回 agent.log 尾部 + 状态迁移行；
 * - `done`：cbx job 进入终态时 resolve，输出为 result.json/state 摘要；
 * - `cancel(reason)`：转发为 `cancelJob`（幂等）。
 *
 * 桥是可选的、best-effort：`ctx.jobs` 不可用、无 agent 上下文、或 `start` 抛错
 * （例如该 agent 的 preset 没挂 tool-jobs，或并发任务数达上限）时静默退化为旧行为
 * ——cbx job 照常运行，只是不在会话内显示。所有错误都不影响 cbx 本身的执行。
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

/** 桥接入参。 */
export interface CbxBridgeOptions {
  workspace: string;
  jobId: string;
  task: string;
  /** 发起委派的 harness agent；缺省（无会话上下文）时不注册。 */
  agent?: unknown;
}

/**
 * 把一次 cbx 委派注册为 harness 原生后台任务，返回 harness job id；
 * 桥不可用时返回 undefined（cbx 本身不受影响）。
 */
export function bridgeCbxJob(ctx: Context, options: CbxBridgeOptions): string | undefined {
  const { agent } = options;
  if (!agent) return undefined;
  let jobs: JobsRegistryLike | undefined;
  try {
    jobs = ctx.get("jobs") as JobsRegistryLike | undefined;
  } catch {
    jobs = undefined;
  }
  if (!jobs || typeof jobs.start !== "function") return undefined;
  const label = `cbx ${options.jobId}: ${options.task.replace(/\s+/g, " ").trim().slice(0, 80)}`;
  try {
    return jobs.start({
      kind: "cbx",
      label,
      owner: agent,
      outputLimitBytes: OUTPUT_LIMIT_BYTES,
      run: () => monitorCbxJob(options.workspace, options.jobId),
    });
  } catch {
    // 无 controller / 达并发上限 / 注册失败：静默退化为无桥接。
    return undefined;
  }
}

/** 轮询状态变更 + agent.log 尾部（内存游标，不碰 agent.log.cursor 共享文件）。 */
async function tailAgentLog(workspace: string, jobId: string, since: number): Promise<{ text: string; next: number }> {
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

/** 从 result.json / state 生成终态摘要（有限长度，供 job_output 与完成通知使用）。 */
async function buildFinalSummary(workspace: string, jobId: string, state: JobState): Promise<string> {
  const lines: string[] = [];
  lines.push(`[${state.status}${state.phase ? ` / ${state.phase}` : ""}${state.attempt !== undefined ? ` (attempt ${state.attempt})` : ""}]`);
  let result: Record<string, unknown> | undefined;
  try {
    result = JSON.parse(await readArtifact(workspace, jobId, "result.json")) as Record<string, unknown>;
  } catch {
    result = undefined;
  }
  const pick = (key: string): string | undefined => {
    const value = result?.[key];
    return typeof value === "string" && value ? value : undefined;
  };
  const error = pick("error") ?? (typeof state.error === "string" ? state.error : undefined);
  if (error) lines.push(`error: ${error}`);
  const verdict = pick("reviewVerdict") ?? (typeof state.reviewVerdict === "string" ? state.reviewVerdict : undefined);
  if (verdict) lines.push(`review: ${verdict}`);
  const changed = result?.changedFiles;
  if (Array.isArray(changed)) lines.push(`changed files: ${changed.length}`);
  const handback = pick("handback");
  if (handback) lines.push(`handback:\n${handback}`);
  return lines.join("\n").slice(0, OUTPUT_LIMIT_BYTES);
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
  let lastStatus: string | undefined;
  let cancelled = false;
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
      if (state.status !== lastStatus) {
        lastStatus = state.status;
        buffer += `[${state.status}${state.phase ? ` / ${state.phase}` : ""}${state.attempt !== undefined ? ` (attempt ${state.attempt})` : ""}]\n`;
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
