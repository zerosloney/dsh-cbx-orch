import type { Context } from "@deepseek-ai/cordis";
import { existsSync } from "node:fs";
import path from "node:path";
import { startBackground, cancelJob } from "./lifecycle.js";
import { createJob } from "./jobs.js";
import { listQueue, pauseQueue, resumeQueue } from "./queue-api.js";
import { listJobs, readArtifact } from "./artifacts.js";
import { formatTaskList } from "./format.js";
import { loadConfig, loadState, mergeConfig } from "./state.js";
import { bridgeCbxJob } from "./jobs-bridge.js";
import { publishCbxFacade } from "./subagent-facade.js";
import { routeNote } from "./session-message.js";
import { deriveRequirements, noExecutorError, routeExecutor, type ExecutorStrategy, type RouteDecision } from "./executor-router.js";
import { resolveExecutor } from "./executors/builtin.js";
import { buildTierCatalog } from "./executor-catalog.js";
import { loadHealth } from "./executor-health.js";
import type { CbxDefaults, SessionCwdContext } from "./tools.js";
import type { CommandResult } from "@deepseek-ai/dsh-commands";
import { WorkspacePolicy } from "./workspace-policy.js";
import { CBX_MOUNT } from "./web.js";

/** Registration entry shared by the interactive command layer. */
interface CbxCommandContext {
  ctx: Context;
  defaults: CbxDefaults;
}

function ok(text?: string): CommandResult {
  return { kind: "success", ...(text === undefined ? {} : { text }) };
}

function err(text: string): CommandResult {
  return { kind: "error", text };
}

/**
 * 从 /cbx-run 输入解析显式执行器覆盖（斜杠命令没有工具那样的结构化 executor 参数）：
 * - `--executor <name>` / `--executor=<name>`：任意位置，解析后从任务文本剔除（也接受插件路径）；
 * - 前导 `@<name>` 简写：仅当命中内置执行器注册名/别名（resolveExecutor）才剥离，
 *   避免误伤以 @ 开头的普通任务文本。
 *
 * 返回 { executor, task }：task 为剔除覆盖后的剩余文本。这是"用户点名执行器"在
 * 命令层的自动识别——与 cbx_run 工具的 args.executor 语义对齐（覆盖 > 工作区
 * config > 插件默认）。
 */
export function extractExecutorOverride(raw: string): { executor?: string; task: string } {
  let task = raw.trim();
  let executor: string | undefined;
  const flag = /(^|\s)--executor[=\s]+([^\s]+)/.exec(task);
  if (flag) {
    executor = flag[2];
    task = task.replace(flag[0], " ").trim();
  }
  if (!executor) {
    const at = /^@([^\s]+)\s*/.exec(task);
    if (at && resolveExecutor(at[1])) {
      executor = at[1];
      task = task.slice(at[0].length);
    }
  }
  return { executor, task: task.trim() };
}

/**
 * 仪表盘入口的默认端口（headless/core-only profile 拿不到 webServer 服务时的回落值，
 * 与 README 中 dsh web GUI 的默认端口一致）。
 */
const DEFAULT_WEB_PORT = 3080;

/** 从 harness webServer 服务取实际监听端口；服务不在时回落默认端口。 */
function webBaseUrl(ctx: Context): string {
  let port = DEFAULT_WEB_PORT;
  try {
    const webServer = ctx.get("webServer") as { port?: number } | undefined;
    if (webServer && typeof webServer.port === "number" && webServer.port > 0)
      port = webServer.port;
  } catch {
    /* 无 webServer 服务（headless profile）：回落默认端口 */
  }
  return `http://127.0.0.1:${port}`;
}

/** cbx 仪表盘是否已挂载：cbx-orch-web 插件激活时 ctx.cbxWeb 服务在。 */
function webPluginActive(ctx: Context): boolean {
  try {
    return Boolean(ctx.get("cbxWeb"));
  } catch {
    return false;
  }
}

/**
 * 尝试在系统默认浏览器打开 URL（best-effort，fire-and-forget）。
 * Windows: `cmd /c start "" <url>`；macOS: `open`；Linux: `xdg-open`。
 * 无 subprocess 服务或 spawn 失败都静默跳过，调用方回落到"给出链接"。
 */
