import { existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CbxError } from "./errors.js";

export interface TaskStage {
  name: string;
  executor: string;
  task: string;
  reviewExecutor?: string;
  skipReview?: boolean;
  /** 依赖的前置 stage name 列表。无 dependsOn 的 stage 先执行；有依赖的等前置完成后执行。
   *  前置 stage 终态为 failed/needs_fix/review_failed 时，后继 stage 标记 skipped 而非执行。 */
  dependsOn?: string[];
}

export interface TaskContract {
  goal?: string;
  nonGoals?: string[];
  acceptanceCriteria?: string[];
  constraints?: string[];
  relevantFiles?: string[];
  decisions?: string[];
  rejectedOptions?: string[];
  assumptions?: string[];
  stages?: TaskStage[];
}

export function assertJobId(jobId: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId) ||
    jobId === "." ||
    jobId === ".."
  )
    throw new CbxError("E_INVALID_JOB_ID", `无效的任务 ID：${jobId}`);
}

export function normalizeJobId(value?: string): string {
  const cleaned = value
    ?.replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (
    cleaned ||
    `${new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, "")
      .slice(0, 14)}-${randomBytes(3).toString("hex")}`
  );
}

export function validateWorkspace(workspace: string): void {
  const resolved = path.resolve(workspace);
  if (path.dirname(resolved) === resolved)
    throw new Error("不允许把文件系统根目录作为工作区。");
  if (!existsSync(resolved)) throw new Error(`工作区不存在：${resolved}`);
}

