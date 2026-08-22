import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeDatabaseConnections, savePersistedState } from "../lib/storage.js";
import { liveFacadeIds, publishCbxFacade, splitText } from "../lib/subagent-facade.js";

/** 可注入 ctx：get('sessions') 返回假 store，get('agents') 可选。 */
function fakeContext(sessions, agents) {
  const ctx = {
    effect(callback) {
      // 瘦 profile 语义：立即执行并持有 disposer，dispose 时调用。
      const disposer = callback();
      ctx._disposers.push(disposer);
      return disposer;
    },
    _disposers: [],
    disposeAll() {
      for (const d of [...ctx._disposers]) d?.();
    },
    get(name) {
      if (name === "sessions") return sessions;
      if (name === "agents") return agents;
      return undefined;
    },
  };
  return ctx;
}

/** 假 session store：prepare/enter/announce + 记录 append 的假 Session。 */
function fakeSessionsStore() {
  const sessions = [];
  const store = {
    sessions,
    prepare(id, options) {
      const session = {
        id,
        header: { id, ...(options?.meta ?? {}) },
        events: [],
        append(type, data, opts) {
          this.events.push({ type, data, opts });
        },
      };
      session.prepared = true;
      return session;
    },
    enter(session) {
      session.entered = true;
      session.detached = false;
      store.sessions.push(session);
      return () => {
        session.detached = true;
      };
    },
    announce(session) {
      session.announced = true;
    },
  };
  return store;
}

