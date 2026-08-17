import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeDatabaseConnections, savePersistedState } from "../lib/storage.js";
import { bridgeCbxJob, monitorCbxJob } from "../lib/jobs-bridge.js";

function fakeContext(jobs) {
  const context = {
    get(name) {
      if (name === "jobs") return jobs;
      return undefined;
    },
  };
  return context;
}

async function withJob(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cbx-jobs-bridge-"));
  const workspace = path.join(root, "ws");
  const jobId = "20260101000000-abc123";
  const dir = path.join(workspace, ".cbx", "jobs", jobId);
  await mkdir(dir, { recursive: true });
  try {
    return await callback({ root, workspace, jobId, dir });
  } finally {
    // 监视器 cancel 里的 cancelJob 是 fire-and-forget，可能在 closeDatabaseConnections
    // 返回后才打开新连接 → rm 撞 EBUSY（Windows 瞬态句柄）。与 git-ops/storage 的
    // EBUSY 重试模式一致：退避重试并每轮重关连接。
    for (let attempt = 0; ; attempt += 1) {
      await closeDatabaseConnections();
      try {
        await rm(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}

async function writeState(dir, status, extra = {}) {
  const state = {
    jobId: "20260101000000-abc123",
    status,
    phase: null,
    workspace: path.resolve(path.join(dir, "..", "..", "..")),
    jobDir: dir,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    attempt: 0,
    ...extra,
  };
  await writeFile(path.join(dir, "state.json"), JSON.stringify(state), "utf8");
  // monitorCbxJob 经 loadState 读 SQLite（state.json 只是镜像文件）；测试须与生产一致
  // 双写，否则后续状态迁移只落到镜像、监视器永远轮询旧状态。
  await savePersistedState(state.workspace, state.jobId, state);
}

test("bridgeCbxJob: 无 agent 上下文时不注册（返回 undefined）", async () => {
  await withJob(async ({ workspace, jobId }) => {
    let started = 0;
    const jobs = { start: () => { started += 1; return "cbx-1"; } };
    const id = bridgeCbxJob(fakeContext(jobs), { workspace, jobId, task: "t", agent: undefined });
    assert.equal(id, undefined);
    assert.equal(started, 0);
  });
});

test("bridgeCbxJob: 无 jobs 服务时不注册（返回 undefined）", async () => {
  await withJob(async ({ workspace, jobId }) => {
    const id = bridgeCbxJob(fakeContext(undefined), { workspace, jobId, task: "t", agent: {} });
    assert.equal(id, undefined);
  });
});

test("bridgeCbxJob: 有 agent 与 jobs 时注册并返回 harness job id", async () => {
  await withJob(async ({ workspace, jobId }) => {
    const specs = [];
    const jobs = {
      start: (spec) => { specs.push(spec); return "cbx-7"; },
    };
    const agent = { id: "session-1" };
    const id = bridgeCbxJob(fakeContext(jobs), { workspace, jobId, task: "  fix   the   bug  ", agent });
    assert.equal(id, "cbx-7");
    assert.equal(specs.length, 1);
    assert.equal(specs[0].kind, "cbx");
    assert.equal(specs[0].owner, agent);
    assert.match(specs[0].label, /^cbx 20260101000000-abc123: fix the bug/);
    assert.equal(typeof specs[0].run, "function");
    const monitor = specs[0].run();
    assert.equal(typeof monitor.readOutput, "function");
    // 监视器首个 tick 会异步打开 SQLite 连接；await done 确保其结束（目录无 state →
    // 视为 killed），否则清理 rm 会与未落缓存的连接竞态产生 EBUSY。
    await monitor.done;
  });
});

test("bridgeCbxJob: jobs.start 抛错时静默退化为 undefined", async () => {
  await withJob(async ({ workspace, jobId }) => {
    const jobs = { start: () => { throw new Error("no controller"); } };
    const id = bridgeCbxJob(fakeContext(jobs), { workspace, jobId, task: "t", agent: {} });
    assert.equal(id, undefined);
  });
});

test("monitorCbxJob: 队列→运行→done 状态迁移与终态摘要", async () => {
  await withJob(async ({ workspace, jobId, dir }) => {
    await writeState(dir, "queued");
    const hooks = monitorCbxJob(workspace, jobId, 30);

    await writeState(dir, "running", { phase: "executor" });
    await new Promise((resolve) => setTimeout(resolve, 80));

    await writeFile(
      path.join(dir, "result.json"),
      JSON.stringify({ status: "done", handback: "handback content", changedFiles: ["a.ts"], reviewVerdict: "PASS" }),
      "utf8",
    );
    await writeState(dir, "done", { phase: null });

    const outcome = await hooks.done;
    assert.equal(outcome.status, "completed");
    assert.match(outcome.output ?? "", /handback content/);
    assert.match(outcome.output ?? "", /changed files: 1/);

    const read = hooks.readOutput();
    assert.match(read, /\[running/);
    assert.match(read, /\[done/);
    assert.match(read, /handback content/);
  });
});

test("monitorCbxJob: 取消保留 reason 并映射为 killed", async () => {
  await withJob(async ({ workspace, jobId, dir }) => {
    await writeState(dir, "running", { phase: "executor" });
    const hooks = monitorCbxJob(workspace, jobId, 30);

    hooks.cancel("user changed their mind");
    await writeState(dir, "cancelled", { phase: null });

    const outcome = await hooks.done;
    assert.equal(outcome.status, "killed");
    assert.equal(outcome.detail, "cancelled");
    assert.match(hooks.readOutput(), /cancel requested: user changed their mind/);
  });
});

test("monitorCbxJob: 失败状态映射为 failed 并带错误信息", async () => {
  await withJob(async ({ workspace, jobId, dir }) => {
    await writeState(dir, "failed", { phase: "test", error: "tests failed" });
    const hooks = monitorCbxJob(workspace, jobId, 30);
    const outcome = await hooks.done;
    assert.equal(outcome.status, "failed");
    assert.match(outcome.output ?? "", /error: tests failed/);
  });
});

test("monitorCbxJob: job 目录消失视为 killed", async () => {
  await withJob(async ({ workspace, jobId }) => {
    const hooks = monitorCbxJob(workspace, jobId, 30);
    // state.json 从不存在 → loadState 抛错 → 目录消失分支
    const outcome = await hooks.done;
    assert.equal(outcome.status, "killed");
  });
});
