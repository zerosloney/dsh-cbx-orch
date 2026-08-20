import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";
import { normalizeAdaptiveOptions } from "./adaptive-manager.js";
import { assertJobId } from "./validation.js";
import { CbxError, type CbxErrorCode } from "./errors.js";
import type { JobContext } from "./types.js";

export function now(): string {
  return new Date().toISOString();
}

export interface TaskTemplate {
  task: string;
  test?: string;
  review?: boolean;
  executor?: string;
  isolated?: boolean;
}

export interface RuntimeConfig {
  testCommand?: string;
  review?: boolean;
  isolated?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  maxTurns?: number;
  keepWorktree?: boolean;
  permissionMode?: string;
  reviewRules?: string;
  approval?: { beforeRun?: boolean; beforeComplete?: boolean };
  maxConcurrent?: number;
  git?: { autoBranch?: boolean; autoCommit?: boolean; commitMessage?: string };
  ci?: { failOnReview?: boolean };
  executor?: string;
  reviewExecutor?: string;
  /** 执行器路由偏好顺序（内置名/别名）；未知项忽略。缺省 = BUILTIN_EXECUTORS 顺序。 */
  executorPreference?: string[];
  /** 执行器需求：路由层先过滤不满足的执行器（如需要 autoApprove 时排除 omp）。见 executor-router。 */
  executorRequirements?: import("./executor-router.js").ExecutorRequirements;
  /** 执行器路由策略（first-available / capability-best / cost-aware / fastest / round-robin / least-recently-used）。 */
  routingStrategy?: import("./executor-router.js").ExecutorStrategy;
  /**
   * 隔离任务携带未提交改动：`isolated: true` 且工作区有未提交内容时，默认 cbx 拒绝
   * （隔离 worktree 从干净基线创建，带不动脏状态）。`carryDirty: true` 会把当前未提交
   * 改动（已跟踪 diff + 未跟踪文件）复制进隔离 worktree，让隔离任务也能对"进行中的工作"
   * 安全执行（不污染主工作区、也无需先提交）。缺省 false。
   */
  carryDirty?: boolean;
  templates?: Record<string, TaskTemplate>;
  execution?: { trustMode?: "trusted" | "untrusted" };
  plugins?: {
    enforce?: boolean;
    allowPaths?: string[];
    allowSha256?: string[];
  };
  notifications?: {
    webhook?: string;
    timeoutMs?: number;
    maxRetries?: number;
    retryBaseMs?: number;
    filters?: {
      events?: string[];
      jobIds?: string[];
      statuses?: string[];
    };
  };
  telemetry?: {
    enabled?: boolean;
    endpoint?: string;
    serviceName?: string;
    timeoutMs?: number;
    maxRetries?: number;
    retryBaseMs?: number;
  };
  governance?: {
    retentionDays?: number;
    redactFields?: string[];
    redactPatterns?: string[];
  };
  reviewGate?: { enabled?: boolean; failOpen?: boolean };
  adaptive?: {
    enabled?: boolean;
    maxRounds?: number;
    managerExecutor?: string;
  };
  dependencyGuard?: boolean;
  ui?: { token?: string };
  context?: {
    tokenBudget?: { manager?: number; executor?: number; auditor?: number };
  };
  /** 工作区级执行器/测试子进程环境变量白名单。显式配置时优先于插件全局
   *  `executors.envAllowlist`；缺省/未配置时回落到全局（插件 config 或缺省=完整继承）。 */
  executors?: {
    envAllowlist?: string[];
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} 必须是对象。`);
  return value as Record<string, unknown>;
}
function known(
  value: Record<string, unknown>,
  name: string,
  keys: string[],
): void {
  for (const key of Object.keys(value))
    if (!keys.includes(key)) throw new Error(`${name} 不支持字段：${key}`);
}
function optionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "boolean")
    throw new Error(`${name} 必须是布尔值。`);
}
function optionalString(value: unknown, name: string): void {
  if (value !== undefined && (typeof value !== "string" || !value.trim()))
    throw new Error(`${name} 必须是非空字符串。`);
}
function optionalInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): void {
  if (
    value !== undefined &&
    (!Number.isInteger(value) ||
      Number(value) < minimum ||
      Number(value) > maximum)
  )
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 的整数。`);
}

