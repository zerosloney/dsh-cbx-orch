import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type { CbxDefaults } from "./tools.js";
import { setExecutorEnvAllowlist } from "./subprocess-adapter.js";
import { setGlobalLimits } from "./global-gate.js";

/**
 * ctx.settings 集成（最小面）：把 cbx 的插件级默认配置（executor/review/isolated/
 * carryDirty/executors.envAllowlist）暴露为 harness 用户设置 namespace `cbx`，
 * 让用户在 harness 的设置界面统一管理，而不是只能改 profile 的 cordis.patch.yml。
 *
 * 优先级（settings 是"插件默认"的运行时替代层）：
 *   工具参数 > 工作区 .cbx.json > **settings** > 插件 config（profile 配置）
 *
 * 实现要点：
 * - **动态 import**：`@deepseek-ai/dsh-settings` 是 optional peerDependency——包
 *   不存在（宿主没装 settings 服务）时 import 失败即跳过，插件照常工作，零行为变化。
 * - **`installSettingsSection`**（dsh-settings 官方可选集成入口）：settings 服务
 *   存在时用插件 composition entry 作 base 层注册 namespace；服务缺失/卸载时自动
 *   回落 composition entry——插件在两种形态下都可用。
 * - **onChange 即时生效**：settings 变更时更新传入的 `defaults` 对象字段（工具在
 *   调用时读 defaults.*，改字段即时生效）与执行器环境白名单。
 * - **范围刻意最小**：不覆盖 workspaces（安全白名单保持 profile 配置，不暴露给
 *   运行时设置面）。
 */

/** settings 覆盖的最小形状（与 CbxOrchestrator.Config 的可覆盖字段对齐）。 */
export interface CbxSettingsSection {
  executor?: string;
  review?: boolean;
  isolated?: boolean;
  carryDirty?: boolean;
  executors?: { envAllowlist?: string[] };
  governance?: { maxGlobalConcurrent?: number; maxGlobalInvocations?: number };
}

/** 插件 composition config 的可覆盖字段子集（installCbxSettings 的 base 层）。 */
export interface CbxSettingsConfig {
  executor?: string;
  review?: boolean;
  isolated?: boolean;
  carryDirty?: boolean;
  executors?: { envAllowlist?: string[] };
  governance?: { maxGlobalConcurrent?: number; maxGlobalInvocations?: number };
}

/**
 * 把 settings section 合并进 defaults（纯函数，供单测）：
 * settings 覆盖插件 config（base 已融合进 section，这里只做类型收窄），
 * 未配字段回落 config。返回是否更新了 envAllowlist（供调用方管理 disposer）。
 */
export function applySettingsSection(
  defaults: CbxDefaults,
  config: CbxSettingsConfig,
  section: CbxSettingsSection | undefined,
): boolean {
  const s = section ?? {};
  // settings 覆盖 config，config 未配时保留 defaults 现值（三值链：s ?? config ?? 现值）。
  defaults.executor = s.executor ?? config.executor ?? defaults.executor;
  defaults.review = s.review ?? config.review ?? defaults.review;
  defaults.isolated = s.isolated ?? config.isolated ?? defaults.isolated;
  defaults.carryDirty = s.carryDirty ?? config.carryDirty ?? defaults.carryDirty;
  const allowlist = s.executors?.envAllowlist;
  if (allowlist !== undefined) return true;
  return config.executors?.envAllowlist !== undefined;
}

/**
 * 接入 ctx.settings。settings 服务不可用（宿主无 dsh-settings 包/服务、headless
 * profile）时静默跳过——返回的 disposer 是 no-op，插件按纯 profile 配置运行。
 *
 * @param ctx 插件 context。
 * @param defaults 插件默认源（可变对象，settings 变更时更新其字段）。
 * @param config 插件 composition config（settings 的 base 层）。
 */
