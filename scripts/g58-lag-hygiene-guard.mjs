#!/usr/bin/env node
/**
 * SDT-G58 AC4 lag-estimate hygiene guard.
 *
 * The oracle is the D1-backed safe-lane fixture: once the last arrival is
 * older than its estimate, the current estimate must decay to zero and the
 * wire-visible SafeWindow must return to the published 20-second floor. The
 * source mutation removes that decay; the oracle must then go red. The full
 * child-process output is retained as a reviewable red receipt.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const sourceFile = "packages/dcb-runtime/src/safeWindow.ts";
const reportFile = ".artifacts/ci-local/g58-lag-hygiene.json";
const mutation = Object.freeze({
  from: "  return Math.max(0, estimateMs - elapsed);",
  to: "  return Math.max(0, estimateMs);",
  oracle: "decays a retired lag estimate back to the published 20-second safe-window floor after one decay interval when arrivals stop",
});

function fail(message) {
  throw new Error(`SDT-G58 AC4 lag-hygiene guard failed: ${message}`);
}

function mutate(source) {
  const occurrences = source.split(mutation.from).length - 1;
  if (occurrences !== 1) fail(`expected one linear-decay anchor in ${sourceFile}, found ${occurrences}`);
  return source.replace(mutation.from, mutation.to);
}

function runOracle() {
  const result = spawnSync(process.execPath, [
    resolve(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config", "vitest.config.ts",
    "--no-cache",
    "test/g58-safe-lane.spec.ts",
    "--testNamePattern", mutation.oracle,
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
  });
  return {
    exitCode: result.status ?? 1,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function main() {
  const absoluteSource = resolve(root, sourceFile);
  const original = readFileSync(absoluteSource, "utf8");
  if (process.argv.includes("--self-test")) {
    mutate(original);
    process.stdout.write(`${JSON.stringify({ selfTest: "g58-lag-decay-mutation-anchor-unique" })}\n`);
    return;
  }

  const baseline = runOracle();
  if (baseline.exitCode !== 0) fail(`lag-floor oracle is red before mutation (exit ${baseline.exitCode})`);

  let mutant;
  try {
    writeFileSync(absoluteSource, mutate(original), "utf8");
    mutant = runOracle();
  } finally {
    writeFileSync(absoluteSource, original, "utf8");
  }
  if (readFileSync(absoluteSource, "utf8") !== original) fail("source mutation was not restored");
  if (mutant.exitCode === 0) fail("stale-estimate mutation unexpectedly remained green");

  mkdirSync(resolve(root, ".artifacts/ci-local"), { recursive: true });
  const evidence = {
    schema: "sdt-g58-ac4-lag-hygiene/v1",
    status: "red-mutant",
    sourceFile,
    mutation: { from: mutation.from, to: mutation.to },
    oracle: { testFile: "test/g58-safe-lane.spec.ts", testName: mutation.oracle },
    baseline,
    mutant,
    restored: true,
  };
  writeFileSync(resolve(root, reportFile), `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ guard: "g58-lag-hygiene", status: "pass", report: reportFile, mutantExitCode: mutant.exitCode })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