/** Strict runtime validation prevents unknown policy fields from silently weakening controls. */
export async function loadRuntimeConfig(
  workspaceInput: string,
): Promise<RuntimeConfig> {
  const workspace = path.resolve(workspaceInput);
  const file = path.join(workspace, ".cbx.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
  const config = object(parsed, ".cbx.json");
  known(config, ".cbx.json", [
    "testCommand",
    "review",
    "isolated",
    "timeoutMs",
    "maxRetries",
    "maxTurns",
    "keepWorktree",
    "permissionMode",
    "reviewRules",
    "approval",
    "maxConcurrent",
    "git",
    "ci",
    "executor",
    "reviewExecutor",
    "executorPreference",
    "executorRequirements",
    "routingStrategy",
    "carryDirty",
    "execution",
    "plugins",
    "notifications",
    "telemetry",
    "governance",
    "reviewGate",
    "adaptive",
    "dependencyGuard",
    "ui",
    "context",
    "executors",
    "templates",
  ]);
  optionalString(config.testCommand, "testCommand");
  optionalBoolean(config.review, "review");
  optionalBoolean(config.isolated, "isolated");
  optionalInteger(config.timeoutMs, "timeoutMs", 100);
  optionalInteger(config.maxRetries, "maxRetries", 0);
  optionalInteger(config.maxTurns, "maxTurns", 1);
  optionalBoolean(config.keepWorktree, "keepWorktree");
  optionalBoolean(config.carryDirty, "carryDirty");
  optionalString(config.permissionMode, "permissionMode");
  optionalString(config.reviewRules, "reviewRules");
  optionalInteger(config.maxConcurrent, "maxConcurrent", 1);
  optionalString(config.executor, "executor");
  optionalString(config.reviewExecutor, "reviewExecutor");
  if (
    config.executorPreference !== undefined &&
    (!Array.isArray(config.executorPreference) ||
      config.executorPreference.some(
        (item) => typeof item !== "string" || !item.trim(),
      ))
  )
    throw new Error("executorPreference 必须是非空字符串数组。");
  if (config.executorRequirements !== undefined) {
    const v = object(config.executorRequirements, "executorRequirements");
    known(v, "executorRequirements", [
      "autoApprove",
      "planMode",
      "sandbox",
      "headless",
      "maxTurnsSupport",
      "streaming",
      "exclude",
    ]);
    for (const key of [
      "autoApprove",
      "planMode",
      "sandbox",
      "headless",
      "maxTurnsSupport",
      "streaming",
    ] as const)
      optionalBoolean(v[key], `executorRequirements.${key}`);
    if (
      v.exclude !== undefined &&
      (!Array.isArray(v.exclude) ||
        v.exclude.some((item: unknown) => typeof item !== "string" || !String(item).trim()))
    )
      throw new Error("executorRequirements.exclude 必须是非空字符串数组。");
  }
  if (config.routingStrategy !== undefined) {
    const allowed = [
      "first-available",
      "capability-best",
      "cost-aware",
      "fastest",
      "round-robin",
      "least-recently-used",
    ];
    if (typeof config.routingStrategy !== "string" || !allowed.includes(config.routingStrategy))
      throw new Error(`routingStrategy 必须是以下之一：${allowed.join(", ")}。`);
  }
  optionalBoolean(config.dependencyGuard, "dependencyGuard");
  if (config.approval !== undefined) {
    const value = object(config.approval, "approval");
    known(value, "approval", ["beforeRun", "beforeComplete"]);
    optionalBoolean(value.beforeRun, "approval.beforeRun");
    optionalBoolean(value.beforeComplete, "approval.beforeComplete");
  }
  if (config.git !== undefined) {
    const value = object(config.git, "git");
    known(value, "git", ["autoBranch", "autoCommit", "commitMessage"]);
    optionalBoolean(value.autoBranch, "git.autoBranch");
    optionalBoolean(value.autoCommit, "git.autoCommit");
    optionalString(value.commitMessage, "git.commitMessage");
  }
  if (config.ci !== undefined) {
    const value = object(config.ci, "ci");
    known(value, "ci", ["failOnReview"]);
    optionalBoolean(value.failOnReview, "ci.failOnReview");
  }
  if (config.execution !== undefined) {
    const value = object(config.execution, "execution");
    known(value, "execution", ["trustMode"]);
    if (
      value.trustMode !== undefined &&
      value.trustMode !== "trusted" &&
      value.trustMode !== "untrusted"
    )
      throw new Error("execution.trustMode 必须是 trusted 或 untrusted。");
  }
  if (config.plugins !== undefined) {
    const value = object(config.plugins, "plugins");
    known(value, "plugins", ["enforce", "allowPaths", "allowSha256"]);
    optionalBoolean(value.enforce, "plugins.enforce");
    for (const key of ["allowPaths", "allowSha256"] as const)
      if (
        value[key] !== undefined &&
        (!Array.isArray(value[key]) ||
          value[key].some((item) => typeof item !== "string" || !item.trim()))
      )
        throw new Error(`plugins.${key} 必须是非空字符串数组。`);
    const hashes = value.allowSha256 as string[] | undefined;
    if (
      hashes !== undefined &&
      hashes.some((hash) => !/^[a-fA-F0-9]{64}$/.test(hash))
    )
      throw new Error("plugins.allowSha256 必须是 SHA-256 十六进制摘要。");
  }
  for (const [name, fields] of [
    [
      "notifications",
      ["webhook", "timeoutMs", "maxRetries", "retryBaseMs", "filters"],
    ],
    [
      "telemetry",
      [
        "enabled",
        "endpoint",
        "serviceName",
        "timeoutMs",
        "maxRetries",
        "retryBaseMs",
      ],
    ],
  ] as const) {
    const raw = config[name];
    if (raw === undefined) continue;
    const value = object(raw, name);
    known(value, name, fields as unknown as string[]);
    optionalString(value.webhook, "notifications.webhook");
    optionalString(value.endpoint, "telemetry.endpoint");
    optionalBoolean(value.enabled, `${name}.enabled`);
    optionalString(value.serviceName, `${name}.serviceName`);
    if (
      name === "telemetry" &&
      value.enabled === true &&
      value.endpoint === undefined
    )
      throw new Error("telemetry.enabled=true 时必须提供 telemetry.endpoint。");
    optionalInteger(value.timeoutMs, `${name}.timeoutMs`, 50, 120_000);
    optionalInteger(value.maxRetries, `${name}.maxRetries`, 0, 10);
    if (
      value.retryBaseMs !== undefined &&
      (typeof value.retryBaseMs !== "number" || value.retryBaseMs < 0)
    )
      throw new Error(`${name}.retryBaseMs 必须是非负数。`);
    // notifications.filters：webhook 事件订阅过滤（仅 notifications 有）。
    if (name === "notifications" && value.filters !== undefined) {
      const filters = object(value.filters, "notifications.filters");
      known(filters, "notifications.filters", ["events", "jobIds", "statuses"]);
      for (const key of ["events", "jobIds", "statuses"] as const) {
        if (
          filters[key] !== undefined &&
          (!Array.isArray(filters[key]) ||
            filters[key].length < 1 ||
            filters[key].some(
              (item) => typeof item !== "string" || !item.trim(),
            ))
        )
          throw new Error(
            `notifications.filters.${key} 必须是非空字符串数组。`,
          );
      }
    }
  }
  if (config.governance !== undefined) {
    const value = object(config.governance, "governance");
    known(value, "governance", [
      "retentionDays",
      "redactFields",
      "redactPatterns",
    ]);
    optionalInteger(value.retentionDays, "governance.retentionDays", 1, 3650);
    if (
      value.redactFields !== undefined &&
      (!Array.isArray(value.redactFields) ||
        value.redactFields.length > 100 ||
        value.redactFields.some(
          (field) => typeof field !== "string" || !field.trim(),
        ))
    )
      throw new Error("governance.redactFields 必须是最多 100 个非空字符串。");
    // intentional-simple: redactPatterns 只做语法校验（new RegExp 不抛即过），无 catastrophic backtracking 检测；
    // 配置来自工作区所有者（同信任域），ReDoS 风险低。升级路径：引入 safe-regex 类启发式检测。
    if (value.redactPatterns !== undefined) {
      if (
        !Array.isArray(value.redactPatterns) ||
        value.redactPatterns.length > 100
      )
        throw new Error(
          "governance.redactPatterns 必须是最多 100 个正则字符串。",
        );
      for (const pattern of value.redactPatterns) {
        if (typeof pattern !== "string" || !pattern.trim())
          throw new Error("governance.redactPatterns 必须是非空正则字符串。");
        try {
          new RegExp(pattern);
        } catch {
          throw new Error(`governance.redactPatterns 包含无效正则：${pattern}`);
        }
      }
    }
  }
  if (config.reviewGate !== undefined) {
    const value = object(config.reviewGate, "reviewGate");
    known(value, "reviewGate", ["enabled", "failOpen"]);
    optionalBoolean(value.enabled, "reviewGate.enabled");
    optionalBoolean(value.failOpen, "reviewGate.failOpen");
  }
  if (config.adaptive !== undefined) normalizeAdaptiveOptions(config.adaptive);
  if (config.ui !== undefined) {
    const value = object(config.ui, "ui");
    known(value, "ui", ["token"]);
    optionalString(value.token, "ui.token");
  }
  if (config.context !== undefined) {
    const value = object(config.context, "context");
    known(value, "context", ["tokenBudget"]);
    if (value.tokenBudget !== undefined) {
      const budget = object(value.tokenBudget, "context.tokenBudget");
      known(budget, "context.tokenBudget", ["manager", "executor", "auditor"]);
      for (const role of ["manager", "executor", "auditor"] as const)
        optionalInteger(budget[role], `context.tokenBudget.${role}`, 100);
    }
  }
  if (config.executors !== undefined) {
    const value = object(config.executors, "executors");
    known(value, "executors", ["envAllowlist"]);
    if (value.envAllowlist !== undefined) {
      if (
        !Array.isArray(value.envAllowlist) ||
        value.envAllowlist.some(
          (item) => typeof item !== "string" || !item.trim(),
        )
      )
        throw new Error(
          "executors.envAllowlist 必须是非空字符串数组（可留空数组=显式继承宿主 env）。",
        );
    }
  }
  if (config.templates !== undefined) {
    // 任务模板：task 必填非空字符串；可选字段类型校验；未知模板键拒绝（防拼写错误静默失效）。
    const templates = object(config.templates, "templates");
    for (const [name, value] of Object.entries(templates)) {
      const tpl = object(value, `templates.${name}`);
      known(tpl, `templates.${name}`, [
        "task",
        "test",
        "review",
        "executor",
        "isolated",
      ]);
      if (typeof tpl.task !== "string" || !tpl.task.trim())
        throw new Error(`templates.${name}.task 必须是必填的非空字符串。`);
      optionalString(tpl.test, `templates.${name}.test`);
      optionalBoolean(tpl.review, `templates.${name}.review`);
      optionalString(tpl.executor, `templates.${name}.executor`);
      optionalBoolean(tpl.isolated, `templates.${name}.isolated`);
    }
  }
  return config as RuntimeConfig;
}

/**
 * 读取某工作区 `.cbx.json` 的工作区级执行器环境白名单 `executors.envAllowlist`。
 *
 * 返回语义（三值，供上层区分"覆盖"与"回落"）：
 *  - `{ configured: false, allowlist: undefined }`：`.cbx.json` 缺失或没有顶层 `executors`
 *    对象 → 上层应回落到插件全局白名单（或缺省=完整继承宿主 env）。
 *  - `{ configured: true, allowlist: [...] }`：工作区显式配置了白名单（可含空数组，
 *    空数组 = 显式"只继承系统变量，过滤全部凭据"，或按上层语义处理）。
 * 字段类型/格式已在 `loadRuntimeConfig` 校验，此 helper 做严格二次校验以防半损坏文件。
 */
export async function loadRuntimeExecutorsAllowlist(
  workspaceInput: string,
): Promise<{ configured: boolean; allowlist: string[] | undefined }> {
  const workspace = path.resolve(workspaceInput);
  const file = path.join(workspace, ".cbx.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (isMissing(error)) return { configured: false, allowlist: undefined };
    throw error;
  }
  const config = object(parsed, ".cbx.json");
  // 加载路径严格校验（与 loadRuntimeConfig 同规则），确保配置不因新字段漂移静默失效。
  if (config.executors === undefined)
    return { configured: false, allowlist: undefined };
  const executors = object(config.executors, "executors");
  known(executors, "executors", ["envAllowlist"]);
  if (executors.envAllowlist === undefined)
    return { configured: true, allowlist: [] };
  if (
    !Array.isArray(executors.envAllowlist) ||
    executors.envAllowlist.some(
      (item) => typeof item !== "string" || !item.trim(),
    )
  )
    throw new Error(
      "executors.envAllowlist 必须是非空字符串数组（可留空数组=显式继承宿主 env）。",
    );
  return { configured: true, allowlist: [...executors.envAllowlist] };
}

// 默认敏感字段名：governance.redactFields 未配置时仍对常见密钥字段脱敏，
// 避免结构化事件（events.ndjson / delivery-failures.ndjson）原样落盘密钥。
const DEFAULT_SENSITIVE_FIELDS = [
  "token",
  "password",
  "secret",
  "apikey",
  "api_key",
  "authorization",
  "privatekey",
  "private_key",
  "credentials",
  "accesskey",
  "access_key",
];

export function redactSensitive(
  value: unknown,
  fields: readonly string[] = [],
): unknown {
  const sensitive = new Set(
    (fields.length > 0 ? fields : DEFAULT_SENSITIVE_FIELDS).map((field) =>
      field.toLowerCase(),
    ),
  );
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).map(([key, child]) => [
        key,
        sensitive.has(key.toLowerCase()) ? "[REDACTED]" : visit(child),
      ]),
    );
  };
  return visit(value);
}

