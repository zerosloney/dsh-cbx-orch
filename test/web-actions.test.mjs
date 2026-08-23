import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeDatabaseConnections, loadPersistedState } from "../lib/storage.js";
import { registerCbxWebRoutes } from "../lib/web.js";
import { WorkspacePolicy } from "../lib/workspace-policy.js";
import { resetExecutorProbeCache } from "../lib/executors/builtin.js";
import { stopScheduler } from "../lib/queue-api.js";
import { listQueue } from "../lib/queue-api.js";

const TOKEN = "web-actions-test-token";

function fakeContext() {
  let activeRoute;
  const cleanups = [];
  const logger = { warn() {}, error() {}, info() {} };
  const context = {
    logger() {
      return logger;
    },
    webServer: {
      register(definition) {
        activeRoute = definition;
        return () => {
          if (activeRoute === definition) activeRoute = undefined;
        };
      },
    },
    effect(factory) {
      const cleanup = factory();
      if (typeof cleanup === "function") cleanups.push(cleanup);
    },
  };
  return {
    context,
    get route() {
      return activeRoute;
    },
    async dispose() {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    },
  };
}

function fakeResponse() {
  let finish;
  let finished = false;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  return {
    statusCode: 0,
    headers: {},
    body: "",
    done,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    write(chunk) {
      this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      return true;
    },
    once() {
      return this;
    },
    destroy() {
      this.end();
    },
    end(chunk = "") {
      if (chunk) this.write(chunk);
      if (!finished) {
        finished = true;
        finish(this);
      }
    },
  };
}

function fakePostRequest(url, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? {});
  const stream = {
    async *[Symbol.asyncIterator]() {
      if (text) yield Buffer.from(text, "utf8");
    },
  };
  return {
    method: "POST",
    url,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
    socket: { remoteAddress: "127.0.0.1" },
    on() {
      return this;
    },
    ...stream,
  };
}

async function callRoute(server, req) {
  assert.ok(server.route);
  const response = fakeResponse();
  server.route.handler(req, response);
  await response.done;
  return response;
}

function parseJson(response) {
  return JSON.parse(response.body);
}

async function waitFor(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await predicate();
    if (ok) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await predicate(), true, message);
}

let server;
let workspace;
let root;

async function setup() {
  root = await mkdtemp(path.join(os.tmpdir(), "cbx-web-actions-"));
  workspace = path.join(root, "ws");
  await mkdir(workspace);
  const fakeExec = path.join(root, "fake-codebuddy.mjs");
  await writeFile(
    fakeExec,
    `export default { manifest: { apiVersion: "cbx.executor/v1", name: "fake", version: "1.0.0", capabilities: ["execute"] }, async run() { return { code: 0, output: "ok" }; } };`,
    "utf8",
  );
  process.env.CBX_CODEBUDDY = fakeExec;
  resetExecutorProbeCache();
  server = fakeContext();
  await registerCbxWebRoutes(server.context, {
    workspacePolicy: new WorkspacePolicy([workspace]),
    token: TOKEN,
  });
}

after(async () => {
  delete process.env.CBX_CODEBUDDY;
  resetExecutorProbeCache();
  if (server) await server.dispose();
  if (workspace) {
    try {
      await stopScheduler(workspace);
    } catch { /* 未启动 */ }
  }
  await closeDatabaseConnections();
  if (root) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
});

const auth = () => ({ authorization: `Bearer ${TOKEN}` });

async function createJob(overrides = {}) {
  const response = await callRoute(
    server,
    fakePostRequest(
      `/cbx/api/jobs?workspace=${encodeURIComponent(workspace)}`,
      { task: "do something", review: false, isolated: false, approval_before_run: true, ...overrides },
      auth(),
    ),
  );
  assert.equal(response.statusCode, 201);
  const jobId = parseJson(response).job_id;
  // approval_before_run=true：调度器拉起 worker 后 executeJob 会停在 awaiting_approval。
  // 等待该状态，确保后续 approve/cancel 作用于正确的门状态。
  await waitFor(async () => {
    const state = await loadPersistedState(workspace, jobId);
    return state?.status === "awaiting_approval";
  }, `任务 ${jobId} 应进入 awaiting_approval`);
  return jobId;
}

