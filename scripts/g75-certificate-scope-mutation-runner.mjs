#!/usr/bin/env node
/**
 * Execute the two required G75 product mutants against the focused Vitest
 * oracle.  Each mutant removes one independent gate, and the source is
 * restored even when the oracle or runtime build fails.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const vitest = [
  resolve(root, "node_modules/vitest/vitest.mjs"),
  resolve(root, "../node_modules/vitest/vitest.mjs"),
].find((candidate) => existsSync(candidate));
if (vitest === undefined) throw new Error("SDT-G75 product mutation runner: vitest executable is unavailable");
const mutations = Object.freeze([
  {
    id: "omit-g44-settled-frontier",
    sourceFile: "packages/dcb-runtime/src/projection/ProjectionRuntime.ts",
    from: `if (options.maximumSuid === null || (\n          options.maximumSuid !== undefined && compareSuid(event.suid, options.maximumSuid) > 0\n        )) {`,
    to: "if (false) {",
    oracle: "certificate alone cannot replace the existing G44 settled frontier",
  },
  {
    id: "omit-closed-prefix-certificate-gate",
    sourceFile: "packages/dcb-runtime/src/projection/ProjectionRuntime.ts",
    from: `if (certifiedClosedPrefixSuid === null || (\n          certifiedClosedPrefixSuid !== undefined && compareSuid(event.suid, certifiedClosedPrefixSuid) > 0\n        )) {`,
    to: "if (false) {",
    oracle: "safe view cannot advance beyond the certificate closed prefix",
  },
]);

function fail(message) {
  throw new Error(`SDT-G75 product mutation runner: ${message}`);
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
  if (result.status !== 0) fail(`${result.label} unexpectedly failed:\n${result.output}`);
}

function requireRed(result, mutation) {
  if (result.status === 0) fail(`${mutation.id} remained green under the focused product oracle`);
}

function mutate(original, mutation) {
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) fail(`${mutation.id} anchor expected once, found ${occurrences}`);
  return original.replace(mutation.from, mutation.to);
}

function oracle(mutation) {
  return run(process.execPath, [
    vitest,
    "run",
    "--config",
    "vitest.config.ts",
    "--no-cache",
    "test/g75-certificate-scope.spec.ts",
    "--testNamePattern",
    mutation.oracle,
  ], `G75 focused product oracle (${mutation.id})`);
}

function buildRuntime() {
  return run("npm", ["run", "build", "--workspace", "@sekiban/dcb-runtime", "--silent"], "runtime build");
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
  for (const mutation of mutations) mutate(readFileSync(resolve(root, mutation.sourceFile), "utf8"), mutation);
  process.stdout.write(`${JSON.stringify({ mutations: mutations.map(({ id }) => id), selfTest: "anchors-unique" })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  requirePass(buildRuntime());
  const rows = mutations.map(runMutation);
  process.stdout.write(`${JSON.stringify({ result: "all-g75-behavioral-product-mutants-red", rows })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
