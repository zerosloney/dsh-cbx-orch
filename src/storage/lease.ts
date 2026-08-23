/**
 * storage/lease —— 常驻调度器租约（跨进程互斥）。
 *
 * 从原 storage.ts 抽出。service_leases 表 + owner_token 防双主：同进程 HMR 重载
 * 可接管，跨进程严格互斥；续期失败自动让位。
 */
import { database } from "./db.js";
import { now, processAlive } from "./io.js";
import { randomBytes } from "node:crypto";
import { CbxError } from "../errors.js";
export interface ServiceLease {
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

export async function acquireServiceLease(
  workspace: string,
  name: string,
  ttlMs = 45_000,
): Promise<ServiceLease> {
  const db = await database(workspace);
  const token = randomBytes(16).toString("hex");
  const acquire = db.transaction(() => {
    const current = Date.now();
    const lease = db
      .prepare(
        "SELECT owner_pid, expires_at FROM service_leases WHERE name = ?",
      )
      .get(name) as { owner_pid: number; expires_at: number } | undefined;
    // 同进程旧实例的租约允许接管（HMR 重载场景）：新模块实例抢走 owner_token 后，
    // 旧实例的下一次 renew 会因 token 不匹配返回 false 而自动停止——同进程内
    // 双调度器最多并存一个租约周期，跨进程仍严格互斥。
    if (
      lease &&
      lease.expires_at > current &&
      lease.owner_pid !== process.pid &&
      processAlive(lease.owner_pid)
    )
      throw new CbxError(
        "E_LEASE_HELD",
        "已有活跃 serve 实例；每个工作区只允许一个常驻调度器。",
      );
    db.prepare(
      "INSERT INTO service_leases(name, owner_pid, expires_at, owner_token) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET owner_pid = excluded.owner_pid, expires_at = excluded.expires_at, owner_token = excluded.owner_token",
    ).run(name, process.pid, current + ttlMs, token);
  });
  acquire();
  return {
    async renew(): Promise<boolean> {
      return (
        db
          .prepare(
            "UPDATE service_leases SET expires_at = ? WHERE name = ? AND owner_token = ?",
          )
          .run(Date.now() + ttlMs, name, token).changes === 1
      );
    },
    async release(): Promise<void> {
      db.prepare(
        "DELETE FROM service_leases WHERE name = ? AND owner_token = ?",
      ).run(name, token);
    },
  };
}
