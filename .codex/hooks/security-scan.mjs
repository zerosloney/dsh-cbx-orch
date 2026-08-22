import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const diffCheck = spawnSync("git", ["diff", "--check"], { cwd: root, encoding: "utf8" });
if (diffCheck.status !== 0) fail(diffCheck.stderr || diffCheck.stdout || "git diff --check failed");

const status = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
if (status.status !== 0) fail(status.stderr || "Unable to inspect Git status");

const secretPattern = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bsk-[A-Za-z0-9]{20,}\b/;
for (const entry of status.stdout.split("\0")) {
  if (!/^[ MADRCU?!]{2} /.test(entry)) continue;
  const path = entry.slice(3);
  if (!/^(src|test|ui|\.github)\//.test(path)) continue;
  try {
    if (secretPattern.test(readFileSync(path, "utf8"))) fail(`Potential credential detected in ${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

process.stdout.write("security scan passed\n");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
