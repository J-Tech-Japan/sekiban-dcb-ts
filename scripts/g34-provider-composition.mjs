import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const manifestPath = "contracts/provider-composition.json";
export const mappingPath = "contracts/provider-composition.local-mapping.json";
export const generatedPath = "samples/meeting-room/src/generated/provider-composition.ts";
export const DOMAIN = "sekiban-dcb-ts/provider-composition-manifest/v1";
export const CANONICALIZATION_VERSION = "rfc8785";

const BINDING_FUNCTIONS = [
  ["ALLOCATOR", "allocatorBinding"],
  ["BOOTSTRAP", "bootstrapBinding"],
  ["D1_MV", "materializedViewD1"],
  ["D1", "pipelineD1"],
  ["DOWNSTREAM_DOORBELL", "downstreamDoorbell"],
  ["DOWNSTREAM_QUEUE", "downstreamQueue"],
  ["JOURNAL", "journalBinding"],
  ["TAG", "tagBinding"],
];

const DIAGNOSTIC_REASONS = new Set([
  "cardinality",
  "credential-redacted",
  "deep-merge-forbidden",
  "do-migration-owner",
  "duplicate-row",
  "entrypoint-missing",
  "generated-drift",
  "global-binding",
  "legacy-fail-new-pass",
  "migration-order",
  "migration-swap",
  "missing-row",
  "new-fail-legacy-pass",
  "queues-forbidden",
  "raw-binding",
  "resource-identity-mismatch",
  "same-resource",
  "scope-proof-unavailable",
  "second-manifest",
  "second-shard",
  "unknown-input",
  "unresolved-kept-var",
]);

export class CompositionDiagnostic extends Error {
  constructor(diagnostic) {
    super(diagnostic.code);
    this.name = "CompositionDiagnostic";
    this.diagnostic = freezeDiagnostic(diagnostic);
  }
}

function freezeDiagnostic(diagnostic) {
  const reason = diagnostic.reason;
  if (!DIAGNOSTIC_REASONS.has(reason)) {
    throw new Error(`diagnostic reason is not in the finite schema: ${reason}`);
  }
  return Object.freeze({
    code: diagnostic.code,
    path: diagnostic.path,
    reason,
  });
}

export function diagnostic(code, path, reason) {
  return freezeDiagnostic({ code, path, reason });
}

function fail(code, path, reason) {
  throw new CompositionDiagnostic(diagnostic(code, path, reason));
}

