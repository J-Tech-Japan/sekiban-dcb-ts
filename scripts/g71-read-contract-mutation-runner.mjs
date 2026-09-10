#!/usr/bin/env node
/**
 * Run the required SDT-G71 authority/read-consistency mutants against
 * the focused public-contract tests. Each mutation is applied to the source
 * under test, the named semantic oracle must turn red, and the original bytes
 * are restored before the next mutation.
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
if (vitest === undefined) throw new Error("SDT-G71 mutation runner: Vitest executable is unavailable");

const sourceFile = "packages/dcb-client/src/executor.ts";
const mutations = Object.freeze([
  {
    id: "sentinel-only-existence",
    from: "exists: true,",
    to: "exists: !empty,",
    oracle: "retains an existing empty object, ignored-event state, and sentinel state as existing",
    reason: "payload sentinel cannot replace the durable authority boolean",
  },
  {
    id: "authority-failure-as-absence",
    from: "() => transport.readTagLatestSortable!({ tag }, signal),",
    to: "() => Promise.resolve({ exists: false, lastSortableUniqueId: \"\" }),",
    oracle: "does not suppress authority failures and reports a missing capability",
    reason: "an authority refusal must not be relabelled as absence",
  },
  {
    id: "existing-empty-object-erased",
    from: "const empty = isRecord(decoded) && decoded.status === \"empty\";",
    to: "const empty = (isRecord(decoded) && decoded.status === \"empty\") || (isRecord(decoded) && Object.keys(decoded).length === 0);",
    oracle: "retains an existing empty object, ignored-event state, and sentinel state as existing",
    reason: "a decoded empty object is an existing projector result",
  },
  {
    id: "mismatched-observation-heads",
    from: "if (compareSortableUniqueId(response.lastSortedUniqueId, authority.lastSortableUniqueId) < 0) {",
    to: "if (false) {",
    oracle: "bounds authority/frontier reconciliation instead of combining mismatched observations",
    reason: "a stale consumed frontier cannot be combined with a newer authority head",
  },
  {
    id: "list-consistency-dropped",
    from: "() => transport.listQuery(withConsistency, readOptions.signal),",
    to: "() => transport.listQuery(request, readOptions.signal),",
    oracle: "carries list consistency through every adapter and refuses it elsewhere",
    reason: "a public list lane must reach each serialized transport",
  },
  {
    id: "abort-collapsed-to-transport",
    from: "if (isAbortError(error)) throw new ClientError(\"aborted\", `${label} read was aborted`, { cause: error });",
    to: "if (isAbortError(error)) throw new ClientError(\"transport\", `${label} read was aborted`, { cause: error });",
    oracle: "keeps refusal, abort, and transport failures distinguishable at the read boundary",
    reason: "an aborted read must not be collapsed into an ordinary transport failure",
  },
]);

function run(args, label) {
  const result = spawnSync(process.execPath, [vitest, ...args], {
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
  if (result.status === 0) throw new Error(`${mutation.id} remained green under its semantic oracle`);
}

function mutate(original, mutation) {
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) throw new Error(`${mutation.id} anchor expected once, found ${occurrences}`);
  return original.replace(mutation.from, mutation.to);
}

function oracle(mutation) {
  return run([
    "run",
    "--config",
    "vitest.config.ts",
    "--no-cache",
    "test/g71-read-contract.spec.ts",
    "--testNamePattern",
    mutation.oracle,
  ], `G71 semantic oracle (${mutation.id})`);
}

function runMutation(mutation) {
  const path = resolve(root, sourceFile);
  const original = readFileSync(path, "utf8");
  try {
    requirePass(oracle(mutation));
    writeFileSync(path, mutate(original, mutation), "utf8");
    const red = oracle(mutation);
    requireRed(red, mutation);
  } finally {
    writeFileSync(path, original, "utf8");
  }
  return { id: mutation.id, reason: mutation.reason, result: "behavioral-product-mutant-red" };
}

function selfTest() {
  const original = readFileSync(resolve(root, sourceFile), "utf8");
  for (const mutation of mutations) mutate(original, mutation);
  process.stdout.write(`${JSON.stringify({ mutations: mutations.map(({ id }) => id), selfTest: "anchors-unique" })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const rows = mutations.map(runMutation);
  process.stdout.write(`${JSON.stringify({ result: "all-g71-behavioral-product-mutants-red", rows })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
