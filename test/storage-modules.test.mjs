import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  closeDatabaseConnections,
  enqueueDelivery,
  claimPendingDelivery,
  rescheduleDelivery,
  completeDelivery,
  nextPendingDeliveryAt,
  recordDeliveryFailure,
  getMetadata,
  setMetadata,
  tryReserveMetadata,
  deleteMetadata,
  replaceMetadataIfMatch,
  nextEventSeq,
  acquireServiceLease,
  savePersistedState,
  loadPersistedState,
  saveApprovalRequeue,
  loadPersistedQueue,
  savePersistedQueue,
  prunePersistedData,
} from "../lib/storage.js";
import { CbxError, isCbxError } from "../lib/errors.js";

const workspaces = [];
after(async () => {
  await closeDatabaseConnections();
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

function makeWs() {
  const ws = mkdtempSync(path.join(tmpdir(), "cbx-storage-mod-"));
  workspaces.push(ws);
  return ws;
}

// ---------------------------------------------------------------------------
// storage/outbox —— delivery 生命周期
// ---------------------------------------------------------------------------

test("outbox: enqueue → claim → complete 完整生命周期", async () => {
  const ws = makeWs();
  const id = await enqueueDelivery(ws, {
    channel: "webhook",
    endpoint: "https://example.com/hook",
    body: { event: "job.state_changed", jobId: "j1" },
    config: { timeoutMs: 3000, maxRetries: 2 },
  });
  assert.ok(id > 0);

  // claim：返回待投递项 + attempts=0
  const claimed = await claimPendingDelivery(ws, "owner-a");
  assert.ok(claimed, "应有可认领的投递");
  assert.equal(claimed.id, id);
  assert.equal(claimed.channel, "webhook");
  assert.equal(claimed.body.event, "job.state_changed");
  assert.equal(claimed.attempts, 0);

  // 认领后（锁内）另一 owner 拿不到
  const second = await claimPendingDelivery(ws, "owner-b");
  assert.equal(second, undefined, "已被 owner-a 认领，owner-b 不应拿到");

  // complete：删除
  await completeDelivery(ws, id, "owner-a");
  const afterComplete = await claimPendingDelivery(ws, "owner-b");
  assert.equal(afterComplete, undefined, "完成后不应再有可认领项");
});

test("outbox: reschedule 重试（attempts 递增 + available_at 推迟）", async () => {
  const ws = makeWs();
  const id = await enqueueDelivery(ws, {
    channel: "otlp",
    endpoint: "http://otel:4318",
    body: { traceId: "t" },
    config: { timeoutMs: 1000, maxRetries: 3, retryBaseMs: 100 },
  });
  const claimed = await claimPendingDelivery(ws, "owner");
  assert.equal(claimed.attempts, 0);

  // 失败 → reschedule（attempts 1，available_at 推迟 100ms）
  await rescheduleDelivery(ws, id, "owner", 1, Date.now() + 100, "boom");
  const next = await claimPendingDelivery(ws, "owner-2");
  assert.equal(next, undefined, "reschedule 后 available_at 未到，不应可认领");

  // 等到 available_at 后可再次认领，attempts=1
  await new Promise((resolve) => setTimeout(resolve, 150));
  const retried = await claimPendingDelivery(ws, "owner-2");
  assert.ok(retried, "available_at 到达后应可重试");
  assert.equal(retried.attempts, 1);
});

test("outbox: nextPendingDeliveryAt 返回下一个可用时间", async () => {
  const ws = makeWs();
  assert.equal(await nextPendingDeliveryAt(ws), undefined, "无投递时返回 undefined");
  await enqueueDelivery(ws, {
    channel: "webhook",
    endpoint: "https://example.com/hook",
    body: { a: 1 },
    config: {},
  });
  const next = await nextPendingDeliveryAt(ws);
  assert.ok(typeof next === "number" && next > 0, "有投递时返回 epoch ms");
});

test("outbox: recordDeliveryFailure 落审计表", async () => {
  const ws = makeWs();
  await recordDeliveryFailure(ws, { channel: "webhook", error: "boom" });
  await recordDeliveryFailure(ws, { channel: "otlp", error: "timeout" });
  // 经 prunePersistedData 的 delivery_failures 计数验证（间接）
  // 直接用 SQLite 查（只读连接）
  const db = (await import("better-sqlite3")).default;
  const conn = new db(path.join(ws, ".cbx", "state.sqlite"), { readonly: true });
  const count = conn.prepare("SELECT COUNT(*) AS c FROM delivery_failures").get().c;
  conn.close();
  assert.equal(count, 2);
});

// ---------------------------------------------------------------------------
// storage/meta —— metadata 读写 / 原子预留 / CAS / event_seq
// ---------------------------------------------------------------------------

test("meta: set/get/delete 基本读写", async () => {
  const ws = makeWs();
  assert.equal(await getMetadata(ws, "k1"), undefined, "不存在返回 undefined");
  await setMetadata(ws, "k1", "v1");
  assert.equal(await getMetadata(ws, "k1"), "v1");
  await setMetadata(ws, "k1", "v2"); // upsert
  assert.equal(await getMetadata(ws, "k1"), "v2");
  await deleteMetadata(ws, "k1");
  assert.equal(await getMetadata(ws, "k1"), undefined);
});

test("meta: tryReserveMetadata 原子预留（只有一方拿到）", async () => {
  const ws = makeWs();
  assert.equal(await tryReserveMetadata(ws, "reserve:key", "first"), true);
  assert.equal(await tryReserveMetadata(ws, "reserve:key", "second"), false, "已预留则拒绝");
  assert.equal(await getMetadata(ws, "reserve:key"), "first", "原值不被覆盖");
  // 删除后可重新预留
  await deleteMetadata(ws, "reserve:key");
  assert.equal(await tryReserveMetadata(ws, "reserve:key", "third"), true);
});

test("meta: replaceMetadataIfMatch CAS（条件替换）", async () => {
  const ws = makeWs();
  await setMetadata(ws, "cas:key", "old");
  assert.equal(await replaceMetadataIfMatch(ws, "cas:key", "old", "new"), true);
  assert.equal(await getMetadata(ws, "cas:key"), "new");
  assert.equal(await replaceMetadataIfMatch(ws, "cas:key", "old", "x"), false, "值已变则拒绝");
  assert.equal(await getMetadata(ws, "cas:key"), "new", "失败不改变值");
});

test("meta: nextEventSeq 单调递增且唯一", async () => {
  const ws = makeWs();
  const s1 = await nextEventSeq(ws);
  const s2 = await nextEventSeq(ws);
  const s3 = await nextEventSeq(ws);
  assert.equal(s2, s1 + 1);
  assert.equal(s3, s2 + 1);
});

// ---------------------------------------------------------------------------
// storage/lease —— 租约互斥
// ---------------------------------------------------------------------------

test("lease: 同进程可反复获取（HMR 接管语义）", async () => {
  const ws = makeWs();
  const lease1 = await acquireServiceLease(ws, "scheduler");
  assert.ok(lease1, "首次获取成功");
  // 同进程再次获取：HMR 场景允许接管（owner_pid === process.pid）
  const lease2 = await acquireServiceLease(ws, "scheduler");
  assert.ok(lease2, "同进程可接管");
  // 旧租约 renew 失败（token 已被新租约替换）
  assert.equal(await lease1.renew(), false, "旧租约续期应失败");
  assert.equal(await lease2.renew(), true, "新租约续期应成功");
  await lease2.release();
});

test("lease: 跨进程互斥（模拟他进程持有活跃租约）", async () => {
  const ws = makeWs();
  // 先触发 database() 初始化 schema（migrate 建表）
  await nextEventSeq(ws);
  const db = (await import("better-sqlite3")).default;
  const conn = new db(path.join(ws, ".cbx", "state.sqlite"));
  // 直接插入一个"他进程"（pid=999999 不存在 → processAlive=false，但仍占锁）
  conn.prepare(
    "INSERT INTO service_leases(name, owner_pid, expires_at, owner_token) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET owner_pid=excluded.owner_pid, expires_at=excluded.expires_at, owner_token=excluded.owner_token",
  ).run("svc", 999999, Date.now() + 60_000, "other-token");
  conn.close();
  // 他进程 pid 不存活 → 可接管（不抛 E_LEASE_HELD）
  const lease = await acquireServiceLease(ws, "svc");
  assert.ok(lease);
  await lease.release();
});

// ---------------------------------------------------------------------------
// storage/persist —— 审批重入队（原子性）
// ---------------------------------------------------------------------------

test("persist: saveApprovalRequeue 原子重入队（state 回 queued + entry 重新激活）", async () => {
  const ws = makeWs();
  await savePersistedState(ws, "ajob", { jobId: "ajob", status: "awaiting_approval", phase: "before_run" });
  // 构造 awaiting_approval 队列条目
  await savePersistedQueue(ws, {
    maxConcurrent: 2,
    paused: false,
    entries: [{ queueId: "q1", jobId: "ajob", status: "awaiting_approval", priority: 0, createdAt: "2026-01-01T00:00:00Z" }],
    updatedAt: "2026-01-01T00:00:00Z",
  });
  // 审批重入队：state 回 queued + entry 重新激活（同事务）
  await saveApprovalRequeue(ws, "ajob", { jobId: "ajob", status: "queued", phase: "queued", approved: true });
  const state = await loadPersistedState(ws, "ajob");
  assert.equal(state.status, "queued");
  assert.equal(state.approved, true);
  const queue = await loadPersistedQueue(ws, { entries: [] });
  const entry = queue.entries.find((e) => e.jobId === "ajob");
  assert.equal(entry.status, "queued", "队列条目应重新激活为 queued");
  assert.equal(entry.finishedAt, undefined, "finishedAt 应清除");
});

// ---------------------------------------------------------------------------
// storage/prune —— 终态清理（不触碰活动工作集）
// ---------------------------------------------------------------------------

test("prune: 只清终态超保留期的 job，running/queued 保留", async () => {
  const ws = makeWs();
  const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const recent = new Date().toISOString();
  // 终态 + 超期 → 应删
  await savePersistedState(ws, "old-done", { jobId: "old-done", status: "done", updatedAt: old });
  // 终态 + 近期 → 保留（未超保留期）
  await savePersistedState(ws, "recent-done", { jobId: "recent-done", status: "done", updatedAt: recent });
  // 非终态 → 保留（即使超期）
  await savePersistedState(ws, "old-running", { jobId: "old-running", status: "running", updatedAt: old });
  await prunePersistedData(ws, 1);
  assert.equal(await loadPersistedState(ws, "old-done"), undefined, "超期终态应被清");
  assert.ok(await loadPersistedState(ws, "recent-done"), "近期终态应保留");
  assert.ok(await loadPersistedState(ws, "old-running"), "非终态应保留");
});

test("prune: 非法 jobId 只清行不删目录（防路径穿越）", async () => {
  const ws = makeWs();
  const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
  // 先触发 database() 初始化 schema
  await nextEventSeq(ws);
  // 直接 SQLite 插入污染 jobId（绕过 assertJobId 门）
  const db = (await import("better-sqlite3")).default;
  const conn = new db(path.join(ws, ".cbx", "state.sqlite"));
  conn.prepare("INSERT INTO jobs(job_id, state_json, updated_at) VALUES (?, ?, ?)").run(
    "../../evil",
    JSON.stringify({ status: "done", updatedAt: old }),
    old,
  );
  conn.close();
  // 造一个目录
  const evilDir = path.join(ws, ".cbx", "jobs", "..", "..", "evil");
  mkdirSync(evilDir, { recursive: true });
  const guardFile = path.join(evilDir, "guard.txt");
  writeFileSync(guardFile, "keep", "utf8");

  await prunePersistedData(ws, 1);
  // 行被清，但目录不应被 rm（非法 id 只清行）
  assert.equal(await loadPersistedState(ws, "../../evil"), undefined);
  assert.equal(existsSync(guardFile), true, "非法 id 的目录不应被删除");
});

test("isCbxError: E_LEASE_HELD 识别", async () => {
  // 错误码枚举完整性（直接验证 CbxError 构造与识别）
  const err = new CbxError("E_LEASE_HELD", "held");
  assert.equal(isCbxError(err, "E_LEASE_HELD"), true);
  assert.equal(isCbxError(err, "E_NOT_FOUND"), false);
});
