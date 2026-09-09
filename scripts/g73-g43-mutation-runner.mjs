#!/usr/bin/env node
/**
 * G73's coordination proof: if the source scanner stops reporting pending
 * obligations, the focused AC6 finding assertion must turn red.  The mutant
 * is temporary and the source is restored and rebuilt in finally.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const sourceFile = "packages/dcb-runtime/src/tag/TagDurableObject.ts";
const mutationAnchor = "WHERE status <> 'acknowledged'";
const oracleTitle = "AC6: a due obligation inserted while delivery runs is retained and re-armed for the next handler";
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  return { label, status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function requirePass(result) {
  if (result.status === 0) return;
  throw new Error(`${result.label} unexpectedly failed:\n${result.output}`);
}

function requireRed(result) {
  if (result.status !== 0) return;
  throw new Error("G73 G43 finding-removal mutant was green; AC6 finding assertion is vacuous");
}

function build() {
  return run("npm", ["run", "build:packages", "--silent"], "build:packages");
}

function oracle() {
  return run(process.execPath, [
    vitest,
    "run",
    "--config", "vitest.config.ts",
    "--no-cache",
    "--maxWorkers=1",
    "test/g43-tag-sql.spec.ts",
    "--testNamePattern", oracleTitle,
  ], "G43 AC6 in-flight finding oracle");
}

function mutate(original) {
  const occurrences = original.split(mutationAnchor).length - 1;
  if (occurrences !== 1) {
    throw new Error(`G73 G43 mutation anchor expected once in ${sourceFile}, found ${occurrences}`);
  }
  return original.replace(mutationAnchor, "WHERE status = 'acknowledged'");
}

function selfTest() {
  const source = readFileSync(resolve(root, sourceFile), "utf8");
  if (source.split(mutationAnchor).length - 1 !== 1) {
    throw new Error(`G73 G43 mutation anchor expected once in ${sourceFile}`);
  }
  if (!oracleTitle.includes("obligation inserted") || !oracleTitle.includes("retained")) {
    throw new Error("G73 G43 oracle title lost its in-flight obligation contract");
  }
  process.stdout.write(`${JSON.stringify({ mutation: "remove-pending-findings", selfTest: "anchors-unique" })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const sourcePath = resolve(root, sourceFile);
  const original = readFileSync(sourcePath, "utf8");
  try {
    requirePass(build());
    requirePass(oracle());
    writeFileSync(sourcePath, mutate(original), "utf8");
    requirePass(build());
    requireRed(oracle());
  } finally {
    writeFileSync(sourcePath, original, "utf8");
    requirePass(build());
  }
  process.stdout.write(`${JSON.stringify({ mutation: "remove-pending-findings", result: "red" })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
