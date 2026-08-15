import { appendFileSync, existsSync } from "node:fs";
import { appendFile, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectExecutorPlugin, type ExecutorResult, type ExecutorRequest } from "./executor.js";
import { findExecutable, resolveExecutor } from "./executors/builtin.js";
import { bumpInvocationCount, loadConfig } from "./state.js";
import { runProcess, runShell, type ProcessResult } from "./process-runner.js";
import { saveJson } from "./storage.js";
import { APP_VERSION } from "./version.js";

export type InvocationRole = "stage" | "review" | "manager" | "gate";

export interface InvocationMeta {
  role: InvocationRole;
  jobId: string;
  stageIndex?: number;
}

export function promptFor(phase: string, extra = "", _label: string, contextPack: string): string {
  return `你是任务执行代理。\n\n只读取当前角色上下文包：\n- ${contextPack}\n\n上下文包是编排器生成的最小化脱敏投影；只可额外读取其中 artifacts 明确列出的文件，不要读取任何未列材料或历史轨迹。\n当前阶段：${phase}\n\n${extra}`;
}

async function invokeBuiltin(spec: ReturnType<typeof resolveExecutor> & {}, directory: string, workdir: string, prompt: string, permissionMode: string, maxTurns: number, timeoutMs: number): Promise<ProcessResult> {
  const executable = findExecutable(spec);
  const args = [...executable.slice(1), ...spec.buildArgs({ prompt, permissionMode, maxTurns })];
  const command = executable[0];
  const eventsFile = path.join(directory, "events.ndjson");
  const outputLog = path.join(directory, "agent.log");
  appendFileSync(eventsFile, JSON.stringify({ event: "executor_metadata", source: "builtin", name: spec.name, version: APP_VERSION, at: new Date().toISOString() }) + "\n", "utf8");
  appendFileSync(eventsFile, JSON.stringify({ event: "process_started", command: [command, ...args], cwd: workdir, at: new Date().toISOString() }) + "\n", "utf8");
  const result = await runProcess(command, args, workdir, timeoutMs, outputLog, path.join(directory, "active.pid"));
  appendFileSync(eventsFile, JSON.stringify({ event: "process_finished", returncode: result.code, timedOut: result.timedOut, at: new Date().toISOString() }) + "\n", "utf8");
  return result;
}

export async function invokeExecutor(executor: string, workspace: string, directory: string, workdir: string, prompt: string, permissionMode: string, maxTurns: number, timeoutMs: number, invocationMeta?: InvocationMeta): Promise<ProcessResult> {
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
      appendFileSync(
        path.join(directory, "events.ndjson"),
        JSON.stringify({
          event: "invocation_count_failed",
          role: invocationMeta.role,
          stageIndex: invocationMeta.stageIndex,
          error: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        }) + "\n",
        "utf8",
      );
    }
  }
  const builtin = resolveExecutor(executor);
  if (builtin) return invokeBuiltin(builtin, directory, workdir, prompt, permissionMode, maxTurns, timeoutMs);
  const config = await loadConfig(workspace);
  const identity = await inspectExecutorPlugin(executor, workspace, config.plugins);
  if (!config.plugins?.enforce) {
    // 默认不强制插件白名单：显式告警并落审计事件，提醒生产环境启用 plugins.enforce。
    const warning = `executor 指向插件 ${identity.path}，但 plugins.enforce 未启用，插件未经路径/SHA 白名单校验即被加载；生产环境请配置 plugins.enforce=true 与 allowPaths/allowSha256。`;
    console.error(`cbx: ${warning}`);
    appendFileSync(path.join(directory, "events.ndjson"), JSON.stringify({ event: "plugin_policy_warning", executor: identity.name, path: identity.path, sha256: identity.sha256, enforce: false, at: new Date().toISOString() }) + "\n", "utf8");
  }
  const request: ExecutorRequest = { directory, workdir, prompt, permissionMode, maxTurns, timeoutMs, executor, plugin: { policy: config.plugins, sha256: identity.sha256 } };
  appendFileSync(path.join(directory, "events.ndjson"), JSON.stringify({ event: "executor_metadata", source: identity.source, name: identity.name, version: identity.version, apiVersion: identity.apiVersion, capabilities: identity.capabilities, sha256: identity.sha256, at: new Date().toISOString() }) + "\n", "utf8");
  appendFileSync(path.join(directory, "events.ndjson"), JSON.stringify({ event: "plugin_started", executor: identity.name, at: new Date().toISOString() }) + "\n", "utf8");
  const requestFile = path.join(directory, "plugin-request.json");
  const resultFile = path.join(directory, "plugin-result.json");
  await saveJson(requestFile, request);
  const host = path.join(path.dirname(fileURLToPath(import.meta.url)), "plugin-host.js");
  const processResult = await runProcess(process.execPath, [host, executor, workspace, requestFile, resultFile], workdir, timeoutMs, path.join(directory, "agent.log"), path.join(directory, "active.pid"));
  let pluginResult: ExecutorResult = { code: processResult.code, timedOut: processResult.timedOut, output: processResult.output };
  if (!processResult.timedOut && existsSync(resultFile)) {
    try { pluginResult = JSON.parse(await readFile(resultFile, "utf8")) as ExecutorResult; }
    catch { pluginResult = { code: -1, output: "executor plugin returned an invalid result" }; }
    finally { await unlink(resultFile).catch(() => undefined); }
  } else {
    // Compatibility fallback for an older plugin-host.js left in a development dist directory.
    const marker = /CBX_PLUGIN_RESULT=([A-Za-z0-9+/=]+)/g;
    const matches = [...processResult.output.matchAll(marker)];
    if (!processResult.timedOut && matches.length) {
      try { pluginResult = JSON.parse(Buffer.from(matches.at(-1)![1], "base64").toString("utf8")) as ExecutorResult; }
      catch { pluginResult = { code: -1, output: "executor plugin returned an invalid result" }; }
    }
  }
  const normalized = { code: Number(pluginResult.code ?? processResult.code), timedOut: processResult.timedOut || Boolean(pluginResult.timedOut), output: String(pluginResult.output ?? processResult.output) };
  appendFileSync(path.join(directory, "events.ndjson"), JSON.stringify({ event: "plugin_finished", executor, code: normalized.code, timedOut: normalized.timedOut, at: new Date().toISOString() }) + "\n", "utf8");
  return normalized;
}

export async function runTest(directory: string, workdir: string, command: string | undefined, timeoutMs: number): Promise<ProcessResult> {
  if (!command) { await writeFile(path.join(directory, "test.log"), "未指定测试命令。\n", "utf8"); return { code: 0, timedOut: false, output: "" }; }
  const logFile = path.join(directory, "test.log");
  await writeFile(logFile, `$ ${command}\n\n`, "utf8");
  const result = await runShell(command, workdir, timeoutMs, logFile, path.join(directory, "active.pid"));
  await appendFile(logFile, `\n退出码：${result.code}\n超时：${result.timedOut}\n内存输出已截断：${Boolean(result.outputTruncated)}\n`, "utf8");
  return result;
}
