// 全局治理端到端（不使用 dsh profile，直接驱动 lib 层）：
//   1. 跨工作区并发闸：governance.maxGlobalConcurrent=1 时，第二个工作区的排队任务
//      被拦下并带 deferReason="global_cap"，首个完成后自动（派发）续跑。
//   2. 全局预算闸：耗尽后新任务落在 needs_fix/cost_limit，调高预算经 retry 恢复。
// 执行器用 smoke/mock-executor/codebuddy.mjs（CBX_CODEBUDDY 注入，不依赖 PATH）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createJob } from "../lib/jobs.js";
import {
  dispatchQueue,
  enqueueJob,
  listQueue,
  retryQueueJob,
  stopScheduler,
} from "../lib/queue-api.js";
import { loadState } from "../lib/state.js";
import { closeDatabaseConnections } from "../lib/storage.js";
import {
  tryConsumeInvocation,
  setGlobalLimits,
  resetGlobalGate,
} from "../lib/global-gate.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mockExecutor = path.join(
  repoRoot,
  "smoke",
  "mock-executor",
  "codebuddy.mjs",
);
// 必须在任何 findExecutable 调用之前就位（内置执行器解析有 TTL 缓存）。
process.env.CBX_CODEBUDDY = mockExecutor;

async function git(workspace, args) {
  await execFileAsync("git", args, { cwd: workspace, windowsHide: true });
}

async function cleanGitWorkspace(prefix) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), prefix));
  await writeFile(path.join(workspace, "tracked.txt"), "clean\n", "utf8");
  await git(workspace, ["init", "-q"]);
  await git(workspace, ["config", "user.email", "cbx-tests@example.invalid"]);
  await git(workspace, ["config", "user.name", "cbx tests"]);
  await git(workspace, ["add", "tracked.txt"]);
  await git(workspace, ["commit", "-q", "-m", "initial"]);
  return workspace;
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

async function makeJob(workspace, task, jobId) {
  await createJob({
    workspace,
    task,
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
}

test("全局并发闸端到端：cap=1 跨工作区互斥，首个完成后续跑", async () => {
  const ws1 = await cleanGitWorkspace("cbx-global-ws1-");
  const ws2 = await cleanGitWorkspace("cbx-global-ws2-");
  try {
    const j1 = "job-a";
    const j2 = "job-b";
    await makeJob(ws1, "e2e smoke", j1);
    await makeJob(ws2, "e2e smoke two", j2);
    setGlobalLimits({ maxGlobalConcurrent: 1 });
    try {
      await enqueueJob(ws1, j1);
      // ws1 的 spawn 与注册是同步的：入队返回即已占用全局槽位。
      await enqueueJob(ws2, j2);
      // ws2 必须被全局闸拦下：保持 queued + deferReason 标记。
      const q2 = await listQueue(ws2);
      const e2 = q2.entries.find((entry) => entry.jobId === j2);
      assert.equal(e2.status, "queued", "第二个工作区的任务应保持排队");
      assert.equal(e2.deferReason, "global_cap", "排队滞留原因应为 global_cap");
      // 等首个任务完成后派发：ws2 启动并最终 done。
      await waitStatus(ws1, j1, ["done"]);
      await dispatchQueue(ws2);
      await waitStatus(ws2, j2, ["done"]);
      // deferReason 在真正 spawn 时清除。
      const q2final = await listQueue(ws2);
      const e2final = q2final.entries.find((entry) => entry.jobId === j2);
      assert.equal(e2final.deferReason, undefined);
      assert.equal(e2final.status, "done");
    } finally {
      setGlobalLimits({});
    }
  } finally {
    resetGlobalGate();
    await Promise.all([
      stopScheduler(ws1).catch(() => undefined),
      stopScheduler(ws2).catch(() => undefined),
    ]);
    // Windows 下 SQLite 连接未关闭会导致 rm 撞 EBUSY；先关连接再删目录。
    await closeDatabaseConnections().catch(() => undefined);
    await Promise.all([
      rm(ws1, { recursive: true, force: true }).catch(() => undefined),
      rm(ws2, { recursive: true, force: true }).catch(() => undefined),
    ]);
  }
});

test("全局预算闸端到端：耗尽落 needs_fix/cost_limit，调高预算续跑恢复", async () => {
  const ws1 = await cleanGitWorkspace("cbx-budget-ws-");
  try {
    const j1 = "job-a";
    const j2 = "job-b";
    await makeJob(ws1, "e2e smoke", j1);
    await makeJob(ws1, "e2e smoke two", j2);
    setGlobalLimits({ maxGlobalInvocations: 8 });
    try {
      await enqueueJob(ws1, j1);
      await waitStatus(ws1, j1, ["done"]);
      // 确定性耗尽：无论 job1 实际消费几次，直接消费到顶。
      // eslint-disable-next-line no-empty
      while (tryConsumeInvocation().allowed) { /* drain */ }
      await enqueueJob(ws1, j2);
      const s2 = await waitStatus(ws1, j2, ["needs_fix"]);
      assert.equal(s2.phase, "cost_limit", "全局预算耗尽应走 cost_limit + Human Gate");
      assert.match(String(s2.error ?? ""), /全局/);
      // 调高预算 → retry（cbx_continue 的执行语义）→ 恢复完成。
      setGlobalLimits({ maxGlobalInvocations: 20 });
      await retryQueueJob(ws1, j2);
      await waitStatus(ws1, j2, ["done"]);
    } finally {
      setGlobalLimits({});
    }
  } finally {
    resetGlobalGate();
    await stopScheduler(ws1).catch(() => undefined);
    // Windows 下 SQLite 连接未关闭会导致 rm 撞 EBUSY；先关连接再删目录。
    await closeDatabaseConnections().catch(() => undefined);
    await rm(ws1, { recursive: true, force: true }).catch(() => undefined);
  }
});