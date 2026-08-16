import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateTestCommand,
  assertJobId,
  normalizeTaskContract,
  validateWorkspace,
  validatePermissionMode,
} from "../lib/validation.js";
import { isCbxError } from "../lib/errors.js";

test("校验层错误带错误码（Web 层据此回 400 而非 500）", async () => {
  assert.throws(
    () => validateWorkspace("Z:\\definitely\\missing\\dir"),
    (error) => isCbxError(error, "E_INVALID_WORKSPACE"),
  );
  assert.throws(
    () => validateTestCommand("rm -rf /"),
    (error) => isCbxError(error, "E_INVALID_TEST_COMMAND"),
  );
  assert.throws(
    () => validatePermissionMode("plan"),
    (error) => isCbxError(error, "E_INVALID_PERMISSION_MODE"),
  );
  assert.throws(
    () => validatePermissionMode("dontAsk"),
    (error) => isCbxError(error, "E_INVALID_PERMISSION_MODE"),
  );
  assert.doesNotThrow(() => validatePermissionMode("dontAsk", true));
});

test("validateTestCommand: 拦截破坏性命令（含拼接绕过）", () => {
  const blocked = [
    "rm -rf /",
    'r""m -rf x',
    "r\\m -rf /",
    "find . -name x -exec rm {} +",
    'find . -name "*.log" -delete',
    "git -C .. clean -fdx",
    "git clean -fdx",
    "del /q /s *",
    "powershell -e AAAA",
    "pwsh -ec BBBB",
    "eval rm x",
    "rm --recursive x",
    'echo "a;b"',
    "ls | grep x",
    "echo $(whoami)",
  ];
  for (const cmd of blocked) {
    assert.throws(() => validateTestCommand(cmd), `应拦截: ${cmd}`);
  }
});

test("validateTestCommand: 放行合法命令", () => {
  const allowed = [
    "npm test",
    "pytest -q",
    "npm run eval-test",
    "go test ./...",
    "node --test",
    "git status",
    "cargo test",
    "echo smoke-done",
  ];
  for (const cmd of allowed) {
    assert.doesNotThrow(() => validateTestCommand(cmd), `应放行: ${cmd}`);
  }
});

test("assertJobId: 拒绝非法 id", () => {
  const bad = [
    "",
    "..",
    "a/../b",
    "a b",
    "con",
    "CON.txt",
    "nul",
    "com1",
    "lpt9",
    "trailing.",
    "trailing ",
    "中文",
    "a".repeat(200),
  ];
  for (const id of bad) {
    assert.throws(() => assertJobId(id), `应拒绝: ${JSON.stringify(id)}`);
  }
});

test("assertJobId: 接受合法 id", () => {
  for (const id of ["abc", "job_1", "job-2", "A.B", "a1"]) {
    assert.doesNotThrow(() => assertJobId(id), `应接受: ${id}`);
  }
});

test("normalizeTaskContract: 重复 stage 名与循环依赖被拒", () => {
  const dup = {
    stages: [
      { name: "s", executor: "x", task: "t" },
      { name: "s", executor: "x", task: "t" },
    ],
  };
  assert.throws(() => normalizeTaskContract(dup), /重复/);

  const cycle = {
    stages: [
      { name: "a", executor: "x", task: "t", dependsOn: ["b"] },
      { name: "b", executor: "x", task: "t", dependsOn: ["a"] },
    ],
  };
  assert.throws(() => normalizeTaskContract(cycle), /循环/);
});

test("normalizeTaskContract: 悬空依赖被拒，合法契约通过", () => {
  assert.throws(
    () =>
      normalizeTaskContract({
        stages: [{ name: "a", executor: "x", task: "t", dependsOn: ["nope"] }],
      }),
    /依赖不存在/,
  );
  const ok = normalizeTaskContract({
    goal: "g",
    stages: [
      { name: "a", executor: "x", task: "t" },
      { name: "b", executor: "y", task: "u", dependsOn: ["a"] },
    ],
  });
  assert.equal(ok.stages.length, 2);
  assert.deepEqual(ok.stages[1].dependsOn, ["a"]);
});
