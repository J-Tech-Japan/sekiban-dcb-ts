#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = join(root, "contracts/cosmos-layout.json");
const runtimePath = join(root, "packages/dcb-runtime/src/generated/cosmos-layout.ts");
const starterPath = join(root, "packages/create-dcb/template/cosmos.experimental.json");
const guidePath = join(root, "docs/cosmos-layout.md");

const expectedContainerKeys = ["events", "lagEstimates", "pendingArrivals", "findings", "checkpoints"];
const expectedContainerNames = [
  "dcb-events", "dcb-lag-estimates", "dcb-pending-arrivals", "dcb-findings", "dcb-projection-checkpoints",
];
const guidanceRequirements = [
  {
    id: "cosmos-live-tag-rebuild-exclusion",
    pattern: new RegExp([
      "Cosmos live tag rebuild, a live cross-provider round trip, correction",
      "application, and a real Azure account probe are unsupported\\.",
    ].join("\\n")),
  },
  {
    id: "postgres-sealed-rebuild-exclusion",
    pattern: /The sealed rebuild\s+command remains PostgreSQL-only\./,
  },
  {
    id: "no-production-account-result",
    pattern: /This is not a production-support promise or a production-account check\./,
  },
];
const labelInventory = [
  { id: "root-readme", path: "README.md", kind: "text", pattern: /experimental cosmos/i },
  { id: "runtime-readme", path: "packages/dcb-runtime/README.md", kind: "text", pattern: /experimental cosmos/i },
  { id: "starter-readme", path: "packages/create-dcb/README.md", kind: "text", pattern: /experimental/i },
  { id: "generated-starter-readme", path: "packages/create-dcb/template/README.md", kind: "text", pattern: /experimental cosmos/i },
  { id: "sample-readme", path: "samples/meeting-room/README.md", kind: "text", pattern: /experimental cosmos/i },
  { id: "provider-guide", path: "docs/cosmos-layout.md", kind: "text", pattern: /experimental cosmos/i },
  { id: "comparison-guide", path: "docs/d1-pipeline-store.md", kind: "text", pattern: /experimental cosmos/i },
  { id: "domain-guide", path: "docs/domain-authoring.md", kind: "text", pattern: /experimental cosmos/i },
  { id: "migration-guide", path: "docs/migration-sekiban-dcb.md", kind: "text", pattern: /experimental cosmos/i },
  { id: "generated-descriptor", path: "packages/create-dcb/template/cosmos.experimental.json", kind: "descriptor" },
];
const secretArtifactPaths = [
  "packages/create-dcb/template/cosmos.experimental.json",
  "packages/create-dcb/template/wrangler.jsonc",
  ...readdirSync(join(root, "test"))
    .filter((path) => /^cosmos.*\.spec\.ts$/.test(path))
    .map((path) => join("test", path)),
];
const keyShapedValue = /(?:COSMOS_KEY|["']key["'])\s*[:=]\s*["'][A-Za-z0-9+/]{20,}={0,2}["']/;

function assertContractShape(contract) {
  assert.equal(contract.schemaVersion, 1, "schema version must be 1");
  assert.equal(contract.stability, "experimental", "layout must be experimental");
  assert.equal(contract.provider, "cosmos", "provider id must be cosmos");
  assert.equal(contract.logicalEventContract, "contracts/event-store-ddl.json#cosmos", "logical event link changed");
  assert.deepEqual(Object.keys(contract.bindings).sort(), ["database", "endpoint", "key"]);
  assert.deepEqual(Object.keys(contract.containers), expectedContainerKeys);
  assert.equal(Object.values(contract.containers).length, 5);
  assert.deepEqual(
    Object.values(contract.containers).map((container) => container.name).sort(),
    [...expectedContainerNames].sort(),
    "container names changed",
  );
  assert.equal(contract.containers.events.partitionKeyPath, "/pk");
  const auxiliaryPartitionPath = contract.containers.lagEstimates.partitionKeyPath;
  assert.equal(auxiliaryPartitionPath, "/serviceId");
  for (const key of expectedContainerKeys.slice(1)) {
    assert.equal(contract.containers[key].partitionKeyPath, auxiliaryPartitionPath);
  }
  assert.deepEqual(contract.containers.events.partitionValueKinds, [
    "{serviceId}|{eventId}", "{serviceId}|__dcb_event_ops__",
  ]);
  for (const key of expectedContainerKeys.slice(1)) {
    assert.deepEqual(contract.containers[key].partitionValueKinds, ["{serviceId}"]);
  }
  assert.deepEqual(contract.containers.events.documentIds, {
    logicalEvent: "canonical event id",
    eventSidecar: "safeId(\"event-ops\", eventId)",
    serviceGuards: {
      allocatorLineageBinding: "safeId(\"allocator-lineage-binding\")",
      suidBinding: "safeId(\"suid-binding\", suid)",
      deliveryIncident: "safeId(\"incident\", identityKey)",
    },
  });
  assert.deepEqual(contract.containers.lagEstimates.documentIds, { lagEstimate: "serviceId" });
  assert.deepEqual(contract.containers.pendingArrivals.documentIds, { pendingArrival: "safeId(eventId)" });
  assert.deepEqual(contract.containers.findings.documentIds, {
    finding: "safeId(eventId, path, classification)",
    incidentProjection: "safeId(\"incident\", identityKey)",
  });
  assert.deepEqual(contract.containers.checkpoints.documentIds, { checkpoint: "safeId(projectionId)" });
}

function renderArtifacts(contract) {
  const containers = Object.fromEntries(Object.entries(contract.containers).map(([key, entry]) => [key, {
    name: entry.name,
    partitionKeyPath: entry.partitionKeyPath,
    partitionValueKinds: entry.partitionValueKinds,
    documentIds: entry.documentIds,
  }]));
  const runtime = `// Generated by scripts/cosmos-layout-contract.mjs. Do not edit.\n\n` +
    `export const COSMOS_LAYOUT_STABILITY = ${JSON.stringify(contract.stability)} as const;\n` +
    `export const COSMOS_PROVIDER_ID = ${JSON.stringify(contract.provider)} as const;\n` +
    `export const COSMOS_BINDINGS = Object.freeze(${JSON.stringify(contract.bindings, null, 2)}) as {\n` +
    `  readonly endpoint: "COSMOS_ENDPOINT";\n  readonly database: "COSMOS_DATABASE";\n  readonly key: "COSMOS_KEY";\n};\n` +
    `export const COSMOS_CONTAINER_LAYOUT = Object.freeze(${JSON.stringify(containers, null, 2)} as const);\n` +
    `export const COSMOS_DOCUMENT_ID_RULES = Object.freeze(${JSON.stringify(Object.fromEntries(Object.entries(contract.containers).map(([key, entry]) => [key, entry.documentIds])), null, 2)} as const);\n` +
    `export const COSMOS_CONTAINER_NAMES = Object.freeze(${JSON.stringify(Object.fromEntries(Object.entries(contract.containers).map(([key, entry]) => [key, entry.name])), null, 2)} as const);\n`;
  const descriptor = {
    stability: contract.stability,
    provider: contract.provider,
    active: false,
    bindings: contract.bindings,
    containers: Object.fromEntries(Object.entries(contract.containers).map(([key, entry]) => [key, {
      name: entry.name,
      partitionKeyPath: entry.partitionKeyPath,
      partitionValueKinds: entry.partitionValueKinds,
      documentIds: entry.documentIds,
    }])),
  };
  return { runtime, starter: `${JSON.stringify(descriptor, null, 2)}\n` };
}

function parseGuideRows(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|$/);
    if (match && match[1] !== "key") rows.push({ key: match[1], name: match[2], path: match[3], values: match[4] });
  }
  return rows;
}

