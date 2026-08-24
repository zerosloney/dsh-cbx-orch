import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export interface ExecutorRequest {
  directory: string;
  workdir: string;
  prompt: string;
  timeoutMs: number;
  maxTurns: number;
  permissionMode: string;
  /** 执行器名（内置注册名或插件路径），让插件实现自识别 */
  executor: string;
  plugin?: { policy?: PluginPolicy; sha256?: string };
}

export interface ExecutorResult {
  code: number;
  timedOut?: boolean;
  output?: string;
}

export const EXECUTOR_PLUGIN_API_VERSION = "cbx.executor/v1";
export interface ExecutorPluginManifest {
  apiVersion: typeof EXECUTOR_PLUGIN_API_VERSION;
  name: string;
  version: string;
  capabilities: string[];
}

export interface PluginPolicy {
  enforce?: boolean;
  allowPaths?: string[];
  allowSha256?: string[];
  /**
   * 调用方提供的"enforce 未显式设置时的缺省值"。这是 runner 侧安全默认的载体：
   * `.cbx.json` 未配置 plugins.enforce 时，runner 传 `defaultEnforce: true` 让插件
   * 路径默认走白名单校验（fail-closed），而不是"默认告警放行"。显式配置的
   * `enforce` 始终优先。legacy 插件宿主（plugin-host 直接调 loadExecutorPlugin）
   * 不传此字段时保持旧行为（enforce 缺省 = 不强制），因此该默认只对编排器主进程生效。
   */
  defaultEnforce?: boolean;
}export interface PluginIdentity extends ExecutorPluginManifest {
  source: "plugin";
  path: string;
  sha256: string;
}

export interface ExecutorPlugin {
  name?: string;
  manifest?: ExecutorPluginManifest;
  run(request: ExecutorRequest): Promise<ExecutorResult> | ExecutorResult;
}

async function verifyExecutorPluginSource(
  spec: string,
  workspace: string,
  policy: PluginPolicy,
): Promise<{ file: string; sha256: string }> {
  const file = path.resolve(workspace, spec);
  const resolvedWorkspace = path.resolve(workspace);
  // 默认策略下也阻止路径穿越：解析符号链接后比较，防止 workspace 内软链指向外部文件。
  const realFile = await realpath(file);
  const realWorkspace = await realpath(resolvedWorkspace);
  const relative = path.relative(realWorkspace, realFile);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    realFile === realWorkspace
  )
    throw new Error(`插件路径必须位于工作区内：${file}`);
  const source = await readFile(file);
  const sha256 = createHash("sha256").update(source).digest("hex");
  const allowPaths = (policy.allowPaths ?? []).map((allowed) =>
    path.resolve(workspace, allowed),
  );
  const allowSha256 = (policy.allowSha256 ?? []).map((allowed) =>
    allowed.toLowerCase(),
  );
  // enforce 未显式配置时按调用方提供的 defaultEnforce 生效（runner 默认 true）。
  // 显式 enforce 始终优先；两侧都未提供时保持旧行为（不强制）。
  const enforce = policy.enforce ?? policy.defaultEnforce ?? false;
  if (enforce) {
    if (!allowPaths.length && !allowSha256.length)
      throw new Error(
        "plugins.enforce=true 时必须配置 allowPaths 或 allowSha256。",
      );
    if (allowPaths.length && !allowPaths.includes(file))
      throw new Error(`插件路径未获批准：${file}`);
    if (allowSha256.length && !allowSha256.includes(sha256))
      throw new Error(`插件 SHA-256 未获批准：${file}`);
  }
  return { file, sha256 };
}

function validateManifest(
  value: unknown,
  file: string,
  enforce: boolean,
): ExecutorPluginManifest {
  if (!value && !enforce)
    return {
      apiVersion: EXECUTOR_PLUGIN_API_VERSION,
      name: path.basename(file),
      version: "legacy",
      capabilities: ["execute"],
    };
  if (!value || typeof value !== "object")
    throw new Error(`executor 插件缺少 manifest：${file}`);
  const manifest = value as Partial<ExecutorPluginManifest>;
  if (
    manifest.apiVersion !== EXECUTOR_PLUGIN_API_VERSION ||
    typeof manifest.name !== "string" ||
    !manifest.name ||
    typeof manifest.version !== "string" ||
    !manifest.version ||
    !Array.isArray(manifest.capabilities) ||
    manifest.capabilities.some(
      (capability) => typeof capability !== "string" || !capability,
    )
  )
    throw new Error(`executor 插件 manifest 无效：${file}`);
  return {
    apiVersion: manifest.apiVersion,
    name: manifest.name,
    version: manifest.version,
    capabilities: [...manifest.capabilities],
  };
}

export async function inspectExecutorPlugin(
  spec: string,
  workspace: string,
  policy: PluginPolicy = {},
): Promise<PluginIdentity> {
  const { file, sha256 } = await verifyExecutorPluginSource(
    spec,
    workspace,
    policy,
  );
  // 边界说明：此 import 发生在编排器主进程，插件顶层代码（含顶层 throw/副作用）
  // 会在主进程执行——插件路径已强制位于工作区内且 enforce 默认 fail-closed
  // （白名单），通过校验的插件是 operator 显式信任的代码，与 dsh 自身在主进程
  // 加载的插件同构。真正的**崩溃隔离**由 plugin-host 子进程承担（运行期二次加载
  // + run）；这里 try/catch 兜住顶层 throw，避免插件损坏时打挂整个 harness 进程
  // （调用方会收到可诊断的错误而非未处理异常）。
  let module: {
    default?: ExecutorPlugin;
    run?: ExecutorPlugin["run"];
    manifest?: ExecutorPluginManifest;
  };
  try {
    module = (await import(pathToFileURL(file).href)) as typeof module;
  } catch (error) {
    throw new Error(
      `executor 插件加载失败（顶层代码抛错）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const plugin =
    module.default ??
    (module.run
      ? {
          name: path.basename(file),
          run: module.run,
          manifest: (module as { manifest?: ExecutorPluginManifest }).manifest,
        }
      : undefined);
  if (!plugin || typeof plugin.run !== "function")
    throw new Error(`executor 插件没有导出 run(request)：${file}`);
  const manifest = validateManifest(
    plugin.manifest ?? (module as { manifest?: unknown }).manifest,
    file,
    Boolean(policy.enforce),
  );
  return { source: "plugin", path: file, sha256, ...manifest };
}

export async function loadExecutorPlugin(
  spec: string,
  workspace: string,
  policy: PluginPolicy = {},
  expectedSha256?: string,
): Promise<ExecutorPlugin> {
  const { file, sha256 } = await verifyExecutorPluginSource(
    spec,
    workspace,
    policy,
  );
  if (expectedSha256 && sha256 !== expectedSha256)
    throw new Error(`executor 插件内容在启动前发生变化：${file}`);
  const module = (await import(pathToFileURL(file).href)) as {
    default?: ExecutorPlugin;
    run?: ExecutorPlugin["run"];
    manifest?: ExecutorPluginManifest;
  };
  const plugin =
    module.default ??
    (module.run ? { name: path.basename(file), run: module.run } : undefined);
  if (!plugin || typeof plugin.run !== "function")
    throw new Error(`executor 插件没有导出 run(request)：${file}`);
  validateManifest(
    plugin.manifest ?? module.manifest,
    file,
    Boolean(policy.enforce),
  );
  return plugin;
}
