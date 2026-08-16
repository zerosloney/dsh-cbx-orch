import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { registerCbxTools } from "../lib/tools.js";
import { runProcess } from "../lib/process-runner.js";
import { WorkspacePolicy } from "../lib/workspace-policy.js";

const execFileAsync = promisify(execFile);

function registeredTools(policy) {
  const definitions = new Map();
  registerCbxTools(
    {
      tools: {
        register(definition) {
          definitions.set(definition.name, definition);
          return () => definitions.delete(definition.name);
        },
      },
    },
    { workspacePolicy: policy },
  );
  return definitions;
}

async function git(workspace, args) {
  await execFileAsync("git", args, { cwd: workspace, windowsHide: true });
}

async function cleanGitWorkspace() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cancel-git-"));
  await writeFile(path.join(workspace, "tracked.txt"), "clean\n", "utf8");
  await git(workspace, ["init", "-q"]);
  await git(workspace, ["config", "user.email", "cbx-tests@example.invalid"]);
  await git(workspace, ["config", "user.name", "cbx tests"]);
  await git(workspace, ["add", "tracked.txt"]);
  await git(workspace, ["commit", "-q", "-m", "initial"]);
  return workspace;
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待取消测试条件超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("cbx_review_gate forwards the exact tool signal into the review gate", async () => {
  const workspace = await cleanGitWorkspace();
  try {
    const calls = [];
    const signal = {
      throwIfAborted() {
        calls.push(this);
      },
    };
    const tool = registeredTools(new WorkspacePolicy([workspace])).get("cbx_review_gate");
    const result = await tool.execute({ workspace }, { signal });

    assert.equal(result.verdict, "SKIP");
    assert.ok(calls.length >= 3, `expected tool and review-gate checks, got ${calls.length}`);
    assert.ok(calls.every((value) => value === signal));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("pre-cancelled cbx_review_gate rejects before workspace policy or review side effects", async () => {
  const allowed = await mkdtemp(path.join(os.tmpdir(), "cbx-cancel-allowed-"));
  const denied = await mkdtemp(path.join(os.tmpdir(), "cbx-cancel-denied-"));
  try {
    const reason = new Error("caller cancelled review");
    const controller = new AbortController();
    controller.abort(reason);
    const tool = registeredTools(new WorkspacePolicy([allowed])).get("cbx_review_gate");

    await assert.rejects(
      () => tool.execute({ workspace: denied }, { signal: controller.signal }),
      (error) => error === reason,
    );
    assert.equal(existsSync(path.join(denied, ".cbx")), false);
  } finally {
    await Promise.all([
      rm(allowed, { recursive: true, force: true }),
      rm(denied, { recursive: true, force: true }),
    ]);
  }
});

test("raw process cancellation preserves reason and settles after child/pid cleanup", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cancel-process-"));
  const pidFile = path.join(workspace, "active.pid");
  const controller = new AbortController();
  const reason = new Error("caller cancelled process");
  let running;
  let pid;
  try {
    running = runProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 60_000);"],
      workspace,
      30_000,
      undefined,
      pidFile,
      controller.signal,
    );
    await waitFor(() => existsSync(pidFile));
    pid = JSON.parse(readFileSync(pidFile, "utf8")).pid;
    assert.ok(Number.isSafeInteger(pid) && pid > 0);

    controller.abort(reason);
    await assert.rejects(running, (error) => error === reason);
    assert.equal(existsSync(pidFile), false);
    await waitFor(() => !processIsAlive(pid));
    assert.equal(processIsAlive(pid), false);
  } finally {
    if (running) {
      controller.abort(reason);
      await running.catch(() => undefined);
    }
    await rm(workspace, { recursive: true, force: true });
  }
});
