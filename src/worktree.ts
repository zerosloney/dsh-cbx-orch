import path from "node:path";
import { cleanupRecordedWorktree } from "./git-ops.js";
import { jobDir } from "./state.js";

export async function cleanupWorktree(workspaceInput: string, jobId: string): Promise<boolean> {
  const workspace = path.resolve(workspaceInput);
  const directory = jobDir(workspace, jobId);
  return cleanupRecordedWorktree(workspace, directory);
}
