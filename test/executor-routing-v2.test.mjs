import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_EXECUTORS,
  probeAllExecutors,
} from "../lib/executors/builtin.js";
import {
  routeExecutor,
  deriveRequirements,
  meetsRequirements,
  DEFAULT_EXECUTOR_PREFERENCE,
} from "../lib/executor-router.js";

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
