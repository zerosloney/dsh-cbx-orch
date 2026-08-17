import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTaskList } from "../lib/format.js";

test("formatTaskList: 空列表给一行提示", () => {
  assert.equal(formatTaskList([]), "（当前工作区无 cbx job）");
});

test("formatTaskList: 输出对齐表格并保留传入排序", () => {
  const jobs = [
    {
      jobId: "20260101000000-abc123",
      status: "running",
      phase: "executor",
      attempt: 1,
      updatedAt: "2026-01-01T00:00:10.000Z",
    },
    {
      jobId: "20260101000001-def456",
      status: "done",
      phase: "",
      attempt: 0,
      updatedAt: "2026-01-01T00:00:20.000Z",
    },
  ];
  const out = formatTaskList(jobs);
  assert.match(out, /2 个 cbx job:/);
  assert.match(out, /\| 20260101000000-abc123 \| running/);
  assert.match(out, /\| 20260101000001-def456 \| done/);
  // 时间戳归一化（移除 T/Z）且表头对齐列存在
  assert.match(out, /2026-01-01 00:00:10\.000/);
  assert.match(out, /\| Job ID +\| Status/);
  // 最新优先 = 调用方传入顺序；格式化器不得重排
  assert.ok(out.indexOf("20260101000000-abc123") < out.indexOf("20260101000001-def456"));
});

test("formatTaskList: 空 phase/缺字段以 — 容错", () => {
  const out = formatTaskList([
    { jobId: "x", status: "queued", phase: null, attempt: 0, updatedAt: undefined },
  ]);
  assert.match(out, /\| x +\| queued +\| —/);
});

test("formatTaskList: 长 jobId 不破坏表格（截断宽度）", () => {
  const out = formatTaskList([
    { jobId: "20260101000000-" + "z".repeat(40), status: "failed", phase: "test", attempt: 2, updatedAt: "2026-01-01T00:00:00.000Z" },
  ]);
  assert.match(out, /1 个 cbx job:/);
  assert.match(out, /\| 20260101000000-zzzz/);
});