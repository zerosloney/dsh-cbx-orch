import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  claimPendingDelivery,
  completeDelivery,
  enqueueDelivery,
  loadRuntimeConfig,
  nextEventSeq,
  nextPendingDeliveryAt,
  recordDeliveryFailure,
  redactSensitive,
  rescheduleDelivery,
  type PendingDelivery,
  type RuntimeConfig,
} from "./storage.js";

interface DeliveryConfig {
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
}
interface NotificationConfig extends DeliveryConfig {
  webhook?: string;
  filters?: {
    events?: string[];
    jobIds?: string[];
    statuses?: string[];
  };
}
interface TelemetryConfig extends DeliveryConfig {
  enabled?: boolean;
  endpoint?: string;
  serviceName?: string;
}
interface ObservabilityConfig extends RuntimeConfig {
  notifications?: NotificationConfig;
  telemetry?: TelemetryConfig;
}

function isoNow(): string {
  return new Date().toISOString();
}

/** webhook 事件订阅过滤：AND 语义（多条件同时满足才投递）。未配置的维度不限制；
 *  payload 中 jobId/status 缺失时该维度视为不匹配（避免误投递）。无 filters 时全量。 */
export function matchesWebhookFilters(
  event: { type: string; payload: Record<string, unknown> },
  filters:
    | {
        events?: string[];
        jobIds?: string[];
        statuses?: string[];
      }
    | undefined,
): boolean {
  if (!filters) return true;
  if (filters.events && !filters.events.includes(event.type)) return false;
  const jobId =
    typeof event.payload.jobId === "string" ? event.payload.jobId : undefined;
  if (filters.jobIds && (!jobId || !filters.jobIds.includes(jobId)))
    return false;
  const status =
    typeof event.payload.status === "string" ? event.payload.status : undefined;
  if (filters.statuses && (!status || !filters.statuses.includes(status)))
    return false;
  return true;
}
function id(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}
async function config(workspace: string): Promise<ObservabilityConfig> {
  return loadRuntimeConfig(workspace) as Promise<ObservabilityConfig>;
}
async function append(
  workspace: string,
  file: string,
  value: unknown,
): Promise<void> {
  const directory = path.join(workspace, ".cbx");
  await mkdir(directory, { recursive: true });
  await appendFile(
    path.join(directory, file),
    JSON.stringify(value, null, 0) + "\n",
    "utf8",
  );
}

function deliveryOptions(config: DeliveryConfig): Required<DeliveryConfig> {
  const timeoutMs = config.timeoutMs ?? 3_000;
  const maxRetries = config.maxRetries ?? 2;
  const retryBaseMs = config.retryBaseMs ?? 100;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 50)
    throw new Error("通知 timeoutMs 必须不小于 50ms。");
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10)
    throw new Error("通知 maxRetries 必须是 0 到 10 的整数。");
  if (!Number.isFinite(retryBaseMs) || retryBaseMs < 0)
    throw new Error("通知 retryBaseMs 必须是非负数。");
  return { timeoutMs, maxRetries, retryBaseMs };
}

