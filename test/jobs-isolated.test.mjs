import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createJob } from "../lib/jobs.js";
import { closeDatabaseConnections } from "../lib/storage.js";

function git(workspace, ...args) {
  return execFileSync("git", ["-C", workspace, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 建一个带未提交改动的 Git 仓库（已跟踪脏文件 + 未跟踪新文件）。 */
async function makeDirtyRepo() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-dirty-"));
  git(workspace, "init", "-q");
  git(workspace, "config", "user.email", "cbx@test.local");
  git(workspace, "config", "user.name", "cbx-test");
  try {
    git(workspace, "symbolic-ref", "HEAD", "refs/heads/main");
  } catch {
    /* 新版 git init 已默认分支，忽略 */
  }
  await writeFile(path.join(workspace, "a.txt"), "hello\n", "utf8");
  git(workspace, "add", "a.txt");
  git(workspace, "commit", "-q", "-m", "init");
  await writeFile(path.join(workspace, "a.txt"), "hello world\n", "utf8"); // 已跟踪脏
  await writeFile(path.join(workspace, "new.txt"), "untracked\n", "utf8"); // 未跟踪
  return workspace;
}

/** 建一个干净的 Git 仓库（无未提交改动）。 */
async function makeCleanRepo() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-clean-"));
  git(workspace, "init", "-q");
  git(workspace, "config", "user.email", "cbx@test.local");
  git(workspace, "config", "user.name", "cbx-test");
  await writeFile(path.join(workspace, "a.txt"), "hello\n", "utf8");
  git(workspace, "add", "a.txt");
  git(workspace, "commit", "-q", "-m", "init");
  return workspace;
}


test("isolated=true 且工作区不是 Git 仓库时创建即报错并给出修复建议", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-nogit-"));
  try {
    await assert.rejects(
      () =>
        createJob({
          workspace,
          task: "t",
          review: false,
          isolated: true,
          permissionMode: "default",
          maxTurns: 10,
          maxRetries: 0,
        }),
      (error) => {
        const message = String(error.message);
        assert.match(message, /isolated=true 要求工作区位于 Git 仓库中/);
        assert.match(message, /git init/);
        assert.match(message, /isolated 设为 false/);
        return true;
      },
    );
  } finally {
    await closeDatabaseConnections();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("isolated=true + 脏仓库 + 未 carryDirty → 创建即报错并列出可操作补救", async () => {
  const workspace = await makeDirtyRepo();
  const jobId = "dirty-retry";
  const directory = path.join(workspace, ".cbx", "jobs", jobId);
  const options = {
    workspace,
    task: "t",
    review: false,
    isolated: true,
    permissionMode: "default",
    maxTurns: 10,
    maxRetries: 0,
    jobId,
  };
  try {
    const assertDirtyRejection = () =>
      assert.rejects(() => createJob(options), (error) => {
        const message = String(error.message);
        assert.match(message, /隔离任务无法携带创建时的未提交内容/);
        assert.match(message, /carryDirty: true/);
        assert.match(message, /isolated: false/);
        assert.match(message, /git commit \/ stash/);
        assert.doesNotMatch(message, /任务已存在/);
        return true;
      });
    await assertDirtyRejection();
    assert.equal(existsSync(directory), false);
    await assertDirtyRejection();
    assert.equal(existsSync(directory), false);
  } finally {
    await closeDatabaseConnections();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("isolated=true + 脏仓库 + carryDirty=true → 创建成功且持久化标志（不再 dirty_baseline 崩溃）", async () => {
  const workspace = await makeDirtyRepo();
  try {
    const { jobId, directory } = await createJob({
      workspace,
      task: "t",
      review: false,
      isolated: true,
      carryDirty: true,
      permissionMode: "default",
      maxTurns: 10,
      maxRetries: 0,
    });
    assert.ok(jobId);
    const context = JSON.parse(await readFile(path.join(directory, "context.json"), "utf8"));
    assert.equal(context.isolated, true);
    assert.equal(context.carryDirty, true);
    assert.equal(context.baseDirty, true); // 创建基线确实脏，但被 carryDirty 许可
  } finally {
    await closeDatabaseConnections();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("isolated=true + 干净仓库 → 直接创建成功（隔离不受影响）", async () => {
  const workspace = await makeCleanRepo();
  try {
    const { jobId } = await createJob({
      workspace,
      task: "t",
      review: false,
      isolated: true,
      permissionMode: "default",
      maxTurns: 10,
      maxRetries: 0,
    });
    assert.ok(jobId);
  } finally {
    await closeDatabaseConnections();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("isolated=false 在非 Git 工作区可正常创建（不误伤非隔离任务）", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-nogit-"));
  try {
    const { jobId, directory } = await createJob({
      workspace,
      task: "t",
      review: false,
      isolated: false,
      permissionMode: "default",
      maxTurns: 10,
      maxRetries: 0,
    });
    assert.ok(jobId);
    assert.equal(path.dirname(directory), path.join(workspace, ".cbx", "jobs"));
  } finally {
    await closeDatabaseConnections();
    await rm(workspace, { recursive: true, force: true });
  }
});
