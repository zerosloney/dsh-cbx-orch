#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { loadExecutorPlugin, type ExecutorRequest } from "./executor.js";

async function main(): Promise<void> {
  const [executor, workspace, requestFile, resultFile] = process.argv.slice(2);
  if (!executor || !workspace || !requestFile || !resultFile)
    throw new Error("plugin host 缺少参数");
  const request = JSON.parse(
    await readFile(requestFile, "utf8"),
  ) as ExecutorRequest;
  const plugin = await loadExecutorPlugin(
    executor,
    workspace,
    request.plugin?.policy,
    request.plugin?.sha256,
  );
  const result = await plugin.run(request);
  await writeFile(resultFile, JSON.stringify(result), "utf8");
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
