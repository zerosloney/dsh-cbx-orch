import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rmdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { atomicWriteFile, loadJson, now, saveJson } from "./storage.js";
import { capture } from "./process-runner.js";

const CODE_PATHS = [".", ":(exclude).cbx", ":(exclude).cbx/**"];

export function gitRoot(workspace: string): string | undefined {
  const result = capture(["git", "rev-parse", "--show-toplevel"], workspace);
  return result.code === 0 && result.stdout.trim() ? path.resolve(result.stdout.trim()) : undefined;
}

export interface GitBaseline { root: string; commit?: string; branch?: string; dirty: boolean; status: string; }

export function snapshotGitBaseline(workspace: string): GitBaseline | undefined {
  const root = gitRoot(workspace);
  if (!root) return undefined;
  const commit = capture(["git", "rev-parse", "HEAD"], root);
  const branch = capture(["git", "branch", "--show-current"], root);
  const status = capture(["git", "status", "--porcelain", "--untracked-files=all", "--", ...CODE_PATHS], root);
  return {
    root,
    commit: commit.code === 0 ? commit.stdout.trim() : undefined,
    branch: branch.code === 0 && branch.stdout.trim() ? branch.stdout.trim() : undefined,
    dirty: Boolean(status.stdout.trim()),
    status: status.stdout,
  };
}

export function gitDirtyFingerprint(workspace: string): string | undefined {
  const root = gitRoot(workspace);
  if (!root) return undefined;
  const status = capture(["git", "status", "--porcelain", "--untracked-files=all", "--", ...CODE_PATHS], root);
  const tracked = trackedDiff(root);
  const paths = capture(["git", "ls-files", "--others", "--exclude-standard", "-z", "--", ...CODE_PATHS], root).stdout.split("\0").filter(Boolean).sort();
  const hash = createHash("sha256").update(status.stdout).update("\0").update(tracked);
  for (const relative of paths) {
    const blob = capture(["git", "hash-object", "--no-filters", "--", relative], root);
    hash.update("\0").update(relative).update("\0").update(blob.code === 0 ? blob.stdout.trim() : `ERROR:${blob.stderr.trim()}`);
  }
  return hash.digest("hex");
}

export async function prepareWorktree(workspace: string, directory: string, jobId: string, isolated: boolean, autoBranch = false, baseCommit = "HEAD"): Promise<string> {
  if (!isolated) return workspace;
  const root = gitRoot(workspace);
  if (!root) throw new Error("--isolated 要求工作区位于 Git 仓库中。");
  const target = path.join(path.dirname(root), `.${path.basename(root)}.cbx-worktrees`, jobId);
  await mkdir(path.dirname(target), { recursive: true });
  const branch = `cbx/${jobId}`;
  const branchExists = capture(["git", "show-ref", "--verify", `refs/heads/${branch}`], root).code === 0;
  const args = autoBranch && branchExists ? ["git", "worktree", "add", target, branch] : autoBranch ? ["git", "worktree", "add", "-b", branch, target, baseCommit] : ["git", "worktree", "add", "--detach", target, baseCommit];
  const result = capture(args, root);
  if (result.code !== 0) throw new Error(`创建 Git worktree 失败：\n${result.stderr.trim()}`);
  await saveJson(path.join(directory, "worktree.json"), { path: target, branch: autoBranch ? branch : undefined, baseCommit, createdAt: now() });
  return target;
}

export async function cleanupRecordedWorktree(workspace: string, directory: string): Promise<boolean> {
  const file = path.join(directory, "worktree.json");
  if (!existsSync(file)) return false;
  const record = await loadJson<{ path: string }>(file);
  const target = path.resolve(record.path);
  const root = gitRoot(workspace);
  const expectedParent = root ? path.resolve(path.dirname(root), `.${path.basename(root)}.cbx-worktrees`) : "";
  if (!root || path.dirname(target) !== expectedParent) throw new Error("拒绝清理不属于本编排器的 worktree 路径。");
  const result = capture(["git", "worktree", "remove", "--force", target], root);
  if (result.code !== 0 && existsSync(target)) throw new Error(`清理 worktree 失败：\n${result.stderr.trim()}`);
  // 容器目录 .<repo>.cbx-worktrees/ 跨 job 复用；删完 job 子目录后若已空，一并清理避免孤儿。
  // 并发安全：readdir 非空（其他 job 在用）则跳过；rmdir 仅删空目录，不会误伤。
  if (expectedParent && existsSync(expectedParent)) {
    try {
      const remaining = await readdir(expectedParent);
      if (remaining.length === 0) await rmdir(expectedParent);
    } catch { /* 容器清理是 best-effort，失败不影响 job 终态 */ }
  }
  await saveJson(path.join(directory, "worktree-cleaned.json"), { path: target, cleanedAt: now() });
  return true;
}

