#!/usr/bin/env node
/**
 * Structural negative oracle for the amended AC5 wording. The active target
 * packet/body/implementation-note surfaces must agree with the frozen
 * bounded-loss contract. The sealed host means/19 baseline is represented by
 * its bundle digest; historical evidence is intentionally out of scope.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const HOST_MEANS_19_PATH = "intents/sekiban-dcb-ts/intent-tree/means/19-commit-latency.md";
const HOST_MEANS_19_DIGEST = "sha256:173ef152786cbeacb468eac5776ef35db3303d594dfbf12c69d5200653b3f571";

export const G30_AC5_NORMATIVE_SURFACES = Object.freeze([
  "contracts/commit-trace-bundle.json",
  "docs/SDT-G30-pr-body.md",
  "docs/SDT-G30-oracle-map.md",
  "docs/commit-tracing.md",
  "scripts/g30-b0-contract.mjs",
  "scripts/deploy/g30-trace-export.mjs",
  "scripts/deploy/g30-b0-record-evidence.mjs",
  "scripts/g30-ac5-mutation-runner.mjs",
]);
const G30_AC5_ACTIVE_ASSERTION_SURFACES = Object.freeze([
  "docs/SDT-G30-pr-body.md",
  "docs/SDT-G30-oracle-map.md",
  "docs/commit-tracing.md",
  "scripts/g30-b0-contract.mjs",
  "scripts/deploy/g30-trace-export.mjs",
  "scripts/deploy/g30-b0-record-evidence.mjs",
]);

function readTarget(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function fail(message) {
  throw new Error(`g30-ac5-structural:${message}`);
}

function requireText(texts, path, expression, description) {
  if (!expression.test(texts.get(path))) fail(`${path} lacks ${description}`);
}

function forbidText(texts, path, expression, description) {
  if (expression.test(texts.get(path))) fail(`${path} retains stale ${description}`);
}

/** Reads every active normative surface; expected values are never generated from a scan. */
export function assertAc5StructuralContract(read = readTarget) {
  const texts = new Map(G30_AC5_NORMATIVE_SURFACES.map((path) => [path, read(path)]));
  for (const path of G30_AC5_ACTIVE_ASSERTION_SURFACES) {
    if (typeof texts.get(path) !== "string" || texts.get(path).length === 0) fail(`${path} is unavailable`);
  }
  requireText(texts, "scripts/g30-b0-contract.mjs", /G30_MIN_SCHEMA_COMPLETE_COUNT\s*=\s*85/, "the frozen 85/100 delivery budget");
  requireText(texts, "scripts/g30-b0-contract.mjs", /G30_TAIL_RANK_COUNT\s*=\s*5/, "the exact rank-1..5 tail size");
  requireText(texts, "scripts/g30-b0-contract.mjs", /nearest-rank\/full-client-ledger\/v1/, "the sealed full-ledger estimator");
  requireText(texts, "scripts/g30-b0-contract.mjs", /stage === "root-absent" \? entry\.clientLatency : rootDurationMs/, "the root-absent sensitivity envelope");
  requireText(texts, "scripts/g30-b0-contract.mjs", /ranking\.ranked\.slice\(0, G30_TAIL_RANK_COUNT\)/, "the exact rank-set tail selector");
  requireText(texts, "scripts/deploy/g30-trace-export.mjs", /Query roots directly by the provider identity/, "root-first missing-stage classification");
  requireText(texts, "scripts/g30-ac5-mutation-runner.mjs", /id: "accept-84"/, "the accept-84 mutation label");
  requireText(texts, "scripts/g30-ac5-mutation-runner.mjs", /id: "reject-85"/, "the reject-85 mutation label");
  requireText(texts, "scripts/g30-ac5-mutation-runner.mjs", /id: "tail-tie-order"/, "the rank-5/6 tie mutation label");
  requireText(texts, "scripts/g30-ac5-mutation-runner.mjs", /id: "unsealed-percentile-estimator"/, "the unsealed-estimator mutation label");
  requireText(texts, "scripts/g30-ac5-mutation-runner.mjs", /id: "root-absent-envelope"/, "the root-absent envelope mutation label");
  let bundle;
  try { bundle = JSON.parse(texts.get("contracts/commit-trace-bundle.json")); } catch { fail("contracts/commit-trace-bundle.json is not valid JSON"); }
  const means19 = Array.isArray(bundle?.hostOnlyInputs)
    ? bundle.hostOnlyInputs.find((entry) => entry?.hostPath === HOST_MEANS_19_PATH)
    : undefined;
  if (means19?.digest !== HOST_MEANS_19_DIGEST) fail("sealed means/19 baseline digest is absent or stale");
  for (const path of ["docs/SDT-G30-pr-body.md", "docs/SDT-G30-oracle-map.md", "docs/commit-tracing.md"]) {
    requireText(texts, path, /schemaCompleteCount\s*>=\s*85|85\/100/, "the bounded-loss delivery contract");
    requireText(texts, path, /rank-1\.\.5/, "the exact rank-1..5 tail contract");
    requireText(texts, path, /root-absent/, "the root-absent UNKNOWN stage");
    requireText(texts, path, /nearest-rank/, "the sealed latency estimator");
  }
  requireText(texts, "scripts/deploy/g30-b0-record-evidence.mjs", /joined per-hop p50\/p95 are joined-cohort conditional descriptive estimates/, "the conditional descriptive per-hop estimate label");
  for (const path of G30_AC5_ACTIVE_ASSERTION_SURFACES) {
    forbidText(texts, path, /zero[- ]loss/i, "zero-loss wording");
    forbidText(texts, path, /exactly 100 complete (?:schemas|traces)/i, "100-complete join wording");
    forbidText(texts, path, /p95(?:-threshold| threshold)[^\n]{0,80}tail/i, "p95-threshold tail wording");
    forbidText(texts, path, /schemaCompleteCount\s*>=\s*95|95\/100|95-of-100/, "superseded 95/100 delivery wording");
  }
  forbidText(texts, "scripts/g30-b0-contract.mjs", /refuses a cohort with loss/i, "equivalent zero-loss wording");
  forbidText(texts, "docs/SDT-G30-pr-body.md", /every B trace.?s individual\s+unattributed/i, "unqualified every-B-trace attribution wording");
  return Object.freeze({ surfaces: G30_AC5_NORMATIVE_SURFACES, result: "bounded-loss-contract-active" });
}

