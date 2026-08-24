import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  closeDatabaseConnections,
  jobEventsAfterCursor,
  verifyJobAudit,
} from "../lib/storage.js";
import { flushJobEventMirrors, logJobEvent } from "../lib/state.js";
import { buildTimeline, readExecutorStatus } from "../lib/ui.js";
import { writeResult } from "../lib/result.js";
import { loadJson } from "../lib/storage.js";

const workspaces = [];
after(async () => {
  await flushJobEventMirrors();
  await closeDatabaseConnections();
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

function makeJob() {
  const workspace = mkdtempSync(path.join(tmpdir(), "cbx-audit-"));
  const jobId = "audit-job";
  const directory = path.join(workspace, ".cbx", "jobs", jobId);
  mkdirSync(directory, { recursive: true });
  // 最小 context.json：writeResult 需要（loadJobContext 校验必填字段）。
  writeFileSync(
    path.join(directory, "context.json"),
    JSON.stringify({
      appVersion: "0.0.0",
      jobId,
      workspace,
      createdAt: new Date().toISOString(),
      permissionMode: "default",
      executor: "codebuddy",
      reviewRequested: false,
      isolated: false,
      maxTurns: 5,
      timeoutMs: 30000,
      maxRetries: 0,
    }),
    "utf8",
  );
  workspaces.push(workspace);
  return { workspace, jobId, directory };
}

test("logJobEvent 镜像 SQLite：job 级事件可经 jobEventsAfterCursor 查询（审计权威）", async () => {
  const { workspace, jobId, directory } = makeJob();
  logJobEvent(workspace, jobId, "worker_crash", { error: "boom" });
  logJobEvent(workspace, jobId, "stage_started", { stage: "impl" });
  await flushJobEventMirrors();

  const result = await jobEventsAfterCursor(workspace, jobId, 0, 100);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].payload.event, "worker_crash");
  assert.equal(result.rows[0].payload.error, "boom");
  assert.equal(result.rows[1].payload.event, "stage_started");
  // ndjson 同步落盘（兼容读取/轮转）
  const ndjson = readFileSync(path.join(directory, "events.ndjson"), "utf8");
  assert.match(ndjson, /worker_crash/);
  assert.match(ndjson, /stage_started/);
});

test("verifyJobAudit: ndjson 与 SQLite 一致时 valid=true", async () => {
  const { workspace, jobId } = makeJob();
  logJobEvent(workspace, jobId, "process_started", { command: ["codebuddy"] });
  logJobEvent(workspace, jobId, "process_finished", { returncode: 0 });
  await flushJobEventMirrors();

  const result = await verifyJobAudit(workspace, jobId);
  assert.equal(result.tampered, false);
  assert.equal(result.valid, true);
  assert.equal(result.ndjsonCount, 2);
  assert.equal(result.sqliteCount, 2);
});

test("verifyJobAudit: 执行器篡改 ndjson（追加伪造事件）被检测为 tampered", async () => {
  const { workspace, jobId, directory } = makeJob();
  logJobEvent(workspace, jobId, "process_started", { command: ["codebuddy"] });
  await flushJobEventMirrors();

  // 模拟执行器篡改：往 ndjson 追加一条伪造事件（SQLite 镜像无此记录）
  const ndjsonFile = path.join(directory, "events.ndjson");
  writeFileSync(
    ndjsonFile,
    readFileSync(ndjsonFile, "utf8") +
      JSON.stringify({ event: "process_finished", jobId, returncode: 0 }) +
      "\n",
    "utf8",
  );

  const result = await verifyJobAudit(workspace, jobId);
  assert.equal(result.tampered, true);
  assert.equal(result.valid, false);
  assert.match(result.reason ?? "", /不一致|不匹配|多于|伪造/);
});

test("verifyJobAudit: 执行器篡改 ndjson（删除行）被检测为 tampered", async () => {
  const { workspace, jobId, directory } = makeJob();
  logJobEvent(workspace, jobId, "stage_started", { stage: "impl" });
  logJobEvent(workspace, jobId, "stage_finished", { stage: "impl" });
  await flushJobEventMirrors();

  // 模拟执行器删除最后一行的失败记录
  const ndjsonFile = path.join(directory, "events.ndjson");
  const lines = readFileSync(ndjsonFile, "utf8")
    .split("\n")
    .filter(Boolean);
  writeFileSync(ndjsonFile, lines.slice(0, -1).join("\n") + "\n", "utf8");

  const result = await verifyJobAudit(workspace, jobId);
  assert.equal(result.tampered, true);
});

