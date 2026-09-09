#!/usr/bin/env node
/**
 * Execute the four G70 product mutants against the public acceptance oracle.
 * Unlike the source-only guard, this runner changes a product source file,
 * rebuilds the runtime bundle, runs the real Miniflare acceptance test, and
 * requires the mutated product to turn that test red. Every source is restored
 * in a finally block.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");

export const G70_MUTATIONS = Object.freeze([
  {
    id: "omit-allocator-certificate",
    sourceFile: "packages/dcb-runtime/src/projection/LiveProjectionWorker.ts",
    from: "const requireClosedPrefixCertificate = env.ALLOCATOR !== undefined;",
    to: "const requireClosedPrefixCertificate = false;",
    oracle: "public safe application acceptance matrix",
  },
  {
    id: "omit-all-tag-maximumSuid",
    sourceFile: "packages/dcb-runtime/src/projection/LiveProjectionWorker.ts",
    from: "      options.maximumSuid,\n      closedPrefixSuid,\n      options.closedPrefixCertificate,",
    to: "      undefined,\n      closedPrefixSuid,\n      options.closedPrefixCertificate,",
    oracle: "public safe application acceptance matrix",
  },
  {
    id: "resolve-temporary-fence",
    sourceFile: "packages/dcb-runtime/src/tag/TagDurableObject.ts",
    from: "        `SELECT attempt_id FROM tag_tombstone WHERE attempt_id = ? LIMIT 1`,",
    to: "        `SELECT attempt_id FROM tag_fence WHERE attempt_id = ? LIMIT 1`,",
    oracle: "temporary repair coverage can be cleared",
  },
  {
    id: "accept-expired-writer",
    sourceFile: "packages/dcb-runtime/src/allocator/AllocatorDurableObject.ts",
    from: "    if ((obligation.revokedTags ?? []).includes(body.tag) || obligation.fencedTags.includes(body.tag)) {",
    to: "    if (obligation.fencedTags.includes(body.tag)) {",
    oracle: "temporary repair coverage can be cleared",
  },
]);

function fail(message) {
  throw new Error(`SDT-G70 product mutation runner: ${message}`);
}

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
  fail(`${result.label} unexpectedly failed:\n${result.output}`);
}

function requireRed(result, mutation) {
  if (result.status !== 0) return;
  fail(`${mutation.id} remained green under the public oracle: ${mutation.oracle}`);
}

function mutate(original, mutation) {
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) fail(`${mutation.id} anchor expected once in ${mutation.sourceFile}, found ${occurrences}`);
  return original.replace(mutation.from, mutation.to);
}

function oracle(mutation) {
  return run(process.execPath, [
    vitest,
    "run",
    "--config",
    "vitest.config.ts",
    "--no-cache",
    "test/g70-allocator-closed-prefix.spec.ts",
    "--testNamePattern",
    mutation.oracle,
  ], `G70 public product oracle (${mutation.id})`);
}

function buildRuntime() {
  return run("npm", ["run", "build:packages", "--silent"], "build:packages");
}

function runMutation(mutation) {
  const sourcePath = resolve(root, mutation.sourceFile);
  const original = readFileSync(sourcePath, "utf8");
  try {
    requirePass(oracle(mutation));
    writeFileSync(sourcePath, mutate(original, mutation), "utf8");
    requirePass(buildRuntime());
    requireRed(oracle(mutation), mutation);
  } finally {
    writeFileSync(sourcePath, original, "utf8");
    requirePass(buildRuntime());
  }
  return { id: mutation.id, result: "behavioral-product-mutant-red" };
}

function selfTest() {
  for (const mutation of G70_MUTATIONS) {
    mutate(readFileSync(resolve(root, mutation.sourceFile), "utf8"), mutation);
  }
  process.stdout.write(`${JSON.stringify({ mutations: G70_MUTATIONS.map(({ id }) => id), selfTest: "anchors-unique" })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  requirePass(buildRuntime());
  const rows = G70_MUTATIONS.map(runMutation);
  process.stdout.write(`${JSON.stringify({ result: "all-g70-behavioral-product-mutants-red", rows })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
