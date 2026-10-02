#!/usr/bin/env node
/**
 * Executes the bounded BLOCK safe-lane mutation against the current sample
 * Worker. The focused fixture has a real safe checkpoint below a retained
 * FULL frontier, so removing the bounded calls must turn it red.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const sourceFile = "samples/meeting-room/src/worker.cloudflare-only.ts";
const mutation = Object.freeze({
  label: "omit-bounded-BLOCK-safe-lane",
  from: "      await input.catchUp(coverage.frontierSuid);\n      await input.drainUnsafeKicks(coverage.frontierSuid);",
  to: "      // SDT-G58 mutant: BLOCK incorrectly skips the bounded safe lane.",
  oracle: "continues a BLOCK tick through only the retained FULL frontier and never passes an unproven event",
});

function fail(message) {
  throw new Error(`SDT-G58 safe-lane mutation runner: ${message}`);
}

function mutate(source) {
  const occurrences = source.split(mutation.from).length - 1;
  if (occurrences !== 1) fail(`expected one bounded BLOCK anchor in ${sourceFile}, found ${occurrences}`);
  return source.replace(mutation.from, mutation.to);
}

function run(args, label) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  return { label, status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function requirePass(result) {
  if (result.status === 0) return;
  fail(`${result.label} unexpectedly failed:\n${result.output}`);
}

function requireRed(result) {
  if (result.status !== 0) return;
  fail(`${mutation.label} was vacuous: ${mutation.oracle} remained green`);
}

function oracle() {
  return run([
    resolve(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config", "vitest.config.ts",
    "--no-cache",
    "test/g58-safe-lane.spec.ts",
    "--testNamePattern", mutation.oracle,
  ], "G58 retained-frontier oracle");
}

function main() {
  const original = readFileSync(resolve(root, sourceFile), "utf8");
  if (process.argv.includes("--self-test")) {
    mutate(original);
    process.stdout.write(`${JSON.stringify({ selfTest: "g58-production-mutation-anchor-unique" })}\n`);
    return;
  }
  try {
    requirePass(oracle());
    writeFileSync(resolve(root, sourceFile), mutate(original), "utf8");
    const mutant = oracle();
    requireRed(mutant);
    process.stdout.write(`${JSON.stringify({ check: "g58-safe-lane-mutation-runner", mutants: [{ label: mutation.label, baselineExitCode: 0, mutantExitCode: mutant.status, result: "red" }] })}\n`);
  } finally {
    writeFileSync(resolve(root, sourceFile), original, "utf8");
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
