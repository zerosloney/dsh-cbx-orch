import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeDatabaseConnections } from "../lib/storage.js";
import { registerCbxWebRoutes } from "../lib/web.js";
import { resolveWebWorkspaceList } from "../lib/web-plugin.js";
import { WorkspacePolicy } from "../lib/workspace-policy.js";

function fakeContext() {
  let activeRoute;
  const cleanups = [];
  const registered = new Set();
  const logger = { warn() {}, error() {}, info() {} };
  const context = {
    logger() {
      return logger;
    },
    webServer: {
      register(definition) {
        activeRoute = definition;
        registered.add(definition);
        return () => {
          registered.delete(definition);
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
    get registeredCount() {
      return registered.size;
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

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(predicate(), true, message);
}

async function openSse(server) {
  assert.ok(server.route, "路由应已完成异步注册");
  const response = fakeResponse();
  server.route.handler(
    fakeRequest("/cbx/events"),
    response,
  );
  await waitFor(
    () => response.body.includes('"type":"connected"'),
    "SSE 连接应完成 aggregate 初始回放",
  );
  return response;
}

function fakeRequest(url, headers = {}) {
  return {
    method: "GET",
    url,
    headers: { host: "localhost", ...headers },
    socket: { remoteAddress: "127.0.0.1" },
    on() {
      return this;
    },
  };
}

async function callRoute(server, url) {
  assert.ok(server.route, "路由应已完成异步注册");
  const response = fakeResponse();
  server.route.handler(
    fakeRequest(url),
    response,
  );
  await response.done;
  return response;
}

async function withWorkspaces(callback, { count = 2 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cbx-web-policy-"));
  const workspaces = [];
  for (let index = 0; index < count; index += 1) {
    const workspace = path.join(root, `workspace-${index}`);
    await mkdir(workspace);
    workspaces.push(workspace);
  }
  const server = fakeContext();
  try {
    return await callback({ root, workspaces, server });
  } finally {
    await server.dispose();
    await closeDatabaseConnections();
    await rm(root, { recursive: true, force: true });
  }
}

function queueUrl(workspace) {
  return workspace === undefined
    ? "/cbx/api/queue"
    : `/cbx/api/queue?workspace=${encodeURIComponent(workspace)}`;
}

test("resolveWebWorkspaceList: 显式列表原样返回", async () => {
  const paths = await resolveWebWorkspaceList({ web: { workspaces: ["/a", "/b"] } });
  assert.deepEqual(paths, ["/a", "/b"]);
});

test("resolveWebWorkspaceList: 空列表跟随注册表，丢弃缺失目录并去重", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cbx-web-registry-"));
  try {
    const alive = path.join(root, "alive");
    await mkdir(alive);
    const missing = path.join(root, "missing");
    const registry = {
      list() {
        return [
          { path: alive },
          { path: missing },
          { path: alive }, // 去重
        ];
      },
    };
    const paths = await resolveWebWorkspaceList({}, registry);
    assert.equal(paths.length, 1);
    assert.equal(path.resolve(paths[0]), path.resolve(alive));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveWebWorkspaceList: 无注册表或注册表为空时返回空数组", async () => {
  assert.deepEqual(await resolveWebWorkspaceList({}), []);
  assert.deepEqual(
    await resolveWebWorkspaceList({}, { list: () => [] }),
    [],
  );
  assert.deepEqual(
    await resolveWebWorkspaceList({}, undefined),
    [],
  );
});

test("Web 注册是 async：完成前不假定 /cbx 路由已就绪，effect dispose 会卸载路由", async () => {
  await withWorkspaces(async ({ workspaces, server }) => {
    const basePolicy = new WorkspacePolicy([workspaces[0]]);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const delayedPolicy = {
      async listAllowedWorkspaces() {
        await gate;
        return basePolicy.listAllowedWorkspaces();
      },
      resolveWorkspace(input) {
        return basePolicy.resolveWorkspace(input);
      },
    };

    const registration = registerCbxWebRoutes(server.context, {
      workspacePolicy: delayedPolicy,

    });
    assert.equal(server.route, undefined);
    release();
    await registration;
    assert.ok(server.route);
    assert.equal(server.registeredCount, 1);

    await server.dispose();
    assert.equal(server.route, undefined);
    assert.equal(server.registeredCount, 0);
  });
});

test("默认 workspace 使用 canonical 首项，显式相对别名命中第二个 canonical workspace", async () => {
  await withWorkspaces(async ({ workspaces, server }) => {
    const [first, second] = workspaces;
    const firstAlias = path.relative(process.cwd(), first) || ".";
    const secondAlias = path.relative(process.cwd(), second) || ".";
    await registerCbxWebRoutes(server.context, {
      workspacePolicy: new WorkspacePolicy([firstAlias, second]),

    });

    const defaultResponse = await callRoute(server, queueUrl());
    assert.equal(defaultResponse.statusCode, 200);
    assert.equal(existsSync(path.join(first, ".cbx", "state.sqlite")), true);
    assert.equal(existsSync(path.join(second, ".cbx", "state.sqlite")), false);

    const aliasResponse = await callRoute(server, queueUrl(secondAlias));
    assert.equal(aliasResponse.statusCode, 200);
    assert.equal(existsSync(path.join(second, ".cbx", "state.sqlite")), true);
  });
});

test("聚合 events/workspaces 端点拒绝任何 workspace query", async () => {
  await withWorkspaces(async ({ workspaces, server }) => {
    await registerCbxWebRoutes(server.context, {
      workspacePolicy: new WorkspacePolicy(workspaces),

    });

    for (const pathname of ["/cbx/events", "/cbx/api/workspaces"]) {
      const response = await callRoute(server, `${pathname}?workspace=${encodeURIComponent(workspaces[0])}`);
      assert.equal(response.statusCode, 400, `${pathname} 应拒绝 workspace query`);
      assert.match(response.body, /workspace/);
    }
  });
});

test("SSE workspace identity 替换后关闭连接且不广播新目标事件", async (t) => {
  await withWorkspaces(async ({ root, workspaces, server }) => {
    const [allowed, denied] = workspaces;
    const moved = path.join(root, "workspace-0-moved");
    await registerCbxWebRoutes(server.context, {
      workspacePolicy: new WorkspacePolicy([allowed]),

    });
    const response = await openSse(server);

    // replayEvents may have opened the workspace SQLite file; close only the
    // test cache before Windows directory rename, leaving the SSE/tailer alive.
    await closeDatabaseConnections();
    await rename(allowed, moved);
    try {
      try {
        await symlink(denied, allowed, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        await rename(moved, allowed);
        if (error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "EINVAL") {
          t.skip("当前平台不允许创建目录符号链接：" + error.code);
          return;
        }
        throw error;
      }

      await waitFor(() => response.destroyed, "workspace identity 失效后 SSE 应被销毁");
      await mkdir(path.join(denied, ".cbx"));
      await writeFile(
        path.join(denied, ".cbx", "events.ndjson"),
        JSON.stringify({ seq: 1, event: "unauthorized_event_marker" }) + "\n",
        "utf8",
      );
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.equal(response.body.includes("unauthorized_event_marker"), false);
    } finally {
      await rm(allowed, { recursive: true, force: true });
      await rm(moved, { recursive: true, force: true });
    }
  });
});

test("SSE events 文件暂不存在时 guard 不会断开，创建后仍可收到事件", async () => {
  await withWorkspaces(async ({ workspaces, server }) => {
    const [allowed] = workspaces;
    await registerCbxWebRoutes(server.context, {
      workspacePolicy: new WorkspacePolicy([allowed]),

    });
    const response = await openSse(server);
    await new Promise((resolve) => setTimeout(resolve, 700));

    await mkdir(path.join(allowed, ".cbx"), { recursive: true });
    await writeFile(
      path.join(allowed, ".cbx", "events.ndjson"),
      JSON.stringify({ seq: 1, event: "late_event_marker" }) + "\n",
      "utf8",
    );
    await waitFor(
      () => response.body.includes("late_event_marker"),
      "events 文件后创建时 SSE 应继续接收事件",
    );
    assert.equal(response.destroyed, false);
  });
});

test("默认 workspace 每次请求重新 canonicalize，替换为越权 symlink 时拒绝且不访问新目标", async (t) => {
  await withWorkspaces(async ({ root, workspaces, server }) => {
    const [allowed, denied] = workspaces;
    const moved = path.join(root, "workspace-0-moved");
    await registerCbxWebRoutes(server.context, {
      workspacePolicy: new WorkspacePolicy([allowed]),

    });

    await rename(allowed, moved);
    try {
      try {
        await symlink(denied, allowed, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        await rename(moved, allowed);
        if (error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "EINVAL") {
          t.skip("当前平台不允许创建目录符号链接：" + error.code);
          return;
        }
        throw error;
      }

      const response = await callRoute(server, queueUrl());
      assert.ok(response.statusCode >= 400 && response.statusCode < 500);
      assert.match(response.body, /工作区|workspace/);
      assert.equal(existsSync(path.join(denied, ".cbx")), false);
    } finally {
      await rm(allowed, { recursive: true, force: true });
      await rm(moved, { recursive: true, force: true });
    }
  });
});

test("显式越权、缺失、非目录和空 workspace 均返回 4xx，不回退到默认 workspace", async () => {
  await withWorkspaces(async ({ root, workspaces, server }) => {
    const [allowed] = workspaces;
    const denied = path.join(root, "denied");
    const missing = path.join(root, "missing");
    const file = path.join(root, "not-a-directory");
    await mkdir(denied);
    await writeFile(file, "fixture", "utf8");
    await registerCbxWebRoutes(server.context, {
      workspacePolicy: new WorkspacePolicy([allowed]),

    });

    for (const [label, url] of [
      ["越权", queueUrl(denied)],
      ["缺失", queueUrl(missing)],
      ["非目录", queueUrl(file)],
      ["空值", queueUrl("")],
    ]) {
      const response = await callRoute(server, url);
      assert.ok(response.statusCode >= 400 && response.statusCode < 500, `${label} 应返回 4xx`);
      assert.match(response.body, /工作区|workspace/);
      assert.equal(
        existsSync(path.join(allowed, ".cbx")),
        false,
        `${label} 不应回退并访问默认 workspace`,
      );
    }
    assert.equal(existsSync(path.join(denied, ".cbx")), false);
  });
});
