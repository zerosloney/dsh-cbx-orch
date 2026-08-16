import { appendFileSync, unlinkSync } from "node:fs";
import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import { jobContext, type ActiveProcessHandle } from "./job-runtime.js";
import { writePidRecord } from "./pid-guard.js";
import {
  MAX_CAPTURE_BYTES,
  ProcessTreeTerminationError,
  type ProcessResult,
  type ProcessSpawn,
} from "./process-runner.js";

const TREE_QUIESCE_TIMEOUT_MS = 7_000;

async function waitForTreeExit(
  handle: ReturnType<SubprocessRuntime["spawn"]>,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TREE_QUIESCE_TIMEOUT_MS);
  timer.unref();
  try {
    return await handle.waitForExit(controller.signal);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function terminateAndWait(
  handle: ReturnType<SubprocessRuntime["spawn"]>,
): Promise<{ stopped: boolean; error?: unknown }> {
  let error: unknown;
  try {
    handle.terminate();
  } catch (caught) {
    error = caught;
  }
  const stopped = await waitForTreeExit(handle);
  return error === undefined ? { stopped } : { stopped, error };
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

// 凭据形状的落盘脱敏：执行器/测试命令输出可能回显其环境中的 API key/私钥
// （子进程继承宿主完整 env，见下方注释），原样写入 agent.log/test.log 会形成持久的
// 凭据泄漏面。这里只在写盘边界做正则脱敏；内存 output 保持原样，供上层
// contextRedactor/redactText 按 governance 配置二次处理。
const CREDENTIAL_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_\-]{16,}\b/g, // OpenAI 系
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub PAT / SSH key
  /\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/g, // Slack
  /\bAIza[0-9A-Za-z_\-]{30,}\b/g, // Google API key
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+\/\-=]{20,}\b/gi,
];
const REDACTED_TOKEN = "[redacted]";

function redactCredentials(text: string): string {
  let out = text;
  for (const re of CREDENTIAL_PATTERNS) out = out.replace(re, REDACTED_TOKEN);
  return out;
}

/**
 * 流式日志落盘的凭据脱敏器：chunk 按任意边界到达，key 可能被切分在两个 chunk 之间。
 * 保留上一 chunk 末尾 TAIL_BYTES 字节与当前 chunk 拼接后再脱敏，只把属于当前 chunk
 * 的部分写盘。跨边界 key 的前缀（≤16 字节，如 `sk-ant-api03-`）可能已在上一轮原样
 * 写出，但正则要求先匹配常量前缀才替换，因此泄漏的仅是非随机前缀，不含熵。
 */
const TAIL_BYTES = 16;

class LogRedactor {
  private tail = "";

  write(sink: (text: string) => void, text: string): void {
    const redacted = redactCredentials(this.tail + text);
    const cut = this.tail.length;
    // 仅当本次替换使拼接文本收缩到小于 tail 时才出现：整个 chunk 被 key 占满且 key
    // 跨越边界。此时不写字节会丢失日志内容，补写占位符既保留痕迹又避免泄漏。
    if (redacted.length > cut) sink(redacted.slice(cut));
    else if (redacted.length < cut) sink(REDACTED_TOKEN);
    this.tail = text.slice(-TAIL_BYTES);
  }
}

/**
 * Build a `ctx.subprocess` provider for the engine's `runProcess`/`runShell`.
 * All executor/test/git child processes flow through the DeepSeek Harness
 * subprocess seam: tree-scoped termination, graceful escalation, and the
 * job-runtime registry that lets `cbx cancel` terminate live subprocesses.
 *
 * 环境变量：执行器子进程完整继承宿主的 process.env（与终端直接运行一致）。这是
 * 有意设计——用户配置的编码 CLI（codebuddy/opencode/omp/cline/qwen）依赖环境里的
 * API 凭据才能工作，过滤变量会破坏执行器认证。对应缓解在落盘边界：日志写入前按
 * 凭据形状正则脱敏（见 LogRedactor），防止执行器输出回显凭据形成持久的磁盘泄漏。
 */
