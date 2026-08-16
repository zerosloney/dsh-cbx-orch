import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { JobContext } from "./types.js";
import {
  auditAllowsCompletion,
  type StructuredAudit,
  type VerifiedProgress,
} from "./progress.js";

export const AUDIT_EVIDENCE_ARTIFACTS = [
  "complete.patch",
  "test.log",
  "review.md",
  "handback.md",
] as const;

export interface PendingCompletion {
  version: 1;
  evidenceHashes: Record<string, string>;
  worktreeSha256: string;
  createdAt: string;
}

export async function evidenceHashes(
  directory: string,
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const artifact of AUDIT_EVIDENCE_ARTIFACTS) {
    const file = path.join(directory, artifact);
    if (existsSync(file))
      hashes[artifact] = createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
  }
  return hashes;
}

/**
 * 完成证据门：`hashes` 是完成时刻对所有必要 artifact 计算的 SHA-256 映射，
 * 此处检查其"存在性"（`hashes[name]` 为真 = 文件在完成时存在并已哈希），
 * 而非与某个历史基线做完整性比对——本插件不维护完成前的基线哈希。
 * 结构化审计路径额外经 `auditAllowsCompletion` 做哈希值级比对。
 */
/**
 * 该 job 是否"实际上"要求审查证据。job 级 reviewRequested 与 stage 级 skipReview
 * 是两套口径：契约显式让全部 stage 跳过审查时，review.md 不会产出也不应成为完成
 * 前提——否则完成门永远无法通过（verification_gate 死锁）。部分 stage 跳过时仍按
 * 需要审查处理（保守：至少有一个 stage 会产出 review.md）。
 */
export function reviewEffectivelyRequired(context: JobContext): boolean {
  if (!context.reviewRequested) return false;
  const stages = context.taskContract?.stages;
  if (stages?.length && stages.every((stage) => stage.skipReview)) return false;
  return true;
}

export function completionEvidenceValid(
  context: JobContext,
  state: Record<string, unknown>,
  hashes: Record<string, string>,
): boolean {
  const reviewRequired = reviewEffectivelyRequired(context);
  const required = [
    "complete.patch",
    "test.log",
    ...(reviewRequired ? ["review.md"] : []),
  ];
  const reviewOK =
    !reviewRequired ||
    state.reviewVerdict === "PASS" ||
    (!structuredAuditRequested(context) &&
      (state.reviewVerdict === null || state.reviewVerdict === undefined));
  if (
    state.testExitCode !== 0 ||
    !reviewOK ||
    required.some((name) => !hashes[name])
  )
    return false;
  if (!structuredAuditRequested(context)) return true;
  const progress = state.verifiedProgress as VerifiedProgress | undefined;
  return Boolean(
    progress &&
    auditAllowsCompletion(
      state.audit as StructuredAudit | undefined,
      progress,
      reviewRequired
        ? (["complete.patch", "test.log", "review.md"] as const)
        : (["complete.patch", "test.log"] as const),
      hashes,
    ),
  );
}

export function structuredAuditRequested(context: JobContext): boolean {
  const stages = context.taskContract?.stages;
  const anySkip = Boolean(stages?.some((stage) => stage.skipReview));
  if (context.adaptive?.enabled) {
    // adaptive 同样尊重 skipReview：全部跳过审查时不可能产出 audit 证据，强制结构化
    // 审计只会让 Manager 把 maxRounds 烧在 verification_gate 重试上。
    return Boolean(context.taskContract) && reviewEffectivelyRequired(context);
  }
  return Boolean(
    context.taskContract &&
    context.reviewRequested &&
    !anySkip,
  );
}

export function parsePendingCompletion(value: unknown): PendingCompletion {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("pendingCompletion 必须是普通对象。");
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter(
    (key) =>
      !["version", "evidenceHashes", "worktreeSha256", "createdAt"].includes(
        key,
      ),
  );
  if (
    unknown.length ||
    raw.version !== 1 ||
    !raw.evidenceHashes ||
    typeof raw.evidenceHashes !== "object" ||
    Array.isArray(raw.evidenceHashes) ||
    !/^[a-f0-9]{64}$/.test(String(raw.worktreeSha256)) ||
    Number.isNaN(Date.parse(String(raw.createdAt)))
  )
    throw new Error("pendingCompletion 无效。");
  const evidence = raw.evidenceHashes as Record<string, unknown>;
  const evidenceUnknown = Object.keys(evidence).filter(
    (key) => !(AUDIT_EVIDENCE_ARTIFACTS as readonly string[]).includes(key),
  );
  if (
    evidenceUnknown.length ||
    Object.values(evidence).some(
      (hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash),
    )
  )
    throw new Error("pendingCompletion.evidenceHashes 无效。");
  return {
    version: 1,
    evidenceHashes: evidence as Record<string, string>,
    worktreeSha256: String(raw.worktreeSha256),
    createdAt: String(raw.createdAt),
  };
}

export function worktreeSha256(snapshot: unknown): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