function validateGuide(text, contract) {
  const rows = parseGuideRows(text);
  const expected = expectedContainerKeys.map((key) => ({
    key,
    name: contract.containers[key].name,
    path: contract.containers[key].partitionKeyPath,
    values: contract.containers[key].partitionValueKinds.join("; "),
  }));
  assert.deepEqual(rows, expected, "guide layout table does not match the contract");
  assert.match(text, /experimental/i, "guide must label Cosmos experimental");
  assert.match(text, /COSMOS_KEY/, "guide must name the secret binding");
  for (const requirement of guidanceRequirements) {
    assert.match(text, requirement.pattern, `${requirement.id} guidance is missing`);
  }
}

function validateLogicalEvent(contract, ddl) {
  assert.equal(ddl.cosmos?.partitionKeyPath, contract.containers.events.partitionKeyPath);
  assert.equal(ddl.cosmos?.pk, "{serviceId}|{id}");
  assert.deepEqual(ddl.logicalRecord.fields.map((field) => field.id), [
    "serviceId", "id", "sortableUniqueId", "eventType", "payload", "tags", "timestamp",
    "causationId", "correlationId", "executedUser",
  ]);
}

function isCompleteLayoutContract(value, contract) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value.containers === undefined) {
    return false;
  }
  const keys = Object.keys(value.containers);
  if (keys.length !== expectedContainerKeys.length
    || !expectedContainerKeys.every((key) => keys.includes(key))) return false;
  return expectedContainerKeys.every((key) => value.containers[key]?.name === contract.containers[key].name);
}

