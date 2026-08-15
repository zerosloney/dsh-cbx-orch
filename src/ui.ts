import {
  createServer,
  type Server,
  type ServerResponse,
  type IncomingMessage,
} from "node:http";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  approveJob,
  cancelJob,
  createJob,
  forgetJobKeepWorktree,
  health,
  jobDir,
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
import { captureAsync } from "./process-runner.js";
import { constantTimeEqual, processAlive } from "./storage.js";
import { isCbxError } from "./errors.js";

/** 校验 token; 未配置 token 时始终放行。常量时间比较避免时序侧信道。
 *  支持两种凭证：Authorization Bearer header（curl/API 客户端），
 *  或 `cbx_token` HttpOnly cookie（浏览器自动携带，JS 不可读，避免 token 暴露在页面源码/URL 查询串）。
 *  query token 仅对 `/events` 放行 (兼容无法设 header 的旧 EventSource 客户端)。 */
export function isAuthorized(
  req: IncomingMessage,
  url: URL,
  expectedToken: string | undefined,
  allowQueryToken = false,
): boolean {
  if (!expectedToken) return true;
  const auth = req.headers["authorization"];
  if (auth && auth.startsWith("Bearer "))
    return constantTimeEqual(auth.slice(7), expectedToken);
  // HttpOnly cookie：浏览器同源请求自动携带；值即 token 本身（loopback 场景下与 HTML 内嵌等价，但 JS/XSS 不可读）。
  const cookie = req.headers.cookie;
  if (cookie) {
    for (const part of cookie.split(";")) {
      const [name, value] = part.trim().split("=");
      if (name === "cbx_token" && value)
        return constantTimeEqual(decodeURIComponent(value), expectedToken);
    }
  }
  if (allowQueryToken) {
    const q = url.searchParams.get("token");
    if (q) return constantTimeEqual(q, expectedToken);
  }
  return false;
}

export interface WorkspaceSummary {
  path: string;
  name: string;
  jobsByStatus: Record<string, number>;
  queueDepth: number;
  paused: boolean;
  activeExecutors: number;
  lastActivityAt: string | null;
  gitBranch: string | null;
  gitDirty: boolean | null;
  /** 汇总失败时由调用方填充（单 ws 失败不拖垮整体跨 ws 汇总）。 */
  error?: string;
}

export async function summarizeWorkspace(
  workspace: string,
): Promise<WorkspaceSummary> {
  const [jobs, queue] = await Promise.all([
    listJobs(workspace),
    listQueue(workspace),
  ]);
  const jobsByStatus: Record<string, number> = {};
  let activeExecutors = 0;
  let lastActivityAt: string | null = null;
  for (const job of jobs) {
    const status = String(job.status);
    jobsByStatus[status] = (jobsByStatus[status] ?? 0) + 1;
    if (status === "running") activeExecutors += 1;
    const updated = String(job.updatedAt ?? "");
    if (updated && (!lastActivityAt || updated > lastActivityAt))
      lastActivityAt = updated;
  }
  const queueDepth = (queue.entries ?? []).filter((entry) =>
    ["queued", "running", "awaiting_approval"].includes(String(entry.status)),
  ).length;
  let gitBranch: string | null = null;
  let gitDirty: boolean | null = null;
  try {
    // 异步 git：Web UI 服务进程内跑，避免 git status 阻塞 SSE 心跳与其他客户端（git-ops 的同步版保留给 worker 进程）。
    const [branch, statusResult] = await Promise.all([
      captureAsync(["git", "branch", "--show-current"], workspace),
      captureAsync(["git", "status", "--porcelain"], workspace),
    ]);
    if (branch.code === 0) gitBranch = branch.stdout.trim() || null;
    if (statusResult.code === 0) gitDirty = Boolean(statusResult.stdout.trim());
  } catch {
    /* not a git repo, leave null */
  }
  return {
    path: workspace,
    name: path.basename(workspace) || workspace,
    jobsByStatus,
    queueDepth,
    paused: Boolean(queue.paused),
    activeExecutors,
    lastActivityAt,
    gitBranch,
    gitDirty,
  };
}

export interface TimelineStage {
  name: string;
  phase?: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
}
export interface JobTimeline {
  stages: TimelineStage[];
  currentStage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedSec: number;
}

