/** 统一错误类型：控制流按错误码判定，消除按消息字符串匹配的耦合（消息文案保留给用户与测试断言）。 */

export type CbxErrorCode =
  | "E_INVALID_JOB_ID"
  | "E_INVALID_WORKSPACE"
  | "E_INVALID_TEST_COMMAND"
  | "E_INVALID_PERMISSION_MODE"
  | "E_LEASE_HELD"
  | "E_ARTIFACT_FORBIDDEN"
  | "E_INVALID_CONTEXT"
  | "E_LOCK_BUSY"
  | "E_QUEUE_BUSY"
  | "E_BACKEND_UNAVAILABLE"
  | "E_NOT_FOUND"
  | "E_COST_LIMIT"
  | "E_POLICY_DRIFT"
  | "E_INVALID_STATE";

export class CbxError extends Error {
  readonly code: CbxErrorCode;
  constructor(code: CbxErrorCode, message: string) {
    super(message);
    this.name = "CbxError";
    this.code = code;
  }
}

/** 执行器调用已达成本上限（maxExecutorInvocations）。携带上限与当前计数，
 *  调用方（stage-runner / review-gate / handshake / adaptive）识别后转 needs_fix
 *  + human gate，而不是当作普通执行失败走重试（重试只会继续烧配额）。 */
export class ExecutorCostLimitError extends Error {
  readonly limit: number;
  readonly current: number;
  constructor(limit: number, current: number) {
    super(
      `执行器调用已达成本上限 ${limit} 次（已用 ${current} 次）。请通过 cbx_continue 提供更多预算（配置 max_executor_invocations）或放弃该任务。`,
    );
    this.name = "ExecutorCostLimitError";
    this.limit = limit;
    this.current = current;
  }
}

/**
 * 安全策略漂移：任务创建时的 `.cbx.json` 安全指纹（成本闸/插件白名单/reviewGate/
 * 环境白名单）与执行期现读值不一致——工作区 `.cbx.json` 在任务创建后被修改
 * （非隔离执行器 cwd=workspace 可改写，静默拆掉安全/成本控制即此场景）。fail-closed：
 * 拒绝执行器调用，转 needs_fix，绝不静默用新策略继续。
 */
export class ExecutorPolicyDriftError extends Error {
  constructor() {
    super(
      "安全策略漂移：工作区 .cbx.json 的 cost/plugins/reviewGate/executors 配置在任务创建后被修改，已拒绝执行器调用以保护成本/安全控制。请确认配置变更意图后重新创建任务或显式刷新基线。",
    );
    this.name = "ExecutorPolicyDriftError";
  }
}

export function isCbxError(error: unknown, code?: CbxErrorCode): error is CbxError {
  return error instanceof CbxError && (code === undefined || error.code === code);
}

/** 是否"不可重试的执行器调用拒绝"：成本上限或策略漂移。调用方识别后转 needs_fix
 *  + human gate，绝不当作普通执行失败走重试（重试只会继续烧配额或绕过已拒绝的
 *  策略）。类型守卫：命中时 error 收窄为 Error 子类，调用方可直接用 error.message。 */
export function isUnretryableInvocationError(
  error: unknown,
): error is ExecutorCostLimitError | ExecutorPolicyDriftError {
  return (
    error instanceof ExecutorCostLimitError ||
    error instanceof ExecutorPolicyDriftError
  );
}
