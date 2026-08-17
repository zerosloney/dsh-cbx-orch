import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveWorktreeWorkspace } from "../lib/subprocess-adapter.js";
import {
  loadRuntimeExecutorsAllowlist,
  closeDatabaseConnections,
} from "../lib/storage.js";

const workspaces = [];

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "cbx-wt-"));
  workspaces.push(dir);
  return dir;
}

after(async () => {
  await closeDatabaseConnections();
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

// 构造 cbx worktree 布局（对齐 git-ops.ts）：<root> 主工作区，其 worktree 在
//   <parent>/.<basename(root)>.cbx-worktrees/<jobId>。
function makeWorktreeLayout() {
  const root = workspace();
  const parent = path.dirname(root);
  const base = path.basename(root);
  const container = path.join(parent, `.${base}.cbx-worktrees`);
  const jobDir = path.join(container, `job-${Date.now().toString(36)}`);
  mkdirSync(path.join(root, ".cbx"), { recursive: true });
  mkdirSync(jobDir, { recursive: true });
  return { root, parent, base, container, jobDir };
}

test("resolveWorktreeWorkspace: 在 worktree 内定位到主工作区（含 .cbx/）", () => {
  const { root, jobDir } = makeWorktreeLayout();
  // 深一层子目录也应命中
  const deep = path.join(jobDir, "src", "lib");
  mkdirSync(deep, { recursive: true });
  const resolved = resolveWorktreeWorkspace(deep);
  assert.equal(resolved && path.resolve(resolved), path.resolve(root));
});

test("resolveWorktreeWorkspace: 主工作区已配 .cbx.json 也被识别", () => {
  const { root, jobDir } = makeWorktreeLayout();
  writeFileSync(path.join(root, ".cbx.json"), "{}", "utf8");
  const resolved = resolveWorktreeWorkspace(path.join(jobDir, "pkg"));
  assert.equal(resolved && path.resolve(resolved), path.resolve(root));
});

test("resolveWorktreeWorkspace: 主工作区无 .cbx 也不认（防误匹配任意 .cbx-worktrees 目录）", () => {
  const { root, jobDir } = makeWorktreeLayout();
  // 清掉主工作区的 .cbx 标记
  rmSync(path.join(root, ".cbx"), { recursive: true, force: true });
  rmSync(path.join(root, ".cbx.json"), { force: true });
  assert.equal(existsSync(path.join(root, ".cbx")), false);
  const resolved = resolveWorktreeWorkspace(jobDir);
  assert.equal(resolved, undefined);
});

test("resolveWorktreeWorkspace: 普通目录（无 worktree 标记）返回 undefined", () => {
  const ws = workspace();
  assert.equal(resolveWorktreeWorkspace(ws), undefined);
  assert.equal(resolveWorktreeWorkspace(path.join(ws, "nested")), undefined);
});

test("resolveWorktreeWorkspace: 任意 .cbx-worktrees 后缀的普通目录（无 .cbx 标记前导）不被误认", () => {
  const ws = workspace();
  const fake = path.join(ws, "not.a.cbx-worktrees", "job-1");
  mkdirSync(fake, { recursive: true });
  // ws 无 .cbx 标记 → undefined（不会把 ws 当主工作区）
  assert.equal(resolveWorktreeWorkspace(fake), undefined);
});

test("工作区级 envAllowlist 经 loadRuntimeExecutorsAllowlist 读取（worktree 映射依赖它）", async () => {
  const root = workspace();
  writeFileSync(
    path.join(root, ".cbx.json"),
    JSON.stringify({ executors: { envAllowlist: ["MY_SECRET"] } }),
    "utf8",
  );
  const result = await loadRuntimeExecutorsAllowlist(root);
  assert.deepEqual(result, { configured: true, allowlist: ["MY_SECRET"] });
});
