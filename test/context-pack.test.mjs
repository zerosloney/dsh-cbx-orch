import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateText, estimateTokens } from "../lib/context-pack.js";

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
