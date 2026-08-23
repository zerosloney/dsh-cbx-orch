/**
 * storage/outbox —— 投递 outbox（webhook/OTLP 持久化队列）。
 *
 * 从原 storage.ts 抽出。delivery_outbox 表（带租约认领、重试、死信）与
 * delivery_failures 审计表。observability.ts 的投递循环依赖本模块。
 */
import { database } from "./db.js";
import { now } from "./io.js";
export async function recordDeliveryFailure(
  workspace: string,
  value: unknown,
): Promise<void> {
  const db = await database(workspace);
  db.prepare(
    "INSERT INTO delivery_failures(created_at, record_json) VALUES (?, ?)",
  ).run(now(), JSON.stringify(value));
}
export interface PendingDelivery {
  id: number;
  channel: "webhook" | "otlp";
  endpoint: string;
  body: unknown;
  config: { timeoutMs?: number; maxRetries?: number; retryBaseMs?: number };
  attempts: number;
}

export async function enqueueDelivery(
  workspace: string,
  delivery: Omit<PendingDelivery, "id" | "attempts">,
): Promise<number> {
  const db = await database(workspace);
  const result = db
    .prepare(
      "INSERT INTO delivery_outbox(created_at, channel, endpoint, body_json, config_json, attempts, available_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    )
    .run(
      now(),
      delivery.channel,
      delivery.endpoint,
      JSON.stringify(delivery.body),
      JSON.stringify(delivery.config),
      Date.now(),
    );
  return Number(result.lastInsertRowid);
}

export async function claimPendingDelivery(
  workspace: string,
  owner: string,
  lockMs = 30_000,
): Promise<PendingDelivery | undefined> {
  const db = await database(workspace);
  return db.transaction(() => {
    const current = Date.now();
    const row = db
      .prepare(
        "SELECT id, channel, endpoint, body_json, config_json, attempts FROM delivery_outbox WHERE available_at <= ? AND (locked_until IS NULL OR locked_until < ?) ORDER BY id LIMIT 1",
      )
      .get(current, current) as
      | {
          id: number;
          channel: "webhook" | "otlp";
          endpoint: string;
          body_json: string;
          config_json: string;
          attempts: number;
        }
      | undefined;
    if (!row) return undefined;
    const claimed = db
      .prepare(
        "UPDATE delivery_outbox SET locked_by = ?, locked_until = ? WHERE id = ? AND (locked_until IS NULL OR locked_until < ?)",
      )
      .run(owner, current + lockMs, row.id, current).changes;
    if (!claimed) return undefined;
    return {
      id: row.id,
      channel: row.channel,
      endpoint: row.endpoint,
      body: JSON.parse(row.body_json),
      config: JSON.parse(row.config_json),
      attempts: row.attempts,
    };
  })();
}

export async function rescheduleDelivery(
  workspace: string,
  id: number,
  owner: string,
  attempts: number,
  availableAt: number,
  error: string,
): Promise<void> {
  const db = await database(workspace);
  db.prepare(
    "UPDATE delivery_outbox SET attempts = ?, available_at = ?, last_error = ?, locked_by = NULL, locked_until = NULL WHERE id = ? AND locked_by = ?",
  ).run(attempts, availableAt, error, id, owner);
}

export async function completeDelivery(
  workspace: string,
  id: number,
  owner: string,
): Promise<void> {
  const db = await database(workspace);
  db.prepare("DELETE FROM delivery_outbox WHERE id = ? AND locked_by = ?").run(
    id,
    owner,
  );
}

export async function nextPendingDeliveryAt(
  workspace: string,
): Promise<number | undefined> {
  const db = await database(workspace);
  const row = db
    .prepare(
      "SELECT MIN(CASE WHEN locked_until IS NOT NULL AND locked_until > ? THEN locked_until ELSE available_at END) AS available_at FROM delivery_outbox",
    )
    .get(Date.now()) as { available_at: number | null };
  return row.available_at ?? undefined;
}
