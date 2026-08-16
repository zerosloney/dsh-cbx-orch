import { closeSync, fsyncSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { publishEvent } from "./observability.js";
import {
  loadRuntimeConfig,
  loadPersistedState,
  forgetPersistedJob,
  prunePersistedData,
  savePersistedState,
  savePersistedStateCas,
  savePersistedStateAndFinishQueue,
  savePersistedStateAndResolveApprovalQueue,
  saveApprovalRequeue,
  setMetadata,
  saveJson,
  now,
  redactText,
  withQueueLock,
  type RuntimeConfig,
} from "./storage.js";
import { assertJobId } from "./validation.js";
import { CbxError } from "./errors.js";
import { cleanupWorktree } from "./worktree.js";
import { normalizeAdaptiveOptions } from "./adaptive-manager.js";
import type { JobState, CbxConfig, Json } from "./types.js";

/** job 级事件流轮转阈值：超过即滚动到 events.ndjson.1（单代保留）。timeline/回放只读
 *  主文件，轮转保证读取与 SSE 回放的内存开销有界；.1 代供人工排查历史。 */
const JOB_EVENTS_ROTATE_BYTES = 10 * 1024 * 1024;

/** 事件流写入失败只告警一次：持续刷屏会淹没真正的日志，但首次失败必须留痕。 */
let logJobEventWriteWarned = false;

/** 把降级路径的失败原因落到 job 事件流，避免裸吞导致排障无据。 */
export function logJobEvent(
  workspace: string,
  jobId: string,
  event: string,
  detail: Record<string, unknown> = {},
): void {
  try {
    const file = path.join(jobDir(workspace, jobId), "events.ndjson");
    // 轮转：长任务（或反复 retry 的任务）的事件流无界增长会拖慢 timeline 构建与
    // 读取；超过阈值滚动一代。rename 失败（Windows 文件锁）时退化为继续追加。
    try {
      if (statSync(file).size > JOB_EVENTS_ROTATE_BYTES) {
        try {
          unlinkSync(`${file}.1`);
        } catch {
          /* 无历史代 */
        }
        renameSync(file, `${file}.1`);
      }
    } catch {
      /* 文件尚不存在或轮转失败：不影响本次追加 */
    }
    // fsync 保证审计事件在系统级崩溃（断电）后仍可恢复：appendFileSync 仅落 OS page cache，
    // 进程崩溃安全但系统崩溃可能丢尾部。事件流是 job 审计的唯一来源（无 SQLite 副本），值得 fsync。
    // 写入边界统一脱敏（内置凭据形状）：事件 detail 可能携带执行器输出/错误文本，
    // 其中回显的内联凭据不得持久落盘（agent.log/test.log 同此约束）。
    const fd = openSync(file, "a");
    try {
      writeSync(fd, redactText(JSON.stringify({ event, jobId, ...detail, at: now() })) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    logJobEventWriteWarned = false;
  } catch (error) {
    if (!logJobEventWriteWarned) {
      logJobEventWriteWarned = true;
      console.error(
        `cbx: 事件流写入失败（后续同类失败静默）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function jobDir(workspace: string, jobId: string): string {
  assertJobId(jobId);
  return path.join(workspace, ".cbx", "jobs", jobId);
}

export async function loadState(
  workspace: string,
  jobId: string,
): Promise<JobState> {
  jobDir(workspace, jobId);
  const value = await loadPersistedState<JobState>(workspace, jobId);
  if (!value || typeof value !== "object")
    throw new CbxError(
      "E_NOT_FOUND",
      `任务不存在或状态文件损坏：${jobId}`,
    );
  return value;
}

export async function loadConfig(workspaceInput: string): Promise<CbxConfig> {
  return loadRuntimeConfig(workspaceInput);
}

/**
 * 任务进入终态后的保留期清理入口：加载 governance.retentionDays 并调用 prunePersistedData。
 *
 * 这是终态路径（approve / cancel / executeJob 早返回与终态分支）的唯一保留期清理入口。
 * 之前 13bf85f 重构把 prunePersistedData 从 state.ts / queue-api.ts 移走，散到 4 个文件
 * 6 个调用点、每点都各自 loadConfig 一次；现在收成单 helper，retentionDays 解析与
 * prune 调用是同一个原子单元——未来加 retentionHours / 多段保留 / 中间态清理，
 * 改这一处即可。
 *
 * 周期性清理（health check）走 `prunePersistedData(workspace, config.governance?.retentionDays)`
 * 直接调，那是另一个关注点，不在终态触发范围内。
 */
export async function pruneAfterTerminal(workspace: string): Promise<number> {
  const retentionDays = (await loadConfig(workspace)).governance?.retentionDays;
  return prunePersistedData(workspace, retentionDays);
}

/** 禁止直接 forget/purge 的活跃状态——必须先 cancel / approve。 */
const FORBIDDEN_FORGET_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "queued",
  "awaiting_approval",
]);

export interface ForgetOptions {
  /** 是否连带删 worktree（cbx purge 走 true，cbx forget 走 false）。 */
  purgeWorktree: boolean;
  /** 写 lifecycle/deleted 事件时附带的元数据（调用方来源、reason 等）。 */
  reason?: string;
}

export interface ForgetResult {
  jobId: string;
  status: string;
  deletedDirectory: boolean;
  worktreeCleaned: boolean;
  remainingQueueEntries: number;
  tombstonedAt: string;
}

/**
 * 删除一个 job 的全部持久化记录：state.json / events.ndjson / 产物文件、SQLite jobs 表行、
 * queue_state 中该 jobId 的全部 entries。默认**不**删 worktree——`cbx forget` 留给
 * `--keep-worktree` 用户的轻量入口，`cbx purge` 走 `purgeWorktree: true` 删 worktree。
 *
 * 状态守卫：running / queued / awaiting_approval 必须先 cancel / approve，否则抛错。
 * rationale：删正在跑的 job 留存的 .cbx/jobs/<id>/active.pid 与 worktree 状态会进入
 * 撕裂态（worker 还活着但 state 没了），且无审计痕迹。
 *
 * 顺序：先写 lifecycle/deleted 事件（依赖 appendFileSync、不依赖 jobs 表）→ 删 SQLite 行
 * 与 queue entries（单事务，forgetPersistedJob）→ 删目录（异步 rm）→ 写 tombstone。
 * tombstone 写到 metadata 表而非 events 流，避免被 events.ndjson 跟着一起 rm 掉。
 */
export async function forgetJob(
  workspace: string,
  jobId: string,
  options: ForgetOptions,
): Promise<ForgetResult> {
  assertJobId(jobId);
  const state = await loadState(workspace, jobId);
  if (FORBIDDEN_FORGET_STATUSES.has(state.status))
    throw new Error(
      `任务 ${jobId} 当前状态为 ${state.status}；请先 cancel（运行中或排队）或 approve（等待审批），再 forget/purge。`,
    );
  // 事件先于删除落盘：appendFileSync 写 events.ndjson 不依赖 jobs 表行。
  // 注意：成功 forget 时 jobDir 连同 events.ndjson 会被下方 rm 一起擦除，故本事件
  // 是"删除前审计记录"，仅在目录 rm 失败时随 events.ndjson 保留。持久的删除审计
  // 靠 metadata tombstone（forgotten:<jobId>）+ webhook job.deleted（workspace 级 outbox），
  // 二者都不随 jobDir 删除。
  logJobEvent(workspace, jobId, "lifecycle/deleted", {
    fromStatus: state.status,
    purgeWorktree: options.purgeWorktree,
    reason: options.reason ?? null,
  });
  // 目录删除放在 SQLite 事务之前：rm 失败时 jobs 行未动，loadState 仍能读到，
  // 用户可重试 forget（或手动 rm 目录后再 forget）。若反之（先删行再 rm），rm 失败后
  // 重试会因 jobs 行已删 → loadState 抛 E_NOT_FOUND 而死锁，无法自愈。
  const directory = jobDir(workspace, jobId);
  let deletedDirectory = false;
  try {
    await rm(directory, { recursive: true, force: true });
    deletedDirectory = true;
  } catch (error) {
    throw new Error(
      `清理目录失败：${directory}（${(error as Error).message}）。SQLite 记录未动，可重试 forget 或手动删除该目录。`,
    );
  }
  const { remainingEntries } = await forgetPersistedJob(workspace, jobId);
  // worktree 在 forget 路径上**保留**；purge 才删。
  const worktreeCleaned = options.purgeWorktree
    ? await cleanupWorktree(workspace, jobId)
    : false;
  const tombstonedAt = now();
  try {
    await setMetadata(workspace, `forgotten:${jobId}`, tombstonedAt);
  } catch {
    /* tombstone 失败不影响 forget 主流程。tombstone 是 metadata 表的持久审计记录
       （可经 getMetadata 查询），不参与"防同 id 重建"——那由 SQLite 行缺失在 createJob
       时报错承担（jobDir 已删 + 行已删，state 缺失即报错），与 importLegacyData 一致。 */
  }
  try {
    await publishEvent(workspace, "job.deleted", {
      jobId,
      fromStatus: state.status,
      purgeWorktree: options.purgeWorktree,
    });
  } catch {
    /* webhook 投递失败不应阻塞 forget 主流程 */
  }
  return {
    jobId,
    status: state.status,
    deletedDirectory,
    worktreeCleaned,
    remainingQueueEntries: remainingEntries,
    tombstonedAt,
  };
}

/** 便捷入口：保留 worktree 的 forget（cbx forget）。 */
export function forgetJobKeepWorktree(
  workspace: string,
  jobId: string,
  reason?: string,
): Promise<ForgetResult> {
  return forgetJob(workspace, jobId, { purgeWorktree: false, reason });
}

/** 便捷入口：连 worktree 一起删的 purge（cbx purge）。 */
export function purgeJob(
  workspace: string,
  jobId: string,
  reason?: string,
): Promise<ForgetResult> {
  return forgetJob(workspace, jobId, { purgeWorktree: true, reason });
}

export function mergeConfig(
  config: CbxConfig,
  overrides: Partial<CbxConfig> & {
    approvalBeforeRun?: boolean;
    approvalBeforeComplete?: boolean;
    autoBranch?: boolean;
    autoCommit?: boolean;
    commitMessage?: string;
    trustMode?: "trusted" | "untrusted";
  },
): Required<
  Pick<
    CbxConfig,
    | "review"
    | "isolated"
    | "timeoutMs"
    | "maxRetries"
    | "maxTurns"
    | "keepWorktree"
    | "permissionMode"
    | "maxConcurrent"
    | "dependencyGuard"
  >
> &
  Pick<
    CbxConfig,
    "testCommand" | "reviewRules" | "executor" | "reviewExecutor"
  > & {
    approvalBeforeRun: boolean;
    approvalBeforeComplete: boolean;
    autoBranch: boolean;
    autoCommit: boolean;
    commitMessage: string;
    trustMode: "trusted" | "untrusted";
    adaptive: import("./adaptive-manager.js").AdaptiveOptions;
  } {
  const adaptive = normalizeAdaptiveOptions(
    overrides.adaptive,
    normalizeAdaptiveOptions(config.adaptive),
  );
  return {
    testCommand: overrides.testCommand ?? config.testCommand,
    review: overrides.review ?? config.review ?? false,
    isolated: overrides.isolated ?? config.isolated ?? false,
    timeoutMs: overrides.timeoutMs ?? config.timeoutMs ?? 30 * 60_000,
    maxRetries: overrides.maxRetries ?? config.maxRetries ?? 1,
    maxTurns: overrides.maxTurns ?? config.maxTurns ?? 50,
    keepWorktree: overrides.keepWorktree ?? config.keepWorktree ?? false,
    permissionMode: overrides.permissionMode ?? config.permissionMode ?? "auto",
    reviewRules: overrides.reviewRules ?? config.reviewRules,
    approvalBeforeRun:
      overrides.approvalBeforeRun ?? config.approval?.beforeRun ?? false,
    approvalBeforeComplete:
      overrides.approvalBeforeComplete ??
      config.approval?.beforeComplete ??
      false,
    maxConcurrent: overrides.maxConcurrent ?? config.maxConcurrent ?? 2,
    autoBranch: overrides.autoBranch ?? config.git?.autoBranch ?? false,
    autoCommit: overrides.autoCommit ?? config.git?.autoCommit ?? false,
    commitMessage:
      overrides.commitMessage ??
      config.git?.commitMessage ??
      "chore(cbx): apply task",
    executor: overrides.executor ?? config.executor ?? "codebuddy",
    reviewExecutor: overrides.reviewExecutor ?? config.reviewExecutor,
    trustMode: overrides.trustMode ?? config.execution?.trustMode ?? "trusted",
    dependencyGuard:
      overrides.dependencyGuard ?? config.dependencyGuard ?? false,
    adaptive,
  };
}

/**
 * state.json 是人类可读镜像，权威存储是 SQLite：镜像写失败（Windows AV 锁住
 * rename 等）只落审计事件降级，不能让已提交的 SQLite 状态向上抛错——那会让调用
 * 方误判写入失败并重试，且两库从此永久分歧、无从对账。
 */
async function mirrorStateFile(
  workspace: string,
  jobId: string,
  state: JobState,
): Promise<void> {
  try {
    await saveJson(path.join(jobDir(workspace, jobId), "state.json"), state);
  } catch (error) {
    logJobEvent(workspace, jobId, "state_mirror_write_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function writeState(
  workspace: string,
  jobId: string,
  updates: Json,
  queueEntryId?: string,
): Promise<JobState> {
  // 终态双写与调度器整 blob 写回共用队列锁：否则两者并发时 worker 的终态会被调度器的旧快照覆盖。
  if (queueEntryId) {
    const state = await loadState(workspace, jobId);
    const previousStatus = state.status;
    Object.assign(state, updates, { updatedAt: now() });
    await withQueueLock(
      workspace,
      () =>
        savePersistedStateAndFinishQueue(workspace, jobId, state, queueEntryId),
      { retries: 120 },
    );
    await mirrorStateFile(workspace, jobId, state);
    await publishStateEvent(workspace, jobId, previousStatus, state);
    return state;
  }
  // 非终态写不走队列锁，与调度器/其他写者并发：按 CAS 重读重放，不再整 blob
  // 盲覆盖回退对方快照（重试 5 次后仍冲突则退化为直接写，避免饿死）。
  for (let attempt = 0; ; attempt += 1) {
    const base = await loadState(workspace, jobId);
    const previousStatus = base.status;
    const expected = { ...base };
    Object.assign(base, updates, { updatedAt: now() });
    if (
      attempt >= 5 ||
      (await savePersistedStateCas(workspace, jobId, expected, base))
    ) {
      await mirrorStateFile(workspace, jobId, base);
      await publishStateEvent(workspace, jobId, previousStatus, base);
      return base;
    }
  }
}

async function publishStateEvent(
  workspace: string,
  jobId: string,
  previousStatus: string,
  state: JobState,
): Promise<void> {
  try {
    await publishEvent(workspace, "job.state_changed", {
      jobId,
      previousStatus,
      status: state.status,
      phase: state.phase,
      attempt: state.attempt,
    });
  } catch {
    /* event delivery must not mask the durable state change */
  }
}

/**
 * 轻量级递增执行器调用计数：仅修改 state.json + SQLite 持久化副本，不发 job.state_changed 事件。
 *
 * 使用场景：runner.ts:invokeExecutor 每次被调用前自增一次，区分角色（stage/review/manager）
 * 和 stageIndex（仅 stage 角色）。读端（result.json / UI 概览）聚合展示实际预算消耗。
 *
 * 不加 withFileLock：调用方（stage-runner 内部）已持有 run.lock 串行所有 invokeExecutor 调用，
 * 嵌套加锁会导致自己死锁自己（retries=0 立即 busyMessage）。worker 进程内单 job 串行可保原子。
 */
export async function bumpInvocationCount(
  workspace: string,
  jobId: string,
  role: "stage" | "review" | "manager" | "gate",
  stageIndex?: number,
): Promise<void> {
  // 仅在实际执行中计数（见下方状态守卫）；无锁读改写按 CAS 收敛，
  // 不再整 blob 盲覆盖（那会把并发终态"复活"成 running 或回退他人快照）。
  for (let attempt = 0; ; attempt += 1) {
    const base = await loadState(workspace, jobId);
    if (base.status !== "running") return;
    const expected = { ...base };
    const current =
      typeof base.executorInvocations === "number" &&
      Number.isInteger(base.executorInvocations)
        ? base.executorInvocations
        : 0;
    const updates: Json = { executorInvocations: current + 1 };
    if (role === "stage" && Number.isInteger(stageIndex)) {
      const key = String(stageIndex);
      const existing = (base.stageInvocations as
        | Record<string, number>
        | undefined) ?? {};
      updates.stageInvocations = {
        ...existing,
        [key]: (Number(existing[key]) || 0) + 1,
      };
    }
    // 不走 writeState（会发布 job.state_changed 事件，污染事件流）。
    // 直接同步 SQLite + state.json 文件，保留 updatedAt。
    Object.assign(base, updates, { updatedAt: now() });
    if (
      attempt >= 5 ||
      (await savePersistedStateCas(workspace, jobId, expected, base))
    ) {
      await mirrorStateFile(workspace, jobId, base);
      return;
    }
  }
}

/** 任务创建时记录 configuredMaxTurns；Stage 独立覆盖时由 stage-runner 在 stage 启动时写。 */
export async function recordConfiguredMaxTurns(
  workspace: string,
  jobId: string,
  maxTurns: number,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const base = await loadState(workspace, jobId);
    if (base.configuredMaxTurns === maxTurns) return;
    const expected = { ...base };
    Object.assign(base, { configuredMaxTurns: maxTurns, updatedAt: now() });
    if (
      attempt >= 5 ||
      (await savePersistedStateCas(workspace, jobId, expected, base))
    ) {
      await mirrorStateFile(workspace, jobId, base);
      return;
    }
  }
}

export async function writeApprovalState(
  workspace: string,
  jobId: string,
  updates: Json,
  queueStatus: "done" | "failed",
): Promise<JobState> {
  const state = await loadState(workspace, jobId);
  const previousStatus = state.status;
  Object.assign(state, updates, { updatedAt: now() });
  // 审批终态同样并入队列锁，避免与调度器整 blob 写回互相覆盖。
  await withQueueLock(
    workspace,
    () =>
      savePersistedStateAndResolveApprovalQueue(
        workspace,
        jobId,
        state,
        queueStatus,
      ),
    { retries: 120 },
  );
  await mirrorStateFile(workspace, jobId, state);
  try {
    await publishEvent(workspace, "job.state_changed", {
      jobId,
      previousStatus,
      status: state.status,
      phase: state.phase,
      attempt: state.attempt,
    });
  } catch {
    /* durable approval transition must not depend on delivery */
  }
  return state;
}

/**
 * before_run 审批通过的重入队写入：state 回 queued 与队列条目重新激活同事务
 * （saveApprovalRequeue），取代"writeApprovalState(done) + 调用方补 startBackground"
 * 的两段式——后者两步之间崩溃会留下永不调度的 queued 任务。
 */
export async function writeApprovalRequeueState(
  workspace: string,
  jobId: string,
  updates: Json,
): Promise<JobState> {
  const state = await loadState(workspace, jobId);
  const previousStatus = state.status;
  Object.assign(state, updates, { updatedAt: now() });
  await withQueueLock(
    workspace,
    () => saveApprovalRequeue(workspace, jobId, state),
    { retries: 120 },
  );
  await mirrorStateFile(workspace, jobId, state);
  try {
    await publishEvent(workspace, "job.state_changed", {
      jobId,
      previousStatus,
      status: state.status,
      phase: state.phase,
      attempt: state.attempt,
    });
  } catch {
    /* durable approval transition must not depend on delivery */
  }
  return state;
}
