import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSessionMessage,
  phaseExplanation,
  nextActionHint,
  progressLine,
} from "../lib/session-message.js";

test("phaseExplanation: 状态+阶段 → 人话", () => {
  assert.equal(phaseExplanation("queued"), "已入队，等待调度");
  assert.equal(phaseExplanation("running"), "执行器正在改代码");
  assert.equal(phaseExplanation("running", "testing"), "执行完成，正在跑测试");
  assert.equal(phaseExplanation("running", "reviewing"), "测试通过，独立审查中");
  assert.equal(phaseExplanation("awaiting_approval", "before_run"), "执行前等待审批");
  assert.equal(phaseExplanation("awaiting_approval", "before_complete"), "完成前等待审批");
  assert.equal(phaseExplanation("needs_fix", "awaiting_clarification"), "等待补充说明");
  assert.equal(phaseExplanation("needs_fix", "completion_evidence_stale"), "完成证据已变化，需重跑验证");
  assert.equal(phaseExplanation("done"), "已完成");
  assert.equal(phaseExplanation("failed"), "已失败");
});

test("nextActionHint: 可行动命令", () => {
  assert.deepEqual(nextActionHint("awaiting_approval", "before_run", "j1"), ["批准：cbx_approve j1", "取消：cbx_cancel j1"]);
  assert.deepEqual(nextActionHint("needs_fix", "awaiting_clarification", "j1"), ["补充说明后续跑：cbx_continue j1 <说明>"]);
  assert.deepEqual(nextActionHint("done", "done", "j1"), ["读结果 / 产物：cbx_result j1"]);
  assert.deepEqual(nextActionHint("running", "executing", "j1")[0], "跟踪进度：cbx_watch j1");
});

test("progressLine: 状态/阶段/attempt/执行器", () => {
  assert.equal(progressLine({ status: "running", phase: "executing", attempt: 1 }), "[running / executing (attempt 1)]");
  assert.equal(progressLine({ status: "running", phase: "executing", attempt: 1, executor: "qwen" }), "[running / executing (attempt 1) · qwen]");
  assert.equal(progressLine({ status: "done" }), "[done]");
});

test("buildSessionMessage: 富化字段齐全", () => {
  const text = buildSessionMessage({
    jobId: "2026-probe",
    status: "needs_fix",
    phase: "awaiting_clarification",
    attempt: 2,
    executor: "codebuddy",
    error: "some error",
    jobDir: "C:/ws/.cbx/jobs/2026-probe",
    statusEvents: ["[running / executing (attempt 1)]", "[needs_fix / awaiting_clarification (attempt 2)]"],
    logTail: "LOGTAIL",
    taskList: [{ jobId: "2026-probe", status: "needs_fix", phase: "awaiting_clarification", attempt: 2, updatedAt: "2026-01-01T00:00:00.000Z" }],
  });
  assert.match(text, /cbx 2026-probe needs_fix（等待补充说明）/);
  assert.match(text, /executor: codebuddy/);
  assert.match(text, /下一步:.*cbx_continue 2026-probe <说明>/);
  assert.match(text, /job dir:  C:\/ws\/\.cbx\/jobs\/2026-probe/);
  assert.match(text, /状态迁移:/);
  assert.match(text, /处理消息（agent\.log）:/);
  assert.match(text, /LOGTAIL/);
  assert.match(text, /1 个 cbx job/);
});

test("buildSessionMessage: 完成态带下一步行读产物", () => {
  const text = buildSessionMessage({
    jobId: "j9",
    status: "done",
    phase: "done",
    attempt: 1,
    executor: "qwen",
    changedFilesCount: 3,
    reviewVerdict: "PASS",
  });
  assert.match(text, /cbx j9 done（已完成）/);
  assert.match(text, /executor: qwen/);
  assert.match(text, /changed:  3 个文件/);
  assert.match(text, /review:   PASS/);
  assert.match(text, /下一步:.*cbx_result j9/);
});
