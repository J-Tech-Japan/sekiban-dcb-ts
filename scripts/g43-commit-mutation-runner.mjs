#!/usr/bin/env node
/**
 * G43's five-fact rule is a runtime mutation check, not a source-text tally.
 * Each mutant suppresses one production transaction write, rebuilds the
 * Worker bundle, and proves the SQLite fact oracle turns red. The original
 * source is restored and rebuilt in `finally` after every case.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const sourceFile = "packages/dcb-runtime/src/tag/TagDurableObject.ts";
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");
const oracleTitle = "AC2/AC3: commits event, head, membership, obligation, and receipt together";

export const G43_COMMIT_FACT_MUTATIONS = Object.freeze([
  { fact: "event", from: "this.writeCommittedSqlEvent(sql, serviceId, event);", to: "void 0; // G43 mutant: omit event fact" },
  { fact: "committedMembership", from: "this.writeCommittedSqlMembership(sql, serviceId, event.eventId, tag, committedAt);", to: "void 0; // G43 mutant: omit membership fact" },
  { fact: "outbox_obligation", from: "this.writeCommittedSqlObligation(sql, serviceId, event, artifact);", to: "void 0; // G43 mutant: omit obligation fact" },
  { fact: "head", from: "this.writeCommittedSqlHead(sql, serviceId, head, version + 1, committedAt);", to: "void 0; // G43 mutant: omit head fact" },
  { fact: "commit_receipt", from: "this.writeCommittedSqlReceipt(sql, input, committedAt, events.length, head, confirmsReservation);", to: "void 0; // G43 mutant: omit receipt fact" },
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
  throw new Error(`G43 ${fact} omission was vacuous: the five-fact SQLite oracle remained green`);
}

function build() {
  return run("npm", ["run", "build:packages", "--silent"], "build:packages");
}

function oracle() {
  return run(process.execPath, [
    vitest,
    "run",
    "--config", "vitest.config.ts",
    "test/g43-tag-sql.spec.ts",
    "--testNamePattern", oracleTitle,
  ], "G43 five-fact SQLite oracle");
}

function mutate(original, mutation) {
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) {
    throw new Error(`G43 ${mutation.fact} mutation anchor expected once in ${sourceFile}, found ${occurrences}`);
  }
  return original.replace(mutation.from, mutation.to);
}

function runMutation(mutation) {
  const sourcePath = resolve(root, sourceFile);
  const original = readFileSync(sourcePath, "utf8");
  try {
    requirePass(oracle());
    writeFileSync(sourcePath, mutate(original, mutation), "utf8");
    requirePass(build());
    requireRed(oracle(), mutation.fact);
  } finally {
    writeFileSync(sourcePath, original, "utf8");
    requirePass(build());
  }
  return { fact: mutation.fact, result: "production-mutant-red" };
}

function selfTest() {
  const source = readFileSync(resolve(root, sourceFile), "utf8");
  for (const mutation of G43_COMMIT_FACT_MUTATIONS) mutate(source, mutation);
  process.stdout.write(`${JSON.stringify({ facts: G43_COMMIT_FACT_MUTATIONS.map(({ fact }) => fact), selfTest: "anchors-unique" })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  requirePass(build());
  const results = G43_COMMIT_FACT_MUTATIONS.map(runMutation);
  process.stdout.write(`${JSON.stringify({ result: "all-five-production-mutants-red", rows: results })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
