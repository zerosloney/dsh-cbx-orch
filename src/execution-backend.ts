import type { InvocationMeta } from "./runner.js";
import type { ProcessResult } from "./process-runner.js";
import { invokeExecutor, runTest } from "./runner.js";
import { CbxError } from "./errors.js";

export type { ProcessResult };

/** 一次 executor（编码代理 / 审查代理 / 经理）的执行请求。 */
export interface ExecutorRunRequest {
  executor: string;
  workspace: string;
  directory: string;
  workdir: string;
  prompt: string;
  permissionMode: string;
  maxTurns: number;
  timeoutMs: number;
  invocationMeta?: InvocationMeta;
  callerSignal?: AbortSignal;
}

/** 传给可插拔后端的 job 上下文信息。 */
export interface CbxExecutionJobContext {
  workspace: string;
  jobId: string;
  directory: string;
  workdir: string;
  isolated: boolean;
  keepWorktree: boolean;
  artifactsDir?: string;
  envAllowlist?: readonly string[];
  trustMode?: "trusted" | "untrusted";
  executionBackend?: string;
}

/** 执行选项。 */
export interface CbxExecutionOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 已准备好的执行 world：代表一个 job 的执行环境。
 * - 默认 host 后端：在宿主机直接 spawn 子进程；
 * - 容器化后端：在一个隔离容器中运行。
 */
export interface CbxExecutionWorld {
  /** 挂载/准备 job 需要的产物与运行时环境校验。 */
  prepare(): Promise<void>;
  /** 在 world 内运行一次 executor（编码 agent）。 */
  runAgent(request: ExecutorRunRequest): Promise<ProcessResult>;
  /** 在 world 内运行测试/验收命令。 */
  runTest(
    command: string | undefined,
    cwd: string,
    timeoutMs: number,
    callerSignal?: AbortSignal,
  ): Promise<ProcessResult>;
  /** 释放 world 资源（幂等、可重入）。 */
  dispose(): Promise<void>;
}

/** 后端工厂：按 job 上下文创建执行 world。 */
export interface CbxExecutionBackend {
  readonly name: string;
  /** 校验可用性（不可用返回 false 或抛出明确原因）。 */
  available(job: CbxExecutionJobContext): Promise<boolean>;
  /** 创建 world 实例。 */
  createWorld(
    job: CbxExecutionJobContext,
    options?: CbxExecutionOptions,
  ): Promise<CbxExecutionWorld>;
}

/** 默认的宿主执行 World 实现：在当前进程/子进程树中执行。 */
export class HostExecutionWorld implements CbxExecutionWorld {
  constructor(
    public readonly job: CbxExecutionJobContext,
    public readonly options?: CbxExecutionOptions,
  ) {}

  async prepare(): Promise<void> {
    // 宿主 world: 文件系统和 worktree 已经就位，无需额外容器挂载
  }

  async runAgent(request: ExecutorRunRequest): Promise<ProcessResult> {
    return invokeExecutor(
      request.executor,
      request.workspace,
      request.directory,
      request.workdir,
      request.prompt,
      request.permissionMode,
      request.maxTurns,
      request.timeoutMs,
      request.invocationMeta,
      request.callerSignal ?? this.options?.signal,
    );
  }

  async runTest(
    command: string | undefined,
    cwd: string,
    timeoutMs: number,
    callerSignal?: AbortSignal,
  ): Promise<ProcessResult> {
    return runTest(
      this.job.directory,
      cwd,
      command,
      timeoutMs,
      callerSignal ?? this.options?.signal,
    );
  }

  async dispose(): Promise<void> {
    // 宿主 world: 退出时由进程树与上下文自动收尾，幂等无操作
  }
}

/** 默认的宿主执行后端。 */
export class HostExecutionBackend implements CbxExecutionBackend {
  readonly name = "host";

  async available(_job: CbxExecutionJobContext): Promise<boolean> {
    return true;
  }

  async createWorld(
    job: CbxExecutionJobContext,
    options?: CbxExecutionOptions,
  ): Promise<CbxExecutionWorld> {
    return new HostExecutionWorld(job, options);
  }
}

const backends = new Map<string, CbxExecutionBackend>();
const defaultHostBackend = new HostExecutionBackend();
backends.set(defaultHostBackend.name, defaultHostBackend);

/** 注册可插拔执行后端；返回注销函数。 */
export function registerExecutionBackend(
  backend: CbxExecutionBackend,
): () => void {
  if (!backend || typeof backend.name !== "string" || !backend.name.trim()) {
    throw new CbxError("E_INVALID_CONTEXT", "执行后端必须具有非空的 name 属性。");
  }
  backends.set(backend.name, backend);
  return () => {
    if (backends.get(backend.name) === backend && backend.name !== "host") {
      backends.delete(backend.name);
    }
  };
}

/** 按名称查询已注册的执行后端。 */
export function getExecutionBackend(
  name: string,
): CbxExecutionBackend | undefined {
  return backends.get(name);
}

/** 列出所有已注册执行后端的名称。 */
export function listExecutionBackends(): string[] {
  return Array.from(backends.keys());
}

/** 解析指定的执行后端；找不到时抛出 E_BACKEND_UNAVAILABLE。 */
export function resolveExecutionBackend(name?: string): CbxExecutionBackend {
  const selected = name && name.trim() ? name.trim() : "host";
  const backend = backends.get(selected);
  if (!backend) {
    throw new CbxError(
      "E_BACKEND_UNAVAILABLE",
      `未找到执行后端 "${selected}"。当前已注册后端：${listExecutionBackends().join(", ")}`,
    );
  }
  return backend;
}

/** 清理非内置的自定义执行后端（测试用）。 */
export function clearCustomExecutionBackends(): void {
  for (const key of Array.from(backends.keys())) {
    if (key !== "host") backends.delete(key);
  }
}
