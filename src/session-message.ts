import type { JobState } from "./types.js";
import { formatTaskList } from "./format.js";
import { jobDir } from "./state.js";

/**
 * 会话消息统一构建器：把 cbx 任务的"状态 + 阶段人话说明 + 下一步行动 + 执行器/路由 +
 * 任务清单 + 产物指针 + 处理消息(agent.log)"收敛成一套一致、可行动的文本。
 *
 * 供四处会话通道共用（单一事实来源）：
 * - `cbx_run` / `cbx_continue` 提交响应（tools.ts runJobOutput）
 * - `cbx_status` 渲染（tools.ts renderJobStatus）
 * - `cbx_watch` 渲染（tools.ts renderWatchReport）
 * - 会话内后台任务桥的终态摘要（jobs-bridge buildFinalSummary）
 *
 * 定位：session-message 只产出纯文本，仪表盘 footer 由各调用方自行追加，
 * 避免引入 tools/web 的依赖（保持模块低耦合、可单测）。
 */

export interface RouterInfoLike {
  executor?: string;
  routed?: boolean;
  reason?: string;
}

export interface SessionMessageInput {
  workspace?: string;
  jobId?: string;
  status?: string;
  phase?: string;
  attempt?: number;
  executor?: string;
  router?: RouterInfoLike;
  error?: string;
  reviewVerdict?: string;
  changedFilesCount?: number;
  /** 执行器交付的 handback（终态摘要/产物长文）。 */
  handback?: string;
  /** 完成/失败时的产物目录指针。 */
  jobDir?: string;
  /** 桥注册提示（已渲染成一行）或其余外部提示。 */
  bridgeNote?: string;
  /** 前台子代理外观层提示（已渲染成一行）。 */
  facadeNote?: string;
  /** 工作区全量任务清单（由本模块统一 formatTaskList）。 */
  taskList?: readonly JobState[];
  /** 运行中经历的状态迁移行（终态前的事件回放）。 */
  statusEvents?: string[];
  /** 处理消息（agent.log 尾部）。 */
  logTail?: string;
  logChars?: number;
}

/** 状态 + 阶段 → 人话说明。 */
export function phaseExplanation(status?: string, phase?: string): string {
  const s = status ?? "";
  const p = phase ?? "";
  switch (s) {
    case "queued":
      return "已入队，等待调度";
    case "running":
      if (p.includes("test")) return "执行完成，正在跑测试";
      if (p.includes("review") || p === "reviewing") return "测试通过，独立审查中";
      if (p.includes("understand") || p === "plan") return "理解需求 / 规划中";
      return "执行器正在改代码";
    case "awaiting_approval":
      return p.includes("complete") ? "完成前等待审批" : "执行前等待审批";
    case "needs_fix":
      if (p.includes("clarification") || p.includes("input")) return "等待补充说明";
      if (p.includes("evidence")) return "完成证据已变化，需重跑验证";
      return "执行 / 测试未通过，等待修复续跑";
    case "review_failed":
      return "审查未通过，等待处理";
    case "done":
      return "已完成";
    case "failed":
      return "已失败";
    case "cancelled":
      return "已取消";
    default:
      return p || s;
  }
}

/** 状态 + 阶段 → 下一步行动提示（可行动命令）。 */
export function nextActionHint(status?: string, phase?: string, jobId?: string): string[] {
  const s = status ?? "";
  const p = phase ?? "";
  const id = jobId ? jobId.trim() : "";
  const cmd = (verb: string): string => `${verb} ${id}`.trim();
  switch (s) {
    case "awaiting_approval":
      return [`批准：${cmd("cbx_approve")}`, `取消：${cmd("cbx_cancel")}`];
    case "needs_fix":
      if (p.includes("clarification") || p.includes("input")) {
        return [`补充说明后续跑：${cmd("cbx_continue")} <说明>`];
      }
      if (p.includes("evidence")) return [`重跑验证：${cmd("cbx_continue")}`];
      return [
        `按失败原因修复续跑：${cmd("cbx_continue")} <修复指令>`,
        `或重试：${cmd("cbx_retry")}`,
      ];
    case "review_failed":
      return [`读 review.md 后继续：${cmd("cbx_continue")}`];
    case "done":
      return [`读结果 / 产物：${cmd("cbx_result")}`];
    case "failed":
      return [`读失败详情：${cmd("cbx_result")} / ${"cbx_logs"}`, `可重试：${cmd("cbx_retry")}`];
    case "running":
    case "queued":
      return [`跟踪进度：${cmd("cbx_watch")}`, "或会话 job_output / job_wait"];
    default:
      return [];
  }
}

