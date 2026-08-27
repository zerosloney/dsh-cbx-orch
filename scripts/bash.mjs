#!/usr/bin/env node
// 跨平台 bash 解析器：让 npm scripts（release / smoke:e2e / smoke:pack）在 Windows
// 上无需把 Git for Windows 的 bin 加入 PATH 也能直接跑。
// 解析顺序：PATH 上的 bash（Linux/macOS 天然命中）→ Git for Windows 常见安装位置。
// 用法：node scripts/bash.mjs <script> [args...]
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error("usage: node scripts/bash.mjs <script> [args...]");
  process.exit(2);
}

const candidates = [];
// 1. PATH 上的 bash（Linux / macOS / 已配置 PATH 的 Windows）
for (const dir of (process.env.PATH ?? "").split(delimiter)) {
  if (!dir) continue;
  candidates.push(join(dir, "bash"), join(dir, "bash.exe"));
}
// 2. Git for Windows 常见安装位置（PATH 没配时的兜底）
for (const base of [
  process.env.ProgramFiles && join(process.env.ProgramFiles, "Git"),
  process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Git"),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Git"),
]) {
  if (!base) continue;
  candidates.push(join(base, "bin", "bash.exe"), join(base, "usr", "bin", "bash.exe"));
}

const bash = candidates.find((p) => existsSync(p));
if (!bash) {
  console.error(
    "error: 未找到 bash——请把 bash 加入 PATH，或安装 Git for Windows（C:\\Program Files\\Git）后重试",
  );
  process.exit(1);
}

// 直连 exe（不经 shell），cwd 沿用 npm 的仓库根目录
const result = spawnSync(bash, ["--noprofile", "--norc", script, ...args], {
  stdio: "inherit",
  shell: false,
});
process.exit(result.status ?? 1);