const TERMINAL_STATUSES = new Set([
  "done",
  "failed",
  "review_failed",
  "cancelled",
]);

const PUBLIC_UI_PATHS = new Set(["/", "/style.css", "/app.js", "/healthz"]);

/**
 * 从 events.ndjson 推导阶段时间线。兼容两套事件:
 * - 新格式(0.10.2+):job.state_changed 事件携带 status 维度
 * - 老格式(<=0.10.1):stage_started / stage_finished 配对携带 stage 维度
 * 优先用新格式;若不存在则用老格式配对构造。
 */
export async function buildTimeline(
  workspace: string,
  jobId: string,
): Promise<JobTimeline> {
  const eventsFile = path.join(jobDir(workspace, jobId), "events.ndjson");
  let raw = "";
  try {
    raw = await readFile(eventsFile, "utf8");
  } catch {
    /* 任务还没产生事件 */
  }
  const stateChanges: Array<{ status: string; phase?: string; at: string }> =
    [];
  const stageStarts: Array<{
    stage: string;
    executor: string;
    index: number;
    at: string;
  }> = [];
  const stageEnds: Array<{
    stage: string;
    index: number;
    exitCode?: number;
    reviewVerdict?: string;
    at: string;
  }> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const at = String(event.at ?? "");
    if (
      event.event === "job.state_changed" &&
      typeof event.status === "string"
    ) {
      stateChanges.push({
        status: String(event.status),
        phase: typeof event.phase === "string" ? event.phase : undefined,
        at,
      });
    } else if (
      event.event === "stage_started" &&
      typeof event.stage === "string"
    ) {
      stageStarts.push({
        stage: String(event.stage),
        executor: String(event.executor ?? ""),
        index: Number(event.index ?? 0),
        at,
      });
    } else if (
      event.event === "stage_finished" &&
      typeof event.stage === "string"
    ) {
      stageEnds.push({
        stage: String(event.stage),
        index: Number(event.index ?? 0),
        exitCode:
          typeof event.exitCode === "number" ? event.exitCode : undefined,
        reviewVerdict:
          typeof event.reviewVerdict === "string"
            ? event.reviewVerdict
            : undefined,
        at,
      });
    }
  }
  // 优先用 state_changes(更新更详细);老格式 jobs 没有 state_change,用 stage_started/finished 配对
  let stages: TimelineStage[];
  let currentStage: string | null;
  let startedAt: string | null;
  let finishedAt: string | null;
  if (stateChanges.length) {
    stages = [];
    for (let i = 0; i < stateChanges.length; i += 1) {
      const cur = stateChanges[i];
      const next = stateChanges[i + 1];
      const end = next ? next.at : null;
      const durationMs =
        end && cur.at ? Date.parse(end) - Date.parse(cur.at) : null;
      stages.push({
        name: cur.status,
        phase: cur.phase,
        startedAt: cur.at,
        endedAt: end,
        durationMs,
      });
    }
    const last = stateChanges[stateChanges.length - 1];
    currentStage = last ? last.status : null;
    startedAt = stateChanges[0]?.at ?? null;
    finishedAt =
      currentStage && TERMINAL_STATUSES.has(currentStage)
        ? (last?.at ?? null)
        : null;
  } else {
    // 老格式配对:用 stage_started/finished 构造 timeline
    stages = stageStarts.map((start) => {
      const end = stageEnds.find(
        (finish) =>
          finish.stage === start.stage && finish.index === start.index,
      );
      const endAt = end?.at ?? null;
      const durationMs = endAt
        ? Date.parse(endAt) - Date.parse(start.at)
        : null;
      const verdict = end?.reviewVerdict;
      return {
        name: start.stage,
        phase: verdict ? `${start.executor} (${verdict})` : start.executor,
        startedAt: start.at,
        endedAt: endAt,
        durationMs,
      };
    });
    const lastEnd = stageEnds[stageEnds.length - 1];
    const firstStart = stageStarts[0];
    currentStage = lastEnd
      ? `${lastEnd.stage} (${lastEnd.reviewVerdict ?? "done"})`
      : (firstStart?.stage ?? null);
    startedAt = firstStart?.at ?? null;
    finishedAt = lastEnd?.at ?? null;
  }
  const elapsedSec = startedAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000))
    : 0;
  return { stages, currentStage, startedAt, finishedAt, elapsedSec };
}