// intentional-simple: 行级键名匹配用单一正则覆盖 `key: v` / `- key: v` / `key = v` 三种形态。
// 抓不到句中内嵌密钥（如 "use sk-xxx here"）；由 redactPatterns 全文正则兜底。
const KEY_LINE =
  /^\s*([-*]\s+)?([\p{L}\p{N}_][\p{L}\p{N}_\s-]*?)\s*[:=]\s*(.+)$/u;

// 常见凭据形状的全文兜底正则（字符串形式，供 new RegExp 使用）。行级键名正则
// KEY_LINE 抓不到句中内嵌密钥（如 "use sk-xxx here"），无论 governance.redactPatterns
// 是否配置都叠加这些，关闭 inline 凭据的落盘/上下文泄漏面。
const DEFAULT_REDACT_PATTERNS: string[] = [
  "sk-[A-Za-z0-9_\\-]{16,}",
  "gh[pousr]_[A-Za-z0-9]{20,}",
  // 细粒度 PAT（github_pat_ 前缀）与经典 ghp_/gho_/ghu_/ghs_/ghr_ 形状不同，单列。
  "github_pat_[A-Za-z0-9_]{20,}",
  "xox[baprs]-[A-Za-z0-9\\-]{10,}",
  "AIza[0-9A-Za-z_\\-]{30,}",
  "AKIA[0-9A-Z]{16}",
  "-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\\s\\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----",
  "Bearer\\s+[A-Za-z0-9._~+/\\-=]{20,}",
];

export function redactText(
  text: string,
  fields: readonly string[] = [],
  patterns: readonly string[] = [],
): string {
  const sensitive = new Set(fields.map((field) => field.toLowerCase()));
  let out = text;
  if (sensitive.size > 0) {
    out = text
      .split("\n")
      .map((line) => {
        const match = line.match(KEY_LINE);
        if (!match) return line;
        const key = match[2].trim().toLowerCase();
        return sensitive.has(key)
          ? `${match[1] ?? ""}${match[2].trim()}: [REDACTED]`
          : line;
      })
      .join("\n");
  }
  for (const pattern of [...DEFAULT_REDACT_PATTERNS, ...patterns])
    out = out.replace(new RegExp(pattern, "g"), "[REDACTED]");
  return out;
}

