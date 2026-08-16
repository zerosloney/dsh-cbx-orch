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
  prunePersistedData,
  savePersistedState,
  savePersistedStateCas,
  savePersistedQueue,
} from "../lib/storage.js";

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