test("POST /api/jobs/:id/cancel: 取消 awaiting_approval 任务返回 cancelled", async () => {
  await setup();
  const jobId = await createJob();
  const response = await callRoute(
    server,
    fakePostRequest(`/cbx/api/jobs/${jobId}/cancel?workspace=${encodeURIComponent(workspace)}`, {}, auth()),
  );
  assert.equal(response.statusCode, 200);
  const body = parseJson(response);
  assert.equal(body.status, "cancelled");
  assert.equal(body.jobId, jobId);
});

test("POST /api/jobs/:id/approve: 批准 before_run 任务后进入 queued 并最终 done", async () => {
  await setup();
  const jobId = await createJob();
  const response = await callRoute(
    server,
    fakePostRequest(`/cbx/api/jobs/${jobId}/approve?workspace=${encodeURIComponent(workspace)}`, {}, auth()),
  );
  assert.equal(response.statusCode, 200);
  const body = parseJson(response);
  assert.equal(body.status, "queued");
  // 假执行器立即完成 → 任务应推进到 done（调度器 + worker）
  await waitFor(async () => {
    const state = await loadPersistedState(workspace, jobId);
    return state?.status === "done";
  }, `任务 ${jobId} 应经假执行器完成`);
});

test("POST /api/jobs/:id/retry: 对终态任务重试返回新队列条目", async () => {
  await setup();
  const jobId = await createJob();
  await callRoute(
    server,
    fakePostRequest(`/cbx/api/jobs/${jobId}/cancel?workspace=${encodeURIComponent(workspace)}`, {}, auth()),
  );
  const before = await listQueue(workspace);
  const beforeCount = (before.entries ?? []).length;
  const response = await callRoute(
    server,
    fakePostRequest(`/cbx/api/jobs/${jobId}/retry?workspace=${encodeURIComponent(workspace)}`, { priority: 3 }, auth()),
  );
  assert.equal(response.statusCode, 200);
  const body = parseJson(response);
  assert.ok(body.queueId, "应返回新队列条目");
  assert.equal(body.jobId, jobId);
  const after = await listQueue(workspace);
  assert.ok((after.entries ?? []).length > beforeCount, "队列应新增条目");
});

test("POST /api/jobs/:id/continue: 不存在的 job 返回错误", async () => {
  await setup();
  const response = await callRoute(
    server,
    fakePostRequest(`/cbx/api/jobs/nonexistent/continue?workspace=${encodeURIComponent(workspace)}`, { message: "go" }, auth()),
  );
  // continue 内部 loadState 抛 E_NOT_FOUND → errorStatus 映射 404
  assert.equal(response.statusCode, 404);
});

test("POST /api/jobs/:id/forget: 终态任务可被 forget（删除记录）", async () => {
  await setup();
  const jobId = await createJob();
  await callRoute(
    server,
    fakePostRequest(`/cbx/api/jobs/${jobId}/cancel?workspace=${encodeURIComponent(workspace)}`, {}, auth()),
  );
  const response = await callRoute(
    server,
    fakePostRequest(`/cbx/api/jobs/${jobId}/forget?workspace=${encodeURIComponent(workspace)}`, { reason: "cleanup" }, auth()),
  );
  assert.equal(response.statusCode, 200);
  const body = parseJson(response);
  assert.equal(body.job_id, jobId);
  assert.equal(body.status, "cancelled");
  assert.equal(body.deleted_directory, true);
});

test("POST /api/jobs/:id/purge: 不存在的 job 返回错误", async () => {
  await setup();
  const response = await callRoute(
    server,
    fakePostRequest(`/cbx/api/jobs/missing/purge?workspace=${encodeURIComponent(workspace)}`, {}, auth()),
  );
  assert.equal(response.statusCode, 404);
});

test("POST /api/jobs/:id/approve: 非 awaiting_approval 任务返回错误", async () => {
  await setup();
  const jobId = await createJob();
  await callRoute(
    server,
    fakePostRequest(`/cbx/api/jobs/${jobId}/cancel?workspace=${encodeURIComponent(workspace)}`, {}, auth()),
  );
  const response = await callRoute(
    server,
    fakePostRequest(`/cbx/api/jobs/${jobId}/approve?workspace=${encodeURIComponent(workspace)}`, {}, auth()),
  );
  // 已取消的任务不能批准 → 4xx
  assert.ok(response.statusCode >= 400 && response.statusCode < 500);
});