type CbxDatabase = Database.Database;
// intentional-simple: Promise 缓存保证同 workspace 并发只创建一次连接；创建失败时 reject，
// 不缓存坏 promise，允许下次调用重试。
const databases = new Map<string, Promise<CbxDatabase>>();
// 只读连接：WAL 模式下可安全并发读，不与写连接争抢 prepare/transaction 锁。
const readonlyDatabases = new Map<string, Promise<CbxDatabase>>();
const SCHEMA_VERSION = 4;
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
      db.exec(
        "CREATE TABLE jobs (job_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE queue_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), state_json TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE delivery_failures (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, record_json TEXT NOT NULL); CREATE TABLE service_leases (name TEXT PRIMARY KEY, owner_pid INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
      );
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      ).run(1, now());
    })();
  if (version < 2)
    db.transaction(() => {
      db.exec(
        "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      ).run(2, now());
    })();
  if (version < 3)
    db.transaction(() => {
      db.exec("ALTER TABLE service_leases ADD COLUMN owner_token TEXT");
      db.exec(
        "CREATE TABLE delivery_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, channel TEXT NOT NULL, endpoint TEXT NOT NULL, body_json TEXT NOT NULL, config_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, locked_by TEXT, locked_until INTEGER, last_error TEXT); CREATE INDEX delivery_outbox_available_idx ON delivery_outbox(available_at, id)",
      );
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      ).run(3, now());
    })();
  if (version < 4)
    db.transaction(() => {
      db.exec(
        "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, at TEXT NOT NULL); CREATE INDEX events_workspace_seq_idx ON events(workspace, seq)",
      );
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      ).run(4, now());
    })();
  if (version > SCHEMA_VERSION)
    throw new Error("state.sqlite 的 schema 版本高于当前 cbx，拒绝降级运行。");
}
/** 连接缓存键：win32 下折叠大小写——`D:\X` 与 `d:\x` 是同一个 DB 文件的两个键，
 *  会各自开一条连接（迁移/导入跑两遍、双份 WAL 句柄）。 */
