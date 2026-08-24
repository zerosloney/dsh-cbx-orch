import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectExecutorPlugin } from "../lib/executor.js";

const fixtures = [];
after(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

const PLUGIN_SOURCE = `
export default {
  manifest: { apiVersion: "cbx.executor/v1", name: "test", version: "1.0.0", capabilities: ["execute"] },
  async run() { return { code: 0 }; },
};
`;

function makeWorkspace() {
  const workspace = mkdtempSync(path.join(tmpdir(), "cbx-executor-policy-"));
  writeFileSync(path.join(workspace, "executor.mjs"), PLUGIN_SOURCE, "utf8");
  fixtures.push(workspace);
  return workspace;
}

test("默认策略（无 plugins 配置）: 路径穿越被拒", async () => {
  const workspace = makeWorkspace();
  // 在工作区**外**（tmpdir）创建真实文件：realpath 能成功解析到工作区外，才触发
  // 路径穿越拒绝。旧测试只传 "../outside.mjs"（文件不存在），Linux 上 realpath 先抛
  // ENOENT，与期望的"插件路径必须位于工作区内"不符（Windows 碰巧解析到存在的上级
  // 目录才通过）。
  const outside = path.join(tmpdir(), "cbx-executor-policy-outside.mjs");
  writeFileSync(outside, PLUGIN_SOURCE, "utf8");
  try {
    await assert.rejects(
      () => inspectExecutorPlugin("../cbx-executor-policy-outside.mjs", workspace, {}),
      /插件路径必须位于工作区内/,
    );
  } finally {
    rmSync(outside, { force: true });
  }
});

test("enforce 缺省 + defaultEnforce=true: 无 allow 列表时拒绝加载（fail-closed）", async () => {
  const workspace = makeWorkspace();
  await assert.rejects(
    () => inspectExecutorPlugin("executor.mjs", workspace, { defaultEnforce: true }),
    /plugins\.enforce=true 时必须配置 allowPaths 或 allowSha256/,
  );
});

test("enforce 缺省 + defaultEnforce=true: 命中 allowPaths 时放行", async () => {
  const workspace = makeWorkspace();
  const identity = await inspectExecutorPlugin("executor.mjs", workspace, {
    defaultEnforce: true,
    allowPaths: ["executor.mjs"],
  });
  assert.equal(identity.name, "test");
  assert.equal(identity.source, "plugin");
  assert.match(identity.sha256, /^[a-f0-9]{64}$/);
});

test("enforce 缺省 + defaultEnforce=true: 未命中 allowPaths 时拒绝", async () => {
  const workspace = makeWorkspace();
  await assert.rejects(
    () => inspectExecutorPlugin("executor.mjs", workspace, {
      defaultEnforce: true,
      allowPaths: ["other.mjs"],
    }),
    /插件路径未获批准/,
  );
});

test("enforce 缺省 + defaultEnforce=true: 命中 allowSha256 时放行", async () => {
  const workspace = makeWorkspace();
  const identity = await inspectExecutorPlugin("executor.mjs", workspace, {
    defaultEnforce: true,
  }).catch(() => null);
  // 先取 sha256（无 allow 列表会拒绝，改用 allowPaths 拿 identity）
  const withPath = await inspectExecutorPlugin("executor.mjs", workspace, {
    defaultEnforce: true,
    allowPaths: ["executor.mjs"],
  });
  const allowed = await inspectExecutorPlugin("executor.mjs", workspace, {
    defaultEnforce: true,
    allowSha256: [withPath.sha256],
  });
  assert.equal(allowed.sha256, withPath.sha256);
  assert.ok(identity === null); // 无 allow 列表时确实被拒
});

test("显式 enforce=false 覆盖 defaultEnforce: 无白名单也放行（逃生门）", async () => {
  const workspace = makeWorkspace();
  const identity = await inspectExecutorPlugin("executor.mjs", workspace, {
    enforce: false,
    defaultEnforce: true,
  });
  assert.equal(identity.name, "test");
});

test("显式 enforce=true 优先于 defaultEnforce=false", async () => {
  const workspace = makeWorkspace();
  await assert.rejects(
    () => inspectExecutorPlugin("executor.mjs", workspace, {
      enforce: true,
      defaultEnforce: false,
    }),
    /plugins\.enforce=true 时必须配置 allowPaths 或 allowSha256/,
  );
});

test("两侧都缺省（legacy 宿主）: 保持不强制", async () => {
  const workspace = makeWorkspace();
  const identity = await inspectExecutorPlugin("executor.mjs", workspace, {});
  assert.equal(identity.name, "test");
});
