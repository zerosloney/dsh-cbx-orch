import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { listPersistedStates, redactText, jobEventsAfterCursor, verifyJobAudit, type RuntimeConfig } from "./storage.js";
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

/** 列出持久化任务状态（按 updated_at 倒序）。`limit`/`offset` 分页可选：
 *  缺省返回全量（保持向后兼容）；分页用于大工作区避免每次全表扫描。 */
export async function listJobs(
  workspaceInput: string,
  options: { limit?: number; offset?: number } = {},
): Promise<JobState[]> {
  const workspace = path.resolve(workspaceInput);
  return listPersistedStates<JobState>(workspace, options);
}

/** 终态集合：审计完整性富化只对终态 job 做（非终态无审计结果）。 */
const TERMINAL_FOR_AUDIT: ReadonlySet<string> = new Set([
  "done",
  "failed",
  "review_failed",
  "cancelled",
]);

/**
 * 列出任务并富化审计完整性（`__audit` 字段）：仅对终态且 SQLite 有镜像锚点的 job
 * 执行 verifyJobAudit（每 job 一次 SQLite 查询 + 一次 ndjson 读）。非终态/旧任务
 * （无镜像）不附 `__audit`。供 cbx_list 工具与 Web 仪表盘共用。
 */
export async function listJobsWithAudit(
  workspaceInput: string,
  options: { limit?: number; offset?: number } = {},
): Promise<JobState[]> {
  const workspace = path.resolve(workspaceInput);
  const jobs = await listPersistedStates<JobState>(workspace, options);
  return Promise.all(
    jobs.map(async (job) => {
      if (!TERMINAL_FOR_AUDIT.has(String(job.status ?? ""))) return job;
      try {
        const audit = await verifyJobAudit(workspace, job.jobId);
        if (audit.sqliteCount && audit.sqliteCount > 0) {
          return { ...job, __audit: audit };
        }
      } catch {
        /* 验证失败跳过 */
      }
      return job;
    }),
  );
}

/**
 * 扫描根目录下含 .cbx/ 的直接子目录（1 层深度，不递归），返回绝对路径列表。
 * 复用：CLI `cbx ws --workspaces-dir`、CLI `ui` 命令都走这一个入口，避免各入口各自实现"发现 workspace"。
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
  // 优先 SQLite events 表（审计权威，执行器不可写）：按 job_id 过滤 + seq 游标增量读。
  // 镜像缺失（旧任务）时回退 events.ndjson 行级扫描。返回行以 JSON 字符串呈现，
  // 与 ndjson 行形态一致（调用方无需区分来源）。
  //
  // 游标语义：jobEventsAfterCursor 用 `seq > cursor`，因此 next_offset 必须等于
  // "已读的最后一条 seq"（而非 +1）——job 事件在 workspace 全局 seq 中是稀疏的
  // （混有其它 job / 工作区事件），lastSeq+1 与 lastSeq 之间若恰好有本 job 事件
  // （seq == lastSeq+1），`seq > lastSeq+1` 会漏掉它。
  const workspace = path.resolve(workspaceInput);
  try {
    const result = await jobEventsAfterCursor(workspace, jobId, since, 1000);
    const lines = result.rows.map((row) => JSON.stringify(row.payload));
    if (lines.length === 0) {
      // 该 job 在 SQLite 中是否从未镜像过（旧任务 v6 前创建）：是则回退 ndjson
      // 行游标（支持增量续读）；SQLite 有历史但 since 之后无新增 = 正常空。
      const probe = await jobEventsAfterCursor(workspace, jobId, 0, 1);
      if (probe.rows.length === 0) {
        const ndjson = await readNdjsonEventsIncremental(workspaceInput, jobId, since);
        if (ndjson.events.length > 0 || since > 0) return ndjson;
      }
    }
    const nextOffset = result.rows.at(-1)?.seq ?? since;
    return { events: lines, next_offset: nextOffset };
  } catch {
    // fallback：ndjson（镜像查询异常）
    const ndjson = await readNdjsonEventsIncremental(workspaceInput, jobId, since);
    return { events: ndjson.events, next_offset: ndjson.next_offset };
  }
}

/** 读取 job 的 events.ndjson（行游标增量）：`since` 为上次的行偏移。文件缺失返回空。 */
async function readNdjsonEventsIncremental(
  workspaceInput: string,
  jobId: string,
  since: number,
): Promise<{ events: string[]; next_offset: number }> {
  let raw: string;
  try {
    raw = await readArtifact(workspaceInput, jobId, "events.ndjson");
  } catch {
    return { events: [], next_offset: since };
  }
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
