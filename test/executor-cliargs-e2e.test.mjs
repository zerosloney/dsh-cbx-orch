// executors.cliArgs 端到端：工作区 .cbx.json 的 CLI 参数覆盖必须真实到达执行器进程。
// 断言方式：job 事件流（SQLite 审计权威）的 process_started 记录完整命令参数。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createJob } from "../lib/jobs.js";
import { enqueueJob, stopScheduler } from "../lib/queue-api.js";
import { loadState } from "../lib/state.js";
import { jobEventsAfterCursor, closeDatabaseConnections } from "../lib/storage.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mockExecutor = path.join(
  repoRoot,
  "smoke",
  "mock-executor",
  "codebuddy.mjs",
);
process.env.CBX_CODEBUDDY = mockExecutor;

async function git(workspace, args) {
  await execFileAsync("git", args, { cwd: workspace, windowsHide: true });
}

async function waitStatus(workspace, jobId, statuses, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await loadState(workspace, jobId);
    if (statuses.includes(state.status)) return state;
    if (Date.now() >= deadline) {
      throw new Error(
        `等待 ${jobId} 到 ${statuses} 超时（当前 ${state.status}/${state.phase}）。`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test("executors.cliArgs：覆盖参数追加到执行器命令（事件流可见）", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cliargs-"));
  try {
    await writeFile(path.join(ws, "tracked.txt"), "clean\n", "utf8");
    await git(ws, ["init", "-q"]);
    await git(ws, ["config", "user.email", "cbx-tests@example.invalid"]);
    await git(ws, ["config", "user.name", "cbx tests"]);
    await git(ws, ["add", "tracked.txt"]);
    await git(ws, ["commit", "-q", "-m", "initial"]);
    // 工作区级 CLI 参数覆盖（别名键 cbc 也应命中 codebuddy）
    await writeFile(
      path.join(ws, ".cbx.json"),
      JSON.stringify({
        executors: {
          cliArgs: { cbc: ["--model", "mock-model", "--temperature", "0"] },
        },
      }),
      "utf8",
    );
    const jobId = "job-args";
    await createJob({
      workspace: ws,
      task: "e2e smoke",
      review: false,
      isolated: false,
      permissionMode: "default",
      maxTurns: 5,
      timeoutMs: 120_000,
      maxRetries: 0,
      executor: "codebuddy",
      testCommand: "echo smoke-done",
      jobId,
    });
    await enqueueJob(ws, jobId);
    await waitStatus(ws, jobId, ["done"]);

    const events = await jobEventsAfterCursor(ws, jobId, 0, 5000);
    const started = events.rows.find(
      (row) => row.payload?.event === "process_started",
    );
    assert.ok(started, "应记录 process_started 事件");
    const command = started.payload.command;
    assert.ok(
      Array.isArray(command) && command.includes("--model") && command.includes("mock-model"),
      `覆盖参数应出现在命令中：${JSON.stringify(command)}`,
    );
    assert.ok(command.includes("--temperature") && command.includes("0"));
    // 内置参数仍在（参数漂移逃生门是追加而不是替换）
    assert.ok(command.includes("--max-turns"), "内置参数应保留");
  } finally {
    await stopScheduler(ws).catch(() => undefined);
    await closeDatabaseConnections().catch(() => undefined);
    await rm(ws, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("executors.cliArgs：未配置时命令不含覆盖参数（缺省行为不变）", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cliargs-none-"));
  try {
    await writeFile(path.join(ws, "tracked.txt"), "clean\n", "utf8");
    await git(ws, ["init", "-q"]);
    await git(ws, ["config", "user.email", "cbx-tests@example.invalid"]);
    await git(ws, ["config", "user.name", "cbx tests"]);
    await git(ws, ["add", "tracked.txt"]);
    await git(ws, ["commit", "-q", "-m", "initial"]);
    const jobId = "job-args-none";
    await createJob({
      workspace: ws,
      task: "e2e smoke",
      review: false,
      isolated: false,
      permissionMode: "default",
      maxTurns: 5,
      timeoutMs: 120_000,
      maxRetries: 0,
      executor: "codebuddy",
      testCommand: "echo smoke-done",
      jobId,
    });
    await enqueueJob(ws, jobId);
    await waitStatus(ws, jobId, ["done"]);
    const events = await jobEventsAfterCursor(ws, jobId, 0, 5000);
    const started = events.rows.find(
      (row) => row.payload?.event === "process_started",
    );
    assert.ok(started);
    const command = started.payload.command;
    assert.ok(
      !command.includes("--model"),
      `未配置时不应出现覆盖参数：${JSON.stringify(command)}`,
    );
  } finally {
    await stopScheduler(ws).catch(() => undefined);
    await closeDatabaseConnections().catch(() => undefined);
    await rm(ws, { recursive: true, force: true }).catch(() => undefined);
  }
});