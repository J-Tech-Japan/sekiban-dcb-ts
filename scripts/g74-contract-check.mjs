#!/usr/bin/env node
/** Verify SDT-G74 contract documents stay in sync with machine sources (R2–R5, R9–R10). */
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = join(root, "docs/SDT-G74-contract.md");
const evidencePath = join(root, "docs/SDT-G74-evidence.md");
const baselinePath = join(root, "docs/SDT-G74-surface-baseline.json");
const withdrawnPath = join(root, "docs/SDT-G74-withdrawn-hashes.json");
const routedPath = join(root, "docs/SDT-G74-routed-items.json");
const diffItemsPath = join(root, "docs/SDT-G74-diff-items.json");
const classificationPath = join(root, "docs/SDT-G74-classification-policy.json");
const risksPath = join(root, "docs/SDT-G74-dated-risks.json");
const receiptPath = join(root, "docs/SDT-G74-0.1.0-receipt.json");
const consultationTemplate = join(root, "docs/SDT-G74-consultation-template.md");
const classificationModulePath = join(root, "packages/dcb-client/dist/classification.js");

const POLICY_ONLY_CODES = new Set(["(commit-side unavailable)"]);

function fail(message) {
  throw new Error(`SDT-G74 contract check: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const currentHash = baseline.publicSurfaceHash;
const withdrawn = JSON.parse(await readFile(withdrawnPath, "utf8"));
const withdrawnSet = new Set(withdrawn.withdrawn.map((entry) => entry.hash));
const routed = JSON.parse(await readFile(routedPath, "utf8"));
const diffItems = JSON.parse(await readFile(diffItemsPath, "utf8"));
const classification = JSON.parse(await readFile(classificationPath, "utf8"));
const risks = JSON.parse(await readFile(risksPath, "utf8"));
const contract = await readFile(contractPath, "utf8");
const evidence = await readFile(evidencePath, "utf8");

async function docsHashes() {
  const hashes = new Set();
  const docsDir = join(root, "docs");
  for (const name of await readdir(docsDir)) {
    if (!name.startsWith("SDT-G74-")) continue;
    const text = await readFile(join(docsDir, name), "utf8");
    for (const match of text.matchAll(/\b[0-9a-f]{64}\b/g)) hashes.add(match[0]);
  }
  return hashes;
}

function allowedReceiptHashes(receipt) {
  const allowed = new Set([receipt.modelHash, receipt.candidateHash]);
  for (const pkg of receipt.registryPackages ?? []) allowed.add(pkg.integrity);
  return allowed;
}

function checkHashHygiene(hashes, receipt) {
  const receiptAllowed = allowedReceiptHashes(receipt);
  for (const hash of hashes) {
    if (hash === currentHash) continue;
    if (withdrawnSet.has(hash)) continue;
    if (receiptAllowed.has(hash)) continue;
    fail(`stale or unexpected hash ${hash} in docs/SDT-G74-* outside withdrawn list`);
  }
  assert(contract.includes(currentHash), "contract must contain current publicSurfaceHash");
  assert(evidence.includes(currentHash), "evidence must contain current publicSurfaceHash");
  for (const entry of withdrawn.withdrawn) {
    if (entry.hash === currentHash) fail(`current hash ${currentHash} must not appear in withdrawn list`);
  }
}

function normalizedIncludes(haystack, needle) {
  return haystack.replace(/`/g, "").includes(needle.replace(/`/g, ""));
}

function routedCoverageByDiffId() {
  const coverage = new Map();
  for (const item of routed.items) {
    for (const diffId of item.diffIds ?? []) {
      if (!coverage.has(diffId)) coverage.set(diffId, []);
      coverage.get(diffId).push(item.key);
    }
  }
  return coverage;
}

function checkRoutedItems() {
  const coverage = routedCoverageByDiffId();
  for (const item of routed.items) {
    assert(normalizedIncludes(contract, item.routedItem), `contract missing routed item row for ${item.key}: ${item.routedItem}`);
  }
  for (const diffItem of diffItems.items) {
    assert(coverage.has(diffItem.id), `committed diff item ${diffItem.id} (${diffItem.kind}) lacks a routed row`);
  }
  assert(contract.includes("docs/SDT-G74-0.1.0-receipt.json"), "contract must cite 0.1.0 extraction receipt");
  assert(contract.includes("docs/SDT-G74-diff-items.json"), "contract must cite committed 0.1.0 diff item list");
  assert(contract.includes("TS2835"), "contract must disclose TS2835 specifier normalization");
}

async function loadFailureKinds() {
  assert(existsSync(classificationModulePath), "packages/dcb-client/dist/classification.js is missing; run npm run build:packages first");
  const module = await import(pathToFileURL(classificationModulePath).href);
  assert(typeof module.FAILURE_KINDS === "object" && module.FAILURE_KINDS !== null, "built classification module does not export FAILURE_KINDS");
  return module.FAILURE_KINDS;
}

function checkClassificationTableIn(text, failureKinds) {
  assert(text.includes("Consumer-visible error classification"), "contract missing AC6 classification table heading");
  for (const row of classification.rows) {
    assert(text.includes(row.code === "(commit-side unavailable)" ? "commit-side unavailable" : row.code),
      `classification table missing code ${row.code}`);
    assert(text.includes(row.readPathAction), `classification table missing read-path action for ${row.code}`);
    assert(text.includes(row.commitPathAction), `classification table missing commit-path action for ${row.code}`);
    if (!POLICY_ONLY_CODES.has(row.code)) {
      const runtimeKind = failureKinds[row.code];
      assert(typeof runtimeKind === "string", `policy code ${row.code} is missing from FAILURE_KINDS`);
      assert(runtimeKind === row.kind, `policy kind ${row.kind} for ${row.code} differs from FAILURE_KINDS ${runtimeKind}`);
    }
  }
}

async function checkClassificationTable() {
  const failureKinds = await loadFailureKinds();
  checkClassificationTableIn(contract, failureKinds);
}

function checkDatedRisks() {
  for (const row of risks.rows) {
    assert(contract.includes(row.risk), `contract missing dated risk ${row.key}: ${row.risk}`);
  }
  assert(contract.includes("unsafe-lane"), "contract missing unsafe-lane latency risk");
  assert(contract.includes("no-tags WIT"), "contract missing WasmRuntime WIT ABI risk");
  assert(contract.includes("criteria still outstanding on prerequisite"), "contract missing outstanding-prerequisite-criteria statement");
}

async function checkConsultationTemplateAbsent() {
  try {
    await readFile(consultationTemplate, "utf8");
    fail("docs/SDT-G74-consultation-template.md must be deleted");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

if (process.argv.includes("--self-test")) {
  const failureKinds = await loadFailureKinds();
  const mutantKind = { ...failureKinds, aborted: "invalid" };
  let kindRed = false;
  try {
    checkClassificationTableIn(contract, mutantKind);
  } catch {
    kindRed = true;
  }
  assert(kindRed, "FAILURE_KINDS kind mutant self-test unexpectedly passed");

  const policyMutant = contract.replace(classification.rows[0].readPathAction, "WRONG ACTION");
  let policyRed = false;
  try {
    checkClassificationTableIn(policyMutant, failureKinds);
  } catch {
    policyRed = true;
  }
  assert(policyRed, "classification-policy prose mutant self-test unexpectedly passed");

  let routedRed = false;
  try {
    const missing = routed.items.find((item) => (item.diffIds ?? []).length > 0)?.routedItem;
    if (missing !== undefined && contract.includes(missing)) {
      const routedMutant = contract.replace(missing, "REMOVED ROW");
      for (const item of routed.items) {
        assert(normalizedIncludes(routedMutant, item.routedItem), `contract missing routed item row for ${item.key}`);
      }
    }
  } catch {
    routedRed = true;
  }
  assert(routedRed, "routed-items prose mutant self-test unexpectedly passed");

  let diffRed = false;
  try {
    const extra = { ...diffItems, items: [...diffItems.items, { id: "@sekiban/dcb-client::SyntheticDiff", kind: "added" }] };
    const coverage = routedCoverageByDiffId();
    for (const diffItem of extra.items) {
      assert(coverage.has(diffItem.id), `committed diff item ${diffItem.id} (${diffItem.kind}) lacks a routed row`);
    }
  } catch {
    diffRed = true;
  }
  assert(diffRed, "unrouted diff-item mutant self-test unexpectedly passed");

  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    selfTest: ["failure-kinds-red", "classification-policy-red", "routed-items-red", "diff-item-red"],
  }, null, 2)}\n`);
} else {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const hashes = await docsHashes();
  checkHashHygiene(hashes, receipt);
  checkRoutedItems();
  await checkClassificationTable();
  checkDatedRisks();
  await checkConsultationTemplateAbsent();
  assert(receipt.schema === "sdt-g74-0.1.0-receipt/v1", "0.1.0 receipt schema mismatch");
  assert(Array.isArray(receipt.registryPackages) && receipt.registryPackages.length === 3, "0.1.0 receipt must record three registry packages");
  assert(receipt.specifierNormalization?.disclosure?.includes("TS2835"), "0.1.0 receipt must disclose TS2835 workaround");
  assert(receipt.candidateHash === currentHash, "0.1.0 receipt candidateHash must match current baseline");
  assert(diffItems.schema === "sdt-g74-diff-items/v1", "diff items schema mismatch");
  assert(diffItems.items.length === receipt.diffSummary.removedExportCount + receipt.diffSummary.addedExportCount + receipt.diffSummary.changedExportCount,
    "committed diff item count must match 0.1.0 receipt summary");
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    publicSurfaceHash: currentHash,
    routedItems: routed.items.length,
    diffItems: diffItems.items.length,
    classificationRows: classification.rows.length,
    datedRisks: risks.rows.length,
    withdrawnHashes: withdrawn.withdrawn.length,
  }, null, 2)}\n`);
}
