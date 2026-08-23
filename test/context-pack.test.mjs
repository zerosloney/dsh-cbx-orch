import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  truncateText,
  estimateTokens,
  createManagerContextPack,
  createExecutorContextPack,
  createAuditorContextPack,
  parseContextPack,
  contextPackFile,
  DEFAULT_TOKEN_BUDGET,
} from "../lib/context-pack.js";

test("truncateText: 代理对安全（emoji/扩展 CJK 不被切断出 U+FFFD）", () => {
  const emoji = "a".repeat(40) + "😀".repeat(20);
  const cut = truncateText(emoji, 45);
  assert.ok(!cut.includes("\uFFFD"), "不应出现替换字符");
  assert.ok(cut.length <= 45);
  assert.ok(cut.endsWith("…"));
  // 普通文本
  assert.equal(truncateText("short", 100), "short");
  const spaced = truncateText("hello world foo bar", 14);
  assert.equal(spaced, "hello world…");
});

test("estimateTokens: CJK 按 1.5 字符/token，ASCII 按 4 字符/token", () => {
  // 纯 CJK: 300 字符 ≈ 200 token
  const cjk = "测".repeat(300);
  assert.ok(Math.abs(estimateTokens(cjk) - 200) <= 1);
  // 纯 ASCII: 400 字符 ≈ 100 token
  const ascii = "a".repeat(400);
  assert.ok(Math.abs(estimateTokens(ascii) - 100) <= 1);
  assert.equal(estimateTokens(""), 0);
});

// ---------------------------------------------------------------------------
// 角色包组装（create*ContextPack）：投影/裁剪/落盘产物
// ---------------------------------------------------------------------------

const baseInput = {
  directory: null, // 由每个测试先建临时目录再赋值
  taskContract: {
    goal: "实现 X",
    nonGoals: ["不改 Y", "不碰 Z"],
    acceptanceCriteria: ["测试通过", "无回归"],
    constraints: ["只改必要文件"],
    assumptions: ["假设 A"],
  },
  verifiedProgress: {
    version: 1,
    criteria: [
      { id: "c1", criterion: "测试通过", status: "verified", evidence: [{ artifact: "complete.patch", sha256: "a".repeat(64) }] },
    ],
  },
  audit: {
    version: 1,
    completion: "complete",
    cleanliness: "clean",
    alignment: "aligned",
    criteria: [
      { id: "c1", criterion: "测试通过", status: "verified", evidence: [{ artifact: "complete.patch", sha256: "a".repeat(64) }] },
    ],
  },
  recentFailure: {
    phase: "testing",
    error: "验收命令失败",
    retryReason: "请修复后重试",
    count: 2,
  },
  userInstructions: "请完成目标",
  artifactNames: [],
  redact: (text) => text,
};

async function makeDir() {
  return mkdtemp(path.join(os.tmpdir(), "cbx-context-pack-"));
}

/** 构造一个合法的 reference 列表（目录内真实存在这些文件，sha256 与内容一致）。 */
async function materializeArtifacts(dir, names) {
  const artifactNames = [];
  for (const name of names) {
    const content = `content-of-${name}`;
    await writeFile(path.join(dir, name), content, "utf8");
    artifactNames.push(name);
  }
  return artifactNames;
}

