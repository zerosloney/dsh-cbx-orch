import { createHash } from "node:crypto";
import {
  deleteMetadata,
  getMetadata,
  replaceMetadataIfMatch,
  setMetadata,
  tryReserveMetadata,
} from "./storage.js";
import { loadState } from "./state.js";

/**
 * 创建幂等键（HR 式 reservation 语义，防重复委派）：
 *
 * 模型/客户端重试 cbx_run（丢响应、超时重发、或单纯调了两次）时，同一任务会被
 * 创建两份——两个执行器进程在同一工作区跑同一个目标，产物互相踩踏。幂等键把
 * "创建"变成可重试的操作：同键同指纹 → 返回既有任务；同键不同指纹 → 显式报错
 * （静默错任务比失败更糟）。
 *
 * 时序与崩溃安全（预留先于创建，写前日志式两步）：
 * 1. begin：INSERT OR IGNORE 原子预留（只有一方拿到）；
 * 2. createJob 成功后 commit 回填 jobId；
 * 3. createJob 失败则 abort 释放——失败不留下毒键，重试可以真正重跑；
 * 4. 崩溃窗口（预留了但没来得及 commit）：jobId=null 的悬空预留。宽限期内视为
 *    in-flight（并发创建中，第二调用方收到明确错误而不是双建）；超过宽限期视为
 *    上次创建者已死，CAS 接管后重新创建——并发接管也只有一方能赢。
 * 5. 预留指向的任务已被清理/遗忘（loadState 读不到）：同样 CAS 接管重建。
 */

/** jobId=null 的悬空预留宽限期：超过才允许接管（正常创建远快于此）。 */
export const IDEMPOTENCY_IN_FLIGHT_GRACE_MS = 60_000;

/** 幂等键长度上限（SQLite 值无路径语义，纯防御性约束）。 */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 256;

export interface IdempotencyReservation {
  /** 关联的 jobId；null = 预留了但尚未成功创建。 */
  jobId: string | null;
  /** 创建请求指纹（sha256），用于拒绝"同键不同载荷"。 */
  requestHash: string;
  createdAt: string;
}

function storageKey(key: string): string {
  return `idem:${key}`;
}

function parseReservation(raw: string | undefined): IdempotencyReservation | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<IdempotencyReservation>;
    if (
      !value ||
      typeof value !== "object" ||
      (value.jobId !== null && typeof value.jobId !== "string") ||
      typeof value.requestHash !== "string" ||
      typeof value.createdAt !== "string"
    )
      return undefined;
    return { jobId: value.jobId, requestHash: value.requestHash, createdAt: value.createdAt };
  } catch {
    return undefined;
  }
}

function serialize(reservation: IdempotencyReservation): string {
  return JSON.stringify(reservation);
}

/**
 * 创建请求指纹。payload 必须是"字段顺序确定的普通对象"（调用方用对象字面量
 * 构造即可——JSON.stringify 按写入序输出），同一请求重复构造必须得到同一哈希。
 */
export function hashIdempotentRequest(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
}

export type IdempotentCreateOutcome =
  | { kind: "reserved"; takeover: boolean }
  | { kind: "duplicate"; jobId: string; status?: string; createdAt: string }
  | { kind: "in-flight"; createdAt: string }
  | { kind: "conflict"; createdAt: string };

/**
 * 创建前的预留检查。返回 reserved（含 stale 接管，takeover=true 供审计）时
 * 调用方才可以真正 createJob；其余情况不得创建。
 */
export async function beginIdempotentCreate(
  workspace: string,
  key: string,
  requestHash: string,
): Promise<IdempotentCreateOutcome> {
  const fresh = serialize({ jobId: null, requestHash, createdAt: new Date().toISOString() });
  const reserved = await tryReserveMetadata(workspace, storageKey(key), fresh);
  if (reserved) return { kind: "reserved", takeover: false };

  const existingRaw = await getMetadata(workspace, storageKey(key));
  const existing = parseReservation(existingRaw);
  if (!existing) {
    // 预留值损坏（手工编辑/半截写入）：孤儿，CAS 接管；输家按 in-flight 处理。
    if (await replaceMetadataIfMatch(workspace, storageKey(key), existingRaw ?? "", fresh)) {
      return { kind: "reserved", takeover: true };
    }
    return { kind: "in-flight", createdAt: new Date().toISOString() };
  }
  if (existing.requestHash !== requestHash) {
    // 同键不同载荷：几乎必然是调用方 bug，宁可报错也不静默跑错任务。
    return { kind: "conflict", createdAt: existing.createdAt };
  }
  if (existing.jobId) {
    // 已链接任务：任务还在 → duplicate；已被 forget/purge → 孤儿预留，接管重建。
    let status: string | undefined;
    try {
      status = String((await loadState(workspace, existing.jobId)).status);
    } catch {
      status = undefined;
    }
    if (status !== undefined) {
      return { kind: "duplicate", jobId: existing.jobId, status, createdAt: existing.createdAt };
    }
  } else {
    const age = Date.now() - Date.parse(existing.createdAt);
    if (Number.isFinite(age) && age >= 0 && age < IDEMPOTENCY_IN_FLIGHT_GRACE_MS) {
      return { kind: "in-flight", createdAt: existing.createdAt };
    }
  }
  // 悬空预留（超宽限）或任务已消失：CAS 接管；并发接管输家按 in-flight 处理。
  if (await replaceMetadataIfMatch(workspace, storageKey(key), existingRaw!, fresh)) {
    return { kind: "reserved", takeover: true };
  }
  return { kind: "in-flight", createdAt: existing.createdAt };
}

/** 创建成功后回填 jobId（保留首次预留的 requestHash/createdAt 审计信息）。 */
export async function commitIdempotentCreate(
  workspace: string,
  key: string,
  jobId: string,
): Promise<void> {
  const raw = await getMetadata(workspace, storageKey(key));
  const existing = parseReservation(raw);
  const next: IdempotencyReservation = {
    jobId,
    requestHash: existing?.requestHash ?? "",
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  await setMetadata(workspace, storageKey(key), serialize(next));
}

/** createJob 失败时释放预留——失败不留毒键，同键重试可以真正重跑。 */
export async function abortIdempotentCreate(
  workspace: string,
  key: string,
): Promise<void> {
  await deleteMetadata(workspace, storageKey(key));
}
