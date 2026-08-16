import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import CbxOrchestrator from "../lib/index.js";
import { closeDatabaseConnections } from "../lib/storage.js";

function fakeHarness() {
  const tools = new Map();
  const commands = new Map();
  const effects = [];
  const logger = { error() {}, warn() {}, info() {} };
  const context = {
    reflect: { provide() {} },
    subprocess: {},
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    commands: {
      register(definition) {
        commands.set(definition.name, definition);
        return () => commands.delete(definition.name);
      },
    },
    logger() {
      return logger;
    },
    effect(factory, label) {
      const cleanup = factory();
      effects.push({ cleanup, label });
      return cleanup;
    },
  };
  return {
    context,
    tools,
    commands,
    async dispose() {
      // Stop the scheduler before the provider closes database connections;
      // this mirrors the ownership order needed by the real host lifecycle.
      const ordered = [
        ...effects.filter((effect) => effect.label === "cbx.scheduler"),
        ...effects.filter((effect) => effect.label !== "cbx.scheduler"),
      ];
      for (const effect of ordered) await effect.cleanup?.();
      // index cleanup intentionally fire-and-forgets stopScheduler; let that
      // promise settle before the explicit database cleanup below.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await closeDatabaseConnections();
    },
  };
}

async function waitForFile(file, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(existsSync(file), true, `expected ${file} to be created`);
}

test("core scheduler follows the allowed canonical workspace and commands reject an unauthorized cwd", async (t) => {
  const cwdCbx = path.join(process.cwd(), ".cbx");
  // Never remove or mutate an existing user workspace. The test only runs its
  // cwd-touch assertion when the repository cwd has no .cbx directory.
  if (existsSync(cwdCbx)) {
    t.skip("当前 cwd 已有 .cbx，跳过避免触碰用户数据");
    return;
  }

  const allowed = await mkdtemp(path.join(os.tmpdir(), "cbx-core-policy-"));
  const harness = fakeHarness();
  try {
    new CbxOrchestrator(harness.context, {
      executor: "codebuddy",
      review: true,
      isolated: true,
      workspaces: [allowed],
    });

    await waitForFile(path.join(allowed, ".cbx", "state.sqlite"));
    assert.equal(existsSync(cwdCbx), false, "scheduler 不应触碰未授权 cwd");

    const command = harness.commands.get("cbx-run");
    assert.ok(command, "应捕获 cbx-run 命令");
    const result = await command.handler({ rawInput: "should be rejected" });
    assert.equal(result.kind, "error");
    assert.match(result.text, /工作区|workspace/);
    assert.equal(existsSync(cwdCbx), false, "拒绝命令不应在 cwd 创建 .cbx");
  } finally {
    await harness.dispose();
    await rm(allowed, { recursive: true, force: true });
    assert.equal(existsSync(cwdCbx), false, "测试不得在 cwd 留下 .cbx");
  }
});
