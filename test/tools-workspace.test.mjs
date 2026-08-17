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

test("空配置时默认工作区跟随 tool 调用的 agent 会话 cwd（目录委派语义）", async (t) => {
  const delegated = await mkdtemp(path.join(os.tmpdir(), "cbx-tools-session-"));
  const unauthorized = await mkdtemp(path.join(os.tmpdir(), "cbx-tools-session-"));
  try {
    // 空 allowlist：无显式 workspace 参数时，以 exec.agent.session.header.cwd 为默认工作区。
    const tools = registeredTools(); // WorkspacePolicy() → 空配置
    const lossless = (value) => JSON.parse(JSON.stringify(value));
    const execWith = (cwd) => ({
      agent: { session: { header: { cwd } } },
      signal: new AbortController().signal,
    });
    // cbx_health 在委派目录上执行成功（不落盘 .cbx 之外的痕迹；health 只读）。
    const result = await tools.get("cbx_health").execute({}, execWith(delegated));
    assert.equal(lossless(result).status, "ok");
    // 另一个委派目录同样放行：空配置不缓存首个调用方，随调用上下文动态解析。
    const second = await tools.get("cbx_health").execute({}, execWith(unauthorized));
    assert.equal(lossless(second).status, "ok");
    // 显式传入的 workspace 参数仍受约束：与上下文目录不同则拒绝。
    const other = await mkdtemp(path.join(os.tmpdir(), "cbx-tools-session-"));
    try {
      await assert.rejects(
        () => tools.get("cbx_health").execute({ workspace: other }, execWith(delegated)),
        (error) => isCbxError(error, "E_INVALID_WORKSPACE"),
      );
    } finally {
      await rm(other, { recursive: true, force: true });
    }
    // 无 agent 上下文（exec 缺省）回落 process.cwd()。
    const cwdResult = await tools.get("cbx_health").execute({});
    assert.equal(lossless(cwdResult).status, "ok");
  } finally {
    await closeDatabaseConnections();
    await Promise.all([
      rm(delegated, { recursive: true, force: true }),
      rm(unauthorized, { recursive: true, force: true }),
    ]);
  }
});

test("显式白名单时工具默认工作区不自作主张：会话 cwd 不在列表内则拒绝", async (t) => {
  const allowed = await mkdtemp(path.join(os.tmpdir(), "cbx-tools-policy-"));
  const delegated = await mkdtemp(path.join(os.tmpdir(), "cbx-tools-session-"));
  try {
    const tools = registeredTools(new WorkspacePolicy([allowed]));
    const execWith = (cwd) => ({
      agent: { session: { header: { cwd } } },
      signal: new AbortController().signal,
    });
    // 显式白名单优先：即使会话 cwd 是委派目录，不在列表内依然拒绝并给出提示。
    await assert.rejects(
      () => tools.get("cbx_health").execute({}, execWith(delegated)),
      (error) => {
        assert.equal(isCbxError(error, "E_INVALID_WORKSPACE"), true);
        assert.match(String(error.message), /当前允许的工作区/);
        assert.equal(String(error.message).includes(allowed), true);
        return true;
      },
    );
  } finally {
    await closeDatabaseConnections();
    await Promise.all([
      rm(allowed, { recursive: true, force: true }),
      rm(delegated, { recursive: true, force: true }),
    ]);
  }
});
