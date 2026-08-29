#!/usr/bin/env node
/**
 * Runtime mutation proof for SDT-G44.  These are deliberately production
 * mutations: static source matching alone cannot show that the atomic D1
 * batch and the no-view failure gate actually have a live oracle.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");

export const G44_PRODUCTION_MUTATIONS = Object.freeze([
  {
    fact: "event",
    sourceFile: "packages/dcb-runtime/src/store/D1EventStore.ts",
    from: "INSERT INTO dcb_events",
    to: "INSERT INTO g44_mutant_events",
    oracleTitle: "AC1: atomically writes event, tag-local committed membership, and receipt",
  },
  {
    fact: "committed_membership",
    sourceFile: "packages/dcb-runtime/src/store/D1EventStore.ts",
    from: "INSERT INTO serialized_dcb_global_memberships",
    to: "INSERT INTO g44_mutant_global_memberships",
    oracleTitle: "AC1: atomically writes event, tag-local committed membership, and receipt",
  },
  {
    fact: "global_receipt",
    sourceFile: "packages/dcb-runtime/src/store/D1EventStore.ts",
    from: "INSERT INTO serialized_dcb_global_receipts",
    to: "INSERT INTO g44_mutant_global_receipts",
    oracleTitle: "AC1: atomically writes event, tag-local committed membership, and receipt",
  },
  {
    fact: "detector_failure_blocks_views",
    sourceFile: "packages/dcb-runtime/src/downstream/DeliveryCore.ts",
    from: `// A detector failure makes global completeness unknown. Do not apply a
    // view after that failure; an earlier version accumulated the error and
    // then silently continued into views.apply.
    return result(source, message, "stored", arrivedAt, false, [], failures, options.correlationId, startedAt);`,
    to: `// G44 mutant: detector failure is only recorded and then falls through.
    void error;`,
    oracleTitle: "AC5/AC6: detector failure or BLOCK/UNSETTLED coverage blocks every view",
  },
]);

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", env: { ...process.env, CI: "1" } });
  return { label, status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function requirePass(result) {
  if (result.status === 0) return;
  throw new Error(`${result.label} unexpectedly failed:\n${result.output}`);
}

function requireRed(result, fact) {
  if (result.status !== 0) return;
  throw new Error(`G44 ${fact} omission was vacuous: its focused runtime oracle remained green`);
}

function build() {
  return run("npm", ["run", "build:packages", "--silent"], "build:packages");
}

function oracle(title) {
  return run(process.execPath, [
    vitest,
    "run",
    "--config", "vitest.config.ts",
    "test/g44-global-completeness.spec.ts",
    "--testNamePattern", title,
  ], `G44 runtime oracle (${title})`);
}

function mutate(original, mutation) {
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) {
    throw new Error(`G44 ${mutation.fact} anchor expected once in ${mutation.sourceFile}, found ${occurrences}`);
  }
  return original.replace(mutation.from, mutation.to);
}

function runMutation(mutation) {
  const sourcePath = resolve(root, mutation.sourceFile);
  const original = readFileSync(sourcePath, "utf8");
  try {
    requirePass(oracle(mutation.oracleTitle));
    writeFileSync(sourcePath, mutate(original, mutation), "utf8");
    // Vitest transforms and executes the edited TypeScript source directly.
    // The normal lane has already typechecked the unedited tree; rebuilding
    // every syntactically valid mutant only lengthens this guard enough to
    // risk interrupting its finally-based source restoration.
    requireRed(oracle(mutation.oracleTitle), mutation.fact);
  } finally {
    writeFileSync(sourcePath, original, "utf8");
  }
  return { fact: mutation.fact, result: "production-mutant-red" };
}

function selfTest() {
  for (const mutation of G44_PRODUCTION_MUTATIONS) {
    mutate(readFileSync(resolve(root, mutation.sourceFile), "utf8"), mutation);
  }
  process.stdout.write(`${JSON.stringify({ mutations: G44_PRODUCTION_MUTATIONS.map(({ fact }) => fact), selfTest: "anchors-unique" })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  requirePass(build());
  const rows = G44_PRODUCTION_MUTATIONS.map(runMutation);
  process.stdout.write(`${JSON.stringify({ result: "all-g44-production-mutants-red", rows })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