interface ExecutorStatus {
  pid: number | null;
  alive: boolean | null;
  heartbeatAt: string | null;
  heartbeatStaleSec: number | null;
  startedAt: string | null;
  elapsedSec: number | null;
  command: string | null;
  /** P0-2: 累计执行器调用次数（stage + review + manager + gate 全角色）。 */
  executorInvocations: number;
  /** P0-2: 创建时配置的 per-stage maxTurns。null 表示旧任务无此字段。 */
  configuredMaxTurns: number | null;
  /** P0-2: per-stage 调用次数，key 为 stageIndex 字符串。 */
  stageInvocations: Record<string, number>;
}

/** 读取任务当前 executor 进程状态:pid/active.pid、worker.heartbeat、process_started 命令。 */
export async function readExecutorStatus(
  workspace: string,
  jobId: string,
): Promise<ExecutorStatus> {
  const dir = jobDir(workspace, jobId);
  // executor 子进程 pid 优先;worker pid 兜底(已 detached 时仅 worker 文件在)。
  let pid: number | null = null;
  for (const name of ["active.pid", "pid"]) {
    try {
      pid = Number((await readFile(path.join(dir, name), "utf8")).trim());
      if (Number.isSafeInteger(pid) && pid > 0) break;
    } catch {
      continue;
    }
    pid = null;
  }
  const alive = pid !== null ? processAlive(pid) : null;
  let heartbeatAt: string | null = null;
  let heartbeatStaleSec: number | null = null;
  try {
    const s = await stat(path.join(dir, "worker.heartbeat"));
    heartbeatAt = s.mtime.toISOString();
    heartbeatStaleSec = Math.max(
      0,
      Math.floor((Date.now() - s.mtimeMs) / 1000),
    );
  } catch {
    /* no heartbeat file */
  }
  let startedAt: string | null = null;
  let elapsedSec: number | null = null;
  try {
    const s = await stat(path.join(dir, "pid"));
    startedAt = s.mtime.toISOString();
    elapsedSec = Math.max(0, Math.floor((Date.now() - s.mtimeMs) / 1000));
  } catch {
    /* no pid file */
  }
  // 从 events.ndjson 抓最近一次 process_started 的命令(用于 UI 展示「codebuddy -p ...」)。
  let command: string | null = null;
  try {
    const raw = await readFile(path.join(dir, "events.ndjson"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (event.event === "process_started" && Array.isArray(event.command)) {
        command = (event.command as unknown[])
          .map((part) => String(part))
          .join(" ");
      }
    }
  } catch {
    /* no events */
  }
  // P0-2: 暴露累计执行器调用次数 + 配置 maxTurns，让 UI 算出内外 loop 乘数。
  let executorInvocations = 0;
  let configuredMaxTurns: number | null = null;
  let stageInvocations: Record<string, number> = {};
  try {
    const state = await loadState(workspace, jobId);
    executorInvocations = Number(state.executorInvocations) || 0;
    stageInvocations =
      (state.stageInvocations as Record<string, number> | undefined) ?? {};
    if (typeof state.configuredMaxTurns === "number")
      configuredMaxTurns = state.configuredMaxTurns;
  } catch {
    /* state may not exist yet */
  }
  return {
    pid,
    alive,
    heartbeatAt,
    heartbeatStaleSec,
    startedAt,
    elapsedSec,
    command,
    executorInvocations,
    configuredMaxTurns,
    stageInvocations,
  };
}

interface AgentLogChunk {
  content: string;
  nextOffset: number;
  truncated: boolean;
}

/** 增量读 agent.log: since=0 读尾部 maxBytes 初始展示, since>0 按字节游标续读,截到最后一个完整行。 */
export async function readAgentLogIncremental(
  workspace: string,
  jobId: string,
  since = 0,
  maxBytes = 256 * 1024,
): Promise<AgentLogChunk> {
  const file = path.join(jobDir(workspace, jobId), "agent.log");
  let raw: Buffer;
  try {
    raw = await readFile(file);
  } catch {
    return { content: "", nextOffset: 0, truncated: false };
  }
  // since=0: 尾部 maxBytes; since>0: 从该字节续读增量。
  const tailStart = raw.length > maxBytes ? raw.length - maxBytes : 0;
  const start = since > 0 && since <= raw.length ? since : tailStart;
  const slice = raw.subarray(start);
  const text = slice.toString("utf8");
  // 截到最后一个完整行, 避免半行：末尾是换行则全保留；内部有换行但末尾非换行则退到上一个换行；
  // 完全无换行（单行/二进制）无法判断半行，全保留交给前端展示。
  const lastNl = text.lastIndexOf("\n");
  const end = text.endsWith("\n") || lastNl < 0 ? text.length : lastNl + 1;
  const content = text.slice(0, end);
  return {
    content,
    nextOffset: start + Buffer.byteLength(content, "utf8"),
    truncated: start > 0,
  };
}

function resolveUiDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const parent = path.basename(path.dirname(moduleDir));
  if (parent === "dist") return path.join(moduleDir, "..", "..", "ui");
  return path.join(moduleDir, "..", "ui");
}

