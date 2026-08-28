import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { stat } from "node:fs/promises";
import path from "node:path";
import { registerCbxWebRoutes } from "./web.js";
import { acquireScheduler, type SchedulerHandle } from "./queue-api.js";
import { WorkspacePolicy } from "./workspace-policy.js";

/** Plugin config for the cbx web dashboard entry. */
export interface WebConfig {
  web?: {
    /**
     * @deprecated 已废弃：仪表盘始终跟随 harness 工作区注册表（与 agent/GUI 共享
     * 同一工作区集合），不再读这个独立 allowlist。保留字段仅为向后兼容既有 profile
     * 配置，新部署请勿设置。
     */
    workspaces?: string[];
  };
}

/** Minimal structural view of the harness workspace registry (dsh-workspace). */
export interface WorkspaceRegistryLike {
  list(): ReadonlyArray<{ path: string }>;
}

/** webServer 轮询窗口：25 × 200ms = 5s（harness 启动时序繁忙时给足裕量）。 */
const WEB_SERVER_WAIT_ATTEMPTS = 25;
const WEB_SERVER_POLL_MS = 200;
/** 首次轮询超时后的一次延迟重试间隔：晚就绪的 webServer 仍能挂上仪表盘，
 *  不再"2s 没等到就永远不挂载且零诊断"。 */
const WEB_SERVER_RETRY_MS = 30_000;

