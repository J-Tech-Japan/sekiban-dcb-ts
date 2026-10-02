#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");
const testFile = "test/g62-global-completeness.spec.ts";
const mutations = Object.freeze([
  {
    label: "restore-discard-the-whole-pass",
    sourceFile: "packages/dcb-runtime/src/completeness/GlobalCompletenessReconciler.ts",
    from: "      this.assertStartPartitionsRetained(snapshots, endSnapshots);",
    to: "      this.assertSnapshotUniverseUnchanged(snapshots, endSnapshots);",
    pattern: "AC1: sustained new source-partition stream settles the start-of-pass frontier",
    reason: "the start-of-pass frontier must survive a sustained new partition stream",
  },
  {
    label: "remove-start-partition-contiguity-check",
    sourceFile: "packages/dcb-runtime/src/completeness/GlobalCompletenessReconciler.ts",
    from: "if (obligation.obligationSequence !== afterSequence + 1 || obligation.obligationSequence > snapshot.upperBoundSequence)",
    to: "if (obligation.obligationSequence > snapshot.upperBoundSequence)",
    pattern: "AC3: a gap in a start-of-pass partition prevents frontier advancement",
    reason: "a start-of-pass partition gap must block frontier advancement",
  },
  {
    label: "omit-delivery-cursor-membership-check",
    sourceFile: "packages/dcb-runtime/src/downstream/DownstreamAdapter.ts",
    from: `new GlobalCompletenessReconciler(env.D1!, env.TAG!).coverageForObligation(
          message.serviceId,
          message.tag,
          message.completeness.obligationSequence,
          arrivedAt,
        )`,
    to: "new GlobalCompletenessReconciler(env.D1!, env.TAG!).coverage(message.serviceId, arrivedAt)",
    pattern: "AC2: cursor-aware admission blocks a committed post-snapshot obligation until a later scan includes it",
    reason: "delivery admission must verify the obligation against the settled cursor",
  },
]);

function fail(message) {
  throw new Error(`SDT-G62 local check failed: ${message}`);
}

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function replaceOnce(source, mutation) {
  const count = source.split(mutation.from).length - 1;
  if (count !== 1) fail(`${mutation.label} anchor expected once, found ${count}`);
  return source.replace(mutation.from, mutation.to);
}

function runVitest(pattern, label) {
  const result = spawnSync(process.execPath, [
    vitest,
    "run",
    "--config", "vitest.config.ts",
    "--no-cache",
    "--maxWorkers=1",
    testFile,
    "--testNamePattern", pattern,
  ], {
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

function requireRed(result, mutation) {
  if (result.exitCode !== 0) return;
  fail(`${mutation.label} unexpectedly stayed green: ${mutation.reason}`);
}

function assertAnchors() {
  const test = read(testFile);
  for (const mutation of mutations) {
    replaceOnce(read(mutation.sourceFile), mutation);
    if (!test.includes(mutation.pattern)) fail(`${mutation.label} oracle is missing`);
  }
  if (!test.includes("G77 P14: fresh certificate must not pair with an older incompatible snapshot")) {
    fail("fresh-certificate compatibility case is missing");
  }
}

function runMutation(mutation) {
  const absolutePath = resolve(root, mutation.sourceFile);
  const original = read(mutation.sourceFile);
  const baseline = runVitest(mutation.pattern, `${mutation.label} baseline`);
  requirePass(baseline);
  let mutant;
  try {
    writeFileSync(absolutePath, replaceOnce(original, mutation), "utf8");
    mutant = runVitest(mutation.pattern, `${mutation.label} mutant`);
  } finally {
    writeFileSync(absolutePath, original, "utf8");
  }
  if (read(mutation.sourceFile) !== original) fail(`${mutation.label} source was not restored`);
  requireRed(mutant, mutation);
  return {
    label: mutation.label,
    oracle: `${testFile} :: ${mutation.pattern}`,
    baselineExitCode: baseline.exitCode,
    mutantExitCode: mutant.exitCode,
    result: "red",
  };
}

function main() {
  assertAnchors();
  if (process.argv.includes("--self-test")) {
    process.stdout.write(`${JSON.stringify({ check: "g62-local", mutants: mutations.map(({ label }) => ({ label, result: "anchor-pass" })) })}\n`);
    return;
  }
  const rows = mutations.map(runMutation);
  process.stdout.write(`${JSON.stringify({ check: "g62-local", mutants: rows })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