function json(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}
function text(
  res: ServerResponse,
  value: string,
  contentType = "text/plain; charset=utf-8",
): void {
  res.writeHead(200, {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(value);
}

/** 读取 POST 请求体并解析为 JSON 对象；空 body 返回 {}。用于写操作（approve/continue 等携带参数）。 */
async function readJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const maxBodyBytes = 1 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let bodyBytes = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    if (!tooLarge) {
      const buffer = Buffer.from(chunk as Uint8Array);
      bodyBytes += buffer.byteLength;
      if (bodyBytes > maxBodyBytes) {
        tooLarge = true;
      } else {
        chunks.push(buffer);
      }
    }
    // 超限后停止累积但仍排空剩余 body：提前中断会让连接滞留（req 流未读完），
    // 响应写出时未读数据触发 RST、客户端收不到（与 /mcp 路径 0751e5e 同一修复）。
  }
  if (tooLarge) {
    const error = new Error("请求体超过 1 MB 上限。") as NodeJS.ErrnoException;
    error.code = "EBIG";
    throw error;
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("请求体必须是合法 JSON。");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("请求体必须是 JSON 对象。");
  return parsed as Record<string, unknown>;
}

/** SSE 客户端：res + 回放期间缓冲。replaying=true 时 broadcast 写入 pending，回放完成后 flush，消除丢事件窗口。 */
interface SseClient {
  res: ServerResponse;
  pending: string[];
  replaying: boolean;
}

/** 解析复合 Last-Event-ID（格式 <wsIndex>:<seq>）为每个 workspace 的 seq 游标。
 *  兼容旧格式（纯数字）：应用到所有 workspace。 */
export function parseCursors(
  rawId: string | undefined,
  workspaceCount: number,
): number[] {
  if (!rawId) return new Array(workspaceCount).fill(0);
  if (rawId.includes(":")) {
    const cursors = new Array(workspaceCount).fill(0);
    for (const part of rawId.split(",")) {
      const [idxStr, seqStr] = part.split(":");
      const idx = Number(idxStr);
      const seq = Number(seqStr);
      if (
        Number.isInteger(idx) &&
        idx >= 0 &&
        idx < workspaceCount &&
        Number.isInteger(seq) &&
        seq >= 0
      )
        cursors[idx] = seq;
    }
    return cursors;
  }
  // 旧格式：纯数字，应用到所有 workspace（保持单 workspace 向后兼容）。
  const legacy = Number(rawId);
  return new Array(workspaceCount).fill(
    Number.isInteger(legacy) && legacy >= 0 ? legacy : 0,
  );
}

/** 回放历史事件：读取 workspace events.ndjson，向 SSE 客户端补发 seq > cursor 的行。
 *  SSE id 编码为复合游标 <wsIndex>:<seq>，支持多 workspace 独立 seq。
 *  最多回放 maxReplayLines 条，超限只发最近 N 条 + 一条 truncation 警告事件。导出供测试覆盖。 */
export async function replayEvents(
  workspace: string,
  client: SseClient,
  wsIndex: number,
  cursor: number,
  maxReplayLines = 1000,
): Promise<void> {
  const eventsFile = path.join(workspace, ".cbx", "events.ndjson");
  let raw: string;
  try {
    raw = await readFile(eventsFile, "utf8");
  } catch {
    return;
  }
  const lines = raw.split("\n").filter((line) => line.trim());
  const candidates: Array<{ seq: number; line: string }> = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as { seq?: unknown };
      const seq = Number(event.seq);
      if (Number.isInteger(seq) && seq > cursor) candidates.push({ seq, line });
    } catch {
      /* 跳过无法解析的行 */
    }
  }
  const truncated = candidates.length > maxReplayLines;
  const toSend = truncated ? candidates.slice(-maxReplayLines) : candidates;
  const out: string[] = [];
  if (truncated) {
    const warning = {
      at: new Date().toISOString(),
      type: "replay_truncated",
      payload: {
        dropped: candidates.length - toSend.length,
        cursor,
        workspace,
      },
    };
    out.push(`data: ${JSON.stringify(warning)}\n\n`);
  }
  for (const { seq, line } of toSend) {
    out.push(`id: ${wsIndex}:${seq}\ndata: ${line}\n\n`);
  }
  for (const msg of out) client.res.write(msg);
}

