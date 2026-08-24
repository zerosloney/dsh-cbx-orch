import { test } from "node:test";
import assert from "node:assert/strict";
import { applySettingsSection } from "../lib/settings-integration.js";

/** 构造一个 CbxDefaults 的最小实现（覆盖被测字段）。 */
function makeDefaults(overrides = {}) {
  return {
    executor: "codebuddy",
    review: true,
    isolated: true,
    carryDirty: false,
    ...overrides,
  };
}

test("applySettingsSection: settings 字段覆盖插件 config（executor/review/isolated/carryDirty）", () => {
  const defaults = makeDefaults();
  const config = { executor: "opencode", review: true, isolated: true };
  applySettingsSection(defaults, config, {
    executor: "qwen",
    review: false,
    carryDirty: true,
  });
  assert.equal(defaults.executor, "qwen");
  assert.equal(defaults.review, false);
  assert.equal(defaults.isolated, true, "未配字段回落 config");
  assert.equal(defaults.carryDirty, true);
});

test("applySettingsSection: 无 settings section 时回落插件 config", () => {
  const defaults = makeDefaults();
  applySettingsSection(defaults, { executor: "cline" }, undefined);
  assert.equal(defaults.executor, "cline");
  assert.equal(defaults.review, true, "config 未配字段保留 defaults 现值");
});

test("applySettingsSection: 空 section（settings detach 回落）时回落到插件 config", () => {
  const defaults = makeDefaults({ executor: "omp" });
  applySettingsSection(defaults, { executor: "codebuddy" }, {});
  assert.equal(defaults.executor, "codebuddy", "空 section 回落 config（installSettingsSection detach 语义）");
});

test("applySettingsSection: envAllowlist 返回 true 表示需要重应用（settings 或 config 配了）", () => {
  const defaults = makeDefaults();
  assert.equal(
    applySettingsSection(defaults, { executors: { envAllowlist: ["A"] } }, undefined),
    true,
    "config 配了 envAllowlist",
  );
  assert.equal(
    applySettingsSection(defaults, {}, { executors: { envAllowlist: ["B"] } }),
    true,
    "settings 配了 envAllowlist",
  );
  assert.equal(
    applySettingsSection(defaults, {}, undefined),
    false,
    "两侧都未配 → 不需要重应用",
  );
});

test("applySettingsSection: settings 的 executors 未配置时回落 config 的 envAllowlist 语义", () => {
  const defaults = makeDefaults();
  // settings 只配 executor，executors 整体缺失 → envAllowlist 走 config。
  const needsReapply = applySettingsSection(
    defaults,
    { executors: { envAllowlist: ["X"] } },
    { executor: "qwen" },
  );
  assert.equal(needsReapply, true, "config 有 envAllowlist → 需重应用");
  assert.equal(defaults.executor, "qwen");
});
