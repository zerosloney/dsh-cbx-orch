import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerCbxTools } from "../lib/tools.js";
import { isCbxError } from "../lib/errors.js";
import { closeDatabaseConnections } from "../lib/storage.js";
import { WorkspacePolicy } from "../lib/workspace-policy.js";

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
    policy ? { workspacePolicy: policy } : {},
  );
  return definitions;
}

test("默认策略解析 cwd 后才进入下游；异步改造不破坏工具执行", async () => {
  const tools = registeredTools();
  await assert.rejects(
    () => tools.get("cbx_status").execute({ job_id: "../invalid-job-id" }),
    (error) => isCbxError(error, "E_INVALID_JOB_ID"),
  );
});

test("显式越权 workspace 在 cbx_list 下游前被拒绝且不创建 .cbx", async () => {
  const allowed = await mkdtemp(path.join(os.tmpdir(), "cbx-tools-policy-"));
  const denied = await mkdtemp(path.join(os.tmpdir(), "cbx-tools-policy-"));
  try {
    const tools = registeredTools(new WorkspacePolicy([allowed]));
    await assert.rejects(
      () => tools.get("cbx_list").execute({ workspace: denied }),
      (error) => isCbxError(error, "E_INVALID_WORKSPACE"),
    );
    assert.equal(existsSync(path.join(denied, ".cbx")), false);
  } finally {
    await Promise.all([
      rm(allowed, { recursive: true, force: true }),
      rm(denied, { recursive: true, force: true }),
    ]);
  }
});

test("显式越权 root 在 cbx_list_workspaces 下游前被拒绝且不扫描子目录", async () => {
  const allowed = await mkdtemp(path.join(os.tmpdir(), "cbx-tools-policy-"));
  const deniedRoot = await mkdtemp(path.join(os.tmpdir(), "cbx-tools-policy-"));
  const hiddenWorkspace = path.join(deniedRoot, "hidden");
  try {
    await mkdir(hiddenWorkspace);
    await mkdir(path.join(hiddenWorkspace, ".cbx"));
    const tools = registeredTools(new WorkspacePolicy([allowed]));
    await assert.rejects(
      () => tools.get("cbx_list_workspaces").execute({ root: deniedRoot }),
      (error) => isCbxError(error, "E_INVALID_WORKSPACE"),
    );
    assert.equal(existsSync(path.join(deniedRoot, ".cbx")), false);
  } finally {
    await Promise.all([
      rm(allowed, { recursive: true, force: true }),
      rm(deniedRoot, { recursive: true, force: true }),
    ]);
  }
});

test("允许 workspace 的 list_workspaces 只返回授权目标，不隐式发现子目录", async () => {
  const allowed = await mkdtemp(path.join(os.tmpdir(), "cbx-tools-policy-"));
  const child = path.join(allowed, "child");
  try {
    await mkdir(child);
    await mkdir(path.join(child, ".cbx"));
    const policy = new WorkspacePolicy([allowed]);
    const tools = registeredTools(policy);
    const result = await tools.get("cbx_list_workspaces").execute({ root: allowed });
    assert.deepEqual(result.workspaces, [await policy.resolveWorkspace(allowed)]);
    assert.deepEqual(result.jobs, [{ workspace: result.workspaces[0], jobs: [] }]);
    assert.equal(result.workspaces.includes(child), false);
  } finally {
    await closeDatabaseConnections();
    await rm(allowed, { recursive: true, force: true });
  }
});

test("缺失或非目录 workspace 在 health 下游前被拒绝", async () => {
  const allowed = await mkdtemp(path.join(os.tmpdir(), "cbx-tools-policy-"));
  const missing = path.join(allowed, "missing");
  const file = path.join(allowed, "not-a-directory");
  try {
    await writeFile(file, "fixture", "utf8");
    const tools = registeredTools(new WorkspacePolicy([allowed]));
    for (const workspace of [missing, file]) {
      await assert.rejects(
        () => tools.get("cbx_health").execute({ workspace }),
        (error) => isCbxError(error, "E_INVALID_WORKSPACE"),
      );
    }
    assert.equal(existsSync(path.join(allowed, ".cbx")), false);
  } finally {
    await rm(allowed, { recursive: true, force: true });
  }
});
