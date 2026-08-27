/**
 * log-file-sink —— agent.log / test.log 的有界落盘 sink（上限 + 单代轮转）。
 *
 * 语义升级（v0.4.5）：日志达上限不再是「停止落盘」，而是先轮转到 `.1` 代（单代，
 * 与 events.ndjson 的代际语义一致）——长任务的后续日志不再丢失；`.1` 代也存在或
 * 文件被占用（Windows 文件锁）无法轮转时才停止落盘并留标记，内存采集始终保留尾部。
 *
 * 其余不变：流式脱敏（LogRedactor）仍由调用方负责；本 sink 只管理「写不写」。
 */

import { appendFileSync, existsSync, renameSync } from "node:fs";

export interface LogFileSink {
  /** 已停止落盘（主文件与 .1 代均已满或无法轮转）。 */
  capped(): boolean;
  /** 写入一个 chunk。capped 后为 no-op（chunk 不落盘，只有内存侧保留）。 */
  append(chunk: Buffer): void;
}

/**
 * 创建有界落盘 sink。
 * @param logFile 主日志文件路径（轮转目标 `<logFile>.1`）。
 * @param maxBytes 主文件上限（默认 32MB，与历史硬上限一致）。
 * @param write 实际落盘函数（调用方可注入脱敏/编码；接收本次要写入的原始 Buffer）。
 */
export function createLogFileSink(
  logFile: string,
  write: (chunk: Buffer) => void,
  maxBytes = 32 * 1024 * 1024,
): LogFileSink {
  let logBytes = 0;
  let capped = false;
  const tryRotate = (): boolean => {
    try {
      const rotated = `${logFile}.1`;
      if (existsSync(rotated)) return false;
      renameSync(logFile, rotated);
      logBytes = 0;
      return true;
    } catch {
      // Windows 文件锁 / 权限等：滚不动就保持现状（调用方随后按 capped 处理）。
      return false;
    }
  };
  return {
    capped: () => capped,
    append(chunk) {
      if (capped) return;
      logBytes += chunk.length;
      if (logBytes > maxBytes) {
        if (!tryRotate()) {
          capped = true;
          try {
            appendFileSync(
              logFile,
              `\n[cbx: 日志已达 ${maxBytes} 字节上限且无法轮转（.1 代已存在或文件被占用），停止落盘；内存采集仍保留尾部]\n`,
              "utf8",
            );
          } catch {
            /* 磁盘已满等：静默 */
          }
          return;
        }
        // 轮转成功：本次 chunk 落入新主文件（清零计量后不计超限）。
        write(chunk);
        return;
      }
      write(chunk);
    },
  };
}

/** 供测试/内部使用的纯函数：轮转目标路径。 */
export function rotatedLogPath(logFile: string): string {
  return `${logFile}.1`;
}