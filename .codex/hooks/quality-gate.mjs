import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const mode = process.argv[2];
const input = await readInput();
const root = gitRoot(input.cwd ?? process.cwd());
const sessionId = String(input.session_id ?? "default");
const stateFile = join(
  process.env.LOCALAPPDATA ?? process.env.XDG_STATE_HOME ?? tmpdir() ?? homedir(),
  "codex-dsh-cbx-orch-hooks",
  `${hash(root)}-${hash(sessionId)}.json`,
);

if (mode === "session-start") {
  saveState(stateFile, snapshot(root));
  respond({});
  process.exit(0);
}

if (mode === "stop") {
  const before = loadState(stateFile);
  const after = snapshot(root);
  saveState(stateFile, after);
  const changed = changedPaths(before, after).filter(isCodePath);
  if (changed.length === 0) {
    respond({});
    process.exit(0);
  }
  const result = validate(root, changed);
  if (result.ok) {
    respond({});
    process.exit(0);
  }
  respond({ decision: "block", reason: `Quality gate failed: ${result.message}` });
  process.exit(0);
}

if (mode === "pre-commit") {
  const command = String(input.tool_input?.command ?? "");
  if (!/\bgit\s+commit\b/.test(command)) {
    respond({});
    process.exit(0);
  }
  const changed = Object.keys(snapshot(root)).filter(isCodePath);
  const result = validate(root, changed, true);
  if (result.ok) {
    respond({});
    process.exit(0);
  }
  respond({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Commit blocked: ${result.message}`,
    },
  });
  process.exit(0);
}

throw new Error("Expected mode: session-start, stop, or pre-commit");

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

function gitRoot(cwd) {
  const result = run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (result.status !== 0) throw new Error("Hook must run inside a Git worktree");
  return result.stdout.trim();
}

function snapshot(rootPath) {
  const result = run("git", ["-C", rootPath, "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (result.status !== 0) throw new Error(result.stderr || "Unable to inspect Git status");
  const paths = [];
  for (const entry of result.stdout.split("\0")) {
    if (/^[ MADRCU?!]{2} /.test(entry)) paths.push(entry.slice(3));
  }
  return Object.fromEntries(paths.filter(isCodePath).sort().map((path) => [path, fileHash(rootPath, path)]));
}

function changedPaths(before = {}, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((path) => before[path] !== after[path]);
}

function isCodePath(path) {
  return /^(src|test|ui|\.github\/workflows)\//.test(path) || ["package.json", "package-lock.json", "tsconfig.json", "cordis.patch.yml"].includes(path);
}

function isCriticalPath(path) {
  return path === "package.json" || path === "package-lock.json" || path === "cordis.patch.yml" ||
    path.startsWith(".github/workflows/") ||
    /^src\/(approval|execution|executor|git-ops|human-gate|process-runner|subprocess-adapter|tools|validation|web|workspace-policy|worktree)/.test(path);
}

function fileHash(rootPath, path) {
  const absolute = resolve(rootPath, path);
  return existsSync(absolute) ? hash(readFileSync(absolute)) : "<deleted>";
}

function validate(rootPath, changed, finalCheck = false) {
  if (changed.some(isCriticalPath)) {
    const security = run("node", [join(rootPath, ".codex", "hooks", "security-scan.mjs")], rootPath);
    if (security.status !== 0) return { ok: false, message: `security scan failed. ${tail(`${security.stdout ?? ""}\n${security.stderr ?? ""}`)}` };
  }
  const checks = [["npm run lint", "npm", ["run", "lint"]], ["npm test", "npm", ["test"]]];
  for (const [label, command, args] of checks) {
    const result = run(command, args, rootPath);
    if (result.status !== 0) return { ok: false, message: `${label} failed. ${tail(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)}` };
  }
  return { ok: true, message: finalCheck ? "final validation passed" : "changed-code validation passed" };
}

function run(command, args, cwd) {
  if (command === "npm") {
    const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    return spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: "utf8" });
  }
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

function tail(text = "") {
  return text.replace(/\s+/g, " ").trim().slice(-500) || "See command output for details.";
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function loadState(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function saveState(path, state) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(state));
}

function respond(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
