import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  probeExecutable,
  probeAllExecutors,
  resetExecutorProbeCache,
  BUILTIN_EXECUTORS,
} from "../lib/executors/builtin.js";
import {
  normalizePreference,
  routeExecutor,
  availableNames,
  DEFAULT_EXECUTOR_PREFERENCE,
} from "../lib/executor-router.js";

// 构造一个 probe 快照：name 在 installed 集合中则视为可用。
function probesFor(installed) {
  return BUILTIN_EXECUTORS.map((spec) => ({
    name: spec.name,
    label: spec.label,
    available: installed.has(spec.name),
    source: installed.has(spec.name) ? "path" : "none",
    command: installed.has(spec.name) ? `/usr/bin/${spec.name}` : undefined,
  }));
}
const probe = (installed) => probesFor(new Set(installed));

test("normalizePreference: 缺省 = BUILTIN_EXECUTORS 顺序，别名归一化，未知丢弃", () => {
  assert.deepEqual(normalizePreference(undefined), [...DEFAULT_EXECUTOR_PREFERENCE]);
  // 别名 cbc → codebuddy；未知 oops 丢弃；未覆盖项追加到尾部。
  assert.deepEqual(normalizePreference(["cbc", "oops", "qwen"]), [
    "codebuddy",
    "qwen",
    "opencode",
    "omp",
    "cline",
  ]);
});

test("routeExecutor: auto（未指定）选偏好顺序第一个已安装", () => {
  const d = routeExecutor(undefined, {
    probes: probe(["opencode", "qwen"]),
  });
  assert.equal(d.executor, "opencode");
  assert.equal(d.requested, undefined);
  assert.equal(d.routed, true);
  assert.match(d.reason, /自动路由/);
});

test("routeExecutor: preference 影响 auto 选择", () => {
  const d = routeExecutor(undefined, {
    probes: probe(["opencode", "qwen"]),
    preference: ["qwen", "opencode"],
  });
  assert.equal(d.executor, "qwen");
});

test("routeExecutor: 显式指定且已安装 → 直接用（routed=false）", () => {
  const d = routeExecutor("qwen", { probes: probe(["qwen"]) });
  assert.equal(d.executor, "qwen");
  assert.equal(d.routed, false);
});

test("routeExecutor: 显式指定但未安装 → 自动回退到可用执行器并记 requested", () => {
  const d = routeExecutor("codebuddy", {
    probes: probe(["opencode", "qwen"]),
  });
  assert.equal(d.executor, "opencode");
  assert.equal(d.requested, "codebuddy");
  assert.equal(d.routed, true);
  assert.match(d.reason, /codebuddy）未安装，已回退到可用执行器 opencode/);
});

test("routeExecutor: autoFallback=false 时保留原指定（routed=false，reason 说明未安装）", () => {
  const d = routeExecutor("codebuddy", {
    probes: probe(["opencode"]),
    autoFallback: false,
  });
  assert.equal(d.executor, "codebuddy");
  assert.equal(d.routed, false);
  assert.match(d.reason, /未安装/);
});

test("routeExecutor: 插件路径不参与路由，原样返回", () => {
  const d = routeExecutor("./executor.mjs", { probes: probe([]) });
  assert.equal(d.executor, "./executor.mjs");
  assert.equal(d.routed, false);
  assert.match(d.reason, /插件路径/);
});

test("routeExecutor: 全部不可用且 auto → executor=undefined", () => {
  const d = routeExecutor(undefined, { probes: probe([]) });
  assert.equal(d.executor, undefined);
  assert.equal(d.routed, false);
  assert.match(d.reason, /无任何可用/);
});

test("availableNames: 只列可用的", () => {
  assert.equal(availableNames(probe([])), "（无）");
  assert.equal(availableNames(probe(["ok1" === "ok1" ? "codebuddy" : "x", "qwen"])), "codebuddy, qwen");
});

test("probeExecutable: envVar 覆盖指向存在的可执行文件 → available=env", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cbx-probe-"));
  const fake = path.join(root, "codebuddy-cli.exe");
  await writeFile(fake, "#!/usr/bin/env node\n", "utf8");
  try {
    const spec = BUILTIN_EXECUTORS.find((s) => s.name === "codebuddy");
    const result = probeExecutable(spec, { CBX_CODEBUDDY: fake });
    assert.equal(result.available, true);
    assert.equal(result.source, "env");
    assert.equal(result.command, fake);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("probeExecutable: envVar 覆盖指向不存在的路径 → 不可用", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cbx-probe-"));
  const missing = path.join(root, "does-not-exist.exe");
  try {
    const spec = BUILTIN_EXECUTORS.find((s) => s.name === "codebuddy");
    const result = probeExecutable(spec, { CBX_CODEBUDDY: missing });
    assert.equal(result.available, false);
    assert.equal(result.source, "none");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("probeAllExecutors: 命中的执行器计入 availableNames / reset 后重新探测", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cbx-probe-"));
  const fake = path.join(root, "opencode-cli");
  await writeFile(fake, "#!/usr/bin/env node\n", "utf8");
  try {
    resetExecutorProbeCache();
    const probes = probeAllExecutors({ CBX_OPENCODE: fake });
    const opencode = probes.find((p) => p.name === "opencode");
    assert.ok(opencode);
    assert.equal(opencode.available, true);
    assert.equal(opencode.source, "env");
    // 默认 PATH 探测不应闯入 env 场景：即使 codebuddy 未配置，探测仍按系统进行——
    // 只断言 opencode（env 注入的）一定可用即可，避免依赖本机安装。
    resetExecutorProbeCache();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 命令注入回归：envVar 裸名含 PowerShell 元字符（;、`、$()、引号）时，
// resolveCandidateOnSystem 必须把它当作 Get-Command 的纯参数名，绝不解析执行。
// 修复前 `(Get-Command ${primary}).Source` 会把这些字符当代码跑。
test("probeExecutable: 含 PowerShell 元字符的 envVar 裸名不被当作代码执行", async () => {
  const spec = BUILTIN_EXECUTORS.find((s) => s.name === "codebuddy");
  const malicious = "codebuddy; Write-Host INJECTED_GET_COMMAND";
  const result = probeExecutable(spec, { CBX_CODEBUDDY: malicious });
  // Get-Command -Name '…' 找不到字面名为该串的命令 → 不可用，且 INJECTED 不应被执行。
  assert.equal(result.available, false);
  assert.equal(result.source, "none");
  // 防御：注入标记绝不出现在任何解析结果里。
  assert.ok(!String(result.command ?? "").includes("INJECTED_GET_COMMAND"));
});