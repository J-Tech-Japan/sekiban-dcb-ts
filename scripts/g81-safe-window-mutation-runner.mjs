#!/usr/bin/env node
/**
 * Run SDT-G81's two semantic SafeWindow mutants against the G81 boundary
 * oracle only. Product sources are temporary mutation targets and are
 * restored even when a focused run fails.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const vitest = [
  resolve(root, "node_modules/vitest/vitest.mjs"),
  resolve(root, "../node_modules/vitest/vitest.mjs"),
].find((candidate) => existsSync(candidate));
if (vitest === undefined) throw new Error("G81 SafeWindow mutation runner: Vitest executable is unavailable");

const G81_ORACLE_NAME = "[G81] AC3 proves exact 120000 and 120001 ms boundaries through the public reader";
const G81_ORACLE_PATTERN = "\\[G81\\] AC3 proves exact 120000 and 120001 ms boundaries through the public reader";

export const G81_MUTATIONS = Object.freeze([
  {
    id: "remove-ceiling-check",
    sourceFile: "packages/dcb-runtime/src/read/SerializedReadWorker.ts",
    from: "if (safeWindowCeilingExceeded(dynamicLagBoundMs)) {",
    to: "if (false) {",
    expected: "500",
    received: "200",
  },
  {
    id: "ceiling-greater-or-equal",
    sourceFile: "packages/dcb-runtime/src/safeWindow.ts",
    from: "return dynamicLagBoundMs > MAX_PUBLISHED_SAFE_WINDOW_MS;",
    to: "return dynamicLagBoundMs >= MAX_PUBLISHED_SAFE_WINDOW_MS;",
    expected: "200",
    received: "500",
  },
]);

function fail(message) {
  throw new Error(`G81 SafeWindow mutation runner: ${message}`);
}

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  return {
    label,
    status: result.status,
    signal: result.signal,
    error: result.error === undefined ? undefined : String(result.error),
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function runOracle(label) {
  return run(process.execPath, [
    vitest,
    "run",
    "--config", "vitest.config.ts",
    "--no-cache",
    "--maxWorkers=1",
    "test/read.spec.ts",
    "--testNamePattern", G81_ORACLE_PATTERN,
  ], label);
}

function buildPackages() {
  return run("npm", ["run", "build:packages", "--silent"], "G81 package build");
}

function requirePass(result) {
  if (result.status === 0 && result.signal === null && result.error === undefined) return;
  fail(`${result.label} unexpectedly failed:\n${result.output}`);
}

function requireSemanticRed(result, mutation) {
  if (result.status !== 1 || result.signal !== null || result.error !== undefined) {
    fail(`${mutation.id} did not produce a normal Vitest assertion failure: ${JSON.stringify({
      status: result.status,
      signal: result.signal,
      error: result.error,
    })}\n${result.output}`);
  }
  if (!result.output.includes(G81_ORACLE_NAME)) {
    fail(`${mutation.id} output did not identify the exact G81 boundary oracle`);
  }
  if (!result.output.includes(`- ${mutation.expected}`) || !result.output.includes(`+ ${mutation.received}`)) {
    fail(`${mutation.id} output did not show expected ${mutation.expected} and received ${mutation.received}:\n${result.output}`);
  }
  if (result.output.includes("Unhandled Errors") || /Test timed out|Setup Error|Cannot find module|SIG[A-Z]+/.test(result.output)) {
    fail(`${mutation.id} output contains a non-semantic failure:\n${result.output}`);
  }
}

function mutate(original, mutation) {
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) fail(`${mutation.id} anchor expected once in ${mutation.sourceFile}, found ${occurrences}`);
  return original.replace(mutation.from, mutation.to);
}

function selfTest() {
  for (const mutation of G81_MUTATIONS) {
    const source = readFileSync(resolve(root, mutation.sourceFile), "utf8");
    mutate(source, mutation);
  }
  if (!G81_ORACLE_NAME.includes("G81") || !G81_ORACLE_NAME.includes("120000") || !G81_ORACLE_NAME.includes("120001")) {
    fail("oracle is not the named G81 boundary test");
  }
  process.stdout.write(`${JSON.stringify({
    mutations: G81_MUTATIONS.map(({ id, sourceFile }) => ({ id, sourceFile })),
    oracle: G81_ORACLE_NAME,
    testFile: "test/read.spec.ts",
    selfTest: "anchors-and-g81-only-oracle",
  })}\n`);
}

function runMutation(mutation) {
  const sourcePath = resolve(root, mutation.sourceFile);
  const original = readFileSync(sourcePath, "utf8");
  try {
    requirePass(buildPackages());
    requirePass(runOracle(`G81 healthy control (${mutation.id})`));
    writeFileSync(sourcePath, mutate(original, mutation), "utf8");
    requirePass(buildPackages());
    const red = runOracle(`G81 semantic mutant (${mutation.id})`);
    requireSemanticRed(red, mutation);
    return {
      id: mutation.id,
      status: red.status,
      signal: red.signal,
      result: "semantic-mutant-red",
    };
  } finally {
    writeFileSync(sourcePath, original, "utf8");
    requirePass(buildPackages());
  }
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  requirePass(buildPackages());
  const rows = G81_MUTATIONS.map(runMutation);
  process.stdout.write(`${JSON.stringify({ result: "all-g81-safe-window-mutants-red", oracle: G81_ORACLE_NAME, rows })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
