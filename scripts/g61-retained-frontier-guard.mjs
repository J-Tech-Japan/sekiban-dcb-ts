#!/usr/bin/env node
/**
 * SDT-G61 AC3 regression guard.
 *
 * The behavioral oracle intentionally lives in the existing G58 W112
 * advancement test. This named G61 wrapper records the red-before-green
 * omission of the non-FULL retained frontier and keeps the G44 fence contract
 * exercised by that same two-projector test.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const sourceFile = "packages/dcb-runtime/src/cloudflare.ts";
const testFile = "test/g58-live-poll-advancement-repair.spec.ts";
const oracle = "G61 AC3 regression: a non-FULL reconcile advances registered projectors through its proven frontier";
const redReceipt = "test/fixtures/g61-retained-frontier-red-before-green.json";
const greenReceipt = "test/fixtures/g61-retained-frontier-green.json";
const mutantReceipt = "test/fixtures/g61-retained-frontier-mutant-red.json";
const mutation = Object.freeze({
  from: 'return scan.kind === "FULL" ? undefined : retainedFrontierSuid ?? null;',
  to: 'return scan.kind === "FULL" ? undefined : null;',
  name: "omit-non-full-retained-frontier",
});

function fail(message) {
  throw new Error(`SDT-G61 retained-frontier guard failed: ${message}`);
}

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function writeReceipt(path, value) {
  const target = resolve(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function mutate(source) {
  const count = source.split(mutation.from).length - 1;
  if (count !== 1) fail(`${mutation.name} anchor expected once, found ${count}`);
  return source.replace(mutation.from, mutation.to);
}

function run(label) {
  const args = [
    "exec",
    "--",
    "vitest",
    "run",
    "--config", "vitest.config.ts",
    "--no-cache",
    "--maxWorkers=1",
    testFile,
    "--testNamePattern", oracle,
  ];
  const result = spawnSync("npm", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  return {
    label,
    command: ["npm", ...args].join(" "),
    exitCode: result.status ?? 1,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function assertAnchors() {
  const source = read(sourceFile);
  const test = read(testFile);
  if (!test.includes(oracle)) fail(`existing G58 advancement oracle is missing: ${oracle}`);
  if (!test.includes("scheduledLiveProjectionMaximumSuid({ kind: \"BLOCK\" }, proven.suid)")) {
    fail("oracle no longer derives the retained frontier from a non-FULL scan");
  }
  if (!test.includes("expect([...checkpoints.values()].every((checkpoint) => checkpoint.lastSuid === proven.suid)).toBe(true)")) {
    fail("oracle no longer proves both projector checkpoints reach only the proven frontier");
  }
  mutate(source);
}

function requirePass(result) {
  if (result.exitCode === 0) return;
  fail(`${result.label} unexpectedly failed:\n${result.stdout}${result.stderr}`);
}

function requireRed(result, label) {
  if (result.exitCode !== 0) return;
  fail(`${label} unexpectedly stayed green`);
}

function preFix() {
  const path = resolve(root, sourceFile);
  const original = read(sourceFile);
  let result;
  try {
    writeFileSync(path, mutate(original), "utf8");
    result = run("G61 retained-frontier omission red-before-green");
  } finally {
    writeFileSync(path, original, "utf8");
  }
  requireRed(result, mutation.name);
  writeReceipt(redReceipt, {
    schema: "sdt-g61-retained-frontier-red-before-green/v1",
    status: "red-before-green",
    expectedFailure: true,
    sourceFile,
    testFile,
    oracle,
    mutation,
    ...result,
  });
  process.stdout.write(`${JSON.stringify({ result: "g61-retained-frontier-red-before-green", receipt: redReceipt, exitCode: result.exitCode })}\n`);
}

function green() {
  if (!existsSync(resolve(root, redReceipt))) fail(`missing preserved red receipt ${redReceipt}`);
  const prior = JSON.parse(read(redReceipt));
  if (prior.status !== "red-before-green" || prior.expectedFailure !== true || prior.exitCode === 0) {
    fail(`invalid preserved red receipt ${redReceipt}`);
  }
  assertAnchors();
  const greenResult = run("G61 retained-frontier baseline");
  requirePass(greenResult);

  const path = resolve(root, sourceFile);
  const original = read(sourceFile);
  let mutantResult;
  try {
    writeFileSync(path, mutate(original), "utf8");
    mutantResult = run("G61 retained-frontier omission mutant");
  } finally {
    writeFileSync(path, original, "utf8");
  }
  requireRed(mutantResult, mutation.name);

  writeReceipt(greenReceipt, {
    schema: "sdt-g61-retained-frontier-green/v1",
    status: "green",
    sourceFile,
    testFile,
    oracle,
    baseline: greenResult,
    preservedRedReceipt: redReceipt,
    mutantReceipt,
  });
  writeReceipt(mutantReceipt, {
    schema: "sdt-g61-retained-frontier-mutant-red/v1",
    status: "red",
    mutation,
    oracle,
    ...mutantResult,
  });
  process.stdout.write(`${JSON.stringify({ result: "g61-retained-frontier-green-and-mutant-red", greenReceipt, mutantReceipt, mutantExitCode: mutantResult.exitCode })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) {
    assertAnchors();
    process.stdout.write(`${JSON.stringify({ selfTest: "g61-retained-frontier-anchors-unique", mutation: mutation.name })}\n`);
    return;
  }
  if (process.argv.includes("--pre-fix")) {
    preFix();
    return;
  }
  green();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