test("verifyJobAudit: SQLite 无该 job 事件（旧任务/镜像缺失）不判定篡改", async () => {
  const { workspace, jobId, directory } = makeJob();
  // 只写 ndjson，不触发 logJobEvent（模拟旧版本创建的任务）
  writeFileSync(
    path.join(directory, "events.ndjson"),
    JSON.stringify({ event: "stage_started", jobId }) + "\n",
    "utf8",
  );
  const result = await verifyJobAudit(workspace, jobId);
  assert.equal(result.tampered, false);
  assert.equal(result.valid, false); // 无锚点
  assert.match(result.reason ?? "", /无法验证/);
});

test("buildTimeline 优先 SQLite：镜像存在时用 SQLite（执行器篡改 ndjson 不影响 timeline）", async () => {
  const { workspace, jobId, directory } = makeJob();
  logJobEvent(workspace, jobId, "job.state_changed", { status: "queued", phase: "queued" });
  logJobEvent(workspace, jobId, "job.state_changed", { status: "done", phase: "done" });
  await flushJobEventMirrors();

  // 执行器篡改 ndjson：把 done 改成 running（timeline 应从 SQLite 读到 done）
  const ndjsonFile = path.join(directory, "events.ndjson");
  const tampered = readFileSync(ndjsonFile, "utf8").replace(
    /"status":"done"/g,
    '"status":"running"',
  );
  writeFileSync(ndjsonFile, tampered, "utf8");

  const timeline = await buildTimeline(workspace, jobId);
  // SQLite 权威：最后状态是 done
  assert.equal(timeline.currentStage, "done");
});

test("readExecutorStatus 优先 SQLite：process_started 命令来自镜像（篡改 ndjson 不影响）", async () => {
  const { workspace, jobId, directory } = makeJob();
  logJobEvent(workspace, jobId, "process_started", { command: ["codebuddy", "-p"] });
  await flushJobEventMirrors();
  // 写一个 pid 文件让 readExecutorStatus 走完整路径
  writeFileSync(path.join(directory, "pid"), JSON.stringify({ pid: 1, startedAt: Date.now() }), "utf8");

  // 篡改 ndjson 的 command
  const ndjsonFile = path.join(directory, "events.ndjson");
  writeFileSync(
    ndjsonFile,
    JSON.stringify({ event: "process_started", command: ["evil", "-x"] }) + "\n",
    "utf8",
  );

  const status = await readExecutorStatus(workspace, jobId);
  // SQLite 权威：命令来自镜像（codebuddy -p），而非被篡改的 ndjson
  assert.equal(status.command, "codebuddy -p");
});

test("writeResult: result.json 携带 auditIntegrity 验证结果（终态审计状态可见）", async () => {
  const { workspace, jobId, directory } = makeJob();
  logJobEvent(workspace, jobId, "process_started", { command: ["codebuddy"] });
  logJobEvent(workspace, jobId, "process_finished", { returncode: 0 });
  await flushJobEventMirrors();
  // 写最小产物：complete.patch + test.log（result.json 组装需要）
  writeFileSync(path.join(directory, "complete.patch"), "diff --git a/x b/x\n", "utf8");
  writeFileSync(path.join(directory, "test.log"), "ok\n", "utf8");
  writeFileSync(path.join(directory, "handback.md"), "done\n", "utf8");

  await writeResult(workspace, jobId, { status: "done", phase: "done", attempt: 1, jobId } );

  const result = await loadJson(path.join(directory, "result.json"));
  assert.ok(result.auditIntegrity, "result.json 应包含 auditIntegrity");
  assert.equal(result.auditIntegrity.valid, true, "ndjson 与 SQLite 一致时应 valid");
  assert.equal(result.auditIntegrity.tampered, false);
  assert.equal(result.auditIntegrity.ndjsonCount, 2);
  assert.equal(result.auditIntegrity.sqliteCount, 2);
});

test("writeResult: 执行器篡改 ndjson 后 result.json 的 auditIntegrity 标记 tampered", async () => {
  const { workspace, jobId, directory } = makeJob();
  logJobEvent(workspace, jobId, "process_started", { command: ["codebuddy"] });
  await flushJobEventMirrors();
  // 执行器篡改：追加伪造事件
  const ndjsonFile = path.join(directory, "events.ndjson");
  writeFileSync(
    ndjsonFile,
    readFileSync(ndjsonFile, "utf8") +
      JSON.stringify({ event: "process_finished", jobId, returncode: 0 }) +
      "\n",
    "utf8",
  );
  writeFileSync(path.join(directory, "complete.patch"), "diff\n", "utf8");
  writeFileSync(path.join(directory, "test.log"), "ok\n", "utf8");
  writeFileSync(path.join(directory, "handback.md"), "done\n", "utf8");

  await writeResult(workspace, jobId, { status: "done", phase: "done", attempt: 1, jobId });

  const result = await loadJson(path.join(directory, "result.json"));
  assert.equal(result.auditIntegrity.tampered, true, "篡改 ndjson 应被 auditIntegrity 标记");
  assert.equal(result.auditIntegrity.valid, false);
});
