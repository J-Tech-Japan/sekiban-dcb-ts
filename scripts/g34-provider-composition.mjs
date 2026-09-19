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
export const PROFILE_CARDINALITIES = {
  primary: {
    "producer-binding": 1,
    "consumer-attachment": 1,
    "dlq-target": 1,
    "service-binding": 1,
    "target-entrypoint": 1,
  },
  receiver: {
    "producer-binding": 0,
    "consumer-attachment": 0,
    "dlq-target": 0,
    "service-binding": 0,
    "target-entrypoint": 0,
  },
};
const REQUIRED_RESOURCE_IDS = ["dlq-queue", "doorbell-service", "mv-d1", "pipeline-d1", "primary-do", "receiver-do", "work-queue"];
const REQUIRED_EDGES = [
  { id: "primary-consumer", kind: "consumer-attachment", from: "primary", to: "work-queue" },
  { id: "primary-dlq", kind: "dlq-target", from: "primary-consumer", to: "dlq-queue" },
  { id: "primary-doorbell", kind: "service-binding", from: "primary", to: "doorbell-service", binding: "DOWNSTREAM_DOORBELL" },
  { id: "primary-entrypoint", kind: "target-entrypoint", from: "primary-doorbell", name: "MeetingRoomDownstreamDoorbell" },
  { id: "primary-mv", kind: "physical-resource", from: "primary", to: "mv-d1", binding: "D1_MV" },
  { id: "primary-pipeline", kind: "physical-resource", from: "primary", to: "pipeline-d1", binding: "D1" },
  { id: "primary-producer", kind: "producer-binding", from: "primary", to: "work-queue", binding: "DOWNSTREAM_QUEUE" },
  { id: "receiver-mv", kind: "physical-resource", from: "receiver", to: "mv-d1", binding: "D1_MV" },
  { id: "receiver-pipeline", kind: "physical-resource", from: "receiver", to: "pipeline-d1", binding: "D1" },
];
const REQUIRED_EDGE_IDS = REQUIRED_EDGES.map((edge) => edge.id);
const MAPPED_RESOURCE_IDS = ["pipeline-d1", "mv-d1", "work-queue", "dlq-queue", "doorbell-service"];
const DO_MIGRATION_CLASSES = {
  v1: ["AllocatorDurableObject", "JournalDurableObject", "TagDurableObject"],
  v2: ["BootstrapCoordinatorDurableObject"],
};

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
  "missing-config",
  "digest-mismatch",
  "invocation-count",
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
    if (!Number.isFinite(value)) throw new Error("JCS number is not finite");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => jcs(item)).join(",")}]`;
  if (typeof value !== "object") throw new Error("JCS value is not a JSON type");
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${jcs(value[key])}`).join(",")}}`;
}

function mappedIdentity(id, entry) {
  if (entry == null || typeof entry !== "object") return undefined;
  if (id === "pipeline-d1" || id === "mv-d1") return entry.database_id;
  if (id === "work-queue" || id === "dlq-queue") return entry.name;
  if (id === "doorbell-service") return entry.service;
  return undefined;
}

export function digestBytes(payload, domain = DOMAIN) {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0")
    .update(jcs(payload), "utf8")
    .digest("hex");
}

function byId(left, right) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function canonicalComponent(component) {
  return {
    ...component,
    entrypoints: (component.entrypoints ?? []).map((entrypoint) => ({
      ...entrypoint,
      forbiddenBindings: [...(entrypoint.forbiddenBindings ?? [])].sort(),
      requiredBindings: [...(entrypoint.requiredBindings ?? [])].sort(),
    })),
  };
}

export function publishedPayload(manifest) {
  const resources = [...manifest.resources].sort(byId);
  const edges = [...manifest.edges].sort(byId);
  return {
    canonicalizationVersion: manifest.canonicalizationVersion,
    cardinalities: manifest.cardinalities,
    components: [...manifest.components].sort(byId).map(canonicalComponent),
    durableObjectClasses: [...manifest.durableObjectClasses].sort(),
    edges,
    migrationDomains: manifest.migrationDomains,
    profileId: manifest.profileId,
    resources,
    schemaVersion: manifest.schemaVersion,
    scopeAxes: [...manifest.scopeAxes].sort(),
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

export function rawBindingHits(text) {
  const names = BINDING_FUNCTIONS.map(([name]) => name).sort((left, right) => right.length - left.length);
  const alt = names.join("|");
  const patterns = [
    new RegExp(`\\benv\\s*\\?\\.\\s*(${alt})\\b`),
    new RegExp(`\\benv\\.(${alt})\\b`),
    new RegExp(`\\benv\\s*(?:\\?\\.)?\\s*\\[\\s*["'](${alt})["']\\s*\\]`),
    new RegExp(`\\{[\\s\\S]*?\\b(${alt})\\b[\\s\\S]*?\\}\\s*=\\s*env\\b`),
  ];
  return patterns.some((pattern) => pattern.test(text));
}

