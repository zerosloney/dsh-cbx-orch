/**
 * storage/io —— 文件系统 IO 基础层：原子写、JSON 读写、进程存活探测。
 *
 * 从原 storage.ts 抽出（纯文件操作，无内部依赖）。原子写默认 fsync（审计/锁/
 * 产物语义）；镜像类文件可传 { fsync: false }（有权威源，进程崩溃后可重建）。
 */
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export function now(): string {
  return new Date().toISOString();
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function replaceFile(source: string, target: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (
        !new Set(["EACCES", "EPERM", "EBUSY"]).has(String(code)) ||
        attempt === 4
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  throw lastError;
}

/**
 * 原子写文件：临时文件 + fsync + rename。默认 fsync（写入边界保证系统级崩溃后
 * 内容仍可恢复——审计/锁文件/产物依赖此语义）。
 *
 * 镜像类文件（state.json 的 SQLite 镜像、context.json 等）可传 `{ fsync: false }`：
 * 它们有权威源（SQLite/其他主文件），进程崩溃后可从权威源重建，不需要承担每次
 * 同步 fsync 的写放大。rename 的原子性仍保留（读方永远不会看到半截文件）。
 */
export async function atomicWriteFile(
  file: string,
  contents: string,
  options: { fsync?: boolean } = {},
): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    if (options.fsync !== false) await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await replaceFile(temporary, file);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

export async function saveJson(
  file: string,
  value: unknown,
  options: { fsync?: boolean } = {},
): Promise<void> {
  await atomicWriteFile(file, JSON.stringify(value, null, 2) + "\n", options);
}

/** A fallback is used only when the file does not exist. Corrupt JSON always remains visible to callers. */
export async function loadJson<T>(file: string, fallback?: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if (fallback !== undefined && isMissing(error)) return fallback;
    throw error;
  }
}

export function processAlive(pid?: number): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export { isMissing };
