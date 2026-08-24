import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import CbxOrchestrator from "../lib/index.js";
import { closeDatabaseConnections } from "../lib/storage.js";

function fakeHarness(overrides = {}) {
  const tools = new Map();
  const commands = new Map();
  const effects = [];
  const logger = { error() {}, warn() {}, info() {} };
  const services = { ...(overrides.services ?? {}) };
  const context = {
    reflect: { provide() {} },
    subprocess: overrides.subprocess ?? {},
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
      // core 插件把 subprocess 作为 ctx 注入属性（index.ts 用 ctx.subprocess）；
      // ctx.get 侧需能经同一路径读到，供 /cbx-web 的浏览器唤起走 subprocess 服务。
      if (name === "subprocess") return overrides.subprocess ?? {};
      return undefined;
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

/** Windows 瞬态句柄的目录清理：退避重试并每轮重关连接（与 jobs-bridge 测试同模式）。 */
async function rmRetry(target) {
  for (let attempt = 0; ; attempt += 1) {
    await closeDatabaseConnections();
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
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
    // cbx-list 在委派目录打开过 state.sqlite；dispose 前 rm 会撞 Windows 瞬态句柄。
    // rmRetry 每轮重关连接并退避重试，避免 EBUSY。
    await rmRetry(delegated);
  } finally {
    await harness.dispose();
    assert.equal(existsSync(cwdCbx), false, "测试不得在 cwd 留下 .cbx");
  }
});

test("/cbx-web 解析会话 cwd 工作区并输出仪表盘链接（无 webServer 回落默认端口）", async (t) => {
  const cwdCbx = path.join(process.cwd(), ".cbx");
  if (existsSync(cwdCbx)) {
    t.skip("当前 cwd 已有 .cbx，跳过避免触碰用户数据");
    return;
  }

  const harness = fakeHarness();
  const delegated = await mkdtemp(path.join(os.tmpdir(), "cbx-command-web-"));
  try {
    new CbxOrchestrator(harness.context, {
      executor: "codebuddy",
      review: true,
      isolated: true,
      workspaces: [],
    });

    const command = harness.commands.get("cbx-web");
    assert.ok(command, "应捕获 cbx-web 命令");
    const result = await command.handler({
      rawInput: "",
      agent: { session: { header: { cwd: delegated } } },
    });
    assert.equal(result.kind, "success");
    // 会话 cwd 作为工作区；无 webServer 服务时回落默认端口 3080。
    // 链接里的工作区是 realpath 规范化后的规范形式（CI runner 上 realpath 会展开
    // 8.3 短名如 RUNNER~1），断言也用规范化后的形式，平台无关。
    const canonicalDelegated = await realpath(delegated);
    assert.match(result.text, /cbx 仪表盘/);
    assert.ok(result.text.includes(encodeURIComponent(canonicalDelegated)), "链接应编码会话 cwd");
    assert.match(result.text, /http:\/\/127\.0\.0\.1:3080\/cbx\/\?workspace=/);
    // headless profile 提示 + 未自动打开浏览器的回落提示
    assert.match(result.text, /未自动打开浏览器/);
    assert.match(result.text, /未加载 cbx-orch-web/);
    assert.equal(existsSync(cwdCbx), false, "命令不应在进程 cwd 创建 .cbx");
  } finally {
    await harness.dispose();
    await rmRetry(delegated);
    assert.equal(existsSync(cwdCbx), false, "测试不得在 cwd 留下 .cbx");
  }
});

test("/cbx-web cbxWeb 服务存在但路由未挂载（mounted=false）→ 给未挂载提示而非误导为可访问", async () => {
  const allowed = await mkdtemp(path.join(os.tmpdir(), "cbx-command-web-unmounted-"));
  const harness = fakeHarness({
    // cbxWeb 服务存在但 mounted=false：模拟 token fail-closed / 轮询等待中 /
    // 策略解析失败的真实场景——服务已注册但 /cbx 路由不存在，打开浏览器只会 404。
    services: { webServer: { port: 3456, host: "127.0.0.1" }, cbxWeb: { mounted: false } },
    subprocess: {
      spawn() {
        return { done: Promise.resolve({ exitCode: 0, signal: null }) };
      },
    },
  });
  try {
    new CbxOrchestrator(harness.context, {
      executor: "codebuddy",
      review: true,
      isolated: true,
      workspaces: [allowed],
    });

    const command = harness.commands.get("cbx-web");
    assert.ok(command, "应捕获 cbx-web 命令");
    const result = await command.handler({ rawInput: allowed });
    assert.equal(result.kind, "success");
    // 未挂载：提示路由未挂载（而非 Web token 提示，那是已挂载分支）
    assert.match(result.text, /cbx web 路由尚未挂载/);
    assert.equal(result.text.includes("Web token"), false);
  } finally {
    await harness.dispose();
    await rm(allowed, { recursive: true, force: true });
  }
});

test("/cbx-web 显式 workspace 命中白名单并尝试在系统浏览器打开（实际端口 + cbxWeb 激活）", async () => {
  const allowed = await mkdtemp(path.join(os.tmpdir(), "cbx-command-web-"));
  const spawned = [];
  const harness = fakeHarness({
    // cbxWeb.mounted=true：模拟仪表盘路由已真实挂载（新语义下 webPluginActive
    // 读 mounted 而非服务存在——服务存在但路由未挂载（token fail-closed/轮询中）
    // 时 /cbx-web 应给"未挂载"提示而非误导为可访问）。
    services: { webServer: { port: 3456, host: "127.0.0.1" }, cbxWeb: { mounted: true } },
    subprocess: {
      spawn(spec) {
        spawned.push(spec);
        return { done: Promise.resolve({ exitCode: 0, signal: null }) };
      },
    },
  });
  try {
    new CbxOrchestrator(harness.context, {
      executor: "codebuddy",
      review: true,
      isolated: true,
      workspaces: [allowed],
    });

    const command = harness.commands.get("cbx-web");
    assert.ok(command, "应捕获 cbx-web 命令");
    const result = await command.handler({ rawInput: allowed });
    assert.equal(result.kind, "success");
    const canonicalAllowed = await realpath(allowed);
    const url = `http://127.0.0.1:3456/cbx/?workspace=${encodeURIComponent(canonicalAllowed)}`;
    assert.ok(result.text.includes(url), `回复应包含实际端口的完整 URL：\n${result.text}`);
    // cbx 插件激活：给出 token 提示而不是 headless 提示
    assert.match(result.text, /Web token/);
    assert.equal(result.text.includes("未加载 cbx-orch-web"), false);
    // 已尝试通过 subprocess 打开浏览器：argv 末尾即完整 URL
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].argv[spawned[0].argv.length - 1], url);
    assert.match(result.text, /已在系统默认浏览器尝试打开/);
  } finally {
    await harness.dispose();
    await rmRetry(allowed);
  }
});

test("/cbx-web 越权 workspace 拒绝并提示授权位置", async () => {
  const allowed = await mkdtemp(path.join(os.tmpdir(), "cbx-command-web-"));
  const denied = await mkdtemp(path.join(os.tmpdir(), "cbx-command-web-"));
  const harness = fakeHarness();
  try {
    new CbxOrchestrator(harness.context, {
      executor: "codebuddy",
      review: true,
      isolated: true,
      workspaces: [allowed],
    });

    const command = harness.commands.get("cbx-web");
    const result = await command.handler({ rawInput: denied });
    assert.equal(result.kind, "error");
    assert.match(result.text, /工作区|workspace/i);
    assert.equal(result.text.includes(await realpath(allowed)), true, "报错应列出允许的工作区");
    assert.equal(existsSync(path.join(allowed, ".cbx")), false, "拒绝时不应创建 .cbx");
    assert.equal(existsSync(path.join(denied, ".cbx")), false, "拒绝时不应创建 .cbx");
  } finally {
    await harness.dispose();
    await Promise.all([rmRetry(allowed), rmRetry(denied)]);
  }
});
