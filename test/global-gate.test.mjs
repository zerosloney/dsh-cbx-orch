import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setGlobalLimits,
  withSpawnSlot,
  tryConsumeInvocation,
  globalStats,
  resetGlobalGate,
} from "../lib/global-gate.js";
import {
  countRunningJobs,
  registerRunningJob,
  unregisterRunningJob,
} from "../lib/job-runtime.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("global-gate: 上限校验——非法值拒绝", () => {
  try {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      assert.throws(
        () => setGlobalLimits({ maxGlobalConcurrent: bad }),
        /maxGlobalConcurrent/,
        `应拒绝 maxGlobalConcurrent=${bad}`,
      );
    }
    for (const bad of [0, -1, 2.5, NaN]) {
      assert.throws(
        () => setGlobalLimits({ maxGlobalInvocations: bad }),
        /maxGlobalInvocations/,
        `应拒绝 maxGlobalInvocations=${bad}`,
      );
    }
    // 合法值不抛
    setGlobalLimits({ maxGlobalConcurrent: 1, maxGlobalInvocations: 2 });
    assert.equal(globalStats().maxGlobalConcurrent, 1);
    assert.equal(globalStats().maxGlobalInvocations, 2);
  } finally {
    resetGlobalGate();
  }
});

test("global-gate: countRunningJobs 反映注册表真实活跃数", () => {
  try {
    assert.equal(countRunningJobs(), 0);
    const ctx = registerRunningJob("ws-a", "job-1");
    assert.equal(countRunningJobs(), 1);
    registerRunningJob("ws-b", "job-1"); // 不同工作区不同键
    assert.equal(countRunningJobs(), 2);
    assert.equal(registerRunningJob("ws-a", "job-1"), ctx); // 幂等复用
    assert.equal(countRunningJobs(), 2);
  } finally {
    unregisterRunningJob("ws-a", "job-1");
    unregisterRunningJob("ws-b", "job-1");
    assert.equal(countRunningJobs(), 0);
  }
});

test("global-gate: 并发闸 cap=1——并发 spawn 恰一个通过（互斥覆盖异步注册窗口）", async () => {
  try {
    setGlobalLimits({ maxGlobalConcurrent: 1 });
    const outcomes = [];
    // 注册故意放在 await 之后：没有互斥时两个调用都会在注册前通过检查。
    const spawn = async (label) => {
      await delay(5);
      registerRunningJob(`ws-${label}`, "job-1");
      return label;
    };
    // 同时发起（不 await 第一个）——互斥必须串行化二者。
    const [a, b] = await Promise.all([
      withSpawnSlot(() => spawn(1)),
      withSpawnSlot(() => spawn(2)),
    ]);
    outcomes.push(a, b);
    outcomes.sort((x, y) => (x ?? 0) - (y ?? 0));
    assert.deepEqual(outcomes, [null, 1], "cap=1 时恰一个 spawn 通过，另一个被闸拦下");
    assert.equal(countRunningJobs(), 1);
    // 闸释放（注销）后恢复放行
    unregisterRunningJob("ws-1", "job-1");
    const third = await withSpawnSlot(async () => {
      registerRunningJob("ws-3", "job-1");
      return 3;
    });
    assert.equal(third, 3);
  } finally {
    for (const ws of ["ws-1", "ws-2", "ws-3"]) {
      unregisterRunningJob(ws, "job-1");
    }
    resetGlobalGate();
    assert.equal(countRunningJobs(), 0);
  }
});

test("global-gate: 并发闸未配置上限 = 恒放行", async () => {
  try {
    setGlobalLimits({});
    const ok = await withSpawnSlot(async () => {
      registerRunningJob("ws-u", "u1");
      return "ok";
    });
    assert.equal(ok, "ok");
  } finally {
    unregisterRunningJob("ws-u", "u1");
    resetGlobalGate();
  }
});

test("global-gate: 预算闸原子消费——到顶拒绝、调高后恢复、计数不因重设清零", () => {
  try {
    setGlobalLimits({ maxGlobalInvocations: 2 });
    const c1 = tryConsumeInvocation();
    assert.deepEqual(c1, { allowed: true, used: 1 });
    const c2 = tryConsumeInvocation();
    assert.deepEqual(c2, { allowed: true, used: 2 });
    const c3 = tryConsumeInvocation();
    assert.equal(c3.allowed, false);
    assert.equal(c3.limit, 2);
    assert.equal(c3.used, 2);
    // 调高上限：计数保留（单调递增），恢复放行
    setGlobalLimits({ maxGlobalInvocations: 5 });
    const c4 = tryConsumeInvocation();
    assert.equal(c4.allowed, true);
    assert.equal(c4.used, 3);
    // 取消上限：恒放行，计数继续累积
    setGlobalLimits({});
    assert.equal(tryConsumeInvocation().allowed, true);
  } finally {
    resetGlobalGate();
  }
});

test("global-gate: 未配置预算时 tryConsumeInvocation 永远放行", () => {
  try {
    setGlobalLimits({});
    for (let i = 0; i < 5; i += 1) {
      const r = tryConsumeInvocation();
      assert.equal(r.allowed, true);
      assert.equal(r.used, i + 1);
    }
  } finally {
    resetGlobalGate();
  }
});

test("global-gate: 互斥链异常后仍可继续使用（不因 spawn 抛错死锁）", async () => {
  try {
    setGlobalLimits({ maxGlobalConcurrent: 1 });
    await assert.rejects(
      withSpawnSlot(() => {
        throw new Error("spawn 失败");
      }),
      /spawn 失败/,
    );
    // 链未坏：后续调用仍能拿到槽位
    const ok = await withSpawnSlot(async () => {
      await delay(1);
      registerRunningJob("ws-err", "j1");
      return "ok";
    });
    assert.equal(ok, "ok");
  } finally {
    unregisterRunningJob("ws-err", "j1");
    resetGlobalGate();
  }
});