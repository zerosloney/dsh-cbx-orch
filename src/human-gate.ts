import { createHash } from "node:crypto";

export type HumanGateReason = "before_run" | "needs_input" | "semantic_conflict" | "repeated_failure" | "max_rounds" | "completion";
export type HumanGateStatus = "waiting" | "resolved";

export interface HumanGate {
  version: 1;
  reason: HumanGateReason;
  status: HumanGateStatus;
  questions?: string[];
  detail?: string;
  instructions?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface FailureTracker { key: string; count: number; reason: string; }
const REASONS = new Set<HumanGateReason>(["before_run", "needs_input", "semantic_conflict", "repeated_failure", "max_rounds", "completion"]);

function plain(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function text(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} 必须是长度不超过 ${max} 的非空字符串。`);
  return value.trim();
}

export function parseHumanGate(value: unknown): HumanGate {
  if (!plain(value)) throw new Error("humanGate 必须是普通对象。");
  const allowed = ["version", "reason", "status", "questions", "detail", "instructions", "createdAt", "resolvedAt"];
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error(`humanGate 不支持字段：${unknown.join(", ")}`);
  if (value.version !== 1) throw new Error("humanGate.version 必须为 1。");
  if (!REASONS.has(value.reason as HumanGateReason)) throw new Error("humanGate.reason 无效。");
  if (value.status !== "waiting" && value.status !== "resolved") throw new Error("humanGate.status 无效。");
  const questions = value.questions === undefined ? undefined : (() => {
    if (!Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 20) throw new Error("humanGate.questions 必须包含 1 到 20 个问题。");
    return value.questions.map((item, index) => text(item, `humanGate.questions[${index}]`, 1_000)!);
  })();
  const createdAt = text(value.createdAt, "humanGate.createdAt", 64)!;
  if (Number.isNaN(Date.parse(createdAt))) throw new Error("humanGate.createdAt 必须是有效时间。");
  const resolvedAt = text(value.resolvedAt, "humanGate.resolvedAt", 64);
  if (resolvedAt && Number.isNaN(Date.parse(resolvedAt))) throw new Error("humanGate.resolvedAt 必须是有效时间。");
  if (value.status === "waiting" && resolvedAt) throw new Error("waiting humanGate 不能包含 resolvedAt。");
  if (value.status === "resolved" && !resolvedAt) throw new Error("resolved humanGate 必须包含 resolvedAt。");
  return { version: 1, reason: value.reason as HumanGateReason, status: value.status, questions, detail: text(value.detail, "humanGate.detail", 2_000), instructions: text(value.instructions, "humanGate.instructions", 4_000), createdAt, resolvedAt };
}

export function createHumanGate(reason: HumanGateReason, options: { questions?: string[]; detail?: string } = {}): HumanGate {
  return parseHumanGate({ version: 1, reason, status: "waiting", questions: options.questions, detail: options.detail, createdAt: new Date().toISOString() });
}

export function resolveHumanGate(value: unknown, instructions: string, redact: (text: string) => string): HumanGate {
  const gate = parseHumanGate(value);
  if (gate.status !== "waiting") throw new Error("humanGate 已解决，不能重复 resolve。");
  const safe = redact(instructions).trim().slice(0, 4_000);
  return parseHumanGate({ ...gate, status: "resolved", instructions: safe || undefined, resolvedAt: new Date().toISOString() });
}

export function extendRoundLimit(current: number, extra: unknown, totalLimit = 100): number {
  if (!Number.isInteger(extra) || Number(extra) < 1) throw new Error("extra_rounds 必须是正整数。");
  const next = current + Number(extra);
  if (next > totalLimit) throw new Error(`Adaptive 累计轮次不能超过 ${totalLimit}。`);
  return next;
}

export function trackFailure(previous: unknown, reason: string): FailureTracker {
  const normalized = reason.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 2_000);
  const key = createHash("sha256").update(normalized).digest("hex");
  if (plain(previous) && previous.key === key && Number.isInteger(previous.count) && Number(previous.count) > 0) return { key, count: Number(previous.count) + 1, reason: reason.slice(0, 2_000) };
  return { key, count: 1, reason: reason.slice(0, 2_000) };
}