function tryOpenBrowser(ctx: Context, url: string): "opened" | "skipped" {
  try {
    const subprocess = ctx.get("subprocess") as
      | { spawn?: (spec: unknown) => { done?: Promise<unknown>; terminate?: () => void } }
      | undefined;
    if (!subprocess || typeof subprocess.spawn !== "function") return "skipped";
    const argv =
      process.platform === "win32"
        ? [process.env.ComSpec ?? "cmd.exe", "/d", "/c", "start", "", url]
        : process.platform === "darwin"
          ? ["open", url]
          : ["xdg-open", url];
    const handle = subprocess.spawn({
      argv,
      cwd: process.cwd(),
      stdio: { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
      graceMs: 2_000,
    });
    // 不阻塞命令：浏览器启动进程快速退出；失败也不影响命令结果（链接总能点）。
    void handle?.done?.catch(() => undefined);
    return "opened";
  } catch {
    return "skipped";
  }
}

export function registerCbxCommands(service: CbxCommandContext): void {
  const commands = service.ctx.commands;
  const defaults = service.defaults;
  const workspacePolicy = defaults.workspacePolicy ?? new WorkspacePolicy();
  // 默认工作区 = 当前 agent 会话的工作目录（目录委派时设定），回落 process.cwd()。
  // 可显式传 workspace（如 /cbx-web <path>），同样受白名单约束。
  const resolveWorkspace = (workspace: string | undefined, invocation?: SessionCwdContext): Promise<string> =>
    workspacePolicy.resolveWorkspace(
      workspace,
      invocation?.agent?.session?.header?.cwd,
    );

  commands.register({
    name: "cbx-run",
    description: "Delegate a task to the cbx orchestrator in the background (test + review), returning the job id. Prefix with @name or --executor <name> to pick the executor.",
    input: { hint: "[--executor <name>|@<name>] task to delegate" },
    async handler(invocation) {
      // 显式执行器覆盖（--executor / 前导 @name）> 工作区 config > 插件默认，
      // 与 cbx_run 工具的 args.executor ?? config.executor ?? defaults 对齐。
      const override = extractExecutorOverride(invocation.rawInput);
      const task = override.task;
      if (!task) return err("Usage: /cbx-run [--executor <codebuddy|opencode|omp|cline|qwen>] <task>");
      try {
        const ws = await resolveWorkspace(undefined, invocation);
        const config = await loadConfig(ws);
        const merged = mergeConfig(config, {
          review: defaults.review,
          isolated: defaults.isolated,
        });
        // 先探测本机已安装的 agent CLI，再按需求过滤 + 策略打分选最合适的一个。
        // 与 tools.ts 的 cbx_run 对齐：请求执行器 = 显式覆盖 ?? 工作区 config ?? 插件配置默认。
        // （不能用 merged.executor——它在 mergeConfig 里已被兜底为 config ?? "codebuddy"，
        //   会丢 defaults.executor 的插件路径/特定内建默认。）
        const { catalog: tierCatalog, warnings: tierWarnings } =
          buildTierCatalog(loadHealth(ws), config.executorTiers);
        for (const warning of tierWarnings) {
          console.error(`[cbx] 档位目录：${warning}`);
        }
        const decision: RouteDecision = routeExecutor(override.executor ?? config.executor ?? defaults.executor, {
          preference: config.executorPreference,
          requirements: deriveRequirements({ permissionMode: merged.permissionMode }),
          strategy: config.routingStrategy ?? "first-available",
          health: loadHealth(ws),
          tierCatalog,
        });
        if (!decision.executor) throw noExecutorError(decision.available);
        const created = await createJob({
          workspace: ws,
          task,
          review: merged.review,
          isolated: merged.isolated,
          permissionMode: merged.permissionMode,
          maxTurns: merged.maxTurns,
          testCommand: merged.testCommand,
          timeoutMs: merged.timeoutMs,
          maxRetries: merged.maxRetries,
          keepWorktree: merged.keepWorktree,
          reviewRules: config.reviewRules,
          approvalBeforeRun: merged.approvalBeforeRun,
          autoBranch: merged.autoBranch,
          autoCommit: merged.autoCommit,
          commitMessage: merged.commitMessage,
          executor: decision.executor,
          reviewExecutor: merged.reviewExecutor,
          carryDirty: config.carryDirty ?? defaults.carryDirty,
          adaptive: merged.adaptive,
          trustMode: merged.trustMode,
          dependencyGuard: merged.dependencyGuard,
        });
        await startBackground(ws, created.jobId, "", 0);
        // 创建时的路由决策视图：桥首轮快照/终态摘要与前台子代理镜像首条消息
        // 据此显示「委派给了谁、为什么」——与 cbx_run 工具路径同款（tools.ts）。
        const routerView = {
          executor: decision.executor,
          routed: decision.routed,
          reason: decision.reason,
        };
        // 会话内可见：注册 harness 原生后台任务，让当前会话能看到执行进度与最终输出
        // （job_output / job_wait / job_kill；tool-jobs 完成通知会投递回会话）。
        // 桥失败时返回 reason，提示用户**为什么没接到前台**（修复"委派任务看不见"）。
        const bridge = bridgeCbxJob(service.ctx, {
          workspace: ws,
          jobId: created.jobId,
          task,
          agent: invocation.agent,
          logger: (message) => {
            try {
              service.ctx.logger("cbx")?.warn(message);
            } catch {
              /* logger 缺位不影响桥 */
            }
          },
          router: routerView,
        });
        // 前台子代理外观层：把委派发布为「任务管理」页子代理树（前台）的镜像会话。
        const facade = publishCbxFacade(service.ctx, {
          workspace: ws,
          jobId: created.jobId,
          task,
          agent: invocation.agent,
          executor: decision.executor,
          logger: (message) => {
            try {
              service.ctx.logger("cbx")?.warn(message);
            } catch {
              /* logger 缺位不影响外观层 */
            }
          },
          router: routerView,
        });
        const sessionHint = bridge.id !== undefined
          ? ` session job ${bridge.id}（会话内跟踪：job_output / job_kill）`
          : bridge.reason === "no-agent-context"
            ? "（未注册会话任务：命令调用场景正常）"
            : `（未注册会话任务：${bridge.reason}${bridge.detail ? ` ${bridge.detail}` : ""}）`;
        const facadeHint = facade.sessionId !== undefined
          ? ` 前台子代理 ${facade.sessionId}（任务管理页子代理树可见，可点击实时查看）`
          : facade.reason === "no-agent-context"
            ? ""
            : `（未在前台子代理区显示：${facade.reason}${facade.detail ? ` ${facade.detail}` : ""}）`;
        // 任务清单直接显示在当前会话：回复附上全量 job 表格，不用再单独调 /cbx-list。
        const taskList = await formatTaskList(await listJobs(ws));
        // 路由决策一行摘要（与 jobs-bridge 首轮快照同款文案）：
        // 自动路由/回退显示「已自动路由」，显式指定（含 @name/--executor 与工作区
        // config 命中已装执行器）显示「已委派给」。
        const routedNote = decision.routed
          ? ` ${routeNote(decision)}`
          : ` 已委派给执行器 ${decision.executor}`;
        return ok(
          `job ${created.jobId} queued.${routedNote} Use /cbx-status ${created.jobId} to track it.${sessionHint}${facadeHint}\n仪表盘：/cbx/?workspace=${encodeURIComponent(ws)}\n\n任务清单:\n${taskList}`,
        );
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  });

  commands.register({
    name: "cbx-status",
    description: "Show the current state and stage of one cbx job.",
    input: { hint: "job id" },
    async handler(invocation) {
      const jobId = invocation.rawInput.trim();
      if (!jobId) return err("Usage: /cbx-status <job_id>");
      try {
        const state = await loadState(await resolveWorkspace(undefined, invocation), jobId);
        return ok(`[${jobId}] ${state.status}${state.phase ? ` / ${state.phase}` : ""}${state.stage ? ` / stage ${state.stage}` : ""}${state.attempt !== undefined ? ` (attempt ${state.attempt})` : ""}`);
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  });

  commands.register({
    name: "cbx-continue",
    description: "Re-enqueue a job stuck in needs_fix/review_failed with follow-up instructions.",
    input: { hint: "job_id [message]" },
    async handler(invocation) {
      const [jobId, ...rest] = invocation.rawInput.trim().split(/\s+/);
      if (!jobId) return err("Usage: /cbx-continue <job_id> [message]");
      const message = rest.join(" ");
      try {
        const ws = await resolveWorkspace(undefined, invocation);
        await startBackground(ws, jobId, message, 0);
        const bridge = bridgeCbxJob(service.ctx, {
          workspace: ws,
          jobId,
          task: message || "continue",
          agent: invocation.agent,
          logger: (msg) => {
            try {
              service.ctx.logger("cbx")?.warn(msg);
            } catch {
              /* logger 缺位不影响桥 */
            }
          },
        });
        // 续跑场景：复用/刷新前台子代理镜像（同 job 已有存活外观会话时复用）。
        const facade = publishCbxFacade(service.ctx, {
          workspace: ws,
          jobId,
          task: message || "continue",
          agent: invocation.agent,
          logger: (msg) => {
            try {
              service.ctx.logger("cbx")?.warn(msg);
            } catch {
              /* logger 缺位不影响外观层 */
            }
          },
        });
        const sessionHint = bridge.id !== undefined
          ? ` session job ${bridge.id}（会话内跟踪：job_output / job_kill）`
          : bridge.reason === "no-agent-context"
            ? "（未注册会话任务：命令调用场景正常）"
            : `（未注册会话任务：${bridge.reason}${bridge.detail ? ` ${bridge.detail}` : ""}）`;
        const facadeHint = facade.sessionId !== undefined
          ? ` 前台子代理 ${facade.sessionId}（任务管理页子代理树可见，可点击实时查看）`
          : facade.reason === "no-agent-context"
            ? ""
            : `（未在前台子代理区显示：${facade.reason}${facade.detail ? ` ${facade.detail}` : ""}）`;
        const taskList = await formatTaskList(await listJobs(ws));
        return ok(`job ${jobId} re-queued for continuation.${sessionHint}${facadeHint}\n仪表盘：/cbx/?workspace=${encodeURIComponent(ws)}\n\n任务清单:\n${taskList}`);
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  });

  commands.register({
    name: "cbx-cancel",
    description: "Cancel a running or queued cbx job.",
    input: { hint: "job id" },
    async handler(invocation) {
      const jobId = invocation.rawInput.trim();
      if (!jobId) return err("Usage: /cbx-cancel <job_id>");
      try {
        const state = await cancelJob(await resolveWorkspace(undefined, invocation), jobId);
        return ok(`[${jobId}] ${state.status}`);
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  });

  commands.register({
    name: "cbx-list",
    description: "List cbx jobs in the current workspace.",
    async handler(invocation) {
      try {
        const jobs = await listJobs(await resolveWorkspace(undefined, invocation));
        if (jobs.length === 0) return ok("no cbx jobs in this workspace.");
        const lines = jobs.map((job) =>
          `[${job.jobId}] ${job.status}${job.phase ? ` / ${job.phase}` : ""}${job.createdAt ? ` created ${job.createdAt}` : ""}`,
        );
        return ok(lines.join("\n"));
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  });

  commands.register({
    name: "cbx-queue",
    description: "Inspect the cbx queue, or pause/resume it.",
    input: { hint: "pause | resume" },
    async handler(invocation) {
      const action = invocation.rawInput.trim();
      try {
        const ws = await resolveWorkspace(undefined, invocation);
        if (action === "pause") return ok(JSON.stringify(await pauseQueue(ws)));
        if (action === "resume") return ok(JSON.stringify(await resumeQueue(ws)));
        if (action === "") return ok(JSON.stringify(await listQueue(ws)));
        // 拼写错误不再静默降级为"查看队列"，显式报错避免误导。
        return err(`未知操作：${action}（支持 pause / resume，空参数查看队列）。`);
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  });

  commands.register({
    name: "cbx-result",
    description: "Read a cbx job's result.json.",
    input: { hint: "job id" },
    async handler(invocation) {
      const jobId = invocation.rawInput.trim();
      if (!jobId) return err("Usage: /cbx-result <job_id>");
      try {
        return ok(await readArtifact(await resolveWorkspace(undefined, invocation), jobId, "result.json"));
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  });

  commands.register({
    name: "cbx-web",
    description: "开启 cbx 仪表盘（Web 界面）：解析工作区、给出仪表盘链接，并尝试在系统默认浏览器打开。",
    input: { hint: "[workspace]" },
    async handler(invocation) {
      try {
        const workspaceArg = invocation.rawInput.trim() || undefined;
        const ws = await resolveWorkspace(workspaceArg, invocation);
        const base = webBaseUrl(service.ctx);
        const url = `${base}${CBX_MOUNT}/?workspace=${encodeURIComponent(ws)}`;
        const webActive = webPluginActive(service.ctx);
        const launch = tryOpenBrowser(service.ctx, url);
        const lines: string[] = [];
        lines.push(`cbx 仪表盘（工作区：${ws}）`);
        lines.push(`地址：${url}`);
        lines.push(`打开： [cbx 仪表盘](${url})`);
        if (launch === "opened") {
          lines.push("已在系统默认浏览器尝试打开；若未弹出请点击上方链接。");
        } else {
          lines.push("未自动打开浏览器（无 subprocess 服务或当前受限）；请手动访问上面的链接。");
        }
        if (!webActive) {
          lines.push(
            "提示：当前 profile 未加载 cbx-orch-web 插件（headless profile），/cbx 路由尚未挂载；请用含 web 插件的配置（如 dsh --profile web）启动后访问。",
          );
        } else {
          const tokenFile = path.join(ws, ".cbx", "web.token");
          lines.push(
            `提示：首次访问需输入 Web token（${existsSync(tokenFile) ? `见 ${tokenFile}` : "需在配置中设置 web.token"}）。`,
          );
        }
        return ok(lines.join("\n"));
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  });
}
