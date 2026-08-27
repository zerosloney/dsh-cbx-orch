/**
 * storage/events —— 事件表写入与查询（审计权威）。
 *
 * 从原 storage.ts 抽出。events 表是执行器子进程无法写入的审计权威（ndjson 可被
 * 不可信执行器篡改，镜像表不可）。insertEvent / eventsAfterCursor / jobEventsAfterCursor /
 * verifyJobAudit（ndjson vs SQLite 镜像一致性校验）。
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { database } from "./db.js";
import { now } from "./io.js";
/** 工作区事件的 SQLite 镜像写入：与 events.ndjson 双写（ndjson 仍是 tailer 的实时
 *  源与审计轨迹），SSE 回放 / timeline 改走索引查询，不再每次连接整读 O(文件)。
 *  `jobId` 可选：job 级事件（logJobEvent/appendEvent）镜像时携带，支持按任务过滤
 *  ——SQLite 是执行器子进程无法写入的审计权威（见 verifyJobAudit）。 */
export async function insertEvent(
  workspace: string,
  seq: number,
  type: string,
  payload: unknown,
  jobId?: string,
): Promise<void> {
  const db = await database(workspace);
  const event = payload as { at?: unknown };
  db.prepare(
    "INSERT INTO events(workspace, seq, type, payload_json, at, job_id) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    workspace,
    seq,
    type,
    JSON.stringify(payload),
    typeof event.at === "string" ? event.at : now(),
    jobId ?? null,
  );
}

/** 查询某 job 的事件（按 seq 升序，最多 limit 条）。SQLite 是审计权威：执行器可改
 *  events.ndjson 但无法写 events 表，此查询结果可信。 */
export async function jobEventsAfterCursor(
  workspace: string,
  jobId: string,
  cursor: number,
  limit = 1000,
): Promise<{
  rows: Array<{ seq: number; payload: unknown }>;
  truncated: boolean;
}> {
  const db = await database(workspace);
  const rows = db
    .prepare(
      "SELECT seq, payload_json FROM events WHERE workspace = ? AND job_id = ? AND seq > ? ORDER BY seq LIMIT ?",
    )
    .all(workspace, jobId, cursor, limit + 1) as Array<{
    seq: number;
    payload_json: string;
  }>;
  const truncated = rows.length > limit;
  const kept = truncated ? rows.slice(0, limit) : rows;
  return {
    rows: kept.map((row) => ({
      seq: row.seq,
      payload: JSON.parse(row.payload_json),
    })),
    truncated,
  };
}

/** SSE 回放查询：cursor 之后按 seq 升序取最多 limit 条；返回是否截断（有更多行）。 */
export async function eventsAfterCursor(
  workspace: string,
  cursor: number,
  limit = 1000,
): Promise<{
  rows: Array<{ seq: number; payload: unknown }>;
  truncated: boolean;
}> {
  const db = await database(workspace);
  const rows = db
    .prepare(
      "SELECT seq, payload_json FROM events WHERE workspace = ? AND seq > ? ORDER BY seq LIMIT ?",
    )
    .all(workspace, cursor, limit + 1) as Array<{
    seq: number;
    payload_json: string;
  }>;
  const truncated = rows.length > limit;
  const kept = truncated ? rows.slice(0, limit) : rows;
  return {
    rows: kept.map((row) => ({
      seq: row.seq,
      payload: JSON.parse(row.payload_json),
    })),
    truncated,
  };
}

