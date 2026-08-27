import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  closeDatabaseConnections,
  forceReleaseOwnLock,
  insertEvent,
  eventsAfterCursor,
  loadPersistedQueue,
  loadRuntimeExecutorsAllowlist,
  listPersistedStates,
  prunePersistedData,
  saveJson,
  savePersistedState,
  savePersistedStateCas,
  savePersistedQueue,
} from "../lib/storage.js";
import { loadConfig } from "../lib/state.js";

const workspaces = [];

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "cbx-test-"));
  workspaces.push(dir);
  return dir;
}

after(async () => {
  await closeDatabaseConnections();
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

test("forceReleaseOwnLock: 仅释放本进程 pid 的锁", async () => {
  const ws = workspace();
  const own = path.join(ws, "own.lock");
  const other = path.join(ws, "other.lock");
  writeFileSync(own, JSON.stringify({ pid: process.pid, token: "a" }));
  writeFileSync(other, JSON.stringify({ pid: 999999, token: "b" }));
  assert.equal(await forceReleaseOwnLock(own), true);
  assert.equal(existsSync(own), false);
  assert.equal(await forceReleaseOwnLock(other), false);
  assert.equal(existsSync(other), true);
  assert.equal(await forceReleaseOwnLock(path.join(ws, "missing.lock")), false);
});

test("savePersistedStateCas: 胜者写入、败者返回 false（不覆盖）", async () => {
  const ws = workspace();
  await savePersistedState(ws, "j1", { status: "running", a: 1 });
  const won = await savePersistedStateCas(
    ws,
    "j1",
    { status: "running", a: 1 },
    { status: "running", a: 2, b: 1 },
  );
  assert.equal(won, true);
  const stale = await savePersistedStateCas(
    ws,
    "j1",
    { status: "running", a: 1 },
    { status: "running", a: 3 },
  );
  assert.equal(stale, false);
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(path.join(ws, ".cbx", "state.sqlite"), { readonly: true });
  const state = JSON.parse(
    db.prepare("SELECT state_json FROM jobs WHERE job_id = ?").get("j1").state_json,
  );
  db.close();
  assert.equal(state.a, 2);
  assert.equal(state.b, 1);
});

test("queue blob 损坏: 读取重置为空队列而非抛错", async () => {
  const ws = workspace();
  await savePersistedQueue(ws, { maxConcurrent: 2, paused: false, entries: [{ queueId: "q", jobId: "j", status: "queued", priority: 0, createdAt: "2026-01-01T00:00:00Z" }], updatedAt: "2026-01-01T00:00:00Z" });
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(path.join(ws, ".cbx", "state.sqlite"));
  db.prepare("UPDATE queue_state SET state_json = ?").run("{corrupt!!");
  db.close();
  const queue = await loadPersistedQueue(ws, { maxConcurrent: 2, paused: false, entries: [], updatedAt: "" });
  assert.ok(Array.isArray(queue.entries));
  assert.equal(queue.entries.length, 0);
});

test("insertEvent + eventsAfterCursor: 索引回放与截断", async () => {
  const ws = workspace();
  await insertEvent(ws, 1, "job.state_changed", { at: "2026-01-01T00:00:00Z", jobId: "j", status: "queued" });
  await insertEvent(ws, 2, "job.state_changed", { at: "2026-01-01T00:00:01Z", jobId: "j", status: "running" });
  await insertEvent(ws, 3, "job.state_changed", { at: "2026-01-01T00:00:02Z", jobId: "j", status: "done" });
  const page1 = await eventsAfterCursor(ws, 0, 2);
  assert.equal(page1.truncated, true);
  assert.deepEqual(page1.rows.map((r) => r.seq), [1, 2]);
  const page2 = await eventsAfterCursor(ws, 2, 2);
  assert.equal(page2.truncated, false);
  assert.equal(page2.rows[0].seq, 3);
  assert.equal(page2.rows[0].payload.jobId, "j");
  const empty = await eventsAfterCursor(ws, 999, 2);
  assert.equal(empty.rows.length, 0);
});

test("prune 孤儿目录回收：无 SQLite 行 + 超 1h 宽限的目录被清，活跃任务保留", async () => {
  const ws = workspace();
  // 活跃任务（非终态）+ 对应目录：必须保留
  await savePersistedState(ws, "livejob", { status: "running", updatedAt: new Date().toISOString() });
  const liveDir = path.join(ws, ".cbx", "jobs", "livejob");
  mkdirSync(liveDir, { recursive: true });
  writeFileSync(path.join(liveDir, "state.json"), "{}");
  // 孤儿目录：无行，mtime 伪造成 2 天前
  const orphanDir = path.join(ws, ".cbx", "jobs", "orphanjob");
  mkdirSync(orphanDir, { recursive: true });
  writeFileSync(path.join(orphanDir, "state.json"), "{}");
  const old = new Date(Date.now() - 2 * 86_400_000);
  utimesSync(orphanDir, old, old);
  // 新建中的目录（mtime 刚刚）：宽限期内不回收
  const freshDir = path.join(ws, ".cbx", "jobs", "freshjob");
  mkdirSync(freshDir, { recursive: true });

  await prunePersistedData(ws, 1);
  assert.equal(existsSync(liveDir), true, "活跃任务目录应保留");
  assert.equal(existsSync(orphanDir), false, "超宽限孤儿应被回收");
  assert.equal(existsSync(freshDir), true, "宽限期内目录不应回收");
});

test("loadRuntimeExecutorsAllowlist: 缺失 .cbx.json 视为未配置（回落全局）", async () => {
  const ws = workspace();
  assert.deepEqual(await loadRuntimeExecutorsAllowlist(ws), {
    configured: false,
    allowlist: undefined,
  });
});

test("loadRuntimeExecutorsAllowlist: 无顶层 executors 视为未配置", async () => {
  const ws = workspace();
  writeFileSync(path.join(ws, ".cbx.json"), JSON.stringify({ review: true }), "utf8");
  assert.deepEqual(await loadRuntimeExecutorsAllowlist(ws), {
    configured: false,
    allowlist: undefined,
  });
});

test("loadRuntimeExecutorsAllowlist: 配置白名单列表返回 configured=true", async () => {
  const ws = workspace();
  writeFileSync(
    path.join(ws, ".cbx.json"),
    JSON.stringify({ executors: { envAllowlist: ["GITHUB_TOKEN", "OPENAI_API_KEY"] } }),
    "utf8",
  );
  assert.deepEqual(await loadRuntimeExecutorsAllowlist(ws), {
    configured: true,
    allowlist: ["GITHUB_TOKEN", "OPENAI_API_KEY"],
  });
});

test("loadRuntimeExecutorsAllowlist: 显式空数组返回 configured=true 空列表（覆盖全局）", async () => {
  const ws = workspace();
  writeFileSync(path.join(ws, ".cbx.json"), JSON.stringify({ executors: { envAllowlist: [] } }), "utf8");
  assert.deepEqual(await loadRuntimeExecutorsAllowlist(ws), {
    configured: true,
    allowlist: [],
  });
});

test("loadRuntimeExecutorsAllowlist: 非法白名单类型抛错", async () => {
  const ws = workspace();
  writeFileSync(path.join(ws, ".cbx.json"), JSON.stringify({ executors: { envAllowlist: "TOKEN" } }), "utf8");
  await assert.rejects(loadRuntimeExecutorsAllowlist(ws));
});

// executorTiers：档位是路由依据，结构/取值非法必须在加载期拒绝（fail-closed）。
test("loadConfig: executorTiers 合法配置可通过校验", async () => {
  const ws = workspace();
  writeFileSync(
    path.join(ws, ".cbx.json"),
    JSON.stringify({ executorTiers: { qwen: { speedTier: 1 }, cbc: { costTier: 1 } } }),
    "utf8",
  );
  await assert.doesNotReject(loadConfig(ws));
});

test("loadConfig: executorTiers 档位越界抛错", async () => {
  const ws = workspace();
  writeFileSync(path.join(ws, ".cbx.json"), JSON.stringify({ executorTiers: { qwen: { speedTier: 5 } } }), "utf8");
  await assert.rejects(loadConfig(ws), /speedTier/);
});

test("loadConfig: executorTiers 未知字段与非对象值抛错", async () => {
  const a = workspace();
  writeFileSync(path.join(a, ".cbx.json"), JSON.stringify({ executorTiers: { qwen: { velocity: 2 } } }), "utf8");
  await assert.rejects(loadConfig(a), /velocity/);
  const b = workspace();
  writeFileSync(path.join(b, ".cbx.json"), JSON.stringify({ executorTiers: { qwen: 3 } }), "utf8");
  await assert.rejects(loadConfig(b));
});

// executors.cliArgs：CLI 参数覆盖是执行器调用面的配置，结构/取值非法必须加载期拒绝。
test("loadConfig: executors.cliArgs 合法配置可通过校验（注册名与别名均可为键）", async () => {
  const ws = workspace();
  writeFileSync(
    path.join(ws, ".cbx.json"),
    JSON.stringify({ executors: { cliArgs: { codebuddy: ["--model", "mock-x"], cbc: [], qwen: ["--yolo"] } } }),
    "utf8",
  );
  const config = await loadConfig(ws);
  assert.deepEqual(config.executors?.cliArgs?.codebuddy, ["--model", "mock-x"]);
  assert.deepEqual(config.executors?.cliArgs?.qwen, ["--yolo"]);
});

test("loadConfig: executors.cliArgs 非法结构抛错", async () => {
  const cases = [
    [{ executors: { cliArgs: "codebuddy" } }, /cliArgs/],
    [{ executors: { cliArgs: { codebuddy: "--model" } } }, /cliArgs\.codebuddy/],
    [{ executors: { cliArgs: { codebuddy: ["ok", ""] } } }, /cliArgs\.codebuddy/],
    [{ executors: { cliArgs: { codebuddy: new Array(65).fill("x") } } }, /cliArgs\.codebuddy/],
    [{ executors: { cliArgs: { unknown: ["a".repeat(513)] } } }, /cliArgs\.unknown/],
  ];
  for (const [payload, pattern] of cases) {
    const ws = workspace();
    writeFileSync(path.join(ws, ".cbx.json"), JSON.stringify(payload), "utf8");
    await assert.rejects(loadConfig(ws), pattern, `应拒绝 ${JSON.stringify(payload)}`);
  }
});

// configCompat：严格校验的逃生门（升级后需降级/快速恢复）+ schemaVersion 显式版本门。
test("loadConfig: 缺省 strict=true——未知字段整体拒绝（既有行为）", async () => {
  const ws = workspace();
  writeFileSync(path.join(ws, ".cbx.json"), JSON.stringify({ review: true, futureField: 1 }), "utf8");
  await assert.rejects(loadConfig(ws), /futureField/);
});

test("loadConfig: configCompat.strict=false——未知字段降级为警告并忽略", async () => {
  const ws = workspace();
  writeFileSync(
    path.join(ws, ".cbx.json"),
    JSON.stringify({ review: true, futureField: "v2-only", configCompat: { strict: false } }),
    "utf8",
  );
  const config = await loadConfig(ws);
  assert.equal(config.review, true, "已知字段照常生效");
});

test("loadConfig: configCompat.strict=false 不豁免安全字段拼写（costs/pluginz 仍拒绝）", async () => {
  for (const payload of [
    { costs: { maxExecutorInvocations: 1 }, configCompat: { strict: false } },
    { plugin: [{ path: "x" }], configCompat: { strict: false } },
    { reviewGatee: { failOpen: true }, configCompat: { strict: false } },
  ]) {
    const ws = workspace();
    writeFileSync(path.join(ws, ".cbx.json"), JSON.stringify(payload), "utf8");
    await assert.rejects(loadConfig(ws), /安全字段拼写/, `应拒绝 ${JSON.stringify(payload)}`);
  }
});

test("loadConfig: configCompat.strict 非布尔值拒绝", async () => {
  const ws = workspace();
  writeFileSync(path.join(ws, ".cbx.json"), JSON.stringify({ configCompat: { strict: "no" } }), "utf8");
  await assert.rejects(loadConfig(ws), /strict 必须是布尔值/);
});

test("loadConfig: configCompat.schemaVersion 高于当前版本拒绝（fail-closed）", async () => {
  const ws = workspace();
  writeFileSync(path.join(ws, ".cbx.json"), JSON.stringify({ configCompat: { schemaVersion: 99 } }), "utf8");
  await assert.rejects(loadConfig(ws), /schemaVersion=99/);
});

test("loadConfig: configCompat.schemaVersion 非法值拒绝，当前版本放行", async () => {
  for (const bad of [0, -1, 1.5, "x"]) {
    const ws = workspace();
    writeFileSync(path.join(ws, ".cbx.json"), JSON.stringify({ configCompat: { schemaVersion: bad } }), "utf8");
    await assert.rejects(loadConfig(ws), /schemaVersion/, `应拒绝 schemaVersion=${bad}`);
  }
  const ok = workspace();
  writeFileSync(path.join(ok, ".cbx.json"), JSON.stringify({ configCompat: { schemaVersion: 1, strict: false }, futureField: 1 }), "utf8");
  await assert.doesNotReject(loadConfig(ok));
});

test("listPersistedStates: 分页 limit/offset 按 updated_at 倒序返回", async () => {
  const ws = workspace();
  // updated_at 列由 savePersistedState 以 now() 写入（真实时间），逐条写保证
  // 后写者 updated_at 更大；断言按"写入顺序倒序"（最新在前）。
  await savePersistedState(ws, "j1", { jobId: "j1", status: "done" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await savePersistedState(ws, "j2", { jobId: "j2", status: "done" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await savePersistedState(ws, "j3", { jobId: "j3", status: "done" });
  const all = await listPersistedStates(ws);
  assert.deepEqual(all.map((s) => s.jobId), ["j3", "j2", "j1"]);
  const page1 = await listPersistedStates(ws, { limit: 2 });
  assert.deepEqual(page1.map((s) => s.jobId), ["j3", "j2"]);
  const page2 = await listPersistedStates(ws, { limit: 2, offset: 2 });
  assert.deepEqual(page2.map((s) => s.jobId), ["j1"]);
  const beyond = await listPersistedStates(ws, { limit: 2, offset: 10 });
  assert.deepEqual(beyond, []);
});

test("listPersistedStates: 分页不改变全量语义（limit 缺省返回全部）", async () => {
  const ws = workspace();
  await savePersistedState(ws, "x1", { status: "queued", updatedAt: "2026-01-01T00:00:00Z" });
  const all = await listPersistedStates(ws);
  assert.equal(all.length, 1);
});

test("saveJson: fsync:false 仍原子写（临时文件 + rename），文件内容完整", async () => {
  const ws = workspace();
  const file = path.join(ws, "mirror.json");
  await saveJson(file, { a: 1, nested: { b: [1, 2] } }, { fsync: false });
  assert.deepEqual(JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8")), {
    a: 1,
    nested: { b: [1, 2] },
  });
  // 覆盖写也正常（rename 语义）
  await saveJson(file, { c: 2 }, { fsync: false });
  assert.deepEqual(JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8")), {
    c: 2,
  });
});
