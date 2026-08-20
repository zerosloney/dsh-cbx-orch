import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recordExecutorOutcome, loadHealth, resetHealthStore } from "../lib/executor-health.js";

// 每个测试用独立临时目录作 workspace，避免 loadHealth 在内存为空时读到上一次运行的残留文件。
async function withWs(fn) {
  resetHealthStore();
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-hlth-"));
  try {
    return await fn(ws);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}

test("recordExecutorOutcome: 成功累加 successes 并清零连续失败", async () => {
  await withWs((ws) => {
    recordExecutorOutcome(ws, "qwen", { success: true, latencyMs: 100 });
    recordExecutorOutcome(ws, "qwen", { success: true, latencyMs: 120 });
    const rec = loadHealth(ws).qwen;
    assert.equal(rec.successes, 2);
    assert.equal(rec.failures, 0);
    assert.equal(rec.consecutiveFailures, 0);
    assert.equal(rec.lastLatencyMs, 120);
    assert.ok(rec.lastUsedAt);
  });
});

test("recordExecutorOutcome: 失败累加 failures 与连续失败，成功后清零", async () => {
  await withWs((ws) => {
    recordExecutorOutcome(ws, "omp", { success: false });
    recordExecutorOutcome(ws, "omp", { success: false });
    let rec = loadHealth(ws).omp;
    assert.equal(rec.failures, 2);
    assert.equal(rec.consecutiveFailures, 2);
    recordExecutorOutcome(ws, "omp", { success: true });
    rec = loadHealth(ws).omp;
    assert.equal(rec.consecutiveFailures, 0);
  });
});

test("loadHealth: 不同 workspace 互相隔离", async () => {
  resetHealthStore();
  const a = await mkdtemp(path.join(os.tmpdir(), "cbx-hlth-"));
  const b = await mkdtemp(path.join(os.tmpdir(), "cbx-hlth-"));
  try {
    recordExecutorOutcome(a, "qwen", { success: true });
    assert.ok(loadHealth(a).qwen);
    assert.equal(loadHealth(b).qwen, undefined);
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test("recordExecutorOutcome: 无延迟时不记录 lastLatencyMs", async () => {
  await withWs((ws) => {
    recordExecutorOutcome(ws, "cline", { success: true });
    const rec = loadHealth(ws).cline;
    assert.equal(rec.lastLatencyMs, undefined);
  });
});
