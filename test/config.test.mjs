import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import CbxOrchestrator from "../lib/index.js";
import { isCbxError } from "../lib/errors.js";
import { closeDatabaseConnections } from "../lib/storage.js";

test("CbxOrchestrator.Config: 空配置使用部署默认值", () => {
  assert.deepEqual(CbxOrchestrator.Config({}), {
    executor: "codebuddy",
    review: true,
    isolated: true,
    carryDirty: false,
    workspaces: [],
    executors: { envAllowlist: [] },
    governance: {},
    dbIdleTimeoutMs: 60000,
  });
});

test("CbxOrchestrator.Config: 部分配置补齐默认值", () => {
  assert.deepEqual(CbxOrchestrator.Config({ review: false }), {
    executor: "codebuddy",
    review: false,
    isolated: true,
    carryDirty: false,
    workspaces: [],
    executors: { envAllowlist: [] },
    governance: {},
    dbIdleTimeoutMs: 60000,
  });
});

test("CbxOrchestrator.Config: 完整配置保持覆盖语义", () => {
  assert.deepEqual(CbxOrchestrator.Config({
    executor: "opencode",
    review: false,
    isolated: false,
  }), {
    executor: "opencode",
    review: false,
    isolated: false,
    carryDirty: false,
    workspaces: [],
    executors: { envAllowlist: [] },
    governance: {},
    dbIdleTimeoutMs: 60000,
  });
});

test("CbxOrchestrator.Config: 显式 workspace 列表保持覆盖语义", () => {
  const workspaces = ["/srv/project-a", "/srv/project-b"];
  assert.deepEqual(CbxOrchestrator.Config({ workspaces }), {
    executor: "codebuddy",
    review: true,
    isolated: true,
    carryDirty: false,
    workspaces,
    executors: { envAllowlist: [] },
    governance: {},
    dbIdleTimeoutMs: 60000,
  });
});

test("CbxOrchestrator.Config: executors.envAllowlist 覆盖各自定义", () => {
  assert.deepEqual(CbxOrchestrator.Config({ executors: { envAllowlist: ["MY_TOKEN"] } }), {
    executor: "codebuddy",
    review: true,
    isolated: true,
    carryDirty: false,
    workspaces: [],
    executors: { envAllowlist: ["MY_TOKEN"] },
    governance: {},
    dbIdleTimeoutMs: 60000,
  });
});

test("CbxOrchestrator.Config: governance 全局治理覆盖", () => {
  assert.deepEqual(CbxOrchestrator.Config({
    governance: { maxGlobalConcurrent: 3, maxGlobalInvocations: 40 },
  }).governance, {
    maxGlobalConcurrent: 3,
    maxGlobalInvocations: 40,
  });
  // min(1)：0 在 schema 层即拒绝
  assert.throws(
    () => CbxOrchestrator.Config({ governance: { maxGlobalConcurrent: 0 } }),
    /maxGlobalConcurrent/,
  );
});

test("服务注册工具共享配置的 workspace 策略", async () => {
  const allowed = await mkdtemp(path.join(os.tmpdir(), "cbx-config-policy-"));
  const denied = await mkdtemp(path.join(os.tmpdir(), "cbx-config-policy-"));
  const definitions = new Map();
  const cleanups = [];
  const context = {
    reflect: { provide() {} },
    subprocess: {},
    tools: {
      register(definition) {
        definitions.set(definition.name, definition);
        return () => definitions.delete(definition.name);
      },
    },
    commands: { register() {} },
    effect(factory, label) {
      // Avoid starting a real scheduler; retain the provider cleanup for this test.
      if (label === "cbx.provider") {
        const cleanup = factory();
        cleanups.push(cleanup);
        return cleanup;
      }
      return () => {};
    },
  };

  try {
    new CbxOrchestrator(context, {
      executor: "codebuddy",
      review: true,
      isolated: true,
      workspaces: [allowed],
    });

    await definitions.get("cbx_list").execute({ workspace: allowed });
    await definitions.get("cbx_health").execute({ workspace: allowed });
    for (const toolName of ["cbx_list", "cbx_health"]) {
      await assert.rejects(
        () => definitions.get(toolName).execute({ workspace: denied }),
        (error) => isCbxError(error, "E_INVALID_WORKSPACE"),
      );
    }
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup?.();
    await closeDatabaseConnections();
    await Promise.all([
      rm(allowed, { recursive: true, force: true }),
      rm(denied, { recursive: true, force: true }),
    ]);
  }
});
