import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspacePolicy } from "../lib/workspace-policy.js";
import { isCbxError } from "../lib/errors.js";

test("空允许列表默认只允许 canonical process.cwd()", async () => {
  const policy = new WorkspacePolicy([]);
  const expected = await realpath(process.cwd());

  assert.equal(await policy.resolveWorkspace(), expected);
  assert.deepEqual(await policy.listAllowedWorkspaces(), [expected]);
});

test("空允许列表时默认工作区跟随调用方目录（目录委派语义）", async () => {
  const delegated = await mkdtemp(path.join(os.tmpdir(), "cbx-policy-"));
  try {
    const policy = new WorkspacePolicy([]);
    // 无显式 workspace 参数时，以调用方上下文目录（如 agent 会话 cwd）为默认工作区。
    assert.equal(await policy.resolveWorkspace(undefined, delegated), await realpath(delegated));
    // 显式传参与上下文目录一致时放行（空配置只放行当前上下文目录）。
    assert.equal(await policy.resolveWorkspace(delegated, delegated), await realpath(delegated));
    // 显式传参但无上下文目录（回落 process.cwd()）且目录不同 → 拒绝：显式参数仍需命中允许列表。
    await assert.rejects(
      () => policy.resolveWorkspace(delegated),
      (error) => isCbxError(error, "E_INVALID_WORKSPACE"),
    );
    // 策略随调用方目录动态解析：下一次调用换一个委派目录同样放行（空配置不缓存首个调用方）。
    const second = await mkdtemp(path.join(os.tmpdir(), "cbx-policy-second-"));
    try {
      assert.equal(await policy.resolveWorkspace(undefined, second), await realpath(second));
    } finally {
      await rm(second, { recursive: true, force: true });
    }
  } finally {
    await rm(delegated, { recursive: true, force: true });
  }
});

test("显式允许列表 canonicalize、去重并保留首次顺序", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cbx-policy-"));
  try {
    const nested = path.join(root, "nested");
    await mkdir(nested);
    const relative = path.relative(process.cwd(), root) || ".";
    const policy = new WorkspacePolicy([
      relative,
      path.join(root, "."),
      nested,
    ]);
    const canonicalRoot = await realpath(root);
    const canonicalNested = await realpath(nested);

    assert.deepEqual(await policy.listAllowedWorkspaces(), [
      canonicalRoot,
      canonicalNested,
    ]);
    assert.equal(
      await policy.resolveWorkspace(path.join(root, ".", "nested", "..")),
      canonicalRoot,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("越权 workspace 拒绝且使用稳定 CbxError code", async () => {
  const allowed = await mkdtemp(path.join(os.tmpdir(), "cbx-policy-"));
  const denied = await mkdtemp(path.join(os.tmpdir(), "cbx-policy-"));
  try {
    const policy = new WorkspacePolicy([allowed]);
    await assert.rejects(
      () => policy.resolveWorkspace(denied),
      (error) => isCbxError(error, "E_INVALID_WORKSPACE"),
    );
  } finally {
    await Promise.all([
      rm(allowed, { recursive: true, force: true }),
      rm(denied, { recursive: true, force: true }),
    ]);
  }
});

test("越权报错带可操作提示：列出允许的工作区与配置位置", async () => {
  const allowed = await mkdtemp(path.join(os.tmpdir(), "cbx-policy-"));
  const denied = await mkdtemp(path.join(os.tmpdir(), "cbx-policy-"));
  try {
    const policy = new WorkspacePolicy([allowed]);
    await assert.rejects(
      () => policy.resolveWorkspace(denied),
      (error) => {
        assert.equal(isCbxError(error, "E_INVALID_WORKSPACE"), true);
        const message = String(error.message);
        assert.match(message, /当前允许的工作区/);
        assert.equal(message.includes(allowed), true);
        assert.match(message, /cordis\.patch\.yml/);
        return true;
      },
    );
  } finally {
    await Promise.all([
      rm(allowed, { recursive: true, force: true }),
      rm(denied, { recursive: true, force: true }),
    ]);
  }
});

test("不存在路径拒绝而不回退到默认 workspace", async () => {
  const policy = new WorkspacePolicy([]);
  await assert.rejects(
    () => policy.resolveWorkspace(path.join(os.tmpdir(), "cbx-policy-missing", "child")),
    (error) => isCbxError(error, "E_INVALID_WORKSPACE"),
  );
});

test("listAllowedWorkspaces 返回不可篡改的副本", async () => {
  const policy = new WorkspacePolicy([]);
  const first = await policy.listAllowedWorkspaces();
  assert.equal(Object.isFrozen(first), true);
  assert.throws(() => {
    first.push("/outside");
  }, TypeError);
  assert.deepEqual(await policy.listAllowedWorkspaces(), first);
});

test("显式白名单优先于调用方目录：会话 cwd 不在白名单时拒绝且提示", async () => {
  const allowed = await mkdtemp(path.join(os.tmpdir(), "cbx-policy-"));
  const delegated = await mkdtemp(path.join(os.tmpdir(), "cbx-policy-delegated-"));
  try {
    const policy = new WorkspacePolicy([allowed]);
    // 显式白名单时，会话 cwd 不在列表内 → 拒绝，并列出允许的工作区。
    await assert.rejects(
      () => policy.resolveWorkspace(undefined, delegated),
      (error) => {
        assert.equal(isCbxError(error, "E_INVALID_WORKSPACE"), true);
        assert.match(String(error.message), /当前允许的工作区/);
        assert.equal(String(error.message).includes(allowed), true);
        return true;
      },
    );
  } finally {
    await Promise.all([
      rm(allowed, { recursive: true, force: true }),
      rm(delegated, { recursive: true, force: true }),
    ]);
  }
});

test("符号链接目录按 realpath 命中 allowlist（平台允许创建时）", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cbx-policy-"));
  const target = path.join(root, "target");
  const link = path.join(root, "link");
  try {
    await mkdir(target);
    try {
      await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "EINVAL") {
        t.skip("当前平台不允许创建目录符号链接：" + error.code);
        return;
      }
      throw error;
    }
    const policy = new WorkspacePolicy([target]);
    assert.equal(await policy.resolveWorkspace(link), await realpath(target));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
