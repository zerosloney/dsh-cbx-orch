import { test } from "node:test";
import assert from "node:assert/strict";
import {
  criterionDefinitions,
  parseStructuredAudit,
  reconcileVerifiedProgress,
  auditAllowsCompletion,
} from "../lib/progress.js";

const SHA = (char) => char.repeat(64);
const hashes = {
  "complete.patch": SHA("a"),
  "test.log": SHA("b"),
  "review.md": SHA("c"),
};

function definitions() {
  return criterionDefinitions(["验收一", "验收二"]);
}

function validAudit(defs) {
  return {
    version: 1,
    completion: "complete",
    cleanliness: "clean",
    alignment: "aligned",
    criteria: [
      { id: defs[0].id, status: "verified", evidence: ["complete.patch"] },
      { id: defs[1].id, status: "verified", evidence: ["test.log"] },
    ],
  };
}

test("criterionDefinitions: 去重后的 id 确定且唯一", () => {
  const defs = criterionDefinitions(["x", "x"]);
  assert.equal(defs[0].id, defs[0].id);
  assert.notEqual(defs[0].id, defs[1].id);
  assert.match(defs[0].id, /^criterion-[a-f0-9]{16}$/);
});

test("parseStructuredAudit: 接受合法审计，拒绝越界证据", () => {
  const defs = definitions();
  assert.doesNotThrow(() => parseStructuredAudit(validAudit(defs), defs, hashes));
  const badEvidence = validAudit(defs);
  badEvidence.criteria[0].evidence = ["not-an-artifact"];
  assert.throws(() => parseStructuredAudit(badEvidence, defs, hashes), /不允许/);
  const incomplete = validAudit(defs);
  incomplete.completion = "complete";
  incomplete.criteria[1].status = "unverified";
  assert.throws(() => parseStructuredAudit(incomplete, defs, hashes), /complete/);
  const dup = validAudit(defs);
  dup.criteria = [dup.criteria[0], dup.criteria[0]];
  assert.throws(() => parseStructuredAudit(dup, defs, hashes), /重复/);
});

test("auditAllowsCompletion: 证据缺失/进度未满/审计不合格都不放行", () => {
  const defs = definitions();
  const audit = parseStructuredAudit(validAudit(defs), defs, hashes);
  const progress = reconcileVerifiedProgress(defs, undefined, audit, hashes);
  assert.equal(auditAllowsCompletion(audit, progress, ["complete.patch", "test.log"], hashes), true);
  // 证据缺失
  assert.equal(auditAllowsCompletion(audit, progress, ["complete.patch", "missing"], hashes), false);
  // 审计要求未满
  const dirty = validAudit(defs);
  dirty.cleanliness = "suspect";
  assert.equal(auditAllowsCompletion(dirty, progress, ["complete.patch"], hashes), false);
});

test("reconcileVerifiedProgress: 哈希匹配时保留 verified，变更后 invalidated", () => {
  const defs = definitions();
  const audit = parseStructuredAudit(validAudit(defs), defs, hashes);
  const progress = reconcileVerifiedProgress(defs, undefined, audit, hashes);
  assert.ok(progress.criteria.every((c) => c.status === "verified"));
  // 证据被改动：hash 不再匹配 → invalidated
  const changedHashes = { ...hashes, "complete.patch": SHA("d") };
  const reconciled = reconcileVerifiedProgress(defs, progress, audit, changedHashes);
  assert.equal(reconciled.criteria[0].status, "invalidated");
  assert.equal(reconciled.criteria[1].status, "verified");
});
