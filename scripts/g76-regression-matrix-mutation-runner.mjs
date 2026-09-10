#!/usr/bin/env node
/**
 * Prove the G76 outcome matrix is behavioral rather than a source-shape
 * check. Each temporary CommitWorker mutation is exercised by one focused
 * public-response/durable-facts oracle and the source is restored in finally.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");
const sourceFile = "packages/dcb-runtime/src/commit/CommitWorker.ts";

export const G76_MUTATIONS = Object.freeze([
  {
    fact: "recognized_partial_write_becomes_unknown",
    from: "return this.partialWriteOutcome(input, allocatedCandidates, writes, attemptId, fault !== undefined);",
    to: "return this.noApplicationOutcome(attemptId, true);",
    oracle: "AC3 mutant target: a recognized partial write remains definite and non-retryable",
  },
  {
    fact: "incomplete_fence_acknowledgement_becomes_partial_write",
    from: "if (!await this.installPartialWriteFences(writes.pendingTags, attemptId, traceState?.scope)) {",
    to: "if (false) {",
    oracle: "AC3 mutant target: an incomplete fence acknowledgement remains unknown",
  },
  {
    fact: "partial_write_retryable_flips_true",
    from: "retryable: false,",
    to: "retryable: true,",
    oracle: "AC3 mutant target: partial.retryable remains false",
  },
  {
    fact: "all_pending_fences_weaken_to_any_one",
    from: "return installed.every((result) => result.status === \"fulfilled\" && result.value);",
    to: "return installed.some((result) => result.status === \"fulfilled\" && result.value);",
    oracle: "AC3 mutant target: every pending participant fence is required",
  },
]);

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  return { label, status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function requirePass(result) {
  if (result.status !== 0) throw new Error(`${result.label} unexpectedly failed:\n${result.output}`);
}

function requireRed(result, mutation) {
  if (result.status === 0) throw new Error(`${mutation.fact} mutation was vacuous: focused oracle stayed green`);
}

function mutate(original, mutation) {
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) {
    throw new Error(`${mutation.fact} anchor expected once in ${sourceFile}, found ${occurrences}`);
  }
  return original.replace(mutation.from, mutation.to);
}

function oracle(mutation) {
  return run(process.execPath, [
    vitest,
    "run",
    "--config",
    "vitest.config.ts",
    "--no-cache",
    "--maxWorkers=1",
    "test/g76-regression-matrix.spec.ts",
    "--testNamePattern",
    mutation.oracle,
  ], `G76 focused public oracle (${mutation.fact})`);
}

function runMutation(mutation) {
  const sourcePath = resolve(root, sourceFile);
  const original = readFileSync(sourcePath, "utf8");
  try {
    requirePass(oracle(mutation));
    writeFileSync(sourcePath, mutate(original, mutation), "utf8");
    const red = oracle(mutation);
    requireRed(red, mutation);
    return { fact: mutation.fact, result: "behavioral-mutant-red", output: red.output };
  } finally {
    writeFileSync(sourcePath, original, "utf8");
  }
}

function selfTest() {
  const original = readFileSync(resolve(root, sourceFile), "utf8");
  for (const mutation of G76_MUTATIONS) mutate(original, mutation);
  process.stdout.write(`${JSON.stringify({ sourceFile, mutations: G76_MUTATIONS.map(({ fact }) => fact), selfTest: "anchors-unique" })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const rows = G76_MUTATIONS.map(runMutation);
  process.stdout.write(`${JSON.stringify({ result: "all-g76-behavioral-mutants-red", rows })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
