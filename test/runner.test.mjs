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

const fixtures = [];

after(() => {
  for (const directory of fixtures) rmSync(directory, { recursive: true, force: true });
});

function fixture(pluginSource) {
  const workspace = mkdtempSync(path.join(tmpdir(), "cbx-runner-"));
  const directory = path.join(workspace, "job");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(workspace, "executor.mjs"), pluginSource, "utf8");
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
      await new Promise(() => {});
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
      await new Promise(() => {});
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
      await new Promise(() => {});
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
      await new Promise(() => {});
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
