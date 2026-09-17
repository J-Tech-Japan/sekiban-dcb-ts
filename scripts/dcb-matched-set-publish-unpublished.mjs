#!/usr/bin/env node
/**
 * Publish matched-set packages that are not yet on the registry.
 * Version collisions are treated as an allowed skip (already published).
 *
 * Do not import dcb-matched-set-publish-dry-run.mjs — that module runs on import.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPublishFailure } from "./npm-publish-dry-run-classifier.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const packages = (requested.length > 0 ? requested : ["dcb-runtime"]).map((name) => [
  `@sekiban/${name}`,
  `packages/${name}`,
]);
const privateRepository = process.env.REPO_IS_PRIVATE === "true" || process.env.PRIVATE_REPOSITORY === "true";
const dryRun = process.argv.includes("--dry-run");
const args = [
  "publish",
  ...(dryRun ? ["--dry-run"] : []),
  ...(privateRepository ? [] : ["--provenance"]),
  "--access",
  "public",
];
const env = { ...process.env };
if (privateRepository) env.NPM_CONFIG_PROVENANCE = "false";
if (env.NPM_CONFIG_CACHE !== undefined) env.npm_config_cache = env.NPM_CONFIG_CACHE;
if (process.env.UNSET_NODE_AUTH_TOKEN === "true") delete env.NODE_AUTH_TOKEN;

const receipts = [];
for (const [name, relativeDirectory] of packages) {
  const manifest = JSON.parse(readFileSync(resolve(root, relativeDirectory, "package.json"), "utf8"));
  const result = spawnSync("npm", args, {
    cwd: resolve(root, relativeDirectory),
    env,
    encoding: "utf8",
  });
  const receipt = {
    package: name,
    cwd: relativeDirectory,
    version: manifest.version,
    command: ["npm", ...args].join(" "),
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  if (result.status === 0) {
    receipt.outcome = dryRun ? "dry-run-ok" : "published";
    receipts.push(receipt);
    continue;
  }
  const failure = classifyPublishFailure(result, { packageName: name, version: manifest.version });
  if (failure.kind === "version-collision" && result.signal == null) {
    receipt.outcome = "version-already-published";
    receipt.failure = failure;
    receipts.push(receipt);
    continue;
  }
  console.error(JSON.stringify({ status: "FAIL", receipt, failure }, null, 2));
  process.exit(result.status ?? 1);
}

console.log(JSON.stringify({ status: "PASS", dryRun, privateRepository, receipts }, null, 2));
