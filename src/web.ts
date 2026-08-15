import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebServer } from "@deepseek-ai/dsh-host-webserver";
import {
  buildTimeline,
  isAuthorized,
  parseCursors,
  readAgentLogIncremental,
  readExecutorStatus,
  replayEvents,
  startEventTailer,
  summarizeWorkspace,
} from "./ui.js";
import {
  approveJob,
  cancelJob,
  createJob,
  forgetJobKeepWorktree,
  health,
  listArtifacts,
  listJobs,
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

/** Mount point for the cbx dashboard on the harness web server. */
export const CBX_MOUNT = "/cbx";

interface SseClient {
  res: ServerResponse;
  pending: string[];
  replaying: boolean;
}

function resolveUiDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ui");
}

function json(res: ServerResponse, value: unknown, status = 200): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function text(res: ServerResponse, value: string, type: string): void {
  res.writeHead(200, { "content-type": type });
  res.end(value);
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function errorStatus(error: unknown): number {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return 404;
  if (code === "EBIG") return 413;
  if (isCbxError(error, "E_NOT_FOUND")) return 404;
  if (isCbxError(error, "E_ARTIFACT_FORBIDDEN")) return 403;
  if (isCbxError(error, "E_INVALID_JOB_ID")) return 400;
  return 500;
}

/**
 * Register the cbx dashboard (HTML + REST + SSE) under {@link CBX_MOUNT} on the
 * harness web server. Workspaces default to the invoking directory; the
 * plugin config's `web.workspaces` allowlist plus `?workspace=` override picks
 * among them.
 */
export function registerCbxWebRoutes(ctx: Context, options: {
  workspaces?: string[];
  token?: string;
}): void {
  const workspaces = [...(options.workspaces && options.workspaces.length > 0
    ? options.workspaces
    : [process.cwd()])];
  const token = options.token;
  const clients = new Set<SseClient>();

  const broadcast = (wsIndex: number, event: Record<string, unknown>): void => {
    const seq = typeof event.seq === "number" ? event.seq : undefined;
    const idLine = seq !== undefined ? `id: ${wsIndex}:${seq}\n` : "";
    const message = `${idLine}data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      if (client.replaying) client.pending.push(message);
      else {
        try {
          client.res.write(message);
        } catch {
          /* client disconnected */
        }
      }
    }
  };

  const stopTailers: Array<() => void> = [];
  workspaces.forEach((ws, wsIndex) => {
    stopTailers.push(startEventTailer(ws, (event) =>
      broadcast(wsIndex, { ...event, workspace: ws })));
  });

  const resolveWorkspace = (url: URL): string => {
    const requested = url.searchParams.get("workspace");
    if (requested) {
      const resolved = path.resolve(decodeURIComponent(requested));
      if (workspaces.includes(resolved)) return resolved;
    }
    return workspaces[0] ?? process.cwd();
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.method !== "GET" && req.method !== "POST") {
        json(res, { error: "method not allowed" }, 405);
        return;
      }
      const base = `http://${req.headers.host ?? "localhost"}`;
      const url = new URL(req.url ?? "/", base);
      const pathname = url.pathname === CBX_MOUNT
        ? "/"
        : url.pathname.startsWith(`${CBX_MOUNT}/`)
          ? url.pathname.slice(CBX_MOUNT.length)
          : url.pathname;

      // Public shell + healthz stay open; data endpoints require the token.
      const publicPath = pathname === "/" || pathname === "/healthz"
        || pathname === "/style.css" || pathname === "/app.js";
      if (!publicPath && !isAuthorized(req, url, token, pathname === "/events")) {
        res.writeHead(401, {
          "www-authenticate": "Bearer",
          "content-type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      if (pathname === "/") {
        const uiDir = resolveUiDir();
        const html = await readFile(path.join(uiDir, "index.html"), "utf8");
        if (token) {
          res.setHeader("set-cookie",
            `cbx_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=${CBX_MOUNT}`);
        }
        text(res, html, "text/html; charset=utf-8");
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
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const lastEventIdHeader = req.headers["last-event-id"];
        const lastEventIdRaw = (Array.isArray(lastEventIdHeader)
          ? lastEventIdHeader[0]
          : lastEventIdHeader) ?? url.searchParams.get("last_event_id") ?? undefined;
        const cursors = parseCursors(lastEventIdRaw, workspaces.length);
        const client: SseClient = {
          res,
          pending: [],
          replaying: lastEventIdRaw !== undefined,
        };
        clients.add(client);
        for (let wsIndex = 0; wsIndex < workspaces.length; wsIndex += 1) {
          await replayEvents(workspaces[wsIndex], client, wsIndex, cursors[wsIndex]);
        }
        client.replaying = false;
        for (const msg of client.pending) {
          try {
            res.write(msg);
          } catch {
            /* client disconnected */
          }
        }
        client.pending = [];
        res.write(`data: ${JSON.stringify({
          at: new Date().toISOString(),
          type: "connected",
          workspaces,
        })}\n\n`);
        req.on("close", () => clients.delete(client));
        return;
      }
      if (pathname === "/api/workspaces") {
        const summaries = await Promise.all(workspaces.map((ws) =>
          summarizeWorkspace(ws).catch((error) => ({
            path: ws,
            name: path.basename(ws) || ws,
            error: error instanceof Error ? error.message : String(error),
          }))));
        json(res, { workspaces: summaries, default: workspaces[0] });
        return;
      }
      const ws = resolveWorkspace(url);
      if (pathname === "/api/jobs" && req.method === "GET") {
        json(res, await listJobs(ws));
        return;
      }
      if (pathname === "/api/queue") {
        json(res, await listQueue(ws));
        return;
      }
      if (pathname === "/healthz" || pathname === "/api/metrics") {
        json(res, await health(ws));
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
            timeoutMs: body.timeout_ms === undefined ? undefined : Number(body.timeout_ms),
            maxRetries: body.max_retries === undefined ? undefined : Number(body.max_retries),
            maxTurns: body.max_turns === undefined ? undefined : Number(body.max_turns),
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
          const created = await createJob({
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
            executor: defaults.executor,
            reviewExecutor: defaults.reviewExecutor,
            adaptive: defaults.adaptive,
            trustMode: defaults.trustMode,
            dependencyGuard: defaults.dependencyGuard,
            allowUnsafePermissions: body.allow_unsafe_permissions === true,
          });
          await startBackground(ws, created.jobId, "", body.priority === undefined ? 0 : Number(body.priority));
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
            const state = await approveJob(ws, jobId);
            if (state.status === "queued") await startBackground(ws, jobId);
            json(res, state);
            return;
          }
          if (action === "cancel") {
            json(res, await cancelJob(ws, jobId));
            return;
          }
          if (action === "retry") {
            const body = await readJsonBody(req);
            json(res, await retryQueueJob(ws, jobId, body.priority === undefined ? 0 : Number(body.priority)));
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
          const extraRounds = body.extra_rounds === undefined ? 0 : Number(body.extra_rounds);
          if (body.extra_rounds !== undefined &&
            (!Number.isInteger(extraRounds) || extraRounds < 1 || extraRounds > 100)) {
            json(res, { error: "extra_rounds 必须是 1 到 100 的整数。" }, 400);
            return;
          }
          await startBackground(
            ws,
            jobId,
            body.message === undefined ? "" : String(body.message),
            body.priority === undefined ? 0 : Number(body.priority),
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
      const message = error instanceof Error ? error.message : String(error);
      json(res, { error: message }, errorStatus(error));
    }
  };

  // SSE heartbeat keeps connections alive; per-request handlers own their
  // lifetime, so the route registers once and the interval dies with the process.
  const heartbeat = setInterval(() => {
    const message = `data: ${JSON.stringify({ at: new Date().toISOString(), type: "heartbeat" })}\n\n`;
    for (const client of clients) {
      if (client.replaying) client.pending.push(message);
      else {
        try {
          client.res.write(message);
        } catch {
          /* client disconnected */
        }
      }
    }
  }, 1500);
  heartbeat.unref();

  const disposeRoute = ctx.webServer.register({
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
