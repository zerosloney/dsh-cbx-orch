import { appendFileSync, existsSync } from "node:fs";
import { appendFile, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectExecutorPlugin, type ExecutorResult, type ExecutorRequest } from "./executor.js";
import { findExecutable, resolveExecutor } from "./executors/builtin.js";
import { bumpInvocationCount, loadConfig } from "./state.js";
import { validateTestCommand } from "./validation.js";
import { runProcess, runShell, type ProcessResult } from "./process-runner.js";
import { redactText, saveJson } from "./storage.js";
import { APP_VERSION } from "./version.js";
import { jobContext } from "./job-runtime.js";

export type InvocationRole = "stage" | "review" | "manager" | "gate";

/** 事件载荷中的长字符串（内嵌 prompt 的 argv、输出片段）截断后落盘：审计要可读头部，不要全文。 */
function truncateDeep(value: unknown, maxChars = 500): unknown {
  if (typeof value === "string") {
    return value.length > maxChars ? `${value.slice(0, maxChars)}…(${value.length} chars)` : value;
  }
  if (Array.isArray(value)) return value.map((item) => truncateDeep(item, maxChars));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, truncateDeep(item, maxChars)]),
    );
  }
  return value;
}

/**
 * 事件流写入统一边界：内置凭据形状脱敏 + 长字段截断。prompt 经 argv 内嵌在
 * process_started 的 command 里，原样落盘会把任务全文（含用户指令/handback 与
 * 内联凭据）持久化并随 SSE / events artifact 暴露——agent.log/test.log 的脱敏
 * 约束同样适用于事件流。
 */
function appendEvent(eventsFile: string, payload: Record<string, unknown>): void {
  appendFileSync(eventsFile, redactText(JSON.stringify(truncateDeep(payload))) + "\n", "utf8");
}

/** Remove a per-invocation plugin artifact, surfacing errors other than a missing file. */
async function unlinkIfPresent(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

interface CombinedAbortSignal {
  signal?: AbortSignal;
  dispose(): void;
}

/** Caller cancellation wins over the ambient job cancellation when both fire. */
function combineAbortSignals(
  callerSignal: AbortSignal | undefined,
  jobSignal: AbortSignal | undefined,
): CombinedAbortSignal {
  if (!callerSignal || !jobSignal || callerSignal === jobSignal) {
    return { signal: callerSignal ?? jobSignal, dispose: () => undefined };
  }
  const controller = new AbortController();
  let disposed = false;
  const onCallerAbort = (): void => {
    if (!controller.signal.aborted) controller.abort(callerSignal.reason);
  };
  const onJobAbort = (): void => {
    if (controller.signal.aborted) return;
    queueMicrotask(() => {
      if (disposed || controller.signal.aborted) return;
      controller.abort(callerSignal.aborted ? callerSignal.reason : jobSignal.reason);
    });
  };
  callerSignal.addEventListener("abort", onCallerAbort);
  jobSignal.addEventListener("abort", onJobAbort);
  if (callerSignal.aborted) onCallerAbort();
  else if (jobSignal.aborted) onJobAbort();
  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      callerSignal.removeEventListener("abort", onCallerAbort);
      jobSignal.removeEventListener("abort", onJobAbort);
    },
  };
}

function throwIfAborted(
  callerSignal: AbortSignal | undefined,
  jobSignal: AbortSignal | undefined,
): void {
  if (callerSignal?.aborted) throw callerSignal.reason;
  if (jobSignal?.aborted) throw jobSignal.reason;
}

function rethrowPreferredAbort(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  jobSignal: AbortSignal | undefined,
): never {
  if (callerSignal?.aborted) throw callerSignal.reason;
  if (jobSignal?.aborted) throw jobSignal.reason;
  throw error;
}

async function cleanupPluginArtifacts(
  directory: string,
  requestFile: string,
  resultFile: string,
): Promise<void> {
  const files = [requestFile, resultFile];
  const outcomes = await Promise.allSettled(files.map(unlinkIfPresent));
  const failures = outcomes.flatMap((outcome, index) =>
    outcome.status === "rejected"
      ? [{ file: files[index], error: outcome.reason }]
      : [],
  );
  if (failures.length === 0) return;
  try {
    appendEvent(path.join(directory, "events.ndjson"), {
      event: "plugin_artifact_cleanup_failed",
      files: failures.map(({ file }) => file),
      errors: failures.map(({ error }) =>
        error instanceof Error ? error.message : String(error),
      ),
      at: new Date().toISOString(),
    });
  } catch {
    /* cleanup diagnostics are best effort and must not mask the original result */
  }
}

export interface InvocationMeta {
  role: InvocationRole;
  jobId: string;
  stageIndex?: number;
}

