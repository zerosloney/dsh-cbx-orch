import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface PackageMetadata { version?: unknown; }

const packageFile = [new URL("../../package.json", import.meta.url), new URL("../package.json", import.meta.url)]
  .map(url => fileURLToPath(url))
  .find(file => existsSync(file));
if (!packageFile) throw new Error("无法定位 cbx-orch package.json");
const metadata = JSON.parse(readFileSync(packageFile, "utf8")) as PackageMetadata;

if (typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(metadata.version)) {
  throw new Error(`package.json 包含无效版本：${String(metadata.version)}`);
}

/** Runtime and protocol metadata use package.json as the single source of truth. */
export const APP_VERSION = metadata.version;
