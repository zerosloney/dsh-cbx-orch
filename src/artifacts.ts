import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { listPersistedStates, redactText, type RuntimeConfig } from "./storage.js";
import { jobDir } from "./state.js";
import { CbxError } from "./errors.js";
import type { JobState, JobContext } from "./types.js";
import type { ContextArtifact } from "./context-pack.js";

export const ARTIFACTS = new Set(["request.md", "context-snapshot.md", "context-contract.json", "understanding.json", "context.json", "state.json", "events.ndjson", "agent.log", "handback.md", "review.md", "audit.json", "verified-progress.json", "manager-context.json", "executor-context.json", "auditor-context.json", "test.log", "git-status.txt", "diff.patch", "complete.patch", "untracked-files.txt", "result.json"]);
export const AUDIT_CANDIDATE = "audit-candidate.json";

export function contextArtifacts(directory: string, names: readonly ContextArtifact[]): ContextArtifact[] {
  return names.filter(name => existsSync(path.join(directory, name)));
}

export function contextRedactor(governance?: RuntimeConfig["governance"]): (text: string) => string {
  return text => redactText(text, governance?.redactFields, governance?.redactPatterns);
}

export async function listJobs(workspaceInput: string): Promise<JobState[]> {
  const workspace = path.resolve(workspaceInput);
  return listPersistedStates<JobState>(workspace);
}

/**
 * 扫描根目录下含 .cbx/ 的直接子目录（1 层深度，不递归），返回绝对路径列表。
 * 复用：CLI `cbx ws --workspaces-dir`、CLI `ui` 命令、MCP `cbx_list_workspaces`
 * 都走这一个入口，避免各入口各自实现"发现 workspace"。
 */
export async function discoverWorkspaces(
  root: string,
): Promise<string[]> {
  const resolvedRoot = path.resolve(root);
  let names: string[];
  try {
    names = await readdir(resolvedRoot);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const candidate = path.join(resolvedRoot, name);
    let dirStat;
    try {
      dirStat = await stat(candidate);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;
    try {
      const cbxStat = await stat(path.join(candidate, ".cbx"));
      if (!cbxStat.isDirectory()) continue;
    } catch {
      continue;
    }
    out.push(candidate);
  }
  return out;
}

export function listJobsAcrossWorkspaces(
  root: string,
): Promise<Array<{ workspace: string; jobs: JobState[] }>> {
  return discoverWorkspaces(root).then((workspaces) =>
    Promise.all(
      workspaces.map(async (workspace) => ({
        workspace,
        jobs: await listJobs(workspace),
      })),
    ),
  );
}

/** 按 path.resolve 后的字符串去重，保留首次出现顺序。 */
export function dedupWorkspaces(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const resolved = path.resolve(p);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

export async function readArtifact(workspaceInput: string, jobId: string, artifact: string): Promise<string> {
  // 与 listArtifacts 的动态发现保持一致：stage 交接副本 stage-<index>-<name>-handback.md 可读，
  // 但仍按白名单正则校验，防止路径穿越。
  if (!ARTIFACTS.has(artifact) && !/^stage-\d+-[A-Za-z0-9._-]+-handback\.md$/.test(artifact)) throw new CbxError("E_ARTIFACT_FORBIDDEN", `不允许读取任务文件：${artifact}`);
  return readFile(path.join(jobDir(path.resolve(workspaceInput), jobId), artifact), "utf8");
}

export async function readEventsIncremental(workspaceInput: string, jobId: string, since = 0): Promise<{ events: string[]; next_offset: number }> {
  // intentional-simple: 行级游标 + 逐行 JSON.parse 校验。events.ndjson 单 job 最多几百行，O(n) 扫描无压力。
  // worker 用 appendFileSync 追加；并发写入时最后一条可能截断，parse 失败则停在此处，下次调用补齐。
  const raw = await readArtifact(workspaceInput, jobId, "events.ndjson");
  const lines = raw.split("\n");
  const events: string[] = [];
  let offset = since;
  for (let i = since; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try { JSON.parse(line); } catch { break; }
    events.push(line);
    offset = i + 1;
  }
  return { events, next_offset: offset };
}

export async function listArtifacts(workspaceInput: string, jobId: string): Promise<string[]> {
  const directory = jobDir(path.resolve(workspaceInput), jobId);
  const files: string[] = [];
  for (const file of ARTIFACTS) if (existsSync(path.join(directory, file))) files.push(file);
  // Stage-specific handback copies follow a dynamic pattern; discover them at listing time.
  try {
    const entries = await readdir(directory);
    for (const entry of entries) if (entry.startsWith("stage-") && entry.endsWith("-handback.md")) files.push(entry);
  } catch { /* job directory may not exist yet */ }
  return files;
}