export function selfTest() {
  const baseline = new Map(G30_AC5_NORMATIVE_SURFACES.map((path) => [path, readTarget(path)]));
  assertAc5StructuralContract((path) => baseline.get(path));
  const mutations = [
    ["docs/SDT-G30-pr-body.md", "schemaCompleteCount >= 85", "schemaCompleteCount >= 84"],
    ["docs/SDT-G30-oracle-map.md", "rank-1..5", "p95-threshold tail"],
    ["docs/commit-tracing.md", "root-absent", "root absent"],
    ["scripts/g30-b0-contract.mjs", "G30_MIN_SCHEMA_COMPLETE_COUNT = 85", "G30_MIN_SCHEMA_COMPLETE_COUNT = 84"],
    ["contracts/commit-trace-bundle.json", HOST_MEANS_19_DIGEST, "sha256:0000000000000000000000000000000000000000000000000000000000000000"],
    ["scripts/g30-ac5-mutation-runner.mjs", "id: \"accept-84\"", "id: \"accept-83\""],
    ["scripts/deploy/g30-b0-record-evidence.mjs", "joined per-hop p50/p95 are joined-cohort conditional descriptive estimates", "whole-cohort estimates"],
  ];
  for (const [path, from, to] of mutations) {
    const altered = new Map(baseline);
    const source = altered.get(path);
    if (source?.split(from).length !== 2) fail(`self-test mutation anchor is not unique: ${path}`);
    altered.set(path, source.replace(from, to));
    let red = false;
    try { assertAc5StructuralContract((candidate) => altered.get(candidate)); } catch { red = true; }
    if (!red) fail(`self-test mutation stayed green: ${path}`);
  }
  return Object.freeze({ surfaces: G30_AC5_NORMATIVE_SURFACES.length, mutations: mutations.length });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--self-test")) console.log(JSON.stringify(selfTest(), null, 2));
  else console.log(JSON.stringify(assertAc5StructuralContract(), null, 2));
}
