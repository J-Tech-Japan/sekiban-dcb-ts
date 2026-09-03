#!/usr/bin/env node
/**
 * SDT-G58 W97 same-tick green repair witness.
 *
 * The fixture is green after the W96 scheduling repair: a fresh G44 FULL
 * frontier is handed to the safe MV pass in the same tick. This runner also
 * checks that the committed W96 red receipt remains present, so the green
 * repair cannot silently erase the regression proof.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const testPath = "test/g58-safe-lane-diagnosis.spec.ts";
const workerPath = "samples/meeting-room/src/worker.cloudflare-only.ts";
const runtimePath = "packages/dcb-runtime/src/cloudflare.ts";
const baselineReportPath = ".artifacts/sdt-g58-w96-red-guard.json";
const reportPath = ".artifacts/sdt-g58-w97-green-guard.json";

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
  const runtime = read(runtimePath);
  requireContains(test, "W97 GREEN: applies a freshly scanned FULL frontier in the same scheduled tick", "green witness");
  requireContains(test, "freshCoverage", "fresh-frontier seam");
  requireContains(test, "last proven frontier", "BLOCK frontier witness");
  requireContains(worker, "await input.catchUp(coverage.frontierSuid);", "persisted frontier catch-up");
  requireContains(worker, "await input.runGenericScheduledWork();", "generic scheduled work ordering");
  requireContains(worker, "await input.drainUnsafeKicks(coverage.frontierSuid);", "frontier-fenced unsafe drain");
  requireContains(worker, "beforeLiveProjectionPoll", "runtime fresh-reconcile hook");
  requireContains(runtime, "await options.beforeLiveProjectionPoll?.", "runtime invokes fresh-reconcile hook");
  const baseline = JSON.parse(read(baselineReportPath));
  if (baseline.status !== "red-baseline" || baseline.exitCode === 0) fail("W96 red receipt is not preserved");
  const packageJson = read("package.json");
  requireContains(packageJson, '"diagnose:g58"', "diagnosis package lane");
  process.stdout.write(`${JSON.stringify({ selfTest: "g58-same-tick-frontier-green-witness", baseline: baselineReportPath })}\n`);
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
  const baseline = JSON.parse(read(baselineReportPath));
  const evidence = {
    schema: "sdt-g58-w97-green-guard/v1",
    status: result.status === 0 ? "green" : "unexpected-red",
    command,
    exitCode: result.status,
    signal: result.signal,
    baselineRedReceipt: {
      report: baselineReportPath,
      status: baseline.status,
      exitCode: baseline.exitCode,
    },
    stdout,
    stderr,
  };
  mkdirSync(resolve(root, ".artifacts"), { recursive: true });
  writeFileSync(resolve(root, reportPath), `${JSON.stringify(evidence, null, 2)}\n`);
  if (result.status !== 0) fail(`same-tick frontier witness remains red (exit ${result.status}); inspect ${reportPath}`);
  process.stdout.write(`${JSON.stringify({ guard: "g58-w97-same-tick-frontier", status: "green", report: reportPath, baseline: baselineReportPath, exitCode: result.status })}\n`);
}

if (process.argv.includes("--self-test")) selfTest();
else runWitness();
