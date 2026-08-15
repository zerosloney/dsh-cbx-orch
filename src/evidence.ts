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

export function completionEvidenceValid(
  context: JobContext,
  state: Record<string, unknown>,
  hashes: Record<string, string>,
): boolean {
  const required = [
    "complete.patch",
    "test.log",
    ...(context.reviewRequested ? ["review.md"] : []),
  ];
  const reviewOK =
    !context.reviewRequested ||
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
      ["complete.patch", "test.log", "review.md"] as const,
      hashes,
    ),
  );
}

export function structuredAuditRequested(context: JobContext): boolean {
  if (context.adaptive?.enabled)
    return Boolean(context.taskContract && context.reviewRequested);
  return Boolean(
    context.taskContract &&
    context.reviewRequested &&
    !context.taskContract.stages?.some((stage) => stage.skipReview),
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