/** 状态迁移行：状态 + 阶段 + attempt + 执行器。 */
export function progressLine(state: {
  status?: string;
  phase?: string;
  attempt?: number;
  executor?: string;
}): string {
  const parts = [`[${state.status ?? "?"}`];
  if (state.phase) parts.push(` / ${state.phase}`);
  if (state.attempt !== undefined) parts.push(` (attempt ${state.attempt})`);
  if (state.executor) parts.push(` · ${state.executor}`);
  parts.push("]");
  return parts.join("");
}

/**
 * 路由决策一行摘要（委派时刻的"委派给了谁、为什么"）：
 * - 自动路由/回退（routed=true）：「已自动路由到执行器 X（reason）」
 * - 显式指定：                    「已委派给执行器 X（reason）」
 * 无 executor 时返回 undefined（调用方跳过该行）。
 *
 * 供 jobs-bridge 首轮快照与 subagent-facade 发布首条消息复用——工具渲染
 * （runJobOutput）之外的两个"前台"通道也要在委派那一刻看到路由决策，
 * 而不是等终态摘要才知道选了哪个执行器。
 */
export function routeNote(router?: RouterInfoLike): string | undefined {
  if (!router?.executor) return undefined;
  const reason = router.reason ? `（${router.reason}）` : "";
  return router.routed
    ? `已自动路由到执行器 ${router.executor}${reason}`
    : `已委派给执行器 ${router.executor}${reason}`;
}

/** 统一构建一段会话消息。 */
export function buildSessionMessage(input: SessionMessageInput): string {
  const lines: string[] = [];
  const jobId = input.jobId ?? "—";
  const status = input.status ?? "—";
  const exp = phaseExplanation(status, input.phase);
  lines.push(`cbx ${jobId} ${status}${exp ? `（${exp}）` : ""}`);
  if (input.router?.executor) {
    const routed = input.router.routed ? `（路由：${input.router.reason}）` : "";
    lines.push(`  executor: ${input.router.executor}${routed}`);
  } else if (input.executor) {
    lines.push(`  executor: ${input.executor}`);
  }
  if (input.attempt !== undefined) lines.push(`  attempt:  ${input.attempt}`);
  if (input.changedFilesCount !== undefined) lines.push(`  changed:  ${input.changedFilesCount} 个文件`);
  if (input.reviewVerdict) lines.push(`  review:   ${input.reviewVerdict}`);
  if (input.error) lines.push(`  error:    ${input.error}`);
  if (input.handback) {
    lines.push("");
    lines.push(`handback:\n${input.handback}`);
  }
  if (input.jobDir) lines.push(`  job dir:  ${input.jobDir}`);
  const hints = nextActionHint(status, input.phase, jobId);
  if (hints.length > 0) lines.push(`  下一步:   ${hints.join("；")}`);
  if (input.bridgeNote) lines.push(`  ${input.bridgeNote}`);
  if (input.facadeNote) lines.push(`  ${input.facadeNote}`);

  if (input.statusEvents && input.statusEvents.length > 0) {
    lines.push("");
    lines.push("状态迁移:");
    for (const event of input.statusEvents.slice(-30)) lines.push(`  ${event}`);
  }
  if (input.taskList && input.taskList.length > 0) {
    lines.push("");
    lines.push(`任务清单（${input.taskList.length} 个 cbx job）:`);
    lines.push(formatTaskList(input.taskList));
  }
  if (input.logTail) {
    lines.push("");
    lines.push(`处理消息（agent.log${input.logChars ? `，共 ${input.logChars} 字符` : ""}）:`);
    lines.push(input.logTail);
  }
  return lines.join("\n");
}

/** 便捷：由 workspace+jobId 生成产物目录指针（无该 job 时为 undefined 的错误兜底）。 */
export function jobDirPointer(workspace: string, jobId: string): string {
  return jobDir(workspace, jobId);
}
