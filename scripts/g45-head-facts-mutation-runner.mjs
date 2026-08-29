#!/usr/bin/env node
/**
 * Execute SDT-G45's independent falsifications against the real
 * Miniflare handler/checker.  A static source token is insufficient here:
 * every mutation must make its focused oracle red on its own.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");

export const G45_MUTATIONS = Object.freeze([
  {
    fact: "restore_readStoredRecord",
    sourceFile: "packages/dcb-runtime/src/tag/TagDurableObject.ts",
    from: "const facts = this.readHeadFacts(tag);",
    to: `const facts = (() => {
            const record = this.readStoredRecord(tag);
            return record === undefined ? undefined : { head: record.head, version: record.version, updatedAt: record.updatedAt };
          })();`,
    rebuildRuntime: true,
    oracleTitle: "AC1/AC2: real /head-facts is table-aware, equivalent to /state, and keeps identity outcomes",
  },
  {
    fact: "history_proportional_tag_event_limit",
    sourceFile: "packages/dcb-runtime/src/tag/TagDurableObject.ts",
    from: "const controlHead = sqlString(control.head_suid, \"tag_control.head_suid\");",
    to: `sql.exec("SELECT event_json FROM tag_event ORDER BY suid ASC LIMIT (SELECT COUNT(*) FROM tag_event)").toArray();
    const controlHead = sqlString(control.head_suid, "tag_control.head_suid");`,
    rebuildRuntime: true,
    oracleTitle: "AC3: real handler head-facts read has a singleton non-event SQL set at every history point",
  },
  {
    fact: "constant_tag_event_limit_one",
    sourceFile: "packages/dcb-runtime/src/tag/TagDurableObject.ts",
    from: "const controlHead = sqlString(control.head_suid, \"tag_control.head_suid\");",
    to: `sql.exec("SELECT event_json FROM tag_event ORDER BY suid ASC LIMIT 1").toArray();
    const controlHead = sqlString(control.head_suid, "tag_control.head_suid");`,
    rebuildRuntime: true,
    oracleTitle: "AC1/AC2: real /head-facts is table-aware, equivalent to /state, and keeps identity outcomes",
  },
  {
    fact: "endpoint_only_checker",
    sourceFile: "test/g45-head-facts.spec.ts",
    from: "const allRowsRead = samples.map((sample) => sample.snapshot.rowsRead);",
    to: "const allRowsRead = [samples[0]!, samples.at(-1)!].map((sample) => sample.snapshot.rowsRead);",
    oracleTitle: "AC3 checker rejects each standalone falsification",
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
  throw new Error(`G45 ${fact} mutation was vacuous: its focused oracle remained green`);
}

function mutate(original, mutation) {
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) {
    throw new Error(`G45 ${mutation.fact} anchor expected once in ${mutation.sourceFile}, found ${occurrences}`);
  }
  return original.replace(mutation.from, mutation.to);
}

function oracle(title) {
  return run(process.execPath, [
    vitest,
    "run",
    "--config", "vitest.config.ts",
    "test/g45-head-facts.spec.ts",
    "--testNamePattern", title,
  ], `G45 runtime oracle (${title})`);
}

function buildRuntime() {
  return run("npm", ["run", "build:packages", "--silent"], "build:packages");
}

function runMutation(mutation) {
  const sourcePath = resolve(root, mutation.sourceFile);
  const original = readFileSync(sourcePath, "utf8");
  try {
    requirePass(oracle(mutation.oracleTitle));
    writeFileSync(sourcePath, mutate(original, mutation), "utf8");
    if (mutation.rebuildRuntime === true) requirePass(buildRuntime());
    requireRed(oracle(mutation.oracleTitle), mutation.fact);
  } finally {
    writeFileSync(sourcePath, original, "utf8");
    if (mutation.rebuildRuntime === true) requirePass(buildRuntime());
  }
  return { fact: mutation.fact, result: "production-mutant-red" };
}

function selfTest() {
  for (const mutation of G45_MUTATIONS) {
    mutate(readFileSync(resolve(root, mutation.sourceFile), "utf8"), mutation);
  }
  process.stdout.write(`${JSON.stringify({ mutations: G45_MUTATIONS.map(({ fact }) => fact), selfTest: "anchors-unique" })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  requirePass(buildRuntime());
  const rows = G45_MUTATIONS.map(runMutation);
  process.stdout.write(`${JSON.stringify({ result: "all-g45-head-facts-mutations-red", rows })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
