import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { registerCbxWebRoutes } from "./web.js";
import { acquireScheduler, type SchedulerHandle } from "./queue-api.js";
import { WorkspacePolicy } from "./workspace-policy.js";

/** Plugin config for the cbx web dashboard entry. */
export interface WebConfig {
  web?: {
    /** Bearer token for data endpoints; shell and healthz stay open. */
    token?: string;
    /** Workspace allowlist for `?workspace=` selection; defaults to the invoking directory. */
    workspaces?: string[];
  };
}

/**
 * Resolve the effective web token. Empty/missing token no longer means "no
 * auth": a random token is generated once, persisted under the primary
 * workspace's `.cbx/web.token`, and reused across restarts. A harness web
 * server bound to a non-loopback interface would otherwise expose every data
 * endpoint (and job control) to the LAN.
 */
async function resolveWebToken(
  config: WebConfig,
  workspace: string,
): Promise<string | undefined> {
  if (config.web?.token) return config.web.token;
  const cbxDir = path.join(workspace, ".cbx");
  const tokenFile = path.join(cbxDir, "web.token");
  try {
    const existing = (await readFile(tokenFile, "utf8")).trim();
    if (existing) return existing;
  } catch {
    /* first run: no token file yet */
  }
  const token = randomBytes(24).toString("base64url");
  await mkdir(cbxDir, { recursive: true });
  // 0o600：共享主机上其他账户可读的 token 文件等于把仪表盘钥匙留在门外。
  await writeFile(tokenFile, token + "\n", { encoding: "utf8", mode: 0o600 });
  return token;
}

/**
 * Web entry of the cbx orchestrator: mounts the dashboard (HTML + REST + SSE)
 * under `/cbx` on the harness web server. Injects `webServer`, so it only
 * activates in profiles that host the web server; headless profiles load the
 * core plugin alone.
 */
export default class CbxWeb extends Service {
  static inject = ["cbx", "webServer"];

  static Config: z<WebConfig> = z.object({
    web: z.object({
      token: z.string(),
      workspaces: z.array(z.string()),
    }),
  });

  constructor(ctx: Context, config: WebConfig) {
    super(ctx, "cbxWeb");
    const workspacePolicy = new WorkspacePolicy(config.web?.workspaces ?? []);
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
    // token 解析是异步的：解析完成前插件可能已被卸载（HMR/关闭），此时不得再注册路由，
    // 否则路由/尾部 tailer/心跳定时器会挂在一个已 dispose 的 ctx 上泄漏。
    let disposed = false;
    ctx.effect(() => async () => {
      disposed = true;
      await releaseOwned();
      await waitPendingAcquires();
      await releaseOwned();
    }, "cbxWeb.lifecycle");
    void (async () => {
      let workspaces: readonly string[];
      try {
        // Canonicalize once and share the exact same policy with the route
        // selector, token path, and scheduler startup.
        workspaces = await workspacePolicy.listAllowedWorkspaces();
      } catch (error) {
        ctx.logger("cbx").error(
          `cbx web 工作区策略解析失败：${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      if (disposed) return;
      await Promise.all(workspaces.map((workspace) => acquireOne(workspace)));
      if (disposed) return;

      let token: string | undefined;
      try {
        token = await resolveWebToken(config, workspaces[0]);
      } catch (error) {
        ctx.logger("cbx").error(
          `cbx web token 自动生成失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (disposed) return;
      // fail-closed：解析不到任何 token 时绝不挂载无鉴权的数据端点——webServer 一旦
      // 绑定非 loopback，等于把任务控制面（创建/取消/purge）裸奔到局域网。
      if (!token) {
        ctx.logger("cbx").error(
          "cbx web 无法获得访问 token（.cbx 不可写且未配置 web.token），拒绝挂载仪表盘路由；请显式配置 web.token 或修复工作区写权限。",
        );
        return;
      }
      if (!config.web?.token) {
        ctx.logger("cbx").info(
          `cbx web 未配置 token，已自动生成随机 token：${path.join(workspaces[0], ".cbx", "web.token")}`,
        );
      }
      if (disposed) return;
      await registerCbxWebRoutes(ctx, {
        workspacePolicy,
        token,
        isDisposed: () => disposed,
      });
    })().catch(async (error) => {
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
  }
}