function validateSingleAuthority(entries, contract) {
  const matches = entries
    .filter((entry) => isCompleteLayoutContract(entry.document, contract))
    .map((entry) => entry.path);
  assert.deepEqual(
    matches.sort(),
    ["contracts/cosmos-layout.json", "packages/create-dcb/template/cosmos.experimental.json"],
    "a second complete Cosmos layout authority exists",
  );
}

function validateExperimentalLabels(surfaces) {
  for (const entry of labelInventory) {
    const value = surfaces.get(entry.path);
    assert.notEqual(value, undefined, `experimental label surface is missing: ${entry.path}`);
    if (entry.kind === "descriptor") {
      assert.equal(value.stability, "experimental", `${entry.id} must remain experimental`);
      continue;
    }
    assert.match(value, entry.pattern, `${entry.id} is missing its experimental label`);
  }
}

function validateSecretArtifacts(receipt = "") {
  for (const path of secretArtifactPaths) {
    const text = readFileSync(join(root, path), "utf8");
    assert.doesNotMatch(text, keyShapedValue, `credential-shaped value found in ${path}`);
  }
  assert.doesNotMatch(receipt, keyShapedValue, "credential-shaped value found in layout receipt");
}

function parseExportInventory(text) {
  const inventory = [];
  const exportPattern = new RegExp([
    "(^|\\n)",
    "(?<doc>\\/\\*\\*[\\s\\S]*?\\*\\/\\n)?",
    "\\s*export\\s+",
    "(?:(?<type>type)\\s+)?",
    "(?:(?:declare\\s+)?(?<declaration>class|interface|function|const)\\s+",
    "(?<name>[A-Za-z_$][\\w$]*)|\\{(?<names>[^}]+)\\})",
  ].join(""), "g");
  for (const match of text.matchAll(exportPattern)) {
    const doc = match.groups?.doc ?? "";
    if (match.groups?.names !== undefined) {
      for (const name of match.groups.names.split(",").map((value) => value.trim()).filter(Boolean)) {
        const [exportedName] = name.split(/\s+as\s+/);
        inventory.push({
          name: exportedName,
          kind: match.groups.type === "type" ? "type" : "value",
          experimental: /@experimental\b/.test(doc),
        });
      }
      continue;
    }
    const declaration = match.groups?.declaration;
    const name = match.groups?.name;
    if (declaration !== undefined && name !== undefined) {
      inventory.push({
        name,
        kind: declaration === "function" ? "factory" : declaration,
        experimental: /@experimental\b/.test(doc),
      });
    }
  }
  return inventory;
}

