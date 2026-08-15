import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { registerCbxWebRoutes } from "./web.js";

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
    registerCbxWebRoutes(ctx, {
      workspaces: config.web?.workspaces,
      token: config.web?.token,
    });
  }
}
