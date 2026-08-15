import { mkdtemp, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { invokeExecutor, loadConfig } from "./core.js";
import { snapshotDiff } from "./git-ops.js";
import type { ProcessResult } from "./process-runner.js";

export interface ReviewGateResult {
  pass: boolean;
  reason: string;
  review: string;
  verdict: string;
}

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_MAX_TURNS = 50;

/**
 * 对主工作区未提交改动跑一次独立 review。不创建 job/worktree。
 * 复用 invokeExecutor + snapshotDiff。fail-open：执行异常时 pass:true（不阻塞主会话）。
 */
export async function runReviewGate(workspaceInput: string, options: { executor?: string; reviewRules?: string; timeoutMs?: number; maxTurns?: number; permissionMode?: string } = {}): Promise<ReviewGateResult> {
  const workspace = path.resolve(workspaceInput);
  const config = await loadConfig(workspace);
  const executor = options.executor ?? config.executor ?? "codebuddy";
  const reviewRules = options.reviewRules ?? config.reviewRules;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const permissionMode = options.permissionMode ?? config.permissionMode ?? "default";

  const snapshot = await snapshotDiff(workspace);
  if (!snapshot.status.trim() && !snapshot.complete.trim()) {
    return { pass: true, reason: "无未提交改动，跳过 review", review: "", verdict: "SKIP" };
  }

  // intentional-simple: 临时目录承载 review 产物，跑完即由 OS 清理。不需要 jobDir 持久化。
  const directory = await mkdtemp(path.join(os.tmpdir(), "cbx-review-gate-"));
  const patchFile = path.join(directory, "complete.patch");
  const statusFile = path.join(directory, "git-status.txt");
  const untrackedFile = path.join(directory, "untracked-files.txt");
  const reviewFile = path.join(directory, "review.md");
  await writeFile(patchFile, snapshot.complete, "utf8");
  await writeFile(statusFile, snapshot.status, "utf8");
  await writeFile(untrackedFile, snapshot.untracked, "utf8");

  const extra = `审查以下材料：\n- ${patchFile}\n- ${statusFile}\n- ${untrackedFile}\n\n不要修改代码。将结果写入 ${reviewFile}。第一行必须是 VERDICT: PASS 或 VERDICT: FAIL。按严重程度列出问题、文件和行号。\n\n审查规则：\n${reviewRules ?? "关注正确性、回归风险、安全性、测试覆盖和改动范围。"}`;
  const prompt = `你是独立审查代理。\n\n当前阶段：stop-gate review\n\n${extra}\n\n持久化要求：\n- 将审查结果写入 ${reviewFile}。\n- 报告必须包含 VERDICT 与问题清单。\n- 不要把关键信息只放在聊天输出中。\n`;

  let result: ProcessResult;
  try {
    result = await invokeExecutor(executor, workspace, directory, workspace, prompt, permissionMode, maxTurns, timeoutMs);
  } catch (error) {
    return { pass: true, reason: `审查执行异常（fail-open 放行）：${error instanceof Error ? error.message : String(error)}`, review: "", verdict: "ERROR" };
  }

  if (result.timedOut) return { pass: true, reason: `审查超时（${timeoutMs}ms），fail-open 放行；可手动跑 cbx review-gate 复核`, review: "", verdict: "TIMEOUT" };
  if (result.code !== 0) return { pass: true, reason: `审查代理退出码 ${result.code}，fail-open 放行；可手动跑 cbx review-gate 复核`, review: "", verdict: "ERROR" };

  let review = "";
  try { review = await readFile(reviewFile, "utf8"); } catch { review = result.output; }
  const firstLine = review.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0].trim();
  const pass = /^VERDICT\s*:\s*PASS$/i.test(firstLine);
  const fail = /^VERDICT\s*:\s*FAIL$/i.test(firstLine);
  if (pass) return { pass: true, reason: "审查通过", review, verdict: "PASS" };
  if (fail) return { pass: false, reason: `审查发现问题：\n${review}`, review, verdict: "FAIL" };
  return { pass: true, reason: `审查输出无法解析 VERDICT（fail-open 放行）；首行：${firstLine || "<空>"}`, review, verdict: "UNKNOWN" };
}

export function gateEnabled(enabled: unknown): boolean { return enabled === true; }

export function stopGateDecision(result: ReviewGateResult): { decision: "block"; reason: string } | null {
  if (result.pass) return null;
  return { decision: "block", reason: result.reason };
}

export async function shouldRunGate(workspace: string): Promise<boolean> {
  const config = await loadConfig(workspace);
  return config.reviewGate?.enabled === true;
}

/** 供 hooks/stop-review-gate.js 调用的入口：返回 JSON decision 或 null（放行）。fail-open。 */
export async function stopReviewGateHook(workspaceInput: string): Promise<{ decision: "block"; reason: string } | null> {
  const workspace = path.resolve(workspaceInput);
  try {
    // shouldRunGate 内部读 .cbx.json；配置非法（如未知字段）会让 loadConfig 抛异常，必须纳入 fail-open，否则 hook 逃逸为 exitCode=1 破坏放行契约
    if (!(await shouldRunGate(workspace))) return null;
    const result = await runReviewGate(workspace);
    return stopGateDecision(result);
  } catch (error) {
    process.stderr.write(`cbx review-gate 异常（fail-open 放行）：${error instanceof Error ? error.message : String(error)}\n`);
    return null;
  }
}