function validateExperimentalExports(source, declarations) {
  const sourceInventory = parseExportInventory(source);
  const declarationInventory = parseExportInventory(declarations);
  assert.ok(sourceInventory.length > 0, "Cosmos entry point export inventory is empty");
  assert.deepEqual(
    declarationInventory.map(({ name, kind }) => ({ name, kind })),
    sourceInventory.map(({ name, kind }) => ({ name, kind })),
    "Cosmos source and declaration export inventories differ",
  );
  for (const entry of sourceInventory) {
    assert.equal(entry.experimental, true, `Cosmos source export ${entry.name} is missing @experimental`);
  }
  for (const entry of declarationInventory) {
    assert.equal(entry.experimental, true, `Cosmos declaration export ${entry.name} is missing @experimental`);
  }
  return sourceInventory;
}

function validateArtifacts(
  contract, runtime, starter, guide, ddl, contractEntries, surfaces = new Map(), source = "", declarations = "",
) {
  assertContractShape(contract);
  const rendered = renderArtifacts(contract);
  assert.equal(Buffer.compare(Buffer.from(runtime), Buffer.from(rendered.runtime)), 0, "generated runtime layout is stale or hand-edited");
  assert.equal(Buffer.compare(Buffer.from(starter), Buffer.from(rendered.starter)), 0, "generated starter descriptor is stale or hand-edited");
  validateGuide(guide, contract);
  validateLogicalEvent(contract, ddl);
  validateSingleAuthority(contractEntries, contract);
  if (surfaces.size > 0) validateExperimentalLabels(surfaces);
  if (source.length > 0 || declarations.length > 0) validateExperimentalExports(source, declarations);
  validateSecretArtifacts();
}

