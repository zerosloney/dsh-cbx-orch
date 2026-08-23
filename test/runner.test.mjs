import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { invokeExecutor } from "../lib/runner.js";
import { jobContext } from "../lib/job-runtime.js";
import { loadHealth, resetHealthStore } from "../lib/executor-health.js";

const fixtures = [];

after(() => {
  for (const directory of fixtures) rmSync(directory, { recursive: true, force: true });
  resetHealthStore();
});

// 测试插件源统一注入合法 manifest（enforce 开启时 validateManifest 强制要求）。
// 只接受 `export default { ... }` 形态（可能带前置 import），把 manifest 字段并入导出对象。
function pluginSource(source) {
  return source.replace(
    /export default\s*\{/,
    `export default { manifest: { apiVersion: "cbx.executor/v1", name: "test-plugin", version: "1.0.0", capabilities: ["execute"] },`,
  );
}

function fixture(pluginSourceBody) {
  const workspace = mkdtempSync(path.join(tmpdir(), "cbx-runner-"));
  const directory = path.join(workspace, "job");
  mkdirSync(directory, { recursive: true });
  // 真实插件形态：默认 enforce=true 要求 manifest + 白名单路径，测试源补上两者。
  writeFileSync(path.join(workspace, "executor.mjs"), pluginSource(pluginSourceBody), "utf8");
  writeFileSync(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ plugins: { enforce: true, allowPaths: ["executor.mjs"] } }),
    "utf8",
  );
  fixtures.push(workspace);
  return {
    workspace,
    directory,
    requestFile: path.join(directory, "plugin-request.json"),
    resultFile: path.join(directory, "plugin-result.json"),
  };
}

async function invoke(fixtureValue, timeoutMs = 5_000) {
  return invokeWithSignal(fixtureValue, timeoutMs);
}

async function invokeWithSignal(fixtureValue, timeoutMs = 5_000, signal) {
  return invokeExecutor(
    "executor.mjs",
    fixtureValue.workspace,
    fixtureValue.directory,
    fixtureValue.workspace,
    "test prompt",
    "auto",
    1,
    timeoutMs,
    undefined,
    signal,
  );
}

function jobContextFor(fixtureValue, controller) {
  return {
    workspace: fixtureValue.workspace,
    jobId: "runner-test",
    controller,
    handles: new Set(),
  };
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待 runner 测试条件超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("invokeExecutor: 成功后清理 request/result 临时文件", async () => {
  const value = fixture(`
    export default { async run() { return { code: 0, output: "fresh result" }; } };
  `);

  const result = await invoke(value);

  assert.deepEqual(result, { code: 0, timedOut: false, output: "fresh result" });
  assert.equal(existsSync(value.requestFile), false);
  assert.equal(existsSync(value.resultFile), false);
});

test("invokeExecutor: 执行器失败时不读取陈旧结果并清理临时文件", async () => {
  const value = fixture(`
    export default { async run() { throw new Error("plugin failed"); } };
  `);
  writeFileSync(value.requestFile, JSON.stringify({ prompt: "stale request" }), "utf8");
  writeFileSync(value.resultFile, JSON.stringify({ code: 0, output: "stale result" }), "utf8");

  const result = await invoke(value);

  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.output, /stale result/);
  assert.equal(existsSync(value.requestFile), false);
  assert.equal(existsSync(value.resultFile), false);
});

test("invokeExecutor: 超时时清理 request/result 临时文件", async () => {
  const value = fixture(`
    export default { async run() { await new Promise(() => setInterval(() => {}, 1_000)); } };
  `);
  writeFileSync(value.resultFile, JSON.stringify({ code: 0, output: "stale result" }), "utf8");

  const result = await invoke(value, 250);

  assert.equal(result.timedOut, true);
  assert.doesNotMatch(result.output, /stale result/);
  assert.equal(existsSync(value.requestFile), false);
  assert.equal(existsSync(value.resultFile), false);
});

test("invokeExecutor: jobContext 预取消不 inspect、spawn 或创建插件 artifacts", async () => {
  const value = fixture(`
    import { writeFileSync } from "node:fs";
    import path from "node:path";
    export default { async run(request) {
      writeFileSync(path.join(request.directory, "plugin-ran.marker"), "ran");
      return { code: 0, output: "should not run" };
    } };
  `);
  const controller = new AbortController();
  const reason = new Error("job pre-cancelled");
  controller.abort(reason);

  await assert.rejects(
    () => jobContext.run(jobContextFor(value, controller), () => invoke(value)),
    (error) => error === reason,
  );
  assert.equal(existsSync(value.requestFile), false);
  assert.equal(existsSync(value.resultFile), false);
  assert.equal(existsSync(path.join(value.directory, "plugin-ran.marker")), false);
});

test("invokeExecutor: job 运行中取消保留原始 reason 并清理插件 artifacts", async () => {
  const value = fixture(`
    import { writeFileSync } from "node:fs";
    import path from "node:path";
    export default { async run(request) {
      writeFileSync(path.join(request.directory, "plugin-running.marker"), "running");
      // setInterval 保持事件循环存活；纯 pending promise 会让子进程在写完 marker 后
      // 立刻以 code 0 退出，取消路径探测不到"运行中的插件"。
      await new Promise(() => setInterval(() => {}, 1_000));
    } };
  `);
  const controller = new AbortController();
  const reason = new Error("job cancelled during plugin");
  const pending = jobContext.run(
    jobContextFor(value, controller),
    () => invoke(value, 30_000),
  );
  await waitFor(() => existsSync(path.join(value.directory, "plugin-running.marker")));
  controller.abort(reason);

  await assert.rejects(pending, (error) => error === reason);
  assert.equal(existsSync(value.requestFile), false);
  assert.equal(existsSync(value.resultFile), false);
  assert.equal(existsSync(path.join(value.directory, "active.pid")), false);
});