function connectionKey(resolved: string): string {
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function database(workspaceInput: string): Promise<CbxDatabase> {
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
async function databaseReadonly(workspaceInput: string): Promise<CbxDatabase> {
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
/** 队列 blob 的统一容错读取：损坏 JSON 重置为空队列而不是抛错——jobs 表同款
 *  容错策略。一条坏 blob 打挂 forget/finish/approve/load 全部队列操作，比丢一个
 *  可重建的队列视图严重得多（任务状态本身在 jobs 表里，不受影响）。 */
function readQueueBlob(
  db: CbxDatabase,
): { entries?: Array<Record<string, unknown>> } & Record<string, unknown> {
  const row = db
    .prepare("SELECT state_json FROM queue_state WHERE singleton = 1")
    .get() as { state_json: string } | undefined;
  if (row) {
    try {
      return JSON.parse(row.state_json) as ReturnType<typeof readQueueBlob>;
    } catch (error) {
      console.error(
        `cbx: queue_state 损坏（${error instanceof Error ? error.message : String(error)}），重置为空队列。`,
      );
    }
  }
  const fresh = { maxConcurrent: 2, paused: false, entries: [], updatedAt: now() };
  db.prepare(
    "INSERT INTO queue_state(singleton, state_json, updated_at) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
  ).run(JSON.stringify(fresh), now());
  return fresh;
}

async function legacyQueue(
  workspace: string,
  db: CbxDatabase,
  fallback: unknown,
): Promise<unknown> {
  const existing = db
    .prepare("SELECT state_json FROM queue_state WHERE singleton = 1")
    .get() as { state_json: string } | undefined;
  if (!existing) {
    // 首次开库：尝试从 legacy queue.json 种子；文件损坏（非 ENOENT 的解析失败）
    // 落回默认值而不是抛错，否则整个工作区的队列操作被一个坏文件砖死。
    const file = path.join(workspace, ".cbx", "queue.json");
    let value = fallback;
    try {
      value = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (!isMissing(error))
        console.error(
          `cbx: legacy queue.json 损坏（${error instanceof Error ? error.message : String(error)}），使用默认空队列。`,
        );
    }
    db.prepare(
      "INSERT OR IGNORE INTO queue_state(singleton, state_json, updated_at) VALUES (1, ?, ?)",
    ).run(JSON.stringify(value), now());
  }
  // 统一走容错读取：种子竞态中抢到的行、或已存在的损坏 blob 都在此归一。
  return readQueueBlob(db);
}

export async function loadPersistedState<T>(
  workspace: string,
  jobId: string,
): Promise<T | undefined> {
  const db = await databaseReadonly(workspace);
  const row = db
    .prepare("SELECT state_json FROM jobs WHERE job_id = ?")
    .get(jobId) as { state_json: string } | undefined;
  return row ? (JSON.parse(row.state_json) as T) : undefined;
}
export async function savePersistedState(
  workspace: string,
  jobId: string,
  value: unknown,
): Promise<void> {
  const db = await database(workspace);
  db.prepare(
    "INSERT INTO jobs(job_id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
  ).run(jobId, JSON.stringify(value), now());
}
/**
 * 乐观并发写（CAS）：仅当 jobs 行内容仍是 `expected` 的序列化形态时才写入，
 * 否则返回 false——调用方应重读最新状态、重放自己的 updates 后重试。
 * 用于非终态的解锁写路径（writeState/bumpInvocationCount 等）：这些路径不走
 * 队列锁，与调度器/其他写者的整 blob 写回并发时按 CAS 收敛，不再互相回退
 * 对方快照。行不存在时（首个写者）直接插入并返回 true。
 */
export async function savePersistedStateCas(
  workspace: string,
  jobId: string,
  expected: unknown,
  value: unknown,
): Promise<boolean> {
  const db = await database(workspace);
  const expectedJson = JSON.stringify(expected);
  const updated = db
    .prepare(
      "UPDATE jobs SET state_json = ?, updated_at = ? WHERE job_id = ? AND state_json = ?",
    )
    .run(JSON.stringify(value), now(), jobId, expectedJson);
  if (updated.changes === 1) return true;
  const exists = db.prepare("SELECT 1 FROM jobs WHERE job_id = ?").get(jobId);
  if (!exists) {
    db.prepare(
      "INSERT INTO jobs(job_id, state_json, updated_at) VALUES (?, ?, ?)",
    ).run(jobId, JSON.stringify(value), now());
    return true;
  }
  return false;
}
export async function listPersistedStates<T>(workspace: string): Promise<T[]> {
  const db = await databaseReadonly(workspace);
  const rows = db
    .prepare("SELECT state_json FROM jobs ORDER BY updated_at DESC")
    .all() as Array<{ state_json: string }>;
  // 单条损坏的 state_json 不应拖垮整个 listJobs/health：跳过坏行保持其他 job 可见，
  // 与 importLegacyData 的损坏行跳过策略一致；恢复需 cbx forget 后重建。
  const out: T[] = [];
  for (const row of rows) {
    try {
      out.push(JSON.parse(row.state_json) as T);
    } catch {
      /* skip corrupt row */
    }
  }
  return out;
}

/**
 * 单事务删除 jobId 在持久化层（jobs 表 + queue_state entries）的全部记录。
 *
 * 与 `queue.cancelQueueEntries` 不同：cancel 是把 active entries 标 cancelled（审计可见），
 * forget 是把同 jobId 的所有 entries 物理过滤掉。两者串联——上层先 cancel 杀活 worker
 * 并持久化 cancelled 状态，再 forget 清掉 entries 残留，**单事务**确保 jobs 行删和
 * queue entries 删要么都成功要么都回滚，避免 listJobs 看不见但 queue 还残留的撕裂状态。
 *
 * 返回剩余 queue 长度供上层做断言与日志。
 */
export async function forgetPersistedJob(
  workspaceInput: string,
  jobId: string,
): Promise<{ deletedJob: boolean; remainingEntries: number }> {
  const workspace = path.resolve(workspaceInput);
  const db = await database(workspace);
  return withQueueLock(workspace, async () => {
    let deletedJob = false;
    let remainingEntries = 0;
    db.transaction(() => {
      const result = db
        .prepare("DELETE FROM jobs WHERE job_id = ?")
        .run(jobId);
      deletedJob = result.changes > 0;
      const row = db
        .prepare("SELECT state_json FROM queue_state WHERE singleton = 1")
        .get() as { state_json: string } | undefined;
      if (row) {
        const queue = JSON.parse(row.state_json) as {
          entries?: Array<{ jobId?: string; [k: string]: unknown }>;
        };
        const before = queue.entries?.length ?? 0;
        const filtered = (queue.entries ?? []).filter(
          (entry) => entry.jobId !== jobId,
        );
        remainingEntries = filtered.length;
        if (before !== filtered.length) {
          db.prepare(
            "UPDATE queue_state SET state_json = ?, updated_at = ? WHERE singleton = 1",
          ).run(JSON.stringify({ ...queue, entries: filtered }), now());
        }
      }
    })();
    return { deletedJob, remainingEntries };
  });
}

export async function loadPersistedQueue<T>(
  workspace: string,
  fallback: T,
): Promise<T> {
  return (await legacyQueue(
    path.resolve(workspace),
    await database(workspace),
    fallback,
  )) as T;
}
// intentional-simple: queue_state 整 blob 读写（每次入队/状态变更全量反序列化+序列化+写回）。
// 单 workspace 队列规模小（通常 <100 entry），开销可忽略；升级路径：queue 条目独立行存储 + 增量更新。
export async function savePersistedQueue(
  workspace: string,
  value: unknown,
): Promise<void> {
  const db = await database(workspace);
  db.prepare(
    "INSERT INTO queue_state(singleton, state_json, updated_at) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
  ).run(JSON.stringify(value), now());
}
export async function savePersistedStateAndQueue(
  workspace: string,
  jobId: string,
  state: unknown,
  queue: unknown,
): Promise<void> {
  const db = await database(workspace);
  await legacyQueue(path.resolve(workspace), db, { entries: [] });
  db.transaction(() => {
    db.prepare(
      "INSERT INTO jobs(job_id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
    ).run(jobId, JSON.stringify(state), now());
    db.prepare(
      "UPDATE queue_state SET state_json = ?, updated_at = ? WHERE singleton = 1",
    ).run(JSON.stringify(queue), now());
  })();
}
export async function savePersistedStateAndFinishQueue(
  workspace: string,
  jobId: string,
  state: Record<string, unknown>,
  queueId: string,
): Promise<void> {
  const db = await database(workspace);
  await legacyQueue(path.resolve(workspace), db, { entries: [] });
  db.transaction(() => {
    const queue = readQueueBlob(db);
    const entry = queue.entries?.find((item) => item.queueId === queueId);
    if (entry) {
      const status = String(state.status);
      entry.status =
        status === "done"
          ? "done"
          : status === "cancelled"
            ? "cancelled"
            : status === "awaiting_approval"
              ? "awaiting_approval"
              : status === "needs_fix" || status === "review_failed"
                ? "needs_fix"
                : "failed";
      entry.finishedAt = now();
      entry.pid = undefined;
    }
    db.prepare(
      "INSERT INTO jobs(job_id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
    ).run(jobId, JSON.stringify(state), now());
    db.prepare(
      "UPDATE queue_state SET state_json = ?, updated_at = ? WHERE singleton = 1",
    ).run(JSON.stringify(queue), now());
  })();
}
export async function savePersistedStateAndResolveApprovalQueue(
  workspace: string,
  jobId: string,
  state: Record<string, unknown>,
  queueStatus: "done" | "failed",
): Promise<void> {
  const db = await database(workspace);
  await legacyQueue(path.resolve(workspace), db, { entries: [] });
  db.transaction(() => {
    const queue = readQueueBlob(db);
    for (const entry of queue.entries ?? []) {
      if (entry.jobId === jobId && entry.status === "awaiting_approval") {
        entry.status = queueStatus;
        entry.finishedAt = now();
        entry.pid = undefined;
      }
    }
    db.prepare(
      "INSERT INTO jobs(job_id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
    ).run(jobId, JSON.stringify(state), now());
    db.prepare(
      "UPDATE queue_state SET state_json = ?, updated_at = ? WHERE singleton = 1",
    ).run(JSON.stringify(queue), now());
  })();
}
/**
 * before_run 审批通过的原子重入队：状态回 queued 与 awaiting_approval 队列条目
 * 重新激活（置 queued、清 finishedAt/pid）在同一事务落盘。原实现的"条目置 done +
 * 调用方再补 startBackground"两段式，在两步之间崩溃会留下 state=queued 但无活跃
 * 队列条目的断层——调度器只看条目，这样的任务永远不会被再次派发。
 */
export async function saveApprovalRequeue(
  workspace: string,
  jobId: string,
  state: Record<string, unknown>,
): Promise<void> {
  const db = await database(workspace);
  await legacyQueue(path.resolve(workspace), db, { entries: [] });
  db.transaction(() => {
    const queue = readQueueBlob(db);
    for (const entry of queue.entries ?? []) {
      if (entry.jobId === jobId && entry.status === "awaiting_approval") {
        entry.status = "queued";
        delete entry.finishedAt;
        entry.pid = undefined;
      }
    }
    db.prepare(
      "INSERT INTO jobs(job_id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
    ).run(jobId, JSON.stringify(state), now());
    db.prepare(
      "UPDATE queue_state SET state_json = ?, updated_at = ? WHERE singleton = 1",
    ).run(JSON.stringify(queue), now());
  })();
}
export async function recordDeliveryFailure(
  workspace: string,
  value: unknown,
): Promise<void> {
  const db = await database(workspace);
  db.prepare(
    "INSERT INTO delivery_failures(created_at, record_json) VALUES (?, ?)",
  ).run(now(), JSON.stringify(value));
}

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

/** 工作区事件的 SQLite 镜像写入：与 events.ndjson 双写（ndjson 仍是 tailer 的实时
 *  源与审计轨迹），SSE 回放 / timeline 改走索引查询，不再每次连接整读 O(文件)。 */
export async function insertEvent(
  workspace: string,
  seq: number,
  type: string,
  payload: unknown,
): Promise<void> {
  const db = await database(workspace);
  const event = payload as { at?: unknown };
  db.prepare(
    "INSERT INTO events(workspace, seq, type, payload_json, at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    workspace,
    seq,
    type,
    JSON.stringify(payload),
    typeof event.at === "string" ? event.at : now(),
  );
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

export interface PendingDelivery {
  id: number;
  channel: "webhook" | "otlp";
  endpoint: string;
  body: unknown;
  config: { timeoutMs?: number; maxRetries?: number; retryBaseMs?: number };
  attempts: number;
}

export async function enqueueDelivery(
  workspace: string,
  delivery: Omit<PendingDelivery, "id" | "attempts">,
): Promise<number> {
  const db = await database(workspace);
  const result = db
    .prepare(
      "INSERT INTO delivery_outbox(created_at, channel, endpoint, body_json, config_json, attempts, available_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    )
    .run(
      now(),
      delivery.channel,
      delivery.endpoint,
      JSON.stringify(delivery.body),
      JSON.stringify(delivery.config),
      Date.now(),
    );
  return Number(result.lastInsertRowid);
}

export async function claimPendingDelivery(
  workspace: string,
  owner: string,
  lockMs = 30_000,
): Promise<PendingDelivery | undefined> {
  const db = await database(workspace);
  return db.transaction(() => {
    const current = Date.now();
    const row = db
      .prepare(
        "SELECT id, channel, endpoint, body_json, config_json, attempts FROM delivery_outbox WHERE available_at <= ? AND (locked_until IS NULL OR locked_until < ?) ORDER BY id LIMIT 1",
      )
      .get(current, current) as
      | {
          id: number;
          channel: "webhook" | "otlp";
          endpoint: string;
          body_json: string;
          config_json: string;
          attempts: number;
        }
      | undefined;
    if (!row) return undefined;
    const claimed = db
      .prepare(
        "UPDATE delivery_outbox SET locked_by = ?, locked_until = ? WHERE id = ? AND (locked_until IS NULL OR locked_until < ?)",
      )
      .run(owner, current + lockMs, row.id, current).changes;
    if (!claimed) return undefined;
    return {
      id: row.id,
      channel: row.channel,
      endpoint: row.endpoint,
      body: JSON.parse(row.body_json),
      config: JSON.parse(row.config_json),
      attempts: row.attempts,
    };
  })();
}

export async function rescheduleDelivery(
  workspace: string,
  id: number,
  owner: string,
  attempts: number,
  availableAt: number,
  error: string,
): Promise<void> {
  const db = await database(workspace);
  db.prepare(
    "UPDATE delivery_outbox SET attempts = ?, available_at = ?, last_error = ?, locked_by = NULL, locked_until = NULL WHERE id = ? AND locked_by = ?",
  ).run(attempts, availableAt, error, id, owner);
}

export async function completeDelivery(
  workspace: string,
  id: number,
  owner: string,
): Promise<void> {
  const db = await database(workspace);
  db.prepare("DELETE FROM delivery_outbox WHERE id = ? AND locked_by = ?").run(
    id,
    owner,
  );
}

export async function nextPendingDeliveryAt(
  workspace: string,
): Promise<number | undefined> {
  const db = await database(workspace);
  const row = db
    .prepare(
      "SELECT MIN(CASE WHEN locked_until IS NOT NULL AND locked_until > ? THEN locked_until ELSE available_at END) AS available_at FROM delivery_outbox",
    )
    .get(Date.now()) as { available_at: number | null };
  return row.available_at ?? undefined;
}
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
function peekQueueBlob(
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
const eventMirrorFailures = new Map<string, number>();
/** 有界：防止长期运行/大量工作区时该诊断 Map 无限增长。超过上限丢弃最旧条目。 */
const EVENT_MIRROR_FAILURES_MAX = 64;

/** 累计一次某 workspace 的事件镜像失败（幂等计数）。 */
export function recordEventMirrorFailure(workspace: string): void {
  eventMirrorFailures.set(workspace, (eventMirrorFailures.get(workspace) ?? 0) + 1);
  // intentional-simple: 线性淘汰最旧条目，条目数远小于 64 时无感知；需按 LRU 淘汰时再升级。
  if (eventMirrorFailures.size > EVENT_MIRROR_FAILURES_MAX) {
    const oldest = eventMirrorFailures.keys().next().value as string | undefined;
    if (oldest !== undefined) eventMirrorFailures.delete(oldest);
  }
}

export async function persistedMetrics(workspace: string): Promise<{
  jobsByStatus: Record<string, number>;
  queueDepth: number;
  failedJobs: number;
  retryingJobs: number;
  deliveryFailures: number;
  pendingDeliveries: number;
  /** 事件 SQLite 镜像写入失败累计次数（本进程内存态）；>0 说明 SSE 回放可能
   *  与 events.ndjson 审计轨迹漂移。跨进程/重启后归零，仅作近期漂移信号。 */
  eventMirrorFailures: number;
}> {
  const db = await database(workspace);
  const rows = db.prepare("SELECT state_json FROM jobs").all() as Array<{
    state_json: string;
  }>;
  const jobsByStatus: Record<string, number> = {};
  let retryingJobs = 0;
  for (const row of rows) {
    // 单条损坏的 state_json 不应打挂 metrics/health：与 listPersistedStates 相同的
    // 容错策略跳过坏行，计数归入 unknown 保持总数可见。
    let state: { status?: string; phase?: string };
    try {
      state = JSON.parse(row.state_json) as { status?: string; phase?: string };
    } catch {
      jobsByStatus.unknown = (jobsByStatus.unknown ?? 0) + 1;
      continue;
    }
    const status = state.status ?? "unknown";
    jobsByStatus[status] = (jobsByStatus[status] ?? 0) + 1;
    if (state.phase === "retrying") retryingJobs += 1;
  }
  const queue = peekQueueBlob(db);
  return {
    jobsByStatus,
    queueDepth: (queue.entries ?? []).filter((entry) =>
      ["queued", "running", "awaiting_approval"].includes(String(entry.status)),
    ).length,
    failedJobs: jobsByStatus.failed ?? 0,
    retryingJobs,
    deliveryFailures: Number(
      (
        db.prepare("SELECT COUNT(*) AS count FROM delivery_failures").get() as {
          count: number;
        }
      ).count,
    ),
    pendingDeliveries: Number(
      (
        db.prepare("SELECT COUNT(*) AS count FROM delivery_outbox").get() as {
          count: number;
        }
      ).count,
    ),
    eventMirrorFailures: eventMirrorFailures.get(workspace) ?? 0,
  };
}

export interface ServiceLease {
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

export async function acquireServiceLease(
  workspace: string,
  name: string,
  ttlMs = 45_000,
): Promise<ServiceLease> {
  const db = await database(workspace);
  const token = randomBytes(16).toString("hex");
  const acquire = db.transaction(() => {
    const current = Date.now();
    const lease = db
      .prepare(
        "SELECT owner_pid, expires_at FROM service_leases WHERE name = ?",
      )
      .get(name) as { owner_pid: number; expires_at: number } | undefined;
    // 同进程旧实例的租约允许接管（HMR 重载场景）：新模块实例抢走 owner_token 后，
    // 旧实例的下一次 renew 会因 token 不匹配返回 false 而自动停止——同进程内
    // 双调度器最多并存一个租约周期，跨进程仍严格互斥。
    if (
      lease &&
      lease.expires_at > current &&
      lease.owner_pid !== process.pid &&
      processAlive(lease.owner_pid)
    )
      throw new CbxError(
        "E_LEASE_HELD",
        "已有活跃 serve 实例；每个工作区只允许一个常驻调度器。",
      );
    db.prepare(
      "INSERT INTO service_leases(name, owner_pid, expires_at, owner_token) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET owner_pid = excluded.owner_pid, expires_at = excluded.expires_at, owner_token = excluded.owner_token",
    ).run(name, process.pid, current + ttlMs, token);
  });
  acquire();
  return {
    async renew(): Promise<boolean> {
      return (
        db
          .prepare(
            "UPDATE service_leases SET expires_at = ? WHERE name = ? AND owner_token = ?",
          )
          .run(Date.now() + ttlMs, name, token).changes === 1
      );
    },
    async release(): Promise<void> {
      db.prepare(
        "DELETE FROM service_leases WHERE name = ? AND owner_token = ?",
      ).run(name, token);
    },
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function replaceFile(source: string, target: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (
        !new Set(["EACCES", "EPERM", "EBUSY"]).has(String(code)) ||
        attempt === 4
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** Write a complete file in the destination directory, fsync it, then atomically replace the destination. */
export async function atomicWriteFile(
  file: string,
  contents: string,
): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await replaceFile(temporary, file);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

export async function saveJson(file: string, value: unknown): Promise<void> {
  await atomicWriteFile(file, JSON.stringify(value, null, 2) + "\n");
}

/** A fallback is used only when the file does not exist. Corrupt JSON always remains visible to callers. */
export async function loadJson<T>(file: string, fallback?: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if (fallback !== undefined && isMissing(error)) return fallback;
    throw error;
  }
}

export function processAlive(pid?: number): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

interface LockRecord {
  pid?: number;
  acquiredAt?: string;
  token?: string;
}

/** 判定锁文件是否可回收：存活 pid 永远持有锁；死 pid 或超龄（acquiredAt 缺失时退回 mtime）视为过期。导出供测试覆盖各分支。 */
export async function staleLock(
  file: string,
  staleAfterMs: number,
): Promise<boolean> {
  let record: LockRecord = {};
  let modifiedAt = 0;
  try {
    const [body, info] = await Promise.all([
      readFile(file, "utf8"),
      stat(file),
    ]);
    modifiedAt = info.mtimeMs;
    record = JSON.parse(body) as LockRecord;
  } catch (error) {
    if (isMissing(error)) return false;
    try {
      modifiedAt = (await stat(file)).mtimeMs;
    } catch {
      return false;
    }
  }
  // A live PID always owns the lock, even if a long-running operation exceeds staleAfterMs.
  if (processAlive(record.pid)) return false;
  const acquiredAt = Date.parse(String(record.acquiredAt ?? ""));
  const ageBase = Number.isFinite(acquiredAt) ? acquiredAt : modifiedAt;
  return Boolean(record.pid) || Date.now() - ageBase >= staleAfterMs;
}

async function reclaimLock(file: string): Promise<boolean> {
  const staleName = `${file}.stale.${process.pid}.${randomBytes(5).toString("hex")}`;
  try {
    await rename(file, staleName);
  } catch (error) {
    if (isMissing(error)) return true; // file 已被他人回收，外层立即重试 open(wx)
    return false;
  }
  // 防双持有：rename 后重新校验锁内容——若显示活 pid（staleLock→reclaim 间被他人重新 acquire），
  // 放回原位放弃回收。把双持有窗口从含 await 的 staleLock→reclaim 缩小到本地 read+pid 探测。
  // 最坏情况是 lockfile 内容短暂错乱（被旧死锁记录覆盖），后续 staleLock 自愈，不导致双持有。
  try {
    const record = JSON.parse(await readFile(staleName, "utf8")) as LockRecord;
    if (processAlive(record.pid)) {
      try {
        await rename(staleName, file);
      } catch {
        await unlink(staleName).catch(() => undefined);
      }
      return false;
    }
  } catch {
    /* 内容缺失/损坏：按可回收处理 */
  }
  await unlink(staleName).catch(() => undefined);
  return true;
}

// intentional-simple: SIGKILL（不可捕获信号）后锁文件残留，依赖 staleAfterMs（默认 30s）回收——
// 文件锁固有局限；完全消除需改用 flock 或 SQLite 事务（跨进程互斥由内核/DB 保证）。
export async function withFileLock<T>(
  file: string,
  action: () => Promise<T>,
  options: {
    retries?: number;
    retryDelayMs?: number;
    staleAfterMs?: number;
    busyMessage?: string;
    busyCode?: CbxErrorCode;
  } = {},
): Promise<T> {
  const retries = options.retries ?? 40;
  const retryDelayMs = options.retryDelayMs ?? 50;
  const staleAfterMs = options.staleAfterMs ?? 30_000;
  await mkdir(path.dirname(file), { recursive: true });
  const token = randomBytes(12).toString("hex");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; !handle; attempt += 1) {
    try {
      const acquired = await open(file, "wx", 0o600);
      try {
        await acquired.writeFile(
          JSON.stringify({ pid: process.pid, acquiredAt: now(), token }),
          "utf8",
        );
        await acquired.sync();
        handle = acquired;
      } catch (error) {
        // 锁记录写失败（ENOSPC 等）：残留文件可能是空或半截 JSON——半截若含 pid，
        // "活 pid 持锁"规则会让它永久不可回收（整个队列冻结）。必须当场关闭句柄
        // 并清掉这个只有自己可能持有的 wx 文件。
        await acquired.close().catch(() => undefined);
        await unlink(file).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await staleLock(file, staleAfterMs)) && (await reclaimLock(file)))
        continue;
      if (attempt >= retries)
        throw new CbxError(
          options.busyCode ?? "E_LOCK_BUSY",
          options.busyMessage ?? "锁正在被另一个进程持有，请稍后重试。",
        );
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  try {
    return await action();
  } finally {
    // close 失败（win32 EBUSY 等）不能掩盖 action 结果，也不能跳过 token 校验释放。
    try {
      await handle.close();
    } catch {
      /* fd 已失效 */
    }
    try {
      const current = JSON.parse(await readFile(file, "utf8")) as LockRecord;
      if (current.token === token) await unlink(file);
    } catch {
      /* replaced or already released */
    }
  }
}

/** 队列写互斥的唯一来源：调度器整 blob 写回与 worker 终态双写必须共用同一把锁，否则会互相覆盖。 */
export function queueLockFile(workspace: string): string {
  return path.join(workspace, ".cbx", "queue.lock");
}

/**
 * 强制回收"本进程持有"的文件锁。仅当锁记录 pid === process.pid 时删除：同进程的
 * 锁持有者要么是已死的 worker（finally 已释放、属泄漏残留），要么是事件循环阻塞
 * 的僵尸（永远不会走到释放路径）——两者都无法通过 staleLock 的"活 pid 持锁"规则
 * 回收。跨进程锁仍严格交给 staleLock/pid 存活判定，不受此函数影响。
 */
export async function forceReleaseOwnLock(file: string): Promise<boolean> {
  try {
    const record = JSON.parse(await readFile(file, "utf8")) as LockRecord;
    if (record.pid !== process.pid) return false;
    await unlink(file);
    return true;
  } catch {
    return false;
  }
}

export function withQueueLock<T>(
  workspace: string,
  action: () => Promise<T>,
  options: { retries?: number } = {},
): Promise<T> {
  return withFileLock(queueLockFile(workspace), action, {
    retries: options.retries ?? 40,
    busyMessage: "队列正在被另一个调度器更新，请稍后重试。",
    busyCode: "E_QUEUE_BUSY",
  });
}

/** 常量时间字符串比较：两侧先各取 SHA-256 再 timingSafeEqual，同时规避长度泄漏与逐字节时序差异。 */
export function constantTimeEqual(actual: string, expected: string): boolean {
  const left = createHash("sha256").update(actual, "utf8").digest();
  const right = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(left, right);
}

// ---- context.json schema 校验：必填字段缺失或类型错误即拒绝加载，避免半损坏上下文在执行中途引发不可预期行为 ----

function contextFieldError(field: string, expectation: string): CbxError {
  return new CbxError(
    "E_INVALID_CONTEXT",
    `context.json 无效：${field} ${expectation}。`,
  );
}
function requireContextString(
  raw: Record<string, unknown>,
  field: string,
): void {
  const value = raw[field];
  if (typeof value !== "string" || !value.trim())
    throw contextFieldError(field, "必须是非空字符串");
}
function requireContextBoolean(
  raw: Record<string, unknown>,
  field: string,
): void {
  if (typeof raw[field] !== "boolean")
    throw contextFieldError(field, "必须是布尔值");
}
function requireContextNumber(
  raw: Record<string, unknown>,
  field: string,
): void {
  const value = raw[field];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw contextFieldError(field, "必须是有限数字");
}
function requireContextNonNegInt(
  raw: Record<string, unknown>,
  field: string,
  minimum = 0,
): void {
  const value = raw[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum)
    throw contextFieldError(field, `必须是不小于 ${minimum} 的整数`);
}
function optionalContextString(
  raw: Record<string, unknown>,
  field: string,
): void {
  const value = raw[field];
  // 允许空字符串：git status 等来源合法地产生 ""；仅拒绝非字符串类型。
  if (value !== undefined && typeof value !== "string")
    throw contextFieldError(field, "缺省或为字符串");
}
function optionalContextBoolean(
  raw: Record<string, unknown>,
  field: string,
): void {
  const value = raw[field];
  if (value !== undefined && typeof value !== "boolean")
    throw contextFieldError(field, "缺省或为布尔值");
}
function optionalContextNumber(
  raw: Record<string, unknown>,
  field: string,
): void {
  const value = raw[field];
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isFinite(value))
  )
    throw contextFieldError(field, "缺省或为有限数字");
}
function optionalContextNonNegInt(
  raw: Record<string, unknown>,
  field: string,
): void {
  const value = raw[field];
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isInteger(value) || value < 0)
  )
    throw contextFieldError(field, "缺省或为非负整数");
}
function optionalContextObject(
  raw: Record<string, unknown>,
  field: string,
): void {
  const value = raw[field];
  if (
    value !== undefined &&
    (!value || typeof value !== "object" || Array.isArray(value))
  )
    throw contextFieldError(field, "缺省或为对象");
}

/** 校验 context.json 内容：核心必填字段齐全且类型正确；后期版本新增字段（trustMode、executionRetries 等）
 * 存在时做类型检查但不强制要求，保持旧 job 跨版本续跑不被硬阻断（消费方均有 ?? 兜底）。未知字段容忍（前向兼容）。 */
export function validateJobContext(value: unknown): JobContext {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CbxError("E_INVALID_CONTEXT", "context.json 无效：必须是对象。");
  const raw = value as Record<string, unknown>;
  for (const field of [
    "appVersion",
    "jobId",
    "workspace",
    "createdAt",
    "permissionMode",
    "executor",
  ])
    requireContextString(raw, field);
  for (const field of ["reviewRequested", "isolated"])
    requireContextBoolean(raw, field);
  requireContextNonNegInt(raw, "maxTurns", 1);
  requireContextNumber(raw, "timeoutMs");
  requireContextNonNegInt(raw, "maxRetries", 0);
  for (const field of [
    "testCommand",
    "reviewRules",
    "reviewExecutor",
    "commitMessage",
    "baseCommit",
    "baseBranch",
    "baseStatus",
    "dirtyFingerprint",
    "gitRoot",
  ])
    optionalContextString(raw, field);
  for (const field of [
    "keepWorktree",
    "approvalBeforeRun",
    "approvalBeforeComplete",
    "autoBranch",
    "autoCommit",
    "baseDirty",
    "dependencyGuard",
  ])
    optionalContextBoolean(raw, field);
  for (const field of ["executionRetries", "fixRetries"])
    optionalContextNonNegInt(raw, field);
  optionalContextNonNegInt(raw, "dirtyFingerprintVersion");
  if (
    raw.trustMode !== undefined &&
    raw.trustMode !== "trusted" &&
    raw.trustMode !== "untrusted"
  )
    throw contextFieldError("trustMode", "缺省或为 trusted/untrusted");
  optionalContextObject(raw, "taskContract");
  optionalContextObject(raw, "adaptive");
  optionalContextObject(raw, "contextBudget");
  return value as JobContext;
}

/** 读取并校验任务的 context.json；schema 损坏时抛出带 E_INVALID_CONTEXT 错误码的异常（文件缺失则按 loadJson 原样抛 ENOENT），不返回半成品。 */
export async function loadJobContext(directory: string): Promise<JobContext> {
  return validateJobContext(
    await loadJson<unknown>(path.join(directory, "context.json")),
  );
}

export async function updateJobContext(
  workspace: string,
  jobId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  // context.json 是执行器可写的输入面：jobId 可能被篡改（"../../x"），写入前必须
  // 与 jobDir/loadState 走同一道 assertJobId 门，否则等于任意路径 JSON 写。
  assertJobId(jobId);
  const directory = path.join(workspace, ".cbx", "jobs", jobId);
  const file = path.join(directory, "context.json");
  const current = { ...(await loadJobContext(directory)) } as Record<
    string,
    unknown
  >;
  Object.assign(current, updates);
  await saveJson(file, current);
}
