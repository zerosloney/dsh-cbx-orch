import { createHash } from "node:crypto";

export type AuditCompletion = "complete" | "incomplete" | "blocked";
export type AuditCleanliness = "clean" | "suspect" | "violation";
export type AuditAlignment = "aligned" | "unknown" | "needs_revision" | "invalid";
export type CriterionStatus = "verified" | "unverified" | "blocked" | "invalidated";

export interface CriterionDefinition { id: string; criterion: string; }
export interface EvidenceReference { artifact: string; sha256: string; }
export interface CriterionJudgement { id: string; criterion: string; status: CriterionStatus; evidence: EvidenceReference[]; }
export interface StructuredAudit {
  version: 1;
  completion: AuditCompletion;
  cleanliness: AuditCleanliness;
  alignment: AuditAlignment;
  criteria: CriterionJudgement[];
}
export interface VerifiedProgress { version: 1; criteria: CriterionJudgement[]; }

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} 必须是对象。`);
  return value as Record<string, unknown>;
}

function known(value: Record<string, unknown>, name: string, fields: string[]): void {
  const unknown = Object.keys(value).filter(key => !fields.includes(key));
  if (unknown.length) throw new Error(`${name} 不支持字段：${unknown.join(", ")}`);
}

function enumeration<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${name} 必须是 ${allowed.join("/")} 之一。`);
  return value as T;
}

export function criterionDefinitions(criteria: string[]): CriterionDefinition[] {
  const occurrences = new Map<string, number>();
  return criteria.map(criterion => {
    const occurrence = occurrences.get(criterion) ?? 0;
    occurrences.set(criterion, occurrence + 1);
    const identity = occurrence === 0 ? criterion : `${criterion}\0${occurrence}`;
    return { id: `criterion-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`, criterion };
  });
}

export function parseStructuredAudit(value: unknown, definitions: CriterionDefinition[], evidenceHashes: Record<string, string>): StructuredAudit {
  const audit = object(value, "audit");
  known(audit, "audit", ["version", "completion", "cleanliness", "alignment", "criteria"]);
  if (audit.version !== 1) throw new Error("audit.version 必须是 1。");
  const completion = enumeration(audit.completion, "audit.completion", ["complete", "incomplete", "blocked"] as const);
  const cleanliness = enumeration(audit.cleanliness, "audit.cleanliness", ["clean", "suspect", "violation"] as const);
  const alignment = enumeration(audit.alignment, "audit.alignment", ["aligned", "unknown", "needs_revision", "invalid"] as const);
  if (!Array.isArray(audit.criteria)) throw new Error("audit.criteria 必须是数组。");
  const expected = new Map(definitions.map(item => [item.id, item]));
  const seen = new Set<string>();
  const criteria = audit.criteria.map((item, index): CriterionJudgement => {
    const judgement = object(item, `audit.criteria[${index}]`);
    known(judgement, `audit.criteria[${index}]`, ["id", "status", "evidence"]);
    if (typeof judgement.id !== "string" || !expected.has(judgement.id)) throw new Error(`audit.criteria[${index}].id 未知。`);
    if (seen.has(judgement.id)) throw new Error(`audit.criteria[${index}].id 重复。`);
    seen.add(judgement.id);
    const status = enumeration(judgement.status, `audit.criteria[${index}].status`, ["verified", "unverified", "blocked"] as const);
    if (!Array.isArray(judgement.evidence) || judgement.evidence.some(artifact => typeof artifact !== "string")) throw new Error(`audit.criteria[${index}].evidence 必须是字符串数组。`);
    const artifacts = judgement.evidence as string[];
    if (new Set(artifacts).size !== artifacts.length) throw new Error(`audit.criteria[${index}].evidence 不能重复。`);
    const evidence = artifacts.map(artifact => {
      const sha256 = evidenceHashes[artifact];
      if (!Object.hasOwn(evidenceHashes, artifact) || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`audit.criteria[${index}].evidence 引用了不允许或不存在的产物：${artifact}`);
      return { artifact, sha256 };
    });
    if (status === "verified" && evidence.length === 0) throw new Error(`audit.criteria[${index}] 标记 verified 时必须引用证据。`);
    return { ...expected.get(judgement.id)!, status, evidence };
  });
  if (criteria.length !== definitions.length || seen.size !== expected.size) throw new Error("audit.criteria 必须完整覆盖所有验收标准。");
  if (completion === "complete" && criteria.some(item => item.status !== "verified")) throw new Error("audit.completion=complete 时所有验收标准必须是 verified。");
  return { version: 1, completion, cleanliness, alignment, criteria };
}

function validReference(reference: EvidenceReference, evidenceHashes: Record<string, string>): boolean {
  return evidenceHashes[reference.artifact] === reference.sha256;
}

export function reconcileVerifiedProgress(definitions: CriterionDefinition[], previous: VerifiedProgress | undefined, audit: StructuredAudit | undefined, evidenceHashes: Record<string, string>): VerifiedProgress {
  const old = new Map((previous?.criteria ?? []).map(item => [item.id, item]));
  const current = new Map((audit?.criteria ?? []).map(item => [item.id, item]));
  return {
    version: 1,
    criteria: definitions.map(definition => {
      const judgement = current.get(definition.id);
      if (judgement?.status === "verified") {
        const valid = judgement.evidence.length > 0 && judgement.evidence.every(reference => validReference(reference, evidenceHashes));
        return valid ? judgement : { ...definition, status: "invalidated", evidence: judgement.evidence };
      }
      const prior = old.get(definition.id);
      if (prior?.status === "verified") {
        const valid = prior.evidence.length > 0 && prior.evidence.every(reference => validReference(reference, evidenceHashes));
        return { ...definition, status: valid ? "verified" : "invalidated", evidence: prior.evidence };
      }
      return judgement ?? { ...definition, status: "unverified", evidence: [] };
    }),
  };
}

export function auditAllowsCompletion(audit: StructuredAudit | undefined, progress: VerifiedProgress, requiredEvidence: string[], evidenceHashes: Record<string, string>): boolean {
  return audit?.completion === "complete"
    && audit.cleanliness === "clean"
    && audit.alignment === "aligned"
    && progress.criteria.every(item => item.status === "verified")
    && requiredEvidence.every(artifact => Boolean(evidenceHashes[artifact]));
}
