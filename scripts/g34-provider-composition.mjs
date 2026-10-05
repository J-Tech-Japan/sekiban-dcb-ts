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
  worker: {
    "producer-binding": 1,
    "consumer-attachment": 1,
    "dlq-target": 1,
    "service-binding": 0,
    "embedded-entrypoint": 1,
    "physical-resource": 2,
    "durable-object-binding": 5,
  },
};

const REQUIRED_RESOURCE_IDS = ["pipeline-d1", "mv-d1", "work-queue", "dlq-queue", "allocator-do", "bootstrap-do", "journal-do", "tag-do", "tag-state-do"];
const REQUIRED_BINDINGS = ["ALLOCATOR", "BOOTSTRAP", "D1", "D1_MV", "DOWNSTREAM_QUEUE", "JOURNAL", "TAG", "TAG_STATE"];
const REQUIRED_MAPPING_KEYS = ["D1", "D1_MV", "DOWNSTREAM_QUEUE", "ALLOCATOR", "BOOTSTRAP", "JOURNAL", "TAG", "TAG_STATE"];
const REQUIRED_EDGE_IDS = ["worker-pipeline", "worker-mv", "worker-producer", "worker-consumer", "worker-dlq", "worker-allocator", "worker-bootstrap", "worker-journal", "worker-tag", "worker-tag-state", "worker-doorbell-entrypoint"];
const EXPECTED_MAPPING_VALUES = {
  D1: { database_id: "REPLACE_WITH_CLOUDFLARE_ONLY_PIPELINE_D1_ID", resourceRef: "rref-a17c4e90d2b68f53c04d" },
  D1_MV: { database_id: "REPLACE_WITH_CLOUDFLARE_ONLY_MV_D1_ID", resourceRef: "rref-b28d5f01e3c79a64d15e" },
  DOWNSTREAM_QUEUE: { queue: "sekiban-dcb-meeting-room-cloudflare-outbox", consumerQueue: "sekiban-dcb-meeting-room-cloudflare-outbox", dead_letter_queue: "sekiban-dcb-meeting-room-cloudflare-outbox-dlq", resourceRef: "rref-c39e6012f4d80b75e26f", deadLetterResourceRef: "rref-d40f7123a5e91c86f370" },
  ALLOCATOR: { class_name: "AllocatorDurableObject", resourceRef: "rref-7ba7fb7d22ca57236b6a" },
  BOOTSTRAP: { class_name: "BootstrapCoordinatorDurableObject", resourceRef: "rref-06bb3fabe0ff9fbf1aa5" },
  JOURNAL: { class_name: "JournalDurableObject", resourceRef: "rref-711e4471e1117bcbc3e9" },
  TAG: { class_name: "TagDurableObject", resourceRef: "rref-8a294ee6138da14e0e6c" },
  TAG_STATE: { class_name: "TagStateDurableObject", resourceRef: "rref-919c2ad04fb274ab43c0" },
};
const DO_MIGRATION_CLASSES = {
  v1: ["AllocatorDurableObject", "JournalDurableObject", "TagDurableObject"],
  v2: ["BootstrapCoordinatorDurableObject"],
  v3: ["TagStateDurableObject"],
};

const BINDING_FUNCTIONS = [
  ["ALLOCATOR", "allocatorBinding"],
  ["BOOTSTRAP", "bootstrapBinding"],
  ["D1", "pipelineD1"],
  ["D1_MV", "materializedViewD1"],
  ["DOWNSTREAM_QUEUE", "downstreamQueue"],
  ["JOURNAL", "journalBinding"],
  ["TAG", "tagBinding"],
  ["TAG_STATE", "tagStateBinding"],
];

const DIAGNOSTIC_REASONS = new Set([
  "cardinality", "credential-redacted", "deep-merge-forbidden", "do-migration-owner", "duplicate-row",
  "entrypoint-missing", "generated-drift", "global-binding", "migration-order", "migration-swap", "missing-row",
  "new-fail-legacy-pass", "queues-forbidden", "raw-binding", "resource-identity-mismatch", "same-resource",
  "scope-proof-unavailable", "second-manifest", "second-producer", "second-shard", "unknown-input",
  "unresolved-kept-var", "missing-config", "digest-mismatch", "invocation-count", "retarget-producer",
]);

export class CompositionDiagnostic extends Error {
  constructor(value) {
    super(value.code);
    this.name = "CompositionDiagnostic";
    this.diagnostic = Object.freeze(value);
  }
}

