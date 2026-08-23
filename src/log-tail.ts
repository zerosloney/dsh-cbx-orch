import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { jobDir } from "./state.js";

export interface AgentLogChunk {
  content: string;
  nextOffset: number;
  truncated: boolean;
}

export interface ReadAgentLogOptions {
  /** 续读起点（上次的 nextOffset）；0 = 从尾部限长起读。 */
  since?: number;
  /**
   * 尾部限长（初始读/旋转后回退都对齐到该窗口内）。0 = 不限（完整读，
   * jobs-bridge 全量场景）。默认 256KB（ui 仪表盘/工具增量读的默认）。
   */
  maxBytes?: number;
  /**
   * 是否启用"游标文件 + 短文件旋转自愈"：true（ui 契约）把协商出的 nextOffset
   * 持久化到 <job>/agent.log.cursor，下次续读若磁盘比上次游标短则判定被截断/重建、
   * 回退到尾部窗口；false（jobs-bridge 契约）只做"游标越界即回文件头"的内存态自愈，
   * 不读不写 cursor 文件（多个内存游标互不污染同一文件）。
   */
  persistCursor?: boolean;
  /**
   * 是否把文本截到最后一个完整换行（避免把半行喂给展示层）。true（ui 契约）；
   * jobs-bridge 保持原样（全量 subarray）。
   */
  alignLine?: boolean;
}

/**
 * 统一的 agent.log 增量读者（原 ui.readAgentLogIncremental 与
 * jobs-bridge.tailAgentLog 两套独立实现的收敛）：
 *
 * - 尾部限长 + 续游标读；短文件/旋转自愈分两种口径（见 persistCursor）；
 * - 可选行对齐（半行截断）；
 * - 只读 jobDir，不持有状态，多调用方各自维护 since 游标。
 *
 * 幂等与边界：文件缺失返回空块；since 越界回退到（限长后的）文件头。
 */
export async function readAgentLog(
  workspace: string,
  jobId: string,
  options: ReadAgentLogOptions = {},
): Promise<AgentLogChunk> {
  const since = options.since ?? 0;
  const maxBytes = options.maxBytes ?? 256 * 1024;
  const persistCursor = options.persistCursor !== false;
  const alignLine = options.alignLine !== false;

  const dir = jobDir(workspace, jobId);
  const file = path.join(dir, "agent.log");
  const cursorFile = path.join(dir, "agent.log.cursor");
  let raw: Buffer;
  try {
    raw = await readFile(file);
  } catch {
    // 缺失时 next 取值对齐两套旧契约：ui(persistCursor) → 0；jobs-bridge → 仍回 since，
    // 这样下游"游标未推进、文件将来出现时重读"的语义不变。
    return { content: "", nextOffset: persistCursor ? 0 : since, truncated: false };
  }
  // 尾部起点：maxBytes 为 0/负数 = 不限（完整读）。
  const tailStart = maxBytes > 0 ? Math.max(0, raw.length - maxBytes) : 0;

  let effectiveSince = since;
  if (since > 0 && since <= raw.length) {
    // 续读：仅 persistCursor 契约做"磁盘比上次游标短 → 判定旋转/截断"。
    if (persistCursor) {
      try {
        const persisted = Number((await readFile(cursorFile, "utf8")).trim());
        if (Number.isSafeInteger(persisted) && persisted > 0 && raw.length < persisted)
          effectiveSince = tailStart;
      } catch {
        /* 无游标文件：按 since 仍在范围内处理 */
      }
    }
  } else {
    // since<=0（首次/越过头）或 since>len（文件被重建/变短）：退到尾部起点。
    effectiveSince = tailStart;
  }

  const start = since > 0 ? effectiveSince : tailStart;
  const slice = raw.subarray(start);
  const text = slice.toString("utf8");
  let content = text;
  if (alignLine) {
    const lastNl = text.lastIndexOf("\n");
    const end = text.endsWith("\n") || lastNl < 0 ? text.length : lastNl + 1;
    content = text.slice(0, end);
  }
  const nextOffset = start + Buffer.byteLength(content, "utf8");
  if (persistCursor && since > 0) {
    // 持久化本次协商出的边界，供下一次续读做旋转自愈。写失败不阻塞读取。
    await writeFile(cursorFile, String(nextOffset), "utf8").catch(() => undefined);
  }
  return { content, nextOffset, truncated: start > 0 };
}

/**
 * 旧 ui 契约：行对齐 + 尾部限长 + 持久化游标自愈。
 * 导出名与签名保持一致，web/tools 的 import 无需改动。
 */
export async function readAgentLogIncremental(
  workspace: string,
  jobId: string,
  since = 0,
  maxBytes = 256 * 1024,
): Promise<AgentLogChunk> {
  return readAgentLog(workspace, jobId, {
    since,
    maxBytes,
    persistCursor: true,
    alignLine: true,
  });
}

/**
 * 旧 jobs-bridge 契约：内存态续读（不写游标文件），完整读（不截行、不限长）。
 * 导出名/签名/返回结构 { text, next } 不变，jobs-bridge/subagent-facade/tools
 * 的调用点零改动。
 */
export async function tailAgentLog(
  workspace: string,
  jobId: string,
  since: number,
): Promise<{ text: string; next: number }> {
  const chunk = await readAgentLog(workspace, jobId, {
    since,
    maxBytes: 0,
    persistCursor: false,
    alignLine: false,
  });
  return { text: chunk.content, next: chunk.nextOffset };
}