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

export function isCbxError(error: unknown, code?: CbxErrorCode): error is CbxError {
  return error instanceof CbxError && (code === undefined || error.code === code);
}
