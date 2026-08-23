import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BUILTIN_EXECUTORS,
  probeAllExecutors,
} from "../lib/executors/builtin.js";
import {
  routeExecutor,
  deriveRequirements,
  meetsRequirements,
  resolveInvokableExecutor,
  DEFAULT_EXECUTOR_PREFERENCE,
} from "../lib/executor-router.js";
import {
  recordExecutorOutcome,
  loadHealth,
  resetHealthStore,
} from "../lib/executor-health.js";

// 构造一个 probe 快照：name 在 installed 集合中则视为可用。
function probeFor(installed) {
  return BUILTIN_EXECUTORS.map((spec) => ({
    name: spec.name,
    label: spec.label,
    available: installed.has(spec.name),
    source: installed.has(spec.name) ? "path" : "none",
    command: installed.has(spec.name) ? `/usr/bin/${spec.name}` : undefined,
  }));
}
const probe = (installed) => probeFor(new Set(installed));

test("deriveRequirements: permissionMode/plan 推导需求", () => {
  assert.deepEqual(deriveRequirements({ permissionMode: "auto" }), { autoApprove: true });
  assert.deepEqual(deriveRequirements({ permissionMode: "dontAsk" }), { autoApprove: true });
  assert.deepEqual(deriveRequirements({ permissionMode: "plan" }), { planMode: true });
  assert.deepEqual(deriveRequirements({ plan: true }), { planMode: true });
  assert.deepEqual(deriveRequirements({}), {});
});

test("meetsRequirements: 能力不匹配即过滤", () => {
  const omp = BUILTIN_EXECUTORS.find((s) => s.name === "omp");
  const qwen = BUILTIN_EXECUTORS.find((s) => s.name === "qwen");
  assert.equal(meetsRequirements(omp, { autoApprove: true }), false); // omp 无 autoApprove
  assert.equal(meetsRequirements(omp, {}), true);
  assert.equal(meetsRequirements(qwen, { autoApprove: true, planMode: true }), true);
  assert.equal(meetsRequirements(qwen, { exclude: ["qwen"] }), false);
});

test("routeExecutor: autoApprove 需求排除 omp，落到 opencode", () => {
  const d = routeExecutor(undefined, {
    probes: probe(["omp", "opencode", "qwen"]),
    requirements: { autoApprove: true },
  });
  assert.equal(d.executor, "opencode");
  assert.equal(d.routed, true);
});

test("routeExecutor: 需求无人满足 → executor=undefined", () => {
  const d = routeExecutor(undefined, {
    probes: probe(["omp"]),
    requirements: { autoApprove: true },
  });
  assert.equal(d.executor, undefined);
  assert.match(d.reason, /无满足需求/);
});

test("routeExecutor: 显式指定不满足需求仍按原指定使用（routed=false，原因告警）", () => {
  const d = routeExecutor("omp", {
    probes: probe(["omp"]),
    requirements: { autoApprove: true },
  });
  assert.equal(d.executor, "omp");
  assert.equal(d.routed, false);
  assert.match(d.reason, /不满足需求/);
});

test("routeExecutor: capability-best 选能力最多的 qwen", () => {
  const d = routeExecutor(undefined, {
    probes: probe(["omp", "opencode", "qwen", "cline"]),
    strategy: "capability-best",
  });
  assert.equal(d.executor, "qwen");
});

test("routeExecutor: cost-aware 选成本最低的 omp", () => {
  const d = routeExecutor(undefined, {
    probes: probe(["omp", "opencode", "qwen", "cline"]),
    strategy: "cost-aware",
  });
  assert.equal(d.executor, "omp");
});

test("routeExecutor: fastest 选速度最高的 qwen", () => {
  const d = routeExecutor(undefined, {
    probes: probe(["omp", "opencode", "qwen", "cline"]),
    strategy: "fastest",
  });
  assert.equal(d.executor, "qwen");
});

test("routeExecutor: least-recently-used 选最久未用的 qwen", () => {
  const now = Date.now();
  const health = {
    opencode: { successes: 1, failures: 0, consecutiveFailures: 0, lastUsedAt: new Date(now - 1_000).toISOString() },
    qwen: { successes: 1, failures: 0, consecutiveFailures: 0, lastUsedAt: new Date(now - 600_000).toISOString() },
  };
  const d = routeExecutor(undefined, {
    probes: probe(["opencode", "qwen"]),
    strategy: "least-recently-used",
    health,
    now,
  });
  assert.equal(d.executor, "qwen");
});

