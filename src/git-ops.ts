import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { atomicWriteFile, loadJson, now, saveJson } from "./storage.js";
import { captureAsync } from "./process-runner.js";
import { syncEnvForChild } from "./subprocess-adapter.js";

const CODE_PATHS = [".", ":(exclude).cbx", ":(exclude).cbx/**"];

/** 全异步 git 调用：不再用 spawnSync 阻塞事件循环（长阻塞会让心跳陈旧、
 *  调度器误判僵尸、SSE 抖动）。captureAsync 的输出是 stdout+stderr 合并。 */
export async function gitRoot(workspace: string): Promise<string | undefined> {
  const result = await captureAsync(["git", "rev-parse", "--show-toplevel"], workspace);
  return result.code === 0 && result.stdout.trim() ? path.resolve(result.stdout.trim()) : undefined;
}

/**
 * isolated 任务要求工作区位于 Git 仓库：创建/准备时统一校验，抛出带修复途径的
 * 错误（git init 或 isolated: false），避免任务带病入队后崩溃熔断才暴露根因。
 */
export async function requireGitRoot(workspace: string): Promise<string> {
  const root = await gitRoot(workspace);
  if (!root)
    throw new Error(
      `isolated=true 要求工作区位于 Git 仓库中：${workspace}。` +
        `请先在该目录初始化 Git（git init）或改用已有仓库；` +
        `或将 isolated 设为 false（任务将直接在主工作区执行）。`,
    );
  return root;
}

export interface GitBaseline { root: string; commit?: string; branch?: string; dirty: boolean; status: string; }

export async function snapshotGitBaseline(workspace: string): Promise<GitBaseline | undefined> {
  const root = await gitRoot(workspace);
  if (!root) return undefined;
  const commit = await captureAsync(["git", "rev-parse", "HEAD"], root);
  const branch = await captureAsync(["git", "branch", "--show-current"], root);
  const status = await captureAsync(["git", "status", "--porcelain", "--untracked-files=all", "--", ...CODE_PATHS], root);
  // git status 失败（仓库损坏/权限/并发操作）不能静默当作"干净仓库"：fail-safe 为
  // dirty，并把合并输出并入 status 文本，让基线漂移检测与任务流程显式看到异常，
  // 而非漏判未提交/未跟踪改动。
  const statusOk = status.code === 0;
  return {
    root,
    commit: commit.code === 0 ? commit.stdout.trim() : undefined,
    branch: branch.code === 0 && branch.stdout.trim() ? branch.stdout.trim() : undefined,
    dirty: !statusOk || Boolean(status.stdout.trim()),
    status: statusOk ? status.stdout : status.stdout,
  };
}

export async function gitDirtyFingerprint(workspace: string): Promise<string | undefined> {
  const root = await gitRoot(workspace);
  if (!root) return undefined;
  const status = await captureAsync(["git", "status", "--porcelain", "--untracked-files=all", "--", ...CODE_PATHS], root);
  const tracked = await trackedDiff(root);
  const paths = (await captureAsync(["git", "ls-files", "--others", "--exclude-standard", "-z", "--", ...CODE_PATHS], root)).stdout.split("\0").filter(Boolean).sort();
  const hash = createHash("sha256").update(status.stdout).update("\0").update(tracked);
  if (paths.length > 0) {
    // 批量 hash：单进程 --stdin-paths 一次 hash 全部未跟踪文件，替代逐文件 spawn
    // （大仓库 O(n) 子进程启动慢，可拖到数十秒）。需要 stdin，保留同步 spawn。
    const batched = spawnSync(
      "git",
      ["hash-object", "--stdin-paths", "--no-filters"],
      {
        cwd: root,
        input: paths.join("\n") + "\n",
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        // 同步 spawn 无法走 provider 白名单，这里显式复用同一套 env 裁剪。
        env: syncEnvForChild(root),
      },
    );
    const blobs = (batched.stdout ?? "").split("\n").filter(Boolean);
    for (let i = 0; i < paths.length; i++) {
      // 输出与输入路径一一对应；数量不匹配（个别文件并发消失）时对该文件回退单进程。
      const relative = paths[i];
      const blob =
        i < blobs.length
          ? blobs[i]
          : (
              await captureAsync(
                ["git", "hash-object", "--no-filters", "--", relative],
                root,
              )
            ).stdout.trim();
      hash.update("\0").update(relative).update("\0").update(blob);
    }
  }
  return hash.digest("hex");
}

/**
 * v2 脏指纹：仅 git status + 已跟踪文件 diff，不含未跟踪文件内容。v1 把未跟踪
 * 内容也纳入哈希——工作区里随手放一个 scratch 文件、或别的任务在同一工作区留下
 * 产物，都会让非隔离任务误判"脏漂移"而 blocked。未跟踪内容由快照/diff 流程单独
 * 审计，不参与漂移判定。旧 job（context 无 dirtyFingerprintVersion）仍按 v1 比对，
 * 显式 refreshBaseline 时升级到 v2。
 */
