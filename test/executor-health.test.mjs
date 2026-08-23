import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recordExecutorOutcome,
  loadHealth,
  resetHealthStore,
  flushHealthStore,
  windowStats,
  HEALTH_WINDOW_SIZE,
} from "../lib/executor-health.js";

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

test("recordExecutorOutcome: 超时与崩溃分开计数，成功清零两者", async () => {
  await withWs((ws) => {
    recordExecutorOutcome(ws, "qwen", { success: false, kind: "timeout" });
    recordExecutorOutcome(ws, "qwen", { success: false, kind: "timeout" });
    let rec = loadHealth(ws).qwen;
    assert.equal(rec.failures, 2);
    assert.equal(rec.timeouts, 2);
    assert.equal(rec.consecutiveFailures, 2);
    assert.equal(rec.consecutiveTimeouts, 2);
    assert.equal(rec.lastFailureKind, "timeout");
    // 非超时失败打断连续超时（进程能 fail-fast 说明还活着），但连续失败继续累计
    recordExecutorOutcome(ws, "qwen", { success: false, kind: "failure" });
    rec = loadHealth(ws).qwen;
    assert.equal(rec.failures, 3);
    assert.equal(rec.consecutiveFailures, 3);
    assert.equal(rec.consecutiveTimeouts, 0);
    assert.equal(rec.lastFailureKind, "failure");
    assert.equal(rec.timeouts, 2);
    // 成功把两类连败与 lastFailureKind 全部清掉
    recordExecutorOutcome(ws, "qwen", { success: true });
    rec = loadHealth(ws).qwen;
    assert.equal(rec.consecutiveFailures, 0);
    assert.equal(rec.consecutiveTimeouts, 0);
    assert.equal(rec.lastFailureKind, undefined);
  });
});

test("recordExecutorOutcome: 缺省 kind 按 failure 记（兼容旧调用方）", async () => {
  await withWs((ws) => {
    recordExecutorOutcome(ws, "omp", { success: false });
    const rec = loadHealth(ws).omp;
    assert.equal(rec.lastFailureKind, "failure");
    assert.equal(rec.timeouts, undefined);
    assert.equal(rec.consecutiveTimeouts, 0);
  });
});

test("recordExecutorOutcome: 延迟样本跨成功与失败累计，可算实测平均", async () => {
  await withWs((ws) => {
    recordExecutorOutcome(ws, "qwen", { success: true, latencyMs: 100 });
    recordExecutorOutcome(ws, "qwen", { success: false, kind: "timeout", latencyMs: 300 });
    recordExecutorOutcome(ws, "qwen", { success: true, latencyMs: 200 });
    const rec = loadHealth(ws).qwen;
    assert.equal(rec.latencySamples, 3);
    assert.equal(rec.totalLatencyMs, 600);
    assert.equal(rec.lastLatencyMs, 200);
    // 无延迟的调用不计入样本
    recordExecutorOutcome(ws, "qwen", { success: true });
    assert.equal(rec.latencySamples, 3);
    assert.equal(Math.round(rec.totalLatencyMs / rec.latencySamples), 200);
  });
});

test("滑动窗口：只保留最近 HEALTH_WINDOW_SIZE 条，旧样本出局", async () => {
  await withWs((ws) => {
    for (let i = 0; i < HEALTH_WINDOW_SIZE + 5; i++) {
      recordExecutorOutcome(ws, "qwen", { success: i % 2 === 0, latencyMs: 10 });
    }
    const rec = loadHealth(ws).qwen;
    assert.equal(rec.recent.length, HEALTH_WINDOW_SIZE);
    // 最老的 5 条（含开头的成功）已被挤出：窗口内第一条应是第 6 次调用=失败
    assert.equal(rec.recent[0].s, 0);
    // 终身计数不受窗口裁剪影响（审计口径）
    assert.equal(rec.successes, 13);
    assert.equal(rec.failures, 12);
  });
});

test("windowStats: 连败从窗口尾部推导，段内超时/崩溃构成分别累计", () => {
  // 尾部失败段 [超时, 超时, 崩溃]：旧计数器口径会把整段按崩溃计罚（崩溃清零
  // 连续超时）；窗口保留真实构成——超时 2 + 崩溃 1。
  const stats = windowStats({
    successes: 2,
    failures: 4,
    consecutiveFailures: 3,
    recent: [
      { s: 1, ms: 100 },
      { s: 0, t: 1, ms: 500 },
      { s: 0, t: 1, ms: 600 },
      { s: 0, ms: 50 }, // 尾部最后是崩溃
    ],
  });
  assert.equal(stats.samples, 4);
  assert.equal(stats.successes, 1);
  assert.equal(stats.failures, 3);
  assert.equal(stats.timeouts, 2);
  assert.equal(stats.timeoutStreak, 2);
  assert.equal(stats.crashStreak, 1);
  assert.equal(stats.latencySamples, 4);
  assert.equal(stats.totalLatencyMs, 1250);
});

test("windowStats: 窗口尾部全超时 → timeoutStreak 完整；成功收尾 → 双清零", () => {
  const allTimeout = windowStats({
    recent: [{ s: 0, t: 1 }, { s: 0, t: 1 }],
  });
  assert.equal(allTimeout.timeoutStreak, 2);
  assert.equal(allTimeout.crashStreak, 0);
  const endsWithSuccess = windowStats({
    consecutiveFailures: 9,
    consecutiveTimeouts: 9,
    recent: [{ s: 0, t: 1 }, { s: 1 }],
  });
  assert.equal(endsWithSuccess.crashStreak, 0);
  assert.equal(endsWithSuccess.timeoutStreak, 0);
});

test("windowStats: 旧格式记录（无 recent）回退累计字段", () => {
  const legacy = windowStats({
    successes: 7,
    failures: 3,
    consecutiveFailures: 2,
    consecutiveTimeouts: 1,
    timeouts: 1,
    latencySamples: 10,
    totalLatencyMs: 5000,
  });
  assert.equal(legacy.samples, 10);
  assert.equal(legacy.crashStreak, 1);
  assert.equal(legacy.timeoutStreak, 1);
  assert.equal(legacy.latencySamples, 10);
});

// ---------------------------------------------------------------------------
// 落盘防抖：窗口合并 + flushHealthStore 冲刷
// ---------------------------------------------------------------------------

test("recordExecutorOutcome: 多次调用合并为一次落盘（flushHealthStore 后文件为最新状态）", async () => {
  await withWs(async (ws) => {
    const file = path.join(ws, ".cbx", "executor-health.json");
    // 窗口内连续 5 次记录（原实现会触发 5 次写盘）
    for (let i = 0; i < 5; i++) {
      recordExecutorOutcome(ws, "qwen", { success: true, latencyMs: 100 + i });
    }
    // 防抖窗口内文件不应立即出现（合并中）
    assert.equal(existsSync(file), false);
    // 冲刷后落盘，且内容为最新（5 次成功）
    await flushHealthStore(ws);
    assert.equal(existsSync(file), true);
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(persisted.qwen.successes, 5);
    assert.equal(persisted.qwen.lastLatencyMs, 104);
  });
});

test("flushHealthStore: 无挂起更新时是 no-op（不抛错）", async () => {
  await withWs(async (ws) => {
    await flushHealthStore(ws);
  });
});