export function diagnostic(code, path, reason) {
  if (!DIAGNOSTIC_REASONS.has(reason)) throw new Error(`diagnostic reason is not in the finite schema: ${reason}`);
  return Object.freeze({ code, path, reason });
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
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (typeof value !== "object") throw new Error("JCS value is not a JSON type");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${jcs(value[key])}`).join(",")}}`;
}

export function digestBytes(payload, domain = DOMAIN) {
  return createHash("sha256").update(domain, "utf8").update("\0").update(jcs(payload), "utf8").digest("hex");
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
  return {
    canonicalizationVersion: manifest.canonicalizationVersion,
    cardinalities: manifest.cardinalities,
    components: [...manifest.components].sort(byId).map(canonicalComponent),
    durableObjectClasses: [...manifest.durableObjectClasses].sort(),
    edges: [...manifest.edges].sort(byId),
    migrationDomains: manifest.migrationDomains,
    profileId: manifest.profileId,
    resources: [...manifest.resources].sort(byId),
    schemaVersion: manifest.schemaVersion,
    scopeAxes: [...manifest.scopeAxes].sort(),
    tenantRef: manifest.tenantRef,
  };
}

export function manifestDigest(manifest, domain = DOMAIN) {
  return { algorithm: "sha256", domain, nulTerminated: true, canonicalizationVersion: CANONICALIZATION_VERSION, digest: digestBytes(publishedPayload(manifest), domain) };
}

export function loadJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

export function loadManifest() { return loadJson(manifestPath); }
export function loadMapping() { return loadJson(mappingPath); }

function resourceById(manifest, id) { return manifest.resources.find((resource) => resource.id === id); }
function edgeById(manifest, id) { return manifest.edges.find((edge) => edge.id === id); }

function bindingNames(config) {
  return [
    ...(config?.d1_databases ?? []).map((entry) => entry.binding),
    ...(config?.durable_objects?.bindings ?? []).map((entry) => entry.name),
    ...(config?.queues?.producers ?? []).map((entry) => entry.binding),
    ...(config?.services ?? []).map((entry) => entry.binding),
  ];
}

export function generateSource(manifest) {
  const descriptor = {
    profileId: manifest.profileId,
    components: manifest.components.map((component) => ({ id: component.id, entrypoints: component.entrypoints })),
    bindings: REQUIRED_BINDINGS,
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
  if (descriptor.profileId !== "meeting-room-cloudflare" || descriptor.components?.length !== 1 || JSON.stringify(descriptor.bindings) !== JSON.stringify(REQUIRED_BINDINGS)) {
    fail("GENERATED_DRIFT", generatedPath, "generated-drift");
  }
  return expected;
}

export function rawBindingHits(text) {
  const alt = REQUIRED_BINDINGS.slice().sort((left, right) => right.length - left.length).join("|");
  return [
    new RegExp(`\\benv\\s*\\?\\.\\s*(${alt})\\b`),
    new RegExp(`\\benv\\.(${alt})\\b`),
    new RegExp(`\\benv\\s*(?:\\?\\.)?\\s*\\[\\s*["'](${alt})["']\\s*\\]`),
    new RegExp(`\\{[\\s\\S]*?\\b(${alt})\\b[\\s\\S]*?\\}\\s*=\\s*env\\b`),
  ].some((pattern) => pattern.test(text));
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
  const hits = walkTs(join(root, "samples/meeting-room/src")).filter((file) => file !== generatedPath).filter((file) => rawBindingHits(readFileSync(join(root, file), "utf8")));
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
  if (files.length !== 1 || files[0] !== manifestPath) fail("SECOND_MANIFEST", files.find((file) => file !== manifestPath) ?? manifestPath, "second-manifest");
}

function requireMappingEntries(mapping) {
  const resources = mapping?.resources;
  if (resources === undefined || typeof resources !== "object" || Array.isArray(resources)) fail("SCOPE_PROOF_UNAVAILABLE", mappingPath, "scope-proof-unavailable");
  const keys = Object.keys(resources);
  if (JSON.stringify(keys) !== JSON.stringify(REQUIRED_MAPPING_KEYS)) fail("CARDINALITY", "resources", "cardinality");
  const expected = {
    D1: ["database_id", "resourceRef"], D1_MV: ["database_id", "resourceRef"], DOWNSTREAM_QUEUE: ["queue", "consumerQueue", "dead_letter_queue", "resourceRef", "deadLetterResourceRef"],
    ALLOCATOR: ["class_name", "resourceRef"], BOOTSTRAP: ["class_name", "resourceRef"], JOURNAL: ["class_name", "resourceRef"], TAG: ["class_name", "resourceRef"], TAG_STATE: ["class_name", "resourceRef"],
  };
  for (const key of REQUIRED_MAPPING_KEYS) {
    if (JSON.stringify(Object.keys(resources[key])) !== JSON.stringify(expected[key])) fail("CARDINALITY", `resources.${key}`, "cardinality");
    if (typeof resources[key].resourceRef !== "string" || resources[key].resourceRef.length < 16) fail("SCOPE_PROOF_UNAVAILABLE", `resources.${key}`, "scope-proof-unavailable");
    for (const [field, value] of Object.entries(EXPECTED_MAPPING_VALUES[key])) {
      if (resources[key][field] !== value) fail("RESOURCE_MISMATCH", `resources.${key}.${field}`, "resource-identity-mismatch");
    }
  }
}

function assertExact(actual, expected, code, path, reason) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(code, path, reason);
}

