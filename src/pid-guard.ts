import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";

/**
 * active.pid 归属守卫。
 *
 * pid 文件里只有 pid 时，"kill 掉这个 pid 的进程树"在两类真实场景下会打到
 * 无关进程：宿主崩溃后留下陈旧 pid 文件（恰是 retry/取消兜底要处理的场景），
 * 而 OS 已把该 pid 复用给另一个进程——Windows 上 taskkill /T /F 会连整棵
 * 无关进程树一起杀掉。因此 pid 文件升级为 {pid, startedAt} 记录，跨进程
 * kill 前先校验目标进程的启动时刻仍然吻合：
 *   - 吻合    → 确实是我们拉起的孤儿/僵尸，正常杀；
 *   - 不吻合  → pid 已被复用，跳过 kill（取消标记 + 超时兜底）；
 *   - 无法判定 → 同样跳过 kill（fail-safe）。
 */

/** pid 文件记录：pid + 我方 spawn 时刻（epoch ms）。 */
export interface PidRecord {
  pid: number;
  startedAt: number;
}

/** 启动时刻比较容差：记录的是 spawn 后立即写入的时间，进程创建只可能更早几秒。 */
const OWNERSHIP_TOLERANCE_MS = 15_000;

/** 写入 pid 记录（JSON）。调用点在 spawn 成功后立即执行。 */
export function writePidRecord(pidFile: string, pid: number): void {
  writeFileSync(pidFile, JSON.stringify({ pid, startedAt: Date.now() } satisfies PidRecord), "utf8");
}

/** 解析 pid 文件内容：兼容新 JSON 格式与旧版裸数字；无效返回 undefined。 */
export function parsePidRecordText(text: string): PidRecord | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { pid?: unknown; startedAt?: unknown };
      const pid = Number(parsed.pid);
      const startedAt = Number(parsed.startedAt);
      if (Number.isSafeInteger(pid) && pid > 0 && Number.isFinite(startedAt)) {
        return { pid, startedAt };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
  const pid = Number(trimmed);
  if (Number.isSafeInteger(pid) && pid > 0) {
    // 旧格式无 startedAt：无法校验归属，startedAt 置 NaN 以便区分。
    return { pid, startedAt: Number.NaN };
  }
  return undefined;
}

/** 读取 pid 文件为记录；文件缺失或损坏返回 undefined。 */
export async function readPidRecord(pidFile: string): Promise<PidRecord | undefined> {
  try {
    return parsePidRecordText(await readFile(pidFile, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * 目标进程的启动时刻（epoch ms），尽力而为的平台实现：
 * - Linux：/proc/<pid>/stat 的 starttime（时钟节拍）+ /proc/stat 的 btime；
 * - macOS：ps -o etime= 反推 now - elapsed；
 * - Windows：PowerShell Get-Process 的 StartTime。
 * 读不到 / 平台不支持 → undefined（调用方按"无法判定"处理）。
 */
export async function processStartEpochMs(pid: number): Promise<number | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  if (process.platform === "linux") return linuxStartEpochMs(pid);
  if (process.platform === "darwin") return darwinStartEpochMs(pid);
  if (process.platform === "win32") return windowsStartEpochMs(pid);
  return undefined;
}

async function linuxStartEpochMs(pid: number): Promise<number | undefined> {
  try {
    // comm 字段可含空格与括号，从最后一个 ')' 之后切分；其后 fields[0] 是第 3 字段
    // state，starttime（第 22 字段）对应索引 22 - 3 = 19。节拍频率按主流 USER_HZ=100。
    const statText = await readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = statText.lastIndexOf(")");
    if (closeParen < 0) return undefined;
    const fields = statText.slice(closeParen + 2).split(/\s+/);
    const startTimeTicks = Number(fields[19]);
    if (!Number.isFinite(startTimeTicks)) return undefined;
    const procStat = await readFile("/proc/stat", "utf8");
    const bootSeconds = Number(procStat.match(/^btime (\d+)$/m)?.[1]);
    if (!Number.isFinite(bootSeconds)) return undefined;
    return Math.round((bootSeconds + startTimeTicks / 100) * 1000);
  } catch {
    return undefined;
  }
}

/** `ps -o etime=` 的 [[dd-]hh:]mm:ss 输出换算为毫秒。 */
function parseEtimeMs(etime: string): number | undefined {
  const match = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?$/);
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return (Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds)) * 1000;
}

async function darwinStartEpochMs(pid: number): Promise<number | undefined> {
  try {
    const etime = await captureCommand("ps", ["-o", "etime=", "-p", String(pid)]);
    const elapsedMs = parseEtimeMs(etime ?? "");
    if (elapsedMs === undefined) return undefined;
    return Date.now() - elapsedMs;
  } catch {
    return undefined;
  }
}

async function windowsStartEpochMs(pid: number): Promise<number | undefined> {
  try {
    const stdout = await captureCommand(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
        `[int64](([DateTimeOffset](Get-Process -Id ${pid}).StartTime).ToUnixTimeMilliseconds())`],
    );
    const startMs = Number((stdout ?? "").trim());
    return Number.isFinite(startMs) && startMs > 0 ? startMs : undefined;
  } catch {
    return undefined;
  }
}

function captureCommand(command: string, args: string[], timeoutMs = 8_000): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
      child.on("error", () => { clearTimeout(timer); resolve(undefined); });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? out : undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * 校验 pid 记录是否仍指向我方拉起的进程。
 * @returns true = 确认归属；false = 确认非我方（pid 复用）；undefined = 无法判定。
 */
export async function pidRecordOwnsProcess(record: PidRecord): Promise<boolean | undefined> {
  if (!Number.isFinite(record.startedAt)) return undefined; // 旧格式记录，无从校验
  const startMs = await processStartEpochMs(record.pid);
  if (startMs === undefined) return undefined;
  return Math.abs(startMs - record.startedAt) <= OWNERSHIP_TOLERANCE_MS;
}
