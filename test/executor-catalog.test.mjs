import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTierCatalog,
  MIN_TIER_CALIBRATION_SAMPLES,
  tierSourcesNote,
} from "../lib/executor-catalog.js";

// 健康快照辅助：samples 次调用、总延迟 totalMs。
function healthFor(entries) {
  const health = {};
  for (const [name, samples, totalMs] of entries) {
    if (samples <= 0) continue;
    health[name] = {
      successes: samples,
      failures: 0,
      consecutiveFailures: 0,
      latencySamples: samples,
      totalLatencyMs: totalMs,
    };
  }
  return health;
}

test("buildTierCatalog: 无样本时全部 declared，档位等于声明值", () => {
  const { catalog, warnings } = buildTierCatalog({}, {});
  assert.equal(warnings.length, 0);
  // 与 executors/builtin.ts 的声明值对齐：qwen speed=3 / cost=2。
  assert.equal(catalog.qwen.speedTier, 3);
  assert.equal(catalog.qwen.costTier, 2);
  assert.equal(catalog.qwen.speedSource, "declared");
  assert.equal(catalog.qwen.costSource, "declared");
  assert.equal(catalog.qwen.samples, 0);
  assert.equal(catalog.qwen.avgLatencyMs, undefined);
});

test("buildTierCatalog: 样本不足阈值时保持 declared（估值不得冒充实测）", () => {
  const health = healthFor([["qwen", MIN_TIER_CALIBRATION_SAMPLES - 1, 60_000]]);
  const { catalog } = buildTierCatalog(health, {});
  assert.equal(catalog.qwen.speedSource, "declared");
  assert.equal(catalog.qwen.speedTier, 3); // 声明值
  assert.equal(catalog.qwen.samples, MIN_TIER_CALIBRATION_SAMPLES - 1);
});

test("buildTierCatalog: 样本足够时速度档进入实测校准（相对排名映射）", () => {
  // qwen 平均 50s，opencode 平均 100s：best=qwen(3)，opencode=1+floor(2*50/100)=2。
  const health = healthFor([
    ["qwen", 5, 250_000],
    ["opencode", 4, 400_000],
  ]);
  const { catalog } = buildTierCatalog(health, {});
  assert.equal(catalog.qwen.speedSource, "measured");
  assert.equal(catalog.qwen.speedTier, 3);
  assert.equal(catalog.qwen.avgLatencyMs, 50_000);
  assert.equal(catalog.opencode.speedSource, "measured");
  assert.equal(catalog.opencode.speedTier, 2);
  // 未参与校准的执行器不受影响：omp 无样本保持声明值（speed=2）。
  assert.equal(catalog.omp.speedSource, "declared");
  assert.equal(catalog.omp.speedTier, 2);
});

test("buildTierCatalog: 实测最慢者落到档位 1（3 倍于 best）", () => {
  const health = healthFor([
    ["qwen", 3, 90_000], // avg 30s
    ["cline", 3, 300_000], // avg 100s → 1+floor(2*30/100)=1
  ]);
  const { catalog } = buildTierCatalog(health, {});
  assert.equal(catalog.qwen.speedTier, 3);
  assert.equal(catalog.cline.speedTier, 1);
});

test("buildTierCatalog: executorTiers 覆盖优先于实测与声明，cost/speed 出处分开", () => {
  const health = healthFor([["qwen", 5, 250_000]]);
  const { catalog } = buildTierCatalog(health, {
    qwen: { speedTier: 1 },
    omp: { costTier: 3 },
  });
  assert.equal(catalog.qwen.speedTier, 1);
  assert.equal(catalog.qwen.speedSource, "configured");
  assert.ok(catalog.qwen.avgLatencyMs, "覆盖不丢实测统计");
  assert.equal(catalog.omp.costTier, 3);
  assert.equal(catalog.omp.costSource, "configured");
  assert.equal(catalog.omp.speedSource, "declared");
});

test("buildTierCatalog: 别名归一到注册名；未知名产出 warning 且不生效", () => {
  const { catalog, warnings } = buildTierCatalog({}, {
    cbc: { costTier: 1 }, // codebuddy 的别名
    qwenx: { speedTier: 3 }, // 拼错的名字
  });
  assert.equal(catalog.codebuddy.costTier, 1);
  assert.equal(catalog.codebuddy.costSource, "configured");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /qwenx/);
});

test("buildTierCatalog: 非对象覆盖与别名+注册名重复各产一条 warning", () => {
  const { warnings } = buildTierCatalog({}, {
    broken: "not-an-object",
    cbc: { costTier: 1 }, // 别名先出现
    codebuddy: { costTier: 2 }, // 同一执行器：保留 cbc 的覆盖，此条告警
  });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /broken/);
  assert.match(warnings[1], /codebuddy/);
  assert.match(warnings[1], /cbc/);
});

test("tierSourcesNote: measured 注明样本数；declared 明说估值；无目录为空串", () => {
  const health = healthFor([["qwen", 5, 250_000]]);
  const { catalog } = buildTierCatalog(health, {});
  const measuredNote = tierSourcesNote(catalog, "qwen");
  assert.match(measuredNote, /实测/);
  assert.match(measuredNote, /5 样本/);
  const declaredNote = tierSourcesNote(catalog, "opencode");
  assert.match(declaredNote, /声明估值/);
  assert.equal(tierSourcesNote(undefined, "qwen"), "");
});

test("buildTierCatalog: 校准走滑动窗口——机器变慢后档位跟着漂移，不被历史平均稀释", () => {
  // qwen 终身统计很快（50 样本、平均 50s），但最近 4 次实测慢到 200s；
  // 窗口口径下必须按最近表现校准：opencode（60s）成为 best，qwen 跌到档位 1。
  const health = {
    qwen: {
      successes: 50,
      failures: 0,
      consecutiveFailures: 0,
      latencySamples: 50, // 终身快的历史……
      totalLatencyMs: 2_500_000,
      recent: Array.from({ length: 4 }, () => ({ s: 1, ms: 200_000 })), // ……最近变慢了
    },
    opencode: {
      successes: 4,
      failures: 0,
      consecutiveFailures: 0,
      recent: Array.from({ length: 4 }, () => ({ s: 1, ms: 60_000 })),
    },
  };
  const { catalog } = buildTierCatalog(health, {});
  assert.equal(catalog.qwen.speedSource, "measured");
  assert.equal(catalog.qwen.speedTier, 1); // 不是历史暗示的 3
  assert.equal(catalog.qwen.samples, 4); // 窗口口径，不是终身的 50
  assert.equal(catalog.qwen.avgLatencyMs, 200_000);
  assert.equal(catalog.opencode.speedTier, 3);
});