export function createSubprocessProvider(subprocess: SubprocessRuntime): ProcessSpawn {
  return async (
    useShell,
    command,
    args,
    cwd,
    timeoutMs,
    logFile,
    pidFile,
    callerSignal,
  ): Promise<ProcessResult> => {
    const argv = useShell ? shellArgv(command) : [command, ...args];
    // 先取 ALS 上下文：取消可能落在"标记检查之后、spawn 之前"的窗口里（上层还有
    // 若干 await）。发现已取消就直接放弃拉起子进程——抛错沿 runStage 的取消感知
    // catch 收口，避免执行器白跑整个 timeoutMs。
    const jobStore = jobContext.getStore();
    const jobSignal = jobStore?.controller.signal;
    const throwIfCallerOrJobAborted = (): void => {
      callerSignal?.throwIfAborted();
      jobSignal?.throwIfAborted();
    };
    throwIfCallerOrJobAborted();
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    if (callerSignal) signals.push(callerSignal);
    if (jobSignal) signals.push(jobSignal);
    signals.push(controller.signal);
    const spawnSignal = AbortSignal.any(signals);
    const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);
    const output = new BoundedOutput();
    let timedOut = false;

    let handle: ReturnType<SubprocessRuntime["spawn"]>;
    try {
      handle = subprocess.spawn({
        argv,
        cwd,
        stdio: {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
        graceMs: 2_000,
        signal: spawnSignal,
        env: process.env,
      });
    } catch (error) {
      clearTimeout(timeoutTimer);
      throwIfCallerOrJobAborted();
      throw error;
    }

    const active: ActiveProcessHandle = {
      pid: handle.pid,
      terminate: () => handle.terminate(),
    };
    if (jobStore) jobStore.handles.add(active);
    let preserveTracking = false;
    let pidWritten = false;
    try {
      throwIfCallerOrJobAborted();
      if (pidFile && handle.pid > 0) {
        writePidRecord(pidFile, handle.pid);
        pidWritten = true;
      }
    } catch (error) {
      clearTimeout(timeoutTimer);
      const callerOrJobAborted = callerSignal?.aborted || jobSignal?.aborted;
      if (callerOrJobAborted) {
        const termination = await terminateAndWait(handle);
        if (!termination.stopped) {
          preserveTracking = true;
          if (pidFile && handle.pid > 0 && !pidWritten) {
            try {
              writePidRecord(pidFile, handle.pid);
              pidWritten = true;
            } catch {
              /* retain the diagnostic error below */
            }
          }
          throw new ProcessTreeTerminationError(
            handle.pid,
            callerSignal?.aborted ? callerSignal.reason : jobSignal?.reason,
            termination.error,
          );
        }
        if (jobStore) jobStore.handles.delete(active);
        if (pidFile) {
          try {
            unlinkSync(pidFile);
          } catch {
            /* never written or already removed */
          }
        }
        throw callerSignal?.aborted ? callerSignal.reason : jobSignal?.reason;
      }
      const termination = await terminateAndWait(handle);
      if (!termination.stopped) {
        preserveTracking = true;
        throw new ProcessTreeTerminationError(handle.pid, error, termination.error);
      }
      if (jobStore) jobStore.handles.delete(active);
      if (pidFile) {
        try {
          unlinkSync(pidFile);
        } catch {
          /* never written or already removed */
        }
      }
      throw error;
    }
    // 取消落在 spawn 与句柄注册之间：abortRunningJob 遍历句柄集时还看不到本句柄，
    // 注册后立刻按已取消信号补一次树级终止。
    if (spawnSignal.aborted) {
      try {
        handle.terminate();
      } catch {
        /* the signal remains authoritative */
      }
    }

    // 落盘日志经流式脱敏（跨 chunk 边界保留 16 字节重叠）后再写 logFile，
    // 防止执行器输出回显的凭据原样持久化；内存 output 保持原样。
    // 磁盘侧设硬上限：内存 BoundedOutput 只保尾部 4MB，但逐 chunk append 不设限
    // 会让 chatty 执行器把 agent.log/test.log 写到数百 MB（evidence 哈希、artifact
    // 读取、SSE 回放全部跟着遭殃）。超限后停止落盘并留标记，内存采集不受影响。
    const MAX_LOG_FILE_BYTES = 32 * 1024 * 1024;
    const logRedactor = new LogRedactor();
    let logBytes = 0;
    let logCapped = false;
    const append = (chunk: Buffer): void => {
      output.append(chunk);
      if (logFile && !logCapped) {
        logBytes += chunk.length;
        if (logBytes > MAX_LOG_FILE_BYTES) {
          logCapped = true;
          try {
            appendFileSync(
              logFile,
              `\n[cbx: 日志已达 ${MAX_LOG_FILE_BYTES} 字节上限，停止落盘；内存采集仍保留尾部]\n`,
              "utf8",
            );
          } catch {
            /* 磁盘已满等：静默 */
          }
          return;
        }
        logRedactor.write(
          (redacted) => appendFileSync(logFile, redacted),
          chunk.toString("utf8"),
        );
      }
    };
    handle.stdout?.on("data", append);
    handle.stderr?.on("data", append);

    let outcome: Awaited<typeof handle.done> | undefined;
    let hardDeadlineHit = false;
    // 硬死线：abort（超时/取消）触发后，若 seam 的 SIGTERM→grace→SIGKILL 升级仍
    // 无法让 done settle（不可中断 IO / 句柄泄漏），job 会永久挂起——且事件循环
    // 空闲、心跳持续刷新，连队列回收路径都不会触发。到点后再次 terminate 并以
    // 合成超时结果解除本调用阻塞；卡死子进程仍留在句柄集里由取消路径兜底。
    let hardTimerHandle: ReturnType<typeof setTimeout> | undefined;
    const hardTimer = new Promise<"hard">((resolve) => {
      hardTimerHandle = setTimeout(
        () => resolve("hard"),
        timeoutMs + 2_000 + 5_000,
      );
      hardTimerHandle.unref();
    });
    try {
      const settled = await Promise.race([
        handle.done.then((value) => ({ value })),
        hardTimer,
      ]);
      if (settled === "hard") {
        hardDeadlineHit = true;
        const termination = await terminateAndWait(handle);
        if (!termination.stopped) {
          preserveTracking = true;
          throw new ProcessTreeTerminationError(
            handle.pid,
            controller.signal.reason,
            termination.error,
          );
        }
      } else {
        outcome = settled.value;
        if (controller.signal.aborted) {
          const termination = await terminateAndWait(handle);
          if (!termination.stopped) {
            preserveTracking = true;
            throw new ProcessTreeTerminationError(
              handle.pid,
              controller.signal.reason,
              termination.error,
            );
          }
        }
      }
      throwIfCallerOrJobAborted();
    } catch (error) {
      const callerOrJobAborted = callerSignal?.aborted || jobSignal?.aborted;
      if (callerOrJobAborted) {
        const termination = await terminateAndWait(handle);
        if (!termination.stopped) {
          preserveTracking = true;
          throw new ProcessTreeTerminationError(
            handle.pid,
            callerSignal?.aborted ? callerSignal.reason : jobSignal?.reason,
            termination.error,
          );
        }
        throw callerSignal?.aborted ? callerSignal.reason : jobSignal?.reason;
      }
      throw error;
    } finally {
      clearTimeout(timeoutTimer);
      if (hardTimerHandle !== undefined) clearTimeout(hardTimerHandle);
      if (!preserveTracking) {
        if (jobStore) jobStore.handles.delete(active);
        if (pidFile) {
          try {
            unlinkSync(pidFile);
          } catch {
            /* already removed */
          }
        }
      }
    }

    if (hardDeadlineHit) {
      return {
        code: -1,
        timedOut: true,
        output: output.text(),
        ...(output.truncated ? { outputTruncated: true } : {}),
      };
    }
    // 超时判定：abort 恰好在进程正常退出(0)的同一瞬间的场景不算超时——
    // 退出码 0 说明工作已完成，误判成超时会触发无意义的重试。
    timedOut = controller.signal.aborted && (outcome?.exitCode ?? -1) !== 0;
    return {
      code: outcome?.exitCode ?? -1,
      timedOut,
      output: output.text(),
      ...(output.truncated ? { outputTruncated: true } : {}),
    };
  };
}

function shellArgv(command: string): string[] {
  if (process.platform === "win32") {
    return [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", command];
  }
  return ["/bin/sh", "-c", command];
}
