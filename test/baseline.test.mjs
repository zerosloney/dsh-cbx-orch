import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { tryMigrateDirtyFingerprintV2 } from "../lib/baseline.js";
import { closeDatabaseConnections } from "../lib/storage.js";
import { flushJobEventMirrors } from "../lib/state.js";

const repos = [];

after(async () => {
  // logJobEvent 现在会 fire-and-forget 镜像 SQLite（审计权威），测试结束时可能
  // 仍有异步写入在途——先排空镜像、关连接释放句柄，再删目录（Windows 文件锁）。
  await flushJobEventMirrors();
  await closeDatabaseConnections();
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
});

function gitRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "cbx-baseline-"));
  repos.push(repo);
  execSync(
    "git init -q && git config user.email t@t && git config user.name t && echo base > f.txt && git add . && git commit -qm init",
    { cwd: repo },
  );
  return repo;
}

function writeOldContext(repo, jobId, overrides = {}) {
  const jobDir = path.join(repo, ".cbx", "jobs", jobId);
  mkdirSync(jobDir, { recursive: true });
  const context = {
    appVersion: "0.1.0",
    jobId,
    workspace: repo,
    createdAt: "2026-01-01T00:00:00Z",
    permissionMode: "default",
    executor: "codebuddy",
    reviewRequested: true,
    isolated: false,
    maxTurns: 10,
    timeoutMs: 60000,
    maxRetries: 1,
    executionRetries: 1,
    fixRetries: 1,
    testCommand: "echo t",
    ...overrides,
  };
  writeFileSync(path.join(jobDir, "context.json"), JSON.stringify(context, null, 2));
  return context;
}

test("v1→v2 懒迁移：干净工作区升级并落盘", async () => {
  const repo = gitRepo();
  const context = writeOldContext(repo, "mig1");
  await tryMigrateDirtyFingerprintV2(repo, "mig1", path.join(repo, ".cbx", "jobs", "mig1"), context);
  assert.equal(context.dirtyFingerprintVersion, 2);
  assert.ok(context.dirtyFingerprint);
  const persisted = JSON.parse(
    readFileSync(path.join(repo, ".cbx", "jobs", "mig1", "context.json"), "utf8"),
  );
  assert.equal(persisted.dirtyFingerprintVersion, 2);
  assert.ok(persisted.dirtyFingerprint);
});

test("迁移守卫：存在已跟踪改动时不升级（保留 v1 语义）", async () => {
  const repo = gitRepo();
  const context = writeOldContext(repo, "mig2");
  execSync("echo dirty >> f.txt", { cwd: repo }); // 已跟踪文件被修改
  await tryMigrateDirtyFingerprintV2(repo, "mig2", path.join(repo, ".cbx", "jobs", "mig2"), context);
  assert.equal(context.dirtyFingerprintVersion, undefined);
  const persisted = JSON.parse(
    readFileSync(path.join(repo, ".cbx", "jobs", "mig2", "context.json"), "utf8"),
  );
  assert.equal(persisted.dirtyFingerprintVersion, undefined);
});

test("迁移跳过：已有 v2 / 隔离任务", async () => {
  const repo = gitRepo();
  const alreadyV2 = writeOldContext(repo, "mig3", { dirtyFingerprintVersion: 2 });
  await tryMigrateDirtyFingerprintV2(repo, "mig3", path.join(repo, ".cbx", "jobs", "mig3"), alreadyV2);
  assert.equal(alreadyV2.dirtyFingerprintVersion, 2);

  const isolated = writeOldContext(repo, "mig4", { isolated: true });
  await tryMigrateDirtyFingerprintV2(repo, "mig4", path.join(repo, ".cbx", "jobs", "mig4"), isolated);
  assert.equal(isolated.dirtyFingerprintVersion, undefined);
});
