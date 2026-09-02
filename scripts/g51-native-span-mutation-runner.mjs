#!/usr/bin/env node
/**
 * Proves the G51 fake-native-tracer guard is independently red when the S00
 * root skips native span entry. The source is restored in the finally block;
 * snapshots and commit semantics remain the unrelated oracle.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");
const sourceFile = "packages/dcb-runtime/src/trace/CommitTrace.ts";
const mutation = Object.freeze({
  from: "    return native === undefined\n      ? execute(undefined)\n      : this.enterNativeSpan(native, row.span, execute);",
  to: "    return native === undefined || rowId === \"S00\"\n      ? execute(undefined)\n      : this.enterNativeSpan(native, row.span, execute);",
});
const guardTitle = "G51 guard: enters every mapped Worker S-row with its native row id on one successful serialized commit";
const unrelatedTitle = "emits every caller-owned success row from the real CommitWorker path";

function fail(message) {
  throw new Error(`g51-native-span-mutation-runner:${message}`);
}

function run(title) {
  const result = spawnSync(process.execPath, [
    vitest,
    "run",
    "--config", "vitest.config.ts",
    "test/g30-trace.spec.ts",
    "--testNamePattern", title,
  ], { cwd: root, encoding: "utf8", env: { ...process.env, CI: "1" } });
  return Object.freeze({ status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` });
}

function requirePass(result, label) {
  if (result.status === 0) return;
  fail(`${label} unexpectedly failed:\n${result.output}`);
}

function requireRed(result, label) {
  if (result.status !== 0) return;
  fail(`${label} mutant was vacuous`);
}

export function skipNativeRootSpan(source) {
  const occurrences = source.split(mutation.from).length - 1;
  if (occurrences !== 1) fail(`expected one native root entry anchor, found ${occurrences}`);
  return source.replace(mutation.from, mutation.to);
}

function selfTest() {
  const mutated = skipNativeRootSpan(`before\n${mutation.from}\nafter`);
  if (!mutated.includes(mutation.to) || mutated.includes(mutation.from)) fail("self-test mutation did not replace its anchor");
  return { anchor: "unique", result: "root-span-omission-mutant-ready" };
}

function main() {
  if (process.argv.includes("--self-test")) {
    process.stdout.write(`${JSON.stringify(selfTest())}\n`);
    return;
  }
  const path = resolve(root, sourceFile);
  const original = readFileSync(path, "utf8");
  try {
    requirePass(run(guardTitle), "G51 native-span guard baseline");
    requirePass(run(unrelatedTitle), "G51 unrelated commit-semantics oracle baseline");
    writeFileSync(path, skipNativeRootSpan(original), "utf8");
    requireRed(run(guardTitle), "G51 native-root omission");
    requirePass(run(unrelatedTitle), "G51 unrelated commit-semantics oracle mutant");
  } finally {
    writeFileSync(path, original, "utf8");
  }
  process.stdout.write(`${JSON.stringify({
    result: "g51-native-root-omission-mutant-red",
    guard: guardTitle,
    unrelatedOracle: unrelatedTitle,
  })}\n`);
}

main();
