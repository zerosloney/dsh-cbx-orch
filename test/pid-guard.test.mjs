import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePidRecordText } from "../lib/pid-guard.js";
import { reclaimBackoffRemainingMs } from "../lib/queue.js";

test("parsePidRecordText: 新 JSON 格式", () => {
  const record = parsePidRecordText('{"pid":123,"startedAt":1700000000000}');
  assert.deepEqual(record, { pid: 123, startedAt: 1700000000000 });
});

test("parsePidRecordText: 旧裸数字格式（startedAt=NaN 表示无法校验）", () => {
  const record = parsePidRecordText("456");
  assert.equal(record.pid, 456);
  assert.ok(Number.isNaN(record.startedAt));
});

test("parsePidRecordText: 拒绝垃圾输入", () => {
  for (const input of ["", "../../evil", "abc", "0", "-1", "{broken", "123\n456"]) {
    assert.equal(parsePidRecordText(input), undefined, `应拒绝: ${JSON.stringify(input)}`);
  }
});

test("reclaimBackoffRemainingMs: 退避随次数指数增长并封顶", () => {
  const base = { queueId: "q", jobId: "j", status: "running", priority: 0, createdAt: "" };
  // 第 1 次回收：等待 60s
  const r1 = reclaimBackoffRemainingMs({
    ...base,
    reclaimCount: 1,
    lastReclaimAt: new Date(Date.now() - 5_000).toISOString(),
  });
  assert.ok(r1 > 50_000 && r1 <= 60_000, `r1=${r1}`);
  // 第 6 次回收：waitMs 封顶 30min，再减去已等待的 5s
  const r6 = reclaimBackoffRemainingMs({
    ...base,
    reclaimCount: 6,
    lastReclaimAt: new Date(Date.now() - 5_000).toISOString(),
  });
  assert.ok(r6 > 1_790_000 && r6 <= 1_800_000, `r6=${r6}`);
  // 已过等待期 → 0
  const done = reclaimBackoffRemainingMs({
    ...base,
    reclaimCount: 1,
    lastReclaimAt: new Date(Date.now() - 61_000).toISOString(),
  });
  assert.equal(done, 0);
  // 损坏时间戳（NaN）→ 按满额退避处理，不静默重放
  const corrupt = reclaimBackoffRemainingMs({
    ...base,
    reclaimCount: 2,
    lastReclaimAt: "not-a-date",
  });
  assert.equal(corrupt, 120_000);
  // 无回收记录 → 0
  assert.equal(reclaimBackoffRemainingMs(base), 0);
});
