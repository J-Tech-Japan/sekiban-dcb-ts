#!/usr/bin/env node
/**
 * AC5 guard-isolation matrix. These mutations patch the real target source or
 * normative surface, run exactly one named oracle, and restore the checkout.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");
const structural = "scripts/g30-ac5-structural-check.mjs";

const MUTATIONS = Object.freeze([
  {
    id: "delivery-budget-94",
    file: "scripts/g30-b0-contract.mjs",
    from: "export const G30_MIN_SCHEMA_COMPLETE_COUNT = 95;",
    to: "export const G30_MIN_SCHEMA_COMPLETE_COUNT = 94;",
    target: "enforces the 95-of-100 delivery boundary per phase without shrinking the client denominator",
    unrelated: "uses the exact rank-1..5 client-latency tail set, including a deterministic rank-5/6 tie",
  },
  {
    id: "delivery-budget-95",
    file: "scripts/g30-b0-contract.mjs",
    from: "export const G30_MIN_SCHEMA_COMPLETE_COUNT = 95;",
    to: "export const G30_MIN_SCHEMA_COMPLETE_COUNT = 96;",
    target: "enforces the 95-of-100 delivery boundary per phase without shrinking the client denominator",
    unrelated: "records a per-missing sensitivity source and keeps per-hop aggregates conditional",
  },
  {
    id: "joined-denominator",
    file: "scripts/g30-b0-contract.mjs",
    from: "    clientCount: G30_SAMPLE_COUNT,",
    to: "    clientCount: complete.length,",
    target: "enforces the 95-of-100 delivery boundary per phase without shrinking the client denominator",
    unrelated: "uses the exact rank-1..5 client-latency tail set, including a deterministic rank-5/6 tie",
  },
  {
    id: "tail-rank-five",
    file: "scripts/g30-b0-contract.mjs",
    from: "const tail = ranking.ranked.slice(0, G30_TAIL_RANK_COUNT);",
    to: "const tail = ranking.ranked.slice(0, G30_TAIL_RANK_COUNT - 1);",
    target: "uses the exact rank-1..5 client-latency tail set, including a deterministic rank-5/6 tie",
    unrelated: "enforces the 95-of-100 delivery boundary per phase without shrinking the client denominator",
  },
  {
    id: "tail-tie-order",
    file: "scripts/g30-b0-contract.mjs",
    from: "right.clientLatency - left.clientLatency || requestIdOrder(left.requestId, right.requestId)",
    to: "right.clientLatency - left.clientLatency",
    target: "uses the exact rank-1..5 client-latency tail set, including a deterministic rank-5/6 tie",
    unrelated: "records a per-missing sensitivity source and keeps per-hop aggregates conditional",
  },
  {
    id: "unsealed-percentile-estimator",
    file: "scripts/g30-b0-contract.mjs",
    from: "p95: percentile(clientLatencies, 0.95),",
    to: "p95: percentile(clientLatencies.slice(0, complete.length), 0.95),",
    target: "enforces the 95-of-100 delivery boundary per phase without shrinking the client denominator",
    unrelated: "keeps a dropped non-tail trace in the fixed denominator as UNKNOWN",
  },
  {
    id: "root-absent-envelope",
    file: "scripts/g30-b0-contract.mjs",
    from: "const upperBoundMs = stage === \"root-absent\" ? entry.clientLatency : rootDurationMs;",
    to: "const upperBoundMs = stage === \"root-absent\" ? 0 : rootDurationMs;",
    target: "records a per-missing sensitivity source and keeps per-hop aggregates conditional",
    unrelated: "enforces the 95-of-100 delivery boundary per phase without shrinking the client denominator",
  },
  {
    id: "missing-identity-omission",
    file: "scripts/g30-b0-contract.mjs",
    from: "    missing: Object.freeze(missing),",
    to: "    missing: Object.freeze([]),",
    target: "allows only the explicitly enumerated AC5 UNKNOWN set through the joined observation stream",
    unrelated: "uses the exact rank-1..5 client-latency tail set, including a deterministic rank-5/6 tie",
  },
  {
    id: "pr-body-only-regression",
    file: "docs/SDT-G30-pr-body.md",
    from: "schemaCompleteCount >= 95",
    to: "schemaCompleteCount >= 94",
    structural: true,
  },
  {
    id: "oracle-map-only-regression",
    file: "docs/SDT-G30-oracle-map.md",
    from: "rank-1..5",
    to: "p95-threshold tail",
    structural: true,
  },
  {
    id: "implementation-notes-only-regression",
    file: "docs/commit-tracing.md",
    from: "root-absent",
    to: "root absent",
    structural: true,
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

function requireRed(result, id) {
  if (result.status !== 0) return;
  throw new Error(`G30 AC5 ${id} mutant was vacuous`);
}

function testNamed(name) {
  return run(process.execPath, [vitest, "run", "--config", "vitest.config.ts", "test/g30-b0.spec.ts", "--testNamePattern", name], `G30 AC5 oracle ${name}`);
}

function mutate(source, mutation) {
  const count = source.split(mutation.from).length - 1;
  if (count !== 1) throw new Error(`G30 AC5 ${mutation.id} expected one anchor in ${mutation.file}, found ${count}`);
  return source.replace(mutation.from, mutation.to);
}

function execute(mutation) {
  const path = resolve(root, mutation.file);
  const original = readFileSync(path, "utf8");
  try {
    requirePass(run(process.execPath, [structural], "G30 AC5 structural baseline"));
    if (mutation.structural) {
      writeFileSync(path, mutate(original, mutation), "utf8");
      requireRed(run(process.execPath, [structural], "G30 AC5 structural target"), mutation.id);
      return { id: mutation.id, result: "red" };
    }
    requirePass(testNamed(mutation.target));
    requirePass(testNamed(mutation.unrelated));
    writeFileSync(path, mutate(original, mutation), "utf8");
    requireRed(testNamed(mutation.target), mutation.id);
    requirePass(testNamed(mutation.unrelated));
    return { id: mutation.id, result: "red-with-unrelated-pass" };
  } finally {
    writeFileSync(path, original, "utf8");
    requirePass(run(process.execPath, [structural], "G30 AC5 structural restoration"));
  }
}

function main() {
  const ids = MUTATIONS.map((mutation) => mutation.id);
  if (new Set(ids).size !== ids.length) throw new Error("G30 AC5 mutation IDs must be unique");
  console.log(JSON.stringify({ mutations: MUTATIONS.map(execute), result: "all-amended-ac5-mutants-red" }, null, 2));
}

main();