export function findRawBindingReads(files) {
  const hits = [];
  for (const file of files) {
    if (file.endsWith(generatedPath)) continue;
    if (rawBindingHits(readFileSync(join(root, file), "utf8"))) hits.push(file);
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

function publishedManifestFiles() {
  return readdirSync(join(root, "contracts"))
    .filter((name) => name.startsWith("provider-composition") && name.endsWith(".json") && !name.includes("local-mapping"))
    .map((name) => `contracts/${name}`)
    .sort();
}

export function assertSingleSource(files = publishedManifestFiles()) {
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

function requireMappingEntries(mapping) {
  if (mapping?.resources == null || typeof mapping.resources !== "object" || Array.isArray(mapping.resources)) {
    fail("SCOPE_PROOF_UNAVAILABLE", mappingPath, "scope-proof-unavailable");
  }
  for (const id of MAPPED_RESOURCE_IDS) {
    const identity = mappedIdentity(id, mapping.resources[id]);
    const ref = mapping.resources[id]?.resourceRef;
    if (typeof identity !== "string" || identity.length === 0 || typeof ref !== "string" || ref.length < 16) {
      fail("SCOPE_PROOF_UNAVAILABLE", `${mappingPath}#${id}`, "scope-proof-unavailable");
    }
  }
}

export function validateManifest(manifest, mapping) {
  requireMappingEntries(mapping);
  if (tenantRefOf(manifest).length < 16) fail("SCOPE_PROOF_UNAVAILABLE", "tenantRef", "scope-proof-unavailable");
  const workerNames = manifest.components.map((component) => component.workerName);
  if (workerNames.some((name) => typeof name !== "string" || name.length === 0) || new Set(workerNames).size !== workerNames.length) {
    fail("CARDINALITY", "workerName", "cardinality");
  }
  const declaredBindings = [...new Set(manifest.components.flatMap((component) => (
    component.entrypoints ?? []
  ).flatMap((entrypoint) => [...(entrypoint.requiredBindings ?? []), ...(entrypoint.forbiddenBindings ?? [])])))].sort();
  const generatedBindings = BINDING_FUNCTIONS.map(([name]) => name).sort();
  if (JSON.stringify(declaredBindings) !== JSON.stringify(generatedBindings)) {
    fail("CARDINALITY", "bindings", "cardinality");
  }
  const componentIds = (manifest.components ?? []).map((component) => component.id).sort();
  if (JSON.stringify(componentIds) !== JSON.stringify(["primary", "receiver"])) {
    fail("CARDINALITY", "components", "cardinality");
  }
  for (const id of ["primary", "receiver"]) {
    const declared = Object.keys(manifest.cardinalities?.[id] ?? {}).sort();
    const expectedKeys = Object.keys(PROFILE_CARDINALITIES[id]).sort();
    if (JSON.stringify(declared) !== JSON.stringify(expectedKeys)) {
      fail("CARDINALITY", `${id}.cardinalities`, "cardinality");
    }
  }
  const cardinalityOwners = Object.keys(manifest.cardinalities ?? {}).sort();
  if (JSON.stringify(cardinalityOwners) !== JSON.stringify(Object.keys(PROFILE_CARDINALITIES).sort())) {
    fail("CARDINALITY", "cardinalities", "cardinality");
  }
  const pipeline = manifest.resources.filter((resource) => resource.role === "pipeline-D1");
  if (pipeline.length !== 1) fail("SECOND_SHARD", "resources.pipeline-D1", "second-shard");
  const resourceIds = [...manifest.resources.map((resource) => resource.id)].sort();
  if (JSON.stringify(resourceIds) !== JSON.stringify([...REQUIRED_RESOURCE_IDS].sort())) {
    fail("CARDINALITY", "resources", "cardinality");
  }
  const mv = manifest.resources.filter((resource) => resource.role === "MV-D1");
  if (mv.length !== 1 || mv[0].resourceRef === pipeline[0].resourceRef) {
    fail("CARDINALITY", "resources.MV-D1", "cardinality");
  }
  for (const id of MAPPED_RESOURCE_IDS) {
    const resource = resourceById(manifest, id);
    const mappedRef = mapping.resources[id]?.resourceRef;
    if (resource === undefined || resource.resourceRef !== mappedRef) {
      fail("RESOURCE_MISMATCH", id, "resource-identity-mismatch");
    }
  }
  const edgeIds = manifest.edges.map((edge) => edge.id).sort();
  if (JSON.stringify(edgeIds) !== JSON.stringify([...REQUIRED_EDGE_IDS].sort())) {
    fail("CARDINALITY", "edges", "cardinality");
  }
  for (const required of REQUIRED_EDGES) {
    const found = manifest.edges.find((edge) => edge.id === required.id);
    for (const [key, value] of Object.entries(required)) {
      if (found?.[key] !== value) fail("CARDINALITY", `edges.${required.id}.${key}`, "cardinality");
    }
  }
  for (const component of manifest.components) {
    requireAxes(component);
    if (component.providerTenantScope?.tenantRef !== manifest.tenantRef) {
      fail("SCOPE_PROOF_UNAVAILABLE", `${component.id}.providerTenantScope`, "scope-proof-unavailable");
    }
    const owner = manifest.migrationDomains["durable-object"][component.id];
    if (owner?.owner !== component.id) fail("DO_MIGRATION_OWNER", `${component.id}.durable-object`, "do-migration-owner");
    const expectedCounts = PROFILE_CARDINALITIES[component.id];
    if (expectedCounts === undefined) fail("CARDINALITY", component.id, "cardinality");
    for (const [kind, expected] of Object.entries(expectedCounts)) {
      if (manifest.cardinalities?.[component.id]?.[kind] !== expected) {
        fail("CARDINALITY", `${component.id}.${kind}`, "cardinality");
      }
      if (componentEdgeCount(manifest, component.id, kind) !== expected) {
        fail("CARDINALITY", `${component.id}.${kind}`, "cardinality");
      }
    }
  }
  const primaryDo = resourceById(manifest, "primary-do");
  const receiverDo = resourceById(manifest, "receiver-do");
  if (primaryDo.owner !== "primary" || receiverDo.owner !== "receiver") {
    fail("DO_MIGRATION_OWNER", "durable-object.owner", "do-migration-owner");
  }
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
  requireMappingEntries(mapping);
  if (config.name !== component.workerName) fail("CARDINALITY", `${component.id}.workerName`, "cardinality");
  const names = bindingNames(config);
  if (new Set(names).size !== names.length) fail("GLOBAL_BINDING", `${component.id}.bindings`, "global-binding");
  const allowed = new Set(component.entrypoints.flatMap((entrypoint) => entrypoint.requiredBindings));
  for (const name of names) {
    if (!allowed.has(name)) fail("CARDINALITY", `${component.id}.${name}`, "cardinality");
  }
  for (const required of allowed) {
    if (!names.includes(required)) fail("CARDINALITY", `${component.id}.${required}`, "cardinality");
  }
  const pipelineEdge = manifest.edges.find((edge) => edge.from === component.id && edge.binding === "D1");
  const mvEdge = manifest.edges.find((edge) => edge.from === component.id && edge.binding === "D1_MV");
  const pipeline = database(config, "D1");
  const mv = database(config, "D1_MV");
  if (pipeline === undefined || mv === undefined) fail("CARDINALITY", `${component.id}.d1`, "cardinality");
  const pipelineId = mappedIdentity(pipelineEdge?.to, mapping.resources?.[pipelineEdge?.to]);
  const mvId = mappedIdentity(mvEdge?.to, mapping.resources?.[mvEdge?.to]);
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
  for (const entry of config.migrations ?? []) {
    const expectedClasses = [...(DO_MIGRATION_CLASSES[entry.tag] ?? [])].sort();
    const actualClasses = [...(entry.new_sqlite_classes ?? [])].sort();
    if (expectedClasses.length === 0 || JSON.stringify(actualClasses) !== JSON.stringify(expectedClasses)) {
      fail("DO_MIGRATION_OWNER", `${component.id}.${entry.tag}`, "do-migration-owner");
    }
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
  const expected = PROFILE_CARDINALITIES[component.id];
  if (component.id === "receiver") {
    if (config.queues !== undefined) fail("QUEUES_FORBIDDEN", "receiver.queues", "queues-forbidden");
    if ((config.services ?? []).length !== 0) fail("CARDINALITY", "receiver.service-binding", "cardinality");
  } else {
    if (producers.length !== expected["producer-binding"]) fail("CARDINALITY", "primary.producer-binding", "cardinality");
    if (consumers.length !== expected["consumer-attachment"]) fail("CARDINALITY", "primary.consumer-attachment", "cardinality");
    const producerEdge = manifest.edges.find((edge) => edge.kind === "producer-binding" && edge.from === component.id);
    const consumerEdge = manifest.edges.find((edge) => edge.kind === "consumer-attachment" && edge.from === component.id);
    const dlqEdge = manifest.edges.find((edge) => edge.kind === "dlq-target" && edge.from === `${component.id}-consumer`);
    const work = mappedIdentity(producerEdge?.to, mapping.resources?.[producerEdge?.to]);
    const consumerTarget = mappedIdentity(consumerEdge?.to, mapping.resources?.[consumerEdge?.to]);
    const dlq = mappedIdentity(dlqEdge?.to, mapping.resources?.[dlqEdge?.to]);
    if (typeof work !== "string" || typeof consumerTarget !== "string" || typeof dlq !== "string") {
      fail("SCOPE_PROOF_UNAVAILABLE", "primary.queue", "scope-proof-unavailable");
    }
    if (producerEdge.to !== "work-queue" || consumerEdge.to !== "work-queue" || dlqEdge.to !== "dlq-queue") {
      fail("CARDINALITY", "primary.queue", "cardinality");
    }
    if (producers[0]?.queue !== work || consumers[0]?.queue !== consumerTarget) {
      fail("RESOURCE_MISMATCH", "primary.queue", "resource-identity-mismatch");
    }
    if (consumers[0]?.dead_letter_queue !== dlq || dlq === work) fail("CARDINALITY", "primary.dlq-target", "cardinality");
    const service = config.services ?? [];
    const entrypoint = manifest.edges.find((edge) => edge.kind === "target-entrypoint" && edge.from.startsWith(`${component.id}-`));
    if (service.length !== 1 || entrypoint === undefined || service[0].entrypoint !== entrypoint.name) {
      fail("ENTRYPOINT_MISSING", `${component.id}.target-entrypoint`, "entrypoint-missing");
    }
    if (service[0].entrypoint === component.workerName) fail("ENTRYPOINT_MISSING", `${component.id}.target-entrypoint`, "entrypoint-missing");
    const doorbell = mappedIdentity("doorbell-service", mapping.resources?.["doorbell-service"]);
    if (typeof doorbell !== "string" || service[0].service !== doorbell) {
      fail("RESOURCE_MISMATCH", "primary.service-binding", "resource-identity-mismatch");
    }
  }
  const forbidden = component.entrypoints.flatMap((entrypoint) => entrypoint.forbiddenBindings);
  for (const binding of forbidden) {
    if (names.includes(binding)) fail("CARDINALITY", `${component.id}.${binding}`, "cardinality");
  }
}

export function validateProfile(manifest = loadManifest(), mapping = loadMapping(), configs) {
  assertSingleSource();
  validateManifest(manifest, mapping);
  const loaded = configs ?? Object.fromEntries(manifest.components.map((component) => [component.id, loadJson(component.config)]));
  for (const component of manifest.components) validateConfig(manifest, component, loaded[component.id], mapping);
  scanSampleBindingReads();
  checkGenerated(manifest);
  return manifestDigest(manifest);
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
  const resolved = invocation.environment === undefined ? { ...config } : { ...selected };
  const vars = { ...(resolved.vars ?? {}) };
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
  return { ...resolved, vars };
}

export function runSelfTest() {
  const manifest = loadManifest();
  const mapping = loadMapping();
  const envelope = validateProfile(manifest, mapping);
  const primary = loadJson(manifest.components[0].config);
  const receiver = loadJson(manifest.components[1].config);
  const swapped = jcs({ b: 1, a: 2 });
  if (swapped !== jcs({ a: 2, b: 1 })) throw new Error("JCS key order drifted");
  if (jcs(-0) !== "0" || jcs(1.5) !== "1.5" || jcs({ b: 1, a: -0 }) !== '{"a":0,"b":1}') {
    throw new Error("JCS number serialization drifted");
  }
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
  expect("missing-map", () => {
    const partial = structuredClone(mapping);
    delete partial.resources["doorbell-service"];
    validateManifest(manifest, partial);
  });
  expect("inflated-cardinality", () => validateManifest({
    ...manifest,
    cardinalities: {
      ...manifest.cardinalities,
      primary: { ...manifest.cardinalities.primary, "producer-binding": 2 },
    },
    edges: [...manifest.edges, { id: "primary-producer-2", kind: "producer-binding", from: "primary", to: "work-queue" }],
  }, mapping));
  const shifted = structuredClone(manifest);
  shifted.resources = shifted.resources.map((resource) => (
    resource.id === "pipeline-d1" ? { ...resource, resourceRef: "rref-00000000000000000000" } : resource
  ));
  if (manifestDigest(shifted).digest === envelope.digest) throw new Error("resource ref change did not move the digest");
  expect("identity-stale", () => validateManifest(manifest, {
    resources: {
      ...mapping.resources,
      "pipeline-d1": { ...mapping.resources["pipeline-d1"], resourceRef: "rref-00000000000000000000" },
    },
  }));
  expect("extra-cardinality-owner", () => validateManifest({
    ...manifest,
    cardinalities: { ...manifest.cardinalities, extra: { "producer-binding": 0 } },
  }, mapping));
  try {
    validateConfig(manifest, manifest.components[0], primary, {
      resources: {
        ...mapping.resources,
        "pipeline-d1": { ...mapping.resources["pipeline-d1"], database_id: "CANARY-SECRET-VALUE" },
      },
    });
    throw new Error("canary unexpectedly passed");
  } catch (error) {
    if (!(error instanceof CompositionDiagnostic)) throw error;
    const renderedDiagnostic = JSON.stringify(error.diagnostic);
    if (!renderedDiagnostic.includes("resource-identity-mismatch") || renderedDiagnostic.includes("CANARY-SECRET-VALUE")) {
      throw new Error("canary leaked or was not redacted");
    }
  }
  expect("dropped-component", () => validateManifest({
    ...manifest,
    components: manifest.components.filter((component) => component.id !== "receiver"),
  }, mapping));
  const reorderedSets = structuredClone(manifest);
  reorderedSets.components = [...manifest.components].reverse();
  reorderedSets.durableObjectClasses = [...manifest.durableObjectClasses].reverse();
  reorderedSets.scopeAxes = [...manifest.scopeAxes].reverse();
  if (manifestDigest(reorderedSets).digest !== envelope.digest) throw new Error("set order changed the digest");
  expect("retarget-producer", () => validateManifest({
    ...manifest,
    edges: manifest.edges.map((edge) => edge.id === "primary-producer" ? { ...edge, to: "dlq-queue" } : edge),
  }, mapping));
  expect("env-no-inherit", () => validateConfig(
    manifest,
    manifest.components[0],
    resolveCompositionInput({
      environment: "staging",
      config: {
        ...primary,
        vars: { SDT_SERVICE_ID: "top" },
        env: { staging: { name: primary.name, vars: {}, d1_databases: [] } },
      },
    }),
    mapping,
  ));
  expect("same-worker", () => validateManifest({
    ...manifest,
    components: manifest.components.map((component) => ({ ...component, workerName: "same-worker" })),
  }, mapping));
  expect("do-resource-owner", () => {
    const swapped = structuredClone(manifest);
    swapped.resources = swapped.resources.map((resource) => (
      resource.id === "primary-do" ? { ...resource, owner: "receiver" } : resource
    ));
    validateManifest(swapped, mapping);
  });
  expect("moved-do-class", () => {
    const moved = structuredClone(primary);
    moved.migrations = [
      { tag: "v1", new_sqlite_classes: ["AllocatorDurableObject", "JournalDurableObject"] },
      { tag: "v2", new_sqlite_classes: ["TagDurableObject", "BootstrapCoordinatorDurableObject"] },
    ];
    validateConfig(manifest, manifest.components[0], moved, mapping);
  });
  expect("unmapped-binding", () => validateManifest({
    ...manifest,
    components: manifest.components.map((component) => component.id === "primary" ? {
      ...component,
      entrypoints: component.entrypoints.map((entrypoint) => ({
        ...entrypoint,
        requiredBindings: [...entrypoint.requiredBindings, "EXTRA"],
      })),
    } : component),
  }, mapping));
  for (const sample of ['env.D1', 'env["D1"]', "env?.D1", "const { D1 } = env", "const { D1: alias } = env", "const {\n  D1\n} = env"]) {
    if (!rawBindingHits(sample)) throw new Error(`raw binding scan missed ${sample}`);
  }
  if (rawBindingHits("pipelineD1(env)")) throw new Error("raw binding scan flagged an accessor");
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
