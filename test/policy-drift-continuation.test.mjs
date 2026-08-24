import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createJob } from "../lib/jobs.js";
import { closeDatabaseConnections, savePersistedState, securityPolicyFingerprint } from "../lib/storage.js";
import { loadConfig, loadState } from "../lib/state.js";
import { executeJob, prepareContinuation } from "../lib/execution.js";
import { invokeExecutor } from "../lib/runner.js";
import { ExecutorPolicyDriftError } from "../lib/errors.js";

function git(workspace, ...args) {
  return execFileSync("git", ["-C", workspace, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const fixtures = [];
after(async () => {
  await closeDatabaseConnections();
  for (const dir of fixtures) await rm(dir, { recursive: true, force: true });
});

/** 建一个干净 Git 仓库 + 假执行器 + 配置成本上限，返回任务。 */
async function makeJob({ maxExecutorInvocations }) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-fingerprint-"));
  fixtures.push(workspace);
  git(workspace, "init", "-q");
  git(workspace, "config", "user.email", "cbx@test.local");
  git(workspace, "config", "user.name", "cbx-test");
  await writeFile(path.join(workspace, "a.txt"), "hello\n", "utf8");
  git(workspace, "add", "a.txt");
  git(workspace, "commit", "-q", "-m", "init");
  await writeFile(
    path.join(workspace, "executor.mjs"),
    `export default { manifest: { apiVersion: "cbx.executor/v1", name: "fake", version: "1.0.0", capabilities: ["execute"] }, async run() { return { code: 0, output: "ok" }; } };`,
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
  return { workspace, jobId, directory };
}

test("策略指纹: 改 .cbx.json 后执行器调用被拒（policy_drift），但经 prepareContinuation（human gate 续跑）刷新后放行", async () => {
  const { workspace, jobId, directory } = await makeJob({ maxExecutorInvocations: 5 });
  // 初始指纹 = 创建时（cost=5）
  const initialFingerprint = (await loadState(workspace, jobId)).securityFingerprint;
  assert.equal(typeof initialFingerprint, "string");

  // operator 改配置：调高成本上限（cost_limit 场景的既定解法）
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({
      plugins: { enforce: true, allowPaths: ["executor.mjs"] },
      cost: { maxExecutorInvocations: 50 },
    }),
    "utf8",
  );

  // 改配置后：未经续跑刷新 → 执行器调用被 policy_drift 拒绝（fail-closed 生效）
  await assert.rejects(
    () => invokeExecutor(
      "executor.mjs",
      workspace,
      directory,
      workspace,
      "test",
      "auto",
      1,
      5_000,
      { role: "stage", jobId, stageIndex: 0 },
    ),
    (error) => error instanceof ExecutorPolicyDriftError,
  );

  // operator 通过 human gate 续跑（cbx_continue 语义）：prepareContinuation 刷新指纹
  const state = await loadState(workspace, jobId);
  await savePersistedState(workspace, jobId, {
    ...state,
    status: "needs_fix",
    phase: "cost_limit",
    humanGate: {
      version: 1,
      reason: "needs_input",
      status: "waiting",
      createdAt: new Date().toISOString(),
      detail: "成本上限",
    },
  });
  const continuation = await prepareContinuation(workspace, jobId, "提高预算继续");
  assert.ok(!continuation.blocked, "human gate 续跑不应被 block");

  // 续跑后指纹已刷新为当前配置（cost=50）
  const refreshed = await loadState(workspace, jobId);
  const currentFingerprint = securityPolicyFingerprint(await loadConfig(workspace));
  assert.equal(refreshed.securityFingerprint, currentFingerprint, "续跑应刷新指纹为当前配置");

  // 刷新后执行器调用放行（不再 policy_drift）
  const result = await invokeExecutor(
    "executor.mjs",
    workspace,
    directory,
    workspace,
    "test",
    "auto",
    1,
    5_000,
    { role: "stage", jobId, stageIndex: 0 },
  );
  assert.equal(result.code, 0);
});
