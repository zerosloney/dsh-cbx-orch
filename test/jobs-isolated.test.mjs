import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJob } from "../lib/jobs.js";
import { closeDatabaseConnections } from "../lib/storage.js";

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