#!/usr/bin/env node
/** Verify the current G74 machine contracts and their cross-file coverage. */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(new URL("..", import.meta.url).pathname);
const paths = Object.freeze({
  baseline: join(root, "contracts/g74-surface-baseline.json"),
  policy: join(root, "contracts/g74-classification-policy.json"),
  diff: join(root, "contracts/g74-diff-items.json"),
  exports: join(root, "contracts/g74-export-classification.json"),
  routed: join(root, "contracts/g74-routed-items.json"),
  builtKinds: join(root, "packages/dcb-client/dist/classification.js"),
});

function fail(message) { throw new Error(`SDT-G74 contract check: ${message}`); }
function assert(condition, message) { if (!condition) fail(message); }
function load(text, label) { try { return JSON.parse(text); } catch (error) { fail(`${label} is not valid JSON: ${error.message}`); } }

function routedCoverage(routed) {
  const coverage = new Map();
  for (const row of routed.items ?? []) for (const id of row.diffIds ?? []) coverage.set(id, (coverage.get(id) ?? 0) + 1);
  return coverage;
}

async function currentContracts() {
  const [baselineText, policyText, diffText, exportsText, routedText] = await Promise.all([
    readFile(paths.baseline, "utf8"), readFile(paths.policy, "utf8"), readFile(paths.diff, "utf8"),
    readFile(paths.exports, "utf8"), readFile(paths.routed, "utf8"),
  ]);
  return {
    baseline: load(baselineText, "surface baseline"),
    policy: load(policyText, "classification policy"),
    diff: load(diffText, "diff items"),
    exports: load(exportsText, "export classification"),
    routed: load(routedText, "routed items"),
  };
}

async function loadFailureKinds() {
  assert(existsSync(paths.builtKinds), "built classification module is missing; run npm run build:packages first");
  const module = await import(pathToFileURL(paths.builtKinds).href);
  assert(module.FAILURE_KINDS !== null && typeof module.FAILURE_KINDS === "object", "built classification module does not export FAILURE_KINDS");
  return module.FAILURE_KINDS;
}

function checkContracts(value, failureKinds) {
  const { baseline, policy, diff, exports, routed } = value;
  assert(baseline.schema === "sdt-g74-surface/v3", "surface baseline schema mismatch");
  assert(typeof baseline.publicSurfaceHash === "string" && /^[a-f0-9]{64}$/.test(baseline.publicSurfaceHash), "surface baseline hash is invalid");
  assert(policy.schema === "sdt-g74-classification-policy/v1", "classification policy schema mismatch");
  assert(diff.schema === "sdt-g74-diff-items/v1", "diff items schema mismatch");
  assert(exports.schema === "sdt-g74-export-classification/v1", "export classification schema mismatch");
  assert(routed.schema === "sdt-g74-routed-items/v1", "routed items schema mismatch");
  assert(Array.isArray(policy.rows) && policy.rows.length > 0, "classification policy rows are missing");
  for (const row of policy.rows) {
    assert(typeof row.code === "string" && typeof row.kind === "string", "classification policy row is incomplete");
    if (row.code !== "(commit-side unavailable)") assert(failureKinds[row.code] === row.kind, `policy kind for ${row.code} differs from FAILURE_KINDS`);
  }
  const coverage = routedCoverage(routed);
  for (const item of diff.items ?? []) assert(coverage.has(item.id), `committed diff item ${item.id} lacks a routed row`);
  assert(Array.isArray(exports.reviewedModuleInternal), "export classification reviewedModuleInternal is missing");
  assert(exports.module === "packages/dcb-client/src/executor.ts", "export classification module mismatch");
  assert(typeof exports.reviewStatus === "string" && exports.reviewStatus.length > 0, "export classification review status is missing");
}

async function main() {
  const value = await currentContracts();
  const failureKinds = await loadFailureKinds();
  if (process.argv.includes("--self-test")) {
    const kindMutant = { ...failureKinds, aborted: "invalid" };
    let kindRed = false;
    try { checkContracts(value, kindMutant); } catch { kindRed = true; }
    assert(kindRed, "FAILURE_KINDS kind mutant unexpectedly passed");
    const routedMutant = structuredClone(value);
    const first = routedMutant.diff.items[0]?.id;
    routedMutant.routed.items = routedMutant.routed.items.map((row) => ({ ...row, diffIds: (row.diffIds ?? []).filter((id) => id !== first) }));
    let routedRed = false;
    try { checkContracts(routedMutant, failureKinds); } catch { routedRed = true; }
    assert(routedRed, "unrouted diff-item mutant unexpectedly passed");
    process.stdout.write(`${JSON.stringify({ status: "PASS", selfTest: ["failure-kinds-red", "routed-items-red"] })}\n`);
    return;
  }
  checkContracts(value, failureKinds);
  process.stdout.write(`${JSON.stringify({ status: "PASS", publicSurfaceHash: value.baseline.publicSurfaceHash, diffItems: value.diff.items.length, routedItems: value.routed.items.length, classificationRows: value.policy.rows.length })}\n`);
}

main();