test("routeExecutor: 健康度降权——连续失败的执行器在 capability-best 下被跳过", () => {
  const health = { qwen: { successes: 0, failures: 3, consecutiveFailures: 3 } };
  const d = routeExecutor(undefined, {
    probes: probe(["opencode", "qwen"]),
    strategy: "capability-best",
    health,
  });
  // qwen 能力多但连续失败 3 次重罚，opencode 胜出。
  assert.equal(d.executor, "opencode");
});

test("routeExecutor: requirements.exclude 排除指定执行器", () => {
  const d = routeExecutor(undefined, {
    probes: probe(["opencode", "qwen"]),
    requirements: { exclude: ["opencode"] },
  });
  assert.equal(d.executor, "qwen");
});

test("routeExecutor: 默认策略下偏好顺序仍主导（omp 在偏好尾部但可用时仍可按显式/preference 选）", () => {
  // preference 把 omp 提到最前，无需求时 first-available 选 omp。
  const d = routeExecutor(undefined, {
    probes: probe(["omp", "opencode"]),
    preference: ["omp", "opencode"],
  });
  assert.equal(d.executor, "omp");
});

test("routeExecutor: 健康度持久存在于进程内快照（probeAllExecutors 不依赖健康）", () => {
  // 仅确认 probeAllExecutors 仍可调用，返回 5 个已知执行器。
  const probes = probeAllExecutors();
  assert.equal(probes.length, DEFAULT_EXECUTOR_PREFERENCE.length);
});

// ---------------------------------------------------------------------------
// 失败语义细分：连续超时与连续崩溃的降权档位不同
// （capability-best 下 qwen 比 opencode 多 2 个能力，基础分领先 14：
//  1 次崩溃 -15 翻盘；1 次超时 -9 保住席位——编码两档罚分的定性差异）
// ---------------------------------------------------------------------------

test("routeExecutor: 连续崩溃重罚翻盘（capability-best 下输给能力更弱者）", () => {
  const health = {
    qwen: { successes: 0, failures: 1, consecutiveFailures: 1 },
  };
  const d = routeExecutor(undefined, {
    probes: probe(["opencode", "qwen"]),
    strategy: "capability-best",
    health,
  });
  assert.equal(d.executor, "opencode");
});

test("routeExecutor: 同样连败次数但为超时时降权更轻（保住能力优势席位）", () => {
  const health = {
    qwen: {
      successes: 0,
      failures: 1,
      consecutiveFailures: 1,
      timeouts: 1,
      consecutiveTimeouts: 1,
      lastFailureKind: "timeout",
    },
  };
  const d = routeExecutor(undefined, {
    probes: probe(["opencode", "qwen"]),
    strategy: "capability-best",
    health,
  });
  assert.equal(d.executor, "qwen");
});

// ---------------------------------------------------------------------------
// resolveInvokableExecutor：执行期单次解析（stage / review / manager 调用前用）
// ---------------------------------------------------------------------------

test("resolveInvokableExecutor: 插件路径原样放行不路由", () => {
  const r = resolveInvokableExecutor("/plugins/my-agent.mjs", { probes: probe([]) });
  assert.equal(r.name, "/plugins/my-agent.mjs");
  assert.equal(r.routed, false);
  assert.equal(r.reason, undefined);
});

test("resolveInvokableExecutor: 已安装直用，别名归一为注册名", () => {
  const r = resolveInvokableExecutor("cbc", { probes: probe(["codebuddy"]) });
  assert.equal(r.name, "codebuddy");
  assert.equal(r.routed, false);
});

test("resolveInvokableExecutor: 未安装回退到满足需求的可用者并给出原因", () => {
  const r = resolveInvokableExecutor("codebuddy", {
    probes: probe(["omp", "opencode"]),
    requirements: { autoApprove: true },
  });
  assert.equal(r.name, "opencode"); // omp 不满足 autoApprove，被需求过滤掉
  assert.equal(r.routed, true);
  assert.match(r.reason, /回退/);
});

