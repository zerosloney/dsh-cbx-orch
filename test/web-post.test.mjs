import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeDatabaseConnections } from "../lib/storage.js";
import { registerCbxWebRoutes } from "../lib/web.js";
import { WorkspacePolicy } from "../lib/workspace-policy.js";
import { resetExecutorProbeCache } from "../lib/executors/builtin.js";
import { stopScheduler } from "../lib/queue-api.js";

const TOKEN = "web-post-test-token";

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
    destroyed: false,
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
      this.destroyed = true;
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

/** POST 请求：body 以可异步迭代的流形式提供（readJsonBody 用 for await）。 */
function fakePostRequest(url, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
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
  assert.ok(server.route, "路由应已完成异步注册");
  const response = fakeResponse();
  server.route.handler(req, response);
  await response.done;
  return response;
}

function parseJson(response) {
  return JSON.parse(response.body);
}

/** 建一个工作区 + 注册路由。假执行器经 CBX_CODEBUDDY 注入，使路由能找到执行器。 */
async function withServer(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cbx-web-post-"));
  const workspace = path.join(root, "ws");
  await mkdir(workspace);
  // 假执行器：脚本文件（probe 只要 existsSync 命中即可路由；任务因
  // approval_before_run=true 停在 awaiting_approval，不会真正 spawn）。
  const fakeExec = path.join(root, "fake-codebuddy.mjs");
  await writeFile(
    fakeExec,
    `export default { manifest: { apiVersion: "cbx.executor/v1", name: "fake", version: "1.0.0", capabilities: ["execute"] }, async run() { return { code: 0, output: "ok" }; } };`,
    "utf8",
  );
  const previous = process.env.CBX_CODEBUDDY;
  process.env.CBX_CODEBUDDY = fakeExec;
  resetExecutorProbeCache();
  const server = fakeContext();
  try {
    await registerCbxWebRoutes(server.context, {
      workspacePolicy: new WorkspacePolicy([workspace]),
      token: TOKEN,
    });
    return await callback({ root, workspace, server });
  } finally {
    if (previous === undefined) delete process.env.CBX_CODEBUDDY;
    else process.env.CBX_CODEBUDDY = previous;
    resetExecutorProbeCache();
    await server.dispose();
    // POST 创建会经 startBackground 拉起常驻调度器（30s 定时器 + SQLite 连接），
    // 必须先停调度器释放句柄，再关数据库连接。Windows 下 WAL 句柄释放有延迟，
    // 目录删除做 best-effort + 重试，清理失败不掩盖测试断言。
    try {
      await stopScheduler(workspace);
    } catch {
      /* 调度器未启动或已停止 */
    }
    await closeDatabaseConnections();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
}

function authHeaders() {
  return { authorization: `Bearer ${TOKEN}` };
}

test("POST /api/jobs: 无 task 返回 400", async () => {
  await withServer(async ({ workspace, server }) => {
    const response = await callRoute(
      server,
      fakePostRequest(`/cbx/api/jobs?workspace=${encodeURIComponent(workspace)}`, { review: false }, authHeaders()),
    );
    assert.equal(response.statusCode, 400);
    assert.match(parseJson(response).error, /task 必须是非空字符串/);
  });
});

test("POST /api/jobs: 非法 max_turns 返回 400", async () => {
  await withServer(async ({ workspace, server }) => {
    const response = await callRoute(
      server,
      fakePostRequest(
        `/cbx/api/jobs?workspace=${encodeURIComponent(workspace)}`,
        { task: "t", max_turns: "abc" },
        authHeaders(),
      ),
    );
    assert.equal(response.statusCode, 400);
    assert.match(parseJson(response).error, /max_turns/);
  });
});

test("POST /api/jobs: 合法创建返回 201 + job_id，任务落库为 queued", async () => {
  await withServer(async ({ workspace, server }) => {
    const response = await callRoute(
      server,
      fakePostRequest(
        `/cbx/api/jobs?workspace=${encodeURIComponent(workspace)}`,
        { task: "implement x", review: false, isolated: false, approval_before_run: true },
        authHeaders(),
      ),
    );
    assert.equal(response.statusCode, 201);
    const body = parseJson(response);
    assert.ok(body.job_id, "应返回 job_id");
    assert.equal(body.status, "queued");
    // 任务目录已创建
    assert.equal(
      existsSync(path.join(workspace, ".cbx", "jobs", body.job_id, "state.json")),
      true,
    );
  });
});

test("POST /api/jobs: 幂等键同请求去重返回既有任务（deduplicated）", async () => {
  await withServer(async ({ workspace, server }) => {
    const makeBody = () => ({
      task: "same task",
      review: false,
      isolated: false,
      approval_before_run: true,
      idempotency_key: "dup-key",
    });
    const first = await callRoute(
      server,
      fakePostRequest(`/cbx/api/jobs?workspace=${encodeURIComponent(workspace)}`, makeBody(), authHeaders()),
    );
    assert.equal(first.statusCode, 201);
    const firstId = parseJson(first).job_id;
    const second = await callRoute(
      server,
      fakePostRequest(`/cbx/api/jobs?workspace=${encodeURIComponent(workspace)}`, makeBody(), authHeaders()),
    );
    assert.equal(second.statusCode, 200, "幂等命中返回 200（非新创建）");
    const secondBody = parseJson(second);
    assert.equal(secondBody.job_id, firstId, "同幂等键应返回同一任务");
    assert.equal(secondBody.deduplicated, true);
  });
});

test("POST /api/jobs: 幂等键不同载荷返回 409 冲突", async () => {
  await withServer(async ({ workspace, server }) => {
    const first = await callRoute(
      server,
      fakePostRequest(
        `/cbx/api/jobs?workspace=${encodeURIComponent(workspace)}`,
        { task: "payload A", review: false, isolated: false, approval_before_run: true, idempotency_key: "conflict-key" },
        authHeaders(),
      ),
    );
    assert.equal(first.statusCode, 201);
    const second = await callRoute(
      server,
      fakePostRequest(
        `/cbx/api/jobs?workspace=${encodeURIComponent(workspace)}`,
        { task: "payload B", review: false, isolated: false, approval_before_run: true, idempotency_key: "conflict-key" },
        authHeaders(),
      ),
    );
    assert.equal(second.statusCode, 409);
    assert.match(parseJson(second).error, /幂等键/);
  });
});

test("POST /api/jobs: 空 idempotency_key 返回 400", async () => {
  await withServer(async ({ workspace, server }) => {
    const response = await callRoute(
      server,
      fakePostRequest(
        `/cbx/api/jobs?workspace=${encodeURIComponent(workspace)}`,
        { task: "t", review: false, isolated: false, idempotency_key: "   " },
        authHeaders(),
      ),
    );
    assert.equal(response.statusCode, 400);
    assert.match(parseJson(response).error, /idempotency_key/);
  });
});

test("POST /api/jobs: 无授权返回 401（数据端点需要 token）", async () => {
  await withServer(async ({ workspace, server }) => {
    const response = await callRoute(
      server,
      fakePostRequest(`/cbx/api/jobs?workspace=${encodeURIComponent(workspace)}`, { task: "t" }),
      // 无 authorization header
    );
    assert.equal(response.statusCode, 401);
  });
});

test("POST /api/jobs: 方法不允许返回 405", async () => {
  await withServer(async ({ workspace, server }) => {
    const req = fakePostRequest(`/cbx/api/jobs?workspace=${encodeURIComponent(workspace)}`, {}, authHeaders());
    req.method = "DELETE";
    const response = await callRoute(server, req);
    assert.equal(response.statusCode, 405);
  });
});

test("POST /api/jobs: 请求体超限返回 413", async () => {
  await withServer(async ({ workspace, server }) => {
    const huge = { task: "x".repeat(2 * 1024 * 1024), review: false };
    const response = await callRoute(
      server,
      fakePostRequest(`/cbx/api/jobs?workspace=${encodeURIComponent(workspace)}`, huge, authHeaders()),
    );
    assert.equal(response.statusCode, 413);
  });
});

test("POST /api/jobs: 非 JSON 请求体返回 400", async () => {
  await withServer(async ({ workspace, server }) => {
    const response = await callRoute(
      server,
      fakePostRequest(`/cbx/api/jobs?workspace=${encodeURIComponent(workspace)}`, "not-json{{", authHeaders()),
    );
    assert.equal(response.statusCode, 400);
    assert.match(parseJson(response).error, /JSON/);
  });
});
