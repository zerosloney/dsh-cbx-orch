import type { Context } from "@deepseek-ai/cordis";
import { startBackground, cancelJob } from "./lifecycle.js";
import { createJob } from "./jobs.js";
import { listQueue, pauseQueue, resumeQueue } from "./queue-api.js";
import { listJobs, readArtifact } from "./artifacts.js";
import { loadConfig, loadState, mergeConfig } from "./state.js";
import type { CbxDefaults } from "./tools.js";
import type { CommandResult } from "@deepseek-ai/dsh-commands";

/** Registration entry shared by the interactive command layer. */
interface CbxCommandContext {
  ctx: Context;
  defaults: CbxDefaults;
}

function ok(text?: string): CommandResult {
  return { kind: "success", ...(text === undefined ? {} : { text }) };
}

function err(text: string): CommandResult {
  return { kind: "error", text };
}

function workspace(): string {
  return process.cwd();
}

export function registerCbxCommands(service: CbxCommandContext): void {
  const commands = service.ctx.commands;
  const defaults = service.defaults;

  commands.register({
    name: "cbx-run",
    description: "Delegate a task to the cbx orchestrator in the background (test + review), returning the job id.",
    input: { hint: "task to delegate" },
    async handler(invocation) {
      const task = invocation.rawInput.trim();
      if (!task) return err("Usage: /cbx-run <task>");
      const ws = workspace();
      const config = await loadConfig(ws);
      const merged = mergeConfig(config, {
        review: defaults.review,
        isolated: defaults.isolated,
      });
      try {
        const created = await createJob({
          workspace: ws,
          task,
          review: merged.review,
          isolated: merged.isolated,
          permissionMode: merged.permissionMode,
          maxTurns: merged.maxTurns,
          testCommand: merged.testCommand,
          timeoutMs: merged.timeoutMs,
          maxRetries: merged.maxRetries,
          keepWorktree: merged.keepWorktree,
          reviewRules: config.reviewRules,
          approvalBeforeRun: merged.approvalBeforeRun,
          autoBranch: merged.autoBranch,
          autoCommit: merged.autoCommit,
          commitMessage: merged.commitMessage,
          executor: merged.executor ?? defaults.executor,
          reviewExecutor: merged.reviewExecutor,
          adaptive: merged.adaptive,
          trustMode: merged.trustMode,
          dependencyGuard: merged.dependencyGuard,
        });
        await startBackground(ws, created.jobId, "", 0);
        return ok(`job ${created.jobId} queued (executor ${merged.executor ?? defaults.executor ?? "codebuddy"}). Use /cbx-status ${created.jobId} to track it.`);
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  });

  commands.register({
    name: "cbx-status",
    description: "Show the current state and stage of one cbx job.",
    input: { hint: "job id" },
    async handler(invocation) {
      const jobId = invocation.rawInput.trim();
      if (!jobId) return err("Usage: /cbx-status <job_id>");
      try {
        const state = await loadState(workspace(), jobId);
        return ok(`[${jobId}] ${state.status}${state.phase ? ` / ${state.phase}` : ""}${state.stage ? ` / stage ${state.stage}` : ""}${state.attempt !== undefined ? ` (attempt ${state.attempt})` : ""}`);
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  });

  commands.register({
    name: "cbx-continue",
    description: "Re-enqueue a job stuck in needs_fix/review_failed with follow-up instructions.",
    input: { hint: "job_id [message]" },
    async handler(invocation) {
      const [jobId, ...rest] = invocation.rawInput.trim().split(/\s+/);
      if (!jobId) return err("Usage: /cbx-continue <job_id> [message]");
      const message = rest.join(" ");
      try {
        await startBackground(workspace(), jobId, message, 0);
        return ok(`job ${jobId} re-queued for continuation.`);
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  });

  commands.register({
    name: "cbx-cancel",
    description: "Cancel a running or queued cbx job.",
    input: { hint: "job id" },
    async handler(invocation) {
      const jobId = invocation.rawInput.trim();
      if (!jobId) return err("Usage: /cbx-cancel <job_id>");
      try {
        const state = await cancelJob(workspace(), jobId);
        return ok(`[${jobId}] ${state.status}`);
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  });

  commands.register({
    name: "cbx-list",
    description: "List cbx jobs in the current workspace.",
    async handler() {
      try {
        const jobs = await listJobs(workspace());
        if (jobs.length === 0) return ok("no cbx jobs in this workspace.");
        const lines = jobs.map((job) =>
          `[${job.jobId}] ${job.status}${job.phase ? ` / ${job.phase}` : ""}${job.createdAt ? ` created ${job.createdAt}` : ""}`,
        );
        return ok(lines.join("\n"));
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  });

  commands.register({
    name: "cbx-queue",
    description: "Inspect the cbx queue, or pause/resume it.",
    input: { hint: "pause | resume" },
    async handler(invocation) {
      const action = invocation.rawInput.trim();
      try {
        if (action === "pause") return ok(JSON.stringify(await pauseQueue(workspace())));
        if (action === "resume") return ok(JSON.stringify(await resumeQueue(workspace())));
        if (action === "") return ok(JSON.stringify(await listQueue(workspace())));
        // 拼写错误不再静默降级为"查看队列"，显式报错避免误导。
        return err(`未知操作：${action}（支持 pause / resume，空参数查看队列）。`);
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  });

  commands.register({
    name: "cbx-result",
    description: "Read a cbx job's result.json.",
    input: { hint: "job id" },
    async handler(invocation) {
      const jobId = invocation.rawInput.trim();
      if (!jobId) return err("Usage: /cbx-result <job_id>");
      try {
        return ok(await readArtifact(workspace(), jobId, "result.json"));
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  });
}
