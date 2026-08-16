#!/usr/bin/env node
import { readFile, unlink, writeFile } from "node:fs/promises";
import { loadExecutorPlugin, type ExecutorRequest } from "./executor.js";

async function main(): Promise<void> {
  const [executor, workspace, requestFile, resultFile] = process.argv.slice(2);
  if (!executor || !workspace || !requestFile || !resultFile)
    throw new Error("plugin host 缺少参数");
  // The request embeds the full prompt and may contain inline credentials.
  // Remove it immediately after reading, before parsing/loading/running so
  // host-side failures cannot leave the sensitive request behind.
  const requestText = await readFile(requestFile, "utf8");
  await unlink(requestFile);
  const request = JSON.parse(requestText) as ExecutorRequest;
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
