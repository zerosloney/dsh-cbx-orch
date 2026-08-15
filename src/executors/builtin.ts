import { spawnSync } from "node:child_process";

// 内置执行器适配层：把 codebuddy / opencode / omp / cline / qwen 等编码 CLI 收敛到统一的调用契约。
// 每个 adapter 描述：发现二进制的方式 + 如何把 (prompt, permissionMode, maxTurns) 翻译成 CLI 参数。

export interface BuildArgsOptions {
  prompt: string;
  permissionMode: string;
  maxTurns: number;
}

export interface BuiltinExecutor {
  /** 注册名，写入 .cbx.json 的 executor 字段或 --executor */
  name: "codebuddy" | "opencode" | "omp" | "cline" | "qwen";
  /** 别名，resolveExecutor 同样命中（oh-my-pi 指向 omp，非独立二进制） */
  aliases: string[];
  /** 显示名，注入到提示词与用户可见的错误消息中 */
  label: string;
  /** 覆盖二进制路径的环境变量，与 bin 名一一对应 */
  envVar: string;
  /** PATH 上依次尝试的二进制名 */
  candidates: string[];
  /** 把统一入参翻译成该 CLI 的具体参数序列（不含二进制本身） */
  buildArgs(opts: BuildArgsOptions): string[];
}

// permissionMode 中表示「自动放行」的语义值：opencode 用 --auto、cline 用 --auto-approve true 表达。
const AUTO_MODES = new Set(["auto", "dontAsk"]);

export const BUILTIN_EXECUTORS: readonly BuiltinExecutor[] = [
  {
    name: "codebuddy",
    aliases: ["cbc"],
    label: "CodeBuddy",
    envVar: "CBX_CODEBUDDY",
    candidates: ["codebuddy", "cbc"],
    buildArgs: ({ prompt, permissionMode, maxTurns }) => [
      "-p",
      "--output-format", "stream-json",
      "--max-turns", String(maxTurns),
      "--permission-mode", permissionMode,
      prompt,
    ],
  },
  {
    name: "opencode",
    aliases: [],
    label: "OpenCode",
    envVar: "CBX_OPENCODE",
    candidates: ["opencode"],
    buildArgs: ({ prompt, permissionMode }) => {
      const args = ["run", "--format", "json", prompt];
      if (AUTO_MODES.has(permissionMode)) args.push("--auto");
      return args;
    },
  },
  {
    name: "omp",
    aliases: ["oh-my-pi"], // oh-my-pi 是 omp 的扩展框架，仍由 omp 二进制执行
    label: "Oh My Pi",
    envVar: "CBX_OMP",
    candidates: ["omp"],
    // omp 官方 CLI 文档未公开 permission/auto flag；非交互 -p 默认按 omp 自身权限行事。
    // intentional-simple: 不追加 auto flag，缺已知天花板——待 omp 暴露权限 flag 后补 `-a` 类参数。
    buildArgs: ({ prompt }) => ["-p", "--mode", "json", prompt],
  },
  {
    name: "cline",
    aliases: [],
    label: "Cline",
    envVar: "CBX_CLINE",
    candidates: ["cline"],
    buildArgs: ({ prompt, permissionMode }) => {
      const args = ["--json", prompt, "--auto-approve", String(AUTO_MODES.has(permissionMode))];
      if (permissionMode === "plan") args.push("--plan");
      return args;
    },
  },
  {
    name: "qwen",
    aliases: [],
    label: "Qwen Code",
    envVar: "CBX_QWEN",
    candidates: ["qwen"],
    // qwen 非交互模式（--prompt）按官方 headless 文档映射（https://qwenlm.github.io/qwen-code-docs/zh/users/features/headless/）：
    // - maxTurns → --max-session-turns（交互轮数预算）
    // - plan → --approval-mode plan；auto/dontAsk → --yolo（auto-approve all）
    // 不传 --sandbox：cbx 需执行器在 worktree 内自由读写，沙箱会阻碍任务执行。
    // 无人值守场景建议在宿主环境设 QWEN_CODE_UNATTENDED_RETRY=1（子进程经 runProcess 继承 process.env）。
    buildArgs: ({ prompt, permissionMode, maxTurns }) => {
      const args = ["--prompt", prompt, "--output-format", "stream-json", "--max-session-turns", String(maxTurns)];
      if (permissionMode === "plan") args.push("--approval-mode", "plan");
      else if (AUTO_MODES.has(permissionMode)) args.push("--yolo");
      return args;
    },
  },
];

const BY_NAME: ReadonlyMap<string, BuiltinExecutor> = (() => {
  const map = new Map<string, BuiltinExecutor>();
  for (const spec of BUILTIN_EXECUTORS) {
    map.set(spec.name, spec);
    for (const alias of spec.aliases) map.set(alias, spec);
  }
  return map;
})();

/** 按注册名或别名解析内置执行器；未命中返回 undefined（调用方再当插件路径处理）。 */
export function resolveExecutor(name: string): BuiltinExecutor | undefined {
  return BY_NAME.get(name);
}

// intentional-simple: 进程级缓存，只对单进程内重复调用生效。环境变量/安装变更需重启进程。
const resolvedPathCache = new Map<string, string>();

/**
 * 返回 [command, ...rest] 形式的可执行命令：
 * - 优先采用 envVar 指定的覆盖路径；
 * - Windows 上用 PowerShell Get-Command 解析 bin 名的真实来源（结果缓存，避免每次 spawn 同步阻塞事件循环）；
 * - 兜底直接把候选名交给 spawn；
 * - .ps1/.js/.mjs/.cjs 会被包装成 powershell/node 调用。
 */
export function findExecutable(spec: BuiltinExecutor): string[] {
  const configured = process.env[spec.envVar];
  const candidates: string[] = [];
  if (configured) candidates.push(configured);
  if (process.platform === "win32") {
    const primary = spec.candidates[0];
    let resolved = resolvedPathCache.get(primary);
    if (resolved === undefined) {
      const ps = spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Command ${primary}).Source`], { encoding: "utf8", windowsHide: true });
      resolved = ps.status === 0 ? String(ps.stdout).trim() : "";
      resolvedPathCache.set(primary, resolved);
    }
    if (resolved) candidates.push(resolved);
  }
  candidates.push(...spec.candidates);
  for (const candidate of candidates) {
    if (!candidate) continue;
    const lower = candidate.toLowerCase();
    if (lower.endsWith(".ps1")) return ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", candidate];
    if (lower.endsWith(".mjs") || lower.endsWith(".cjs") || lower.endsWith(".js")) return [process.execPath, candidate];
    return [candidate];
  }
  throw new Error(`找不到 ${spec.label} (${spec.candidates.join("/")})。请安装 ${spec.label}，或设置 ${spec.envVar}。`);
}
