#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPublishFailure } from "./npm-publish-dry-run-classifier.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageName = "@sekiban/dcb-domain";
const packageDirectory = resolve(root, "packages/dcb-domain");
const publishArgs = ["publish", "--dry-run", "--provenance", "--access", "public"];

function command() {
  return ["npm", ...publishArgs].join(" ");
}

function selfTest() {
  assert.deepEqual(publishArgs, ["publish", "--dry-run", "--provenance", "--access", "public"]);
  console.log(JSON.stringify({
    status: "PASS",
    guard: "dcb-domain-publish-dry-run",
    command: command(),
    failureClassifier: "npm-publish-dry-run-classifier",
  }, null, 2));
}

if (process.argv.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(resolve(packageDirectory, "package.json"), "utf8"));
const env = { ...process.env };
if (env.NPM_CONFIG_CACHE !== undefined) env.npm_config_cache = env.NPM_CONFIG_CACHE;
const result = spawnSync("npm", publishArgs, { cwd: packageDirectory, env, encoding: "utf8" });
const receipt = {
  package: packageName,
  version: manifest.version,
  cwd: "packages/dcb-domain",
  command: command(),
  head: process.env.GITHUB_SHA ?? null,
  runId: process.env.GITHUB_RUN_ID ?? null,
  workflow: process.env.GITHUB_WORKFLOW ?? null,
  status: result.status,
  signal: result.signal,
  stdout: result.stdout,
  stderr: result.stderr,
};
if (result.status !== 0) {
  const failure = classifyPublishFailure(result, { packageName, version: manifest.version });
  console.error(JSON.stringify({ status: "FAIL", failure, receipt }, null, 2));
  process.exit(result.status ?? 1);
}
console.log(JSON.stringify({ status: "PASS", receipt }, null, 2));