async function deliverOnce(delivery: PendingDelivery): Promise<void> {
  const options = deliveryOptions(delivery.config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(delivery.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(delivery.body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

const drainTasks = new Map<string, Promise<number>>();
const scheduledDrains = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; due: number }
>();

function scheduleDeliveryDrain(workspace: string, delayMs = 0): void {
  const due = Date.now() + Math.max(0, delayMs);
  const existing = scheduledDrains.get(workspace);
  if (existing && existing.due <= due) return;
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(
    () => {
      scheduledDrains.delete(workspace);
      void flushDeliveries(workspace).catch((error) =>
        console.error(
          `cbx: outbox 投递失败：${error instanceof Error ? error.message : error}`,
        ),
      );
    },
    Math.max(0, due - Date.now()),
  );
  timer.unref();
  scheduledDrains.set(workspace, { timer, due });
}

/** Drain durable notifications. State transitions only enqueue; callers may await this explicitly for shutdown/tests. */
export function flushDeliveries(
  workspace: string,
  waitForRetries = false,
  limit = 100,
): Promise<number> {
  const current = drainTasks.get(workspace);
  if (current)
    return waitForRetries
      ? current.then(() => flushDeliveries(workspace, true, limit))
      : current;
  const task = (async () => {
    const owner = `${process.pid}-${id(8)}`;
    let processed = 0;
    while (processed < limit) {
      const delivery = await claimPendingDelivery(workspace, owner, 130_000);
      if (!delivery) {
        const next = await nextPendingDeliveryAt(workspace);
        if (waitForRetries && next !== undefined && next > Date.now()) {
          await new Promise((resolve) =>
            setTimeout(resolve, next - Date.now()),
          );
          continue;
        }
        if (next !== undefined)
          scheduleDeliveryDrain(workspace, Math.max(0, next - Date.now()));
        break;
      }
      try {
        await deliverOnce(delivery);
        await completeDelivery(workspace, delivery.id, owner);
        processed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const options = deliveryOptions(delivery.config);
        const attempts = delivery.attempts + 1;
        if (attempts > options.maxRetries) {
          const runtime = await config(workspace);
          const failure = redactSensitive(
            {
              type: "delivery.failed",
              at: isoNow(),
              channel: delivery.channel,
              endpoint: delivery.endpoint,
              attempts,
              error: message,
              body: delivery.body,
            },
            runtime.governance?.redactFields,
          ) as Record<string, unknown>;
          await append(workspace, "delivery-failures.ndjson", failure);
          await recordDeliveryFailure(workspace, failure);
          await completeDelivery(workspace, delivery.id, owner);
          console.error(
            `cbx: ${delivery.channel} 投递失败（已重试 ${options.maxRetries} 次）：${message}`,
          );
          processed += 1;
          continue;
        }
        const delay = options.retryBaseMs * 2 ** delivery.attempts;
        await rescheduleDelivery(
          workspace,
          delivery.id,
          owner,
          attempts,
          Date.now() + delay,
          message,
        );
        if (waitForRetries)
          await new Promise((resolve) => setTimeout(resolve, delay));
        else {
          scheduleDeliveryDrain(workspace, delay);
          break;
        }
      }
    }
    return processed;
  })();
  drainTasks.set(workspace, task);
  return task.finally(() => {
    if (drainTasks.get(workspace) === task) drainTasks.delete(workspace);
  });
}

const eventChains = new Map<string, Promise<void>>();

export async function publishEvent(
  workspace: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const previous = eventChains.get(workspace) ?? Promise.resolve();
  const currentTask = previous
    .catch(() => undefined)
    .then(async () => {
      // seq 经 SQLite 单事务原子自增（nextEventSeq），保证并发 worker（独立进程）不会读到相同值。
      // eventChains 仅串行化本进程内的发布顺序（保证 NDJSON 追加因果），跨进程唯一性由 SQLite 行锁保证。
      const seq = await nextEventSeq(workspace);
      const event = { id: id(12), seq, type, at: isoNow(), workspace, payload };
      const current = await config(workspace);
      const redacted = redactSensitive(
        event,
        current.governance?.redactFields,
      ) as typeof event;
      await append(workspace, "events.ndjson", redacted);
      const notifications = current.notifications;
      const webhook = notifications?.webhook;
      if (webhook && notifications) {
        // webhook 订阅过滤：不匹配的事件不 enqueue、不落 delivery 记录。
        // 本地 events.ndjson 已在上方 append（全量），仅投递被过滤。
        if (matchesWebhookFilters({ type, payload }, notifications.filters)) {
          await enqueueDelivery(workspace, {
            channel: "webhook",
            endpoint: webhook,
            body: redacted,
            config: notifications,
          });
          scheduleDeliveryDrain(workspace);
        }
      }
    });
  eventChains.set(workspace, currentTask);
  try {
    await currentTask;
  } finally {
    if (eventChains.get(workspace) === currentTask)
      eventChains.delete(workspace);
  }
}

export interface SpanHandle {
  traceId: string;
  spanId: string;
  name: string;
  startedAt: number;
  attributes: Record<string, string | number | boolean>;
}
export function startSpan(
  name: string,
  attributes: Record<string, string | number | boolean> = {},
): SpanHandle {
  return {
    traceId: id(16),
    spanId: id(8),
    name,
    startedAt: Date.now(),
    attributes,
  };
}

export async function finishSpan(
  workspace: string,
  span: SpanHandle,
  status: string,
  attributes: Record<string, string | number | boolean> = {},
): Promise<void> {
  const endedAt = Date.now();
  const spanRecord = {
    traceId: span.traceId,
    spanId: span.spanId,
    name: span.name,
    startedAt: span.startedAt,
    endedAt,
    durationMs: endedAt - span.startedAt,
    status,
    attributes: { ...span.attributes, ...attributes },
  };
  await append(workspace, "telemetry.ndjson", spanRecord);
  const current = await config(workspace);
  if (!current.telemetry?.enabled || !current.telemetry.endpoint) return;
  const startNs = String(span.startedAt * 1_000_000);
  const endNs = String(endedAt * 1_000_000);
  const attributesList = Object.entries(spanRecord.attributes).map(
    ([key, value]) => ({
      key,
      value:
        typeof value === "boolean"
          ? { boolValue: value }
          : typeof value === "number"
            ? { intValue: String(value) }
            : { stringValue: String(value) },
    }),
  );
  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: {
                stringValue:
                  current.telemetry.serviceName ?? "cbx-orchestrator",
              },
            },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: span.traceId,
                spanId: span.spanId,
                name: span.name,
                startTimeUnixNano: startNs,
                endTimeUnixNano: endNs,
                attributes: attributesList,
                status: { code: status === "ok" ? 1 : 2 },
              },
            ],
          },
        ],
      },
    ],
  };
  await enqueueDelivery(workspace, {
    channel: "otlp",
    endpoint: current.telemetry.endpoint,
    body: payload,
    config: current.telemetry,
  });
  scheduleDeliveryDrain(workspace);
}
