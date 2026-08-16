import { test } from "node:test";
import assert from "node:assert/strict";
import {
  completionEvidenceValid,
  structuredAuditRequested,
  reviewEffectivelyRequired,
} from "../lib/evidence.js";

const SHA = (char) => char.repeat(64);
const hashes = {
  "complete.patch": SHA("a"),
  "test.log": SHA("b"),
  "review.md": SHA("c"),
};

const baseContext = {
  reviewRequested: true,
  testCommand: "echo t",
  executor: "x",
  maxTurns: 10,
  timeoutMs: 1000,
  maxRetries: 1,
  executionRetries: 1,
  fixRetries: 1,
  isolated: true,
  permissionMode: "default",
  workspace: ".",
  jobId: "j",
  createdAt: "2026-01-01T00:00:00Z",
  appVersion: "0.1.0",
  trustMode: "trusted",
};

const passedState = { testExitCode: 0, reviewVerdict: null };

test("reviewEffectivelyRequired: 全部 skipReview 时不要求审查证据", () => {
  const allSkip = {
    ...baseContext,
    taskContract: {
      stages: [
        { name: "a", executor: "x", task: "t", skipReview: true },
        { name: "b", executor: "x", task: "t", skipReview: true },
      ],
    },
  };
  assert.equal(reviewEffectivelyRequired(allSkip), false);
  const partial = {
    ...baseContext,
    taskContract: {
      stages: [
        { name: "a", executor: "x", task: "t", skipReview: true },
        { name: "b", executor: "x", task: "t" },
      ],
    },
  };
  assert.equal(reviewEffectivelyRequired(partial), true);
  assert.equal(reviewEffectivelyRequired(baseContext), true);
  assert.equal(reviewEffectivelyRequired({ ...baseContext, reviewRequested: false }), false);
});

test("completionEvidenceValid: skipReview 任务无 review.md 也能通过完成门（死锁修复）", () => {
  const allSkip = {
    ...baseContext,
    taskContract: {
      stages: [
        { name: "a", executor: "x", task: "t", skipReview: true },
        { name: "b", executor: "x", task: "t", skipReview: true },
      ],
    },
  };
  // 无 review.md 哈希（review 从未运行），verdict null —— 旧实现卡死，现在放行
  const noReviewHashes = { "complete.patch": SHA("a"), "test.log": SHA("b") };
  assert.equal(
    completionEvidenceValid(allSkip, passedState, noReviewHashes),
    true,
  );
  // 普通任务仍要求 review.md
  assert.equal(
    completionEvidenceValid(baseContext, passedState, noReviewHashes),
    false,
  );
});

test("completionEvidenceValid: 测试失败/审查 FAIL 不过门", () => {
  assert.equal(
    completionEvidenceValid(baseContext, { testExitCode: 1, reviewVerdict: null }, hashes),
    false,
  );
  assert.equal(
    completionEvidenceValid(baseContext, { testExitCode: 0, reviewVerdict: "FAIL" }, hashes),
    false,
  );
  assert.equal(
    completionEvidenceValid(baseContext, { testExitCode: 0, reviewVerdict: "PASS" }, hashes),
    true,
  );
});

test("structuredAuditRequested: adaptive 路径同样尊重 skipReview", () => {
  const adaptive = {
    ...baseContext,
    adaptive: { enabled: true, maxRounds: 5, managerExecutor: "x" },
    taskContract: { goal: "g" },
  };
  assert.equal(structuredAuditRequested(adaptive), true);
  const adaptiveAllSkip = {
    ...adaptive,
    taskContract: {
      goal: "g",
      stages: [{ name: "a", executor: "x", task: "t", skipReview: true }],
    },
  };
  assert.equal(structuredAuditRequested(adaptiveAllSkip), false);
});