async function loadInputs() {
  const trackedJson = execFileSync("git", ["ls-files", "--", "*.json"], { cwd: root, encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  const [contractText, guide, ddlText] = await Promise.all([
    readFile(contractPath, "utf8"),
    readFile(guidePath, "utf8"), readFile(join(root, "contracts/event-store-ddl.json"), "utf8"),
  ]);
  const [source, declarations] = await Promise.all([
    readFile(join(root, "packages/dcb-runtime/src/cosmos.ts"), "utf8"),
    readFile(join(root, "packages/dcb-runtime/dist/cosmos.d.ts"), "utf8"),
  ]);
  const runtime = readFileSync(runtimePath);
  const starter = readFileSync(starterPath);
  const entries = trackedJson.map((path) => ({ path, document: JSON.parse(readFileSync(join(root, path), "utf8")) }));
  const surfaceValues = await Promise.all(labelInventory.map(async (entry) => {
    const text = await readFile(join(root, entry.path), "utf8");
    return [entry.path, entry.kind === "descriptor" ? JSON.parse(text) : text];
  }));
  return {
    contract: JSON.parse(contractText), runtime, starter, guide, ddl: JSON.parse(ddlText), entries,
    surfaces: new Map(surfaceValues), source, declarations,
  };
}

function expectRed(action, label) {
  let error = null;
  try { action(); } catch (caught) { error = caught; }
  assert.ok(error !== null, `${label} mutation unexpectedly passed`);
}

async function selfTest() {
  const input = await loadInputs();
  validateArtifacts(
    input.contract, input.runtime, input.starter, input.guide, input.ddl, input.entries,
    input.surfaces, input.source, input.declarations,
  );
  const mutation = structuredClone(input.contract);
  delete mutation.containers.findings;
  expectRed(() => assertContractShape(mutation), "missing container");
  const eventPath = structuredClone(input.contract);
  eventPath.containers.events.partitionKeyPath = "/serviceId";
  expectRed(() => assertContractShape(eventPath), "event partition path");
  const auxiliaryPath = structuredClone(input.contract);
  auxiliaryPath.containers.findings.partitionKeyPath = "/pk";
  expectRed(() => assertContractShape(auxiliaryPath), "auxiliary partition path");
  const coordinatedNameDrift = structuredClone(input.contract);
  coordinatedNameDrift.containers.events.name = "dcb-events-mutated";
  const coordinatedNameArtifacts = renderArtifacts(coordinatedNameDrift);
  const coordinatedNameGuide = input.guide.replace("dcb-events", "dcb-events-mutated");
  expectRed(
    () => validateArtifacts(
      coordinatedNameDrift,
      coordinatedNameArtifacts.runtime,
      coordinatedNameArtifacts.starter,
      coordinatedNameGuide,
      input.ddl,
      input.entries,
    ),
    "coordinated container name drift",
  );
  expectRed(
    () => validateArtifacts(input.contract, `${input.runtime}x`, input.starter, input.guide, input.ddl, input.entries),
    "runtime mutation",
  );
  expectRed(
    () => validateArtifacts(input.contract, input.runtime, `${input.starter}x`, input.guide, input.ddl, input.entries),
    "starter mutation",
  );
  expectRed(() => validateGuide(input.guide.replace("dcb-events", "dcb-events-mutated"), input.contract), "guide mutation");
  expectRed(() => validateSingleAuthority([
    { path: "contracts/cosmos-layout.json", document: input.contract },
    { path: "packages/create-dcb/template/cosmos.experimental.json", document: input.contract },
    {
      path: "contracts/cosmos-containers.json",
      document: {
        ...input.contract,
        containers: {
          ...input.contract.containers,
          events: { ...input.contract.containers.events, partitionKeyPath: "/serviceId" },
        },
      },
    },
  ], input.contract), "second authority");
  for (const entry of labelInventory) {
    const mutated = new Map(input.surfaces);
    if (entry.kind === "descriptor") mutated.set(entry.path, { ...mutated.get(entry.path), stability: "stable" });
    else mutated.set(entry.path, String(mutated.get(entry.path)).replace(/experimental/gi, "stable"));
    expectRed(() => validateExperimentalLabels(mutated), `${entry.id} experimental label`);
  }
  const exportInventory = validateExperimentalExports(input.source, input.declarations);
  for (const entry of exportInventory) {
    const labelPattern = new RegExp(`@experimental[^\\n]*\\n(?=export[^\\n]*\\b${entry.name}\\b)`);
    const sourceMutation = input.source.replace(labelPattern, "");
    const declarationMutation = input.declarations.replace(labelPattern, "");
    expectRed(
      () => validateExperimentalExports(sourceMutation, input.declarations),
      `${entry.name} source experimental label`,
    );
    expectRed(
      () => validateExperimentalExports(input.source, declarationMutation),
      `${entry.name} declaration experimental label`,
    );
  }
  expectRed(() => validateGuide(
    input.guide.replace(guidanceRequirements[0].pattern, ""), input.contract,
  ), guidanceRequirements[0].id);
  expectRed(() => validateGuide(
    input.guide.replace(guidanceRequirements[1].pattern, ""), input.contract,
  ), guidanceRequirements[1].id);
  expectRed(() => validateGuide(
    input.guide.replace(guidanceRequirements[2].pattern, ""), input.contract,
  ), guidanceRequirements[2].id);
  process.stdout.write(JSON.stringify({
    result: "cosmos-layout-self-test-passed",
    mutations: 9 + labelInventory.length + exportInventory.length * 2 + guidanceRequirements.length,
  }) + "\n");
}

async function main() {
  if (process.argv.includes("--write")) {
    const contract = JSON.parse(await readFile(contractPath, "utf8"));
    assertContractShape(contract);
    await mkdir(dirname(runtimePath), { recursive: true });
    const rendered = renderArtifacts(contract);
    await writeFile(runtimePath, rendered.runtime);
    await writeFile(starterPath, rendered.starter);
    process.stdout.write(JSON.stringify({ result: "cosmos-layout-written", runtime: runtimePath, starter: starterPath }) + "\n");
    return;
  }
  const input = await loadInputs();
  if (process.argv.includes("--self-test")) return selfTest();
  validateArtifacts(
    input.contract, input.runtime, input.starter, input.guide, input.ddl, input.entries,
    input.surfaces, input.source, input.declarations,
  );
  const receipt = JSON.stringify({
    result: "cosmos-layout-check-passed",
    containers: Object.values(input.contract.containers).map((entry) => entry.name),
  });
  validateSecretArtifacts(receipt);
  process.stdout.write(`${receipt}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

export { renderArtifacts, validateArtifacts, validateExperimentalLabels };
