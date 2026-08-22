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
  | "E_NOT_FOUND";

export class CbxError extends Error {
  readonly code: CbxErrorCode;
  constructor(code: CbxErrorCode, message: string) {
    super(message);
    this.name = "CbxError";
    this.code = code;
  }
}

export function isCbxError(error: unknown, code?: CbxErrorCode): error is CbxError {
  return error instanceof CbxError && (code === undefined || error.code === code);
}
