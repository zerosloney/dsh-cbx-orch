/**
 * storage/db —— SQLite 连接管理与 schema 迁移。
 *
 * 从原 storage.ts 抽出。WAL 模式 + 读写/只读双连接缓存 + schema_migrations 版本化
 * 迁移（拒绝降级运行）+ legacy 数据导入。所有读写模块经 database()/databaseReadonly()
 * 取连接。
 */
import path from "node:path";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import Database from "better-sqlite3";
import { now, isMissing } from "./io.js";
import { assertJobId } from "../validation.js";

export type CbxDatabase = Database.Database;
// intentional-simple: Promise 缓存保证同 workspace 并发只创建一次连接；创建失败时 reject，
// 不缓存坏 promise，允许下次调用重试。
const databases = new Map<string, Promise<CbxDatabase>>();
// 只读连接：WAL 模式下可安全并发读，不与写连接争抢 prepare/transaction 锁。
const readonlyDatabases = new Map<string, Promise<CbxDatabase>>();
const SCHEMA_VERSION = 6;
function databaseFile(workspace: string): string {
  return path.join(workspace, ".cbx", "state.sqlite");
}
function migrate(db: CbxDatabase): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const version = Number(
    (
      db
        .prepare(
          "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
        )
        .get() as { version: number }
    ).version,
  );
  if (version < 1)
    db.transaction(() => {
      // 并发首开迁移（两进程同读 version=0 各跑一遍）时，CREATE IF NOT EXISTS +
      // INSERT OR IGNORE 让后跑者幂等通过，不再撞 "table already exists" / 主键冲突。
      db.exec(
        "CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS queue_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), state_json TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS delivery_failures (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, record_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS service_leases (name TEXT PRIMARY KEY, owner_pid INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
      );
      db.prepare(
        "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      ).run(1, now());
    })();
  if (version < 2)
    db.transaction(() => {
      db.exec(
        "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      db.prepare(
        "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      ).run(2, now());
    })();
  if (version < 3)
    db.transaction(() => {
      // 列存在性检查：并发迁移时后跑者跳过已加的列（ALTER 无 IF NOT EXISTS）。
      const hasOwnerToken = (
        db
          .prepare(
            "SELECT 1 FROM pragma_table_info('service_leases') WHERE name = 'owner_token'",
          )
          .get() as { "1"?: number } | undefined
      ) !== undefined;
      if (!hasOwnerToken)
        db.exec("ALTER TABLE service_leases ADD COLUMN owner_token TEXT");
      db.exec(
        "CREATE TABLE IF NOT EXISTS delivery_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, channel TEXT NOT NULL, endpoint TEXT NOT NULL, body_json TEXT NOT NULL, config_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, locked_by TEXT, locked_until INTEGER, last_error TEXT); CREATE INDEX IF NOT EXISTS delivery_outbox_available_idx ON delivery_outbox(available_at, id)",
      );
      db.prepare(
        "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      ).run(3, now());
    })();
  if (version < 4)
    db.transaction(() => {
      db.exec(
        "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS events_workspace_seq_idx ON events(workspace, seq)",
      );
      db.prepare(
        "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      ).run(4, now());
    })();
  if (version < 5)
    db.transaction(() => {
      // listJobs / 仪表盘按 updated_at 倒序全表扫描，任务上千后每次 O(n) 排序；
      // 索引让 ORDER BY updated_at DESC 走索引。jobs 行以 job_id 为主键的写路径不受影响。
      db.exec("CREATE INDEX IF NOT EXISTS jobs_updated_at_idx ON jobs(updated_at DESC)");
      db.prepare(
        "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      ).run(5, now());
    })();
  if (version < 6)
    db.transaction(() => {
      // job 级事件镜像进 SQLite（审计权威）：执行器子进程只有文件系统权限、无
      // SQLite 连接，无法篡改 events 表。job_id 列支持按任务过滤查询。
      const hasJobId = (
        db
          .prepare(
            "SELECT 1 FROM pragma_table_info('events') WHERE name = 'job_id'",
          )
          .get() as { "1"?: number } | undefined
      ) !== undefined;
      if (!hasJobId) db.exec("ALTER TABLE events ADD COLUMN job_id TEXT");
      db.exec(
        "CREATE INDEX IF NOT EXISTS events_workspace_job_seq_idx ON events(workspace, job_id, seq)",
      );
      db.prepare(
        "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      ).run(6, now());
    })();
  if (version > SCHEMA_VERSION)
    throw new Error("state.sqlite 的 schema 版本高于当前 cbx，拒绝降级运行。");
}
/** 连接缓存键：win32 下折叠大小写——`D:\X` 与 `d:\x` 是同一个 DB 文件的两个键，
 *  会各自开一条连接（迁移/导入跑两遍、双份 WAL 句柄）。 */
function connectionKey(resolved: string): string {
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export async function database(workspaceInput: string): Promise<CbxDatabase> {
  const workspace = path.resolve(workspaceInput);
  const key = connectionKey(workspace);
  let promise = databases.get(key);
  if (!promise) {
    promise = (async (): Promise<CbxDatabase> => {
      await mkdir(path.join(workspace, ".cbx"), { recursive: true });
      const db = new Database(databaseFile(workspace));
      db.pragma("journal_mode = WAL");
      db.pragma("busy_timeout = 5000");
      migrate(db);
      await importLegacyData(workspace, db);
      return db;
    })();
    databases.set(key, promise);
  }
  try {
    return await promise;
  } catch (error) {
    // 创建失败时不缓存坏 promise，允许后续调用重试。
    databases.delete(key);
    throw error;
  }
}

/** 只读连接：用于纯查询场景。WAL 模式下可与写并发；
 *  文件不存在或 schema 未初始化时回落到读写连接。 */
export async function databaseReadonly(workspaceInput: string): Promise<CbxDatabase> {
  const workspace = path.resolve(workspaceInput);
  const file = databaseFile(workspace);
  // 文件不存在时由写连接负责初始化；不进只读缓存，避免长期持有写连接
  try {
    await stat(file);
  } catch {
    return database(workspace);
  }
  const key = connectionKey(workspace);
  let promise = readonlyDatabases.get(key);
  if (!promise) {
    promise = (async (): Promise<CbxDatabase> => {
      const db = new Database(file, { readonly: true });
      db.pragma("busy_timeout = 5000");
      // schema 尚未初始化时（如测试场景或首次访问）回落到读写连接；
      // 清除只读缓存，下次访问可重新尝试只读连接
      const hasSchema = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'",
        )
        .get() as { name: string } | undefined;
      if (!hasSchema) {
        db.close();
        readonlyDatabases.delete(key);
        return database(workspace);
      }
      return db;
    })();
    readonlyDatabases.set(key, promise);
  }
  try {
    return await promise;
  } catch (error) {
    readonlyDatabases.delete(key);
    throw error;
  }
}

/** 关闭全部缓存连接（写 + 只读），释放文件句柄与 WAL 锁。插件 dispose 时调用。
 *  循环收敛：clear 与 close 之间可能有并发 database() 把新连接塞进已清空的缓存
 *  （HMR 卸载与调度器 tick 并发的典型窗口），这些漏网连接由下一轮循环捕获关闭，
 *  避免每次重载泄漏一套 fd/WAL 句柄。 */
export async function closeDatabaseConnections(): Promise<void> {
  for (;;) {
    const pending = [...databases.values(), ...readonlyDatabases.values()];
    databases.clear();
    readonlyDatabases.clear();
    if (pending.length === 0) return;
    const opened = await Promise.all(
      pending.map((p) => p.catch(() => undefined)),
    );
    for (const db of opened) {
      try {
        db?.close();
      } catch {
        /* 已关闭 */
      }
    }
  }
}

async function importLegacyData(
  workspace: string,
  db: CbxDatabase,
): Promise<void> {
  if (
    db
      .prepare("SELECT value FROM metadata WHERE key = ?")
      .get("legacy_import_v1")
  )
    return;
  // 先异步收集再单事务提交：损坏行跳过并留痕而非致命抛出，避免一条坏记录锁死整个 workspace；
  // 任务、失败记录与幂等标记同事务落盘，崩溃后整体重放，不产生部分导入或重复失败记录。
  const jobRows: Array<{
    jobId: string;
    stateJson: string;
    updatedAt: string;
  }> = [];
  const root = path.join(workspace, ".cbx", "jobs");
  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) entries = [];
    else throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const state = JSON.parse(
        await readFile(path.join(root, entry.name, "state.json"), "utf8"),
      ) as Record<string, unknown>;
      if (typeof state.jobId === "string")
        jobRows.push({
          jobId: state.jobId,
          stateJson: JSON.stringify(state),
          updatedAt: String(state.updatedAt ?? now()),
        });
    } catch (error) {
      if (!isMissing(error))
        console.error(
          `cbx: 跳过无法导入的旧任务 ${entry.name}：${error instanceof Error ? error.message : error}`,
        );
    }
  }
  const failureRows: Array<{ createdAt: string; recordJson: string }> = [];
  try {
    const lines = (
      await readFile(
        path.join(workspace, ".cbx", "delivery-failures.ndjson"),
        "utf8",
      )
    )
      .split(/\r?\n/)
      .filter(Boolean);
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as { at?: string };
        failureRows.push({
          createdAt: record.at ?? now(),
          recordJson: JSON.stringify(record),
        });
      } catch (error) {
        console.error(
          `cbx: 跳过无法解析的旧投递失败记录：${error instanceof Error ? error.message : error}`,
        );
      }
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const insertJob = db.prepare(
    "INSERT OR IGNORE INTO jobs(job_id, state_json, updated_at) VALUES (?, ?, ?)",
  );
  const insertFailure = db.prepare(
    "INSERT INTO delivery_failures(created_at, record_json) VALUES (?, ?)",
  );
  db.transaction(() => {
    // 先抢占导入标记：双进程同时通过外层 metadata 检查时，只有抢到标记的一方执行
    // 导入——delivery_failures 无唯一键，重复导入会产生双份记录。
    const claimed = db
      .prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES ('legacy_import_v1', ?)")
      .run(now());
    if (claimed.changes === 0) return;
    for (const row of jobRows)
      insertJob.run(row.jobId, row.stateJson, row.updatedAt);
    for (const row of failureRows)
      insertFailure.run(row.createdAt, row.recordJson);
  })();
}
