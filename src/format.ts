import type { JobState } from "./types.js";

/**
 * 任务清单（工作区全部 cbx job）的会话内展示格式化器。
 *
 * 供多个显示通道共用（单一事实来源）：
 * - `cbx_list` 工具渲染（tools.ts）
 * - `cbx_run` / `cbx_continue` 提交响应（tools.ts / commands.ts）
 * - 会话内后台任务桥的首轮快照与终态摘要（jobs-bridge.ts）
 *
 * 输出紧凑表格（对齐列），空列表给一行提示。jobs 保持传入顺序
 * （listPersistedStates 返回 updated_at 倒序 = 最新优先）。
 *
 * 审计列：job 携带 `__audit`（{ tampered, valid }）时展示审计完整性状态——
 * `篡改!` = ndjson 与 SQLite 镜像漂移（执行器可能篡改）；`✓` = 通过；`—` = 无法验证。
 */
export function formatTaskList(jobs: readonly JobState[]): string {
  if (jobs.length === 0) return "（当前工作区无 cbx job）";
  const lines: string[] = [];
  lines.push(`${jobs.length} 个 cbx job:`);
  lines.push("");
  lines.push("| Job ID              | Status       | Phase        | Attempt | Audit   | Updated                 |");
  lines.push("|---------------------|--------------|--------------|---------|---------|-------------------------|");
  for (const job of jobs) {
    const id = String(job.jobId ?? "—");
    const status = String(job.status ?? "—");
    const phase = typeof job.phase === "string" && job.phase ? job.phase : "—";
    const attempt = typeof job.attempt === "number" ? String(job.attempt) : "—";
    const audit = auditBadge(job);
    const updated =
      typeof job.updatedAt === "string"
        ? job.updatedAt.replace("T", " ").replace("Z", "")
        : "—";
    lines.push(
      `| ${id.padEnd(19)} | ${status.padEnd(12)} | ${phase.padEnd(12)} | ${attempt.padEnd(7)} | ${audit.padEnd(7)} | ${updated.padEnd(23)} |`,
    );
  }
  return lines.join("\n");
}

/** 审计完整性徽标：`篡改!` / `✓` / `—`。 */
function auditBadge(job: JobState): string {
  const audit = (job as JobState & { __audit?: { tampered?: boolean; valid?: boolean } }).__audit;
  if (!audit) return "—";
  if (audit.tampered) return "篡改!";
  if (audit.valid) return "✓";
  return "—";
}