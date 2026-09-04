#!/usr/bin/env node
/**
 * Local SDT-G62 AC1–AC3 guard.
 *
 * The pre-fix mode is run once on the preserved current-main implementation
 * and records the real reconciler's red AC1 receipt. The normal mode runs the
 * green runtime oracles and then applies two temporary production mutations:
 * restoring discard-the-whole-pass and removing the local contiguity check.
 * Each mutant must make its focused oracle red, and every source mutation is
 * restored in a finally block.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");
const sourceFile = "packages/dcb-runtime/src/completeness/GlobalCompletenessReconciler.ts";
const testFile = "test/g62-global-completeness.spec.ts";
const redReceipt = "test/fixtures/g62-ac1-red-before-green.json";
const greenReceipt = "test/fixtures/g62-ac3-green.json";
const mutantReceipt = "test/fixtures/g62-ac3-mutants-red.json";

const mutations = Object.freeze([
  {
    name: "restore-discard-the-whole-pass",
    sourceFile,
    from: "      this.assertStartPartitionsRetained(snapshots, endSnapshots);",
    to: "      this.assertSnapshotUniverseUnchanged(snapshots, endSnapshots);",
    oracle: "AC1: sustained new source-partition stream settles the start-of-pass frontier",
    expectedReason: "source_partition_set_changed_during_scan",
  },
  {
    name: "remove-start-partition-contiguity-check",
    sourceFile,
    from: "if (obligation.obligationSequence !== afterSequence + 1 || obligation.obligationSequence > snapshot.upperBoundSequence)",
    to: "if (obligation.obligationSequence > snapshot.upperBoundSequence)",
    oracle: "AC3: a gap in a start-of-pass partition prevents frontier advancement",
    expectedReason: "source_page_sequence_outside_snapshot",
  },
]);

function fail(message) {
  throw new Error(`SDT-G62 local guard: ${message}`);
}

function runVitest(testNamePattern, label) {
  const args = [
    vitest,
    "run",
    "--config", "vitest.config.ts",
    "--no-cache",
    "--maxWorkers=1",
    testFile,
    "--testNamePattern", testNamePattern,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  return {
    label,
    command: [process.execPath, ...args].join(" "),
    status: result.status ?? 1,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function writeReceipt(relativePath, receipt) {
  const path = resolve(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

function extractAc1Observations(result) {
  const line = `${result.stdout}\n${result.stderr}`.split("\n")
    .find((candidate) => candidate.startsWith("G62_AC1_OBSERVATIONS "));
  if (line === undefined) return null;
  try {
    return JSON.parse(line.slice("G62_AC1_OBSERVATIONS ".length));
  } catch {
    return { parseError: true, raw: line };
  }
}

function occurrences(source, fragment) {
  return source.split(fragment).length - 1;
}

function mutate(source, mutation) {
  const count = occurrences(source, mutation.from);
  if (count !== 1) fail(`${mutation.name} anchor expected once, found ${count}`);
  return source.replace(mutation.from, mutation.to);
}

function requirePass(result) {
  if (result.status === 0) return;
  fail(`${result.label} unexpectedly failed:\n${result.output}`);
}

function requireRed(result, mutation) {
  if (result.status !== 0) return;
  fail(`${mutation.name} was vacuous: ${mutation.expectedReason} oracle stayed green`);
}

function selfTest() {
  const source = readFileSync(resolve(root, sourceFile), "utf8");
  for (const mutation of mutations) mutate(source, mutation);
  const test = readFileSync(resolve(root, testFile), "utf8");
  if (!test.includes("AC1: sustained new source-partition stream settles the start-of-pass frontier")) {
    fail("AC1 runtime oracle is missing");
  }
  if (!test.includes("AC3: a gap in a start-of-pass partition prevents frontier advancement")) {
    fail("AC3 runtime oracle is missing");
  }
  process.stdout.write(`${JSON.stringify({ selfTest: "g62-anchors-unique", mutations: mutations.map(({ name }) => name)})}\n`);
}

function preFix() {
  const result = runVitest(mutations[0].oracle, "AC1 current-main red reproduction");
  const observations = extractAc1Observations(result);
  const receipt = {
    schema: "sdt-g62-w132-ac1-red-receipt/v1",
    status: result.status === 0 ? "unexpected-green" : "red-before-green",
    expectedFailure: result.status !== 0,
    command: result.command,
    exitCode: result.status,
    signal: result.signal,
    observations,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  writeReceipt(redReceipt, receipt);
  if (result.status === 0) fail("current-main AC1 reproduction was unexpectedly green; red receipt is not valid");
  process.stdout.write(`${JSON.stringify({ result: "g62-ac1-red-before-green", receipt: redReceipt, observations })}\n`);
}

function runMutation(mutation) {
  const path = resolve(root, mutation.sourceFile);
  const original = readFileSync(path, "utf8");
  try {
    requirePass(runVitest(mutation.oracle, `${mutation.name} baseline`));
    writeFileSync(path, mutate(original, mutation), "utf8");
    const mutant = runVitest(mutation.oracle, `${mutation.name} mutant`);
    requireRed(mutant, mutation);
    return {
      name: mutation.name,
      status: "red",
      expectedReason: mutation.expectedReason,
      command: mutant.command,
      exitCode: mutant.status,
      stdout: mutant.stdout,
      stderr: mutant.stderr,
    };
  } finally {
    writeFileSync(path, original, "utf8");
  }
}

function green() {
  const priorRed = resolve(root, redReceipt);
  if (!existsSync(priorRed)) fail(`missing preserved red receipt ${redReceipt}`);
  const prior = JSON.parse(readFileSync(priorRed, "utf8"));
  if (prior.status !== "red-before-green" || prior.expectedFailure !== true || prior.exitCode === 0) {
    fail(`invalid preserved red receipt ${redReceipt}`);
  }

  const greenResult = runVitest("AC1: sustained new source-partition stream settles the start-of-pass frontier|AC3: a gap in a start-of-pass partition prevents frontier advancement", "G62 AC1/AC3 green oracles");
  requirePass(greenResult);
  const rows = mutations.map(runMutation);
  writeReceipt(greenReceipt, {
    schema: "sdt-g62-w132-ac3-green-receipt/v1",
    status: "green",
    command: greenResult.command,
    exitCode: greenResult.status,
    stdout: greenResult.stdout,
    stderr: greenResult.stderr,
    preservedRedReceipt: redReceipt,
    mutantReceipts: mutantReceipt,
  });
  writeReceipt(mutantReceipt, {
    schema: "sdt-g62-w132-mutant-receipts/v1",
    status: "all-required-mutants-red",
    rows,
  });
  process.stdout.write(`${JSON.stringify({ result: "g62-ac1-ac3-green-and-mutants-red", greenReceipt, mutantReceipt, rows })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  if (process.argv.includes("--pre-fix")) return preFix();
  return green();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
