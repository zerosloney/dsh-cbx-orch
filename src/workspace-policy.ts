import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { CbxError } from "./errors.js";

/**
 * Canonical, exact-match workspace allowlist used by future entry points.
 *
 * The policy is intentionally small: it establishes one canonical spelling for
 * each existing directory and never expands an allowlist to arbitrary child
 * paths. Callers that need artifact/worktree containment should add a narrower
 * policy on top of this workspace boundary.
 *
 * 默认工作区语义（空配置时）：以「调用方上下文的目录」为准——工具由 agent 调起时
 * 传 `agent.session.header.cwd`（目录委派时的工作目录），回落 `process.cwd()`。
 * 显式配置白名单后仍是精确匹配，只在列表内的目录可用。
 */
export class WorkspacePolicy {
  private readonly configured: readonly string[];
  private explicitAllowedPromise: Promise<readonly string[]> | undefined;

  constructor(allowedWorkspaces: readonly string[] = []) {
    this.configured = [...allowedWorkspaces];
  }

  /** 是否显式配置了工作区白名单。空配置时工作区跟随委派目录动态解析，无单一权威目录。 */
  hasExplicitWorkspaces(): boolean {
    return this.configured.length > 0;
  }

  /**
   * Resolve an optional request to one of the configured workspaces.
   * Missing input means the caller's context directory (`defaultCwd`),
   * which itself falls back to `process.cwd()`.
   */
  async resolveWorkspace(input?: string, defaultCwd?: string): Promise<string> {
    const fallback = defaultCwd ?? process.cwd();
    const requested = await canonicalDirectory(input ?? fallback);
    const allowed = await this.allowedFor(fallback);
    const match = allowed.find((candidate) => samePath(candidate, requested));
    if (match) return match;
    const allowedList = allowed.map((item) => `  - ${item}`).join("\n");
    throw invalidWorkspace(
      input ?? fallback,
      "工作区未获授权：只能访问允许列表中的目录。\n" +
        `当前允许的工作区：\n${allowedList}\n` +
        "如需新增授权：在 dsh profile 的 cordis.patch.yml 中给 cbx-orch 配 config.workspaces（core 工具），" +
        "或给 cbx-orch-web 配 config.web.workspaces（Web 选择），重启后生效。",
    );
  }

  /** Return a frozen copy so callers cannot mutate the policy state. */
  async listAllowedWorkspaces(defaultCwd?: string): Promise<ReadonlyArray<string>> {
    if (this.configured.length > 0) {
      return Object.freeze([...(await this.explicitAllowed())]);
    }
    // 空配置：随调用方上下文目录动态解析（无上下文时回落 process.cwd()）。
    return Object.freeze([await canonicalDirectory(defaultCwd ?? process.cwd())]);
  }

  /** 允许列表：显式配置时缓存；空配置时随调用方上下文目录动态计算（不缓存）。 */
  private allowedFor(fallback: string): Promise<readonly string[]> {
    if (this.configured.length > 0) return this.explicitAllowed();
    return canonicalizeAllowed([fallback]);
  }

  private explicitAllowed(): Promise<readonly string[]> {
    if (!this.explicitAllowedPromise) {
      this.explicitAllowedPromise = canonicalizeAllowed(this.configured);
    }
    return this.explicitAllowedPromise;
  }
}

async function canonicalizeAllowed(
  values: readonly string[],
): Promise<readonly string[]> {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !value.trim())
      throw invalidWorkspace(String(value), "允许工作区必须是非空目录路径。");
    const canonical = await canonicalDirectory(value);
    const key = comparisonKey(canonical);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(canonical);
  }
  return Object.freeze(result);
}

async function canonicalDirectory(input: string): Promise<string> {
  const resolved = path.resolve(input);
  let canonical: string;
  try {
    canonical = path.normalize(await realpath(resolved));
    const information = await stat(canonical);
    if (!information.isDirectory()) throw new Error("不是目录");
  } catch {
    throw invalidWorkspace(input, "工作区不存在或不是目录：" + resolved);
  }
  return canonical;
}

function comparisonKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
  return comparisonKey(left) === comparisonKey(right);
}

function invalidWorkspace(input: string, message: string): CbxError {
  return new CbxError("E_INVALID_WORKSPACE", message + "：" + input);
}
