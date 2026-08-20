import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { setProcessSpawnProvider } from "./process-runner.js";
import { createSubprocessProvider, setExecutorEnvAllowlist } from "./subprocess-adapter.js";
import { closeDatabaseConnections } from "./storage.js";
import { disposeObservability } from "./observability.js";
import { registerCbxTools, type CbxDefaults } from "./tools.js";
import { registerCbxCommands } from "./commands.js";
import { acquireScheduler, type SchedulerHandle } from "./queue-api.js";
import { WorkspacePolicy } from "./workspace-policy.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** The cbx durable orchestrator seam: job queue, state machine, executors. */
    cbx: CbxOrchestrator;
  }
}

/** Plugin config: deployment defaults applied when a job/tool call omits the field. */
export interface Config {
  /** Default executor: codebuddy / opencode / omp / cline / qwen. */
  executor?: string;
  /** Run an independent review phase after tests pass. */
  review?: boolean;
  /** Run tasks in an isolated git worktree. */
  isolated?: boolean;
  /** Explicitly authorized workspace directories; an empty list means cwd only. */
  workspaces?: string[];
  /** Default policy for carrying uncommitted changes into isolated worktrees.
   *  true = isolated+dirty tasks that request carryDirty actually carry the dirty
   *  state into the worktree; false (default) = such tasks fail-fast at creation
   *  unless the caller opts in. */
  carryDirty?: boolean;
  /** Opt-in host env allowlist for executor/test child processes. When set (non-empty),
   *  only these vars (plus essential system vars) reach the child; when empty/missing
   *  the host env is inherited as before (intentional: coding CLIs need API credentials). */
  executors?: {
    envAllowlist?: string[];
  };
}

/**
 * The cbx orchestrator as a DeepSeek Harness plugin. Loads in every profile
 * (the base bundle provides subprocess/tools/commands); the separate
 * `dsh-cbx-orch/web` entry mounts the dashboard only where webServer exists.
 */
export default class CbxOrchestrator extends Service {
  static inject = ["subprocess", "tools", "commands"];

  static Config: z<Config> = z.object({
    executor: z.string().default("codebuddy"),
    review: z.boolean().default(true),
    isolated: z.boolean().default(true),
    carryDirty: z.boolean().default(false),
    workspaces: z.array(z.string()).default([]),
    executors: z.object({
      envAllowlist: z.array(z.string()).default([]),
    }),
  });

  constructor(ctx: Context, config: Config) {
    super(ctx, "cbx");
    const workspacePolicy = new WorkspacePolicy(config.workspaces ?? []);
    const defaults: CbxDefaults = {
      executor: config.executor,
      review: config.review,
      isolated: config.isolated,
      carryDirty: config.carryDirty,
      workspacePolicy,
    };
    // Route all executor/test/git child processes through the harness
    // subprocess seam (tree-scoped termination, cancel integration).
    // disposer 带属主校验：HMR 下旧实例卸载只会撤掉自己的 provider。
    const disposeProvider = setProcessSpawnProvider(createSubprocessProvider(ctx.subprocess));
    // executor 子进程环境变量白名单（可选，opt-in 硬化）。空数组 = 保持完整继承。
    const envAllowlist = config.executors?.envAllowlist;
    const disposeEnvAllowlist = setExecutorEnvAllowlist(
      envAllowlist && envAllowlist.length > 0 ? envAllowlist : undefined,
    );
    registerCbxTools(ctx, defaults);
    registerCbxCommands({ ctx, defaults });
    let disposeSchedulers: (() => Promise<void>) | undefined;
    // Register provider teardown before the scheduler effect. Cordis unloads
    // effects in reverse registration order; the explicit await below also
    // protects hosts that unload sibling effects concurrently.
    ctx.effect(() => async () => {
      try {
        await disposeSchedulers?.();
      } finally {
        try {
          disposeProvider();
        } finally {
          try {
            disposeEnvAllowlist();
          } finally {
            try {
              await closeDatabaseConnections();
            } finally {
              disposeObservability();
            }
          }
        }
      }
    }, "cbx.provider");
    // 常驻调度器：30s 定时 dispatch（含死 worker 回收），启动即 tick 一次——
    // 崩溃重启后无需等下一次入队就能续跑遗留任务（README"可恢复续跑"承诺的落地）。
    ctx.effect(() => {
      let disposed = false;
      const ownedSchedulers = new Set<SchedulerHandle>();
      const pendingAcquires = new Set<Promise<void>>();
      const releaseOwned = async (): Promise<void> => {
        const handles = [...ownedSchedulers];
        ownedSchedulers.clear();
        await Promise.all(handles.map((handle) => handle.release()));
      };
      const waitPendingAcquires = async (): Promise<void> => {
        while (pendingAcquires.size > 0)
          await Promise.allSettled([...pendingAcquires]);
      };
      let cleanupTask: Promise<void> | undefined;
      const cleanup = (): Promise<void> => {
        if (cleanupTask) return cleanupTask;
        disposed = true;
        cleanupTask = (async () => {
          await releaseOwned();
          await waitPendingAcquires();
          await releaseOwned();
        })();
        return cleanupTask;
      };
      disposeSchedulers = cleanup;
      const acquireOne = (workspace: string): Promise<void> => {
        const pending = (async () => {
          const handle = await acquireScheduler(workspace);
          if (disposed) {
            await handle.release();
            return;
          }
          ownedSchedulers.add(handle);
          await handle.ready;
          if (disposed) {
            ownedSchedulers.delete(handle);
            await handle.release();
          }
        })();
        pendingAcquires.add(pending);
        void pending.then(
          () => pendingAcquires.delete(pending),
          () => pendingAcquires.delete(pending),
        );
        return pending;
      };
      void (async () => {
        // 仅对**显式配置**的工作区在启动时拉起常驻调度器（崩溃重启后无需等下一次
        // 入队就能续跑遗留任务）。空配置（workspaces: []）时工作区跟随委派目录动态
        // 解析，没有单一权威目录可常驻——此时不预拉调度器，避免在 process.cwd() 里
        // 无谓创建 .cbx；这些目录的调度器会在入队/派发时经 ensureScheduler 按需拉起，
        // 同样会回收死 worker 并续跑遗留任务。
        if (!workspacePolicy.hasExplicitWorkspaces()) return;
        let workspaces: readonly string[];
        try {
          workspaces = await workspacePolicy.listAllowedWorkspaces();
        } catch (error) {
          ctx.logger("cbx").error(
            `cbx 核心工作区策略解析失败：${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        if (disposed) return;
        await Promise.all(workspaces.map((workspace) => acquireOne(workspace)));
      })().catch(async (error) => {
        const wasDisposed = disposed;
        await cleanup();
        if (!wasDisposed) {
          ctx.logger("cbx").error(
            `cbx 核心调度器启动失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
      return async () => {
        try {
          await cleanup();
        } finally {
          if (disposeSchedulers === cleanup) disposeSchedulers = undefined;
        }
      };
    }, "cbx.scheduler");
  }
}

export { CbxOrchestrator };
export * from "./types.js";

