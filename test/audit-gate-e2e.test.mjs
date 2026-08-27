// audit.failOnTamper 端到端：done 收口前核对审计完整性，篡改即 fail-closed 拦截。
//   A. 未配置 failOnTamper：篡改只落在展示面（result.json auditIntegrity），任务照常 done——
//      向后兼容（缺省仅展示）。
//   B. 配置 failOnTamper=true：篡改导致 done 被改写为 needs_fix/audit_tamper + Human Gate；
//      复原 events.ndjson 后续跑（retry）正常 done。
// 执行器用 smoke/mock-executor/codebuddy.mjs（CBX_CODEBUDDY 注入，不依赖 PATH）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createJob } from "../lib/jobs.js";
import { enqueueJob, retryQueueJob, stopScheduler } from "../lib/queue-api.js";
import { loadState } from "../lib/state.js";
import { loadJson } from "../lib/storage.js";
import { closeDatabaseConnections } from "../lib/storage.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mockExecutor = path.join(
  repoRoot,
  "smoke",
  "mock-executor",
  "codebuddy.mjs",
);
process.env.CBX_CODEBUDDY = mockExecutor;

async function git(workspace, args) {
  await execFileAsync("git", args, { cwd: workspace, windowsHide: true });
}

async function cleanGitWorkspace(prefix, cbxJson) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), prefix));
  await writeFile(path.join(workspace, "tracked.txt"), "clean\n", "utf8");
  await git(workspace, ["init", "-q"]);
  await git(workspace, ["config", "user.email", "cbx-tests@example.invalid"]);
  await git(workspace, ["config", "user.name", "cbx tests"]);
  await git(workspace, ["add", "tracked.txt"]);
  await git(workspace, ["commit", "-q", "-m", "initial"]);
  if (cbxJson !== undefined) {
    await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify(cbxJson), "utf8");
  }
  return workspace;
}

async function waitStatus(workspace, jobId, statuses, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await loadState(workspace, jobId);
    if (statuses.includes(state.status)) return state;
    if (Date.now() >= deadline) {
      throw new Error(
        `等待 ${jobId} 到 ${statuses} 超时（当前 ${state.status}/${state.phase}）。`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function makeJob(workspace, task, jobId) {
  await createJob({
    workspace,
    task,
    review: false,
    isolated: false,
    permissionMode: "default",
    maxTurns: 5,
    timeoutMs: 120_000,
    maxRetries: 0,
    executor: "codebuddy",
    testCommand: "echo smoke-done",
    jobId,
  });
}

/** 在执行器运行前向 job 级 events.ndjson 注入伪造行：真实事件只会追加在其后，
 *  ndjson 行数恒比 SQLite 镜像多 → verifyJobAudit 必然判定篡改（确定性）。 */
async function injectFakeEvent(workspace, jobId) {
  const file = path.join(workspace, ".cbx", "jobs", jobId, "events.ndjson");
  const fake = JSON.stringify({ event: "fake_tamper", jobId, at: "now" }) + "\n";
  // 文件可能尚不存在（首次写入由编排器 append）——先建好再注入。
  await writeFile(file, fake, "utf8");
  return file;
}

/** 移除注入的伪造行（复原 ndjson），供诚实修复路径使用。 */
async function restoreNdjson(file) {
  const raw = await readFile(file, "utf8");
  const kept = raw
    .split("\n")
    .filter((line) => line.trim() && !line.includes("fake_tamper"));
  await writeFile(file, kept.join("\n") + "\n", "utf8");
}

test("audit.failOnTamper 未配置：篡改落在展示面（auditIntegrity），任务照常 done（向后兼容）", async () => {
  const ws = await cleanGitWorkspace("cbx-audit-open-");
  try {
    const jobId = "job-open";
    await makeJob(ws, "e2e smoke", jobId);
    const ndjson = await injectFakeEvent(ws, jobId);
    await enqueueJob(ws, jobId);
    const state = await waitStatus(ws, jobId, ["done"]);
    assert.equal(state.status, "done", "未配置 failOnTamper 时篡改不拦截完成");
    const result = await loadJson(path.join(ws, ".cbx", "jobs", jobId, "result.json"));
    assert.equal(result.auditIntegrity.tampered, true, "展示面应标记篡改");
    assert.equal(result.auditIntegrity.valid, false);
  } finally {
    await stopScheduler(ws).catch(() => undefined);
    await closeDatabaseConnections().catch(() => undefined);
    await rm(ws, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("audit.failOnTamper=true：篡改拦截 done → needs_fix/audit_tamper，复原后续跑完成", async () => {
  const ws = await cleanGitWorkspace("cbx-audit-close-", {
    audit: { failOnTamper: true },
  });
  try {
    const jobId = "job-close";
    await makeJob(ws, "e2e smoke", jobId);
    const ndjson = await injectFakeEvent(ws, jobId);
    await enqueueJob(ws, jobId);
    const state = await waitStatus(ws, jobId, ["needs_fix"]);
    assert.equal(state.phase, "audit_tamper", "应被审计强制闸改写为 audit_tamper");
    assert.ok(state.humanGate, "应挂 Human Gate 等待人工处置");
    assert.match(String(state.error ?? ""), /篡改/);

    // 诚实修复：复原 ndjson（移除伪造行）→ retry（cbx_continue 执行语义）→ done。
    await restoreNdjson(ndjson);
    await retryQueueJob(ws, jobId);
    await waitStatus(ws, jobId, ["done"]);
    const result = await loadJson(path.join(ws, ".cbx", "jobs", jobId, "result.json"));
    assert.equal(result.auditIntegrity.tampered, false, "复原后审计应通过");
    assert.equal(result.auditIntegrity.valid, true);
  } finally {
    await stopScheduler(ws).catch(() => undefined);
    await closeDatabaseConnections().catch(() => undefined);
    await rm(ws, { recursive: true, force: true }).catch(() => undefined);
  }
});