export function validateManifest(manifest, mapping) {
  requireMappingEntries(mapping);
  if (manifest.schemaVersion !== 1 || manifest.canonicalizationVersion !== CANONICALIZATION_VERSION || manifest.profileId !== "meeting-room-cloudflare") fail("CARDINALITY", "profileId", "cardinality");
  if (manifest.tenantRef !== "tnrf-c4e91a70b2d85f36a18e") fail("SCOPE_PROOF_UNAVAILABLE", "tenantRef", "scope-proof-unavailable");
  assertExact(manifest.scopeAxes, ["logicalServiceScope", "deploymentComponentScope", "providerTenantScope", "physicalResourceScope"], "CARDINALITY", "scopeAxes", "cardinality");
  assertExact(manifest.components.map((component) => component.id), ["worker"], "CARDINALITY", "components", "cardinality");
  const component = manifest.components[0];
  for (const key of ["workerName", "config", "deploymentComponentScope", "physicalResourceScope"]) if (component[key] !== ({ workerName: "sekiban-dcb-meeting-room-cloudflare-only", config: "samples/meeting-room/wrangler.cloudflare-only.jsonc", deploymentComponentScope: "worker", physicalResourceScope: "opaque-ref" }[key])) fail("CARDINALITY", `worker.${key}`, "cardinality");
  if (component.logicalServiceScope?.sharing !== "exclusive" || component.logicalServiceScope?.serviceIdSource !== "deploy-var" || component.providerTenantScope?.tenantRef !== manifest.tenantRef) fail("SCOPE_PROOF_UNAVAILABLE", "worker.scope", "scope-proof-unavailable");
  if (component.entrypoints?.some((entrypoint) => entrypoint.requiredBindings.includes("DOWNSTREAM_DOORBELL"))) fail("CARDINALITY", "worker.DOWNSTREAM_DOORBELL", "cardinality");
  assertExact(component.entrypoints, [
    { kind: "default", operation: "fetch", requiredBindings: REQUIRED_BINDINGS, forbiddenBindings: [] },
    { kind: "named", name: "MeetingRoomDownstreamDoorbell", operation: "deliver", requiredBindings: REQUIRED_BINDINGS, forbiddenBindings: [] },
  ], "CARDINALITY", "worker.entrypoints", "cardinality");
  assertExact([...new Set(component.entrypoints.flatMap((entrypoint) => [...entrypoint.requiredBindings, ...entrypoint.forbiddenBindings]))].sort(), [...REQUIRED_BINDINGS].sort(), "CARDINALITY", "bindings", "cardinality");
  const pipelineResources = manifest.resources.filter((resource) => resource.role === "pipeline-D1");
  if (pipelineResources.length !== 1) fail("SECOND_SHARD", "resources.pipeline-D1", "second-shard");
  assertExact(manifest.resources.map((resource) => resource.id), REQUIRED_RESOURCE_IDS, "CARDINALITY", "resources", "cardinality");
  const refs = { "pipeline-d1": "rref-a17c4e90d2b68f53c04d", "mv-d1": "rref-b28d5f01e3c79a64d15e", "work-queue": "rref-c39e6012f4d80b75e26f", "dlq-queue": "rref-d40f7123a5e91c86f370", "allocator-do": "rref-7ba7fb7d22ca57236b6a", "bootstrap-do": "rref-06bb3fabe0ff9fbf1aa5", "journal-do": "rref-711e4471e1117bcbc3e9", "tag-do": "rref-8a294ee6138da14e0e6c", "tag-state-do": "rref-919c2ad04fb274ab43c0" };
  for (const resource of manifest.resources) {
    if (resource.resourceRef !== refs[resource.id]) fail("RESOURCE_MISMATCH", resource.id, "resource-identity-mismatch");
    if (resource.providerKind === "durable-object" && (resource.owner !== "worker" || resource.scriptName !== null)) fail("DO_MIGRATION_OWNER", resource.id, "do-migration-owner");
  }
  assertExact(manifest.edges.map((edge) => edge.id), REQUIRED_EDGE_IDS, "CARDINALITY", "edges", "cardinality");
  const expectedEdges = [
    ["worker-pipeline", "physical-resource", "worker", "pipeline-d1", "D1"], ["worker-mv", "physical-resource", "worker", "mv-d1", "D1_MV"], ["worker-producer", "producer-binding", "worker", "work-queue", "DOWNSTREAM_QUEUE"], ["worker-consumer", "consumer-attachment", "worker", "work-queue"], ["worker-dlq", "dlq-target", "worker-consumer", "dlq-queue"], ["worker-allocator", "durable-object-binding", "worker", "allocator-do", "ALLOCATOR"], ["worker-bootstrap", "durable-object-binding", "worker", "bootstrap-do", "BOOTSTRAP"], ["worker-journal", "durable-object-binding", "worker", "journal-do", "JOURNAL"], ["worker-tag", "durable-object-binding", "worker", "tag-do", "TAG"], ["worker-tag-state", "durable-object-binding", "worker", "tag-state-do", "TAG_STATE"], ["worker-doorbell-entrypoint", "embedded-entrypoint", "worker", undefined, undefined],
  ];
  for (const [id, kind, from, to, binding] of expectedEdges) {
    const edge = edgeById(manifest, id);
    if (edge?.kind !== kind || edge.from !== from || (to !== undefined && edge.to !== to) || (binding !== undefined && edge.binding !== binding)) fail("CARDINALITY", `edges.${id}`, "cardinality");
  }
  const entryEdge = edgeById(manifest, "worker-doorbell-entrypoint");
  if (entryEdge.name !== "MeetingRoomDownstreamDoorbell" || entryEdge.operation !== "deliver") fail("ENTRYPOINT_MISSING", "worker.entrypoint", "entrypoint-missing");
  assertExact(Object.keys(manifest.cardinalities), ["worker"], "CARDINALITY", "cardinalities", "cardinality");
  assertExact(manifest.cardinalities.worker, PROFILE_CARDINALITIES.worker, "CARDINALITY", "worker.cardinality", "cardinality");
  for (const [kind, count] of Object.entries(PROFILE_CARDINALITIES.worker)) {
    const actual = kind === "physical-resource" ? manifest.edges.filter((edge) => edge.from === "worker" && edge.kind === "physical-resource").length : kind === "durable-object-binding" ? manifest.edges.filter((edge) => edge.from === "worker" && edge.kind === kind).length : kind === "dlq-target" ? manifest.edges.filter((edge) => edge.kind === kind).length : kind === "embedded-entrypoint" ? manifest.edges.filter((edge) => edge.kind === kind).length : manifest.edges.filter((edge) => edge.from === "worker" && edge.kind === kind).length;
    if (actual !== count) fail("CARDINALITY", `worker.${kind}`, "cardinality");
  }
  if (manifest.migrationDomains?.["durable-object"]?.worker?.owner !== "worker") fail("DO_MIGRATION_OWNER", "worker.durable-object", "do-migration-owner");
  assertExact(manifest.migrationDomains, { "pipeline-D1": ["../../migrations/d1/g32"], "MV-D1": ["../../migrations/mv"], "durable-object": { worker: { owner: "worker", sequence: ["v1", "v2", "v3"] } } }, "MIGRATION_ORDER", "migrationDomains", "migration-order");
  assertExact(manifest.durableObjectClasses, ["AllocatorDurableObject", "BootstrapCoordinatorDurableObject", "JournalDurableObject", "TagDurableObject", "TagStateDurableObject"], "CARDINALITY", "durableObjectClasses", "cardinality");
  for (const [binding, resourceId] of Object.entries({ D1: "pipeline-d1", D1_MV: "mv-d1", DOWNSTREAM_QUEUE: "work-queue", ALLOCATOR: "allocator-do", BOOTSTRAP: "bootstrap-do", JOURNAL: "journal-do", TAG: "tag-do", TAG_STATE: "tag-state-do" })) {
    if (mapping.resources[binding].resourceRef !== resourceById(manifest, resourceId).resourceRef) fail("RESOURCE_MISMATCH", binding, "resource-identity-mismatch");
  }
  if (mapping.resources.DOWNSTREAM_QUEUE.deadLetterResourceRef !== resourceById(manifest, "dlq-queue").resourceRef) fail("RESOURCE_MISMATCH", "DOWNSTREAM_QUEUE.deadLetterResourceRef", "resource-identity-mismatch");
  return manifestDigest(manifest);
}

