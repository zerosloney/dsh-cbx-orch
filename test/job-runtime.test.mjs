import { test } from "node:test";
import assert from "node:assert/strict";
import {
  registerRunningJob,
  unregisterRunningJob,
  getRunningJob,
  abortRunningJob,
} from "../lib/job-runtime.js";

test("注册表按 workspace::jobId 复合键：同名任务跨工作区互不串扰", () => {
  const wsA = registerRunningJob("D:/ws-a", "same-job");
  const wsB = registerRunningJob("D:/ws-b", "same-job");
  assert.notEqual(wsA, wsB);
  assert.equal(getRunningJob("D:/ws-a", "same-job"), wsA);
  assert.equal(getRunningJob("D:/ws-b", "same-job"), wsB);

  // 路径形态不同（尾斜杠/大小写由 resolve 归一）仍命中同一键
  assert.equal(getRunningJob("D:\\ws-a\\", "same-job"), wsA);

  // 取消只影响目标工作区的上下文
  assert.equal(abortRunningJob("D:/ws-b", "same-job"), true);
  assert.equal(wsB.controller.signal.aborted, true);
  assert.equal(wsA.controller.signal.aborted, false);

  unregisterRunningJob("D:/ws-b", "same-job");
  assert.equal(getRunningJob("D:/ws-b", "same-job"), undefined);
  assert.equal(abortRunningJob("D:/ws-b", "same-job"), false);
  assert.equal(getRunningJob("D:/ws-a", "same-job"), wsA);
});
