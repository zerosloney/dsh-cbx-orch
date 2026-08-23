/**
 * storage/meta —— metadata 表（键值存储）与事件 seq 分配。
 *
 * 从原 storage.ts 抽出。metadata 表承载幂等键预留、审计 tombstone、legacy 导入标记
 * 与事件 seq（跨进程唯一单调序列，SQLite 行锁保证）。
 */
import { database, databaseReadonly } from "./db.js";
import { now } from "./io.js";
/** 读取 metadata 表中 key 对应的字符串值；不存在返回 undefined。 */
export async function getMetadata(
  workspace: string,
  key: string,
): Promise<string | undefined> {
  const db = await databaseReadonly(workspace);
  const row = db
    .prepare("SELECT value FROM metadata WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

/** 写入 metadata 表（upsert）。 */
export async function setMetadata(
  workspace: string,
  key: string,
  value: string,
): Promise<void> {
  const db = await database(workspace);
  db.prepare(
    "INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/**
 * 原子预留 metadata 键：不存在则写入并返回 true；已存在保持原值返回 false
 * （绝不覆盖）。单条 INSERT OR IGNORE 在 SQLite 写锁下天然串行——幂等键预留、
 * 跨进程互斥标记都靠它保证"只有一方拿到"。
 */
export async function tryReserveMetadata(
  workspace: string,
  key: string,
  value: string,
): Promise<boolean> {
  const db = await database(workspace);
  const result = db
    .prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES (?, ?)")
    .run(key, value);
  return result.changes === 1;
}

/** 删除 metadata 键（幂等预留失败回滚等场景；键不存在是成功）。 */
export async function deleteMetadata(
  workspace: string,
  key: string,
): Promise<void> {
  const db = await database(workspace);
  db.prepare("DELETE FROM metadata WHERE key = ?").run(key);
}

/**
 * 条件替换（CAS）：当前值等于 expectedValue 时才写入 newValue 并返回 true。
 * 单事务内读比写，孤儿接管等"只在状态没被别人动过时才继续"的路径用。
 */
export async function replaceMetadataIfMatch(
  workspace: string,
  key: string,
  expectedValue: string,
  newValue: string,
): Promise<boolean> {
  const db = await database(workspace);
  return db.transaction(() => {
    const row = db
      .prepare("SELECT value FROM metadata WHERE key = ?")
      .get(key) as { value: string } | undefined;
    if (row?.value !== expectedValue) return false;
    db.prepare("UPDATE metadata SET value = ? WHERE key = ?").run(newValue, key);
    return true;
  })();
}

/** 原子自增并返回下一个事件 seq。用 SQLite 单事务保证跨进程唯一：INSERT OR IGNORE 初始化后 UPDATE ... RETURNING 取新值。
 *  并发进程在 SQLite 行锁下串行化，不会读到相同 seq。 */
export async function nextEventSeq(workspace: string): Promise<number> {
  const db = await database(workspace);
  return db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES (?, ?)").run(
      "event_seq",
      "0",
    );
    const raw = (
      db.prepare("SELECT value FROM metadata WHERE key = ?").get("event_seq") as {
        value: string;
      }
    ).value;
    if (!/^\d+$/.test(raw)) {
      // 损坏值经 CAST 归零后 seq 会从 1 重发，与已落盘事件撞号、SSE 游标回放错乱。
      // 以当前时间戳为基线重启单调序列（与历史值大概率不重叠）。
      db.prepare("UPDATE metadata SET value = ? WHERE key = ?").run(
        String(Date.now()),
        "event_seq",
      );
    }
    const row = db
      .prepare(
        "UPDATE metadata SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = ? RETURNING CAST(value AS INTEGER) AS seq",
      )
      .get("event_seq") as { seq: number } | undefined;
    if (!row) throw new Error("event_seq 分配失败：metadata 表可能已损坏。");
    return Number(row.seq);
  })();
}
