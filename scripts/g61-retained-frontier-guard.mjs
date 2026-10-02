#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const sourceFile = "packages/dcb-runtime/src/cloudflare.ts";
const testFile = "test/g58-live-poll-advancement-repair.spec.ts";
const oracle = "G61 AC3 regression: a non-FULL reconcile advances registered projectors through its proven frontier";
const mutation = Object.freeze({
  label: "omit-non-full-retained-frontier",
  from: 'return scan.kind === "FULL" ? undefined : retainedFrontierSuid ?? null;',
  to: 'return scan.kind === "FULL" ? undefined : null;',
});

function fail(message) {
  throw new Error(`SDT-G61 retained-frontier check failed: ${message}`);
}

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function replaceOnce(source) {
  const count = source.split(mutation.from).length - 1;
  if (count !== 1) fail(`${mutation.label} anchor expected once, found ${count}`);
  return source.replace(mutation.from, mutation.to);
}

function run(label) {
  const args = [
    "run",
    "--config", "vitest.config.ts",
    "--no-cache",
    "--maxWorkers=1",
    testFile,
    "--testNamePattern", oracle,
  ];
  const result = spawnSync(process.execPath, [resolve(root, "node_modules/vitest/vitest.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    label,
    exitCode: result.status ?? 1,
    signal: result.signal,
    stdoutBytes: Buffer.byteLength(result.stdout ?? ""),
    stderrBytes: Buffer.byteLength(result.stderr ?? ""),
  };
}

function requirePass(result) {
  if (result.exitCode === 0) return;
  fail(`${result.label} unexpectedly failed (exit ${result.exitCode})`);
}

function requireRed(result) {
  if (result.exitCode !== 0) return;
  fail(`${mutation.label} unexpectedly stayed green`);
}

function assertAnchors() {
  const source = read(sourceFile);
  const test = read(testFile);
  if (!test.includes(oracle)) fail(`G61 oracle is missing: ${oracle}`);
  if (!test.includes("scheduledLiveProjectionMaximumSuid({ kind: \"BLOCK\" }, proven.suid)")) {
    fail("the oracle no longer derives a retained frontier from a non-FULL scan");
  }
  if (!test.includes("expect([...checkpoints.values()].every((checkpoint) => checkpoint.lastSuid === proven.suid)).toBe(true)")) {
    fail("the oracle no longer proves both projectors stop at the proven frontier");
  }
  replaceOnce(source);
}

function main() {
  const sourcePath = resolve(root, sourceFile);
  const original = read(sourceFile);
  assertAnchors();
  if (process.argv.includes("--self-test")) {
    process.stdout.write(`${JSON.stringify({ check: "g61-retained-frontier", mutants: [{ label: mutation.label, result: "anchor-pass" }] })}\n`);
    return;
  }

  const baseline = run("G61 retained-frontier baseline");
  requirePass(baseline);
  let mutant;
  try {
    writeFileSync(sourcePath, replaceOnce(original), "utf8");
    mutant = run("G61 retained-frontier mutant");
  } finally {
    writeFileSync(sourcePath, original, "utf8");
  }
  if (read(sourceFile) !== original) fail("source mutation was not restored");
  requireRed(mutant);
  process.stdout.write(`${JSON.stringify({
    check: "g61-retained-frontier",
    mutants: [{ label: mutation.label, oracle: `${testFile} :: ${oracle}`, baselineExitCode: baseline.exitCode, mutantExitCode: mutant.exitCode, result: "red" }],
  })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
