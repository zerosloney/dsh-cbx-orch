import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebServer } from "@deepseek-ai/dsh-host-webserver";
import {
  buildTimeline,
  parseCursors,
  readExecutorStatus,
  replayEvents,
  startEventTailer,
  summarizeWorkspace,
} from "./ui.js";
import { readAgentLogIncremental } from "./log-tail.js";
import {
  approveJob,
  cancelJob,
  createJob,
  forgetJobKeepWorktree,
  health,
  listArtifacts,
  listJobs,
  listJobsWithAudit,
  listQueue,
  loadConfig,
  loadState,
  mergeConfig,
  pauseQueue,
  purgeJob,
  readArtifact,
  resumeQueue,
  retryQueueJob,
  startBackground,
} from "./core.js";
import { isCbxError } from "./errors.js";
import { deriveRequirements, noExecutorError, routeExecutor, type ExecutorStrategy } from "./executor-router.js";
import { buildTierCatalog } from "./executor-catalog.js";
import {
  abortIdempotentCreate,
  beginIdempotentCreate,
  commitIdempotentCreate,
  hashIdempotentRequest,
} from "./idempotency.js";
import { loadHealth } from "./executor-health.js";
import {
  HttpError,
  parseNumberField,
  readJsonBody,
} from "./http-util.js";
import { WorkspacePolicy } from "./workspace-policy.js";

/** Mount point for the cbx dashboard on the harness web server. */
export const CBX_MOUNT = "/cbx";

interface SseClient {
  res: ServerResponse;
  pending: string[];
  replaying: boolean;
  /** 背压累计：write 返回 false 期间新增的待冲刷字节估计，drain/成功写后归零。 */
  bufferedBytes: number;
}

/** SSE 连接数上限：每个都是常驻 tailer 广播的订阅者 + 全量回放读，无上限即内存 DoS 面。 */
const MAX_SSE_CLIENTS = 16;
/** 单客户端背压上限：慢客户端不读时 Node socket 写队列无界增长，超限直接断开该客户端。 */
const MAX_SSE_BUFFERED_BYTES = 1024 * 1024;

function resolveUiDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ui");
}

function json(res: ServerResponse, value: unknown, status = 200): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(body);
}

