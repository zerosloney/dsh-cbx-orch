import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, unlinkSync } from "node:fs";
import { writePidRecord } from "./pid-guard.js";
import { createLogFileSink } from "./log-file-sink.js";

export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export interface ProcessResult {
  code: number;
  timedOut: boolean;
  output: string;
  outputTruncated?: boolean;
}

class BoundedOutput {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private readonly maximumBytes: number;
  truncated = false;

  constructor(maximumBytes = MAX_CAPTURE_BYTES) {
    this.maximumBytes = maximumBytes;
  }

  append(chunk: Buffer): void {
    const copy = Buffer.from(chunk);
    this.chunks.push(copy);
    this.bytes += copy.length;
    while (this.bytes > this.maximumBytes && this.chunks.length > 0) {
      const excess = this.bytes - this.maximumBytes;
      const first = this.chunks[0];
      if (first.length <= excess) {
        this.chunks.shift();
        this.bytes -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.bytes -= excess;
      }
      this.truncated = true;
    }
  }

  text(): string {
    return Buffer.concat(this.chunks, this.bytes).toString("utf8");
  }
}

/**
 * A pluggable process executor. The DeepSeek Harness plugin installs an
 * implementation backed by `ctx.subprocess` (see subprocess-adapter.ts) so all
 * executor/test/git child processes flow through the harness seam (tree-scoped
 * termination, scrubbed env, sandbox integration). When no provider is set the
 * engine falls back to raw `node:child_process`, which keeps the core usable
 * standalone and under tests.
 */
export type ProcessSpawn = (
  useShell: boolean,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  logFile?: string,
  pidFile?: string,
  signal?: AbortSignal,
) => Promise<ProcessResult>;

let provider: ProcessSpawn | undefined;

/**
 * Install the process provider (typically the harness adapter). Returns a
 * disposer that only clears the provider if it is still THIS call's function —
 * HMR/多实例下后装实例被先装实例的卸载清理误清空，会让所有 spawn 静默退回
 * raw child_process（丢失树杀/取消集成/凭据脱敏）。
 */
export function setProcessSpawnProvider(fn: ProcessSpawn): () => void {
  provider = fn;
  return () => {
    if (provider === fn) provider = undefined;
  };
}

export function getProcessSpawnProvider(): ProcessSpawn | undefined {
  return provider;
}

export function capture(
  args: string[],
  cwd: string,
  timeout = 30_000,
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
  return {
    code: result.status ?? -1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? result.error ?? ""),
  };
}

/** 异步版 capture：不阻塞调用方事件循环。用于主进程内的 UI/调度路径（SSE 心跳、多客户端共享事件循环）。 */
export async function captureAsync(
  args: string[],
  cwd: string,
  timeout = 30_000,
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  signal?.throwIfAborted();
  const result = await runProcess(
    args[0],
    args.slice(1),
    cwd,
    timeout,
    undefined,
    undefined,
    signal,
  );
  return { code: result.code, stdout: result.output, stderr: "" };
}

export function killTree(
  pid: number,
  signal: NodeJS.Signals = "SIGKILL",
  child?: ChildProcess,
): boolean {
  if (process.platform === "win32") {
    // child.kill("SIGKILL") 只 TerminateProcess 直接子进程并同步返回 true——提前
    // return 会让 taskkill /T 永不执行，孙进程（npm 包装的 CLI 等）全部成为孤儿。
    // 因此 child.kill 仅作第一步，树级终止始终再跑一次 taskkill /T /F。
    if (child) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 进程已退出 */
      }
    }
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
    });
    if (result.status === 0) return true;
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    if (child) {
      try {
        return child.kill(signal);
      } catch {
        /* 进程已退出 */
      }
    }
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

function treeAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function waitUntilStopped(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (treeAlive(pid) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  return !treeAlive(pid);
}

/** Gracefully stop a process group, escalate to SIGKILL, and confirm it is gone. */
export async function terminateTree(
  pid: number,
  gracefulMs = 2_000,
  forceMs = 1_000,
): Promise<boolean> {
  if (!treeAlive(pid)) return true;
  killTree(pid, "SIGTERM");
  if (await waitUntilStopped(pid, gracefulMs)) return true;
  killTree(pid, "SIGKILL");
  return waitUntilStopped(pid, forceMs);
}

/** Cancellation/timeout could not prove that the whole process tree stopped. */
export class ProcessTreeTerminationError extends Error {
  constructor(
    public readonly pid: number,
    public readonly cancellationReason: unknown,
    public readonly terminationError?: unknown,
  ) {
    super(`cbx: unable to confirm process tree ${pid} stopped`, {
      cause: cancellationReason,
    });
    this.name = "ProcessTreeTerminationError";
  }
}

/** Retry the seam's bounded terminate ladder before declaring a survivor. */
export async function terminateTreeWithRetry(pid: number): Promise<boolean> {
  const attempts: readonly [number, number][] = [
    [2_000, 1_000],
    [1_000, 1_000],
    [1_000, 1_000],
  ];
  for (const [gracefulMs, forceMs] of attempts) {
    if (await terminateTree(pid, gracefulMs, forceMs)) return true;
  }
  return false;
}

/** 共享子进程执行核心（原生 child_process 回退实现）。 */
function runChildRaw(
  useShell: boolean,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  logFile?: string,
  pidFile?: string,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = useShell
      ? spawn(command, {
          cwd,
          shell: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        })
      : spawn(command, args, {
          cwd,
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
    const output = new BoundedOutput();
    let timedOut = false;
    let settled = false;
    let aborting = false;
    let abortReason: unknown;
    let cleaned = false;
    let preservePidFile = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** 超时后 killTree 仍不退出时的强制 settle 死线（防 Promise 永久挂起）。 */
    let hardDeadline: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    let resolveChildExit!: () => void;
    let childExited = false;
    const childExit = new Promise<void>((resolve) => {
      resolveChildExit = resolve;
    });
    const markChildExit = () => {
      if (childExited) return;
      childExited = true;
      resolveChildExit();
    };
    const removePidFile = () => {
      if (pidFile) {
        try {
          unlinkSync(pidFile);
        } catch {
          /* removed */
        }
      }
    };
    const stopCancellationSources = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (hardDeadline !== undefined) clearTimeout(hardDeadline);
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      stopCancellationSources();
      if (!preservePidFile) removePidFile();
    };
    const cancel = () => {
      if (settled || aborting) return;
      aborting = true;
      abortReason = signal?.reason;
      stopCancellationSources();
      void finishCancellation();
    };
    const finishCancellation = async (): Promise<void> => {
      let treeStopped = true;
      let terminationError: unknown;
      try {
        if (child.pid) {
          killTree(child.pid, "SIGKILL", child);
          treeStopped = await terminateTreeWithRetry(child.pid);
        }
      } catch (error) {
        treeStopped = false;
        terminationError = error;
      }
      try {
        if (!treeStopped && !childExited) {
          let waitTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              childExit,
              new Promise<void>((resolve) => {
                waitTimer = setTimeout(resolve, 1_000);
              }),
            ]);
          } finally {
            if (waitTimer !== undefined) clearTimeout(waitTimer);
          }
        }
      } finally {
        preservePidFile = !treeStopped;
        cleanup();
        settled = true;
        reject(
          treeStopped
            ? abortReason
            : new ProcessTreeTerminationError(
                child.pid ?? -1,
                abortReason,
                terminationError,
              ),
        );
      }
    };
    // 磁盘日志硬上限（与 seam 适配器一致）：raw 回退路径同样不能让 agent.log/test.log
    // 无界增长。createLogFileSink：主文件达上限先轮转 .1 代，两代都满/无法轮转才
    // 停止落盘并留标记；内存采集（BoundedOutput）始终保留尾部。
    const MAX_LOG_FILE_BYTES = 32 * 1024 * 1024;
    const logFileSink = logFile
      ? createLogFileSink(logFile, (chunk) => appendFileSync(logFile, chunk), MAX_LOG_FILE_BYTES)
      : { capped: () => false, append: () => undefined };
    const append = (chunk: Buffer) => {
      output.append(chunk);
      logFileSink.append(chunk);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    // 超时硬死线：killTree 后若子进程仍不退出（不可中断 IO / 句柄泄漏），close 永不
    // 触发会让 Promise 永久挂起。与 subprocess-adapter 的 hardTimer 同款兜底——到点
    // 强制 settle 为合成超时结果，不让调用方无限等。
    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      if (child.pid) killTree(child.pid, "SIGKILL", child);
      hardDeadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          code: -1,
          timedOut: true,
          output: output.text(),
          ...(output.truncated ? { outputTruncated: true } : {}),
        });
      }, 5_000);
      hardDeadline.unref?.();
    }, timeoutMs);
    child.on("error", (error) => {
      markChildExit();
      if (aborting) return;
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    });
    child.on("close", (code) => {
      markChildExit();
      if (aborting) return;
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        code: code ?? -1,
        timedOut,
        output: output.text(),
        ...(output.truncated ? { outputTruncated: true } : {}),
      });
    });
    if (signal) {
      abortListener = cancel;
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) cancel();
    }
    if (!settled && !aborting && pidFile && child.pid) {
      try {
        writePidRecord(pidFile, child.pid);
      } catch (error) {
        settled = true;
        cleanup();
        try {
          if (child.pid) killTree(child.pid, "SIGKILL", child);
        } finally {
          reject(error);
        }
      }
    }
  });
}

function runChild(
  useShell: boolean,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  logFile?: string,
  pidFile?: string,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (provider) return provider(useShell, command, args, cwd, timeoutMs, logFile, pidFile, signal);
  return runChildRaw(useShell, command, args, cwd, timeoutMs, logFile, pidFile, signal);
}

export function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  logFile?: string,
  pidFile?: string,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  return runChild(false, command, args, cwd, timeoutMs, logFile, pidFile, signal);
}

export function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  logFile?: string,
  pidFile?: string,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  return runChild(true, command, [], cwd, timeoutMs, logFile, pidFile, signal);
}
