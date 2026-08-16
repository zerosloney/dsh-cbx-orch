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
