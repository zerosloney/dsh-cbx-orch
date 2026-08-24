import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  saveJson,
  savePersistedState,
  loadPersistedState,
  redactText,
  now,
  securityPolicyFingerprint,
} from "./storage.js";
import { loadConfig, jobDir } from "./state.js";
import {
  validateWorkspace,
  validateTestCommand,
  validatePermissionMode,
  assertExecutionPolicy,
  normalizeJobId,
  normalizeTaskContract,
} from "./validation.js";
import { normalizeAdaptiveOptions } from "./adaptive-manager.js";
import {
  snapshotGitBaseline,
  gitDirtyFingerprintTracked,
  gitRoot,
  requireGitRoot,
} from "./git-ops.js";
import { DEFAULT_TOKEN_BUDGET, type ContextBudget } from "./context-pack.js";
import { APP_VERSION } from "./version.js";
import type { JobContext, JobState, TaskContract } from "./types.js";

/** 规范化 .cbx.json 的 context.tokenBudget；缺失角色用默认值填充。 */
function normalizeContextBudget(raw: unknown): ContextBudget {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_TOKEN_BUDGET };
  const obj = raw as Record<string, unknown>;
  const pick = (role: keyof ContextBudget): number => {
    const value = obj[role];
    return Number.isInteger(value) && Number(value) >= 100
      ? Number(value)
      : DEFAULT_TOKEN_BUDGET[role];
  };
  return {
    manager: pick("manager"),
    executor: pick("executor"),
    auditor: pick("auditor"),
  };
}

