import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  acquireScheduler,
  ensureScheduler,
} from "../lib/queue-api.js";
import { closeDatabaseConnections } from "../lib/storage.js";

async function awaitWithin(promise, timeoutMs, message) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("scheduler ownership: shared generation survives partial release and restarts after final release", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-scheduler-owner-"));
  const handles = [];
  try {
    const first = await acquireScheduler(workspace);
    handles.push(first);
    const second = await acquireScheduler(path.join(workspace, "."));
    handles.push(second);

    // CI runner 上 realpath 会展开 8.3 短名（如 RUNNER~1），与 mkdtemp 返回的长名不同：
    // 以 realpath 规范化后的形式断言，平台无关。
    assert.equal(first.workspace, await realpath(workspace));
    assert.strictEqual(first.ready, second.ready, "canonical aliases must share one scheduler generation");
    const service = await first.ready;
    assert.ok(service, "the scheduler should start for a temporary workspace");
    assert.strictEqual(await ensureScheduler(workspace), service, "ensureScheduler must reuse the owned generation");

    await first.release();
    const third = await acquireScheduler(workspace);
    handles.push(third);
    assert.strictEqual(third.ready, second.ready, "one remaining owner must keep the scheduler running");

    await second.release();
    await third.release();
    await third.release();

    const fourth = await acquireScheduler(workspace);
    handles.push(fourth);
    assert.notStrictEqual(fourth.ready, third.ready, "the final release must stop the old generation");
    assert.ok(await fourth.ready);
    await fourth.release();
    await fourth.release();
  } finally {
    for (const handle of handles.reverse()) await handle.release();
    await closeDatabaseConnections();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("scheduler identity guard stops before dispatching through a replaced workspace path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cbx-scheduler-identity-"));
  const workspace = path.join(root, "allowed");
  const movedWorkspace = path.join(root, "allowed-moved");
  const replacement = path.join(root, "replacement");
  await Promise.all([mkdir(workspace), mkdir(replacement)]);

  let handle;
  let service;
  let moved = false;
  let linked = false;
  try {
    // acquireScheduler currently owns the production 30s interval. Capture its
    // callback so the identity check can be driven directly after replacement,
    // without making this regression wait 30s or relying on timer scheduling.
    const originalSetInterval = globalThis.setInterval;
    const schedulerTicks = [];
    globalThis.setInterval = ((callback, delay, ...args) => {
      const timer = originalSetInterval(callback, delay, ...args);
      if (delay === 30_000) schedulerTicks.push(() => callback(...args));
      return timer;
    });
    try {
      handle = await acquireScheduler(workspace);
      service = await handle.ready;
      assert.ok(service, "the scheduler should start for an authorized workspace");
      assert.ok(schedulerTicks.length > 0, "the scheduler heartbeat should be observable");
    } finally {
      globalThis.setInterval = originalSetInterval;
    }

    await rename(workspace, movedWorkspace);
    moved = true;
    try {
      await symlink(
        replacement,
        workspace,
        process.platform === "win32" ? "junction" : "dir",
      );
      linked = true;
    } catch (error) {
      const code = error?.code;
      if (process.platform === "win32" && ["EACCES", "EINVAL", "EPERM"].includes(code)) {
        t.skip(`无法创建 Windows junction（${code}）`);
        return;
      }
      throw error;
    }

    assert.equal(existsSync(path.join(replacement, ".cbx")), false);
    schedulerTicks[0]();
    await awaitWithin(
      service.done,
      5_000,
      "replaced workspace identity must stop the scheduler promptly",
    );
    assert.equal(
      existsSync(path.join(replacement, ".cbx")),
      false,
      "identity failure must not dispatch into the replacement target",
    );

    await handle.release();
    await handle.release();
  } catch (error) {
    if (
      process.platform === "win32" &&
      !moved &&
      ["EACCES", "EBUSY", "EPERM"].includes(error?.code)
    ) {
      t.skip(`无法在 Windows 重命名打开的 workspace（${error.code}）`);
      return;
    }
    throw error;
  } finally {
    if (handle) {
      await handle.release();
      await handle.release();
    }
    await closeDatabaseConnections();
    if (linked) await unlink(workspace).catch(() => undefined);
    if (moved) await rm(movedWorkspace, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
