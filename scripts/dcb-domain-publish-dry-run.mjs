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

export function evaluateFailedDryRun(result, { packageName: name, version, receiptExtras = {} } = {}) {
  const failure = classifyPublishFailure(result, { packageName: name, version });
  const receipt = {
    package: name,
    version,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    ...receiptExtras,
  };
  if (failure.kind === "version-collision") {
    receipt.classification = failure;
    return {
      exitCode: 0,
      output: {
        status: "PASS",
        guard: "dcb-domain-publish-dry-run",
        outcome: "version-already-published",
        failure,
        receipt,
      },
    };
  }
  return {
    exitCode: result.status ?? 1,
    output: { status: "FAIL", failure, receipt },
  };
}

function selfTest() {
  assert.deepEqual(publishArgs, ["publish", "--dry-run", "--provenance", "--access", "public"]);

  const collisionResult = {
    status: 1,
    signal: null,
    stdout: "",
    stderr: "npm error You cannot publish over the previously published versions: 0.2.0",
  };
  const collision = evaluateFailedDryRun(collisionResult, {
    packageName,
    version: "0.2.0",
    receiptExtras: { cwd: "packages/dcb-domain", command: command() },
  });
  assert.equal(collision.exitCode, 0, "version-collision must PASS");
  assert.equal(collision.output.status, "PASS");
  assert.equal(collision.output.outcome, "version-already-published");
  assert.equal(collision.output.failure.kind, "version-collision");

  const invalidPackagingResult = {
    status: 1,
    signal: null,
    stdout: "",
    stderr: "npm error code EJSONPARSE: Unexpected token in package.json (also saw a stale collision warning)",
  };
  const invalidPackaging = evaluateFailedDryRun(invalidPackagingResult, {
    packageName,
    version: "0.2.0",
  });
  assert.notEqual(invalidPackaging.exitCode, 0, "invalid-packaging must fail-closed");
  assert.equal(invalidPackaging.output.status, "FAIL");
  assert.equal(invalidPackaging.output.failure.kind, "invalid-packaging");

  const genericFailureResult = {
    status: 1,
    signal: null,
    stdout: "",
    stderr: "npm error code E401 Incorrect or missing password.",
  };
  const genericFailure = evaluateFailedDryRun(genericFailureResult, {
    packageName,
    version: "0.2.0",
  });
  assert.notEqual(genericFailure.exitCode, 0, "generic publish failure must fail-closed");
  assert.equal(genericFailure.output.status, "FAIL");
  assert.equal(genericFailure.output.failure.kind, "publish-or-environment-failure");

  console.log(JSON.stringify({
    status: "PASS",
    guard: "dcb-domain-publish-dry-run",
    command: command(),
    failureClassifier: "npm-publish-dry-run-classifier",
    fixtures: {
      versionCollision: { result: "pass", outcome: collision.output.outcome },
      invalidPackaging: { result: "fail", kind: invalidPackaging.output.failure.kind },
      genericFailure: { result: "fail", kind: genericFailure.output.failure.kind },
    },
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
const receiptExtras = {
  cwd: "packages/dcb-domain",
  command: command(),
  head: process.env.GITHUB_SHA ?? null,
  runId: process.env.GITHUB_RUN_ID ?? null,
  workflow: process.env.GITHUB_WORKFLOW ?? null,
};
if (result.status !== 0) {
  const evaluated = evaluateFailedDryRun(result, {
    packageName,
    version: manifest.version,
    receiptExtras,
  });
  const serialized = JSON.stringify(evaluated.output, null, 2);
  if (evaluated.exitCode === 0) {
    console.log(serialized);
  } else {
    console.error(serialized);
  }
  process.exit(evaluated.exitCode);
}
console.log(JSON.stringify({ status: "PASS", receipt: { ...receiptExtras, package: packageName, version: manifest.version, status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr } }, null, 2));
