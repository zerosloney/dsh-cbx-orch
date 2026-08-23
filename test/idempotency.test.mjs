import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createJob } from "../lib/jobs.js";
import {
  closeDatabaseConnections,
  getMetadata,
  replaceMetadataIfMatch,
  setMetadata,
  tryReserveMetadata,
} from "../lib/storage.js";
import {
  IDEMPOTENCY_IN_FLIGHT_GRACE_MS,
  abortIdempotentCreate,
  beginIdempotentCreate,
  commitIdempotentCreate,
  hashIdempotentRequest,
} from "../lib/idempotency.js";

const workspaces = [];

after(async () => {
  await closeDatabaseConnections();
  for (const dir of workspaces) await rm(dir, { recursive: true, force: true });
});

function git(workspace, ...args) {
  execFileSync("git", ["-C", workspace, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function makeRepo() {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-idem-"));
  workspaces.push(ws);
  git(ws, "init", "-q");
  git(ws, "config", "user.email", "cbx@test.local");
  git(ws, "config", "user.name", "cbx-test");
  return ws;
}

function jobOptionsFor(ws, task) {
  // 与 tools.ts 的 jobOptions 同构（字段顺序固定）：指纹与创建内容一致。
  return {
    workspace: ws,
    task,
    testCommand: undefined,
    review: false,
    isolated: false,
    permissionMode: "default",
    maxTurns: 1,
    timeoutMs: undefined,
    maxRetries: undefined,
    keepWorktree: undefined,
    reviewRules: undefined,
    approvalBeforeRun: false,
    approvalBeforeComplete: false,
    executor: "codebuddy",
  };
}

test("hashIdempotentRequest：同载荷同哈希，改任一字段即变", () => {
  const a = jobOptionsFor("/tmp/x", "任务 A");
  const b = jobOptionsFor("/tmp/x", "任务 A");
  assert.equal(hashIdempotentRequest(a), hashIdempotentRequest(b));
  assert.notEqual(
    hashIdempotentRequest(a),
    hashIdempotentRequest({ ...a, task: "任务 B" }),
  );
});

// --- 存储原语 ---

test("tryReserveMetadata / replaceMetadataIfMatch：原子预留与 CAS 语义", async () => {
  const ws = await makeRepo();
  assert.equal(await tryReserveMetadata(ws, "t:primitive", "v1"), true);
  assert.equal(await tryReserveMetadata(ws, "t:primitive", "v2"), false); // 已存在不覆盖
  assert.equal(await getMetadata(ws, "t:primitive"), "v1");
  assert.equal(await replaceMetadataIfMatch(ws, "t:primitive", "wrong", "v9"), false);
  assert.equal(await replaceMetadataIfMatch(ws, "t:primitive", "v1", "v2"), true);
  assert.equal(await getMetadata(ws, "t:primitive"), "v2");
});

// --- 幂等生命周期（真实 createJob 集成）---

test("幂等键：首次 reserved，提交后同键同载荷返回 duplicate（同一 jobId）", async () => {
  const ws = await makeRepo();
  const options = jobOptionsFor(ws, "写一个 README 章节");
  const hash = hashIdempotentRequest(options);

  const first = await beginIdempotentCreate(ws, "feat-readme", hash);
  assert.deepEqual(first, { kind: "reserved", takeover: false });

  const created = await createJob(options);
  await commitIdempotentCreate(ws, "feat-readme", created.jobId);

  const second = await beginIdempotentCreate(ws, "feat-readme", hash);
  assert.equal(second.kind, "duplicate");
  assert.equal(second.jobId, created.jobId);
  assert.equal(second.status, "queued"); // 状态来自真实 loadState
});

test("幂等键：同键不同载荷 → conflict（宁可报错也不静默跑错任务）", async () => {
  const ws = await makeRepo();
  const hashA = hashIdempotentRequest(jobOptionsFor(ws, "任务 A"));
  await beginIdempotentCreate(ws, "k-conflict", hashA);
  const hashB = hashIdempotentRequest(jobOptionsFor(ws, "任务 B"));
  const outcome = await beginIdempotentCreate(ws, "k-conflict", hashB);
  assert.equal(outcome.kind, "conflict");
  assert.ok(typeof outcome.createdAt === "string");
});

test("幂等键：失败 abort 后不留毒键，同键可真正重跑", async () => {
  const ws = await makeRepo();
  const hash = hashIdempotentRequest(jobOptionsFor(ws, "可能失败的任务"));
  await beginIdempotentCreate(ws, "k-abort", hash);
  await abortIdempotentCreate(ws, "k-abort");
  // 模拟重试：再次 begin 应重新拿到预留（而不是 duplicate/conflict）
  const retry = await beginIdempotentCreate(ws, "k-abort", hash);
  assert.deepEqual(retry, { kind: "reserved", takeover: false });
});

test("幂等键：悬空预留宽限期内视为 in-flight（并发创建中）", async () => {
  const ws = await makeRepo();
  const hash = hashIdempotentRequest(jobOptionsFor(ws, "正在创建的任务"));
  await setMetadata(
    ws,
    "idem:k-inflight",
    JSON.stringify({ jobId: null, requestHash: hash, createdAt: new Date().toISOString() }),
  );
  const outcome = await beginIdempotentCreate(ws, "k-inflight", hash);
  assert.equal(outcome.kind, "in-flight");
  assert.ok(IDEMPOTENCY_IN_FLIGHT_GRACE_MS >= 60_000);
});

test("幂等键：超过宽限期的悬空预留被接管（上次创建者已死）", async () => {
  const ws = await makeRepo();
  const hash = hashIdempotentRequest(jobOptionsFor(ws, "崩溃遗留的预留"));
  const staleTime = new Date(Date.now() - IDEMPOTENCY_IN_FLIGHT_GRACE_MS - 1000).toISOString();
  await setMetadata(
    ws,
    "idem:k-stale",
    JSON.stringify({ jobId: null, requestHash: hash, createdAt: staleTime }),
  );
  const outcome = await beginIdempotentCreate(ws, "k-stale", hash);
  assert.deepEqual(outcome, { kind: "reserved", takeover: true });
  // 接管后预留时间刷新
  const stored = JSON.parse(await getMetadata(ws, "idem:k-stale"));
  assert.ok(Date.parse(stored.createdAt) > Date.parse(staleTime));
});

test("幂等键：损坏的预留值按孤儿处理并接管", async () => {
  const ws = await makeRepo();
  const hash = hashIdempotentRequest(jobOptionsFor(ws, "半截写入的任务"));
  await setMetadata(ws, "idem:k-corrupt", "{\"jobId\": ");
  const outcome = await beginIdempotentCreate(ws, "k-corrupt", hash);
  assert.equal(outcome.kind, "reserved");
  assert.equal(outcome.takeover, true);
});

test("幂等键：预留指向的任务已被清理 → 孤儿接管重建", async () => {
  const ws = await makeRepo();
  const hash = hashIdempotentRequest(jobOptionsFor(ws, "被清理过的任务"));
  await setMetadata(
    ws,
    "idem:k-purged",
    JSON.stringify({ jobId: "does-not-exist", requestHash: hash, createdAt: new Date().toISOString() }),
  );
  const outcome = await beginIdempotentCreate(ws, "k-purged", hash);
  assert.deepEqual(outcome, { kind: "reserved", takeover: true });
});
