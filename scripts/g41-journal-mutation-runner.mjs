#!/usr/bin/env node
/**
 * Execute focused production mutations for SDT-G41.  The static inventory
 * guard proves shape; this runner proves the namespace seam and tag-owned
 * failure outcomes actually fail when the normal commit implementation is
 * changed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");

export const G41_PRODUCTION_MUTATIONS = Object.freeze([
  {
    fact: "restore_commit_path_journal_namespace_lookup",
    sourceFile: "packages/dcb-runtime/src/commit/CommitWorker.ts",
    from: "const reservations = await this.acquireReservations(input, attemptId, fault, traceState?.scope);",
    to: `const g41MutantJournal = this.env.JOURNAL;
    if (g41MutantJournal !== undefined) {
      await g41MutantJournal.get(scopeIdFor(g41MutantJournal, { serviceId: this.serviceId, doClass: "journal", identity: attemptId })).fetch(
        new Request("https://mutant.invalid/admit", { method: "POST" }),
      );
    }
    const reservations = await this.acquireReservations(input, attemptId, fault, traceState?.scope);`,
    oracleTitle: "AC2: performs zero JOURNAL namespace calls while the Tag positive control is live",
  },
  {
    fact: "remove_force_tombstone_on_prepare_failure",
    sourceFile: "packages/dcb-runtime/src/commit/CommitWorker.ts",
    from: "forceTombstone: true,",
    to: "forceTombstone: false,",
    oracleTitle: "AC3: prepare failure cancels every already-reserved tag and leaves the primary refusal intact",
  },
  {
    fact: "claim_partial_write_deleted_events",
    sourceFile: "packages/dcb-runtime/src/commit/CommitWorker.ts",
    from: "eventsDeleted: false,",
    to: "eventsDeleted: true,",
    oracleTitle: "AC3: commit failure cancels every tag but cannot delete a committed event or overwrite partial_write",
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
  throw new Error(`G41 ${fact} mutation was vacuous: its focused oracle stayed green`);
}

function mutate(original, mutation) {
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) {
    throw new Error(`G41 ${mutation.fact} anchor expected once in ${mutation.sourceFile}, found ${occurrences}`);
  }
  return original.replace(mutation.from, mutation.to);
}

function oracle(title) {
  return run(process.execPath, [
    vitest,
    "run",
    "--config", "vitest.config.ts",
    "--maxWorkers=1",
    "test/g41-journal-removal.spec.ts",
    "--testNamePattern", title,
  ], `G41 runtime oracle (${title})`);
}

function runMutation(mutation) {
  const sourcePath = resolve(root, mutation.sourceFile);
  const original = readFileSync(sourcePath, "utf8");
  try {
    requirePass(oracle(mutation.oracleTitle));
    writeFileSync(sourcePath, mutate(original, mutation), "utf8");
    requireRed(oracle(mutation.oracleTitle), mutation.fact);
  } finally {
    writeFileSync(sourcePath, original, "utf8");
  }
  return { fact: mutation.fact, result: "production-mutant-red" };
}

function selfTest() {
  for (const mutation of G41_PRODUCTION_MUTATIONS) {
    mutate(readFileSync(resolve(root, mutation.sourceFile), "utf8"), mutation);
  }
  process.stdout.write(`${JSON.stringify({ mutations: G41_PRODUCTION_MUTATIONS.map(({ fact }) => fact), selfTest: "anchors-unique" })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const rows = G41_PRODUCTION_MUTATIONS.map(runMutation);
  process.stdout.write(`${JSON.stringify({ result: "all-g41-production-mutants-red", rows })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
