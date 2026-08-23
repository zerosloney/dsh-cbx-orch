/**
 * storage/prune —— 保留期清理（终态任务、事件、outbox 死信、孤儿目录）。
 *
 * 从原 storage.ts 抽出。按 governance.retentionDays 清理 SQLite 行与磁盘目录；
 * 仅删终态且超保留期的 job（不触碰活动工作集）；孤儿 job 目录按"无行 + mtime
 * 超 1h"回收。peekQueueBlob（只读队列快照）供 metrics 使用。
 */
import path from "node:path";
import { readdir, readFile, rename, rm, stat, unlink, writeFile, appendFile } from "node:fs/promises";
import { now, isMissing } from "./io.js";
import { database, type CbxDatabase } from "./db.js";
import { assertJobId } from "../validation.js";
async function pruneDeliveryFailureArtifact(
  workspace: string,
  cutoff: number,
): Promise<number> {
  const file = path.join(workspace, ".cbx", "delivery-failures.ndjson");
  // 低流量审计文件，整读即可（也顺带拿到精确的字节基线用于竞态回捞）。
  let raw: string;
  let readBytes: number;
  try {
    const buffer = await readFile(file);
    readBytes = buffer.byteLength;
    raw = buffer.toString("utf8");
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  const retained: string[] = [];
  let removed = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const record = JSON.parse(line) as { at?: string; createdAt?: string };
      const at = Date.parse(record.at ?? record.createdAt ?? "");
      if (Number.isFinite(at) && at < cutoff) {
        removed += 1;
        continue;
      }
    } catch {
      /* preserve malformed records for manual recovery */
    }
    retained.push(line);
  }
  if (!removed) return 0;
  // 竞态安全的压缩：直接"读全文→覆盖写"会吞掉读取与替换之间并发 append 的行
  // （它们写进了被换掉的旧 inode）。改为：写临时文件 → 原文件改名让位 →（若路径
  // 已被并发 append 重建，先并入其内容）→ 临时文件上位 → 从旧 inode 回捞读取
  // 之后新增的尾部行 → 清理。任一步失败尝试回滚原名。
  const temporary = `${file}.${process.pid}.tmp`;
  const previous = `${file}.prune-old`;
  await writeFile(
    temporary,
    retained.length ? retained.join("\n") + "\n" : "",
    "utf8",
  );
  try {
    await rename(file, previous);
    try {
      // 让位与上位之间并发 appendFile 会在路径上重建新文件：先并入再上位，
      // 避免 rename 覆盖把它吞掉。
      try {
        const appended = await readFile(file, "utf8");
        if (appended)
          await appendFile(
            temporary,
            appended.endsWith("\n") ? appended : `${appended}\n`,
            "utf8",
          );
      } catch {
        /* 无并发写 */
      }
      await rename(temporary, file);
    } catch (error) {
      await rename(previous, file).catch(() => undefined);
      throw error;
    }
    // 回捞：读取期间追加、落在旧 inode 上的行。
    try {
      const old = await readFile(previous);
      if (old.byteLength > readBytes) {
        const tail = old.subarray(readBytes).toString("utf8");
        if (tail.trim())
          await appendFile(
            file,
            tail.endsWith("\n") ? tail : `${tail}\n`,
            "utf8",
          );
      }
    } catch {
      /* best effort */
    }
    await unlink(previous).catch(() => undefined);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (isMissing(error)) return 0;
    throw error;
  }
  return removed;
}
export async function prunePersistedData(
  workspace: string,
  retentionDays?: number,
): Promise<number> {
  if (!retentionDays) return 0;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const db = await database(workspace);
  const sqlite = db
    .prepare("DELETE FROM delivery_failures WHERE created_at < ?")
    .run(new Date(cutoff).toISOString()).changes;
  // events 表（SSE 回放源）随保留期清理，与 events.ndjson 轮转互为兜底。
  const removedEvents = db
    .prepare("DELETE FROM events WHERE at < ?")
    .run(new Date(cutoff).toISOString()).changes;
  const removedJobs = await prunePersistedJobs(workspace, db, cutoff);
  const removedOrphans = await pruneOrphanJobDirs(workspace, db);
  return (
    sqlite + removedEvents + removedOrphans + (await pruneDeliveryFailureArtifact(workspace, cutoff)) + removedJobs
  );
}

