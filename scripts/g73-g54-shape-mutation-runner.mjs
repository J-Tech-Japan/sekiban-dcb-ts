#!/usr/bin/env node
/**
 * G73's G54 response-shape proof. The live V1 empty response must keep its
 * exact top-level shape while accepting a non-fixed duration string. Each
 * temporary product mutation is rebuilt, tested, and restored.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const sourceFile = "packages/dcb-runtime/src/commit/CommitWorker.ts";
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");
const oracleTitle = "continues to accept explicit empty V1 arrays";
const mutationAnchor = "return json({ writtenEvents: [], tagWriteResults: [], duration: durationSince(startedAt) });";

const mutations = Object.freeze([
  {
    id: "extra-response-field",
    replacement: "return json({ writtenEvents: [], tagWriteResults: [], duration: durationSince(startedAt), g73Unexpected: true });",
    expected: "red",
  },
  {
    id: "duration-variation",
    replacement: "return json({ writtenEvents: [], tagWriteResults: [], duration: \"PT0.001S\" });",
    expected: "green",
  },
]);

function run(program, args, label) {
  const result = spawnSync(program, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  return { label, status: result.status ?? 1, output: (result.stdout ?? "") + (result.stderr ?? "") };
}

function requirePass(result) {
  if (result.status === 0) return;
  throw new Error(result.label + " unexpectedly failed:\n" + result.output);
}

function requireRed(result, mutation) {
  if (result.status !== 0) return;
  throw new Error("G54 " + mutation.id + " mutant was green; the shape oracle is incomplete");
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
    "test/g54-envelope-boundary.spec.ts",
    "--testNamePattern", oracleTitle,
  ], "G54 exact-shape oracle");
}

function mutate(original, mutation) {
  const occurrences = original.split(mutationAnchor).length - 1;
  if (occurrences !== 1) {
    throw new Error("G54 shape mutation anchor expected once in " + sourceFile + ", found " + occurrences);
  }
  return original.replace(mutationAnchor, mutation.replacement);
}

function selfTest() {
  const source = readFileSync(resolve(root, sourceFile), "utf8");
  for (const mutation of mutations) mutate(source, mutation);
  process.stdout.write(JSON.stringify({
    mutations: mutations.map(({ id, expected }) => ({ id, expected })),
    selfTest: "anchors-unique",
  }) + "\n");
}

function runMutation(original, mutation, sourcePath) {
  try {
    writeFileSync(sourcePath, mutate(original, mutation), "utf8");
    requirePass(build());
    const result = oracle();
    if (mutation.expected === "red") requireRed(result, mutation);
    else requirePass(result);
    return { mutation: mutation.id, result: mutation.expected };
  } finally {
    writeFileSync(sourcePath, original, "utf8");
    requirePass(build());
  }
}

function main() {
  const sourcePath = resolve(root, sourceFile);
  const original = readFileSync(sourcePath, "utf8");
  if (process.argv.includes("--self-test")) return selfTest();
  try {
    requirePass(build());
    requirePass(oracle());
    const results = mutations.map((mutation) => runMutation(original, mutation, sourcePath));
    process.stdout.write(JSON.stringify({ result: "g54-shape-proof", rows: results }) + "\n");
  } finally {
    writeFileSync(sourcePath, original, "utf8");
    requirePass(build());
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