export async function createJob(options: {
  workspace: string;
  task: string;
  testCommand?: string;
  review: boolean;
  isolated: boolean;
  permissionMode: string;
  maxTurns: number;
  timeoutMs?: number;
  maxRetries?: number;
  keepWorktree?: boolean;
  allowUnsafePermissions?: boolean;
  reviewRules?: string;
  approvalBeforeRun?: boolean;
  approvalBeforeComplete?: boolean;
  autoBranch?: boolean;
  autoCommit?: boolean;
  commitMessage?: string;
  executor?: string;
  reviewExecutor?: string;
  /** 隔离任务携带未提交改动（见 storage.ts RuntimeConfig.carryDirty）。 */
  carryDirty?: boolean;
  trustMode?: "trusted" | "untrusted";
  contextSnapshot?: string;
  taskContract?: TaskContract;
  adaptive?: Partial<import("./adaptive-manager.js").AdaptiveOptions>;
  dependencyGuard?: boolean;
  jobId?: string;
  /** per-job 成本上限覆盖（工具/Web 参数透传；缺省回落 `.cbx.json` 的 cost）。 */
  cost?: { maxExecutorInvocations?: number };
}): Promise<{ jobId: string; directory: string }> {
  const workspace = path.resolve(options.workspace);
  if (typeof options.task !== "string" || !options.task.trim())
    throw new Error("task 必须是非空字符串。");
  validateWorkspace(workspace);
  validateTestCommand(options.testCommand);
  validatePermissionMode(
    options.permissionMode,
    options.allowUnsafePermissions,
  );
  assertExecutionPolicy(options.trustMode ?? "trusted", options.isolated);
  if (!Number.isInteger(options.maxTurns) || options.maxTurns < 1)
    throw new Error("maxTurns 必须是正整数。");
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 100)
  )
    throw new Error("timeoutMs 必须不小于 100ms。");
  if (
    options.maxRetries !== undefined &&
    (!Number.isInteger(options.maxRetries) || options.maxRetries < 0)
  )
    throw new Error("maxRetries 必须是非负整数。");
  const adaptive = normalizeAdaptiveOptions(options.adaptive);
  if (adaptive.enabled && !options.review)
    throw new Error(
      "adaptive.enabled=true 需要 review=true，以便 done 通过结构化证据门。",
    );
  const taskContract =
    normalizeTaskContract(options.taskContract) ??
    (adaptive.enabled ? { goal: options.task.trim() } : undefined);
  // autoCommit 隐含 isolated：提交到 worktree 才安全，避免把主工作区无关改动一起提交。
  // 不抛错——autoCommit=true 时自动开启 isolated，保留告警让用户知道发生了隐含提升。
  if (options.autoCommit && !options.isolated) {
    console.error(
      "cbx 提示：autoCommit=true 已隐含开启 isolated=true（提交到 worktree，避免污染主工作区）。",
    );
    options.isolated = true;
  }
  // isolated 任务要求工作区位于 Git 仓库：创建时即校验并给出修复途径，而不是
  // 让任务带病入队、worker 崩溃 4 次熔断后只留一句笼统的"worker 反复无法恢复"，
  // 把真实根因（不是 Git 仓库）淹没在 events.ndjson 里。
  if (options.isolated) {
    await requireGitRoot(workspace);
  }
  // 测试命令黑名单是软防线（正则可被变体绕过）。非隔离时强警告：cbx 不保证命令安全，应运行在受控环境。
  if (options.testCommand && !options.isolated) {
    console.error(
      `cbx 警告：测试命令将在主工作区执行（isolated=false），cbx 不保证其安全性：${options.testCommand}`,
    );
  }
  const jobId = normalizeJobId(options.jobId);
  const directory = jobDir(workspace, jobId);
  if (existsSync(directory)) throw new Error(`任务已存在：${jobId}`);
  // legacy 导入可能把 .cbx/jobs/<id>/ 目录清掉但 SQLite 记录仍在；仅查目录会让同 jobId 静默覆盖旧 state。
  const persisted = await loadPersistedState<unknown>(workspace, jobId);
  if (persisted)
    throw new Error(`任务已存在（SQLite 有记录但目录缺失）：${jobId}`);
  const baseline = await snapshotGitBaseline(workspace);
  // 创建期 fail-fast：隔离任务无法携带未提交内容（worktree 从干净基线创建）。
  // 在创建时立刻给可操作提示，避免任务带病入队、执行期才因 dirty_baseline 崩溃。
  // carryDirty: true 时才允许——把未提交改动带进隔离 worktree 执行。
  if (options.isolated && baseline?.dirty && !options.carryDirty) {
    throw new Error(
      "隔离任务无法携带创建时的未提交内容。三种处理方式：\n" +
        "  1) 先提交或清理工作区（git commit / stash）后重试；\n" +
        "  2) 设 carryDirty: true（工具参数 carry_dirty）——把当前未提交改动带进隔离 worktree，任务在主工作区之外安全执行；\n" +
        "  3) 设 isolated: false——任务直接在当前工作区（含未提交改动）执行。",
    );
  }
  await mkdir(directory, { recursive: true });
  const request = `# 任务\n\n## 目标\n\n${taskContract?.goal ?? options.task.trim()}\n\n## 验收标准\n\n${taskContract?.acceptanceCriteria?.map((item) => `- ${item}`).join("\n") || "- 以目标和验收命令为准。"}\n\n## 非目标\n\n${taskContract?.nonGoals?.map((item) => `- ${item}`).join("\n") || "- 未指定。"}\n\n## 约束\n\n${taskContract?.constraints?.map((item) => `- ${item}`).join("\n") || "- 只修改完成目标所需的文件。"}\n\n## 验收命令\n\n${options.testCommand ?? "未指定；请根据项目现有脚本选择最相关的检查。"}\n\n## 执行规则\n\n- 先检查项目结构和现有测试，再修改。\n- 完成后运行验收命令。\n- 将修改摘要、测试命令、测试结果和遗留问题写入 handback.md。\n`;
  await writeFile(path.join(directory, "request.md"), request, "utf8");
  const governance = (await loadConfig(workspace)).governance;
  const snapshot = redactText(
    options.contextSnapshot ?? "",
    governance?.redactFields,
    governance?.redactPatterns,
  );
  if (snapshot)
    await writeFile(
      path.join(directory, "context-snapshot.md"),
      snapshot,
      "utf8",
    );
  if (taskContract)
    await saveJson(path.join(directory, "context-contract.json"), taskContract);
  // v2 脏指纹（仅跟踪文件）：未跟踪 scratch 文件不再触发非隔离任务的脏漂移误报。
  const dirtyFingerprint = await gitDirtyFingerprintTracked(workspace);
  const runtimeConfig = await loadConfig(workspace);
  const contextBudget = normalizeContextBudget(
    runtimeConfig.context?.tokenBudget,
  );
  const context: JobContext = {
    appVersion: APP_VERSION,
    jobId,
    workspace,
    createdAt: now(),
    testCommand: options.testCommand,
    reviewRequested: options.review,
    isolated: options.isolated,
    permissionMode: options.permissionMode,
    maxTurns: options.maxTurns,
    timeoutMs: options.timeoutMs ?? 30 * 60_000,
    maxRetries: options.maxRetries ?? 1,
    // 重试预算语义：maxRetries = 首次执行失败后允许的重试次数（总执行 = 1 + maxRetries）。
    // 旧实现 executionRetries = maxRetries + 1 被 stage-runner 当"重试次数"用，
    // maxRetries:1 实际跑 3 次（多一次）。旧 job 按创建时持久化的值执行，不受影响。
    executionRetries: Math.max(0, options.maxRetries ?? 1),
    fixRetries: Math.max(0, options.maxRetries ?? 1),
    keepWorktree: options.keepWorktree ?? false,
    reviewRules: options.reviewRules,
    approvalBeforeRun: options.approvalBeforeRun ?? false,
    approvalBeforeComplete: options.approvalBeforeComplete ?? false,
    autoBranch: options.autoBranch ?? false,
    autoCommit: options.autoCommit ?? false,
    commitMessage: options.commitMessage ?? "chore(cbx): apply task",
    executor: options.executor ?? "codebuddy",
    reviewExecutor: options.reviewExecutor,
    adaptive: adaptive.enabled
      ? {
          ...adaptive,
          managerExecutor:
            adaptive.managerExecutor ?? options.executor ?? "codebuddy",
        }
      : undefined,
    taskContract,
    trustMode: options.trustMode ?? "trusted",
    gitRoot: baseline?.root ?? await gitRoot(workspace),
    baseCommit: baseline?.commit,
    baseBranch: baseline?.branch,
    baseDirty: baseline?.dirty,
    carryDirty: options.carryDirty ?? false,
    baseStatus: baseline?.status,
    dirtyFingerprint,
    dirtyFingerprintVersion: 2,
    dependencyGuard: options.dependencyGuard ?? false,
    contextBudget,
    cost: options.cost,
  };
  await saveJson(path.join(directory, "context.json"), context, {
    fsync: false,
  });
  const state: JobState = {
    jobId,
    status: "queued",
    phase: "queued",
    workspace,
    jobDir: directory,
    createdAt: now(),
    updatedAt: now(),
    attempt: 0,
    // P0-2: 创建时记录 maxTurns，UI/result 可直接读取实际预算而无需推断。
    configuredMaxTurns: context.maxTurns,
    // 安全策略指纹（成本闸/插件白名单/reviewGate/环境白名单）：创建时固定，
    // 执行期现读 .cbx.json 重算比对——防非隔离执行器中途改写 .cbx.json 静默
    // 拆掉安全/成本控制。存 SQLite（state 权威），执行器无连接无法篡改。
    securityFingerprint: securityPolicyFingerprint(runtimeConfig),
  };
  await savePersistedState(workspace, jobId, state);
  // 创建期的 state.json 镜像（权威在 SQLite），无需 fsync。
  await saveJson(path.join(directory, "state.json"), state, { fsync: false });
  return { jobId, directory };
}
