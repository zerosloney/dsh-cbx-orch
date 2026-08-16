import type { IncomingMessage } from "node:http";

/** 携带 HTTP 状态码的请求处理错误；errorStatus 据此映射响应码（其余一律 500）。 */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Read and parse a JSON object request body, rejecting oversized payloads.
 *
 * 超限后停止累积但仍排空剩余 body：提前中断会让连接滞留（req 流未读完），
 * 响应写出时未读数据触发 RST、客户端收不到（与 /mcp 路径 0751e5e 同一修复）。
 * web.ts 与 ui.ts 共用此实现，避免两处 HTTP 边界行为分叉。
 */
export async function readJsonBody(
  req: IncomingMessage,
  maxBodyBytes = 1 * 1024 * 1024,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bodyBytes = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    if (!tooLarge) {
      const buffer = Buffer.from(chunk as Uint8Array);
      bodyBytes += buffer.byteLength;
      if (bodyBytes > maxBodyBytes) {
        tooLarge = true;
      } else {
        chunks.push(buffer);
      }
    }
  }
  if (tooLarge) {
    const error = new Error(
      `请求体超过 ${maxBodyBytes} 字节上限。`,
    ) as NodeJS.ErrnoException;
    error.code = "EBIG";
    throw error;
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "请求体必须是合法 JSON。");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "请求体必须是 JSON 对象。");
  }
  return parsed as Record<string, unknown>;
}

/**
 * 解析可选的数字字段：非有限数字（NaN/Infinity）返回 400 而非沉到 500。
 * 范围校验（min/max/integer）仅在这里做显式传入的部分，业务级范围仍由下游负责。
 */
export function parseNumberField(
  body: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): number | undefined {
  if (body[key] === undefined) return undefined;
  const value = Number(body[key]);
  if (!Number.isFinite(value)) {
    throw new HttpError(400, `${key} 必须是数字。`);
  }
  if (opts.integer && !Number.isInteger(value)) {
    throw new HttpError(400, `${key} 必须是整数。`);
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new HttpError(400, `${key} 不能小于 ${opts.min}。`);
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new HttpError(400, `${key} 不能大于 ${opts.max}。`);
  }
  return value;
}

/** 登录交换端点的每 IP 限速：内存计数，窗口 60s。防 token 暴力猜测。 */
export class AuthRateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxAttempts = 10,
    private readonly windowMs = 60_000,
  ) {}

  /** 顺带清理过期条目：Map 无限增长（每个来源 IP 一条）会在长寿命进程里缓慢泄漏。 */
  private evictExpired(now: number): void {
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
  }

  /** 记一次尝试；返回 false 表示该 IP 在本窗口内已被限流。 */
  allow(key: string): boolean {
    const now = Date.now();
    this.evictExpired(now);
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.maxAttempts;
  }

  /** 登录成功后清零该 IP 的计数：正常用户反复登录不应消耗暴力猜测配额。 */
  success(key: string): void {
    this.hits.delete(key);
  }
}