/** 轮询 workspace 级 .cbx/events.ndjson 增量，解析完整行后回调。 */
export function startEventTailer(
  workspace: string,
  onEvent: (event: Record<string, unknown>) => void,
): () => void {
  const eventsFile = path.join(workspace, ".cbx", "events.ndjson");
  let size = -1;
  let buffer = "";
  // intentional-simple: 500ms 文件大小轮询。Windows 下 fs.watch 不可靠；事件量低，开销可忽略。
  // 首次 stat 前文件不存在时设 size=0：文件首次创建后读到全部已有事件，不丢首批。
  const poll = async (): Promise<void> => {
    try {
      const s = await stat(eventsFile);
      if (size < 0) {
        size = s.size;
        return;
      }
      if (s.size === size) return;
      if (s.size < size) {
        size = s.size;
        buffer = "";
        return;
      }
      const fd = await open(eventsFile, "r");
      try {
        const buf = Buffer.alloc(s.size - size);
        await fd.read(buf, 0, buf.length, size);
        buffer += buf.toString("utf8");
        size = s.size;
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) {
            try {
              onEvent(JSON.parse(line));
            } catch {
              /* partial/corrupt line */
            }
          }
        }
      } finally {
        await fd.close();
      }
    } catch (error) {
      // 文件不存在时初始化基线为 0，避免文件首次创建后把已有内容当历史跳过。
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT" && size < 0)
        size = 0;
    }
  };
  const timer = setInterval(poll, 500);
  timer.unref();
  return () => clearInterval(timer);
}

