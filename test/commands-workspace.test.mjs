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

test("命令默认工作区跟随委派的 agent 会话 cwd（header.cwd），不回落到进程 cwd", async (t) => {
  const cwdCbx = path.join(process.cwd(), ".cbx");
  if (existsSync(cwdCbx)) {
    t.skip("当前 cwd 已有 .cbx，跳过避免触碰用户数据");
    return;
  }

  // 空配置：显式白名单不启用，命令默认工作区 = 会话 header.cwd，回落 process.cwd()。
  const harness = fakeHarness();
  try {
    new CbxOrchestrator(harness.context, {
      executor: "codebuddy",
      review: true,
      isolated: true,
      workspaces: [],
    });

    const delegated = await mkdtemp(path.join(os.tmpdir(), "cbx-command-session-"));
    const command = harness.commands.get("cbx-list");
    assert.ok(command, "应捕获 cbx-list 命令");
    // 委派目录的会话上下文：命令应在该目录解析工作区，而非进程 cwd。
    const result = await command.handler({
      rawInput: "",
      agent: { session: { header: { cwd: delegated } } },
    });
    assert.equal(result.kind, "success", "委派目录应放行并返回列表");
    // listJobs 只读数据库会在解析出的工作区落盘 state.sqlite——若默认工作区正确
    // 跟随 header.cwd，.cbx 应出现在委派目录而非进程 cwd。
    assert.equal(
      existsSync(path.join(delegated, ".cbx", "state.sqlite")),
      true,
      "命令应在委派目录解析工作区（.cbx 落在委派目录）",
    );
    assert.equal(existsSync(cwdCbx), false, "命令不应在进程 cwd 创建 .cbx");
    await rm(delegated, { recursive: true, force: true });
  } finally {
    await harness.dispose();
    assert.equal(existsSync(cwdCbx), false, "测试不得在 cwd 留下 .cbx");
  }
});