export function promptFor(phase: string, extra = "", _label: string, contextPack: string): string {
  return `你是任务执行代理。\n\n只读取当前角色上下文包：\n- ${contextPack}\n\n上下文包是编排器生成的最小化脱敏投影；只可额外读取其中 artifacts 明确列出的文件，不要读取任何未列材料或历史轨迹。\n当前阶段：${phase}\n\n${extra}`;
}

async function invokeBuiltin(spec: ReturnType<typeof resolveExecutor> & {}, directory: string, workdir: string, prompt: string, permissionMode: string, maxTurns: number, timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult> {
  signal?.throwIfAborted();
  const executable = findExecutable(spec);
  const args = [...executable.slice(1), ...spec.buildArgs({ prompt, permissionMode, maxTurns })];
  const command = executable[0];
  const eventsFile = path.join(directory, "events.ndjson");
  const outputLog = path.join(directory, "agent.log");
  appendEvent(eventsFile, { event: "executor_metadata", source: "builtin", name: spec.name, version: APP_VERSION, at: new Date().toISOString() });
  appendEvent(eventsFile, { event: "process_started", command: [command, ...args], cwd: workdir, at: new Date().toISOString() });
  const result = await runProcess(command, args, workdir, timeoutMs, outputLog, path.join(directory, "active.pid"), signal);
  signal?.throwIfAborted();
  appendEvent(eventsFile, { event: "process_finished", returncode: result.code, timedOut: result.timedOut, at: new Date().toISOString() });
  return result;
}

export async function invokeExecutor(
  executor: string,
  workspace: string,
  directory: string,
  workdir: string,
  prompt: string,
  permissionMode: string,
  maxTurns: number,
  timeoutMs: number,
  invocationMeta?: InvocationMeta,
  callerSignal?: AbortSignal,
): Promise<ProcessResult> {
  const jobSignal = jobContext.getStore()?.controller.signal;
  const combined = combineAbortSignals(callerSignal, jobSignal);
  try {
    throwIfAborted(callerSignal, jobSignal);
    return await invokeExecutorCore(
      executor,
      workspace,
      directory,
      workdir,
      prompt,
      permissionMode,
      maxTurns,
      timeoutMs,
      invocationMeta,
      combined.signal,
    );
  } catch (error) {
    rethrowPreferredAbort(error, callerSignal, jobSignal);
  } finally {
    combined.dispose();
  }
}

async function invokeExecutorCore(executor: string, workspace: string, directory: string, workdir: string, prompt: string, permissionMode: string, maxTurns: number, timeoutMs: number, invocationMeta?: InvocationMeta, signal?: AbortSignal): Promise<ProcessResult> {
  signal?.throwIfAborted();
  if (invocationMeta?.jobId) {
    try {
      await bumpInvocationCount(
        workspace,
        invocationMeta.jobId,
        invocationMeta.role,
        invocationMeta.stageIndex,
      );
    } catch (error) {
      // 计数失败不应阻塞执行器调用；落审计事件便于排障。
      appendEvent(path.join(directory, "events.ndjson"), {
        event: "invocation_count_failed",
        role: invocationMeta.role,
        stageIndex: invocationMeta.stageIndex,
        error: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      });
    }
  }
  signal?.throwIfAborted();
  const builtin = resolveExecutor(executor);
  if (builtin) return invokeBuiltin(builtin, directory, workdir, prompt, permissionMode, maxTurns, timeoutMs, signal);
  const config = await loadConfig(workspace);
  signal?.throwIfAborted();
  const identity = await inspectExecutorPlugin(executor, workspace, config.plugins);
  signal?.throwIfAborted();
  if (!config.plugins?.enforce) {
    // 默认不强制插件白名单：显式告警并落审计事件，提醒生产环境启用 plugins.enforce。
    const warning = `executor 指向插件 ${identity.path}，但 plugins.enforce 未启用，插件未经路径/SHA 白名单校验即被加载；生产环境请配置 plugins.enforce=true 与 allowPaths/allowSha256。`;
    console.error(`cbx: ${warning}`);
    appendEvent(path.join(directory, "events.ndjson"), { event: "plugin_policy_warning", executor: identity.name, path: identity.path, sha256: identity.sha256, enforce: false, at: new Date().toISOString() });
  }
  const request: ExecutorRequest = { directory, workdir, prompt, permissionMode, maxTurns, timeoutMs, executor, plugin: { policy: config.plugins, sha256: identity.sha256 } };
  appendEvent(path.join(directory, "events.ndjson"), { event: "executor_metadata", source: identity.source, name: identity.name, version: identity.version, apiVersion: identity.apiVersion, capabilities: identity.capabilities, sha256: identity.sha256, at: new Date().toISOString() });
  appendEvent(path.join(directory, "events.ndjson"), { event: "plugin_started", executor: identity.name, at: new Date().toISOString() });
  const requestFile = path.join(directory, "plugin-request.json");
  const resultFile = path.join(directory, "plugin-result.json");
  const host = path.join(path.dirname(fileURLToPath(import.meta.url)), "plugin-host.js");
  // plugin-request.json 内嵌完整 prompt（用户指令，可能携带内联凭据），是 job 目录里
  // 唯一未经脱敏的明文落盘面——插件宿主读取完毕后立即删除，不留持久副本。
  try {
    // 同一 job 目录可能是上次崩溃/超时留下的；先清掉两类文件，避免旧结果被误当成本次结果。
    await unlinkIfPresent(requestFile);
    await unlinkIfPresent(resultFile);
    signal?.throwIfAborted();
    await saveJson(requestFile, request);
    signal?.throwIfAborted();
    const processResult = await runProcess(process.execPath, [host, executor, workspace, requestFile, resultFile], workdir, timeoutMs, path.join(directory, "agent.log"), path.join(directory, "active.pid"), signal);
    signal?.throwIfAborted();
    let pluginResult: ExecutorResult = { code: processResult.code, timedOut: processResult.timedOut, output: processResult.output };
    if (!processResult.timedOut && existsSync(resultFile)) {
      try { pluginResult = JSON.parse(await readFile(resultFile, "utf8")) as ExecutorResult; }
      catch { pluginResult = { code: -1, output: "executor plugin returned an invalid result" }; }
    } else {
      // Compatibility fallback for an older plugin-host.js left in a development dist directory.
      const marker = /CBX_PLUGIN_RESULT=([A-Za-z0-9+/=]+)/g;
      const matches = [...processResult.output.matchAll(marker)];
      if (!processResult.timedOut && matches.length) {
        try { pluginResult = JSON.parse(Buffer.from(matches.at(-1)![1], "base64").toString("utf8")) as ExecutorResult; }
        catch { pluginResult = { code: -1, output: "executor plugin returned an invalid result" }; }
      }
    }
    signal?.throwIfAborted();
    const normalized = { code: Number(pluginResult.code ?? processResult.code), timedOut: processResult.timedOut || Boolean(pluginResult.timedOut), output: String(pluginResult.output ?? processResult.output) };
    appendEvent(path.join(directory, "events.ndjson"), { event: "plugin_finished", executor, code: normalized.code, timedOut: normalized.timedOut, at: new Date().toISOString() });
    return normalized;
  } finally {
    await cleanupPluginArtifacts(directory, requestFile, resultFile);
  }
}

export async function runTest(
  directory: string,
  workdir: string,
  command: string | undefined,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<ProcessResult> {
  const jobSignal = jobContext.getStore()?.controller.signal;
  const combined = combineAbortSignals(callerSignal, jobSignal);
  try {
    throwIfAborted(callerSignal, jobSignal);
    return await runTestCore(directory, workdir, command, timeoutMs, combined.signal);
  } catch (error) {
    rethrowPreferredAbort(error, callerSignal, jobSignal);
  } finally {
    combined.dispose();
  }
}

async function runTestCore(directory: string, workdir: string, command: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult> {
  signal?.throwIfAborted();
  if (!command) {
    signal?.throwIfAborted();
    await writeFile(path.join(directory, "test.log"), "未指定测试命令。\n", "utf8");
    signal?.throwIfAborted();
    return { code: 0, timedOut: false, output: "" };
  }
  // 执行期复验：context.json 是执行器可写文件，测试命令可能在创建校验之后被篡改。
  // 这里失败直接按执行失败处理（非零退出），不跑 shell。
  try {
    validateTestCommand(command);
  } catch (error) {
    signal?.throwIfAborted();
    const message = error instanceof Error ? error.message : String(error);
    await writeFile(path.join(directory, "test.log"), `$ ${command}\n\n拒绝执行：${message}\n`, "utf8");
    signal?.throwIfAborted();
    return { code: 1, timedOut: false, output: `测试命令被拒绝：${message}` };
  }
  const logFile = path.join(directory, "test.log");
  signal?.throwIfAborted();
  await writeFile(logFile, `$ ${command}\n\n`, "utf8");
  signal?.throwIfAborted();
  const result = await runShell(command, workdir, timeoutMs, logFile, path.join(directory, "active.pid"), signal);
  signal?.throwIfAborted();
  await appendFile(logFile, `\n退出码：${result.code}\n超时：${result.timedOut}\n内存输出已截断：${Boolean(result.outputTruncated)}\n`, "utf8");
  signal?.throwIfAborted();
  return result;
}