export async function installCbxSettings(
  ctx: Context,
  defaults: CbxDefaults,
  config: CbxSettingsConfig,
): Promise<() => void> {
  let settingsModule: typeof import("@deepseek-ai/dsh-settings") | undefined;
  try {
    settingsModule = await import("@deepseek-ai/dsh-settings");
  } catch {
    // 宿主未安装 dsh-settings：跳过集成，插件按 profile 配置运行。
    return () => undefined;
  }
  const { installSettingsSection, settingsNamespace } = settingsModule;
  if (typeof installSettingsSection !== "function") return () => undefined;
  // installSettingsSection 依赖 cordis 的 ctx.inject（按需注入 settings 服务）。
  // 缺 inject 的宿主（测试 fake ctx / 非 cordis 环境）无法安全调用——跳过集成。
  if (typeof (ctx as { inject?: unknown }).inject !== "function")
    return () => undefined;

  // schemastery object 的字段天然可选（未配字段在解析 output 中被省略，不是
  // undefined 值）——用户没配的字段自动继承 base（插件 config），无需 .optional()。
  const schema = z.object({
    executor: z.string(),
    review: z.boolean(),
    isolated: z.boolean(),
    carryDirty: z.boolean(),
    executors: z.object({
      envAllowlist: z.array(z.string()),
    }),
    governance: z.object({
      // min(1) 表意，整数性由 setGlobalLimits 运行时校验兜底（拒绝时保持上一份有效配置）。
      maxGlobalConcurrent: z.number().min(1),
      maxGlobalInvocations: z.number().min(1),
    }),
  });

  /** 当前权威配置源 thunk（installSettingsSection 在 attach/detach 时设置）。 */
  let currentSource: (() => CbxSettingsSection) | undefined;
  /** 最近一次 envAllowlist disposer：dispose 时还原（与插件级 setExecutorEnvAllowlist 协调）。 */
  let latestEnvDisposer: (() => void) | undefined;

  const apply = (section: CbxSettingsSection | undefined): void => {
    // 进程级全局治理：字段级合并（settings 覆盖 config 的同名字段，未配字段回落
    // config / 缺省无限），换值即 setGlobalLimits 替换、即时生效；非法值在
    // setGlobalLimits 内抛错，由 onChange 的 catch 兜底——保持上一份有效配置。
    const governance = {
      ...(config.governance ?? {}),
      ...((section ?? {}).governance ?? {}),
    };
    setGlobalLimits(governance);
    if (!applySettingsSection(defaults, config, section)) return;
    // envAllowlist 被 settings 或 config 配置：重新应用（先还原上一次的 disposer）。
    const s = section ?? {};
    const allowlist = s.executors?.envAllowlist;
    latestEnvDisposer?.();
    latestEnvDisposer = setExecutorEnvAllowlist(
      allowlist !== undefined
        ? allowlist.length > 0
          ? allowlist
          : undefined
        : config.executors?.envAllowlist?.length
          ? config.executors.envAllowlist
          : undefined,
    );
  };

  installSettingsSection(
    ctx,
    settingsNamespace("cbx"),
    schema,
    // base 层：插件 composition entry（config 的可覆盖字段）。
    {
      executor: config.executor,
      review: config.review,
      isolated: config.isolated,
      carryDirty: config.carryDirty,
      executors: config.executors,
      governance: config.governance,
    } satisfies CbxSettingsSection,
    {
      setSource: (current) => {
        currentSource = current;
      },
      onChange: () => {
        try {
          apply(currentSource?.() ?? {});
        } catch {
          /* 覆盖失败不影响主流程：保持上一份有效配置 */
        }
      },
    },
  );
  // 初始应用（attach 时 installSettingsSection 已调 onChange，这里幂等兜底）。
  return () => {
    currentSource = undefined;
    // 还原为插件 composition config 的治理配置（settings 层已摘除）。
    setGlobalLimits(config.governance ?? {});
    latestEnvDisposer?.();
    latestEnvDisposer = undefined;
  };
}
