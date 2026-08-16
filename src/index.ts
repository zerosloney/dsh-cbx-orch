import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { setProcessSpawnProvider } from "./process-runner.js";
import { createSubprocessProvider } from "./subprocess-adapter.js";
import { closeDatabaseConnections } from "./storage.js";
import { disposeObservability } from "./observability.js";
import { registerCbxTools, type CbxDefaults } from "./tools.js";
import { registerCbxCommands } from "./commands.js";
import { ensureScheduler, stopScheduler } from "./queue-api.js";

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
}

/**
 * The cbx orchestrator as a DeepSeek Harness plugin. Loads in every profile
 * (the base bundle provides subprocess/tools/commands); the separate
 * `dsh-cbx-orch/web` entry mounts the dashboard only where webServer exists.
 */
export default class CbxOrchestrator extends Service {
  static inject = ["subprocess", "tools", "commands"];

  static Config: z<Config> = z.object({
    executor: z.string(),
    review: z.boolean(),
    isolated: z.boolean(),
  });

  constructor(ctx: Context, config: Config) {
    super(ctx, "cbx");
    const defaults: CbxDefaults = {
      executor: config.executor,
      review: config.review,
      isolated: config.isolated,
    };
    // Route all executor/test/git child processes through the harness
    // subprocess seam (tree-scoped termination, cancel integration).
    // disposer 带属主校验：HMR 下旧实例卸载只会撤掉自己的 provider。
    const disposeProvider = setProcessSpawnProvider(createSubprocessProvider(ctx.subprocess));
    registerCbxTools(ctx, defaults);
    registerCbxCommands({ ctx, defaults });
    // 常驻调度器：30s 定时 dispatch（含死 worker 回收），启动即 tick 一次——
    // 崩溃重启后无需等下一次入队就能续跑遗留任务（README"可恢复续跑"承诺的落地）。
    ctx.effect(() => {
      void ensureScheduler(process.cwd());
      return () => {
        void stopScheduler(process.cwd());
      };
    }, "cbx.scheduler");
    ctx.effect(() => () => {
      disposeProvider();
      void closeDatabaseConnections();
      void disposeObservability();
    }, "cbx.provider");
  }
}