/**
 * 孤儿目录回收：行已删除（prune 时 rm 失败）或从未写入（createJob 半途崩溃）的
 * `.cbx/jobs/<id>/` 目录此前永不再被扫描。按"目录无 SQLite 行 + mtime 超 1h 宽限"
 * 回收——宽限覆盖 createJob 的 mkdir→写行窗口，不会误删创建中的任务。
 */
async function pruneOrphanJobDirs(workspace: string, db: CbxDatabase): Promise<number> {
  const jobsRoot = path.join(workspace, ".cbx", "jobs");
  let removed = 0;
  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    entries = await readdir(jobsRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  const existing = new Set(
    (db.prepare("SELECT job_id FROM jobs").all() as Array<{ job_id: string }>).map(
      (row) => row.job_id,
    ),
  );
  for (const entry of entries) {
    if (!entry.isDirectory() || existing.has(entry.name)) continue;
    // 非 jobId 形态的目录不碰（人工放置/未知来源），只回收合法 id 的孤儿。
    if (!isSafeJobId(entry.name)) continue;
    const dir = path.join(jobsRoot, entry.name);
    try {
      const info = await stat(dir);
      if (Date.now() - info.mtimeMs < 3_600_000) continue;
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* 单个失败跳过，下次 prune 再试 */
    }
  }
  return removed;
}

/** 非抛出版 jobId 合法性检查（与 assertJobId 同规则）：prune 等批量路径使用。 */
function isSafeJobId(jobId: string): boolean {
  try {
    assertJobId(jobId);
    return true;
  } catch {
    return false;
  }
}

/** 按保留期清理终态 job 的 SQLite 行与任务目录。仅删终态且 updatedAt 早于 cutoff 的 job，
 *  不触碰 running/queued/needs_fix/awaiting_approval 等可继续推进的任务，避免误删活动工作集。 */
async function prunePersistedJobs(
  workspace: string,
  db: CbxDatabase,
  cutoff: number,
): Promise<number> {
  const rows = db.prepare("SELECT job_id, state_json FROM jobs").all() as Array<{
    job_id: string;
    state_json: string;
  }>;
  const TERMINAL: Record<string, true> = {
    done: true,
    failed: true,
    review_failed: true,
    cancelled: true,
  };
  let removed = 0;
  for (const row of rows) {
    let state: { status?: string; updatedAt?: string };
    try {
      state = JSON.parse(row.state_json) as {
        status?: string;
        updatedAt?: string;
      };
    } catch {
      continue;
    }
    if (!state.status || !TERMINAL[state.status]) continue;
    const updatedAt = Date.parse(state.updatedAt ?? "");
    if (!Number.isFinite(updatedAt) || updatedAt >= cutoff) continue;
    db.prepare("DELETE FROM jobs WHERE job_id = ?").run(row.job_id);
    // job_id 来自 DB（legacy 导入只校验过"是字符串"），rm 前必须过 assertJobId——
    // 一行被污染的 "../../x" 会让递归删除打到工作区之外。非法 id 只清行不删目录。
    if (!isSafeJobId(row.job_id)) continue;
    await rm(path.join(workspace, ".cbx", "jobs", row.job_id), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    removed += 1;
  }
  return removed;
}
/** 只读队列 blob（不种子、不重置）：metrics 等纯读路径使用——健康探针不应有写副作用。 */
export function peekQueueBlob(
  db: CbxDatabase,
): { entries?: Array<{ status?: string }> } {
  const row = db
    .prepare("SELECT state_json FROM queue_state WHERE singleton = 1")
    .get() as { state_json: string } | undefined;
  if (!row) return { entries: [] };
  try {
    return JSON.parse(row.state_json) as { entries?: Array<{ status?: string }> };
  } catch {
    return { entries: [] };
  }
}

/**
 * 事件 SQLite 镜像写入失败计数（按 workspace 聚合，进程内存态）。镜像失败时 SSE 回放
 * （读 SQLite events 表）会与该 job 的审计轨迹（events.ndjson）漂移——这是主动接受的
 * 降级，但必须可见。observability.publishEvent 在镜像 catch 中调用本函数；persistedMetrics
 * 读取并暴露给 health / 仪表盘。定义在 storage 而非 observability，避免循环依赖。
 */