async function withJob(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cbx-facade-"));
  const workspace = path.join(root, "ws");
  const jobId = "20260101000000-abc123";
  const dir = path.join(workspace, ".cbx", "jobs", jobId);
  await mkdir(dir, { recursive: true });
  try {
    return await callback({ root, workspace, jobId, dir });
  } finally {
    // 镜像轮询的 loadState 是 fire-and-forget，可能在 closeDatabaseConnections 返回后
    // 才打开新连接 → rm 撞 EBUSY（Windows 瞬态句柄）。沿用 jobs-bridge 的退避重试模式。
    for (let attempt = 0; ; attempt += 1) {
      await closeDatabaseConnections();
      try {
        await rm(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}

async function writeState(dir, status, extra = {}) {
  const state = {
    jobId: "20260101000000-abc123",
    status,
    phase: null,
    workspace: path.resolve(path.join(dir, "..", "..", "..")),
    jobDir: dir,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    attempt: 0,
    ...extra,
  };
  await writeFile(path.join(dir, "state.json"), JSON.stringify(state), "utf8");
  // 镜像轮询经 loadState 读 SQLite；与生产一致双写。
  await savePersistedState(state.workspace, state.jobId, state);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await sleep(20);
  }
};

test("publishCbxFacade: 无 agent 上下文时不发布（reason=no-agent-context）", () => {
  const logs = [];
  const result = publishCbxFacade(fakeContext(fakeSessionsStore()), {
    workspace: "C:/ws",
    jobId: "j1",
    task: "t",
    agent: undefined,
    logger: (m) => logs.push(m),
  });
  assert.equal(result.sessionId, undefined);
  assert.equal(result.reason, "no-agent-context");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /无 agent 上下文/);
});

test("publishCbxFacade: 无 sessions 服务时不发布（reason=no-sessions-service）", () => {
  const result = publishCbxFacade(fakeContext(undefined, { currentInitiator: () => ({ id: "parent-1" }) }), {
    workspace: "C:/ws",
    jobId: "j1",
    task: "t",
  });
  assert.equal(result.sessionId, undefined);
  assert.equal(result.reason, "no-sessions-service");
});

test("publishCbxFacade: 发布成功——初始事件齐备、镜像启动、enter/announce 调用", async () => {
  await withJob(async ({ workspace, jobId, dir }) => {
    await writeState(dir, "queued");
    const store = fakeSessionsStore();
    const logs = [];
    const ctx = fakeContext(store, { currentInitiator: () => ({ id: "parent-1" }) });
    const result = publishCbxFacade(ctx, {
      workspace,
      jobId,
      task: "审查这个项目",
      agent: undefined,
      logger: (m) => logs.push(m),
      pollMs: 20,
    });
    assert.equal(result.reason, undefined);
    assert.equal(result.sessionId, `cbx-${jobId}`);
    assert.equal(store.sessions.length, 1);
    const session = store.sessions[0];
    assert.equal(session.header.origin, "subagent");
    assert.equal(session.header.parentSession, "parent-1");
    assert.equal(session.header.cwd, workspace);
    assert.equal(session.entered, true);
    assert.equal(session.announced, true);
    // 初始事件：turn/start + subagent/descriptor + user/message。
    const types = session.events.map((e) => e.type);
    assert.ok(types.includes("turn/start"));
    assert.ok(types.includes("subagent/descriptor"));
    assert.ok(types.includes("user/message"));
    const descriptor = session.events.find((e) => e.type === "subagent/descriptor").data;
    assert.equal(descriptor.version, 2);
    assert.equal(descriptor.mode, "one-shot");
    assert.equal(descriptor.provider, "cbx");
    assert.match(descriptor.label, new RegExp(`cbx ${jobId}`));
    // 镜像轮询开始：status queued 的迁移行会作为 assistant/message 出现。
    await waitFor(() => session.events.some((e) => e.type === "assistant/message"));
    assert.equal(liveFacadeIds(ctx).length, 1);
    // 清理：context dispose 触发 registry 清理（detach 幂等）。
    ctx.disposeAll();
  });
});

test("publishCbxFacade: 终态时结算——追加摘要与 turn/end、detach、registry 清空", async () => {
  await withJob(async ({ workspace, jobId, dir }) => {
    await writeState(dir, "queued");
    const store = fakeSessionsStore();
    const ctx = fakeContext(store, { currentInitiator: () => ({ id: "parent-1" }) });
    publishCbxFacade(ctx, {
      workspace,
      jobId,
      task: "审查这个项目",
      logger: () => undefined,
      pollMs: 20,
    });
    const session = store.sessions[0];
    await waitFor(() => session.events.some((e) => e.type === "assistant/message"));
    assert.equal(session.detached, false);
    // 任务进入终态 → 镜像结算。
    await writeState(dir, "done", { phase: "done" });
    await waitFor(() => session.detached === true);
    const types = session.events.map((e) => e.type);
    assert.ok(types.includes("turn/end"));
    const finals = session.events.filter((e) => e.type === "assistant/message");
    assert.ok(finals.some((e) => e.data.message.content.some((b) => b.type === "text" && /cbx .* done/.test(b.text))));
    assert.equal(liveFacadeIds(ctx).length, 0);
  });
});

test("publishCbxFacade: 同 job 重复发布复用既有外观会话（existing=true）", async () => {
  await withJob(async ({ workspace, jobId, dir }) => {
    await writeState(dir, "queued");
    const store = fakeSessionsStore();
    const ctx = fakeContext(store, { currentInitiator: () => ({ id: "parent-1" }) });
    const first = publishCbxFacade(ctx, { workspace, jobId, task: "t1", pollMs: 20 });
    const second = publishCbxFacade(ctx, { workspace, jobId, task: "t2", pollMs: 20 });
    assert.equal(first.sessionId, `cbx-${jobId}`);
    assert.equal(second.sessionId, `cbx-${jobId}`);
    assert.equal(second.existing, true);
    assert.equal(store.sessions.length, 1);
    // 清理：把 job 置终态让镜像结算，避免测试进程遗留定时器。
    await writeState(dir, "cancelled");
    await waitFor(() => store.sessions[0].detached === true);
  });
});

test("publishCbxFacade: 发布时立即追加路由决策消息（委派给谁+原因，不等轮询）", async () => {
  await withJob(async ({ workspace, jobId, dir }) => {
    await writeState(dir, "queued");
    const store = fakeSessionsStore();
    const ctx = fakeContext(store, { currentInitiator: () => ({ id: "parent-1" }) });
    publishCbxFacade(ctx, {
      workspace,
      jobId,
      task: "审查这个项目",
      router: { executor: "opencode", routed: false, reason: "OpenCode（opencode）已安装，直接使用。" },
      logger: () => undefined,
      pollMs: 20,
    });
    const session = store.sessions[0];
    // 首条 assistant 消息就是路由决策（发布时同步追加，先于任何镜像轮询输出）。
    const notes = session.events.filter((e) => e.type === "assistant/message");
    assert.ok(notes.length >= 1);
    assert.ok(
      notes[0].data.message.content.some((b) => b.type === "text" && b.text.includes("已委派给执行器 opencode")),
    );
    // 清理：置终态让镜像结算，避免测试进程遗留定时器。
    await writeState(dir, "cancelled");
    await waitFor(() => session.detached === true);
  });
});

test("publishCbxFacade: 无 router 时不追加路由消息（旧行为不变）", async () => {
  await withJob(async ({ workspace, jobId, dir }) => {
    await writeState(dir, "queued");
    const store = fakeSessionsStore();
    const ctx = fakeContext(store, { currentInitiator: () => ({ id: "parent-1" }) });
    publishCbxFacade(ctx, { workspace, jobId, task: "t", logger: () => undefined, pollMs: 20 });
    const session = store.sessions[0];
    await waitFor(() => session.events.some((e) => e.type === "assistant/message"));
    const texts = session.events
      .filter((e) => e.type === "assistant/message")
      .flatMap((e) => e.data.message.content.filter((b) => b.type === "text").map((b) => b.text));
    assert.ok(texts.every((t) => !t.includes("已委派给执行器") && !t.includes("已自动路由到执行器")));
    await writeState(dir, "cancelled");
    await waitFor(() => session.detached === true);
  });
});

test("splitText: 短文本原样、长文本按 limit 切分（优先换行）", () => {
  assert.deepEqual(splitText("abc", 10), ["abc"]);
  const long = "a".repeat(100) + "\n" + "b".repeat(100);
  const pieces = splitText(long, 50);
  assert.ok(pieces.length > 1);
  assert.equal(pieces.join(""), long);
  for (const piece of pieces) assert.ok(piece.length <= 50 + 1); // 换行边界允许 1 字符余量
});