function trackedDiff(workdir: string): string {
  const againstHead = capture(["git", "diff", "--binary", "HEAD", "--", ...CODE_PATHS], workdir);
  if (againstHead.code === 0) return againstHead.stdout;
  // Unborn repositories do not have HEAD yet.
  const staged = capture(["git", "diff", "--binary", "--cached", "--", ...CODE_PATHS], workdir);
  const unstaged = capture(["git", "diff", "--binary", "--", ...CODE_PATHS], workdir);
  return staged.stdout + unstaged.stdout + (staged.code || unstaged.code ? staged.stderr + unstaged.stderr : "");
}

async function untrackedSections(workdir: string, paths: string[]): Promise<{ listing: string; patches: string }> {
  const listing: string[] = [];
  const patches: string[] = [];
  const root = path.resolve(workdir) + path.sep;
  for (const relative of paths) {
    const file = path.resolve(workdir, relative);
    if (!file.startsWith(root)) continue;
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      if (info.size > 200_000) {
        listing.push(`## ${relative}\n[跳过超过 200KB 的文件]\n`);
        patches.push(`diff --git a/${relative} b/${relative}\nnew file mode 100644\n--- /dev/null\n+++ b/${relative}\n[文件超过 200KB，内容见 worktree]\n`);
        continue;
      }
      const content = await readFile(file, "utf8");
      listing.push(`## ${relative}\n\n${content}\n`);
      const sourceLines = content.split(/\r?\n/);
      const lines = sourceLines.map(line => `+${line}`).join("\n");
      patches.push(`diff --git a/${relative} b/${relative}\nnew file mode 100644\n--- /dev/null\n+++ b/${relative}\n@@ -0,0 +1,${sourceLines.length} @@\n${lines}\n`);
    } catch {
      listing.push(`## ${relative}\n[二进制或不可读取文件]\n`);
      patches.push(`diff --git a/${relative} b/${relative}\nnew file mode 100644\n[二进制或不可读取文件]\n`);
    }
  }
  return { listing: listing.join("\n"), patches: patches.join("\n") };
}

export interface DiffSnapshot { status: string; tracked: string; untracked: string; complete: string; }

export async function snapshotDiff(workdir: string): Promise<DiffSnapshot> {
  const statusResult = capture(["git", "status", "--short", "--untracked-files=all", "--", ...CODE_PATHS], workdir);
  const tracked = trackedDiff(workdir);
  const pathsResult = capture(["git", "ls-files", "--others", "--exclude-standard", "-z", "--", ...CODE_PATHS], workdir);
  const paths = pathsResult.stdout.split("\0").filter(Boolean).sort();
  const untracked = await untrackedSections(workdir, paths);
  return {
    status: statusResult.stdout + (statusResult.code === 0 ? "" : statusResult.stderr),
    tracked,
    untracked: untracked.listing,
    complete: [tracked, untracked.patches].filter(Boolean).join("\n"),
  };
}

export async function collectDiff(directory: string, workdir: string): Promise<DiffSnapshot> {
  const snapshot = await snapshotDiff(workdir);
  await Promise.all([
    atomicWriteFile(path.join(directory, "git-status.txt"), snapshot.status),
    atomicWriteFile(path.join(directory, "diff.patch"), snapshot.tracked),
    atomicWriteFile(path.join(directory, "untracked-files.txt"), snapshot.untracked),
    atomicWriteFile(path.join(directory, "complete.patch"), snapshot.complete),
  ]);
  return snapshot;
}

export function commitWorktree(workdir: string, message: string): string | undefined {
  const status = capture(["git", "status", "--porcelain", "--", ...CODE_PATHS], workdir);
  if (status.code !== 0) throw new Error(`读取 Git 状态失败：${status.stderr.trim()}`);
  if (!status.stdout.trim()) return undefined;
  const add = capture(["git", "add", "-A", "--", ...CODE_PATHS], workdir);
  if (add.code !== 0) throw new Error(`git add 失败：${add.stderr.trim()}`);
  const commit = capture(["git", "commit", "-m", message], workdir);
  if (commit.code !== 0) throw new Error(`git commit 失败：${commit.stderr.trim()}`);
  const hash = capture(["git", "rev-parse", "HEAD"], workdir);
  if (hash.code !== 0) throw new Error(`读取提交哈希失败：${hash.stderr.trim()}`);
  return hash.stdout.trim();
}
