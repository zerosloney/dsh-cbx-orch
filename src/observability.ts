import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  claimPendingDelivery,
  completeDelivery,
  enqueueDelivery,
  insertEvent,
  loadRuntimeConfig,
  nextEventSeq,
  nextPendingDeliveryAt,
  recordDeliveryFailure,
  recordEventMirrorFailure,
  redactSensitive,
  redactText,
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

/** 配置短缓存：publishEvent/finishSpan 等高频路径不再每条事件读一遍 .cbx.json。
 *  代价是配置变更（如 webhook 地址）最多 5s 后生效——对通知投递可接受。 */
const configCache = new Map<string, { at: number; value: ObservabilityConfig }>();
const CONFIG_CACHE_TTL_MS = 5_000;

async function cachedConfig(workspace: string): Promise<ObservabilityConfig> {
  const key = path.resolve(workspace);
  const hit = configCache.get(key);
  if (hit && Date.now() - hit.at < CONFIG_CACHE_TTL_MS) return hit.value;
  const value = await config(workspace);
  configCache.set(key, { at: Date.now(), value });
  return value;
}

/** 死信记录里的 endpoint 剥掉 userinfo（https://user:pass@hook → https://hook）：
 *  带凭据的 webhook URL 不应永久躺在 delivery_failures 表与 ndjson 里。 */
function redactEndpointUrl(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
      return url.toString();
    }
  } catch {
    /* 非 URL 形态，原样保留 */
  }
  return endpoint;
}
/** 工作区级 ndjson（events/telemetry）轮转阈值：滚动单代 .1。SSE 回放与 tailer
 *  只读主文件，轮转保证每次连接的回放读取量有界；tailer 对"文件变小"已有基线重置逻辑。 */
const WORKSPACE_LOG_ROTATE_BYTES = 10 * 1024 * 1024;

async function rotateIfLarge(file: string): Promise<void> {
  try {
    if ((await stat(file)).size <= WORKSPACE_LOG_ROTATE_BYTES) return;
  } catch {
    return; /* 文件尚不存在 */
  }
  try {
    await unlink(`${file}.1`);
  } catch {
    /* 无历史代 */
  }
  try {
    await rename(file, `${file}.1`);
  } catch {
    /* 轮转失败（Windows 锁）则退化为继续追加 */
  }
}

async function append(
  workspace: string,
  file: string,
  value: unknown,
): Promise<void> {
  const directory = path.join(workspace, ".cbx");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, file);
  await rotateIfLarge(target);
  await appendFile(target, JSON.stringify(value, null, 0) + "\n", "utf8");
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

/**
 * 插件卸载（HMR/关闭）时清空本模块实例排定的 drain 定时器。不清的话，旧实例的
 * 定时器仍会触发 flushDeliveries 并撞向已被 closeDatabaseConnections 关闭的连接，
 * 每次重载都泄漏一组定时器与报差错。outbox 行本身持久化在 SQLite，新实例的
 * 下一次事件投递会重新认领，不会丢通知。
 */
export function disposeObservability(): void {
  for (const { timer } of scheduledDrains.values()) clearTimeout(timer);
  scheduledDrains.clear();
}

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
              endpoint: redactEndpointUrl(delivery.endpoint),
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
    // 恰好投满 limit 条时循环因计数退出，剩余行无人触发下一轮——立即补排一次
    // drain，否则它们要等到下一个事件发布才被认领。
    if (processed >= limit) scheduleDeliveryDrain(workspace);
    return processed;
  })();
  drainTasks.set(workspace, task);
  return task.finally(() => {
    if (drainTasks.get(workspace) === task) drainTasks.delete(workspace);
  });
}

const eventChains = new Map<string, Promise<void>>();

/** 镜像失败只告警一次（按 workspace）：持续刷屏会淹没真正日志，但首次失败必须留痕。 */
const eventMirrorWarned = new Set<string>();

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
      const current = await cachedConfig(workspace);
      const redacted = redactSensitive(
        event,
        current.governance?.redactFields,
      ) as typeof event;
      await append(workspace, "events.ndjson", redacted);
      // SQLite 镜像（SSE 回放/查询源）：与 ndjson 同序写入（本进程内由 eventChains
      // 串行化，seq 已在 nextEventSeq 分配）。镜像失败只落日志 + 累计计数器，不阻塞事件发布；
      // 计数器在 storage.ts（recordEventMirrorFailure），避免本模块与 storage 循环依赖。
      await insertEvent(workspace, seq, type, redacted).catch((error) => {
        recordEventMirrorFailure(workspace);
        if (!eventMirrorWarned.has(workspace)) {
          eventMirrorWarned.add(workspace);
          console.error(
            `cbx: 事件 SQLite 镜像写入失败（SSE 回放将与该 workspace 的 events.ndjson 漂移）：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
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

/** 深度字符串形状脱敏：redactSensitive 只按键名脱敏，普通键下内嵌的凭据形状
 *  （"note": "… Bearer xxx …"）由 redactText 的全文正则兜底（fields 传空即只跑
 *  形状匹配）。 */
function redactStringsDeep(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactStringsDeep);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redactStringsDeep(item),
      ]),
    );
  return value;
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
  const current = await cachedConfig(workspace);
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
  // span 属性可能携带命令行/错误文本（含回显的凭据），与事件流同边界脱敏后再
  // 落 telemetry.ndjson 与 OTLP outbox：先按键名（redactSensitive），再对字符串
  // 值做凭据形状兜底（普通键下内嵌的 sk-/Bearer/私钥等）。
  const redactedRecord = redactStringsDeep(
    redactSensitive(spanRecord, current.governance?.redactFields),
  ) as typeof spanRecord;
  await append(workspace, "telemetry.ndjson", redactedRecord);
  if (!current.telemetry?.enabled || !current.telemetry.endpoint) return;
  const startNs = String(span.startedAt * 1_000_000);
  const endNs = String(endedAt * 1_000_000);
  const attributesList = Object.entries(redactedRecord.attributes).map(
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