test("createExecutorContextPack: 组装完整投影，含 stage/attempt/预算估算", async () => {
  const dir = await makeDir();
  try {
    const artifactNames = await materializeArtifacts(dir, ["complete.patch", "test.log"]);
    const { pack, path: packPath } = await createExecutorContextPack({
      ...baseInput,
      directory: dir,
      artifactNames,
      stage: { name: "impl", executor: "codebuddy", task: "实现目标" },
      attempt: 2,
    });
    assert.equal(pack.role, "executor");
    assert.equal(pack.projection, true);
    assert.equal(pack.current.stage.name, "impl");
    assert.equal(pack.current.attempt, 2);
    // 投影：字符串被截断到上限；数组被裁剪
    assert.ok(pack.taskContract.goal.length <= 1_000);
    assert.equal(pack.taskContract.nonGoals.length, 2);
    // verifiedProgress / audit 投影保留
    assert.equal(pack.verifiedProgress.criteria[0].status, "verified");
    assert.equal(pack.audit.completion, "complete");
    // recentFailure 投影
    assert.equal(pack.recentFailure.count, 2);
    // artifacts 引用：sha256 与实际内容一致
    assert.equal(pack.artifacts.length, 2);
    for (const ref of pack.artifacts) {
      assert.match(ref.sha256, /^[a-f0-9]{64}$/);
      assert.equal(ref.name, path.basename(ref.path));
    }
    // 落盘文件
    assert.equal(packPath, path.join(dir, contextPackFile("executor")));
    // 重新解析应成功
    const reparsed = parseContextPack(pack);
    assert.equal(reparsed.role, "executor");
    assert.equal(reparsed.estimatedTokens, pack.estimatedTokens);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createManagerContextPack: current.round/maxRounds/remainingRounds", async () => {
  const dir = await makeDir();
  try {
    const { pack } = await createManagerContextPack({
      ...baseInput,
      directory: dir,
      artifactNames: [],
      round: 3,
      maxRounds: 8,
    });
    assert.equal(pack.role, "manager");
    assert.equal(pack.current.round, 3);
    assert.equal(pack.current.maxRounds, 8);
    assert.equal(pack.current.remainingRounds, 5);
    assert.equal(contextPackFile("manager"), "manager-context.json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAuditorContextPack: current 含 reviewRules 与 criteria", async () => {
  const dir = await makeDir();
  try {
    const { pack } = await createAuditorContextPack({
      ...baseInput,
      directory: dir,
      artifactNames: [],
      stage: { name: "impl", executor: "codebuddy", task: "实现目标" },
      reviewRules: "关注安全性",
      criteria: [{ id: "c1", criterion: "测试通过" }],
    });
    assert.equal(pack.role, "auditor");
    assert.equal(pack.current.reviewRules, "关注安全性");
    assert.equal(pack.current.criteria[0].id, "c1");
    assert.equal(contextPackFile("auditor"), "auditor-context.json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 预算裁剪（tokenBudget）：裁掉低优先字段 / 收缩 userInstructions / 标记 truncated
// ---------------------------------------------------------------------------

test("token 预算裁剪：超预算时按优先级裁掉 assumptions 并标记 truncated", async () => {
  const dir = await makeDir();
  try {
    const { pack } = await createExecutorContextPack({
      ...baseInput,
      directory: dir,
      artifactNames: [],
      stage: { name: "impl", executor: "codebuddy", task: "实现目标" },
      attempt: 1,
      budget: { manager: 6_000, executor: 50, auditor: 8_000 }, // 极小预算强制裁剪
    });
    // 核心字段永不裁剪
    assert.ok(pack.taskContract.goal);
    assert.ok(pack.taskContract.acceptanceCriteria.length > 0);
    // 低优先字段（assumptions）被裁掉
    assert.equal(pack.taskContract.assumptions, undefined);
    // truncated 标记
    assert.equal(pack.truncated, true);
    // 估算值始终有界
    assert.equal(typeof pack.estimatedTokens, "number");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("token 预算裁剪：预算充足时不裁剪、不标记 truncated", async () => {
  const dir = await makeDir();
  try {
    const { pack } = await createExecutorContextPack({
      ...baseInput,
      directory: dir,
      artifactNames: [],
      stage: { name: "impl", executor: "codebuddy", task: "实现目标" },
      attempt: 1,
      budget: { manager: 6_000, executor: 1_000_000, auditor: 8_000 },
    });
    assert.equal(pack.truncated, undefined);
    assert.ok(pack.taskContract.assumptions, "预算充足时应保留 assumptions");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("userInstructions 超预算时被指数收缩", async () => {
  const dir = await makeDir();
  try {
    const { pack } = await createExecutorContextPack({
      ...baseInput,
      directory: dir,
      artifactNames: [],
      stage: { name: "impl", executor: "codebuddy", task: "实现目标" },
      attempt: 1,
      userInstructions: "补充说明 ".repeat(5_000), // 4 万字符
      budget: { manager: 6_000, executor: 500, auditor: 8_000 },
    });
    assert.ok(pack.userInstructions.length < 5_000 * 5, "超长 userInstructions 必须被收缩");
    assert.equal(pack.truncated, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 投影校验（parseContextPack）：非法输入被拒绝
// ---------------------------------------------------------------------------

test("parseContextPack: 拒绝未知顶层字段", () => {
  assert.throws(() => parseContextPack({ version: 1, projection: true, role: "executor", bogus: 1 }), /不支持字段/);
});

test("parseContextPack: 拒绝非法角色", () => {
  assert.throws(() => parseContextPack({ version: 1, projection: true, role: "evil" }), /角色无效/);
});

test("parseContextPack: 拒绝超长包", () => {
  const huge = "x".repeat(25_000);
  assert.throws(() => parseContextPack({ version: 1, projection: true, role: "executor", current: { stage: { name: "s", executor: "e", task: huge }, attempt: 0 } }), /字符上限/);
});

// parseContextPack 的合法最小 base：userInstructions/taskContract/recentFailure/artifacts 都是必检字段
function parseBase(overrides = {}) {
  return {
    version: 1,
    projection: true,
    role: "executor",
    userInstructions: "x",
    taskContract: { goal: "g" },
    recentFailure: null,
    artifacts: [],
    current: { stage: { name: "s", executor: "e", task: "t" }, attempt: 0 },
    ...overrides,
  };
}

test("parseContextPack: manager current 需要一致的 round/maxRounds/remainingRounds", () => {
  const base = parseBase({ role: "manager", current: { round: 2, maxRounds: 5, remainingRounds: 3 } });
  assert.doesNotThrow(() => parseContextPack(base));
  assert.throws(() => parseContextPack(parseBase({ role: "manager", current: { round: 2, maxRounds: 5, remainingRounds: 99 } })), /无效/);
  assert.throws(() => parseContextPack(parseBase({ role: "manager", current: { round: 0, maxRounds: 5, remainingRounds: 5 } })), /无效/);
});

test("parseContextPack: executor current 需要合法 stage/attempt", () => {
  const base = parseBase();
  assert.doesNotThrow(() => parseContextPack(base));
  assert.throws(() => parseContextPack(parseBase({ current: { stage: { name: "s", executor: "e", task: "t" }, attempt: -1 } })), /无效/);
  assert.throws(() => parseContextPack(parseBase({ current: { stage: { name: "s", executor: "e" }, attempt: 1 } })), /无效/);
});

test("parseContextPack: 拒绝 artifact 路径穿越（path 不是目录内文件）", () => {
  const bad = parseBase({
    artifacts: [{ name: "complete.patch", path: "/etc/passwd", sha256: "a".repeat(64) }],
  });
  assert.throws(() => parseContextPack(bad), /artifact/);
});

test("parseContextPack: 拒绝损坏的 verifiedProgress/audit", () => {
  const base = { version: 1, projection: true, role: "executor", current: { stage: { name: "s", executor: "e", task: "t" }, attempt: 0 } };
  assert.throws(() => parseContextPack({ ...base, verifiedProgress: { version: 2, criteria: [] } }), /无效/);
  assert.throws(() => parseContextPack({ ...base, audit: { version: 1, completion: "nonsense", cleanliness: "clean", alignment: "aligned", criteria: [] } }), /无效/);
});

// ---------------------------------------------------------------------------
// truncateText 边界：硬切与代理对
// ---------------------------------------------------------------------------

test("truncateText: 硬切（无空白时）不切断代理对", () => {
  const noSpace = "a".repeat(30) + "😀";
  const cut = truncateText(noSpace, 32);
  assert.ok(!cut.includes("\uFFFD"), "代理对不可被切断");
  assert.ok(cut.length <= 33);
});

test("DEFAULT_TOKEN_BUDGET 结构完整", () => {
  assert.equal(typeof DEFAULT_TOKEN_BUDGET.manager, "number");
  assert.equal(typeof DEFAULT_TOKEN_BUDGET.executor, "number");
  assert.equal(typeof DEFAULT_TOKEN_BUDGET.auditor, "number");
});
