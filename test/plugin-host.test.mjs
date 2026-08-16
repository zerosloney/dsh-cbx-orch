import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtures = [];
const host = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../lib/plugin-host.js",
);

after(() => {
  for (const directory of fixtures) rmSync(directory, { recursive: true, force: true });
});

function fixture(requestText, pluginSource) {
  const workspace = mkdtempSync(path.join(tmpdir(), "cbx-plugin-host-"));
  const directory = path.join(workspace, "job");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(workspace, "executor.mjs"), pluginSource, "utf8");
  const requestFile = path.join(directory, "plugin-request.json");
  const resultFile = path.join(directory, "plugin-result.json");
  writeFileSync(requestFile, requestText, "utf8");
  fixtures.push(workspace);
  return { workspace, requestFile, resultFile };
}

function runHost(value) {
  return spawnSync(
    process.execPath,
    [host, "executor.mjs", value.workspace, value.requestFile, value.resultFile],
    { encoding: "utf8" },
  );
}

test("plugin-host: 插件执行前 request 已删除", () => {
  const value = fixture(
    "{}",
    `
      import { existsSync } from "node:fs";
      import path from "node:path";
      export default { async run(request) {
        if (existsSync(path.join(request.directory, "plugin-request.json"))) {
          throw new Error("request still exists");
        }
        return { code: 0, output: "ok" };
      } };
    `,
  );
  writeFileSync(
    value.requestFile,
    JSON.stringify({ directory: path.dirname(value.requestFile) }),
    "utf8",
  );

  const result = runHost(value);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(value.requestFile), false);
});

test("plugin-host: JSON 解析失败也清理 request", () => {
  const value = fixture("{", "export default { async run() { return { code: 0 }; } };");

  const result = runHost(value);

  assert.notEqual(result.status, 0);
  assert.equal(existsSync(value.requestFile), false);
});

test("plugin-host: 插件加载失败也清理 request", () => {
  const value = fixture("{}", "export default ???;");

  const result = runHost(value);

  assert.notEqual(result.status, 0);
  assert.equal(existsSync(value.requestFile), false);
});

test("plugin-host: 插件执行失败也清理 request", () => {
  const value = fixture(
    "{}",
    "export default { async run() { throw new Error(\"run failed\"); } };",
  );

  const result = runHost(value);

  assert.notEqual(result.status, 0);
  assert.equal(existsSync(value.requestFile), false);
});
