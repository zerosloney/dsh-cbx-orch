import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import CbxOrchestrator from "../lib/index.js";
import { closeDatabaseConnections } from "../lib/storage.js";
import { extractExecutorOverride } from "../lib/commands.js";
import { cancelJob } from "../lib/lifecycle.js";
import { loadState } from "../lib/state.js";
import { stopScheduler } from "../lib/queue-api.js";

// ---- extractExecutorOverride：纯函数单测 ----

test("extractExecutorOverride: --executor <name> 任意位置", () => {
  assert.deepEqual(
    extractExecutorOverride("--executor opencode 审查这个项目"),
    { executor: "opencode", task: "审查这个项目" },
  );
  assert.deepEqual(
    extractExecutorOverride("审查这个项目 --executor=qwen"),
    { executor: "qwen", task: "审查这个项目" },
  );
});

test("extractExecutorOverride: 前导 @name 仅命中内置注册名/别名才剥离", () => {
  assert.deepEqual(
    extractExecutorOverride("@opencode 审查这个项目"),
    { executor: "opencode", task: "审查这个项目" },
  );
  // 别名 oh-my-pi → omp
  assert.deepEqual(
    extractExecutorOverride("@oh-my-pi 跑任务"),
    { executor: "oh-my-pi", task: "跑任务" },
  );
  // 未命中内置执行器的 @ 前缀是普通任务文本，不误伤
  assert.deepEqual(
    extractExecutorOverride("@user 请看这个问题"),
    { executor: undefined, task: "@user 请看这个问题" },
  );
});

test("extractExecutorOverride: 无覆盖时原样返回", () => {
  assert.deepEqual(
    extractExecutorOverride("委派 opencode 审查（自然语言不算覆盖）"),
    { executor: undefined, task: "委派 opencode 审查（自然语言不算覆盖）" },
  );
  assert.deepEqual(extractExecutorOverride("  "), { executor: undefined, task: "" });
});

// ---- /cbx-run 端到端：执行器覆盖生效 + 回复带路由行 ----

/**
 * 最小可用 fake subprocess：spawn 立即返回"exitCode=1 已退出"的句柄。
 * git 调用（captureAsync→provider）拿到 code≠0 → 非仓库目录优雅降级，
 * createJob 正常完成；不抛 TypeError。任务若被调度执行也会快速失败，无副作用。
 */
function fakeSubprocess() {
  return {
    spawn() {
      return {
        pid: 0,
        stdout: undefined,
        stderr: undefined,
        done: Promise.resolve({ exitCode: 1, signal: null }),
        terminate() {},
      };
    },
  };
}

function fakeHarness(overrides = {}) {
  const tools = new Map();
  const commands = new Map();
  const effects = [];
  const logger = { error() {}, warn() {}, info() {} };
  const services = { ...(overrides.services ?? {}) };
  const context = {
    reflect: { provide() {} },
    subprocess: overrides.subprocess ?? fakeSubprocess(),
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
    get(name) {
      if (Object.prototype.hasOwnProperty.call(services, name)) return services[name];
      if (name === "subprocess") return context.subprocess;
      return undefined;
    },
  };
  return {
    context,
    tools,
    commands,
    async dispose() {
      const ordered = [
        ...effects.filter((effect) => effect.label === "cbx.scheduler"),
        ...effects.filter((effect) => effect.label !== "cbx.scheduler"),
      ];
      for (const effect of ordered) await effect.cleanup?.();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await closeDatabaseConnections();
    },
  };
}

/** Windows 瞬态句柄的目录清理：退避重试并每轮重关连接。 */
async function rmRetry(target) {
  for (let attempt = 0; ; attempt += 1) {
    await closeDatabaseConnections();
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 8) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

const TERMINAL = new Set(["done", "failed", "review_failed", "cancelled", "needs_fix"]);

/**
 * 完整清理：取消任务并等终态 → dispose 插件（停 tracked 调度器）→
 * stopScheduler 停掉入队时经 ensureScheduler 拉起的**动态** serve 循环
 * （它不受插件 effect 管理，租约定时器会占住 SQLite 导致 rm EBUSY）。
 */
async function cleanupRun(harness, delegated, result) {
  const id = typeof result?.text === "string" ? /job (\S+) queued/.exec(result.text)?.[1] : undefined;
  if (id) {
    try {
      await cancelJob(delegated, id);
    } catch {
      /* 已终态/不存在：忽略 */
    }
    for (let i = 0; i < 40; i += 1) {
      try {
        const state = await loadState(delegated, id);
        if (TERMINAL.has(state.status)) break;
      } catch {
        /* state 未就绪 */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await harness.dispose();
  await stopScheduler(delegated).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 200));
}

test("/cbx-run --executor 显式指定：路由到该执行器，回复带「已委派给」路由行", async () => {
  const delegated = await mkdtemp(path.join(os.tmpdir(), "cbx-command-run-"));
  const harness = fakeHarness();
  let result;
  try {
    new CbxOrchestrator(harness.context, {
      executor: "codebuddy",
      review: false,
      isolated: false,
      workspaces: [],
    });
    const command = harness.commands.get("cbx-run");
    assert.ok(command, "应捕获 cbx-run 命令");
    result = await command.handler({
      rawInput: "--executor opencode 审查这个项目",
      agent: { session: { header: { cwd: delegated }, id: "parent-x" } },
    });
    assert.equal(result.kind, "success");
    // 任务文本剔除 flag；显式指定已装执行器 → 「已委派给」+ 执行器名
    assert.match(result.text, /job \S+ queued\. 已委派给执行器 opencode/);
    assert.doesNotMatch(result.text, /--executor/);
    // 桥/外观层的 router 透传已在 jobs-bridge/subagent-facade 单测覆盖；
    // 这里只验证命令入口的解析与回复文案。
  } finally {
    await cleanupRun(harness, delegated, result);
    await rmRetry(delegated);
  }
});

test("/cbx-run @name 前导简写同样生效且剥离前缀", async () => {
  const delegated = await mkdtemp(path.join(os.tmpdir(), "cbx-command-run2-"));
  const harness = fakeHarness();
  let result;
  try {
    new CbxOrchestrator(harness.context, {
      executor: "auto",
      review: false,
      isolated: false,
      workspaces: [],
    });
    const command = harness.commands.get("cbx-run");
    result = await command.handler({
      rawInput: "@opencode 审查这个项目",
      agent: { session: { header: { cwd: delegated }, id: "parent-y" } },
    });
    assert.equal(result.kind, "success");
    assert.match(result.text, /已委派给执行器 opencode/);
    assert.doesNotMatch(result.text, /@opencode/);
  } finally {
    await cleanupRun(harness, delegated, result);
    await rmRetry(delegated);
  }
});