/** 某 job 的事件总数（审计验证分页的 COUNT 锚点，代价 O(索引)）。 */
export async function countJobEvents(
  workspace: string,
  jobId: string,
): Promise<number> {
  const db = await database(workspace);
  const row = db
    .prepare(
      "SELECT COUNT(*) AS c FROM events WHERE workspace = ? AND job_id = ?",
    )
    .get(workspace, jobId) as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

/** 某 job 的事件页（seq 严格小于 beforeSeq，降序取 limit 条）——审计验证从尾部
 *  分页回放，事件再多也不整读进内存。 */
export async function jobEventsDesc(
  workspace: string,
  jobId: string,
  beforeSeq: number,
  limit = 5000,
): Promise<Array<{ seq: number; payload: unknown }>> {
  const db = await database(workspace);
  const rows = db
    .prepare(
      "SELECT seq, payload_json FROM events WHERE workspace = ? AND job_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
    )
    .all(workspace, jobId, beforeSeq, limit) as Array<{
    seq: number;
    payload_json: string;
  }>;
  return rows.map((row) => ({
    seq: row.seq,
    payload: JSON.parse(row.payload_json),
  }));
}

export interface JobAuditVerification {
  /** 审计是否可信（ndjson 与 SQLite 镜像一致或 SQLite 无该 job 事件时视为可信）。 */
  valid: boolean;
  /** 检测到执行器篡改 ndjson（与 SQLite 镜像漂移）。 */
  tampered: boolean;
  /** 详情：不匹配位置、行数差异等。 */
  reason?: string;
  /** ndjson 事件数（尽力）。 */
  ndjsonCount?: number;
  /** SQLite 镜像事件数。 */
  sqliteCount?: number;
}

/**
 * 校验某 job 的审计完整性：比对 events.ndjson 与 SQLite events 表镜像。
 *
 * 威胁模型：执行器（不可信子进程）知道 jobDir 绝对路径，可改写/追加/删除
 * events.ndjson；但它没有 SQLite 连接，无法写 events 表。因此 ndjson 与镜像
 * 漂移 = 检测到篡改（或镜像失败，此时 valid=false 但 tampered=false，需人工排查）。
 *
 * 对齐语义：ndjson 必须是 SQLite 镜像的**连续尾部子序列**——即 ndjson 的每一行
 * 都与 SQLite 中"距末尾同样距离"的那一行逐字段一致（event/jobId/at/全部 detail）。
 * - ndjson 头部缺失（事件 >10MB 轮转到 .1 代、或保留期清理先删了镜像行）= 尾部
 *   仍对齐 → 不误报；
 * - 执行器改写任意行（含 payload 内容）= 该行深度比对失败 → 检测；
 * - 执行器删除中间行 = ndjson 不再是连续尾部 → 检测。
 * SQLite 无该 job 事件（旧任务/镜像未启用）时视为"无锚点"，不判定篡改。
 *
 * 实现（分块流式，v0.4.5）：SQLite 侧先 COUNT 锚点，再从尾部按 5000 行一页
 * DESC 分页回放，与 ndjson 尾部（内存读取，≤ 两代日志 20MB 量级）逐行对齐——
 * 事件再多（>5 万条）也能完整验证，不再整读截断而返回「无法验证」。
 */
export async function verifyJobAudit(
  workspace: string,
  jobId: string,
): Promise<JobAuditVerification> {
  // 1) SQLite 镜像（权威锚点）：COUNT 代价 O(索引)，分页从尾部流式取。
  let sqliteCount = 0;
  try {
    sqliteCount = await countJobEvents(workspace, jobId);
  } catch {
    /* 镜像不可用 */
  }
  if (sqliteCount === 0) {
    // 无锚点：无法验证（旧任务或镜像缺失）。不判定篡改，但标记 valid=false 提示。
    return { valid: false, tampered: false, reason: "SQLite 镜像无该 job 事件（旧任务或镜像缺失），无法验证审计完整性。", sqliteCount: 0 };
  }
  // 2) ndjson（可能被执行器篡改）：主文件 + 轮转 .1 代合并（按行序）。文件级上限
  //    与 events.ndjson 轮转一致（单代），全量读入内存的量级可控。
  const ndjsonEvents: Array<Record<string, unknown>> = [];
  const readNdjson = async (file: string): Promise<void> => {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return; // 主文件缺失 = 与镜像漂移；.1 缺失 = 无历史代
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        ndjsonEvents.push(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        /* 坏行：执行器可能截断了文件，按不匹配处理（不 push 会让后续对齐错位） */
      }
    }
  };
  const base = path.join(workspace, ".cbx", "jobs", jobId, "events.ndjson");
  await readNdjson(base);
  await readNdjson(`${base}.1`);
  const ndjsonCount = ndjsonEvents.length;
  // 3) 连续尾部子序列对齐（分块，从尾部回放）：
  //    ndjson 行数 > SQLite = ndjson 有镜像之外的行（镜像 fire-and-forget 失败不会
  //    产生多余行，只能是执行器追加伪造）→ 判定篡改。
  if (ndjsonCount > sqliteCount) {
    return {
      valid: false,
      tampered: true,
      reason: `events.ndjson 事件数（${ndjsonCount}）多于 SQLite 镜像（${sqliteCount}）——ndjson 含镜像没有的事件，可能被执行器伪造。`,
      ndjsonCount,
      sqliteCount,
    };
  }
  let beforeSeq = Number.MAX_SAFE_INTEGER;
  let compared = 0;
  paging: while (compared < ndjsonCount) {
    const page = await jobEventsDesc(workspace, jobId, beforeSeq, 5000).catch(
      () => [] as Array<{ seq: number; payload: unknown }>,
    );
    if (page.length === 0) break paging;
    for (const row of page) {
      if (compared >= ndjsonCount) break paging;
      const ndjson = ndjsonEvents[ndjsonCount - 1 - compared];
      if (!eventsEqual(row.payload as Record<string, unknown>, ndjson)) {
        return {
          valid: false,
          tampered: true,
          reason: `从尾部数第 ${compared + 1} 行事件与 SQLite 镜像不一致（含 payload 内容）——ndjson 被篡改。`,
          ndjsonCount,
          sqliteCount,
        };
      }
      compared += 1;
    }
    beforeSeq = page[page.length - 1].seq;
  }
  return { valid: true, tampered: false, ndjsonCount, sqliteCount };
}

/** 事件行深度相等：event/jobId/at 与全部 detail 字段逐项一致（防 payload 内容篡改）。
 *  对象字段用规范化（键排序）JSON 比较，避免两侧键序不同导致的误判。 */
function eventsEqual(
  sqlite: Record<string, unknown>,
  ndjson: Record<string, unknown>,
): boolean {
  // 键集合必须一致（执行器增删字段即判定篡改）。
  const sqliteKeys = Object.keys(sqlite).sort();
  const ndjsonKeys = Object.keys(ndjson).sort();
  if (sqliteKeys.length !== ndjsonKeys.length) return false;
  for (let i = 0; i < sqliteKeys.length; i++) {
    if (sqliteKeys[i] !== ndjsonKeys[i]) return false;
    const a = sqlite[sqliteKeys[i]];
    const b = ndjson[ndjsonKeys[i]];
    if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
      if (stableStringify(a) !== stableStringify(b)) return false;
    } else if (a !== b) {
      return false;
    }
  }
  return true;
}

/** 键排序的稳定 JSON 序列化（对象字段序不影响相等性判定）。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([k1], [k2]) => (k1 < k2 ? -1 : k1 > k2 ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
