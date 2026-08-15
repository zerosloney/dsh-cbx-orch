import { appendFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import { jobContext, type ActiveProcessHandle } from "./job-runtime.js";
import { MAX_CAPTURE_BYTES, type ProcessResult, type ProcessSpawn } from "./process-runner.js";

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
 * Build a `ctx.subprocess` provider for the engine's `runProcess`/`runShell`.
 * All executor/test/git child processes flow through the DeepSeek Harness
 * subprocess seam: tree-scoped termination, graceful escalation, and the
 * job-runtime registry that lets `cbx cancel` terminate live subprocesses.
 *
 * Credential-shaped environment entries (API keys) are passed through
 * explicitly via `env`, because a user-configured coding-executor CLI must
 * inherit the host session's real environment — the same inheritance the
 * standalone `child_process` fallback gives. Callers opt into forwarding.
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
  ): Promise<ProcessResult> => {
    const argv = useShell ? shellArgv(command) : [command, ...args];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const output = new BoundedOutput();
    let timedOut = false;

    const handle = subprocess.spawn({
      argv,
      cwd,
      stdio: {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
      graceMs: 2_000,
      signal: controller.signal,
      env: process.env,
    });

    if (pidFile && handle.pid > 0) {
      writeFileSync(pidFile, String(handle.pid), "utf8");
    }
    const active: ActiveProcessHandle = {
      pid: handle.pid,
      terminate: () => handle.terminate(),
    };
    const context = jobContext.getStore();
    if (context) context.handles.add(active);

    const append = (chunk: Buffer): void => {
      output.append(chunk);
      if (logFile) appendFileSync(logFile, chunk);
    };
    handle.stdout?.on("data", append);
    handle.stderr?.on("data", append);

    let outcome;
    try {
      outcome = await handle.done;
    } catch (error) {
      clearTimeout(timer);
      if (context) context.handles.delete(active);
      if (pidFile) unlinkSync(pidFile);
      throw error;
    } finally {
      clearTimeout(timer);
      if (context) context.handles.delete(active);
      if (pidFile) {
        try {
          unlinkSync(pidFile);
        } catch {
          /* already removed */
        }
      }
    }

    timedOut = controller.signal.aborted;
    return {
      code: outcome.exitCode ?? -1,
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