export async function gitDirtyFingerprintTracked(workspace: string): Promise<string | undefined> {
  const root = await gitRoot(workspace);
  if (!root) return undefined;
  const status = await captureAsync(["git", "status", "--porcelain", "--untracked-files=no", "--", ...CODE_PATHS], root);
  const tracked = await trackedDiff(root);
  return createHash("sha256").update(status.stdout).update("\0").update(tracked).digest("hex");
}

export async function prepareWorktree(workspace: string, directory: string, jobId: string, isolated: boolean, autoBranch = false, baseCommit = "HEAD", carryDirty = false): Promise<string> {
  if (!isolated) return workspace;
  const root = await requireGitRoot(workspace);
  const target = path.join(path.dirname(root), `.${path.basename(root)}.cbx-worktrees`, jobId);
  await mkdir(path.dirname(target), { recursive: true });
  const branch = `cbx/${jobId}`;
  const branchExists = (await captureAsync(["git", "show-ref", "--verify", `refs/heads/${branch}`], root)).code === 0;
  const args = autoBranch && branchExists ? ["git", "worktree", "add", target, branch] : autoBranch ? ["git", "worktree", "add", "-b", branch, target, baseCommit] : ["git", "worktree", "add", "--detach", target, baseCommit];
  let result = await captureAsync(args, root);
  if (result.code !== 0) {
    // 自愈：上次运行在 worktree add 与 worktree.json 落盘之间崩溃会留下孤儿目录，
    // 使本 job 每次重跑都撞同一个"目录已存在"错误。prune 清掉陈旧元数据后强制
    // 移除目标目录再重试一次；仍失败才抛错（此时是真正的 git 故障）。
    await captureAsync(["git", "worktree", "prune"], root);
    if (existsSync(target)) {
      await captureAsync(["git", "worktree", "remove", "--force", target], root);
      if (existsSync(target))
        await rm(target, { recursive: true, force: true }).catch(() => undefined);
    }
    result = await captureAsync(args, root);
    if (result.code !== 0) throw new Error(`创建 Git worktree 失败：\n${result.stdout.trim()}`);
  }
  // carryDirty：把主工作区创建时的未提交改动（已跟踪 diff + 未跟踪文件）带进隔离
  // worktree，让隔离任务也能对"进行中的工作"安全执行，而不必先提交/清理主工作区、
  // 也不会污染主工作区（执行器只改 worktree）。
  if (carryDirty) {
    await carryDirtyIntoWorktree(workspace, target, directory);
  }
  await saveJson(path.join(directory, "worktree.json"), { path: target, branch: autoBranch ? branch : undefined, baseCommit, carryDirty, createdAt: now() });
  return target;
}

/** 复制主工作区未提交/未跟踪改动进隔离 worktree。 */
async function carryDirtyIntoWorktree(workspace: string, workdir: string, directory: string): Promise<void> {
  const root = await gitRoot(workspace);
  if (!root) return;
  let patchFile: string | undefined;
  // 1) 已跟踪改动（staged+unstaged）：git diff --binary HEAD → git apply 到 worktree。
  const diff = await captureAsync(["git", "diff", "--binary", "HEAD", "--", ...CODE_PATHS], root);
  if (diff.code === 0 && diff.stdout.trim()) {
    patchFile = path.join(directory, "context.carry.patch");
    await writeFile(patchFile, diff.stdout, "utf8");
    const apply = await captureAsync(
      ["git", "apply", "--whitespace=nowarn", "--binary", patchFile],
      workdir,
    );
    if (apply.code !== 0)
      throw new Error(
        `把未提交改动应用到隔离 worktree 失败（task 基线 = HEAD + 当前脏改动）：\n${apply.stdout.trim()}`,
      );
  }
  // 2) 未跟踪文件：复制进 worktree（跳过 .git / node_modules / 符号链接 / 超大文件）。
  const listed = await captureAsync(
    ["git", "ls-files", "--others", "--exclude-standard", "-z", "--", ...CODE_PATHS],
    root,
  );
  const paths = listed.stdout.split("\0").filter(Boolean);
  const rootPrefix = path.resolve(root) + path.sep;
  const workdirPrefix = path.resolve(workdir) + path.sep;
  for (const relative of paths) {
    if (relative.split(/[\\/]/).some((seg) => seg === "node_modules" || seg === ".git"))
      continue;
    if (await resolvesThroughSymlink(root, relative)) continue;
    const srcFile = path.resolve(root, relative);
    const dstFile = path.resolve(workdir, relative);
    if (!srcFile.startsWith(rootPrefix) || !dstFile.startsWith(workdirPrefix)) continue;
    try {
      const info = await stat(srcFile);
      if (!info.isFile()) continue;
      if (info.size > 4_000_000) continue; // 超大记录/倒数产物不携带
      await mkdir(path.dirname(dstFile), { recursive: true });
      await writeFile(dstFile, await readFile(srcFile));
    } catch {
      /* 并发消失/不可读：跳过该文件，不阻断任务 */
    }
  }
  if (patchFile !== undefined) {
    await rm(patchFile, { force: true }).catch(() => undefined);
  }
}

