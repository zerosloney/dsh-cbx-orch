/**
 * storage/locks —— 文件锁与队列锁（跨进程互斥）。
 *
 * 从原 storage.ts 抽出。文件锁基于 wx 原子创建 + pid 存活判定 + 超龄回收；
 * 队列写互斥的唯一来源（调度器整 blob 写回与 worker 终态双写共用）。
 */
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { CbxError, type CbxErrorCode } from "../errors.js";
import { now, isMissing, processAlive } from "./io.js";
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
