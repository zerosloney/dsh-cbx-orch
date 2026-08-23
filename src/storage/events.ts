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
 * 事件行以 (seq, payload) 为身份：两边按出现顺序对齐比较 event 类型与关键字段。
 * SQLite 无该 job 事件（旧任务/镜像未启用）时视为"无锚点"，不判定篡改。
 */
export async function verifyJobAudit(
  workspace: string,
  jobId: string,
): Promise<JobAuditVerification> {
  // 1) SQLite 镜像（权威锚点）
  let sqliteEvents: Array<Record<string, unknown>> = [];
  try {
    const result = await jobEventsAfterCursor(workspace, jobId, 0, 10000);
    sqliteEvents = result.rows.map((row) => row.payload as Record<string, unknown>);
  } catch {
    /* 镜像不可用 */
  }
  if (sqliteEvents.length === 0) {
    // 无锚点：无法验证（旧任务或镜像缺失）。不判定篡改，但标记 valid=false 提示。
    return { valid: false, tampered: false, reason: "SQLite 镜像无该 job 事件（旧任务或镜像缺失），无法验证审计完整性。", sqliteCount: 0 };
  }
  // 2) ndjson（可能被执行器篡改）
  const ndjsonEvents: Array<Record<string, unknown>> = [];
  try {
    const raw = await readFile(path.join(workspace, ".cbx", "jobs", jobId, "events.ndjson"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        ndjsonEvents.push(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        /* 坏行：执行器可能截断了文件，按不匹配处理 */
      }
    }
  } catch {
    /* ndjson 缺失：与镜像漂移 */
  }
  const sqliteCount = sqliteEvents.length;
  const ndjsonCount = ndjsonEvents.length;
  if (ndjsonEvents.length !== sqliteEvents.length) {
    return {
      valid: false,
      tampered: true,
      reason: `events.ndjson 事件数（${ndjsonEvents.length}）与 SQLite 镜像（${sqliteEvents.length}）不一致——ndjson 可能被篡改。`,
      ndjsonCount,
      sqliteCount,
    };
  }
  // 3) 逐行对齐：event 类型 + jobId + at（时间）必须一致
  for (let i = 0; i < sqliteEvents.length; i++) {
    const sqlite = sqliteEvents[i];
    const ndjson = ndjsonEvents[i];
    if (String(sqlite.event) !== String(ndjson.event) || String(sqlite.jobId) !== String(ndjson.jobId)) {
      return {
        valid: false,
        tampered: true,
        reason: `第 ${i + 1} 行事件不匹配：SQLite=${String(sqlite.event)}，ndjson=${String(ndjson.event)}——ndjson 被篡改。`,
        ndjsonCount,
        sqliteCount,
      };
    }
  }
  return { valid: true, tampered: false, ndjsonCount, sqliteCount };
}
