import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDatabaseConnections, jobEventsAfterCursor, insertEvent, nextEventSeq } from "../lib/storage.js";
import { flushJobEventMirrors, logJobEvent } from "../lib/state.js";
import { readEventsIncremental } from "../lib/artifacts.js";

const workspaces = [];
after(async () => {
  await flushJobEventMirrors();
  await closeDatabaseConnections();
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

function makeJob() {
  const workspace = mkdtempSync(path.join(tmpdir(), "cbx-events-cursor-"));
  const jobId = "cursor-job";
  const directory = path.join(workspace, ".cbx", "jobs", jobId);
  mkdirSync(directory, { recursive: true });
  workspaces.push(workspace);
  return { workspace, jobId, directory };
}

test("readEventsIncremental: SQLite 源增量续读——since=0 全量，next_offset 续读新事件", async () => {
  const { workspace, jobId, directory } = makeJob();
  logJobEvent(workspace, jobId, "stage_started", { stage: "a" });
  logJobEvent(workspace, jobId, "stage_finished", { stage: "a" });
  await flushJobEventMirrors();

  // 首次读：全量
  const first = await readEventsIncremental(workspace, jobId, 0);
  assert.equal(first.events.length, 2);
  assert.ok(first.events[0].includes("stage_started"));
  const cursor = first.next_offset;
  assert.equal(typeof cursor, "number");

  // 续读：无新事件 → 空
  const empty = await readEventsIncremental(workspace, jobId, cursor);
  assert.equal(empty.events.length, 0);

  // 追加一条后用 cursor 续读 → 只返回新事件
  logJobEvent(workspace, jobId, "process_finished", { returncode: 0 });
  await flushJobEventMirrors();
  const next = await readEventsIncremental(workspace, jobId, cursor);
  assert.equal(next.events.length, 1);
  assert.ok(next.events[0].includes("process_finished"));
});

test("readEventsIncremental: 稀疏 seq 不丢事件（job 事件混在 workspace 全局 seq 中）", async () => {
  const { workspace, jobId } = makeJob();
  // 模拟 workspace 全局 seq 稀疏：先写一个"其它 job"的事件占一个 seq，再写本 job 事件
  // 直接经 insertEvent 控制 seq（跳过 logJobEvent 的自动 seq），构造本 job 的 seq 不连续。
  const otherJob = "other-job";
  const seqA = await nextEventSeq(workspace);
  await insertEvent(workspace, seqA, "other.event", { event: "other.event", jobId: otherJob, at: new Date().toISOString() }, otherJob);
  const seqB = await nextEventSeq(workspace);
  await insertEvent(workspace, seqB, "job.state_changed", { event: "job.state_changed", jobId, status: "queued", at: new Date().toISOString() }, jobId);
  const seqC = await nextEventSeq(workspace);
  await insertEvent(workspace, seqC, "job.state_changed", { event: "job.state_changed", jobId, status: "running", at: new Date().toISOString() }, jobId);

  // 首次读：返回 2 条本 job 事件（过滤掉 other）
  const first = await readEventsIncremental(workspace, jobId, 0);
  assert.equal(first.events.length, 2);
  assert.ok(first.events[0].includes("queued"));
  const cursor = first.next_offset;
  // 关键断言：next_offset == 已读最后一条的 seq（不是 +1），续读不丢任何本 job 事件
  assert.equal(cursor, seqC);

  // 续读：无新本 job 事件 → 空（若 next_offset 曾为 seqC+1，而 seqC+1 恰好是另一个
  // 本 job 事件时会漏——这里构造 seqC+1 属于本 job 验证）
  const nextSeq = await nextEventSeq(workspace); // seqC+1（若中间无其它事件）
  assert.equal(nextSeq, seqC + 1);
  await insertEvent(workspace, nextSeq, "job.state_changed", { event: "job.state_changed", jobId, status: "done", at: new Date().toISOString() }, jobId);
  // 用 cursor（=seqC）续读 → 必须读到 seqC+1 的 done 事件
  const next = await readEventsIncremental(workspace, jobId, cursor);
  assert.equal(next.events.length, 1);
  assert.ok(next.events[0].includes("done"));
});

test("readEventsIncremental: 回退 ndjson（无 SQLite 镜像的旧任务）", async () => {
  const { workspace, jobId, directory } = makeJob();
  // 只写 ndjson，不写 SQLite（模拟 v6 之前创建的任务）
  writeFileSync(
    path.join(directory, "events.ndjson"),
    JSON.stringify({ event: "stage_started", jobId, stage: "x" }) + "\n" +
      JSON.stringify({ event: "stage_finished", jobId, stage: "x" }) + "\n",
    "utf8",
  );
  const first = await readEventsIncremental(workspace, jobId, 0);
  assert.equal(first.events.length, 2);
  assert.ok(first.events[0].includes("stage_started"));
  // ndjson 游标：next_offset 是行偏移（> 0）
  assert.ok(first.next_offset > 0);
  // 续读：已到末尾 → 空
  const empty = await readEventsIncremental(workspace, jobId, first.next_offset);
  assert.equal(empty.events.length, 0);
});

test("readEventsIncremental: 回退 ndjson 支持增量续读（旧任务追加事件可读到）", async () => {
  const { workspace, jobId, directory } = makeJob();
  writeFileSync(
    path.join(directory, "events.ndjson"),
    JSON.stringify({ event: "stage_started", jobId, stage: "x" }) + "\n",
    "utf8",
  );
  const first = await readEventsIncremental(workspace, jobId, 0);
  assert.equal(first.events.length, 1);
  const cursor = first.next_offset;
  // 追加一条 ndjson 行（旧任务执行器直接 append）
  writeFileSync(
    path.join(directory, "events.ndjson"),
    JSON.stringify({ event: "stage_started", jobId, stage: "x" }) + "\n" +
      JSON.stringify({ event: "stage_finished", jobId, stage: "x" }) + "\n",
    "utf8",
  );
  // 用行游标续读 → 只返回新追加的行
  const next = await readEventsIncremental(workspace, jobId, cursor);
  assert.equal(next.events.length, 1);
  assert.ok(next.events[0].includes("stage_finished"));
});

test("jobEventsAfterCursor: 截断语义（limit 内返回 truncated + 精确 next）", async () => {
  const { workspace, jobId } = makeJob();
  // 插入 3 条本 job 事件（seq 连续）
  for (let i = 0; i < 3; i++) {
    const seq = await nextEventSeq(workspace);
    await insertEvent(workspace, seq, "job.state_changed", { event: "job.state_changed", jobId, status: `s${i}`, at: new Date().toISOString() }, jobId);
  }
  // limit=2 → truncated，返回前 2 条
  const page = await jobEventsAfterCursor(workspace, jobId, 0, 2);
  assert.equal(page.truncated, true);
  assert.equal(page.rows.length, 2);
  const cursor = page.rows.at(-1).seq;
  // 用 cursor 续读 → 第 3 条
  const next = await jobEventsAfterCursor(workspace, jobId, cursor, 2);
  assert.equal(next.truncated, false);
  assert.equal(next.rows.length, 1);
  assert.equal(next.rows[0].payload.status, "s2");
});

test("readEventsIncremental: 空事件返回空", async () => {
  const { workspace, jobId } = makeJob();
  const result = await readEventsIncremental(workspace, jobId, 0);
  assert.deepEqual(result.events, []);
  assert.equal(result.next_offset, 0);
});