test("invokeExecutor: caller 取消保留 caller reason 并清理插件 artifacts", async () => {
  const value = fixture(`
    import { writeFileSync } from "node:fs";
    import path from "node:path";
    export default { async run(request) {
      writeFileSync(path.join(request.directory, "plugin-running.marker"), "running");
      // setInterval 保持事件循环存活（纯 pending promise 会让子进程即刻退出）。
      await new Promise(() => setInterval(() => {}, 1_000));
    } };
  `);
  const jobController = new AbortController();
  const callerController = new AbortController();
  const reason = new Error("caller cancelled during plugin");
  const pending = jobContext.run(
    jobContextFor(value, jobController),
    () => invokeWithSignal(value, 30_000, callerController.signal),
  );
  await waitFor(() => existsSync(path.join(value.directory, "plugin-running.marker")));
  callerController.abort(reason);

  await assert.rejects(pending, (error) => error === reason);
  assert.equal(existsSync(value.requestFile), false);
  assert.equal(existsSync(value.resultFile), false);
  assert.equal(existsSync(path.join(value.directory, "active.pid")), false);
});

test("invokeExecutor: caller 与 job 同时取消时 caller reason 优先", async () => {
  const value = fixture(`
    import { writeFileSync } from "node:fs";
    import path from "node:path";
    export default { async run(request) {
      writeFileSync(path.join(request.directory, "plugin-running.marker"), "running");
      // setInterval 保持事件循环存活（纯 pending promise 会让子进程即刻退出）。
      await new Promise(() => setInterval(() => {}, 1_000));
    } };
  `);
  const jobController = new AbortController();
  const callerController = new AbortController();
  const jobReason = new Error("job cancelled first");
  const callerReason = new Error("caller cancelled first");
  const pending = jobContext.run(
    jobContextFor(value, jobController),
    () => invokeWithSignal(value, 30_000, callerController.signal),
  );
  await waitFor(() => existsSync(path.join(value.directory, "plugin-running.marker")));
  jobController.abort(jobReason);
  callerController.abort(callerReason);

  await assert.rejects(pending, (error) => error === callerReason);
  assert.equal(existsSync(value.requestFile), false);
  assert.equal(existsSync(value.resultFile), false);
});

test("invokeExecutor: 清理失败不遮蔽取消 reason，并写脱敏审计事件", async () => {
  const value = fixture(`
    import { mkdirSync, writeFileSync } from "node:fs";
    import path from "node:path";
    export default { async run(request) {
      mkdirSync(path.join(request.directory, "plugin-request.json"));
      writeFileSync(path.join(request.directory, "plugin-running.marker"), "running");
      // setInterval 保持事件循环存活（纯 pending promise 会让子进程即刻退出）。
      await new Promise(() => setInterval(() => {}, 1_000));
    } };
  `);
  const controller = new AbortController();
  const reason = new Error("cancel survives cleanup failure");
  const pending = jobContext.run(
    jobContextFor(value, controller),
    () => invoke(value, 30_000),
  );
  await waitFor(() => existsSync(path.join(value.directory, "plugin-running.marker")));
  controller.abort(reason);

  await assert.rejects(pending, (error) => error === reason);
  assert.equal(existsSync(value.requestFile), true);
  assert.match(
    readFileSync(path.join(value.directory, "events.ndjson"), "utf8"),
    /plugin_artifact_cleanup_failed/,
  );
});

// ---------------------------------------------------------------------------
// 健康度回写的失败语义细分：超时/崩溃/启动错误分开计数，供路由层分档降权
// ---------------------------------------------------------------------------

test("invokeExecutor: 成功回写 successes，失败按 failure 记", async () => {
  resetHealthStore();
  const successValue = fixture(`
    export default { async run() { return { code: 0, output: "ok" }; } };
  `);
  await invoke(successValue);
  let rec = loadHealth(successValue.workspace)["executor.mjs"];
  assert.equal(rec.successes, 1);
  assert.equal(rec.consecutiveFailures, 0);

  const failValue = fixture(`
    export default { async run() { return { code: 3, output: "boom" }; } };
  `);
  await invoke(failValue);
  rec = loadHealth(failValue.workspace)["executor.mjs"];
  assert.equal(rec.failures, 1);
  assert.equal(rec.lastFailureKind, "failure");
  assert.equal(rec.timeouts, undefined);
});

test("invokeExecutor: 超时按 timeout 记，与崩溃分开", async () => {
  resetHealthStore();
  const value = fixture(`
    export default { async run() { await new Promise(() => setInterval(() => {}, 1_000)); } };
  `);
  const result = await invoke(value, 250);
  assert.equal(result.timedOut, true);
  const rec = loadHealth(value.workspace)["executor.mjs"];
  assert.equal(rec.failures, 1);
  assert.equal(rec.timeouts, 1);
  assert.equal(rec.consecutiveTimeouts, 1);
  assert.equal(rec.lastFailureKind, "timeout");
});

test("invokeExecutor: 插件缺失等启动错误也计入健康度（取消除外）", async () => {
  resetHealthStore();
  const workspace = mkdtempSync(path.join(tmpdir(), "cbx-runner-"));
  fixtures.push(workspace);
  const directory = path.join(workspace, "job");
  mkdirSync(directory, { recursive: true });
  await assert.rejects(() =>
    invokeExecutor("missing-plugin.mjs", workspace, directory, workspace, "p", "auto", 1, 5_000),
  );
  const rec = loadHealth(workspace)["missing-plugin.mjs"];
  assert.ok(rec, "启动错误必须留下健康度记录");
  assert.equal(rec.failures, 1);
  assert.equal(rec.lastFailureKind, "failure");
});