export function createWebUiServer(
  workspace: string | string[],
  host = "127.0.0.1",
  port = 4173,
  token?: string,
): Server {
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(host))
    throw new Error(
      "Web UI 仅允许绑定到本机回环地址；远程访问需要在受认证的反向代理后显式实现。",
    );
  const workspaces = Array.isArray(workspace) ? workspace : [workspace];
  // 默认 workspace:多 workspace 时取第一个,单 workspace 时取该值。客户端可经 ?workspace=<encoded> 覆盖。
  const defaultWorkspace = workspaces[0] ?? ".";
  const clients = new Set<SseClient>();
  const broadcast = (wsIndex: number, event: Record<string, unknown>): void => {
    // SSE id 编码复合游标 <wsIndex>:<seq>，支持多 workspace 独立 seq 的 Last-Event-ID 回放。
    const seq = typeof event.seq === "number" ? event.seq : undefined;
    const idLine = seq !== undefined ? `id: ${wsIndex}:${seq}\n` : "";
    const message = `${idLine}data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      if (client.replaying)
        client.pending.push(message); // 回放期间缓冲，消除丢事件窗口
      else {
        try {
          client.res.write(message);
        } catch {
          /* client 已断开 */
        }
      }
    }
  };
  // 为每个 workspace 启动独立 tailer;事件附 workspace 字段,前端可按 workspace 过滤着色。
  const stopTailers: Array<() => void> = [];
  workspaces.forEach((ws, wsIndex) => {
    const tailer = startEventTailer(ws, (event) =>
      broadcast(wsIndex, { ...event, workspace: ws }),
    );
    stopTailers.push(tailer);
  });
  // 从 URL query 中选 workspace;不在白名单内时降级到 default,避免任意路径枚举。
  const resolveWorkspace = (url: URL): string => {
    const requested = url.searchParams.get("workspace");
    if (requested) {
      const resolved = path.resolve(decodeURIComponent(requested));
      if (workspaces.some((item) => item === resolved)) return resolved;
    }
    return defaultWorkspace;
  };
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "POST")
        return json(res, { error: "method not allowed" }, 405);
      const url = new URL(req.url ?? "/", `http://${host}:${port}`);
      // UI 外壳与 /healthz 保持开放；API 数据仍需鉴权。
      // /events 允许 query token (EventSource 无法设 Authorization header)。
      if (
        !PUBLIC_UI_PATHS.has(url.pathname) &&
        !isAuthorized(req, url, token, url.pathname === "/events")
      ) {
        res.writeHead(401, {
          "www-authenticate": "Bearer",
          "content-type": "application/json; charset=utf-8",
        });
        return res.end(JSON.stringify({ error: "unauthorized" }));
      }
      if (url.pathname === "/") {
        const uiDir = resolveUiDir();
        const html = await readFile(path.join(uiDir, "index.html"), "utf8");
        // token 经 HttpOnly cookie 下发：浏览器同源请求自动携带，页面 JS/XSS 不可读，也不出现在 URL 查询串。
        // 首页本身保持开放（PUBLIC_UI_PATHS），cookie 仅作后续 API 的凭证。
        if (token) {
          res.setHeader(
            "set-cookie",
            `cbx_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`,
          );
        }
        return text(res, html, "text/html; charset=utf-8");
      }
      if (url.pathname === "/style.css") {
        const css = await readFile(
          path.join(resolveUiDir(), "style.css"),
          "utf8",
        );
        return text(res, css, "text/css; charset=utf-8");
      }
      if (url.pathname === "/app.js") {
        const js = await readFile(path.join(resolveUiDir(), "app.js"), "utf8");
        return text(res, js, "application/javascript; charset=utf-8");
      }
      // /events 鉴权已由上方统一 gate（isAuthorized, allowQueryToken=true）处理；
      // 此处不再二次校验，避免未配置 token 时把合法的无 token SSE 请求误判为 401。
      if (url.pathname === "/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        // 复合 Last-Event-ID：格式 <wsIndex>:<seq>（多 workspace 独立 seq）；兼容旧纯数字格式。
        // 回放期间 client.replaying=true，broadcast 写入 pending 缓冲，回放完成后 flush，消除丢事件窗口。
        const lastEventIdHeader = req.headers["last-event-id"];
        const lastEventIdQuery = url.searchParams.get("last_event_id");
        const lastEventIdRaw =
          (Array.isArray(lastEventIdHeader)
            ? lastEventIdHeader[0]
            : lastEventIdHeader) ??
          lastEventIdQuery ??
          undefined;
        const cursors = parseCursors(lastEventIdRaw, workspaces.length);
        const client: SseClient = {
          res,
          pending: [],
          replaying: lastEventIdRaw !== undefined,
        };
        clients.add(client);
        // 回放历史：每个 workspace 按各自 cursor 过滤，复合 ID 编码 wsIndex:seq。
        for (let wsIndex = 0; wsIndex < workspaces.length; wsIndex += 1) {
          await replayEvents(
            workspaces[wsIndex],
            client,
            wsIndex,
            cursors[wsIndex],
          );
        }
        // flush 缓冲：回放期间 tailer 广播的实时事件先于 connected 消息补发，不丢失。
        client.replaying = false;
        for (const msg of client.pending) {
          try {
            res.write(msg);
          } catch {
            /* client 已断开 */
          }
        }
        client.pending = [];
        res.write(
          `data: ${JSON.stringify({ at: new Date().toISOString(), type: "connected", workspaces })}\n\n`,
        );
        req.on("close", () => clients.delete(client));
        return;
      }
      if (url.pathname === "/api/workspaces") {
        const summaries = await Promise.all(
          workspaces.map((ws) =>
            summarizeWorkspace(ws).catch((error) => ({
              path: ws,
              name: path.basename(ws) || ws,
              error: error instanceof Error ? error.message : String(error),
            })),
          ),
        );
        return json(res, { workspaces: summaries, default: defaultWorkspace });
      }
      const ws = resolveWorkspace(url);
      // GET 才返回任务列表；POST 由下方写操作区块创建任务。
      if (url.pathname === "/api/jobs" && req.method === "GET")
        return json(res, await listJobs(ws));
      if (url.pathname === "/api/queue") return json(res, await listQueue(ws));
      if (url.pathname === "/healthz" || url.pathname === "/api/metrics")
        return json(res, await health(ws));
      const job = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname);
      if (job) return json(res, await loadState(ws, job[1]));
      const artifacts = /^\/api\/jobs\/([^/]+)\/artifacts$/.exec(url.pathname);
      if (artifacts) return json(res, await listArtifacts(ws, artifacts[1]));
      const artifact = /^\/api\/jobs\/([^/]+)\/artifact\/([^/]+)$/.exec(
        url.pathname,
      );
      if (artifact)
        return text(res, await readArtifact(ws, artifact[1], artifact[2]));
      const timeline = /^\/api\/jobs\/([^/]+)\/timeline$/.exec(url.pathname);
      if (timeline) return json(res, await buildTimeline(ws, timeline[1]));
      const executor = /^\/api\/jobs\/([^/]+)\/executor$/.exec(url.pathname);
      if (executor) return json(res, await readExecutorStatus(ws, executor[1]));
      const agentLog = /^\/api\/jobs\/([^/]+)\/agent\.log$/.exec(url.pathname);
      if (agentLog) {
        const since = Number(url.searchParams.get("since") ?? 0);
        return text(
          res,
          JSON.stringify(await readAgentLogIncremental(ws, agentLog[1], since)),
          "application/json; charset=utf-8",
        );
      }
      // ---- 写操作（POST，需鉴权；SameSite=Strict cookie 阻止跨站携带，loopback 绑定 + HttpOnly 即够）----
      if (req.method === "POST") {
        if (url.pathname === "/api/jobs") {
          // 创建任务：与 CLI `cbx start` 语义一致（createJob + startBackground）。
          const body = await readJsonBody(req);
          if (typeof body.task !== "string" || !body.task.trim())
            return json(res, { error: "task 必须是非空字符串。" }, 400);
          const config = await loadConfig(ws);
          const defaults = mergeConfig(config, {
            testCommand:
              typeof body.test_command === "string"
                ? body.test_command
                : undefined,
            review: typeof body.review === "boolean" ? body.review : undefined,
            isolated:
              typeof body.isolated === "boolean" ? body.isolated : undefined,
            timeoutMs:
              body.timeout_ms === undefined
                ? undefined
                : Number(body.timeout_ms),
            maxRetries:
              body.max_retries === undefined ? undefined : Number(body.max_retries),
            maxTurns:
              body.max_turns === undefined ? undefined : Number(body.max_turns),
            permissionMode:
              typeof body.permission_mode === "string"
                ? body.permission_mode
                : undefined,
            approvalBeforeRun:
              typeof body.approval_before_run === "boolean"
                ? body.approval_before_run
                : undefined,
            dependencyGuard:
              typeof body.dependency_guard === "boolean"
                ? body.dependency_guard
                : undefined,
            keepWorktree:
              typeof body.keep_worktree === "boolean"
                ? body.keep_worktree
                : undefined,
            executor:
              typeof body.executor === "string" ? body.executor : undefined,
            reviewExecutor:
              typeof body.review_executor === "string"
                ? body.review_executor
                : undefined,
            autoBranch:
              typeof body.auto_branch === "boolean" ? body.auto_branch : undefined,
            autoCommit:
              typeof body.auto_commit === "boolean" ? body.auto_commit : undefined,
            commitMessage:
              typeof body.commit_message === "string"
                ? body.commit_message
                : undefined,
          });
          const created = await createJob({
            workspace: ws,
            task: body.task,
            contextSnapshot:
              typeof body.context_snapshot === "string"
                ? body.context_snapshot
                : undefined,
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
          await startBackground(
            ws,
            created.jobId,
            "",
            body.priority === undefined ? 0 : Number(body.priority),
          );
          return json(res, { job_id: created.jobId, status: "queued" }, 201);
        }
        if (url.pathname === "/api/queue/pause")
          return json(res, await pauseQueue(ws));
        if (url.pathname === "/api/queue/resume")
          return json(res, await resumeQueue(ws));
        const jobAction =
          /^\/api\/jobs\/([^/]+)\/(approve|cancel|retry|continue|forget|purge)$/.exec(
            url.pathname,
          );
        if (jobAction) {
          const jobId = jobAction[1];
          const action = jobAction[2];
          if (action === "approve") {
            const state = await approveJob(ws, jobId);
            // 与 MCP cbx_approve 一致：批准 before_run 后状态回 queued，需显式启动。
            if (state.status === "queued") await startBackground(ws, jobId);
            return json(res, state);
          }
          if (action === "cancel") return json(res, await cancelJob(ws, jobId));
          if (action === "retry") {
            const body = await readJsonBody(req);
            const priority =
              body.priority === undefined ? 0 : Number(body.priority);
            return json(res, await retryQueueJob(ws, jobId, priority));
          }
          if (action === "forget" || action === "purge") {
            // Web UI 路径：reason 来自 body 字段（前端在 confirm 后把 reason 透传），
            // 缺失时给默认的 source 标记，与 MCP 入口的审计约定保持一致。
            // body 解析失败按空对象处理：忘删本就该能用一个空 POST 完成。
            const body: Record<string, unknown> = await readJsonBody(req)
              .catch(() => ({}) as Record<string, unknown>);
            const reason =
              typeof body.reason === "string" && body.reason.trim()
                ? `web:${action} ${body.reason}`
                : `web:${action}`;
            const result = await (action === "forget"
              ? forgetJobKeepWorktree(ws, jobId, reason)
              : purgeJob(ws, jobId, reason));
            return json(res, {
              job_id: result.jobId,
              status: result.status,
              deleted_directory: result.deletedDirectory,
              worktree_cleaned: result.worktreeCleaned,
              remaining_queue_entries: result.remainingQueueEntries,
              tombstoned_at: result.tombstonedAt,
            });
          }
          // continue
          const body = await readJsonBody(req);
          const extraRounds =
            body.extra_rounds === undefined ? 0 : Number(body.extra_rounds);
          if (
            body.extra_rounds !== undefined &&
            (!Number.isInteger(extraRounds) ||
              extraRounds < 1 ||
              extraRounds > 100)
          )
            return json(
              res,
              { error: "extra_rounds 必须是 1 到 100 的整数。" },
              400,
            );
          const priority =
            body.priority === undefined ? 0 : Number(body.priority);
          if (body.priority !== undefined && !Number.isFinite(priority))
            return json(res, { error: "priority 必须是数字。" }, 400);
          // refresh_baseline 只接受布尔：JSON body 里字符串 "false" 不得被 Boolean() 强转成 true。
          if (
            body.refresh_baseline !== undefined &&
            typeof body.refresh_baseline !== "boolean"
          )
            return json(res, { error: "refresh_baseline 必须是布尔值。" }, 400);
          await startBackground(
            ws,
            jobId,
            body.message === undefined ? "" : String(body.message),
            priority,
            body.context_snapshot === undefined
              ? undefined
              : String(body.context_snapshot),
            body.refresh_baseline === true,
            extraRounds,
          );
          return json(res, { jobId, status: "queued" });
        }
      }
      return json(res, { error: "not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as NodeJS.ErrnoException)?.code;
      // 按错误码映射 HTTP 状态，不再依赖消息文案匹配。
      const status =
        code === "ENOENT"
          ? 404
          : code === "EBIG"
            ? 413
            : isCbxError(error, "E_NOT_FOUND")
              ? 404
              : isCbxError(error, "E_ARTIFACT_FORBIDDEN")
                ? 403
                : isCbxError(error, "E_INVALID_JOB_ID")
                  ? 400
                  : 500;
      json(res, { error: message }, status);
    }
  });
  const heartbeat = setInterval(() => {
    const message = `data: ${JSON.stringify({ at: new Date().toISOString(), type: "heartbeat" })}\n\n`;
    for (const client of clients) {
      if (client.replaying) client.pending.push(message);
      else {
        try {
          client.res.write(message);
        } catch {
          /* client 已断开 */
        }
      }
    }
  }, 1500);
  heartbeat.unref();
  server.on("close", () => {
    clearInterval(heartbeat);
    for (const stop of stopTailers) stop();
  });
  return server;
}

export async function startWebUi(
  workspace: string | string[],
  port = 4173,
  host = "127.0.0.1",
  token?: string,
): Promise<void> {
  const server = createWebUiServer(workspace, host, port, token);
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  console.log(
    `CBX UI: http://${host}:${port}${token ? " (token auth enabled)" : ""}`,
  );
  await new Promise<void>((resolve) => server.on("close", resolve));
}


