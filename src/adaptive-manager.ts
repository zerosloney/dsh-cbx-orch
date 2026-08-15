export interface AdaptiveOptions {
  enabled: boolean;
  maxRounds: number;
  managerExecutor?: string;
}

export interface AdaptiveTaskStage {
  name: string;
  executor: string;
  task: string;
  reviewExecutor?: string;
  skipReview?: boolean;
  dependsOn?: string[];
}

export type NextAction =
  | { action: "execute"; stage: AdaptiveTaskStage }
  | { action: "ask"; questions: string[] }
  | { action: "blocked"; reason: string }
  | { action: "done" };

function object(value: unknown, name: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(`${name} 必须是普通对象。`);
  return value as Record<string, unknown>;
}

function known(
  value: Record<string, unknown>,
  name: string,
  fields: string[],
): void {
  const unknown = Object.keys(value).filter((key) => !fields.includes(key));
  if (unknown.length)
    throw new Error(`${name} 不支持字段：${unknown.join(", ")}`);
}

function text(value: unknown, name: string, maximum = 50_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw new Error(`${name} 必须是不超过 ${maximum} 字符的非空字符串。`);
  return value.trim();
}

export function normalizeAdaptiveOptions(
  value: unknown,
  fallback: AdaptiveOptions = { enabled: false, maxRounds: 8 },
): AdaptiveOptions {
  if (value === undefined) return { ...fallback };
  const raw = object(value, "adaptive");
  known(raw, "adaptive", ["enabled", "maxRounds", "managerExecutor"]);
  const enabled = raw.enabled ?? fallback.enabled;
  const maxRounds = raw.maxRounds ?? fallback.maxRounds;
  const managerExecutor = raw.managerExecutor ?? fallback.managerExecutor;
  if (typeof enabled !== "boolean")
    throw new Error("adaptive.enabled 必须是布尔值。");
  if (
    !Number.isInteger(maxRounds) ||
    Number(maxRounds) < 1 ||
    Number(maxRounds) > 100
  )
    throw new Error("adaptive.maxRounds 必须是 1 到 100 的整数。");
  if (
    managerExecutor !== undefined &&
    (typeof managerExecutor !== "string" || !managerExecutor.trim())
  )
    throw new Error("adaptive.managerExecutor 必须是非空字符串。");
  return {
    enabled,
    maxRounds: Number(maxRounds),
    managerExecutor:
      typeof managerExecutor === "string" ? managerExecutor.trim() : undefined,
  };
}

function parseStage(value: unknown): AdaptiveTaskStage {
  const stage = object(value, "nextAction.stage");
  known(stage, "nextAction.stage", [
    "name",
    "executor",
    "task",
    "reviewExecutor",
    "skipReview",
    "dependsOn",
  ]);
  if (
    stage.reviewExecutor !== undefined &&
    typeof stage.reviewExecutor !== "string"
  )
    throw new Error("nextAction.stage.reviewExecutor 必须是非空字符串。");
  if (stage.skipReview !== undefined && typeof stage.skipReview !== "boolean")
    throw new Error("nextAction.stage.skipReview 必须是布尔值。");
  let dependsOn: string[] | undefined;
  if (stage.dependsOn !== undefined) {
    if (
      !Array.isArray(stage.dependsOn) ||
      stage.dependsOn.some(
        (dep: unknown) => typeof dep !== "string" || !(dep as string).trim(),
      )
    )
      throw new Error("nextAction.stage.dependsOn 必须是非空字符串数组。");
    dependsOn = [...new Set(stage.dependsOn.map((dep: string) => dep.trim()))];
  }
  return {
    name: text(stage.name, "nextAction.stage.name", 200),
    executor: text(stage.executor, "nextAction.stage.executor", 2_000),
    task: text(stage.task, "nextAction.stage.task"),
    reviewExecutor:
      stage.reviewExecutor === undefined
        ? undefined
        : text(stage.reviewExecutor, "nextAction.stage.reviewExecutor", 2_000),
    skipReview: stage.skipReview as boolean | undefined,
    dependsOn,
  };
}

export function parseNextAction(value: unknown): NextAction {
  const decision = object(value, "nextAction");
  const action = decision.action;
  if (action === "execute") {
    known(decision, "nextAction", ["action", "stage"]);
    return { action, stage: parseStage(decision.stage) };
  }
  if (action === "ask") {
    known(decision, "nextAction", ["action", "questions"]);
    if (
      !Array.isArray(decision.questions) ||
      decision.questions.length === 0 ||
      decision.questions.length > 20
    )
      throw new Error("nextAction.questions 必须是 1 到 20 个问题的数组。");
    return {
      action,
      questions: decision.questions.map((question, index) =>
        text(question, `nextAction.questions[${index}]`, 2_000),
      ),
    };
  }
  if (action === "blocked") {
    known(decision, "nextAction", ["action", "reason"]);
    return {
      action,
      reason: text(decision.reason, "nextAction.reason", 10_000),
    };
  }
  if (action === "done") {
    known(decision, "nextAction", ["action"]);
    return { action };
  }
  throw new Error("nextAction.action 必须是 execute/ask/blocked/done 之一。");
}

export function managerPrompt(
  candidateFile: string,
  contextPackFile: string,
): string {
  return `你是 adaptive manager。每轮只做一个决策，不要修改工作区，不要读取 agent.log、历史 prompt 或完整 trajectory。\n\n只读取由编排器生成的最小化投影上下文包：\n- ${contextPackFile}\n\n将严格 JSON 写入 ${candidateFile}，且只能是以下形式之一：\n- {"action":"execute","stage":{"name":"...","executor":"...","task":"...","reviewExecutor":"...","skipReview":false}}\n- {"action":"ask","questions":["..."]}\n- {"action":"blocked","reason":"..."}\n- {"action":"done"}\n不要添加未列出的字段。done 只是请求完成，系统仍会执行确定性证据门。`;
}