export function jcs(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error("JCS number is not finite");
    if (!Number.isSafeInteger(value)) throw new Error("JCS number must be a safe integer in this profile");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => jcs(item)).join(",")}]`;
  if (typeof value !== "object") throw new Error("JCS value is not a JSON type");
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${jcs(value[key])}`).join(",")}}`;
}

export function digestBytes(payload, domain = DOMAIN) {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0")
    .update(jcs(payload), "utf8")
    .digest("hex");
}

export function publishedPayload(manifest) {
  const resources = [...manifest.resources].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const edges = [...manifest.edges].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return {
    canonicalizationVersion: manifest.canonicalizationVersion,
    cardinalities: manifest.cardinalities,
    components: manifest.components,
    durableObjectClasses: manifest.durableObjectClasses,
    edges,
    migrationDomains: manifest.migrationDomains,
    profileId: manifest.profileId,
    resources,
    schemaVersion: manifest.schemaVersion,
    scopeAxes: manifest.scopeAxes,
    tenantRef: manifest.tenantRef,
  };
}

export function manifestDigest(manifest, domain = DOMAIN) {
  return {
    algorithm: "sha256",
    domain,
    nulTerminated: true,
    canonicalizationVersion: CANONICALIZATION_VERSION,
    digest: digestBytes(publishedPayload(manifest), domain),
  };
}

export function loadJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

export function loadManifest() {
  return loadJson(manifestPath);
}

export function loadMapping() {
  return loadJson(mappingPath);
}

function resourceById(manifest, id) {
  return manifest.resources.find((resource) => resource.id === id);
}

function edgesFrom(manifest, componentId, kind) {
  return manifest.edges.filter((edge) => edge.from === componentId && edge.kind === kind);
}

function bindingNames(config) {
  const names = [];
  for (const entry of config?.d1_databases ?? []) names.push(entry.binding);
  for (const entry of config?.durable_objects?.bindings ?? []) names.push(entry.name);
  for (const entry of config?.queues?.producers ?? []) names.push(entry.binding);
  for (const entry of config?.services ?? []) names.push(entry.binding);
  return names;
}

export function generateSource(manifest) {
  const descriptor = {
    profileId: manifest.profileId,
    components: manifest.components.map((component) => ({
      id: component.id,
      entrypoints: component.entrypoints,
    })),
    bindings: BINDING_FUNCTIONS.map(([name]) => name),
  };
  const functions = BINDING_FUNCTIONS.map(([name, fn]) => [
    `export function ${fn}<E extends { ${name}?: unknown }>(env: E): NonNullable<E["${name}"]> {`,
    `  return env["${name}"] as NonNullable<E["${name}"]>;`,
    `}`,
  ].join("\n")).join("\n\n");
  return [
    "// Generated from contracts/provider-composition.json by scripts/g34-provider-composition.mjs. Do not edit.",
    `export const providerCompositionDigest = ${JSON.stringify(digestBytes(publishedPayload(manifest)))};`,
    `export const providerCompositionDescriptor = ${JSON.stringify(descriptor)} as const;`,
    "",
    functions,
    "",
  ].join("\n");
}

export function checkGenerated(manifest = loadManifest(), source = readFileSync(join(root, generatedPath), "utf8")) {
  const expected = generateSource(manifest);
  if (source !== expected) fail("GENERATED_DRIFT", generatedPath, "generated-drift");
  const embedded = source.match(/providerCompositionDescriptor = (\{.*\}) as const;/s);
  if (embedded === null) fail("GENERATED_DRIFT", generatedPath, "generated-drift");
  const descriptor = JSON.parse(embedded[1]);
  const receiver = descriptor.components.find((component) => component.id === "receiver");
  const required = receiver?.entrypoints?.[0]?.requiredBindings ?? [];
  if (required.includes("DOWNSTREAM_QUEUE")) fail("GENERATED_DRIFT", "receiver.entrypoints", "generated-drift");
  return expected;
}

export function findRawBindingReads(files) {
  const names = BINDING_FUNCTIONS.map(([name]) => name).sort((left, right) => right.length - left.length);
  const pattern = new RegExp(`\\benv\\.(${names.join("|")})\\b`, "g");
  const hits = [];
  for (const file of files) {
    if (file.endsWith(generatedPath)) continue;
    const text = readFileSync(join(root, file), "utf8");
    if (pattern.test(text)) hits.push(file);
    pattern.lastIndex = 0;
  }
  return hits;
}

function walkTs(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkTs(path, acc);
    else if (entry.name.endsWith(".ts")) acc.push(relative(root, path));
  }
  return acc;
}

export function scanSampleBindingReads() {
  const hits = findRawBindingReads(walkTs(join(root, "samples/meeting-room/src")));
  if (hits.length !== 0) fail("RAW_BINDING", hits[0], "raw-binding");
  return hits;
}

export function assertSingleSource(files) {
  const manifests = files.filter((file) => {
    const base = file.split("/").pop() ?? file;
    return base.startsWith("provider-composition") && base.endsWith(".json") && !base.includes("local-mapping");
  });
  if (manifests.length !== 1 || manifests[0] !== manifestPath) {
    fail("SECOND_MANIFEST", manifests.find((file) => file !== manifestPath) ?? manifestPath, "second-manifest");
  }
}

function requireAxes(component) {
  for (const axis of ["logicalServiceScope", "deploymentComponentScope", "providerTenantScope", "physicalResourceScope"]) {
    if (component[axis] === undefined || component[axis] === null || component[axis] === "") {
      fail("SCOPE_PROOF_UNAVAILABLE", `${component.id}.${axis}`, "scope-proof-unavailable");
    }
  }
}

function tenantRefOf(manifest) {
  return typeof manifest.tenantRef === "string" ? manifest.tenantRef : "";
}

export function validateManifest(manifest, mapping) {
  if (tenantRefOf(manifest).length < 16) fail("SCOPE_PROOF_UNAVAILABLE", "tenantRef", "scope-proof-unavailable");
  if (!Array.isArray(mapping?.resources ? Object.keys(mapping.resources) : null)) {
    fail("SCOPE_PROOF_UNAVAILABLE", mappingPath, "scope-proof-unavailable");
  }
  const pipeline = manifest.resources.filter((resource) => resource.role === "pipeline-D1");
  if (pipeline.length !== 1) fail("SECOND_SHARD", "resources.pipeline-D1", "second-shard");
  const mv = manifest.resources.filter((resource) => resource.role === "MV-D1");
  if (mv.length !== 1 || mv[0].resourceRef === pipeline[0].resourceRef) {
    fail("CARDINALITY", "resources.MV-D1", "cardinality");
  }
  for (const component of manifest.components) {
    requireAxes(component);
    if (component.providerTenantScope?.tenantRef !== manifest.tenantRef) {
      fail("SCOPE_PROOF_UNAVAILABLE", `${component.id}.providerTenantScope`, "scope-proof-unavailable");
    }
    const owner = manifest.migrationDomains["durable-object"][component.id];
    if (owner?.owner !== component.id) fail("DO_MIGRATION_OWNER", `${component.id}.durable-object`, "do-migration-owner");
    for (const [kind, expected] of Object.entries(manifest.cardinalities[component.id])) {
      const actual = componentEdgeCount(manifest, component.id, kind);
      if (actual !== expected) fail("CARDINALITY", `${component.id}.${kind}`, "cardinality");
    }
  }
  const primaryDo = resourceById(manifest, "primary-do");
  const receiverDo = resourceById(manifest, "receiver-do");
  if (primaryDo.resourceRef === receiverDo.resourceRef || primaryDo.scriptName !== null || receiverDo.scriptName !== null) {
    fail("SAME_RESOURCE", "durable-object", "same-resource");
  }
  const classes = [...manifest.durableObjectClasses];
  if (JSON.stringify(classes) !== JSON.stringify([...classes].sort())) {
    fail("CARDINALITY", "durableObjectClasses", "cardinality");
  }
  return manifestDigest(manifest);
}

function componentEdgeCount(manifest, componentId, kind) {
  if (kind === "target-entrypoint" || kind === "dlq-target") {
    return manifest.edges.filter((edge) => edge.kind === kind && (edge.from === componentId || edge.from.startsWith(`${componentId}-`))).length;
  }
  return edgesFrom(manifest, componentId, kind).length;
}

function database(config, binding) {
  return (config.d1_databases ?? []).find((entry) => entry.binding === binding);
}

export function validateConfig(manifest, component, config, mapping) {
  if (config.name !== component.workerName) fail("CARDINALITY", `${component.id}.workerName`, "cardinality");
  const names = bindingNames(config);
  if (new Set(names).size !== names.length) fail("GLOBAL_BINDING", `${component.id}.bindings`, "global-binding");
  const pipelineEdge = manifest.edges.find((edge) => edge.from === component.id && edge.binding === "D1");
  const mvEdge = manifest.edges.find((edge) => edge.from === component.id && edge.binding === "D1_MV");
  const pipeline = database(config, "D1");
  const mv = database(config, "D1_MV");
  if (pipeline === undefined || mv === undefined) fail("CARDINALITY", `${component.id}.d1`, "cardinality");
  const pipelineId = mapping.resources?.[pipelineEdge.to]?.database_id;
  const mvId = mapping.resources?.[mvEdge.to]?.database_id;
  if (typeof pipelineId !== "string" || typeof mvId !== "string") {
    fail("SCOPE_PROOF_UNAVAILABLE", `${component.id}.mapping`, "scope-proof-unavailable");
  }
  if (pipeline.database_id !== pipelineId || mv.database_id !== mvId) {
    fail("RESOURCE_MISMATCH", `${component.id}.d1`, "resource-identity-mismatch");
  }
  if (pipeline.migrations_dir !== manifest.migrationDomains["pipeline-D1"][0]) {
    fail("MIGRATION_SWAP", `${component.id}.pipeline-D1`, "migration-swap");
  }
  if (mv.migrations_dir !== manifest.migrationDomains["MV-D1"][0]) {
    fail("MIGRATION_SWAP", `${component.id}.MV-D1`, "migration-swap");
  }
  const tags = (config.migrations ?? []).map((entry) => entry.tag);
  const owned = manifest.migrationDomains["durable-object"][component.id];
  if (JSON.stringify(tags) !== JSON.stringify(owned.sequence)) {
    fail("MIGRATION_ORDER", `${component.id}.durable-object`, "migration-order");
  }
  const classes = (config.durable_objects?.bindings ?? []).map((entry) => entry.class_name).sort();
  if (JSON.stringify(classes) !== JSON.stringify([...manifest.durableObjectClasses].sort())) {
    fail("CARDINALITY", `${component.id}.durableObjectClasses`, "cardinality");
  }
  if ((config.durable_objects?.bindings ?? []).some((entry) => entry.script_name !== undefined)) {
    fail("SAME_RESOURCE", `${component.id}.script_name`, "same-resource");
  }
  const producers = config.queues?.producers ?? [];
  const consumers = config.queues?.consumers ?? [];
  const expected = manifest.cardinalities[component.id];
  if (component.id === "receiver") {
    if (config.queues !== undefined) fail("QUEUES_FORBIDDEN", "receiver.queues", "queues-forbidden");
    if ((config.services ?? []).length !== 0) fail("CARDINALITY", "receiver.service-binding", "cardinality");
  } else {
    if (producers.length !== expected["producer-binding"]) fail("CARDINALITY", "primary.producer-binding", "cardinality");
    if (consumers.length !== expected["consumer-attachment"]) fail("CARDINALITY", "primary.consumer-attachment", "cardinality");
    const work = mapping.resources["work-queue"].name;
    const dlq = mapping.resources["dlq-queue"].name;
    if (producers[0]?.queue !== work || consumers[0]?.queue !== work) {
      fail("RESOURCE_MISMATCH", "primary.queue", "resource-identity-mismatch");
    }
    if (consumers[0]?.dead_letter_queue !== dlq || dlq === work) fail("CARDINALITY", "primary.dlq-target", "cardinality");
    const service = config.services ?? [];
    const entrypoint = manifest.edges.find((edge) => edge.kind === "target-entrypoint" && edge.from.startsWith(`${component.id}-`));
    if (service.length !== 1 || entrypoint === undefined || service[0].entrypoint !== entrypoint.name) {
      fail("ENTRYPOINT_MISSING", `${component.id}.target-entrypoint`, "entrypoint-missing");
    }
    if (service[0].entrypoint === component.workerName) fail("ENTRYPOINT_MISSING", `${component.id}.target-entrypoint`, "entrypoint-missing");
    if (service[0].service !== mapping.resources["doorbell-service"].service) {
      fail("RESOURCE_MISMATCH", "primary.service-binding", "resource-identity-mismatch");
    }
  }
  const forbidden = component.entrypoints.flatMap((entrypoint) => entrypoint.forbiddenBindings);
  for (const binding of forbidden) {
    if (names.includes(binding)) fail("CARDINALITY", `${component.id}.${binding}`, "cardinality");
  }
}

export function validateProfile(manifest = loadManifest(), mapping = loadMapping(), configs) {
  validateManifest(manifest, mapping);
  const loaded = configs ?? Object.fromEntries(manifest.components.map((component) => [component.id, loadJson(component.config)]));
  for (const component of manifest.components) validateConfig(manifest, component, loaded[component.id], mapping);
  scanSampleBindingReads();
  checkGenerated(manifest);
  return manifestDigest(manifest);
}

export function overlapRows(componentId, config) {
  const pipeline = database(config, "D1");
  const mv = database(config, "D1_MV");
  const classes = (config.durable_objects?.bindings ?? []).map((entry) => entry.class_name).sort().join(",");
  const rows = [
    { rowId: `${componentId}.pipeline.database_id`, status: pipeline?.database_id ?? "missing" },
    { rowId: `${componentId}.mv.database_id`, status: mv?.database_id ?? "missing" },
    { rowId: `${componentId}.do.class-set`, status: classes },
  ];
  if (componentId === "primary") {
    rows.push(
      { rowId: "primary.queue.producer.0", status: config.queues?.producers?.[0]?.queue ?? "missing" },
      { rowId: "primary.queue.consumer.0", status: config.queues?.consumers?.[0]?.queue ?? "missing" },
      { rowId: "primary.queue.dlq.0", status: config.queues?.consumers?.[0]?.dead_letter_queue ?? "missing" },
    );
  } else {
    rows.push({ rowId: "receiver.queues.absent", status: config.queues === undefined ? "absent" : "present" });
  }
  return rows;
}

export function compareOverlap(legacyRows, newRows) {
  const count = (rows, rowId) => rows.filter((row) => row.rowId === rowId).length;
  const ids = new Set([...legacyRows, ...newRows].map((row) => row.rowId));
  for (const rowId of ids) {
    if (count(legacyRows, rowId) > 1 || count(newRows, rowId) > 1) {
      fail("DUPLICATE_ROW", rowId, "duplicate-row");
    }
  }
  for (const row of legacyRows) {
    const found = newRows.filter((candidate) => candidate.rowId === row.rowId);
    if (found.length === 0) fail("MISSING_ROW", row.rowId, "missing-row");
    if (row.status === "fail" && found[0].status === "pass") fail("LEGACY_FAIL_NEW_PASS", row.rowId, "legacy-fail-new-pass");
    if (row.status === "pass" && found[0].status === "fail") fail("NEW_FAIL_LEGACY_PASS", row.rowId, "new-fail-legacy-pass");
    if (row.status !== found[0].status) fail("NEW_FAIL_LEGACY_PASS", row.rowId, "new-fail-legacy-pass");
  }
  for (const row of newRows) {
    if (!legacyRows.some((candidate) => candidate.rowId === row.rowId)) fail("MISSING_ROW", row.rowId, "missing-row");
  }
  return { count: legacyRows.length, equal: true };
}

const KNOWN_INPUT_KEYS = new Set(["config", "environment", "cliOverrides", "keepVars"]);

export function resolveCompositionInput(invocation) {
  if (Object.prototype.hasOwnProperty.call(invocation, "deepMerge")) fail("DEEP_MERGE_FORBIDDEN", "deepMerge", "deep-merge-forbidden");
  const unknown = Object.keys(invocation).filter((key) => !KNOWN_INPUT_KEYS.has(key));
  if (unknown.length !== 0) fail("UNKNOWN_INPUT", unknown[0], "unknown-input");
  if (invocation.config === undefined || Array.isArray(invocation.config)) fail("UNKNOWN_INPUT", "config", "unknown-input");
  const config = invocation.config;
  const selected = invocation.environment === undefined ? config : config.env?.[invocation.environment];
  if (invocation.environment !== undefined && selected === undefined) fail("UNKNOWN_INPUT", "environment", "unknown-input");
  const vars = { ...(selected?.vars ?? {}) };
  if (invocation.environment !== undefined && config.vars !== undefined) {
    for (const key of Object.keys(config.vars)) {
      if (vars[key] === undefined && invocation.keepVars?.includes(key)) {
        fail("UNRESOLVED_KEPT_VAR", key, "unresolved-kept-var");
      }
    }
  }
  for (const [key, value] of Object.entries(invocation.cliOverrides ?? {})) vars[key] = value;
  for (const key of invocation.keepVars ?? []) {
    if (vars[key] === undefined) fail("UNRESOLVED_KEPT_VAR", key, "unresolved-kept-var");
  }
  return vars;
}

export function runSelfTest() {
  const manifest = loadManifest();
  const mapping = loadMapping();
  const envelope = validateProfile(manifest, mapping);
  const primary = loadJson(manifest.components[0].config);
  const receiver = loadJson(manifest.components[1].config);
  compareOverlap(overlapRows("primary", primary).concat(overlapRows("receiver", receiver)), overlapRows("primary", primary).concat(overlapRows("receiver", receiver)));
  const swapped = jcs({ b: 1, a: 2 });
  if (swapped !== jcs({ a: 2, b: 1 })) throw new Error("JCS key order drifted");
  if (manifestDigest(manifest).digest === manifestDigest(manifest, "sekiban-dcb-ts/g30-bundle/v1").digest) {
    throw new Error("cross-domain digest collided");
  }
  const reversed = structuredClone(manifest);
  reversed.migrationDomains["durable-object"].primary.sequence = ["v2", "v1"];
  if (manifestDigest(reversed).digest === envelope.digest) throw new Error("migration order did not move the digest");
  const mutations = [];
  const expect = (name, fn) => {
    try {
      fn();
      throw new Error(`${name} unexpectedly passed`);
    } catch (error) {
      if (!(error instanceof CompositionDiagnostic)) throw error;
      mutations.push(`${name}:${error.diagnostic.reason}`);
    }
  };
  expect("legacy-fail-new-pass", () => compareOverlap([{ rowId: "a", status: "fail" }], [{ rowId: "a", status: "pass" }]));
  expect("new-fail-legacy-pass", () => compareOverlap([{ rowId: "a", status: "pass" }], [{ rowId: "a", status: "fail" }]));
  expect("missing-row", () => compareOverlap([{ rowId: "a", status: "ok" }], []));
  expect("duplicate-row", () => compareOverlap([{ rowId: "a", status: "ok" }, { rowId: "a", status: "ok" }], [{ rowId: "a", status: "ok" }]));
  expect("second-producer", () => validateConfig(manifest, manifest.components[0], {
    ...primary,
    queues: { ...primary.queues, producers: [...primary.queues.producers, { binding: "EXTRA", queue: primary.queues.producers[0].queue }] },
  }, mapping));
  expect("receiver-queues", () => validateConfig(manifest, manifest.components[1], { ...receiver, queues: { consumers: [] } }, mapping));
  expect("second-shard", () => validateManifest({
    ...manifest,
    resources: [...manifest.resources, { id: "pipeline-d1-b", kind: "physical-resource", providerKind: "d1", role: "pipeline-D1", resourceRef: "rref-extra" }],
  }, mapping));
  expect("second-manifest", () => assertSingleSource([manifestPath, "contracts/provider-composition.copy.json"]));
  const committed = readFileSync(join(root, generatedPath), "utf8");
  const jsonOnly = structuredClone(manifest);
  jsonOnly.tenantRef = "tnrf-ffffffffffffffffffffffffffffffff";
  expect("json-only", () => checkGenerated(jsonOnly, committed));
  expect("generated-only", () => checkGenerated(manifest, `${committed}\n`));
  expect("accessor-only", () => checkGenerated(manifest, committed.replace(
    'return env["D1"] as NonNullable<E["D1"]>;',
    'return env["D1_MV"] as NonNullable<E["D1"]>;',
  )));
  const swappedDirs = structuredClone(primary);
  const pipelineDir = swappedDirs.d1_databases.find((entry) => entry.binding === "D1").migrations_dir;
  const mvDir = swappedDirs.d1_databases.find((entry) => entry.binding === "D1_MV").migrations_dir;
  swappedDirs.d1_databases.find((entry) => entry.binding === "D1").migrations_dir = mvDir;
  swappedDirs.d1_databases.find((entry) => entry.binding === "D1_MV").migrations_dir = pipelineDir;
  expect("migration-swap", () => validateConfig(manifest, manifest.components[0], swappedDirs, mapping));
  const reordered = structuredClone(primary);
  reordered.migrations = [...primary.migrations].reverse();
  expect("migration-order", () => validateConfig(manifest, manifest.components[0], reordered, mapping));
  const borrowed = structuredClone(manifest);
  borrowed.migrationDomains["durable-object"].primary.owner = "receiver";
  expect("do-owner", () => validateManifest(borrowed, mapping));
  const legacy = spawnSync(process.execPath, [join(root, "scripts/g32-cutover-check.mjs")], { encoding: "utf8" });
  if (legacy.status !== 0) throw new Error(legacy.stderr || legacy.stdout || "g32-cutover-check failed");
  expect("kept-var", () => resolveCompositionInput({
    config: { vars: { SDT_SERVICE_ID: "top" }, env: { staging: { vars: {} } } },
    environment: "staging",
    keepVars: ["SDT_SERVICE_ID"],
  }));
  expect("deep-merge", () => resolveCompositionInput({ config: { vars: {} }, deepMerge: true }));
  expect("no-tenant", () => validateManifest({ ...manifest, tenantRef: "" }, mapping));
  const rendered = JSON.stringify(envelope) + JSON.stringify(publishedPayload(manifest));
  if (rendered.includes(mapping.resources["pipeline-d1"].database_id) || rendered.includes("CANARY-SECRET-VALUE")) {
    throw new Error("published digest leaked a raw identity");
  }
  return { result: "g34-provider-composition-self-test-passed", digest: envelope.digest, mutations };
}

function main() {
  const write = process.argv.includes("--write");
  if (write || process.argv.includes("--check")) {
    const source = generateSource(loadManifest());
    if (write) writeFileSync(join(root, generatedPath), source);
    checkGenerated(loadManifest(), write ? source : undefined);
  }
  if (process.argv.includes("--self-test") || process.argv.includes("--check")) {
    console.log(JSON.stringify(runSelfTest()));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
