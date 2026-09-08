#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = [
  ["@sekiban/dcb-core", "packages/dcb-core"],
  ["@sekiban/dcb-domain", "packages/dcb-domain"],
  ["@sekiban/dcb-client", "packages/dcb-client"],
];
const command = "npm publish --dry-run --provenance --access public";
const receipts = [];

for (const [name, relativeDirectory] of packages) {
  const env = { ...process.env };
  if (env.NPM_CONFIG_CACHE !== undefined) env.npm_config_cache = env.NPM_CONFIG_CACHE;
  const result = spawnSync(
    "npm",
    ["publish", "--dry-run", "--provenance", "--access", "public"],
    { cwd: resolve(root, relativeDirectory), env, encoding: "utf8" },
  );
  const receipt = {
    package: name,
    cwd: relativeDirectory,
    command,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  receipts.push(receipt);
  if (result.status !== 0) {
    console.error(JSON.stringify({ status: "FAIL", receipt }, null, 2));
    process.exit(result.status ?? 1);
  }
}

console.log(JSON.stringify({
  status: "PASS",
  order: packages.map(([name]) => name),
  command,
  receipts,
}, null, 2));
