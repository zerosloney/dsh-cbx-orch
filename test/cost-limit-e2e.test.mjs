import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createJob } from "../lib/jobs.js";
import { closeDatabaseConnections, savePersistedState } from "../lib/storage.js";
import { loadState } from "../lib/state.js";
import { executeJob } from "../lib/execution.js";

function git(workspace, ...args) {
  return execFileSync("git", ["-C", workspace, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Windows 下 SQLite WAL/SHM 句柄释放与目录删除存在竞态（closeDatabaseConnections
 *  返回后句柄可能仍被占用一瞬间，rm 撞 ENOTEMPTY 属环境性 flake）：清理失败带
 *  短重试再抛，真失败仍会浮出。 */
async function removeWorkspace(ws) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(ws, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await delay(300);
    }
  }
}

/** 建一个干净 Git 仓库 + 假执行器 + 配置成本上限。 */
async function makeJob({ maxExecutorInvocations, preInvocations }) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cost-e2e-"));
  git(workspace, "init", "-q");
  git(workspace, "config", "user.email", "cbx@test.local");
  git(workspace, "config", "user.name", "cbx-test");
  await writeFile(path.join(workspace, "a.txt"), "hello\n", "utf8");
  git(workspace, "add", "a.txt");
  git(workspace, "commit", "-q", "-m", "init");
  // 假执行器：正常返回成功（若被调用会写 marker）
  await writeFile(
    path.join(workspace, "executor.mjs"),
    `export default { manifest: { apiVersion: "cbx.executor/v1", name: "fake", version: "1.0.0", capabilities: ["execute"] }, async run(request) { const { writeFileSync } = await import("node:fs"); writeFileSync(request.directory + "/executor-ran.marker", "ran"); return { code: 0, output: "ok" }; } };`,
    "utf8",
  );
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({
      plugins: { enforce: true, allowPaths: ["executor.mjs"] },
      cost: { maxExecutorInvocations },
    }),
    "utf8",
  );
  // executor.mjs / .cbx.json 提交进仓库，保证 isolated worktree 从干净基线创建
  git(workspace, "add", "executor.mjs", ".cbx.json");
  git(workspace, "commit", "-q", "-m", "add executor");
  const { jobId, directory } = await createJob({
    workspace,
    task: "do the thing",
    review: false,
    isolated: true,
    permissionMode: "auto",
    maxTurns: 5,
    maxRetries: 0,
    executor: "executor.mjs",
  });
  // 预置调用计数：模拟已达上限
  const state = await loadState(workspace, jobId);
  await savePersistedState(workspace, jobId, {
    ...state,
    status: "running",
    executorInvocations: preInvocations,
  });
  return { workspace, jobId, directory };
}

test("成本闸 e2e: 已达上限时 executeJob 转 needs_fix/cost_limit + human gate，不执行执行器", async () => {
  const { workspace, jobId, directory } = await makeJob({
    maxExecutorInvocations: 2,
    preInvocations: 2,
  });
  try {
    const finalState = await executeJob(workspace, jobId, "");
    assert.equal(finalState.status, "needs_fix");
    assert.equal(finalState.phase, "cost_limit");
    assert.ok(finalState.humanGate, "应有 human gate");
    assert.match(String(finalState.error ?? ""), /成本上限/);
    // 执行器绝未被调用
    const marker = path.join(directory, "executor-ran.marker");
    try {
      await readFile(marker, "utf8");
      assert.fail("执行器不应被调用");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  } finally {
    await closeDatabaseConnections();
    await removeWorkspace(workspace);
  }
});

test("成本闸 e2e: 未达上限时任务正常完成", async () => {
  const { workspace, jobId } = await makeJob({
    maxExecutorInvocations: 10,
    preInvocations: 0,
  });
  try {
    const finalState = await executeJob(workspace, jobId, "");
    // 假执行器 code 0 + 无 review + 无测试 → done
    assert.equal(finalState.status, "done");
  } finally {
    await closeDatabaseConnections();
    await removeWorkspace(workspace);
  }
});
