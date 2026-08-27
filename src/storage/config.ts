/**
 * storage/config —— 工作区配置（.cbx.json）严格校验 + 凭据脱敏。
 *
 * 从原 storage.ts 抽出。`.cbx.json` 是可信配置：未知字段整体拒绝（拼错的策略字段
 * 不能静默失效），校验辅助（object/known/optional*）与脱敏（redactSensitive/
 * redactText）都定义在此。
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { normalizeAdaptiveOptions } from "../adaptive-manager.js";
import { isMissing } from "./io.js";

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
  executorRequirements?: import("../executor-router.js").ExecutorRequirements;
  /** 执行器路由策略（first-available / capability-best / cost-aware / fastest / round-robin / least-recently-used）。 */
  routingStrategy?: import("../executor-router.js").ExecutorStrategy;
  /**
   * 执行器档位人工覆盖（HR 式 fail-closed 目录校准）：cost/speed 档缺省是声明
   * 估值，有足够实测样本时 speed 档自动进入实测校准；此处可显式钉住某执行器的
   * 档位（本机硬件/网络等原因）。键为内置注册名或别名；结构/取值非法直接拒绝，
   * 未知名在路由时以 warning 呈现。见 executor-catalog。
   */
  executorTiers?: Record<string, { costTier?: number; speedTier?: number }>;
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
  /** 审计强制动作：终态收口前检测到 events.ndjson 被篡改（与 SQLite 镜像漂移）时
   *  fail-closed 拦截完成（done → needs_fix/audit_tamper + Human Gate），而不是只
   *  在展示面标「篡改!」。缺省 false = 仅展示（向后兼容）。执行器可写 .cbx.json，
   *  故本字段纳入安全策略指纹（改回 false 会触发 policy_drift）。 */
  audit?: { failOnTamper?: boolean };
  /** 成本治理：执行器调用上限（硬闸，防 API 配额烧穿）。缺省 = 无上限（向后兼容）。 */
  cost?: {
    /** 单个任务累计执行器调用（stage + review + manager + gate 全部角色）的上限。 */
    maxExecutorInvocations?: number;
  };
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
    /** 内置执行器 CLI 参数覆盖：键为注册名/别名（codebuddy/opencode/omp/cline/qwen），
     *  值追加到内置参数序列末尾（通常为 flag/value 形式）。外部 CLI 版本参数漂移时
     *  的工作区逃生门，无需发版插件。纳入安全策略指纹（executors 整对象）。 */
    cliArgs?: Record<string, string[]>;
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} 必须是对象。`);
  return value as Record<string, unknown>;
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

/** 当前 .cbx.json 配置格式版本（配置作者在 configCompat.schemaVersion 声明）。
 *  声明值大于本值 → 加载期拒绝（配置由更新版本的 cbx 编写，需要升级插件）。
 *  降级场景（新字段落到旧版本）用 strict:false 逃生门接管，见 configCompat。 */
export const CURRENT_CONFIG_SCHEMA_VERSION = 1;

/** 安全关键字段名（模糊匹配）：strict:false 模式下仍拒绝"疑似拼错的安全字段"——
 *  逃生门不能静默吞掉成本闸/插件白名单/审查闸/审计闸/执行器白名单的拼写错误。 */
const SECURITY_FIELD_KEYS = new Set(["cost", "plugins", "reviewgate", "audit", "executors"]);

/** 归一化键名（去非字母小写化），供安全字段模糊匹配。 */
function fuzzySecurityKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, "");
}

/** 宽松命中：归一化后与安全字段相等，或只差一个字符（costs/pluginz/reviewgatee/
 *  audits 之类拼写变体）。±1 之外（如 coast）不算安全字段拼写，仍按普通未知键警告。 */
function isSecurityFieldTypo(key: string): boolean {
  const normalized = fuzzySecurityKey(key);
  for (const field of SECURITY_FIELD_KEYS) {
    if (normalized === field) return true;
    if (normalized.startsWith(field) && normalized.length <= field.length + 1)
      return true;
    if (field.startsWith(normalized) && field.length <= normalized.length + 1)
      return true;
  }
  return false;
}

/** 当前加载期的未知键收集器与严格模式开关。仅 loadRuntimeConfig 的同步校验段内
 *  有效（Node 单线程：该段无 await，无并发交错风险）。 */
let strictModeActive = true;
let unknownKeys: string[] = [];

function known(
  value: Record<string, unknown>,
  name: string,
  keys: string[],
): void {
  for (const key of Object.keys(value)) {
    if (keys.includes(key)) continue;
    if (!strictModeActive) {
      // 逃生门（configCompat.strict=false）：未知键降级为警告；安全字段拼写仍拒绝。
      if (isSecurityFieldTypo(key)) {
        throw new Error(
          `${name} 不支持字段：${key}（疑似安全字段拼写错误，strict:false 不豁免安全闸）。`,
        );
      }
      unknownKeys.push(`${name}.${key}`);
      continue;
    }
    throw new Error(`${name} 不支持字段：${key}`);
  }
}

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
  // configCompat：配置格式兼容声明，必须先于严格校验读取（逃生门本身必须永远可解析）。
  //   - schemaVersion > 当前版本 → 拒绝（配置由更新版本编写，fail-closed，strict:false 不豁免）；
  //   - strict: false → 未知键降级为警告（安全字段拼写仍拒绝），供升级后需降级/快速恢复场景。
  const configCompat = (config.configCompat ?? {}) as Record<string, unknown>;
  if (
    configCompat.schemaVersion !== undefined &&
    (!Number.isInteger(configCompat.schemaVersion) ||
      Number(configCompat.schemaVersion) < 1)
  )
    throw new Error("configCompat.schemaVersion 必须是正整数（≥1）。");
  if (
    Number(configCompat.schemaVersion) > CURRENT_CONFIG_SCHEMA_VERSION
  ) {
    throw new Error(
      `.cbx.json 声明 configCompat.schemaVersion=${Number(configCompat.schemaVersion)}，高于当前 cbx 支持的 ${CURRENT_CONFIG_SCHEMA_VERSION}——配置由更新版本编写，请升级插件（或删除该字段后重试）。`,
    );
  }
  const warnedStrict =
    configCompat.strict !== undefined &&
    configCompat.strict !== false &&
    configCompat.strict !== true;
  if (warnedStrict)
    throw new Error("configCompat.strict 必须是布尔值（缺省 true = 严格拒绝未知字段）。");
  // 同步校验段：设置逃生门开关并收集未知键，finally 还原（该段无 await，无交错）。
  const previousStrict = strictModeActive;
  strictModeActive = configCompat.strict !== false;
  unknownKeys = [];
  try {
    return await validateRuntimeConfig(config);
  } finally {
    if (!strictModeActive && unknownKeys.length > 0) {
      console.error(
        `cbx 警告：.cbx.json 配置了 configCompat.strict=false，以下未知字段被忽略（可能已失效或拼写错误）：${unknownKeys.join(", ")}。` +
          `安全字段（cost/plugins/reviewGate/audit/executors）拼写不受此豁免。`,
      );
    }
    strictModeActive = previousStrict;
    unknownKeys = [];
  }
}

/** loadRuntimeConfig 的同步校验体（strict 开关已就位）。 */
async function validateRuntimeConfig(
  config: Record<string, unknown>,
): Promise<RuntimeConfig> {
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
    "executorTiers",
    "carryDirty",
    "execution",
    "plugins",
    "notifications",
    "telemetry",
    "governance",
    "reviewGate",
    "audit",
    "configCompat",
    "cost",
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
  // executorTiers：结构与取值在此严格拒绝（档位是路由依据，坏值不能静默降级）；
  // "键是否为已知执行器"留给 executor-catalog 归一（支持别名）并产出 warning，
  // 避免 storage 反向依赖执行器注册表。
  if (config.executorTiers !== undefined) {
    const tiers = object(config.executorTiers, "executorTiers");
    for (const [name, value] of Object.entries(tiers)) {
      const v = object(value, `executorTiers.${name}`);
      known(v, `executorTiers.${name}`, ["costTier", "speedTier"]);
      optionalInteger(v.costTier, `executorTiers.${name}.costTier`, 1, 3);
      optionalInteger(v.speedTier, `executorTiers.${name}.speedTier`, 1, 3);
    }
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
  if (config.audit !== undefined) {
    const value = object(config.audit, "audit");
    known(value, "audit", ["failOnTamper"]);
    optionalBoolean(value.failOnTamper, "audit.failOnTamper");
  }
  if (config.cost !== undefined) {
    const value = object(config.cost, "cost");
    known(value, "cost", ["maxExecutorInvocations"]);
    optionalInteger(
      value.maxExecutorInvocations,
      "cost.maxExecutorInvocations",
      1,
      1_000_000,
    );
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
    known(value, "executors", ["envAllowlist", "cliArgs"]);
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
    if (value.cliArgs !== undefined) {
      const cliArgs = object(value.cliArgs, "executors.cliArgs");
      for (const [name, args] of Object.entries(cliArgs)) {
        if (
          !Array.isArray(args) ||
          args.length > 64 ||
          args.some(
            (item) =>
              typeof item !== "string" ||
              !item.trim() ||
              item.length > 512,
          )
        )
          throw new Error(
            `executors.cliArgs.${name} 必须是最多 64 个非空字符串（每个 ≤512 字符）的数组。`,
          );
      }
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
// 带 \b 词边界：与 subprocess-adapter 的 LogRedactor 同款——无边界时 `sk-xxx` 会命中
// 更长 base64 子串（如 base64 编码的整块内容含 sk- 片段）过度脱敏、损伤产物文本。
const DEFAULT_REDACT_PATTERNS: string[] = [
  "\\bsk-[A-Za-z0-9_\\-]{16,}\\b",
  "\\bgh[pousr]_[A-Za-z0-9]{20,}\\b",
  // 细粒度 PAT（github_pat_ 前缀）与经典 ghp_/gho_/ghu_/ghs_/ghr_ 形状不同，单列。
  "\\bgithub_pat_[A-Za-z0-9_]{20,}\\b",
  "\\bxox[baprs]-[A-Za-z0-9\\-]{10,}\\b",
  "\\bAIza[0-9A-Za-z_\\-]{30,}\\b",
  "\\bAKIA[0-9A-Z]{16}\\b",
  "-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\\s\\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----",
  "\\bBearer\\s+[A-Za-z0-9._~+/\\-=]{20,}\\b",
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

/**
 * 安全关键策略字段的稳定指纹（sha256）。用途：把任务**创建时**的 `.cbx.json`
 * 安全策略（成本闸/插件白名单/review stop-gate 开关/环境白名单）固定下来，
 * 执行期现读 `.cbx.json` 后重算比对——非隔离执行器 cwd=workspace 可中途改写
 * `.cbx.json`（调高成本上限、拆插件白名单、设 failOpen=true 等），指纹漂移即
 * 拒绝执行（fail-closed），防止静默拆掉安全/成本控制。
 *
 * 字段选择：只覆盖"被改写会削弱安全/成本控制"的策略；testCommand 等业务字段
 * 不在此列（那是任务内容不是安全闸）。
 */
export function securityPolicyFingerprint(
  config: Pick<RuntimeConfig, "cost" | "plugins" | "reviewGate" | "audit" | "executors">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        cost: config.cost ?? null,
        plugins: config.plugins ?? null,
        reviewGate: config.reviewGate ?? null,
        audit: config.audit ?? null,
        executors: config.executors ?? null,
      }),
    )
    .digest("hex");
}