export async function cleanupRecordedWorktree(workspace: string, directory: string): Promise<boolean> {
  const file = path.join(directory, "worktree.json");
  if (!existsSync(file)) return false;
  const record = await loadJson<{ path: string }>(file);
  const target = path.resolve(record.path);
  const root = await gitRoot(workspace);
  const expectedParent = root ? path.resolve(path.dirname(root), `.${path.basename(root)}.cbx-worktrees`) : "";
  if (!root || path.dirname(target) !== expectedParent) throw new Error("拒绝清理不属于本编排器的 worktree 路径。");
  // Windows 瞬态句柄重试：被终止的子进程可能仍持有 worktree 目录句柄（cwd 未释放），
  // 首次 remove 会 "failed to delete"——退避重试 3 次覆盖该窗口，减少 cleanup_failed 噪音。
  let result = await captureAsync(["git", "worktree", "remove", "--force", target], root);
  for (let attempt = 0; result.code !== 0 && existsSync(target) && attempt < 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    result = await captureAsync(["git", "worktree", "remove", "--force", target], root);
  }
  if (result.code !== 0 && existsSync(target)) throw new Error(`清理 worktree 失败：\n${result.stdout.trim()}`);
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

async function trackedDiff(workdir: string): Promise<string> {
  const againstHead = await captureAsync(["git", "diff", "--binary", "HEAD", "--", ...CODE_PATHS], workdir);
  if (againstHead.code === 0) return againstHead.stdout;
  // Unborn repositories do not have HEAD yet.
  const staged = await captureAsync(["git", "diff", "--binary", "--cached", "--", ...CODE_PATHS], workdir);
  const unstaged = await captureAsync(["git", "diff", "--binary", "--", ...CODE_PATHS], workdir);
  return staged.stdout + unstaged.stdout + (staged.code || unstaged.code ? staged.stdout + unstaged.stdout : "");
}

/** 相对路径是否"穿过"符号链接/junction：任一祖先目录或文件本身是链接即真。
 *  POSIX 上 git 把 symlink 当条目列出（lstat 即可判）；Windows 的 junction 被
 *  git 当真实目录遍历、列出的是链接内部文件——只有沿祖先逐级 lstat 才能发现。 */
async function resolvesThroughSymlink(rootDir: string, relative: string): Promise<boolean> {
  const parts = relative.split(/[\\/]/).filter(Boolean);
  let current = rootDir;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function untrackedSections(workdir: string, paths: string[]): Promise<{ listing: string; patches: string }> {
  const listing: string[] = [];
  const patches: string[] = [];
  const root = path.resolve(workdir) + path.sep;
  for (const relative of paths) {
    const file = path.resolve(workdir, relative);
    if (!file.startsWith(root)) continue;
    try {
      // 符号链接/junction 不跟随：readFile/stat 会解析到链接目标，把工作区之外
      // 的文件内容（可能非常大，或属于其他项目/系统路径）吸进 complete.patch/
      // 审计材料。按链接本身记录即可满足 diff 审阅。
      if (await resolvesThroughSymlink(workdir, relative)) {
        listing.push(`## ${relative}\n[符号链接，未跟随]\n`);
        patches.push(`diff --git a/${relative} b/${relative}\n[符号链接，未跟随]\n`);
        continue;
      }
      const info = await lstat(file);
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
  const statusResult = await captureAsync(["git", "status", "--short", "--untracked-files=all", "--", ...CODE_PATHS], workdir);
  const tracked = await trackedDiff(workdir);
  const pathsResult = await captureAsync(["git", "ls-files", "--others", "--exclude-standard", "-z", "--", ...CODE_PATHS], workdir);
  const paths = pathsResult.stdout.split("\0").filter(Boolean).sort();
  const untracked = await untrackedSections(workdir, paths);
  return {
    status: statusResult.stdout + (statusResult.code === 0 ? "" : statusResult.stdout),
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

export async function commitWorktree(workdir: string, message: string): Promise<string | undefined> {
  const status = await captureAsync(["git", "status", "--porcelain", "--", ...CODE_PATHS], workdir);
  if (status.code !== 0) throw new Error(`读取 Git 状态失败：${status.stdout.trim()}`);
  if (!status.stdout.trim()) return undefined;
  const add = await captureAsync(["git", "add", "-A", "--", ...CODE_PATHS], workdir);
  if (add.code !== 0) throw new Error(`git add 失败：${add.stdout.trim()}`);
  const commit = await captureAsync(["git", "commit", "-m", message], workdir);
  if (commit.code !== 0) throw new Error(`git commit 失败：${commit.stdout.trim()}`);
  const hash = await captureAsync(["git", "rev-parse", "HEAD"], workdir);
  if (hash.code !== 0) throw new Error(`读取提交哈希失败：${hash.stdout.trim()}`);
  return hash.stdout.trim();
}