function text(res: ServerResponse, value: string, type: string): void {
  res.writeHead(200, {
    "content-type": type,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(value);
}

function errorStatus(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return 404;
  if (code === "EBIG") return 413;
  if (isCbxError(error, "E_NOT_FOUND")) return 404;
  if (isCbxError(error, "E_ARTIFACT_FORBIDDEN")) return 403;
  if (isCbxError(error, "E_INVALID_STATE")) return 409;
  if (
    isCbxError(error, "E_INVALID_JOB_ID") ||
    isCbxError(error, "E_INVALID_WORKSPACE") ||
    isCbxError(error, "E_INVALID_TEST_COMMAND") ||
    isCbxError(error, "E_INVALID_PERMISSION_MODE")
  )
    return 400;
  return 500;
}

/**
 * Register the cbx dashboard (HTML + REST + SSE) under {@link CBX_MOUNT} on the
 * harness web server. Workspaces are canonicalized by the shared policy; the
 * workspace query override must exactly select one of them.
 */
export async function registerCbxWebRoutes(ctx: Context, options: {
  webServer?: Context["webServer"];
  workspacePolicy?: WorkspacePolicy;
  workspaces?: readonly string[];
  isDisposed?: () => boolean;
}): Promise<void> {
  const workspacePolicy = options.workspacePolicy
    ?? new WorkspacePolicy(options.workspaces ?? []);
  // The policy performs realpath canonicalization, exact-match authorization,
  // and deduplication before any tailer or route is started.
  const workspaces = [...await workspacePolicy.listAllowedWorkspaces()];
  if (options.isDisposed?.()) return;
  const clients = new Set<SseClient>();

  const broadcast = (wsIndex: number, event: Record<string, unknown>): void => {
    const seq = typeof event.seq === "number" ? event.seq : undefined;
    const idLine = seq !== undefined ? `id: ${wsIndex}:${seq}\n` : "";
    const message = `${idLine}data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      if (client.replaying) client.pending.push(message);
      else writeSse(client, message);
    }
  };

  /** 带背压的 SSE 写：write 返回 false 说明内核缓冲已满，累计待冲刷字节；
   *  超过上限判定为死/慢客户端，断开并移除，防止无界内存增长。 */
  const writeSse = (client: SseClient, message: string): void => {
    try {
      if (client.res.write(message)) {
        client.bufferedBytes = 0;
        return;
      }
      client.bufferedBytes += Buffer.byteLength(message);
      if (client.bufferedBytes > MAX_SSE_BUFFERED_BYTES) {
        clients.delete(client);
        client.res.destroy();
        return;
      }
      client.res.once("drain", () => {
        client.bufferedBytes = 0;
      });
    } catch {
      // 写失败 = socket 已断（close 未触发的异常断连），从集合移除避免泄漏。
      clients.delete(client);
    }
  };

  const closeSseClients = (): void => {
    for (const client of clients) {
      clients.delete(client);
      try {
        client.res.destroy();
      } catch {
        /* socket already closed */
      }
    }
  };

  const stopTailers: Array<() => void> = [];
  workspaces.forEach((ws, wsIndex) => {
    const guard = async (): Promise<void> => {
      const current = await workspacePolicy.resolveWorkspace(ws);
      if (current !== ws) throw new Error("工作区身份已变化：路由重定向目标不再指向授权工作区。");
    };
    stopTailers.push(startEventTailer(ws, (event) =>
      broadcast(wsIndex, { ...event, workspace: ws }), {
        guard,
        onGuardFailure: () => {
          // Aggregate SSE subscriptions receive every workspace, so a single
          // invalid identity invalidates all existing clients.
          closeSseClients();
          ctx.logger("cbx").warn(
            "cbx web event tailer stopped after workspace identity validation failed",
          );
        },
      }));
  });

  const resolveWorkspace = async (url: URL): Promise<string> => {
    const requested = url.searchParams.get("workspace");
    if (requested !== null) {
      if (!requested) throw new HttpError(400, "workspace 参数必须是非空路径。");
      // Invalid, missing, non-directory, and unauthorized paths all surface as
      // E_INVALID_WORKSPACE and are mapped to a client error by errorStatus.
      return workspacePolicy.resolveWorkspace(requested);
    }
    // Re-resolve the cached first entry on every default request. This keeps a
    // renamed workspace from silently following a newly installed symlink or
    // junction to an unauthorized directory.
    if (!workspaces[0]) throw new HttpError(400, "没有可用的授权工作区。");
    return workspacePolicy.resolveWorkspace(workspaces[0]);
  };

  const resolveAggregateWorkspaces = async (): Promise<readonly string[]> => {
    // Aggregate endpoints retain their multi-workspace behavior, but each
    // cached path must still be re-canonicalized before it is read.
    return Promise.all(workspaces.map((workspace) =>
      workspacePolicy.resolveWorkspace(workspace)));
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.method !== "GET" && req.method !== "POST") {
        json(res, { error: "method not allowed" }, 405);
        return;
      }
      const base = `http://${req.headers.host ?? "localhost"}`;
      let url: URL;
      try {
        url = new URL(req.url ?? "/", base);
      } catch {
        json(res, { error: "无效的请求路径。" }, 400);
        return;
      }
      // 仪表盘以相对路径引用资源与 API：页面必须停在带尾斜杠的 /cbx/ 上，
      // 否则浏览器会把 "api/jobs" 解析到根路径。无尾斜杠访问一律重定向。
      if (url.pathname === CBX_MOUNT) {
        res.writeHead(301, {
          location: `${CBX_MOUNT}/${url.search}`,
          "cache-control": "no-store",
        });
        res.end();
        return;
      }
      const pathname = url.pathname.startsWith(`${CBX_MOUNT}/`)
        ? url.pathname.slice(CBX_MOUNT.length)
        : url.pathname;
      if (pathname === "/") {
        const uiDir = resolveUiDir();
        const html = await readFile(path.join(uiDir, "index.html"), "utf8");
        // 仪表盘不含内联脚本，全走同源静态文件与 API：default-src 'self' 足够，
        // 同时给未来可能的注入一个硬边界（也阻止被 iframe 嵌套的点击劫持面）。
        // style-src 'unsafe-inline'：app.js 动态设置的内联 style（分布条分段宽度/
        // 颜色、进度条、状态圆点）依赖它——无此指令现代浏览器会丢弃全部内联样式，
        // 仪表盘部分渲染失效。
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
        });
        res.end(html);
        return;
      }
      if (pathname === "/style.css") {
        text(res, await readFile(path.join(resolveUiDir(), "style.css"), "utf8"), "text/css; charset=utf-8");
        return;
      }
      if (pathname === "/app.js") {
        text(res, await readFile(path.join(resolveUiDir(), "app.js"), "utf8"), "application/javascript; charset=utf-8");
        return;
      }
      if (pathname === "/events") {
        if (url.searchParams.has("workspace")) {
          json(res, { error: "聚合 events 端点不接受 workspace 参数。" }, 400);
          return;
        }
        const currentWorkspaces = await resolveAggregateWorkspaces();
        if (clients.size >= MAX_SSE_CLIENTS) {
          json(res, { error: "SSE 连接数已达上限，请关闭其他面板后重试。" }, 503);
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const lastEventIdHeader = req.headers["last-event-id"];
        const lastEventIdRaw = (Array.isArray(lastEventIdHeader)
          ? lastEventIdHeader[0]
          : lastEventIdHeader) ?? url.searchParams.get("last_event_id") ?? undefined;
        const cursors = parseCursors(lastEventIdRaw, currentWorkspaces.length);
        const client: SseClient = {
          res,
          pending: [],
          replaying: lastEventIdRaw !== undefined,
          bufferedBytes: 0,
        };
        clients.add(client);
        for (let wsIndex = 0; wsIndex < currentWorkspaces.length; wsIndex += 1) {
          try {
            await replayEvents(currentWorkspaces[wsIndex], client, wsIndex, cursors[wsIndex]);
          } catch {
            /* 客户端在回放期间断开 */
          }
        }
        client.replaying = false;
        for (const msg of client.pending) {
          writeSse(client, msg);
          if (!clients.has(client)) break;
        }
        client.pending = [];
        writeSse(client, `data: ${JSON.stringify({
          at: new Date().toISOString(),
          type: "connected",
          workspaces: currentWorkspaces,
        })}\n\n`);
        req.on("close", () => clients.delete(client));
        return;
      }
      if (pathname === "/api/workspaces") {
        if (url.searchParams.has("workspace")) {
          json(res, { error: "聚合 workspaces 端点不接受 workspace 参数。" }, 400);
          return;
        }
        const currentWorkspaces = await resolveAggregateWorkspaces();
        const summaries = await Promise.all(currentWorkspaces.map((ws) =>
          summarizeWorkspace(ws).catch((error) => ({
            path: ws,
            name: path.basename(ws) || ws,
            error: error instanceof Error ? error.message : String(error),
          }))));
        json(res, { workspaces: summaries, default: currentWorkspaces[0] });
        return;
      }
      const ws = await resolveWorkspace(url);
      if (pathname === "/api/jobs" && req.method === "GET") {
        // 富化审计完整性（终态 job 附 __audit），供仪表盘展示篡改检测状态。
        json(res, await listJobsWithAudit(ws));
        return;
      }
      if (pathname === "/api/queue") {
        json(res, await listQueue(ws));
        return;
      }
      if (pathname === "/healthz") {
        // 公开端点不触发 prune（全表扫描 + 目录删除，可被当 DoS 放大器）；仅读指标。
        json(res, await health(ws, { prune: false }));
        return;
      }
      if (pathname === "/api/metrics") {
        // 指标端点只读：prune（全表扫描+删目录）由任务终态路径的 pruneAfterTerminal
        // 承担，健康探针不应带删除副作用。
        json(res, await health(ws, { prune: false }));
        return;
      }
      const job = /^\/api\/jobs\/([^/]+)$/.exec(pathname);
      if (job) {
        json(res, await loadState(ws, job[1]));
        return;
      }
      const artifacts = /^\/api\/jobs\/([^/]+)\/artifacts$/.exec(pathname);
      if (artifacts) {
        json(res, await listArtifacts(ws, artifacts[1]));
        return;
      }
      const artifact = /^\/api\/jobs\/([^/]+)\/artifact\/([^/]+)$/.exec(pathname);
      if (artifact) {
        text(res, await readArtifact(ws, artifact[1], artifact[2]), "text/plain; charset=utf-8");
        return;
      }
      const timeline = /^\/api\/jobs\/([^/]+)\/timeline$/.exec(pathname);
      if (timeline) {
        json(res, await buildTimeline(ws, timeline[1]));
        return;
      }
      const executor = /^\/api\/jobs\/([^/]+)\/executor$/.exec(pathname);
      if (executor) {
        json(res, await readExecutorStatus(ws, executor[1]));
        return;
      }
      const agentLog = /^\/api\/jobs\/([^/]+)\/agent\.log$/.exec(pathname);
      if (agentLog) {
        const since = Number(url.searchParams.get("since") ?? 0);
        text(res, JSON.stringify(await readAgentLogIncremental(ws, agentLog[1], since)), "application/json; charset=utf-8");
        return;
      }
      if (req.method === "POST") {
        if (pathname === "/api/jobs") {
          const body = await readJsonBody(req);
          if (typeof body.task !== "string" || !body.task.trim()) {
            json(res, { error: "task 必须是非空字符串。" }, 400);
            return;
          }
          const config = await loadConfig(ws);
          const defaults = mergeConfig(config, {
            testCommand: typeof body.test_command === "string" ? body.test_command : undefined,
            review: typeof body.review === "boolean" ? body.review : undefined,
            isolated: typeof body.isolated === "boolean" ? body.isolated : undefined,
            timeoutMs: parseNumberField(body, "timeout_ms"),
            maxRetries: parseNumberField(body, "max_retries"),
            maxTurns: parseNumberField(body, "max_turns"),
            permissionMode: typeof body.permission_mode === "string" ? body.permission_mode : undefined,
            approvalBeforeRun: typeof body.approval_before_run === "boolean" ? body.approval_before_run : undefined,
            dependencyGuard: typeof body.dependency_guard === "boolean" ? body.dependency_guard : undefined,
            keepWorktree: typeof body.keep_worktree === "boolean" ? body.keep_worktree : undefined,
            executor: typeof body.executor === "string" ? body.executor : undefined,
            reviewExecutor: typeof body.review_executor === "string" ? body.review_executor : undefined,
            autoBranch: typeof body.auto_branch === "boolean" ? body.auto_branch : undefined,
            autoCommit: typeof body.auto_commit === "boolean" ? body.auto_commit : undefined,
            commitMessage: typeof body.commit_message === "string" ? body.commit_message : undefined,
          });
          // 先探测本机已安装的 agent CLI，再按需求过滤 + 策略打分选最合适的一个。
          const derived = deriveRequirements({
            permissionMode: typeof body.permission_mode === "string" ? body.permission_mode : undefined,
          });
          const requirements = {
            ...derived,
            ...(config.executorRequirements ?? {}),
            ...((body.executor_requirements && typeof body.executor_requirements === "object")
              ? body.executor_requirements
              : {}),
          };
          const strategy = (body.routing_strategy ?? config.routingStrategy ?? "first-available") as ExecutorStrategy;
          // 档位目录：实测校准 + executorTiers 覆盖；未知名告警进响应（HTTP 入口无 bridgeLog）。
          const { catalog: tierCatalog, warnings: tierWarnings } =
            buildTierCatalog(loadHealth(ws), config.executorTiers);
          const decision = routeExecutor(defaults.executor, {
            preference: config.executorPreference,
            requirements,
            strategy,
            health: loadHealth(ws),
            tierCatalog,
          });
          if (!decision.executor) {
            const error = noExecutorError(decision.available);
            json(res, { error: error.message, ...(tierWarnings.length ? { tierWarnings } : {}) }, 400);
            return;
          }
          if (tierWarnings.length > 0 && decision.routed) {
            console.error(`[cbx] 档位目录：${tierWarnings.join("；")}`);
          }
          // 幂等键（可选，与 cbx_run 工具同语义）：预留→创建→提交；失败释放。
          const idempotencyKey =
            typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : undefined;
          if (body.idempotency_key !== undefined && !idempotencyKey) {
            json(res, { error: "idempotency_key 提供时必须是非空字符串。" }, 400);
            return;
          }
          const jobOptions = {
            workspace: ws,
            task: body.task,
            contextSnapshot: typeof body.context_snapshot === "string" ? body.context_snapshot : undefined,
            testCommand: defaults.testCommand,
            review: defaults.review,
            isolated: defaults.isolated,
            permissionMode: defaults.permissionMode,
            maxTurns: defaults.maxTurns,
            timeoutMs: defaults.timeoutMs,
            maxRetries: defaults.maxRetries,
            keepWorktree: defaults.keepWorktree,
            reviewRules: config.reviewRules,
            approvalBeforeRun: defaults.approvalBeforeRun,
            autoBranch: defaults.autoBranch,
            autoCommit: defaults.autoCommit,
            commitMessage: defaults.commitMessage,
            executor: decision.executor,
            reviewExecutor: defaults.reviewExecutor,
            carryDirty:
              typeof body.carry_dirty === "boolean"
                ? body.carry_dirty
                : config.carryDirty,
            adaptive: defaults.adaptive,
            trustMode: defaults.trustMode,
            dependencyGuard: defaults.dependencyGuard,
            allowUnsafePermissions: body.allow_unsafe_permissions === true,
            cost: body.max_executor_invocations === undefined
              ? undefined
              : { maxExecutorInvocations: parseNumberField(body, "max_executor_invocations", { integer: true, min: 1, max: 1_000_000 })! },
          };
          if (idempotencyKey) {
            const outcome = await beginIdempotentCreate(
              ws,
              idempotencyKey,
              hashIdempotentRequest(jobOptions),
            );
            if (outcome.kind === "conflict" || outcome.kind === "in-flight") {
              json(
                res,
                {
                  error:
                    outcome.kind === "conflict"
                      ? `幂等键 "${idempotencyKey}" 已用于不同的创建请求（${outcome.createdAt}）。请换键或省略。`
                      : `幂等键 "${idempotencyKey}" 的同名创建正在进行中（${outcome.createdAt}）。`,
                },
                409,
              );
              return;
            }
            if (outcome.kind === "duplicate") {
              json(res, {
                job_id: outcome.jobId,
                status: outcome.status ?? "unknown",
                deduplicated: true,
              });
              return;
            }
          }
          let created;
          try {
            created = await createJob(jobOptions);
          } catch (error) {
            // 失败释放预留：不留毒键，同键重试可以真正重跑。abort 自身失败不能
            // 掩盖 createJob 的真实失败原因，记日志供排障。
            if (idempotencyKey) {
              try {
                await abortIdempotentCreate(ws, idempotencyKey);
              } catch (abortError) {
                ctx.logger("cbx").warn(
                  `cbx 幂等预留释放失败（${abortError instanceof Error ? abortError.message : String(abortError)}）——同键 ${idempotencyKey} 重试将按 in-flight 处理。`,
                );
              }
            }
            throw error;
          }
          if (idempotencyKey) await commitIdempotentCreate(ws, idempotencyKey, created.jobId);
          await startBackground(ws, created.jobId, "", parseNumberField(body, "priority") ?? 0);
          json(res, { job_id: created.jobId, status: "queued" }, 201);
          return;
        }
        if (pathname === "/api/queue/pause") {
          json(res, await pauseQueue(ws));
          return;
        }
        if (pathname === "/api/queue/resume") {
          json(res, await resumeQueue(ws));
          return;
        }
        const jobAction = /^\/api\/jobs\/([^/]+)\/(approve|cancel|retry|continue|forget|purge)$/.exec(pathname);
        if (jobAction) {
          const jobId = jobAction[1];
          const action = jobAction[2];
          if (action === "approve") {
            // before_run 审批通过即原子重入队（approval 内完成 + 立即 dispatch）。
            json(res, await approveJob(ws, jobId));
            return;
          }
          if (action === "cancel") {
            json(res, await cancelJob(ws, jobId));
            return;
          }
          if (action === "retry") {
            const body = await readJsonBody(req);
            json(res, await retryQueueJob(ws, jobId, parseNumberField(body, "priority") ?? 0));
            return;
          }
          if (action === "forget" || action === "purge") {
            const body: Record<string, unknown> = await readJsonBody(req).catch(() => ({}) as Record<string, unknown>);
            const reason = typeof body.reason === "string" && body.reason.trim()
              ? `web:${action} ${body.reason}`
              : `web:${action}`;
            const result = await (action === "forget"
              ? forgetJobKeepWorktree(ws, jobId, reason)
              : purgeJob(ws, jobId, reason));
            json(res, {
              job_id: result.jobId,
              status: result.status,
              deleted_directory: result.deletedDirectory,
              worktree_cleaned: result.worktreeCleaned,
              remaining_queue_entries: result.remainingQueueEntries,
              tombstoned_at: result.tombstonedAt,
            });
            return;
          }
          const body = await readJsonBody(req);
          const extraRounds = parseNumberField(body, "extra_rounds", { integer: true, min: 1, max: 100 }) ?? 0;
          await startBackground(
            ws,
            jobId,
            body.message === undefined ? "" : String(body.message),
            parseNumberField(body, "priority") ?? 0,
            body.context_snapshot === undefined ? undefined : String(body.context_snapshot),
            body.refresh_baseline === true,
            extraRounds,
          );
          json(res, { jobId, status: "queued" });
          return;
        }
      }
      json(res, { error: "not found" }, 404);
    } catch (error) {
      const status = errorStatus(error);
      const rawMessage = error instanceof Error ? error.message : String(error);
      if (status >= 500) {
        // 5xx 不回显原始错误：ENOENT/EPERM 等消息携带绝对路径与模块内部细节，
        // 对外只给通用文案，完整信息进插件日志。
        ctx.logger("cbx").warn(`cbx web 500: ${rawMessage}`);
        json(res, { error: "服务器内部错误，详见插件日志。" }, status);
      } else {
        json(res, { error: rawMessage }, status);
      }
    }
  };

  // SSE heartbeat keeps connections alive; per-request handlers own their
  // lifetime, so the route registers once and the interval dies with the process.
  const heartbeat = setInterval(() => {
    const message = `data: ${JSON.stringify({ at: new Date().toISOString(), type: "heartbeat" })}\n\n`;
    for (const client of clients) {
      if (client.replaying) client.pending.push(message);
      else writeSse(client, message);
    }
  }, 1500);
  heartbeat.unref();

  const disposeRoute = (options.webServer ?? ctx.webServer).register({
    kind: "prefix",
    path: CBX_MOUNT,
    handler: (req, res) => {
      void handler(req, res);
    },
  });
  ctx.effect(() => () => {
    disposeRoute();
    clearInterval(heartbeat);
    for (const stop of stopTailers) stop();
  }, "cbx.web");
}