function assertEntrypointSource(source, receiverSource) {
  if (!source.includes('export { MeetingRoomDownstreamDoorbell } from "./worker.g38-receiver";')) fail("ENTRYPOINT_MISSING", "samples/meeting-room/src/worker.cloudflare-only.ts#MeetingRoomDownstreamDoorbell", "entrypoint-missing");
  for (const match of receiverSource.matchAll(/export\s+default\s+([\s\S]*?);/g)) {
    if (/\bfetch\s*\(/.test(match[1])) fail("CARDINALITY", "samples/meeting-room/src/worker.g38-receiver.ts#default.fetch", "cardinality");
  }
}

export function validateConfig(manifest, component, config, mapping, source = readFileSync(join(root, "samples/meeting-room/src/worker.cloudflare-only.ts"), "utf8"), receiverSource = readFileSync(join(root, "samples/meeting-room/src/worker.g38-receiver.ts"), "utf8")) {
  requireMappingEntries(mapping);
  if (config.name !== component.workerName) fail("CARDINALITY", `${component.id}.workerName`, "cardinality");
  if (config.main !== "src/worker.cloudflare-only.ts") fail("CARDINALITY", `${component.id}.main`, "cardinality");
  if (config.exports !== undefined) fail("CARDINALITY", `${component.id}.exports`, "cardinality");
  const names = bindingNames(config);
  assertExact([...new Set(names)].sort(), [...REQUIRED_BINDINGS].sort(), "CARDINALITY", `${component.id}.bindings`, "cardinality");
  const d1 = config.d1_databases ?? [];
  if (d1.find((entry) => entry.binding === "D1")?.database_id !== mapping.resources.D1.database_id || d1.find((entry) => entry.binding === "D1_MV")?.database_id !== mapping.resources.D1_MV.database_id) fail("RESOURCE_MISMATCH", `${component.id}.d1`, "resource-identity-mismatch");
  if (d1.find((entry) => entry.binding === "D1")?.migrations_dir !== manifest.migrationDomains["pipeline-D1"][0] || d1.find((entry) => entry.binding === "D1_MV")?.migrations_dir !== manifest.migrationDomains["MV-D1"][0]) fail("MIGRATION_SWAP", `${component.id}.pipeline-D1`, "migration-swap");
  assertExact((config.migrations ?? []).map((entry) => entry.tag), ["v1", "v2", "v3"], "MIGRATION_ORDER", `${component.id}.durable-object`, "migration-order");
  for (const entry of config.migrations ?? []) assertExact([...entry.new_sqlite_classes].sort(), [...DO_MIGRATION_CLASSES[entry.tag]].sort(), "DO_MIGRATION_OWNER", `${component.id}.${entry.tag}`, "do-migration-owner");
  assertExact((config.durable_objects?.bindings ?? []).map((entry) => entry.class_name).sort(), [...manifest.durableObjectClasses].sort(), "CARDINALITY", `${component.id}.durableObjectClasses`, "cardinality");
  for (const binding of ["ALLOCATOR", "BOOTSTRAP", "JOURNAL", "TAG", "TAG_STATE"]) {
    const actual = (config.durable_objects?.bindings ?? []).find((entry) => entry.name === binding);
    if (actual?.class_name !== mapping.resources[binding].class_name) fail("RESOURCE_MISMATCH", `${component.id}.${binding}.class_name`, "resource-identity-mismatch");
  }
  if ((config.services ?? []).length !== 0) fail("CARDINALITY", `${component.id}.DOWNSTREAM_DOORBELL`, "cardinality");
  const producer = config.queues?.producers ?? [];
  const consumer = config.queues?.consumers ?? [];
  if (producer.length !== 1) fail("CARDINALITY", `${component.id}.producer-binding`, "cardinality");
  if (consumer.length !== 1) fail("CARDINALITY", "queues.consumers", "cardinality");
  if (producer[0].binding !== "DOWNSTREAM_QUEUE" || producer[0].queue !== mapping.resources.DOWNSTREAM_QUEUE.queue) fail("RESOURCE_MISMATCH", `${component.id}.producer`, "resource-identity-mismatch");
  if (consumer[0].queue !== mapping.resources.DOWNSTREAM_QUEUE.consumerQueue || consumer[0].dead_letter_queue !== mapping.resources.DOWNSTREAM_QUEUE.dead_letter_queue) fail("CARDINALITY", `${component.id}.dlq-target`, "cardinality");
  assertEntrypointSource(source, receiverSource);
  return config;
}

export function validateQueueTopology(consumers) {
  if (JSON.stringify(consumers) === JSON.stringify([{ script: "sekiban-dcb-meeting-room-cloudflare-only" }])) return consumers;
  if (consumers.length !== 1) fail("CARDINALITY", "queues.consumers", "cardinality");
  if (consumers[0]?.script === "synthetic-receiver") fail("QUEUES_FORBIDDEN", "queues.consumers[0].script", "queues-forbidden");
  fail("CARDINALITY", "queues.consumers", "cardinality");
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
  const selected = invocation.environment === undefined ? invocation.config : invocation.config.env?.[invocation.environment];
  if (invocation.environment !== undefined && selected === undefined) fail("UNKNOWN_INPUT", "environment", "unknown-input");
  const resolved = invocation.environment === undefined ? { ...invocation.config } : { ...selected };
  const vars = { ...(resolved.vars ?? {}) };
  for (const key of invocation.keepVars ?? []) if (vars[key] === undefined) fail("UNRESOLVED_KEPT_VAR", key, "unresolved-kept-var");
  for (const [key, value] of Object.entries(invocation.cliOverrides ?? {})) vars[key] = value;
  return { ...resolved, vars };
}

function expectMutation(mutations, name, fn, expected) {
  try { fn(); throw new Error(`${name} unexpectedly passed`); } catch (error) {
    if (!(error instanceof CompositionDiagnostic)) throw error;
    if (JSON.stringify(error.diagnostic) !== JSON.stringify(expected)) throw new Error(`${name} diagnostic drifted: ${JSON.stringify(error.diagnostic)}`);
    mutations.push(`${name}:${error.diagnostic.reason}`);
  }
}

export function runSelfTest() {
  const manifest = loadManifest();
  const mapping = loadMapping();
  const envelope = validateProfile(manifest, mapping);
  const worker = loadJson(manifest.components[0].config);
  const source = readFileSync(join(root, "samples/meeting-room/src/worker.cloudflare-only.ts"), "utf8");
  const receiverSource = readFileSync(join(root, "samples/meeting-room/src/worker.g38-receiver.ts"), "utf8");
  if (jcs({ b: 1, a: 2 }) !== jcs({ a: 2, b: 1 }) || jcs(-0) !== "0" || jcs(1.5) !== "1.5" || jcs({ b: 1, a: -0 }) !== '{"a":0,"b":1}') throw new Error("JCS serialization drifted");
  if (manifestDigest(manifest).digest === manifestDigest(manifest, "sekiban-dcb-ts/g30-bundle/v1").digest) throw new Error("cross-domain digest collided");
  const reversed = structuredClone(manifest); reversed.migrationDomains["durable-object"].worker.sequence = ["v2", "v1", "v3"];
  if (manifestDigest(reversed).digest === envelope.digest) throw new Error("migration order did not move the digest");
  const shifted = structuredClone(manifest); shifted.resources = shifted.resources.map((resource) => resource.id === "pipeline-d1" ? { ...resource, resourceRef: "rref-00000000000000000000" } : resource);
  if (manifestDigest(shifted).digest === envelope.digest) throw new Error("resource ref change did not move the digest");
  const reorderedSets = structuredClone(manifest);
  reorderedSets.components = [...manifest.components].reverse();
  reorderedSets.durableObjectClasses = [...manifest.durableObjectClasses].reverse();
  reorderedSets.scopeAxes = [...manifest.scopeAxes].reverse();
  if (manifestDigest(reorderedSets).digest !== envelope.digest) throw new Error("set order changed the digest");
  const mutations = [];
  const expect = (name, fn, code, path, reason) => expectMutation(mutations, name, fn, { code, path, reason });
  const expectUnlabelled = (fn, expected) => {
    try {
      fn();
      throw new Error("expected diagnostic did not occur");
    } catch (error) {
      if (!(error instanceof CompositionDiagnostic) || JSON.stringify(error.diagnostic) !== JSON.stringify(expected)) throw error;
    }
  };
  expect("second-producer", () => validateConfig(manifest, manifest.components[0], { ...worker, queues: { ...worker.queues, producers: [...worker.queues.producers, { binding: "EXTRA", queue: "extra" }] } }, mapping), "CARDINALITY", "worker.bindings", "cardinality");
  expect("second-shard", () => validateManifest({ ...manifest, resources: [...manifest.resources, { ...manifest.resources[0], id: "pipeline-d1-b" }] }, mapping), "SECOND_SHARD", "resources.pipeline-D1", "second-shard");
  expect("second-manifest", () => assertSingleSource([manifestPath, "contracts/provider-composition.copy.json"]), "SECOND_MANIFEST", "contracts/provider-composition.copy.json", "second-manifest");
  const committed = readFileSync(join(root, generatedPath), "utf8");
  expect("json-only", () => checkGenerated({ ...manifest, tenantRef: "tnrf-ffffffffffffffffffffffffffffffff" }, committed), "GENERATED_DRIFT", generatedPath, "generated-drift");
  expect("generated-only", () => checkGenerated(manifest, `${committed}\n`), "GENERATED_DRIFT", generatedPath, "generated-drift");
  expect("accessor-only", () => checkGenerated(manifest, committed.replace('return env["D1"] as NonNullable<E["D1"]>;', 'return env["D1_MV"] as NonNullable<E["D1_MV"]>;')), "GENERATED_DRIFT", generatedPath, "generated-drift");
  const swapped = structuredClone(worker); [swapped.d1_databases[0].migrations_dir, swapped.d1_databases[1].migrations_dir] = [swapped.d1_databases[1].migrations_dir, swapped.d1_databases[0].migrations_dir];
  expect("migration-swap", () => validateConfig(manifest, manifest.components[0], swapped, mapping), "MIGRATION_SWAP", "worker.pipeline-D1", "migration-swap");
  expect("migration-order", () => validateConfig(manifest, manifest.components[0], { ...worker, migrations: [...worker.migrations].reverse() }, mapping), "MIGRATION_ORDER", "worker.durable-object", "migration-order");
  const owner = structuredClone(manifest); owner.migrationDomains["durable-object"].worker.owner = "other";
  expect("do-owner", () => validateManifest(owner, mapping), "DO_MIGRATION_OWNER", "worker.durable-object", "do-migration-owner");
  expect("kept-var", () => resolveCompositionInput({ config: { vars: { SDT_SERVICE_ID: "top" }, env: { staging: { vars: {} } } }, environment: "staging", keepVars: ["SDT_SERVICE_ID"] }), "UNRESOLVED_KEPT_VAR", "SDT_SERVICE_ID", "unresolved-kept-var");
  expect("deep-merge", () => resolveCompositionInput({ config: { vars: {} }, deepMerge: true }), "DEEP_MERGE_FORBIDDEN", "deepMerge", "deep-merge-forbidden");
  expect("no-tenant", () => validateManifest({ ...manifest, tenantRef: "" }, mapping), "SCOPE_PROOF_UNAVAILABLE", "tenantRef", "scope-proof-unavailable");
  expect("missing-map", () => { const partial = structuredClone(mapping); delete partial.resources.TAG_STATE; validateManifest(manifest, partial); }, "CARDINALITY", "resources", "cardinality");
  expectUnlabelled(() => { const drifted = structuredClone(mapping); drifted.resources.D1.database_id = "REPLACE_WITH_DRIFTED_PIPELINE_D1_ID"; validateManifest(manifest, drifted); }, { code: "RESOURCE_MISMATCH", path: "resources.D1.database_id", reason: "resource-identity-mismatch" });
  expectUnlabelled(() => { const drifted = structuredClone(mapping); drifted.resources.ALLOCATOR.class_name = "DriftedAllocatorDurableObject"; validateManifest(manifest, drifted); }, { code: "RESOURCE_MISMATCH", path: "resources.ALLOCATOR.class_name", reason: "resource-identity-mismatch" });
  expect("inflated-cardinality", () => validateManifest({ ...manifest, cardinalities: { ...manifest.cardinalities, worker: { ...manifest.cardinalities.worker, "producer-binding": 2 } } }, mapping), "CARDINALITY", "worker.cardinality", "cardinality");
  expect("identity-stale", () => { const stale = structuredClone(mapping); stale.resources.D1.resourceRef = "rref-00000000000000000000"; validateManifest(manifest, stale); }, "RESOURCE_MISMATCH", "resources.D1.resourceRef", "resource-identity-mismatch");
  expect("extra-cardinality-owner", () => validateManifest({ ...manifest, cardinalities: { ...manifest.cardinalities, extra: {} } }, mapping), "CARDINALITY", "cardinalities", "cardinality");
  const retargeted = structuredClone(manifest); retargeted.edges[2].to = "dlq-queue";
  expect("retarget-producer", () => validateManifest(retargeted, mapping), "CARDINALITY", "edges.worker-producer", "cardinality");
  expect("env-no-inherit", () => validateConfig(manifest, manifest.components[0], resolveCompositionInput({ environment: "staging", config: { ...worker, vars: { SDT_SERVICE_ID: "top" }, env: { staging: { name: worker.name, main: worker.main, vars: {}, d1_databases: [] } } } }), mapping), "CARDINALITY", "worker.bindings", "cardinality");
  const doOwner = structuredClone(manifest); doOwner.resources[4].owner = "other";
  expect("do-resource-owner", () => validateManifest(doOwner, mapping), "DO_MIGRATION_OWNER", "allocator-do", "do-migration-owner");
  const moved = structuredClone(worker); moved.migrations[0].new_sqlite_classes = ["AllocatorDurableObject"]; expect("moved-do-class", () => validateConfig(manifest, manifest.components[0], moved, mapping), "DO_MIGRATION_OWNER", "worker.v1", "do-migration-owner");
  const extraBinding = structuredClone(manifest); extraBinding.components[0].entrypoints[0].requiredBindings.push("EXTRA"); expect("unmapped-binding", () => validateManifest(extraBinding, mapping), "CARDINALITY", "worker.entrypoints", "cardinality");
  const split = structuredClone(manifest); split.components.push(structuredClone(split.components[0])); expect("forbidden-split", () => validateManifest(split, mapping), "CARDINALITY", "components", "cardinality");
  const serviceSplit = structuredClone(manifest); serviceSplit.components[0].entrypoints[0].requiredBindings = [...REQUIRED_BINDINGS, "DOWNSTREAM_DOORBELL"]; expect("forbidden-split-service-binding", () => validateManifest(serviceSplit, mapping), "CARDINALITY", "worker.DOWNSTREAM_DOORBELL", "cardinality");
  for (const [field, value, path] of [["main", "src/worker.g38-tombstone.ts", "worker.main"], ["name", "sekiban-dcb-meeting-room-doorbell", "worker.workerName"], ["exports", { MeetingRoomDownstreamDoorbell: "worker.g38-tombstone.ts" }, "worker.exports"]]) {
    const tombstone = { ...worker, [field]: value }; expect("forbidden-tombstone", () => validateConfig(manifest, manifest.components[0], tombstone, mapping), "CARDINALITY", path, "cardinality");
  }
  expect("embedded-entrypoint-missing", () => validateConfig(manifest, manifest.components[0], worker, mapping, source.replace('export { MeetingRoomDownstreamDoorbell } from "./worker.g38-receiver";\n', ""), receiverSource), "ENTRYPOINT_MISSING", "samples/meeting-room/src/worker.cloudflare-only.ts#MeetingRoomDownstreamDoorbell", "entrypoint-missing");
  expect("embedded-default-fetch", () => validateConfig(manifest, manifest.components[0], worker, mapping, source, `${receiverSource}\nexport default { fetch() {} };`), "CARDINALITY", "samples/meeting-room/src/worker.g38-receiver.ts#default.fetch", "cardinality");
  validateQueueTopology([{ script: "sekiban-dcb-meeting-room-cloudflare-only" }]);
  expect("receiver-consumer", () => validateQueueTopology([{ script: "synthetic-receiver" }]), "QUEUES_FORBIDDEN", "queues.consumers[0].script", "queues-forbidden");
  expect("extra-consumer", () => validateQueueTopology([{ script: "sekiban-dcb-meeting-room-cloudflare-only" }, { script: "unrelated-worker" }]), "CARDINALITY", "queues.consumers", "cardinality");
  for (const sample of ['env.D1', 'env["D1"]', "env?.D1", "const { D1 } = env", "const { D1: alias } = env", "const {\n  D1\n} = env"]) if (!rawBindingHits(sample)) throw new Error(`raw binding scan missed ${sample}`);
  if (rawBindingHits("pipelineD1(env)")) throw new Error("raw binding scan flagged an accessor");
  try {
    const canary = structuredClone(mapping);
    canary.resources.D1.database_id = "CANARY-SECRET-VALUE";
    validateConfig(manifest, manifest.components[0], worker, canary);
    throw new Error("canary unexpectedly passed");
  } catch (error) {
    if (!(error instanceof CompositionDiagnostic)) throw error;
    const renderedDiagnostic = JSON.stringify(error.diagnostic);
    if (!renderedDiagnostic.includes("resource-identity-mismatch") || renderedDiagnostic.includes("CANARY-SECRET-VALUE")) throw new Error("canary leaked or was not redacted");
  }
  const rendered = JSON.stringify(envelope) + JSON.stringify(publishedPayload(manifest)); if (rendered.includes(mapping.resources.D1.database_id) || rendered.includes("CANARY-SECRET-VALUE")) throw new Error("published digest leaked a raw identity");
  return { result: "g34-provider-composition-self-test-passed", digest: envelope.digest, mutations };
}

function main() {
  const write = process.argv.includes("--write");
  if (write) writeFileSync(join(root, generatedPath), generateSource(loadManifest()));
  if (process.argv.includes("--self-test") || process.argv.includes("--check")) process.stdout.write(`${JSON.stringify(runSelfTest())}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
