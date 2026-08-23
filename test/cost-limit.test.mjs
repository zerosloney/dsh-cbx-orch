import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { invokeExecutor } from "../lib/runner.js";
import { ExecutorCostLimitError } from "../lib/errors.js";
import { closeDatabaseConnections, savePersistedState } from "../lib/storage.js";
import { loadConfig } from "../lib/state.js";
import { createJob } from "../lib/jobs.js";
import { loadJson } from "../lib/storage.js";

const fixtures = [];
after(async () => {
  await closeDatabaseConnections();
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

/** 建一个真实可用的 job 工作区（state 落 SQLite + 插件文件 + .cbx.json 配置）。 */
function makeJob({ maxExecutorInvocations, executorInvocations, pluginBody }) {
  const workspace = mkdtempSync(path.join(tmpdir(), "cbx-cost-"));
  const directory = path.join(workspace, "job");
  mkdirSync(directory, { recursive: true });
  const jobId = "cost-limit-job";
  writeFileSync(path.join(workspace, "executor.mjs"),
    `export default { manifest: { apiVersion: "cbx.executor/v1", name: "cost", version: "1.0.0", capabilities: ["execute"] }, async run() { return { code: 0, output: "ok" }; } };`,
    "utf8",
  );
  writeFileSync(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({
      plugins: { enforce: true, allowPaths: ["executor.mjs"] },
      cost: maxExecutorInvocations === undefined
        ? undefined
        : { maxExecutorInvocations },
    }),
    "utf8",
  );
  fixtures.push(workspace);
  // 同步建 state（await 前同步执行不阻塞）
  return (async () => {
    await savePersistedState(workspace, jobId, {
      jobId,
      status: "running",
      executorInvocations,
    });
    return { workspace, directory, jobId };
  })();
}

async function invoke(job, signal) {
  return invokeExecutor(
    "executor.mjs",
    job.workspace,
    job.directory,
    job.workspace,
    "test prompt",
    "auto",
    1,
    5_000,
    { role: "stage", jobId: job.jobId, stageIndex: 0 },
    signal,
  );
}

test("成本闸: 未配置 cost.maxExecutorInvocations 时无上限", async () => {
  const job = await makeJob({ maxExecutorInvocations: undefined, executorInvocations: 100, pluginBody: "" });
  const result = await invoke(job);
  assert.equal(result.code, 0);
});

test("成本闸: 已达上限（current >= limit）抛 ExecutorCostLimitError 且不 spawn", async () => {
  const job = await makeJob({ maxExecutorInvocations: 3, executorInvocations: 3, pluginBody: "" });
  await assert.rejects(
    () => invoke(job),
    (error) =>
      error instanceof ExecutorCostLimitError &&
      error.limit === 3 &&
      error.current === 3,
  );
  // 确认插件未执行：无 plugin-result.json 产生
  assert.equal(existsSync(path.join(job.directory, "plugin-result.json")), false);
});

test("成本闸: 未达上限（current < limit）正常执行", async () => {
  const job = await makeJob({ maxExecutorInvocations: 5, executorInvocations: 2, pluginBody: "" });
  const result = await invoke(job);
  assert.equal(result.code, 0);
});

test("成本闸: 边界 current === limit - 1 允许执行（未超）", async () => {
  const job = await makeJob({ maxExecutorInvocations: 3, executorInvocations: 2, pluginBody: "" });
  const result = await invoke(job);
  assert.equal(result.code, 0);
});

test("成本闸: 配置校验——cost.maxExecutorInvocations 非法值被拒", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "cbx-cost-"));
  fixtures.push(workspace);
  writeFileSync(path.join(workspace, ".cbx.json"), JSON.stringify({ cost: { maxExecutorInvocations: 0 } }), "utf8");
  await assert.rejects(loadConfig(workspace), /maxExecutorInvocations/);
  writeFileSync(path.join(workspace, ".cbx.json"), JSON.stringify({ cost: { maxExecutorInvocations: 2.5 } }), "utf8");
  await assert.rejects(loadConfig(workspace), /maxExecutorInvocations/);
  writeFileSync(path.join(workspace, ".cbx.json"), JSON.stringify({ cost: { maxExecutorInvocations: 50 } }), "utf8");
  await assert.doesNotReject(loadConfig(workspace));
});

test("createJob: cost 参数持久化进 context.json（per-job 覆盖）", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "cbx-cost-"));
  fixtures.push(workspace);
  // 非隔离任务不需要 git 仓库
  const { jobId, directory } = await createJob({
    workspace,
    task: "t",
    review: false,
    isolated: false,
    permissionMode: "default",
    maxTurns: 5,
    maxRetries: 0,
    cost: { maxExecutorInvocations: 7 },
  });
  const context = await loadJson(path.join(directory, "context.json"));
  assert.equal(context.cost.maxExecutorInvocations, 7);
  assert.equal(jobId.length > 0, true);
});