test("resolveInvokableExecutor: 无任何可用者时抛错并附可用列表与需求", () => {
  assert.throws(
    () =>
      resolveInvokableExecutor("qwen", {
        probes: probe([]),
        requirements: { autoApprove: true },
      }),
    (error) => /不可用/.test(error.message) && /autoApprove=true/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// 档位目录（executor-catalog）：实测校准值参与 fastest 打分，出处进决策
// ---------------------------------------------------------------------------

test("routeExecutor: fastest 在无目录时按声明档位选 opencode（与 cline 同速，偏好在前）", () => {
  const d = routeExecutor(undefined, {
    probes: probe(["opencode", "cline"]),
    strategy: "fastest",
  });
  assert.equal(d.executor, "opencode"); // 声明速度同为 2，偏好序决定
  assert.equal(d.tierSources, undefined); // 未提供目录不附加出处表
  assert.doesNotMatch(d.reason, /档位出处/);
});

test("routeExecutor: 实测校准让更快的 cline 翻盘，出处进 reason 与 tierSources", () => {
  // cline 实测平均 20s（4 样本），opencode 平均 80s（4 样本）→ cline=3, opencode=1。
  const health = {
    cline: { successes: 4, failures: 0, consecutiveFailures: 0, latencySamples: 4, totalLatencyMs: 80_000 },
    opencode: { successes: 4, failures: 0, consecutiveFailures: 0, latencySamples: 4, totalLatencyMs: 320_000 },
  };
  const catalog = {
    cline: { costTier: 3, speedTier: 3, costSource: "declared", speedSource: "measured", samples: 4, avgLatencyMs: 20_000 },
    opencode: { costTier: 2, speedTier: 1, costSource: "declared", speedSource: "measured", samples: 4, avgLatencyMs: 80_000 },
  };
  const d = routeExecutor(undefined, {
    probes: probe(["opencode", "cline"]),
    strategy: "fastest",
    health,
    tierCatalog: catalog,
  });
  assert.equal(d.executor, "cline");
  assert.equal(d.tierSources.cline.speed, "measured");
  assert.equal(d.tierSources.opencode.speed, "measured");
  assert.match(d.reason, /档位出处/);
  assert.match(d.reason, /实测/);
});

test("routeExecutor: 非 tier 驱动策略提供目录也不在 reason 里标注出处", () => {
  const catalog = {
    qwen: { costTier: 2, speedTier: 3, costSource: "declared", speedSource: "declared", samples: 0 },
  };
  const d = routeExecutor(undefined, {
    probes: probe(["qwen"]),
    strategy: "first-available",
    tierCatalog: catalog,
  });
  assert.equal(d.executor, "qwen");
  assert.doesNotMatch(d.reason, /档位出处/);
  assert.equal(d.tierSources.qwen.speed, "declared"); // 结构化出处仍随决策返回
});

// ---------------------------------------------------------------------------
// 滑动窗口口径：历史不再永久托底，连败随新证据老化
// （capability-best 下 qwen 基础分领先 opencode 14：120 vs 106）
// ---------------------------------------------------------------------------

test("routeExecutor: 终身功劳救不了窗口内的连败（滑动窗口覆盖累计字段）", () => {
  const health = {
    qwen: {
      successes: 50, // 终身辉煌
      failures: 3,
      consecutiveFailures: 0, // 计数器已被成功清零……
      recent: [{ s: 0 }, { s: 0 }, { s: 0 }], // ……但窗口里全是失败：真相在窗口
    },
  };
  const d = routeExecutor(undefined, {
    probes: probe(["opencode", "qwen"]),
    strategy: "capability-best",
    health,
  });
  assert.equal(d.executor, "opencode");
});

test("routeExecutor: 窗口内连败被后续成功打断后，降权随之解除（证据老化）", () => {
  const health = {
    qwen: {
      successes: 5,
      failures: 5,
      consecutiveFailures: 5, // 遗留计数器还挂着……
      consecutiveTimeouts: 5,
      recent: [{ s: 0, t: 1 }, { s: 1 }, { s: 1 }], // ……窗口证明已恢复
    },
  };
  const d = routeExecutor(undefined, {
    probes: probe(["opencode", "qwen"]),
    strategy: "capability-best",
    health,
  });
  assert.equal(d.executor, "qwen");
});

test("routeExecutor: 真实回写链路——连超时降权，随后成功恢复席位", async () => {
  resetHealthStore();
  const ws = mkdtempSync(path.join(tmpdir(), "cbx-route-win-"));
  try {
    for (let i = 0; i < 3; i++) {
      recordExecutorOutcome(ws, "qwen", { success: false, kind: "timeout", latencyMs: 60_000 });
    }
    let d = routeExecutor(undefined, {
      probes: probe(["opencode", "qwen"]),
      strategy: "capability-best",
      health: loadHealth(ws),
    });
    assert.equal(d.executor, "opencode"); // 连超时 ×9 + 高延迟均值压过能力优势
    for (let i = 0; i < 2; i++) {
      recordExecutorOutcome(ws, "qwen", { success: true, latencyMs: 1_000 });
    }
    d = routeExecutor(undefined, {
      probes: probe(["opencode", "qwen"]),
      strategy: "capability-best",
      health: loadHealth(ws),
    });
    assert.equal(d.executor, "qwen"); // 连败清零 + 窗口成功奖，席位回来了
  } finally {
    rmSync(ws, { recursive: true, force: true });
    resetHealthStore();
  }
});
