import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createLogFileSink,
  rotatedLogPath,
} from "../lib/log-file-sink.js";

const workspaces = [];
function makeFile() {
  const ws = mkdtempSync(path.join(tmpdir(), "cbx-log-sink-"));
  workspaces.push(ws);
  const logFile = path.join(ws, "agent.log");
  writeFileSync(logFile, "head\n", "utf8"); // 模拟已存在的旧内容（如前置说明）
  return { ws, logFile };
}

/** 逐 chunk 追加（与生产调用方 appendFileSync 语义一致：轮转后自动重建主文件）。 */
function appendChunk(file, chunk) {
  appendFileSync(file, chunk);
}

test("createLogFileSink: 未达上限直接落盘，无轮转", () => {
  const { ws, logFile } = makeFile();
  try {
    const sink = createLogFileSink(logFile, (c) => appendChunk(logFile, c), 1024);
    sink.append(Buffer.from("a-line\n"));
    sink.append(Buffer.from("b-line\n"));
    assert.equal(sink.capped(), false);
    assert.equal(readFileSync(logFile, "utf8"), "head\na-line\nb-line\n");
    assert.equal(existsSync(rotatedLogPath(logFile)), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("createLogFileSink: 达上限轮转到 .1 代并继续落盘（长任务日志不丢失）", () => {
  const { ws, logFile } = makeFile();
  try {
    const sink = createLogFileSink(logFile, (c) => appendChunk(logFile, c), 40);
    // 每个 chunk 11 字节（10 字符 + 换行）：11→22→33 未超限，44 > 40 触发轮转。
    sink.append(Buffer.from("x".repeat(10) + "\n"));
    sink.append(Buffer.from("y".repeat(10) + "\n"));
    sink.append(Buffer.from("z".repeat(10) + "\n"));
    sink.append(Buffer.from("w".repeat(10) + "\n")); // 超限 → 轮转
    assert.equal(sink.capped(), false, "轮转后应继续写入而不是停止");
    assert.equal(existsSync(rotatedLogPath(logFile)), true, "主文件应轮转为 .1");
    // .1 代保存轮转前的全部内容（含旧 head 与前三 chunk）
    const rotated = readFileSync(rotatedLogPath(logFile), "utf8");
    assert.ok(rotated.includes("head\n"));
    assert.ok(rotated.includes("x".repeat(10)));
    assert.ok(rotated.includes("y".repeat(10)));
    assert.ok(rotated.includes("z".repeat(10)));
    assert.ok(!rotated.includes("w".repeat(10)));
    // 新主文件从超限 chunk 开始继续
    const current = readFileSync(logFile, "utf8");
    assert.ok(current.includes("w".repeat(10)), "超限 chunk 应写入新主文件");
    sink.append(Buffer.from("v".repeat(10) + "\n"));
    assert.ok(readFileSync(logFile, "utf8").includes("v".repeat(10)));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("createLogFileSink: .1 代已存在时停止落盘并留标记（capped）", () => {
  const { ws, logFile } = makeFile();
  try {
    writeFileSync(rotatedLogPath(logFile), "old-generation\n", "utf8");
    const sink = createLogFileSink(logFile, (c) => appendChunk(logFile, c), 48);
    sink.append(Buffer.from("a".repeat(60) + "\n")); // 超限且 .1 已存在 → capped
    assert.equal(sink.capped(), true, "两代都满应停止落盘");
    const current = readFileSync(logFile, "utf8");
    assert.match(current, /停止落盘/);
    // capped 后不再写入
    const before = current.length;
    sink.append(Buffer.from("b".repeat(30) + "\n"));
    assert.equal(readFileSync(logFile, "utf8").length, before);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});