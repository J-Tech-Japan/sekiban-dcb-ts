#!/usr/bin/env node
/**
 * F4 attribution is against the shipped tag-rebuild tool itself. Each Cosmos
 * partition/id mutation must make the manifest-derived provider comparison
 * red while the PostgreSQL/SQLite comparison remains independently green.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const sourceFile = "tools/derive-dcb-tags/index.mjs";
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");

export const TAG_DERIVATION_MUTATIONS = Object.freeze([
  {
    id: "cosmos-pk",
    from: "      return Object.freeze({\n        pk: `${event.serviceId}|${tag}`,\n        id: event.id,",
    to: "      return Object.freeze({\n        pk: \"wrong\",\n        id: event.id,",
  },
  {
    id: "cosmos-id",
    from: "      return Object.freeze({\n        pk: `${event.serviceId}|${tag}`,\n        id: event.id,",
    to: "      return Object.freeze({\n        pk: `${event.serviceId}|${tag}`,\n        id: \"wrong\",",
  },
]);

function command(program, args, label) {
  const result = spawnSync(program, args, { cwd: root, encoding: "utf8", env: { ...process.env, CI: "1" } });
  return { label, status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function pass(result) {
  if (result.status === 0) return;
  throw new Error(`${result.label} unexpectedly failed:\n${result.output}`);
}

function red(result, id) {
  if (result.status !== 0) return;
  throw new Error(`${id} tag derivation mutation was vacuous`);
}

function runFixture(pattern) {
  return command(process.execPath, [
    vitest,
    "run", "--config", "vitest.config.ts", "test/g32-tags.spec.ts",
    "--testNamePattern", pattern,
  ], `tag fixture ${pattern}`);
}

function mutate(original, mutation) {
  const count = original.split(mutation.from).length - 1;
  if (count !== 1) throw new Error(`${mutation.id} expected exactly one tool-source anchor, received ${count}`);
  return original.replace(mutation.from, mutation.to);
}

function execute(mutation) {
  const path = resolve(root, sourceFile);
  const original = readFileSync(path, "utf8");
  try {
    pass(runFixture("compares every Cosmos rebuild field"));
    writeFileSync(path, mutate(original, mutation), "utf8");
    red(runFixture("compares every Cosmos rebuild field"), mutation.id);
    pass(runFixture("compares every PostgreSQL/SQLite rebuild field"));
  } finally {
    writeFileSync(path, original, "utf8");
  }
  return Object.freeze({ id: mutation.id, result: "red-with-unrelated-green" });
}

function main() {
  const ids = TAG_DERIVATION_MUTATIONS.map((mutation) => mutation.id);
  if (new Set(ids).size !== ids.length) throw new Error("tag derivation mutation IDs must be unique");
  if (process.argv.includes("--self-test")) {
    process.stdout.write(`${JSON.stringify({ mutations: ids, selfTest: "matrix-valid" })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ result: "all-tag-derivation-mutants-red", mutations: TAG_DERIVATION_MUTATIONS.map(execute) })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