/** Wait briefly for an optional web server without making it a required injection. */
async function waitForWebServer(ctx: Context): Promise<Context["webServer"] | undefined> {
  for (let attempt = 0; attempt < WEB_SERVER_WAIT_ATTEMPTS; attempt += 1) {
    try {
      const webServer = ctx.get("webServer") as Context["webServer"] | undefined;
      if (typeof webServer?.register === "function") return webServer;
    } catch {
      /* Headless profile or web server not ready yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, WEB_SERVER_POLL_MS));
  }
  return undefined;
}

/**
 * Resolve the effective workspace list for the web dashboard.
 *
 * An explicit `web.workspaces` list wins verbatim (exact-match allowlist).
 * With an empty list, the Web layer has no session context of its own, so the
 * harness's own workspace registry is the authoritative "directories the user
 * actually works in" (session cwd → workspace record). Entries whose directory
 * has been deleted are dropped; an unavailable/empty registry yields `[]`,
 * which the caller falls back to the process cwd.
 */
export async function resolveWebWorkspaceList(
  config: WebConfig,
  registry?: WorkspaceRegistryLike,
): Promise<readonly string[]> {
  const explicit = config.web?.workspaces ?? [];
  if (explicit.length > 0) return explicit;
  if (!registry || typeof registry.list !== "function") return [];
  const existing: string[] = [];
  const seen = new Set<string>();
  for (const workspace of registry.list()) {
    const candidate = workspace?.path;
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if ((await stat(candidate)).isDirectory()) existing.push(candidate);
    } catch {
      /* 目录已不存在：不计入，避免 WorkspacePolicy 因缺失目录整体抛错 */
    }
  }
  return existing;
}

/** 短时轮询等待 harness 工作区注册表就绪（可选依赖：注册表晚于 web 插件启动时也能取到）。 */
async function waitForWorkspaceRegistry(
  ctx: Context,
): Promise<WorkspaceRegistryLike | undefined> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const registry = ctx.get("workspaceRegistry") as WorkspaceRegistryLike | undefined;
      if (registry && typeof registry.list === "function") return registry;
    } catch {
      /* 服务尚未提供：继续等待 */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return undefined;
}

/**
 * Web token 已移除：cbx 仪表盘信任 harness webServer 的同源边界，不再提供独立鉴权。
 * harness webServer 显式暴露到非 loopback 的场景）；未配置时仪表盘开放访问，
 * 与 harness GUI 共用同一 webServer 的同源信任边界。
 */

/**
 * Web entry of the cbx orchestrator: mounts the dashboard (HTML + REST + SSE)
 * under `/cbx` on the harness web server. The web server is optional so the
 * bundle can also load its core entry in headless profiles.
 */
export default class CbxWeb extends Service {
  static inject = ["cbx"];

  static Config: z<WebConfig> = z.object({
    web: z.object({
      workspaces: z.array(z.string()),
    }),
  });

  /**
   * 仪表盘路由是否已真实挂载到 webServer。与「服务存在」不同：工作区策略解析失败、
   * webServer 就绪超时都会让服务存在但路由未挂载。供
   * commands.ts 的 webPluginActive 判定（/cbx-web 据此区分"可访问"与"未挂载"）。
   */
  mounted = false;

  constructor(ctx: Context, config: WebConfig) {
    super(ctx, "cbxWeb");
    // web.workspaces 已废弃：仪表盘始终跟随 harness 工作区注册表（与 agent/GUI
    // 共享同一工作区集合），不再读独立 allowlist，避免两边工作区集合漂移。
    const explicitWorkspaces: string[] = [];
    const workspacePolicy = new WorkspacePolicy(explicitWorkspaces);
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
    // 路由挂载是异步的：挂载完成前插件可能已被卸载（HMR/关闭），此时不得再注册路由，
    // 否则路由/尾部 tailer/心跳定时器会挂在一个已 dispose 的 ctx 上泄漏。
    let disposed = false;
    let retryTimer: NodeJS.Timeout | undefined;
    ctx.effect(() => async () => {
      disposed = true;
      // 清掉延迟重试定时器：卸载后不得再尝试挂载（挂在已 dispose 的 ctx 上）。
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      await releaseOwned();
      await waitPendingAcquires();
      await releaseOwned();
    }, "cbxWeb.lifecycle");
    // 挂载尝试（含 webServer 等待）：首轮超时打日志并 30s 后重试一次——晚就绪的
    // webServer 仍能挂上，不再"2s 没等到就永远不挂载且零诊断"（旧实现静默 return）。
    let mountAttempted = false;
    const attemptMount = async (): Promise<void> => {
      if (disposed) return;
      const webServer = await waitForWebServer(ctx);
      if (disposed) return;
      if (!webServer) {
        if (!mountAttempted) {
          // 首轮超时：区分 headless（无 web 层，预期行为）与"webServer 就绪慢"（故障）。
          // ctx.get 不抛错且返回 undefined = 服务未注册；无法完全区分两者，但延迟
          // 重试 + 明确日志能让"晚就绪"自愈，headless 则只记一次 warn 不刷屏。
          ctx.logger("cbx").warn(
            `cbx web: ${WEB_SERVER_WAIT_ATTEMPTS * WEB_SERVER_POLL_MS / 1000}s 内未检测到 webServer，30s 后将重试一次。` +
              "若本 profile 无 web 层（headless），此提示可忽略。",
          );
        }
        if (!retryTimer) {
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            void attemptMount().catch((error) => {
              // 重试挂载异常：记录并放弃（不产生 unhandled rejection）。
              ctx.logger("cbx").error(
                `cbx web 延迟重试挂载失败：${error instanceof Error ? error.message : String(error)}`,
              );
            });
          }, WEB_SERVER_RETRY_MS);
          retryTimer.unref?.();
        }
        return;
      }
      mountAttempted = true;
      if (explicitWorkspaces.length === 0) {
        // 空配置：Web 层没有会话上下文，但 harness 工作区注册表（ctx.workspaceRegistry）
        // 记录了用户实际打开的工作区目录（会话 cwd → workspace 记录）。跟随注册表而非
        // 默认回落 process.cwd()：后者在 `dsh web` 从别的目录启动时会导致仪表盘显示
        // 一个与真实工作区无关的空目录（jobs 为空、?workspace= 还被 400 拒绝）。
        const registry = await waitForWorkspaceRegistry(ctx);
        if (registry) {
          const registryWorkspaces = await resolveWebWorkspaceList({}, registry);
          if (registryWorkspaces.length > 0) {
            ctx.logger("cbx").info(
              `cbx web 未配置 web.workspaces，跟随 harness 工作区注册表（${registryWorkspaces.length} 个）：${registryWorkspaces.join(", ")}`,
            );
            // 注册表路径已是 canonical（realpath），WorkspacePolicy 会再次校验目录存在性。
            await registerWebWith(new WorkspacePolicy([...registryWorkspaces]), webServer);
            return;
          }
          // 注册表存在但为空：回落 process.cwd()（旧行为）。
        }
      }
      await registerWebWith(workspacePolicy, webServer);
    };
    void attemptMount().catch(async (error) => {
      const wasDisposed = disposed;
      disposed = true;
      await releaseOwned();
      await waitPendingAcquires();
      await releaseOwned();
      if (!wasDisposed) {
        ctx.logger("cbx").error(
          `cbx web 路由注册失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    // registerWebWith 内部完成调度器获取与路由挂载；拆成函数以支持
    // 注册表派生列表与显式列表两条路径共用同一套启动流程。箭头函数保持 this
    // 指向实例，成功挂载后置 mounted 供 commands.ts 判定。
    const registerWebWith = async (
      policy: WorkspacePolicy,
      webServer: Context["webServer"],
    ): Promise<void> => {
      return (async () => {
        let workspaces: readonly string[];
        try {
          workspaces = await policy.listAllowedWorkspaces();
        } catch (error) {
          ctx.logger("cbx").error(
            `cbx web 工作区策略解析失败：${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        if (disposed) return;
        await Promise.all(workspaces.map((workspace) => acquireOne(workspace)));
        if (disposed) return;
        await registerCbxWebRoutes(ctx, {
          webServer,
          workspacePolicy: policy,
          isDisposed: () => disposed,
        });
        // 路由真实挂载成功后才置标记：/cbx-web 命令据此知道仪表盘可访问。
        this.mounted = true;
        ctx.logger("cbx").info(`cbx web 仪表盘已挂载（${workspaces.length} 个工作区）。`);
      })();
    };
  }
}
