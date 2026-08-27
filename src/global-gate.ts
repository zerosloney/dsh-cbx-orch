/**
 * global-gate —— 进程级全局治理：跨工作区并发闸 + 全局执行器调用预算。
 *
 * 背景：`maxConcurrent` 与 `cost.maxExecutorInvocations` 都是"每工作区 / 每任务"
 * 粒度的——多个工作区并行（dsh 单进程内多个常驻调度器）时，总并发与总 API 消耗
 * 没有上限。本模块提供**进程级**（per dsh host process）的两道闸：
 *
 * 1. 全局并发（`withSpawnSlot`）：以 job-runtime 注册表（runningJobs.size）为权威
 *    计数，spawn 前在进程级互斥内完成"检查 + spawn"。`registerRunningJob` 在
 *    startInProcessJob 返回前同步完成，注册即生效、无需释放钩子；取消/回收/完成
 *    全部经 `unregisterRunningJob` 自动收缩。互斥保证两个工作区的派发循环不会
 *    交错检查后同时越界 spawn。
 * 2. 全局预算（`tryConsumeInvocation`）：在 runner.invokeExecutorCore 的既有成本闸
 *    检查点同步消费（JS 单线程使 check + bump 原子）。超限抛 GlobalCostLimitError
 *    （extends ExecutorCostLimitError → 既有调用方自动按 cost_limit + human gate
 *    处理，无需改动）。轻微超跑语义与既有 per-job 闸一致：计数失败不阻塞调用。
 *
 * 已知边界：全局闸是**进程内**语义——同机两个 dsh 进程各有各的闸，互不相见。
 * 跨进程治理需要共享存储（如全局 SQLite/租约文件），留作未来工作。
 *
 * 配置入口：插件 config / settings 的 `governance.{maxGlobalConcurrent,
 * maxGlobalInvocations}`，经 `setGlobalLimits` 运行时替换（即时生效）。刻意不放
 * 入 `.cbx.json`：工作区配置对"进程级策略"没有权威性，放进去还会扩大策略指纹
 * （securityPolicyFingerprint）的比对范围。
 */

import { countRunningJobs } from "./job-runtime.js";

export interface GlobalLimits {
  /** 进程级并发上限：所有工作区同时 running 的 in-process 任务总数上限。缺省 = 不限制。 */
  maxGlobalConcurrent?: number;
  /** 进程级执行器调用预算：所有工作区累计调用（stage/review/manager/gate 全角色）硬上限。缺省 = 不限制。 */
  maxGlobalInvocations?: number;
}

interface GlobalGateState extends GlobalLimits {
  /** 全局累计已消费调用数（进程内单调递增；重启归零，与 eventMirrorFailures 同例）。 */
  invocationsUsed: number;
}

let gate: GlobalGateState = {
  maxGlobalConcurrent: undefined,
  maxGlobalInvocations: undefined,
  invocationsUsed: 0,
};

/** 进程级互斥链：withSpawnSlot 借它串行化"检查 + spawn"，跨工作区原子。 */
let chain: Promise<unknown> = Promise.resolve();

/** 校验并整体替换上限（非负整数 ≥1，非法值拒绝）。*每次调用替换两个值*——调用方
 *  需传入完整生效值（settings ?? config）；累积计数不受影响（单调递增）。 */
export function setGlobalLimits(limits: GlobalLimits): void {
  for (const key of ["maxGlobalConcurrent", "maxGlobalInvocations"] as const) {
    const value = limits[key];
    if (
      value !== undefined &&
      (!Number.isInteger(value) || value < 1)
    ) {
      throw new Error(
        key === "maxGlobalConcurrent"
          ? "governance.maxGlobalConcurrent 必须是正整数（≥1）。"
          : "governance.maxGlobalInvocations 必须是正整数（≥1）。",
      );
    }
  }
  gate = {
    maxGlobalConcurrent: limits.maxGlobalConcurrent,
    maxGlobalInvocations: limits.maxGlobalInvocations,
    invocationsUsed: gate.invocationsUsed,
  };
}

/**
 * 在全局并发闸内执行一次 spawn：持有进程级互斥，检查 runningJobs 计数未达
 * `maxConcurrent` 上限才调用 `spawn`，否则返回 null 且不调用。互斥持有期覆盖
 * spawn 的完整回落（同步注册或异步完成后才释放）——两个工作区的派发循环不会
 * 交错检查后同时越界 spawn，也不会"释放过早、注册迟到"。
 */
export async function withSpawnSlot<T>(spawn: () => T): Promise<T | null> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = chain;
  // 双分支接续：previous 无论成败都 resolve 到 held，链本身永不 reject
  // （后到者 await previous.catch 只等持有者收尾，不被其异常连带）。
  chain = previous.then(() => held, () => held);
  await previous.catch(() => undefined);
  try {
    if (
      gate.maxGlobalConcurrent !== undefined &&
      countRunningJobs() >= gate.maxGlobalConcurrent
    ) {
      return null;
    }
    const result = spawn() as T | Promise<T>;
    return await result;
  } finally {
    release();
  }
}

export interface GlobalInvocationResult {
  allowed: boolean;
  /** 预算上限（仅 allowed=false 时有值）。 */
  limit?: number;
  /** 消费后的全局累计计数（未配置预算时 = 当前计数）。 */
  used: number;
}

/** 同步原子消费一次全局预算（单线程下 check + bump 原子）。允许时总是递增累计
 *  计数（未配置预算也计数——stats 的 used 反映真实消耗）；配置预算时到顶拒绝。 */
export function tryConsumeInvocation(): GlobalInvocationResult {
  const used = gate.invocationsUsed;
  if (
    gate.maxGlobalInvocations !== undefined &&
    used >= gate.maxGlobalInvocations
  ) {
    return { allowed: false, limit: gate.maxGlobalInvocations, used };
  }
  gate.invocationsUsed = used + 1;
  return { allowed: true, used: used + 1 };
}

export interface GlobalStats {
  maxGlobalConcurrent?: number;
  active: number;
  maxGlobalInvocations?: number;
  used: number;
}

/** 只读快照（health/metrics 展示）。 */
export function globalStats(): GlobalStats {
  return {
    maxGlobalConcurrent: gate.maxGlobalConcurrent,
    active: countRunningJobs(),
    maxGlobalInvocations: gate.maxGlobalInvocations,
    used: gate.invocationsUsed,
  };
}

/** 重置全部状态（插件卸载 / 测试隔离）。 */
export function resetGlobalGate(): void {
  gate = {
    maxGlobalConcurrent: undefined,
    maxGlobalInvocations: undefined,
    invocationsUsed: 0,
  };
}