export function validateTestCommand(command?: string): void {
  if (!command) return;
  // 拒绝 shell 链式/重定向操作符、换行（命令分隔）、反引号与 $( 命令替换——这些是绕过黑名单的主要手法。
  if (/[;&|<>`\r\n]/.test(command) || command.includes("$(")) {
    throw new Error("测试命令包含不允许的 shell 操作符、换行或命令替换。");
  }
  // 拒绝递归/强制删除与编码执行等破坏性命令（覆盖常见参数变体）。
  // 软防线：无法穷举所有变体，非隔离任务仍依赖运行环境隔离。补 find -delete/git clean/truncate/dd/shred 等。
  const destructive =
    /(?:\brm\s+(?:-[a-z]*[rf]|--recurs|--forc)|\brd\s+\/s|\brmdir\s+\/s|Remove-Item|\bdel\s+\/s|\bdeltree\b|\bformat\s+|\bfind\s+.*\b-delete\b|\bgit\s+clean\b|\btruncate\b|\bdd\b.*\bof=|\bshred\b)/i;
  const encodedCommand = /\s-(?:enc|encodedcommand)\b/i;
  if (destructive.test(command) || encodedCommand.test(command)) {
    throw new Error("测试命令包含不允许的破坏性命令或编码执行。");
  }
}

export function validatePermissionMode(
  mode: string,
  allowUnsafe = false,
): void {
  const allowed = new Set(["default", "acceptEdits", "auto", "dontAsk"]);
  if (!allowed.has(mode)) throw new Error(`不支持的 permission mode：${mode}`);
  if (mode === "dontAsk" && !allowUnsafe)
    throw new Error(
      "dontAsk 需要显式使用 --dangerously-skip-permissions；请在编排器外部确认后再启用。",
    );
}

export function assertExecutionPolicy(
  trustMode: string,
  isolated: boolean,
): asserts trustMode is "trusted" | "untrusted" {
  if (trustMode !== "trusted" && trustMode !== "untrusted")
    throw new Error(`不支持的 trustMode：${trustMode}`);
  if (trustMode === "untrusted") {
    if (!isolated)
      throw new Error(
        "untrusted 任务必须设置 isolated=true；Git worktree 不是安全沙箱。",
      );
    throw new Error(
      "当前 cbx 未提供 OS 容器沙箱，拒绝启用 untrusted 模式；请使用受控的外部容器 runner。",
    );
  }
}

/** 校验 stage 依赖图：悬空依赖（引用不存在的 name）与循环依赖（DFS 检测）。 */
export function validateStageDependencies(stages: TaskStage[]): void {
  const names = new Set(stages.map((stage) => stage.name));
  const adjacency = new Map<string, string[]>();
  for (const stage of stages) {
    const deps = stage.dependsOn ?? [];
    // 悬空依赖
    for (const dep of deps) {
      if (!names.has(dep))
        throw new Error(
          `taskContract.stages：stage "${stage.name}" 依赖不存在的 stage "${dep}"。`,
        );
    }
    adjacency.set(stage.name, deps);
    // 自依赖已在 normalizeTaskContract 单 stage 层拒绝，此处不重复
  }
  // 循环依赖：DFS 三色标记（WHITE=未访问, GRAY=访问中, BLACK=已完成）
  const color = new Map<string, "white" | "gray" | "black">();
  for (const name of names) color.set(name, "white");
  const stack: string[] = [];
  const visit = (node: string): void => {
    const state = color.get(node);
    if (state === "gray") {
      const cycle = [...stack.slice(stack.indexOf(node)), node].join(" → ");
      throw new Error(`taskContract.stages 检测到循环依赖：${cycle}。`);
    }
    if (state === "black") return;
    color.set(node, "gray");
    stack.push(node);
    for (const dep of adjacency.get(node) ?? []) visit(dep);
    stack.pop();
    color.set(node, "black");
  };
  for (const name of names) if (color.get(name) === "white") visit(name);
}

export function normalizeTaskContract(
  value?: TaskContract,
): TaskContract | undefined {
  if (!value) return undefined;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("taskContract 必须是普通对象。");
  const contractFields = [
    "goal",
    "nonGoals",
    "acceptanceCriteria",
    "constraints",
    "relevantFiles",
    "decisions",
    "rejectedOptions",
    "assumptions",
    "stages",
  ];
  const contractUnknown = Object.keys(value).filter(
    (key) => !contractFields.includes(key),
  );
  if (contractUnknown.length)
    throw new Error(`taskContract 不支持字段：${contractUnknown.join(", ")}`);
  const result: TaskContract = {};
  if (value.goal !== undefined) {
    if (typeof value.goal !== "string")
      throw new Error("taskContract.goal 必须是字符串。");
    if (value.goal.trim()) result.goal = value.goal.trim();
  }
  for (const key of [
    "nonGoals",
    "acceptanceCriteria",
    "constraints",
    "relevantFiles",
    "decisions",
    "rejectedOptions",
    "assumptions",
  ] as const) {
    const items = value[key];
    if (items !== undefined) {
      if (
        !Array.isArray(items) ||
        items.some((item) => typeof item !== "string")
      )
        throw new Error(`taskContract.${key} 必须是字符串数组。`);
      result[key] = items.map((item) => item.trim()).filter(Boolean);
    }
  }
  if (value.stages !== undefined) {
    if (!Array.isArray(value.stages) || value.stages.length === 0)
      throw new Error("taskContract.stages 必须是非空数组。");
    result.stages = value.stages.map((stage, index) => {
      if (!stage || typeof stage !== "object")
        throw new Error(`taskContract.stages[${index}] 必须是对象。`);
      const stageUnknown = Object.keys(stage).filter(
        (key) =>
          ![
            "name",
            "executor",
            "task",
            "reviewExecutor",
            "skipReview",
            "dependsOn",
          ].includes(key),
      );
      if (stageUnknown.length)
        throw new Error(
          `taskContract.stages[${index}] 不支持字段：${stageUnknown.join(", ")}`,
        );
      if (typeof stage.name !== "string" || !stage.name.trim())
        throw new Error(
          `taskContract.stages[${index}].name 必须是非空字符串。`,
        );
      if (typeof stage.executor !== "string" || !stage.executor.trim())
        throw new Error(
          `taskContract.stages[${index}].executor 必须是非空字符串。`,
        );
      if (typeof stage.task !== "string" || !stage.task.trim())
        throw new Error(
          `taskContract.stages[${index}].task 必须是非空字符串。`,
        );
      if (
        stage.reviewExecutor !== undefined &&
        (typeof stage.reviewExecutor !== "string" ||
          !stage.reviewExecutor.trim())
      )
        throw new Error(
          `taskContract.stages[${index}].reviewExecutor 必须是非空字符串。`,
        );
      if (
        stage.skipReview !== undefined &&
        typeof stage.skipReview !== "boolean"
      )
        throw new Error(
          `taskContract.stages[${index}].skipReview 必须是布尔值。`,
        );
      let dependsOn: string[] | undefined;
      if (stage.dependsOn !== undefined) {
        if (
          !Array.isArray(stage.dependsOn) ||
          stage.dependsOn.length === 0 ||
          stage.dependsOn.some(
            (dep: unknown) =>
              typeof dep !== "string" || !(dep as string).trim(),
          )
        )
          throw new Error(
            `taskContract.stages[${index}].dependsOn 必须是非空字符串数组。`,
          );
        dependsOn = [
          ...new Set(stage.dependsOn.map((dep: string) => dep.trim())),
        ];
        // stage 不能依赖自己
        if (dependsOn.includes(stage.name.trim()))
          throw new Error(
            `taskContract.stages[${index}].dependsOn 不能依赖自身：${stage.name.trim()}。`,
          );
      }
      return {
        name: stage.name.trim(),
        executor: stage.executor.trim(),
        task: stage.task.trim(),
        reviewExecutor: stage.reviewExecutor?.trim(),
        skipReview: stage.skipReview,
        dependsOn,
      };
    });
    // 全局校验：悬空依赖（引用不存在的 stage name）+ 循环依赖（DFS 检测）
    validateStageDependencies(result.stages);
  }
  return Object.keys(result).length ? result : undefined;
}
