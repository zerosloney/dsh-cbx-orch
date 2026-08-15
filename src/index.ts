import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { setProcessSpawnProvider } from "./process-runner.js";
import { createSubprocessProvider } from "./subprocess-adapter.js";
import { registerCbxTools, type CbxDefaults } from "./tools.js";
import { registerCbxCommands } from "./commands.js";

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
    setProcessSpawnProvider(createSubprocessProvider(ctx.subprocess));
    registerCbxTools(ctx, defaults);
    registerCbxCommands({ ctx, defaults });
    ctx.effect(() => () => {
      setProcessSpawnProvider(undefined);
    }, "cbx.provider");
  }
}
