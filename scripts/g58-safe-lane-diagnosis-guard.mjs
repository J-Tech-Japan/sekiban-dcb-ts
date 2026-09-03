#!/usr/bin/env node
/**
 * SDT-G58 W96 diagnosis witness.
 *
 * The fixture is intentionally red against the current scheduler: a fresh
 * G44 FULL frontier is discovered by generic scheduled work only after the
 * safe MV pass has already consumed the previous persisted frontier. This
 * runner preserves that red output so a later green repair cannot silently
 * erase the regression proof.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const testPath = "test/g58-safe-lane-diagnosis.spec.ts";
const workerPath = "samples/meeting-room/src/worker.cloudflare-only.ts";
const reportPath = ".artifacts/sdt-g58-w96-red-guard.json";

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function fail(message) {
  throw new Error(`SDT-G58 W96 diagnosis guard failed: ${message}`);
}

function requireContains(value, expected, label) {
  if (!value.includes(expected)) fail(`${label} is missing ${JSON.stringify(expected)}`);
}

function selfTest() {
  const test = read(testPath);
  const worker = read(workerPath);
  requireContains(test, "W96 RED: applies a freshly scanned FULL frontier in the same scheduled tick", "red witness");
  requireContains(test, "freshFrontierAvailable", "fresh-frontier simulation");
  requireContains(worker, "await input.catchUp(coverage.frontierSuid);", "persisted frontier catch-up");
  requireContains(worker, "await input.runGenericScheduledWork();", "generic scheduled work ordering");
  requireContains(worker, "await input.drainUnsafeKicks(coverage.frontierSuid);", "frontier-fenced unsafe drain");
  const packageJson = read("package.json");
  requireContains(packageJson, '"diagnose:g58"', "diagnosis package lane");
  process.stdout.write(`${JSON.stringify({ selfTest: "g58-same-tick-frontier-red-witness" })}\n`);
}

function runWitness() {
  const command = "vitest run --config vitest.config.ts --no-file-parallelism --maxWorkers=1 " + testPath;
  const result = spawnSync("./node_modules/.bin/vitest", [
    "run",
    "--config",
    "vitest.config.ts",
    "--no-file-parallelism",
    "--maxWorkers=1",
    testPath,
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const evidence = {
    schema: "sdt-g58-w96-red-guard/v1",
    status: result.status === 0 ? "unexpected-green" : "red-baseline",
    command,
    exitCode: result.status,
    signal: result.signal,
    stdout,
    stderr,
  };
  mkdirSync(resolve(root, ".artifacts"), { recursive: true });
  writeFileSync(resolve(root, reportPath), `${JSON.stringify(evidence, null, 2)}\n`);
  if (result.status === 0) fail("same-tick frontier witness unexpectedly passed; update the diagnosis checkpoint");
  process.stdout.write(`${JSON.stringify({ guard: "g58-w96-same-tick-frontier", status: "red-baseline", report: reportPath, exitCode: result.status })}\n`);
}

if (process.argv.includes("--self-test")) selfTest();
else runWitness();
