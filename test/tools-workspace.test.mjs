import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerCbxTools } from "../lib/tools.js";
import { isCbxError } from "../lib/errors.js";
import { closeDatabaseConnections } from "../lib/storage.js";
import { WorkspacePolicy } from "../lib/workspace-policy.js";
import { resetExecutorProbeCache } from "../lib/executors/builtin.js";
import { stopScheduler } from "../lib/queue-api.js";

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
  // 用临时 cwd 隔离「无 agent 上下文回落 process.cwd()」的探测：避免把 .cbx 写进
  // 仓库 cwd（node --test 并行运行多个文件共享同一进程 cwd，会污染其他文件的 cwd 断言）。
  const tempCwd = await mkdtemp(path.join(os.tmpdir(), "cbx-tools-cwd-"));
  const previousCwd = process.cwd();
  try {
    process.chdir(tempCwd);
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
    // 无 agent 上下文（exec 缺省）回落 process.cwd()（此处为临时 cwd）。
    const cwdResult = await tools.get("cbx_health").execute({});
    assert.equal(lossless(cwdResult).status, "ok");
  } finally {
    process.chdir(previousCwd);
    await closeDatabaseConnections();
    await Promise.all([
      rm(delegated, { recursive: true, force: true }),
      rm(unauthorized, { recursive: true, force: true }),
      rm(tempCwd, { recursive: true, force: true }),
    ]);
  }
});

test("显式白名单时工具默认工作区不自作主张：会话 cwd 不在列表内则拒绝", async (t) => {
  const allowed = await mkdtemp(path.join(os.tmpdir(), "cbx-tools-policy-"));
  const delegated = await mkdtemp(path.join(os.tmpdir(), "cbx-tools-session-"));
  // CI runner 上 realpath 会展开 8.3 短名（如 RUNNER~1），与 mkdtemp 返回的长名不同；
  // 报错列出的是 realpath 规范化后的允许路径，断言用规范化后的形式（平台无关）。
  const canonicalAllowed = await realpath(allowed);
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
        assert.equal(String(error.message).includes(canonicalAllowed), true);
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

test("cbx_run 结果附工作区任务清单（__taskList）且渲染直接显示在会话", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-tools-run-"));
  // CI runner 上没有任何真实编码 agent CLI，路由会抛 noExecutorError 导致本测试挂掉。
  // 用 envVar 覆盖注入一个"存在路径"的假执行器（与 executor-router 测试同模式）：
  // 路由选到 omp 并正常入队；执行阶段 spawn 该假路径会快速失败，不影响创建期断言。
  const fakeExecDir = await mkdtemp(path.join(os.tmpdir(), "cbx-tools-exec-"));
  const fakeExec = path.join(fakeExecDir, "omp-cli");
  await writeFile(fakeExec, "", "utf8");
  const previousOmp = process.env.CBX_OMP;
  process.env.CBX_OMP = fakeExec;
  resetExecutorProbeCache();
  try {
    const tools = registeredTools(new WorkspacePolicy([ws]));
    const definition = tools.get("cbx_run");
    const result = await definition.execute({
      workspace: ws,
      task: "implement the feature",
      test: "npm test",
      // 停在执行前审批门：不触发真实执行器 spawn/重试循环（测试只断言创建期）。
      // 空文件假执行器若被 spawn 会失败并进入重试，拖住全量测试进程。
      approval_before_run: true,
      // 已知字段必须原样透传到路由决策（schema 收窄后拼错字段会被框架拒绝/告警，不再静默忽略）
      executor_requirements: { exclude: [] },
    });
    assert.equal(result.status, "queued");
    assert.equal(typeof result.job_id, "string");
    // executor_requirements 透传：空 exclude 不影响路由，但决策里必须带出该需求
    assert.deepEqual(result.__router.requirements.exclude, []);
    // 任务清单随提交响应直接带出：落库后的实时全量 job 列表
    assert.ok(Array.isArray(result.__taskList));
    assert.equal(result.__taskList.length, 1);
    assert.equal(result.__taskList[0].jobId, result.job_id);
    // 创建后立即快照：queued（调度器异步拉起 worker，可能已到 awaiting_approval 门）
    assert.ok(
      ["queued", "awaiting_approval", "running"].includes(result.__taskList[0].status),
      `任务初始状态应为 queued 或门状态，实际 ${result.__taskList[0].status}`,
    );
    // 渲染层把任务清单表格直接输出到当前会话（无需再单独调用 cbx_list）
    const blocks = definition.output.render({ workspace: ws }, result);
    const text = blocks.map((block) => block.text).join("\n");
    assert.match(text, /任务清单/);
    assert.match(text, /1 个 cbx job:/);
    assert.equal(text.includes(result.job_id), true);
  } finally {
    if (previousOmp === undefined) delete process.env.CBX_OMP;
    else process.env.CBX_OMP = previousOmp;
    resetExecutorProbeCache();
    await rm(fakeExecDir, { recursive: true, force: true });
    // 停掉 cbx_run 入队拉起的常驻调度器（30s 定时器 + 可能的重试循环），
    // 否则它会持有 SQLite 连接并持续跑，拖住全量测试进程（偶发 300s 超时根因）。
    try {
      await stopScheduler(ws);
    } catch {
      /* 调度器未启动或已停止 */
    }
    // Windows 瞬态句柄：createJob/入队路径可能在 closeDatabaseConnections 返回后才
    // 重开连接 → rm 撞 EBUSY。与 git-ops/storage 的 EBUSY 重试模式一致：退避重试并每轮重关连接。
    for (let attempt = 0; ; attempt += 1) {
      await closeDatabaseConnections();
      try {
        await rm(ws, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});
