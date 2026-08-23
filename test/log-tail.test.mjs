import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readAgentLog,
  readAgentLogIncremental,
  tailAgentLog,
} from "../lib/log-tail.js";

const dirs = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function makeJob(ws, content) {
  const job = path.join(ws, ".cbx", "jobs", "job-1");
  await mkdir(job, { recursive: true });
  await writeFile(path.join(job, "agent.log"), content, "utf8");
  return job;
}

// 测试都通过真实文件读写路径：log-tail 直接用 jobDir() 拼 .cbx/jobs/jobId。
async function writeAgent(ws, content) {
  await writeFile(path.join(ws, ".cbx", "jobs", "job-1", "agent.log"), content, "utf8");
}

test("readAgentLogIncremental: since=0 读尾部限长，行对齐，next 为字节偏移", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-logtail-"));
  dirs.push(ws);
  await makeJob(ws, "line1\nline2\nline3\n");
  const c = await readAgentLogIncremental(ws, "job-1", 0, 8);
  // 尾部 8 字节窗口内，行对齐到最后一个合法换行前的完整行
  assert.ok(c.content.endsWith("ine3\n") || c.content.includes("line2\n"));
  assert.equal(c.truncated, true);
  assert.ok(c.nextOffset <= 20);
});

test("readAgentLogIncremental: since 续读增量 + 持久化游标", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-logtail-"));
  dirs.push(ws);
  await makeJob(ws, "aaa\nbbb\n");
  const first = await readAgentLogIncremental(ws, "job-1", 0);
  assert.equal(first.nextOffset, 8); // "aaa\nbbb\n"
  // 追加一行再续读
  await writeAgent(ws, "aaa\nbbb\nccc\n");
  const second = await readAgentLogIncremental(ws, "job-1", first.nextOffset);
  assert.equal(second.content, "ccc\n");
  // 每次 since>0 续读都会把协商出的 nextOffset 持久化到游标文件（本次=续读后值）
  const cursor = await readFile(path.join(ws, ".cbx", "jobs", "job-1", "agent.log.cursor"), "utf8");
  assert.equal(cursor, String(second.nextOffset));
});

test("readAgentLogIncremental: 文件截断/旋转自愈（磁盘比上次游标短则回尾部）", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-logrotate-"));
  dirs.push(ws);
  await makeJob(ws, "aaaa\nbbbb\n");
  const first = await readAgentLogIncremental(ws, "job-1", 0);
  assert.equal(first.nextOffset, 10);
  // 文件被重建（变短）
  await writeAgent(ws, "zz\n");
  const rotated = await readAgentLogIncremental(ws, "job-1", 10);
  // 尾部窗口长度(默认 256k)覆盖整个新文件 → 从头
  assert.equal(rotated.content, "zz\n");
  assert.equal(rotated.truncated, false);
});

test("readAgentLogIncremental: 无换行(单行)时全保留", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-logline-"));
  dirs.push(ws);
  await makeJob(ws, "no-newline-tail");
  const c = await readAgentLogIncremental(ws, "job-1", 0, 1000);
  assert.equal(c.content, "no-newline-tail");
  assert.equal(c.nextOffset, 15);
});

test("tailAgentLog: 内存游标、无限、文件头重置", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-logtailbridge-"));
  dirs.push(ws);
  await makeJob(ws, "one\ntwo\n");
  const c1 = await tailAgentLog(ws, "job-1", 0);
  assert.equal(c1.text, "one\ntwo\n");
  assert.equal(c1.next, 8);
  // 游标越界 → 重置到文件头（完整重读尾部）
  const c2 = await tailAgentLog(ws, "job-1", 5, 100);
  // since<len 仍在范围内：直接续读该起点
  const c2b = await tailAgentLog(ws, "job-1", 5);
  assert.equal(c2b.text, "wo\n");
  // 越界重置
  const c3 = await tailAgentLog(ws, "job-1", 100);
  assert.equal(c3.text, "one\ntwo\n");
  assert.equal(c3.next, 8);
});

test("tailAgentLog: 文件缺失返回 {text:'',next:since}", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-logmissing-"));
  dirs.push(ws);
  // 不创建 job 目录
  const c = await tailAgentLog(ws, "ghost", 42);
  assert.deepEqual(c, { text: "", next: 42 });
});