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
 */
export class WorkspacePolicy {
  private readonly configured: readonly string[];
  private allowedPromise: Promise<readonly string[]> | undefined;

  constructor(allowedWorkspaces: readonly string[] = []) {
    this.configured = [...allowedWorkspaces];
  }

  /**
   * Resolve an optional request to one of the configured workspaces.
   * Missing input means the invoking directory, matching existing defaults.
   */
  async resolveWorkspace(input?: string): Promise<string> {
    const requested = await canonicalDirectory(input ?? process.cwd());
    const allowed = await this.canonicalAllowed();
    const match = allowed.find((candidate) => samePath(candidate, requested));
    if (match) return match;
    throw invalidWorkspace(
      input ?? process.cwd(),
      "工作区未获授权：只能访问允许列表中的目录。",
    );
  }

  /** Return a frozen copy so callers cannot mutate the policy state. */
  async listAllowedWorkspaces(): Promise<ReadonlyArray<string>> {
    return Object.freeze([...(await this.canonicalAllowed())]);
  }

  private canonicalAllowed(): Promise<readonly string[]> {
    if (!this.allowedPromise) {
      const values = this.configured.length > 0
        ? this.configured
        : [process.cwd()];
      this.allowedPromise = canonicalizeAllowed(values);
    }
    return this.allowedPromise;
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
