import type { ServerResponse, IncomingMessage } from "node:http";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { jobDir, listJobs, listQueue, loadState } from "./core.js";
import { captureAsync } from "./process-runner.js";
import { parsePidRecordText } from "./pid-guard.js";
import { constantTimeEqual, eventsAfterCursor, jobEventsAfterCursor, processAlive } from "./storage.js";
import { TERMINAL_STATUSES } from "./types.js";

/** 校验 token; 未配置 token 时始终放行。常量时间比较避免时序侧信道。
 *  凭证只接受 Authorization Bearer header（curl/API 客户端）或 `cbx_token`
 *  HttpOnly cookie（浏览器同源自动携带，JS 不可读）——不接受 URL query token：
 *  它会进浏览器历史、代理与访问日志、Referer，形成持久的凭证泄漏面。 */
export function isAuthorized(
  req: IncomingMessage,
  expectedToken: string | undefined,
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

/** git 摘要短缓存：仪表盘每 1.5s 全量刷新都会打 /api/workspaces，每次两趟 git
 *  （大仓库可达数百毫秒）；5s 缓存把稳态开销压掉 2/3，且不影响正确性体感。 */
const gitSummaryCache = new Map<string, { at: number; branch: string | null; dirty: boolean | null }>();
const GIT_SUMMARY_TTL_MS = 5_000;

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
  const cached = gitSummaryCache.get(workspace);
  if (cached && Date.now() - cached.at < GIT_SUMMARY_TTL_MS) {
    gitBranch = cached.branch;
    gitDirty = cached.dirty;
  } else {
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
    gitSummaryCache.set(workspace, { at: Date.now(), branch: gitBranch, dirty: gitDirty });
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

/**
 * 从事件流推导阶段时间线。兼容两套事件:
 * - 新格式(0.10.2+):job.state_changed 事件携带 status 维度
 * - 老格式(<=0.10.1):stage_started / stage_finished 配对携带 stage 维度
 * 优先用新格式;若不存在则用老格式配对构造。
 *
 * 读取源：优先 SQLite events 表（审计权威，执行器不可写）；SQLite 无该 job 事件
 * （旧任务/镜像缺失）时回退 events.ndjson。
 */
export async function buildTimeline(
  workspace: string,
  jobId: string,
): Promise<JobTimeline> {
  // 先从 SQLite 取事件（审计权威），失败/无数据回退 ndjson。
  let events: Array<Record<string, unknown>> = [];
  try {
    const result = await jobEventsAfterCursor(workspace, jobId, 0, 5000);
    events = result.rows.map((row) => {
      const payload = row.payload as Record<string, unknown>;
      // SQLite payload 与 ndjson 行的结构一致（都含 event/at/...），补 seq 便于排序
      return { ...payload, seq: row.seq };
    });
  } catch {
    events = [];
  }
  if (events.length === 0) {
    // fallback：ndjson（旧任务无 SQLite 镜像）
    const eventsFile = path.join(jobDir(workspace, jobId), "events.ndjson");
    try {
      const raw = await readFile(eventsFile, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          events.push(JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
          /* 跳过坏行 */
        }
      }
    } catch {
      /* 任务还没产生事件 */
    }
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
  for (const event of events) {
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
  // active.pid 为 JSON 记录（{pid, startedAt}），"pid" 为旧版/worker 裸数字，统一走容错解析。
  let pid: number | null = null;
  for (const name of ["active.pid", "pid"]) {
    try {
      pid = parsePidRecordText(await readFile(path.join(dir, name), "utf8"))?.pid ?? null;
      if (pid !== null && Number.isSafeInteger(pid) && pid > 0) break;
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
  // 从事件流抓最近一次 process_started 的命令(用于 UI 展示「codebuddy -p ...」)。
  // 优先 SQLite（审计权威，执行器不可写），fallback ndjson。
  let command: string | null = null;
  try {
    const result = await jobEventsAfterCursor(workspace, jobId, 0, 5000);
    for (const row of result.rows) {
      const event = row.payload as Record<string, unknown>;
      if (event.event === "process_started" && Array.isArray(event.command)) {
        command = (event.command as unknown[])
          .map((part) => String(part))
          .join(" ");
      }
    }
  } catch {
    /* 无事件 */
  }
  if (command === null) {
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

/** 回放历史事件，向 SSE 客户端补发 seq > cursor 的行。
 *  SSE id 编码为复合游标 <wsIndex>:<seq>，支持多 workspace 独立 seq。
 *  优先走 SQLite events 表索引查询（O(cursor 之后的行)，不再整读文件）；表不可用
 *  时回退整读 events.ndjson（文件已被轮转限界）。最多回放 maxReplayLines 条，
 *  超限只发最近 N 条 + 一条 truncation 警告事件。导出供测试覆盖。 */
export async function replayEvents(
  workspace: string,
  client: SseClient,
  wsIndex: number,
  cursor: number,
  maxReplayLines = 1000,
): Promise<void> {
  const out: string[] = [];
  let candidates: Array<{ seq: number; line: string }>;
  let truncated: boolean;
  try {
    const result = await eventsAfterCursor(workspace, cursor, maxReplayLines);
    candidates = result.rows.map((row) => ({
      seq: row.seq,
      line: JSON.stringify(row.payload),
    }));
    truncated = result.truncated;
  } catch {
    // SQLite 回放不可用：退回整读 ndjson（轮转已限界文件大小）。
    const eventsFile = path.join(workspace, ".cbx", "events.ndjson");
    let raw: string;
    try {
      raw = await readFile(eventsFile, "utf8");
    } catch {
      return;
    }
    candidates = [];
    for (const line of raw.split("\n").filter((item) => item.trim())) {
      try {
        const event = JSON.parse(line) as { seq?: unknown };
        const seq = Number(event.seq);
        if (Number.isInteger(seq) && seq > cursor)
          candidates.push({ seq, line });
      } catch {
        /* 跳过无法解析的行 */
      }
    }
    truncated = candidates.length > maxReplayLines;
    if (truncated) candidates = candidates.slice(-maxReplayLines);
  }
  if (truncated) {
    out.push(`data: ${JSON.stringify({
      at: new Date().toISOString(),
      type: "replay_truncated",
      payload: {
        dropped: 0,
        cursor,
        workspace,
      },
    })}\n\n`);
  }
  for (const { seq, line } of candidates) {
    out.push(`id: ${wsIndex}:${seq}\ndata: ${line}\n\n`);
  }
  for (const msg of out) client.res.write(msg);
}

/** 轮询 workspace 级 .cbx/events.ndjson 增量，解析完整行后回调。 */
export type EventTailerGuard = () => void | Promise<void>;

export interface EventTailerOptions {
  /** Runs before each poll; rejection stops the tailer fail-closed. */
  guard?: EventTailerGuard;
  /** Called after a guard rejection, without exposing the workspace path. */
  onGuardFailure?: (error: unknown) => void | Promise<void>;
}

export function startEventTailer(
  workspace: string,
  onEvent: (event: Record<string, unknown>) => void,
  guardOrOptions?: EventTailerGuard | EventTailerOptions,
): () => void {
  const eventsFile = path.join(workspace, ".cbx", "events.ndjson");
  const guard = typeof guardOrOptions === "function"
    ? guardOrOptions
    : guardOrOptions?.guard;
  const onGuardFailure = typeof guardOrOptions === "function"
    ? undefined
    : guardOrOptions?.onGuardFailure;
  let size = -1;
  let buffer = "";
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
  };
  // intentional-simple: 500ms 文件大小轮询。Windows 下 fs.watch 不可靠；事件量低，开销可忽略。
  // 首次 stat 前文件不存在时设 size=0：文件首次创建后读到全部已有事件，不丢首批。
  const poll = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      try {
        await guard?.();
      } catch (error) {
        stop();
        try {
          if (onGuardFailure) await onGuardFailure(error);
          else console.warn("cbx: 事件尾部跟随器因工作区身份校验失败而停止");
        } catch {
          // Guard failure handling must never create an unhandled rejection.
          console.warn("cbx: 事件尾部跟随器因工作区身份校验失败而停止");
        }
        return;
      }
      if (stopped) return;
      try {
        const s = await stat(eventsFile);
        if (stopped) return;
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
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => {
    void poll();
  }, 500);
  timer.unref();
  return stop;
}
