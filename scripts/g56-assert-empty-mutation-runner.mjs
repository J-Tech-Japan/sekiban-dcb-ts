#!/usr/bin/env node
/**
 * Mutates the empty-head branch back to unconditional SUID validation and
 * proves the focused G56 runtime oracle turns red. The source is restored in
 * finally, so this guard cannot leave a mutant in the checkout.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const sourceFile = "packages/dcb-runtime/src/commit/CommitWorker.ts";
const from = 'if (rawTag.lastSortableUniqueId !== "") {';
const to = "if (true) {";
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");

function run() {
  const result = spawnSync(process.execPath, [
    vitest,
    "run",
    "--config", "vitest.config.ts",
    "test/g56-assert-empty.spec.ts",
    "--reporter=dot",
  ], { cwd: root, encoding: "utf8", env: { ...process.env, CI: "1" } });
  return { status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function requirePass(result) {
  if (result.status !== 0) throw new Error(`G56 focused oracle unexpectedly failed:\n${result.output}`);
}

function main() {
  const path = resolve(root, sourceFile);
  const original = readFileSync(path, "utf8");
  if (original.split(from).length - 1 !== 1) throw new Error("G56 empty-head mutation anchor was not unique");
  try {
    requirePass(run());
    writeFileSync(path, original.replace(from, to), "utf8");
    const mutant = run();
    if (mutant.status === 0) throw new Error("G56 empty-head omission mutant was vacuous");
    process.stdout.write(`${JSON.stringify({ result: "g56-empty-head-omission-mutant-red", focusedStatus: mutant.status, receipt: "focused oracle failed under unconditional SUID validation" })}\n`);
  } finally {
    writeFileSync(path, original, "utf8");
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
