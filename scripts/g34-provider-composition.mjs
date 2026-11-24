import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertClosedObject,
  assertUniqueBy,
  canonicalJson,
  compareExactOrdered,
  compareExactSet,
  domainSeparatedSha256,
  parseJsonc,
} from "./lib/offline-provider-validation.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const manifestPath = "contracts/provider-composition.json";
export const mappingPath = "contracts/provider-composition.local-mapping.json";
export const generatedPath = "samples/meeting-room/src/generated/provider-composition.ts";
export const sharedCorePath = "scripts/lib/offline-provider-validation.mjs";
export const templateCorePath = "packages/create-dcb/template/scripts/offline-provider-validation.mjs";
export const postgresManifestPath = "contracts/provider-composition.meeting-room-postgres.json";
export const postgresMappingPath = "contracts/provider-composition.meeting-room-postgres.local-mapping.json";
export const PROFILE_REGISTRY = Object.freeze([
  Object.freeze({ profileId: "meeting-room-cloudflare", manifestPath, mappingPath }),
  Object.freeze({ profileId: "meeting-room-postgres", manifestPath: postgresManifestPath, mappingPath: postgresMappingPath }),
]);
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
  "named-environment-forbidden", "local-connection-string", "forbidden-binding",
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
  return canonicalJson(value, "jcs");
}

export function digestBytes(payload, domain = DOMAIN) {
  return domainSeparatedSha256(payload, domain);
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
  return parseJsonc(readFileSync(join(root, path), "utf8"), path, (value) => {
    fail("CARDINALITY", value.path, "cardinality");
  });
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
    ...(config?.hyperdrive ?? []).map((entry) => entry.binding),
  ];
}

function copyCore() {
  writeFileSync(join(root, templateCorePath), readFileSync(join(root, sharedCorePath)));
}

export function checkTemplateCore(
  source = readFileSync(join(root, sharedCorePath)),
  copy = readFileSync(join(root, templateCorePath)),
) {
  if (!Buffer.from(source).equals(Buffer.from(copy))) fail("GENERATED_DRIFT", templateCorePath, "generated-drift");
  return true;
}

function assertManifestIdentities(manifest) {
  assertUniqueBy(manifest.resources, (resource) => resource?.id, "resources", (value) =>
    fail("CARDINALITY", value.path, "cardinality"));
  assertUniqueBy(manifest.edges, (edge) => edge?.id, "edges", (value) =>
    fail("CARDINALITY", value.path, "cardinality"));
}

function assertConfigIdentities(config) {
  for (const [entries, identity, path] of [
    [config?.d1_databases ?? [], (entry) => entry?.binding, "d1_databases.binding"],
    [config?.d1_databases ?? [], (entry) => entry?.database_name, "d1_databases.database_name"],
    [config?.queues?.producers ?? [], (entry) => entry?.binding, "queues.producers.binding"],
    [config?.queues?.producers ?? [], (entry) => entry?.queue, "queues.producers.queue"],
    [config?.queues?.consumers ?? [], (entry) => entry?.queue, "queues.consumers.queue"],
    [config?.durable_objects?.bindings ?? [], (entry) => entry?.name, "durable_objects.bindings.name"],
    [config?.durable_objects?.bindings ?? [], (entry) => entry?.class_name, "durable_objects.bindings.class_name"],
    [config?.hyperdrive ?? [], (entry) => entry?.binding, "hyperdrive.binding"],
    [config?.migrations ?? [], (entry) => entry?.tag, "migrations.tag"],
  ]) assertUniqueBy(entries, identity, path, (value) => fail("CARDINALITY", value.path, "cardinality"));
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

export function rawBindingHits(text, bindings = REQUIRED_BINDINGS) {
  const alt = bindings.slice().sort((left, right) => right.length - left.length).join("|");
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

function compositionContractFiles() {
  return readdirSync(join(root, "contracts"))
    .filter((name) => name.startsWith("provider-composition") && name.endsWith(".json"))
    .map((name) => `contracts/${name}`)
    .sort();
}

// The listing only refuses files; the closed registry alone selects what is validated.
export function assertRegistry(files = compositionContractFiles(), registry = PROFILE_REGISTRY) {
  assertUniqueBy(registry, (entry) => entry?.profileId, "registry.profileId", (value) => fail("CARDINALITY", value.path, "cardinality"));
  const registered = new Set(registry.flatMap((entry) => [entry.manifestPath, entry.mappingPath]));
  const rogue = [...files].sort().find((file) => !registered.has(file));
  if (rogue !== undefined) fail("SECOND_MANIFEST", rogue, "second-manifest");
  const listed = new Set(files);
  for (const entry of registry) {
    for (const path of [entry.manifestPath, entry.mappingPath]) {
      if (!listed.has(path) || !existsSync(join(root, path))) fail("MISSING_CONFIG", path, "missing-config");
    }
  }
}

export function assertRegisteredProfile(entry, manifest) {
  if (manifest?.profileId !== entry.profileId) fail("CARDINALITY", "profileId", "cardinality");
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
  compareExactOrdered(actual, expected, path, (value) => fail(code, value.path, reason), reason);
}

export function validateManifest(manifest, mapping) {
  assertManifestIdentities(manifest);
  requireMappingEntries(mapping);
  if (manifest.schemaVersion !== 1 || manifest.canonicalizationVersion !== CANONICALIZATION_VERSION || manifest.profileId !== "meeting-room-cloudflare") fail("CARDINALITY", "profileId", "cardinality");
  if (manifest.tenantRef !== "tnrf-c4e91a70b2d85f36a18e") fail("SCOPE_PROOF_UNAVAILABLE", "tenantRef", "scope-proof-unavailable");
  compareExactOrdered(
    manifest.scopeAxes,
    ["logicalServiceScope", "deploymentComponentScope", "providerTenantScope", "physicalResourceScope"],
    "scopeAxes",
    (value) => fail("CARDINALITY", value.path, "cardinality"),
    "cardinality",
  );
  assertExact(manifest.components.map((component) => component.id), ["worker"], "CARDINALITY", "components", "cardinality");
  const component = manifest.components[0];
  for (const key of ["workerName", "config", "deploymentComponentScope", "physicalResourceScope"]) if (component[key] !== ({ workerName: "sekiban-dcb-meeting-room-cloudflare-only", config: "samples/meeting-room/wrangler.cloudflare-only.jsonc", deploymentComponentScope: "worker", physicalResourceScope: "opaque-ref" }[key])) fail("CARDINALITY", `worker.${key}`, "cardinality");
  if (component.logicalServiceScope?.sharing !== "exclusive" || component.logicalServiceScope?.serviceIdSource !== "deploy-var" || component.providerTenantScope?.tenantRef !== manifest.tenantRef) fail("SCOPE_PROOF_UNAVAILABLE", "worker.scope", "scope-proof-unavailable");
  if (component.entrypoints?.some((entrypoint) => entrypoint.requiredBindings.includes("DOWNSTREAM_DOORBELL"))) fail("CARDINALITY", "worker.DOWNSTREAM_DOORBELL", "cardinality");
  assertExact(component.entrypoints, [
    { kind: "default", operation: "fetch", requiredBindings: REQUIRED_BINDINGS, forbiddenBindings: [] },
    { kind: "named", name: "MeetingRoomDownstreamDoorbell", operation: "deliver", requiredBindings: REQUIRED_BINDINGS, forbiddenBindings: [] },
  ], "CARDINALITY", "worker.entrypoints", "cardinality");
  compareExactSet(
    component.entrypoints.flatMap((entrypoint) => [...entrypoint.requiredBindings, ...entrypoint.forbiddenBindings]),
    REQUIRED_BINDINGS,
    "bindings",
    (value) => fail("CARDINALITY", value.path, "cardinality"),
    "cardinality",
  );
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
    const exported = match[1].trim();
    const declared = /^[A-Za-z_$][\w$]*$/.test(exported)
      ? receiverSource.match(new RegExp(`\\b(?:const|let|var)\\s+${exported}\\b[^=]*=\\s*([\\s\\S]*?);`))?.[1] ?? ""
      : "";
    if (/\bfetch\s*[(:,}]/.test(`${exported}\n${declared}`)) fail("CARDINALITY", "samples/meeting-room/src/worker.g38-receiver.ts#default.fetch", "cardinality");
  }
}

export function validateConfig(manifest, component, config, mapping, source = readFileSync(join(root, "samples/meeting-room/src/worker.cloudflare-only.ts"), "utf8"), receiverSource = readFileSync(join(root, "samples/meeting-room/src/worker.g38-receiver.ts"), "utf8")) {
  // The binding comparison de-duplicates names, so a Hyperdrive row named D1 would hide behind it.
  if (config?.hyperdrive !== undefined && !(Array.isArray(config.hyperdrive) && config.hyperdrive.length === 0)) fail("CARDINALITY", `${component.id}.bindings`, "cardinality");
  assertConfigIdentities(config);
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

export function validateProfile(manifest, mapping, configs) {
  assertRegistry();
  const resolvedManifest = manifest ?? loadManifest();
  const resolvedMapping = mapping ?? loadMapping();
  assertRegisteredProfile(PROFILE_REGISTRY[0], resolvedManifest);
  validateManifest(resolvedManifest, resolvedMapping);
  const loaded = configs ?? Object.fromEntries(resolvedManifest.components.map((component) => [component.id, loadJson(component.config)]));
  for (const component of resolvedManifest.components) validateConfig(resolvedManifest, component, loaded[component.id], resolvedMapping);
  scanSampleBindingReads();
  checkGenerated(resolvedManifest);
  return manifestDigest(resolvedManifest);
}

// meeting-room-postgres: the checked-in Hyperdrive / Postgres sample (samples/meeting-room/wrangler.jsonc).
// Its tables are separate from the cloudflare-only tables above, which feed the generated descriptor.
export const POSTGRES_PROFILE_ID = "meeting-room-postgres";
export const POSTGRES_DIGEST = "5a557856334e199ed86a623ebc293df50c05a8d731f38a119bcf5c2d8b54ef34";
const POSTGRES_TENANT_REF = "tnrf-b2f5a80ec001ba54891f";
const POSTGRES_CONFIG_PATH = "samples/meeting-room/wrangler.jsonc";
const POSTGRES_WORKER_SOURCE_PATH = "samples/meeting-room/src/worker.ts";
const POSTGRES_WORKER_NAME = "sekiban-dcb-meeting-room";
const POSTGRES_CONFIG_BINDINGS = ["ALLOCATOR", "DOWNSTREAM_QUEUE", "HYPERDRIVE", "JOURNAL", "RUNTIME", "TAG", "TAG_STATE"];
const POSTGRES_RAW_BINDINGS = ["ALLOCATOR", "DOWNSTREAM_QUEUE", "HYPERDRIVE", "JOURNAL", "TAG", "TAG_STATE"];
const POSTGRES_FORBIDDEN_NAMES = ["BOOTSTRAP", "D1", "D1_MV", "DOWNSTREAM_DOORBELL", "POSTGRES_URL"];
const POSTGRES_FORBIDDEN_PREFIX = "COSMOS_";
const POSTGRES_DO_BINDINGS = ["ALLOCATOR", "JOURNAL", "TAG", "TAG_STATE"];
const POSTGRES_DO_MIGRATION_CLASSES = {
  v1: ["AllocatorDurableObject", "JournalDurableObject", "TagDurableObject"],
  v2: ["TagStateDurableObject"],
};
const POSTGRES_SOURCE_EXPORTS = ["runtime", "AllocatorDurableObject", "JournalDurableObject", "TagDurableObject", "TagStateDurableObject"];
const POSTGRES_TOP_LEVEL_KEYS = ["name", "main", "compatibility_date", "vars", "assets", "triggers", "services", "hyperdrive", "queues", "durable_objects", "migrations", "env"];
const POSTGRES_MANIFEST_KEYS = ["schemaVersion", "profileId", "canonicalizationVersion", "tenantRef", "scopeAxes", "components", "resources", "edges", "cardinalities", "migrationDomains", "durableObjectClasses"];
const POSTGRES_COMPONENT_KEYS = ["id", "workerName", "config", "logicalServiceScope", "deploymentComponentScope", "providerTenantScope", "physicalResourceScope", "entrypoints"];
const POSTGRES_FORBIDDEN_ENTRYPOINT_BINDINGS = ["BOOTSTRAP", "D1", "D1_MV", "DOWNSTREAM_DOORBELL", "POSTGRES_URL"];
const POSTGRES_ENTRYPOINTS = [
  { kind: "default", operation: "fetch", requiredBindings: POSTGRES_CONFIG_BINDINGS, forbiddenBindings: POSTGRES_FORBIDDEN_ENTRYPOINT_BINDINGS },
  { kind: "named", name: "runtime", operation: "fetch", requiredBindings: POSTGRES_RAW_BINDINGS, forbiddenBindings: POSTGRES_FORBIDDEN_ENTRYPOINT_BINDINGS },
];
const POSTGRES_RESOURCE_REFS = {
  "pipeline-hyperdrive": "rref-dd3d86e19942d3b54248",
  "work-queue": "rref-adf533d496da5c50acc6",
  "allocator-do": "rref-e9995a62bf88f5afab7c",
  "journal-do": "rref-ed1dfc4ce97b932cde44",
  "tag-do": "rref-d43ae027c8d23340aaf7",
  "tag-state-do": "rref-dca9f6c4e054bf6a28da",
};
const postgresDurableObjectResource = (id) => ({ id, kind: "physical-resource", providerKind: "durable-object", role: "durable-object", owner: "worker", scriptName: null, resourceRef: POSTGRES_RESOURCE_REFS[id] });
const POSTGRES_RESOURCES = [
  { id: "pipeline-hyperdrive", kind: "physical-resource", providerKind: "hyperdrive", role: "pipeline-Postgres", resourceRef: POSTGRES_RESOURCE_REFS["pipeline-hyperdrive"] },
  { id: "work-queue", kind: "physical-resource", providerKind: "queue", role: "work-queue", resourceRef: POSTGRES_RESOURCE_REFS["work-queue"] },
  postgresDurableObjectResource("allocator-do"),
  postgresDurableObjectResource("journal-do"),
  postgresDurableObjectResource("tag-do"),
  postgresDurableObjectResource("tag-state-do"),
];
const POSTGRES_EDGES = [
  { id: "worker-pipeline", kind: "physical-resource", from: "worker", to: "pipeline-hyperdrive", binding: "HYPERDRIVE" },
  { id: "worker-producer", kind: "producer-binding", from: "worker", to: "work-queue", binding: "DOWNSTREAM_QUEUE" },
  { id: "worker-consumer", kind: "consumer-attachment", from: "worker", to: "work-queue" },
  { id: "worker-allocator", kind: "durable-object-binding", from: "worker", to: "allocator-do", binding: "ALLOCATOR" },
  { id: "worker-journal", kind: "durable-object-binding", from: "worker", to: "journal-do", binding: "JOURNAL" },
  { id: "worker-tag", kind: "durable-object-binding", from: "worker", to: "tag-do", binding: "TAG" },
  { id: "worker-tag-state", kind: "durable-object-binding", from: "worker", to: "tag-state-do", binding: "TAG_STATE" },
  { id: "worker-runtime", kind: "service-binding", from: "worker", to: "worker", binding: "RUNTIME", entrypoint: "runtime" },
];
const POSTGRES_CARDINALITIES = {
  worker: { "producer-binding": 1, "consumer-attachment": 1, "dlq-target": 0, "service-binding": 1, "embedded-entrypoint": 0, "physical-resource": 1, "durable-object-binding": 4 },
};
const POSTGRES_MIGRATION_DOMAINS = { "durable-object": { worker: { owner: "worker", sequence: ["v1", "v2"] } } };
const POSTGRES_DO_CLASSES = ["AllocatorDurableObject", "JournalDurableObject", "TagDurableObject", "TagStateDurableObject"];
const POSTGRES_MAPPING_KEYS = ["HYPERDRIVE", "DOWNSTREAM_QUEUE", "ALLOCATOR", "JOURNAL", "TAG", "TAG_STATE"];
const POSTGRES_MAPPING_VALUES = {
  HYPERDRIVE: { id: "REPLACE_WITH_SAMPLE_HYPERDRIVE_ID", resourceRef: POSTGRES_RESOURCE_REFS["pipeline-hyperdrive"] },
  DOWNSTREAM_QUEUE: { queue: "serialized-dcb-v1-downstream", consumerQueue: "serialized-dcb-v1-downstream", resourceRef: POSTGRES_RESOURCE_REFS["work-queue"] },
  ALLOCATOR: { class_name: "AllocatorDurableObject", resourceRef: POSTGRES_RESOURCE_REFS["allocator-do"] },
  JOURNAL: { class_name: "JournalDurableObject", resourceRef: POSTGRES_RESOURCE_REFS["journal-do"] },
  TAG: { class_name: "TagDurableObject", resourceRef: POSTGRES_RESOURCE_REFS["tag-do"] },
  TAG_STATE: { class_name: "TagStateDurableObject", resourceRef: POSTGRES_RESOURCE_REFS["tag-state-do"] },
};
const POSTGRES_MAPPING_RESOURCES = { HYPERDRIVE: "pipeline-hyperdrive", DOWNSTREAM_QUEUE: "work-queue", ALLOCATOR: "allocator-do", JOURNAL: "journal-do", TAG: "tag-do", TAG_STATE: "tag-state-do" };
const POSTGRES_ROW_KEYS = {
  assets: ["directory"],
  services: ["binding", "entrypoint", "service"],
  hyperdrive: ["binding", "id"],
  queues: ["consumers", "producers"],
  producers: ["binding", "queue"],
  consumers: ["queue"],
  durable_objects: ["bindings"],
  doBindings: ["class_name", "name"],
};

const cardinality = (value) => fail("CARDINALITY", value.path, "cardinality");
const sortedKeys = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : null);
const asArray = (value) => (Array.isArray(value) ? value : []);

export function loadPostgresManifest() { return loadJson(postgresManifestPath); }
export function loadPostgresMapping() { return loadJson(postgresMappingPath); }

function requirePostgresMapping(mapping) {
  assertClosedObject(mapping, "mapping", ["resources"], () => fail("CARDINALITY", "mapping.keys", "cardinality"));
  const resources = mapping.resources;
  if (resources === null || typeof resources !== "object" || Array.isArray(resources)) fail("SCOPE_PROOF_UNAVAILABLE", postgresMappingPath, "scope-proof-unavailable");
  assertExact(Object.keys(resources), POSTGRES_MAPPING_KEYS, "CARDINALITY", "resources", "cardinality");
  for (const key of POSTGRES_MAPPING_KEYS) {
    assertExact(sortedKeys(resources[key]), Object.keys(POSTGRES_MAPPING_VALUES[key]).sort(), "CARDINALITY", `resources.${key}`, "cardinality");
    for (const [field, value] of Object.entries(POSTGRES_MAPPING_VALUES[key])) {
      if (resources[key][field] !== value) fail("RESOURCE_MISMATCH", `resources.${key}.${field}`, "resource-identity-mismatch");
    }
  }
}

export function validatePostgresManifest(manifest, mapping) {
  assertClosedObject(manifest, "manifest", POSTGRES_MANIFEST_KEYS, () => fail("CARDINALITY", "manifest.keys", "cardinality"));
  assertManifestIdentities(manifest);
  requirePostgresMapping(mapping);
  if (manifest.schemaVersion !== 1 || manifest.canonicalizationVersion !== CANONICALIZATION_VERSION || manifest.profileId !== POSTGRES_PROFILE_ID) fail("CARDINALITY", "profileId", "cardinality");
  if (manifest.tenantRef !== POSTGRES_TENANT_REF) fail("SCOPE_PROOF_UNAVAILABLE", "tenantRef", "scope-proof-unavailable");
  assertExact(manifest.scopeAxes, ["logicalServiceScope", "deploymentComponentScope", "providerTenantScope", "physicalResourceScope"], "CARDINALITY", "scopeAxes", "cardinality");
  assertExact(asArray(manifest.components).map((component) => component?.id), ["worker"], "CARDINALITY", "components", "cardinality");
  const component = manifest.components[0];
  assertClosedObject(component, "worker", POSTGRES_COMPONENT_KEYS, () => fail("CARDINALITY", "worker.keys", "cardinality"));
  for (const [key, value] of Object.entries({ workerName: POSTGRES_WORKER_NAME, config: POSTGRES_CONFIG_PATH, deploymentComponentScope: "worker", physicalResourceScope: "opaque-ref" })) {
    if (component[key] !== value) fail("CARDINALITY", `worker.${key}`, "cardinality");
  }
  assertExact(component.logicalServiceScope, { sharing: "exclusive", serviceIdSource: "deploy-var" }, "SCOPE_PROOF_UNAVAILABLE", "worker.scope", "scope-proof-unavailable");
  assertExact(component.providerTenantScope, { tenantRef: manifest.tenantRef }, "SCOPE_PROOF_UNAVAILABLE", "worker.scope", "scope-proof-unavailable");
  assertExact(component.entrypoints, POSTGRES_ENTRYPOINTS, "CARDINALITY", "worker.entrypoints", "cardinality");
  if (asArray(manifest.resources).filter((resource) => resource?.role === "pipeline-Postgres").length !== 1) fail("SECOND_SHARD", "resources.pipeline-Postgres", "second-shard");
  assertExact(manifest.resources.map((resource) => resource.id), POSTGRES_RESOURCES.map((resource) => resource.id), "CARDINALITY", "resources", "cardinality");
  for (const [index, resource] of manifest.resources.entries()) {
    if (resource.resourceRef !== POSTGRES_RESOURCE_REFS[resource.id]) fail("RESOURCE_MISMATCH", resource.id, "resource-identity-mismatch");
    if (resource.providerKind === "durable-object" && (resource.owner !== "worker" || resource.scriptName !== null)) fail("DO_MIGRATION_OWNER", resource.id, "do-migration-owner");
    assertExact(resource, POSTGRES_RESOURCES[index], "CARDINALITY", `resources.${resource.id}`, "cardinality");
  }
  assertExact(asArray(manifest.edges).map((edge) => edge?.id), POSTGRES_EDGES.map((edge) => edge.id), "CARDINALITY", "edges", "cardinality");
  for (const [index, edge] of manifest.edges.entries()) assertExact(edge, POSTGRES_EDGES[index], "CARDINALITY", `edges.${edge.id}`, "cardinality");
  assertExact(sortedKeys(manifest.cardinalities), ["worker"], "CARDINALITY", "cardinalities", "cardinality");
  assertExact(manifest.cardinalities.worker, POSTGRES_CARDINALITIES.worker, "CARDINALITY", "worker.cardinality", "cardinality");
  if (manifest.migrationDomains?.["durable-object"]?.worker?.owner !== "worker") fail("DO_MIGRATION_OWNER", "worker.durable-object", "do-migration-owner");
  assertExact(manifest.migrationDomains, POSTGRES_MIGRATION_DOMAINS, "MIGRATION_ORDER", "migrationDomains", "migration-order");
  assertExact(manifest.durableObjectClasses, POSTGRES_DO_CLASSES, "CARDINALITY", "durableObjectClasses", "cardinality");
  for (const [binding, resourceId] of Object.entries(POSTGRES_MAPPING_RESOURCES)) {
    if (mapping.resources[binding].resourceRef !== resourceById(manifest, resourceId).resourceRef) fail("RESOURCE_MISMATCH", binding, "resource-identity-mismatch");
  }
  const envelope = manifestDigest(manifest);
  if (envelope.digest !== POSTGRES_DIGEST) fail("DIGEST_MISMATCH", "digest", "digest-mismatch");
  return envelope;
}

function postgresDeclaredNames(config) {
  const assetsBinding = config?.assets !== null && typeof config?.assets === "object" && !Array.isArray(config.assets)
    ? config.assets.binding
    : undefined;
  return [
    ...bindingNames(config),
    ...Object.keys(config?.vars ?? {}),
    ...(typeof assetsBinding === "string" ? [assetsBinding] : []),
  ];
}

function canStartRegex(out) {
  let j = out.length - 1;
  while (j >= 0 && /\s/.test(out[j])) j -= 1;
  if (j < 0) return true;
  const ch = out[j];
  // postfix ++ / -- is followed by division, not a regex literal
  if ((ch === "+" || ch === "-") && j >= 1 && out[j - 1] === ch) return false;
  if ("=([,{;!?:&|+-*%<>~^".includes(ch)) return true;
  const tail = out.slice(Math.max(0, j - 9), j + 1);
  return /\b(?:return|case|throw|typeof|void|delete|new|await|in|of|instanceof|yield)$/.test(tail);
}

// Drop comments, strings, templates (incl. nested `${...}`), and regex literals
// so export probes only see executable statements. Not a TypeScript parser.
function stripNonCode(source) {
  let out = "";
  let i = 0;
  const stack = ["code"];
  // Byte offsets into `out` where each templateExpr frame began (expression-local regex context).
  const exprStarts = [];
  const blank = (ch) => (ch === "\n" || ch === "\r" ? ch : " ");
  const regexContext = () => {
    const state = stack[stack.length - 1];
    if (state === "templateExpr") return out.slice(exprStarts[exprStarts.length - 1] ?? out.length);
    return out;
  };
  while (i < source.length) {
    const state = stack[stack.length - 1];
    const ch = source[i];
    const next = source[i + 1];
    if (state === "code" || state === "templateExpr") {
      if (ch === "/" && next === "/") { stack.push("lineComment"); out += "  "; i += 2; continue; }
      if (ch === "/" && next === "*") { stack.push("blockComment"); out += "  "; i += 2; continue; }
      if (ch === "/" && canStartRegex(regexContext())) { stack.push("regex"); out += " "; i += 1; continue; }
      if (ch === "'") { stack.push("single"); out += " "; i += 1; continue; }
      if (ch === "\"") { stack.push("double"); out += " "; i += 1; continue; }
      if (ch === "`") { stack.push("template"); out += " "; i += 1; continue; }
      if (state === "templateExpr" && ch === "{") { stack.push("templateExpr"); exprStarts.push(out.length); out += ch; i += 1; continue; }
      if (state === "templateExpr" && ch === "}") { stack.pop(); exprStarts.pop(); out += ch; i += 1; continue; }
      out += ch; i += 1; continue;
    }
    if (state === "lineComment") {
      if (ch === "\n" || ch === "\r") { stack.pop(); out += ch; i += 1; continue; }
      out += " "; i += 1; continue;
    }
    if (state === "blockComment") {
      if (ch === "*" && next === "/") { stack.pop(); out += "  "; i += 2; continue; }
      out += blank(ch); i += 1; continue;
    }
    if (state === "single" || state === "double") {
      const quote = state === "single" ? "'" : "\"";
      if (ch === "\\") { out += "  "; i += Math.min(2, source.length - i); continue; }
      if (ch === quote) { stack.pop(); out += " "; i += 1; continue; }
      out += blank(ch); i += 1; continue;
    }
    if (state === "template") {
      if (ch === "\\") { out += "  "; i += Math.min(2, source.length - i); continue; }
      if (ch === "`") { stack.pop(); out += " "; i += 1; continue; }
      if (ch === "$" && next === "{") { stack.push("templateExpr"); exprStarts.push(out.length); out += "  "; i += 2; continue; }
      out += blank(ch); i += 1; continue;
    }
    if (state === "regex") {
      if (ch === "\\") { out += "  "; i += Math.min(2, source.length - i); continue; }
      if (ch === "[") { stack.push("regexClass"); out += " "; i += 1; continue; }
      if (ch === "/") {
        stack.pop();
        out += " ";
        i += 1;
        while (i < source.length && /[a-z]/i.test(source[i])) { out += " "; i += 1; }
        continue;
      }
      out += blank(ch); i += 1; continue;
    }
    if (state === "regexClass") {
      if (ch === "\\") { out += "  "; i += Math.min(2, source.length - i); continue; }
      if (ch === "]") { stack.pop(); out += " "; i += 1; continue; }
      out += blank(ch); i += 1; continue;
    }
    out += ch; i += 1;
  }
  return out;
}

function exportedNames(source) {
  const text = stripNonCode(source);
  const names = new Set();
  for (const match of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of match[1].split(",")) {
      const trimmed = part.trim();
      if (!trimmed || /^type\b/.test(trimmed)) continue;
      const name = trimmed.split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  for (const match of text.matchAll(/^export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(match[1]);
  return names;
}

function assertPostgresSource(source) {
  const names = exportedNames(source);
  for (const name of POSTGRES_SOURCE_EXPORTS) if (!names.has(name)) fail("ENTRYPOINT_MISSING", `${POSTGRES_WORKER_SOURCE_PATH}#${name}`, "entrypoint-missing");
  if (!/\benv\s*(?:\?\.|\.)\s*RUNTIME\b/.test(stripNonCode(source))) fail("ENTRYPOINT_MISSING", `${POSTGRES_WORKER_SOURCE_PATH}#RUNTIME`, "entrypoint-missing");
}

export function loadSampleSources() {
  return Object.fromEntries(walkTs(join(root, "samples/meeting-room/src")).sort().map((file) => [file, readFileSync(join(root, file), "utf8")]));
}

export function scanPostgresBindingReads(files = loadSampleSources()) {
  const hits = Object.keys(files).sort().filter((file) => file !== generatedPath).filter((file) => rawBindingHits(files[file], POSTGRES_RAW_BINDINGS));
  if (hits.length !== 0) fail("RAW_BINDING", hits[0], "raw-binding");
  return hits;
}

// Checks the raw top-level configuration (no environment selection), in the documented row order.
export function validatePostgresConfig(
  manifest,
  mapping,
  configText = readFileSync(join(root, POSTGRES_CONFIG_PATH), "utf8"),
  source = readFileSync(join(root, POSTGRES_WORKER_SOURCE_PATH), "utf8"),
  files = loadSampleSources(),
) {
  const component = manifest.components[0];
  const config = parseJsonc(configText, component.config, cardinality);
  if (config === null || typeof config !== "object" || Array.isArray(config)) fail("CARDINALITY", "worker.keys", "cardinality");
  // 1. named environment overlays
  if (Object.prototype.hasOwnProperty.call(config, "env") && JSON.stringify(sortedKeys(config.env)) !== "[]") fail("NAMED_ENVIRONMENT_FORBIDDEN", "worker.env", "named-environment-forbidden");
  // 2. a local connection string never belongs in the checked-in file
  if (asArray(config.hyperdrive).some((entry) => entry !== null && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "localConnectionString"))) fail("LOCAL_CONNECTION_STRING", "worker.hyperdrive.localConnectionString", "local-connection-string");
  // 3. forbidden binding or var names (paths are constants, never configured values)
  const declared = postgresDeclaredNames(config);
  for (const name of POSTGRES_FORBIDDEN_NAMES) if (declared.includes(name)) fail("FORBIDDEN_BINDING", `worker.${name}`, "forbidden-binding");
  if (declared.some((name) => typeof name === "string" && name.startsWith(POSTGRES_FORBIDDEN_PREFIX))) fail("FORBIDDEN_BINDING", "worker.COSMOS", "forbidden-binding");
  // 4. closed top-level keys
  if (Object.keys(config).some((key) => !POSTGRES_TOP_LEVEL_KEYS.includes(key))) fail("CARDINALITY", "worker.keys", "cardinality");
  // 5. duplicate identities
  assertConfigIdentities(config);
  assertUniqueBy(asArray(config.services), (entry) => entry?.binding, "services.binding", cardinality);
  // 6. worker identity
  if (config.name !== component.workerName) fail("CARDINALITY", `${component.id}.workerName`, "cardinality");
  if (config.main !== "src/worker.ts") fail("CARDINALITY", `${component.id}.main`, "cardinality");
  // 7. exact binding multiset; a var may not shadow a required binding
  assertExact(bindingNames(config).sort(), POSTGRES_CONFIG_BINDINGS, "CARDINALITY", `${component.id}.bindings`, "cardinality");
  if (Object.keys(config.vars ?? {}).some((key) => POSTGRES_CONFIG_BINDINGS.includes(key))) fail("CARDINALITY", `${component.id}.vars`, "cardinality");
  // 8. Hyperdrive identity
  if (asArray(config.hyperdrive).find((entry) => entry?.binding === "HYPERDRIVE")?.id !== mapping.resources.HYPERDRIVE.id) fail("RESOURCE_MISMATCH", `${component.id}.hyperdrive`, "resource-identity-mismatch");
  // 9. RUNTIME service attachment
  const runtimeEdge = edgeById(manifest, "worker-runtime");
  const service = asArray(config.services).find((entry) => entry?.binding === runtimeEdge.binding);
  if (service?.service !== component.workerName) fail("RESOURCE_MISMATCH", `${component.id}.RUNTIME.service`, "resource-identity-mismatch");
  if (service?.entrypoint !== runtimeEdge.entrypoint) fail("RESOURCE_MISMATCH", `${component.id}.RUNTIME.entrypoint`, "resource-identity-mismatch");
  // 10. queue cardinality
  const producers = asArray(config.queues?.producers);
  const consumers = asArray(config.queues?.consumers);
  if (producers.length !== manifest.cardinalities.worker["producer-binding"]) fail("CARDINALITY", `${component.id}.producer-binding`, "cardinality");
  if (consumers.length !== manifest.cardinalities.worker["consumer-attachment"]) fail("CARDINALITY", `${component.id}.consumer-attachment`, "cardinality");
  // 11. no dead-letter queue in this profile
  if ([...producers, ...consumers].some((entry) => Object.prototype.hasOwnProperty.call(entry ?? {}, "dead_letter_queue"))) fail("CARDINALITY", `${component.id}.dlq-target`, "cardinality");
  // 12. queue identity
  if (producers[0]?.binding !== "DOWNSTREAM_QUEUE" || producers[0]?.queue !== mapping.resources.DOWNSTREAM_QUEUE.queue) fail("RESOURCE_MISMATCH", `${component.id}.producer`, "resource-identity-mismatch");
  if (consumers[0]?.queue !== mapping.resources.DOWNSTREAM_QUEUE.consumerQueue) fail("RESOURCE_MISMATCH", `${component.id}.consumer`, "resource-identity-mismatch");
  // 13-14. Durable Objects are owned by this Worker and bind the mapped classes
  const doBindings = asArray(config.durable_objects?.bindings);
  for (const binding of POSTGRES_DO_BINDINGS) {
    const actual = doBindings.find((entry) => entry?.name === binding);
    if (Object.prototype.hasOwnProperty.call(actual ?? {}, "script_name")) fail("DO_MIGRATION_OWNER", `${component.id}.${binding}`, "do-migration-owner");
  }
  for (const binding of POSTGRES_DO_BINDINGS) {
    const actual = doBindings.find((entry) => entry?.name === binding);
    if (actual?.class_name !== mapping.resources[binding].class_name) fail("RESOURCE_MISMATCH", `${component.id}.${binding}.class_name`, "resource-identity-mismatch");
  }
  // 15. binding rows carry only the checked-in keys (assets is directory-only; no binding)
  const rowShapes = [
    ...(Object.prototype.hasOwnProperty.call(config, "assets") ? [[config.assets, POSTGRES_ROW_KEYS.assets]] : []),
    ...asArray(config.services).map((row) => [row, POSTGRES_ROW_KEYS.services]),
    ...asArray(config.hyperdrive).map((row) => [row, POSTGRES_ROW_KEYS.hyperdrive]),
    [config.queues, POSTGRES_ROW_KEYS.queues],
    ...producers.map((row) => [row, POSTGRES_ROW_KEYS.producers]),
    ...consumers.map((row) => [row, POSTGRES_ROW_KEYS.consumers]),
    [config.durable_objects, POSTGRES_ROW_KEYS.durable_objects],
    ...doBindings.map((row) => [row, POSTGRES_ROW_KEYS.doBindings]),
  ];
  for (const [row, keys] of rowShapes) if (JSON.stringify(sortedKeys(row)) !== JSON.stringify(keys)) fail("CARDINALITY", `${component.id}.rows`, "cardinality");
  // 16-17. Durable Object migrations
  const migrations = asArray(config.migrations);
  assertExact(migrations.map((entry) => entry?.tag), manifest.migrationDomains["durable-object"].worker.sequence, "MIGRATION_ORDER", `${component.id}.durable-object`, "migration-order");
  for (const entry of migrations) {
    if (JSON.stringify(sortedKeys(entry)) !== JSON.stringify(["new_sqlite_classes", "tag"]) || !Array.isArray(entry.new_sqlite_classes)) fail("DO_MIGRATION_OWNER", `${component.id}.${entry.tag}`, "do-migration-owner");
    assertExact([...entry.new_sqlite_classes].sort(), [...POSTGRES_DO_MIGRATION_CLASSES[entry.tag]].sort(), "DO_MIGRATION_OWNER", `${component.id}.${entry.tag}`, "do-migration-owner");
  }
  // 18. Worker exports and the RUNTIME read
  assertPostgresSource(source);
  // 19. raw binding reads (RUNTIME and SDT_SERVICE_ID direct reads are allowed)
  scanPostgresBindingReads(files);
  return config;
}

export function validatePostgresProfile(manifest, mapping, options = {}) {
  assertRegistry();
  const resolvedManifest = manifest ?? loadPostgresManifest();
  const resolvedMapping = mapping ?? loadPostgresMapping();
  assertRegisteredProfile(PROFILE_REGISTRY[1], resolvedManifest);
  const envelope = validatePostgresManifest(resolvedManifest, resolvedMapping);
  validatePostgresConfig(resolvedManifest, resolvedMapping, options.configText, options.source, options.files);
  return envelope;
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
  assertRegistry();
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
  const parseSelfTestJsonc = (text) => parseJsonc(text, "self-test.jsonc", (value) => fail("CARDINALITY", value.path, "cardinality"));
  if (parseSelfTestJsonc("// line comment\n{\"value\": 1}").value !== 1) throw new Error("line comments were not accepted");
  if (parseSelfTestJsonc("/* block comment */ {\"value\": 1}").value !== 1) throw new Error("block comments were not accepted");
  expect("jsonc-object-trailing-comma", () => parseSelfTestJsonc("{\"value\": 1,}"), "CARDINALITY", "$", "cardinality");
  expect("jsonc-array-trailing-comma", () => parseSelfTestJsonc("[1,]"), "CARDINALITY", "$[1]", "cardinality");
  expect("second-producer", () => validateConfig(manifest, manifest.components[0], { ...worker, queues: { ...worker.queues, producers: [...worker.queues.producers, { binding: "EXTRA", queue: "extra" }] } }, mapping), "CARDINALITY", "worker.bindings", "cardinality");
  expect("duplicate-manifest-resource", () => validateManifest({ ...manifest, resources: [...manifest.resources, { ...manifest.resources[0] }] }, mapping), "CARDINALITY", "resources[9]", "cardinality");
  expect("duplicate-config-binding", () => validateConfig(manifest, manifest.components[0], { ...worker, d1_databases: [...worker.d1_databases, { ...worker.d1_databases[0] }] }, mapping), "CARDINALITY", "d1_databases.binding[2]", "cardinality");
  expect("second-shard", () => validateManifest({ ...manifest, resources: [...manifest.resources, { ...manifest.resources[0], id: "pipeline-d1-b" }] }, mapping), "SECOND_SHARD", "resources.pipeline-D1", "second-shard");
  expect("second-manifest", () => assertRegistry([manifestPath, "contracts/provider-composition.copy.json"]), "SECOND_MANIFEST", "contracts/provider-composition.copy.json", "second-manifest");
  const committed = readFileSync(join(root, generatedPath), "utf8");
  const core = readFileSync(join(root, sharedCorePath));
  expect("core-byte-drift", () => checkTemplateCore(core, Buffer.concat([core, Buffer.from("\n")])), "GENERATED_DRIFT", templateCorePath, "generated-drift");
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
  const fetchReceiverSource = receiverSource.replace("> = {};\nexport default receiver;", "> = { fetch() { return new Response(null); } };\nexport default receiver;");
  if (fetchReceiverSource === receiverSource) throw new Error("embedded-default-fetch anchor not found in samples/meeting-room/src/worker.g38-receiver.ts");
  expect("embedded-default-fetch", () => validateConfig(manifest, manifest.components[0], worker, mapping, source, fetchReceiverSource), "CARDINALITY", "samples/meeting-room/src/worker.g38-receiver.ts#default.fetch", "cardinality");
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
  const postgres = runPostgresSelfTest(expect, mapping, worker, manifest);
  return { result: "g34-provider-composition-self-test-passed", digest: envelope.digest, mutations, profiles: { [manifest.profileId]: envelope.digest, [POSTGRES_PROFILE_ID]: postgres.digest } };
}

function replaceOnce(text, anchor, replacement, label) {
  const count = text.split(anchor).length - 1;
  if (count !== 1) throw new Error(`${label} anchor matched ${count} times`);
  return text.replace(anchor, replacement);
}

function runPostgresSelfTest(expect, cloudflareMapping, cloudflareWorker, cloudflareManifest) {
  const manifest = loadPostgresManifest();
  const mapping = loadPostgresMapping();
  const configText = readFileSync(join(root, POSTGRES_CONFIG_PATH), "utf8");
  const source = readFileSync(join(root, POSTGRES_WORKER_SOURCE_PATH), "utf8");
  const files = loadSampleSources();
  const envelope = validatePostgresProfile(manifest, mapping, { configText, source, files });
  if (envelope.digest !== POSTGRES_DIGEST) throw new Error("postgres digest drifted");
  const config = parseJsonc(configText, POSTGRES_CONFIG_PATH, cardinality);
  const run = (mutated, mutatedSource = source, mutatedFiles = files) => validatePostgresConfig(manifest, mapping, JSON.stringify(mutated), mutatedSource, mutatedFiles);
  const withConfig = (edit) => () => { const mutated = structuredClone(config); edit(mutated); run(mutated); };
  const withManifest = (edit, mutatedMapping = mapping) => () => { const mutated = structuredClone(manifest); edit(mutated); validatePostgresManifest(mutated, mutatedMapping); };
  run(config);

  const registered = PROFILE_REGISTRY.flatMap((entry) => [entry.manifestPath, entry.mappingPath]);
  assertRegistry(registered);
  expect("registry-rogue-manifest", () => assertRegistry([...registered, "contracts/provider-composition.rogue.json"]), "SECOND_MANIFEST", "contracts/provider-composition.rogue.json", "second-manifest");
  expect("registry-rogue-local-mapping", () => assertRegistry([...registered, "contracts/provider-composition.rogue.local-mapping.json"]), "SECOND_MANIFEST", "contracts/provider-composition.rogue.local-mapping.json", "second-manifest");
  expect("registry-missing-manifest", () => assertRegistry(registered.filter((path) => path !== postgresManifestPath)), "MISSING_CONFIG", postgresManifestPath, "missing-config");
  expect("registry-missing-mapping", () => assertRegistry(registered.filter((path) => path !== postgresMappingPath)), "MISSING_CONFIG", postgresMappingPath, "missing-config");
  const missingOnDisk = "contracts/provider-composition.missing-on-disk.json";
  expect("registry-missing-on-disk", () => assertRegistry(
    [missingOnDisk, mappingPath, postgresManifestPath, postgresMappingPath],
    [{ profileId: "meeting-room-cloudflare", manifestPath: missingOnDisk, mappingPath }, PROFILE_REGISTRY[1]],
  ), "MISSING_CONFIG", missingOnDisk, "missing-config");
  expect("registry-duplicate-profile-id", () => assertRegistry(registered, [PROFILE_REGISTRY[0], { ...PROFILE_REGISTRY[1], profileId: PROFILE_REGISTRY[0].profileId }]), "CARDINALITY", "registry.profileId[1]", "cardinality");
  expect("registry-profile-id-mismatch", () => assertRegisteredProfile(PROFILE_REGISTRY[1], { ...manifest, profileId: PROFILE_REGISTRY[0].profileId }), "CARDINALITY", "profileId", "cardinality");
  expect("postgres-assets-binding-d1-mv", withConfig((mutated) => { mutated.assets = { directory: "public", binding: "D1_MV" }; }), "FORBIDDEN_BINDING", "worker.D1_MV", "forbidden-binding");
  expect("postgres-assets-binding-cosmos", withConfig((mutated) => { mutated.assets = { directory: "public", binding: "COSMOS_STORE" }; }), "FORBIDDEN_BINDING", "worker.COSMOS", "forbidden-binding");
  expect("postgres-assets-binding-row", withConfig((mutated) => { mutated.assets = { directory: "public", binding: "EXTRA_ASSET" }; }), "CARDINALITY", "worker.rows", "cardinality");

  expect("postgres-manifest-unknown-key", withManifest((mutated) => { mutated.extra = true; }), "CARDINALITY", "manifest.keys", "cardinality");
  expect("postgres-second-pipeline", withManifest((mutated) => { mutated.resources.push({ ...mutated.resources[0], id: "pipeline-hyperdrive-b" }); }), "SECOND_SHARD", "resources.pipeline-Postgres", "second-shard");
  const reusedMapping = structuredClone(mapping); reusedMapping.resources.HYPERDRIVE.resourceRef = cloudflareMapping.resources.D1.resourceRef;
  expect("postgres-cloudflare-ref-reused", withManifest((mutated) => { mutated.resources[0].resourceRef = cloudflareMapping.resources.D1.resourceRef; }, reusedMapping), "RESOURCE_MISMATCH", "resources.HYPERDRIVE.resourceRef", "resource-identity-mismatch");
  expect("postgres-cloudflare-ref-in-manifest", withManifest((mutated) => { mutated.resources[0].resourceRef = cloudflareMapping.resources.D1.resourceRef; }), "RESOURCE_MISMATCH", "pipeline-hyperdrive", "resource-identity-mismatch");
  expect("postgres-mapping-of-other-profile", () => validatePostgresManifest(manifest, cloudflareMapping), "CARDINALITY", "resources", "cardinality");
  expect("postgres-tenant-ref", withManifest((mutated) => { mutated.tenantRef = cloudflareManifest.tenantRef; }), "SCOPE_PROOF_UNAVAILABLE", "tenantRef", "scope-proof-unavailable");
  expect("postgres-invented-dlq-edge", withManifest((mutated) => { mutated.edges.push({ id: "worker-dlq", kind: "dlq-target", from: "worker-consumer", to: "dlq-queue" }); }), "CARDINALITY", "edges", "cardinality");
  expect("postgres-retargeted-service-edge", withManifest((mutated) => { mutated.edges.find((edge) => edge.id === "worker-runtime").to = "other-worker"; }), "CARDINALITY", "edges.worker-runtime", "cardinality");

  expect("postgres-duplicate-json-key", () => validatePostgresConfig(manifest, mapping, replaceOnce(configText, '"main": "src/worker.ts",', '"main": "src/worker.ts",\n  "main": "src/worker.ts",', "duplicate-json-key"), source, files), "CARDINALITY", "$", "cardinality");
  expect("postgres-duplicate-hyperdrive", withConfig((mutated) => { mutated.hyperdrive.push({ ...mutated.hyperdrive[0] }); }), "CARDINALITY", "hyperdrive.binding[1]", "cardinality");
  expect("postgres-dropped-hyperdrive", withConfig((mutated) => { delete mutated.hyperdrive; }), "CARDINALITY", "worker.bindings", "cardinality");
  expect("postgres-renamed-hyperdrive", withConfig((mutated) => { mutated.hyperdrive[0].binding = "PIPELINE_POSTGRES"; }), "CARDINALITY", "worker.bindings", "cardinality");
  const canaries = { hyperdriveId: "CANARY-HYPERDRIVE-ID-7f3a", localConnectionString: "postgres://canary-user:canary-secret@canary-host:5432/canary", postgresUrl: "postgres://canary-url-user:canary-url-secret@canary-url-host/db" };
  const canaryCases = [
    ["postgres-wrong-hyperdrive-id", withConfig((mutated) => { mutated.hyperdrive[0].id = canaries.hyperdriveId; }), "RESOURCE_MISMATCH", "worker.hyperdrive", "resource-identity-mismatch"],
    ["postgres-local-connection-string", withConfig((mutated) => { mutated.hyperdrive[0].localConnectionString = canaries.localConnectionString; }), "LOCAL_CONNECTION_STRING", "worker.hyperdrive.localConnectionString", "local-connection-string"],
    ["postgres-url-var", withConfig((mutated) => { mutated.vars.POSTGRES_URL = canaries.postgresUrl; }), "FORBIDDEN_BINDING", "worker.POSTGRES_URL", "forbidden-binding"],
  ];
  for (const [name, fn, code, path, reason] of canaryCases) expect(name, fn, code, path, reason);
  expect("postgres-env-preview-hides-d1", withConfig((mutated) => { mutated.env = { preview: { d1_databases: [{ binding: "D1", database_name: "preview", database_id: "preview" }] } }; }), "NAMED_ENVIRONMENT_FORBIDDEN", "worker.env", "named-environment-forbidden");
  run({ ...config, env: {} });
  expect("postgres-d1", withConfig((mutated) => { mutated.d1_databases = [{ binding: "D1", database_name: "pipeline", database_id: "pipeline" }]; }), "FORBIDDEN_BINDING", "worker.D1", "forbidden-binding");
  expect("postgres-d1-mv", withConfig((mutated) => { mutated.d1_databases = [{ binding: "D1_MV", database_name: "mv", database_id: "mv" }]; }), "FORBIDDEN_BINDING", "worker.D1_MV", "forbidden-binding");
  expect("postgres-bootstrap", withConfig((mutated) => { mutated.durable_objects.bindings.push({ name: "BOOTSTRAP", class_name: "BootstrapCoordinatorDurableObject" }); }), "FORBIDDEN_BINDING", "worker.BOOTSTRAP", "forbidden-binding");
  expect("postgres-doorbell", withConfig((mutated) => { mutated.services.push({ binding: "DOWNSTREAM_DOORBELL", service: "sekiban-dcb-meeting-room", entrypoint: "MeetingRoomDownstreamDoorbell" }); }), "FORBIDDEN_BINDING", "worker.DOWNSTREAM_DOORBELL", "forbidden-binding");
  expect("postgres-cosmos-binding", withConfig((mutated) => { mutated.services.push({ binding: "COSMOS_STORE", service: "cosmos-store", entrypoint: "store" }); }), "FORBIDDEN_BINDING", "worker.COSMOS", "forbidden-binding");
  expect("postgres-cosmos-var", withConfig((mutated) => { mutated.vars.COSMOS_DATABASE = "meeting-room"; }), "FORBIDDEN_BINDING", "worker.COSMOS", "forbidden-binding");
  expect("postgres-unknown-top-level-key", withConfig((mutated) => { mutated.kv_namespaces = []; }), "CARDINALITY", "worker.keys", "cardinality");
  expect("postgres-var-shadows-binding", withConfig((mutated) => { mutated.vars.HYPERDRIVE = "shadow"; }), "CARDINALITY", "worker.vars", "cardinality");
  expect("postgres-missing-runtime", withConfig((mutated) => { mutated.services = []; }), "CARDINALITY", "worker.bindings", "cardinality");
  expect("postgres-retargeted-service", withConfig((mutated) => { mutated.services[0].service = "other-worker"; }), "RESOURCE_MISMATCH", "worker.RUNTIME.service", "resource-identity-mismatch");
  expect("postgres-wrong-entrypoint", withConfig((mutated) => { mutated.services[0].entrypoint = "default"; }), "RESOURCE_MISMATCH", "worker.RUNTIME.entrypoint", "resource-identity-mismatch");
  expect("postgres-service-row-key", withConfig((mutated) => { mutated.services[0].environment = "preview"; }), "CARDINALITY", "worker.rows", "cardinality");
  expect("postgres-second-producer", withConfig((mutated) => { mutated.queues.producers.push({ binding: "SECOND_QUEUE", queue: "serialized-dcb-v1-second" }); }), "CARDINALITY", "worker.bindings", "cardinality");
  expect("postgres-second-consumer", withConfig((mutated) => { mutated.queues.consumers.push({ queue: "serialized-dcb-v1-second" }); }), "CARDINALITY", "worker.consumer-attachment", "cardinality");
  expect("postgres-consumer-dlq", withConfig((mutated) => { mutated.queues.consumers[0].dead_letter_queue = "serialized-dcb-v1-downstream-dlq"; }), "CARDINALITY", "worker.dlq-target", "cardinality");
  expect("postgres-wrong-queue", withConfig((mutated) => { mutated.queues.producers[0].queue = "serialized-dcb-v1-other"; }), "RESOURCE_MISMATCH", "worker.producer", "resource-identity-mismatch");
  expect("postgres-script-name", withConfig((mutated) => { mutated.durable_objects.bindings[0].script_name = "other-worker"; }), "DO_MIGRATION_OWNER", "worker.ALLOCATOR", "do-migration-owner");
  expect("postgres-wrong-class", withConfig((mutated) => { mutated.durable_objects.bindings[0].class_name = "OtherAllocatorDurableObject"; }), "RESOURCE_MISMATCH", "worker.ALLOCATOR.class_name", "resource-identity-mismatch");
  expect("postgres-reordered-migrations", withConfig((mutated) => { mutated.migrations.reverse(); }), "MIGRATION_ORDER", "worker.durable-object", "migration-order");
  expect("postgres-moved-class", withConfig((mutated) => { mutated.migrations[0].new_sqlite_classes = ["AllocatorDurableObject", "JournalDurableObject"]; mutated.migrations[1].new_sqlite_classes = ["TagDurableObject", "TagStateDurableObject"]; }), "DO_MIGRATION_OWNER", "worker.v1", "do-migration-owner");

  const sourceCase = (mutatedSource) => () => run(config, mutatedSource);
  expect("postgres-missing-runtime-export", sourceCase(replaceOnce(source, "export { runtime };\n", "", "runtime-export")), "ENTRYPOINT_MISSING", `${POSTGRES_WORKER_SOURCE_PATH}#runtime`, "entrypoint-missing");
  expect("postgres-commented-runtime-export", sourceCase(replaceOnce(source, "export { runtime };\n", "// export { runtime };\n", "runtime-export")), "ENTRYPOINT_MISSING", `${POSTGRES_WORKER_SOURCE_PATH}#runtime`, "entrypoint-missing");
  expect("postgres-block-commented-runtime-export", sourceCase(replaceOnce(source, "export { runtime };\n", "/*\nexport { runtime };\n*/\n", "runtime-export")), "ENTRYPOINT_MISSING", `${POSTGRES_WORKER_SOURCE_PATH}#runtime`, "entrypoint-missing");
  expect("postgres-type-only-runtime-export", sourceCase(replaceOnce(source, "export { runtime };\n", "export type { runtime };\n", "runtime-export")), "ENTRYPOINT_MISSING", `${POSTGRES_WORKER_SOURCE_PATH}#runtime`, "entrypoint-missing");
  expect("postgres-type-aliased-runtime-export", sourceCase(replaceOnce(source, "export { runtime };\n", "export { type runtime as runtime };\n", "runtime-export")), "ENTRYPOINT_MISSING", `${POSTGRES_WORKER_SOURCE_PATH}#runtime`, "entrypoint-missing");
  expect("postgres-template-runtime-export", sourceCase(replaceOnce(source, "export { runtime };\n", "const decoy = `export { runtime };`;\n", "runtime-export")), "ENTRYPOINT_MISSING", `${POSTGRES_WORKER_SOURCE_PATH}#runtime`, "entrypoint-missing");
  expect("postgres-nested-template-runtime-export", sourceCase(replaceOnce(source, "export { runtime };\n", "const decoy = `${`\nexport { runtime };\n`}`;\n", "runtime-export")), "ENTRYPOINT_MISSING", `${POSTGRES_WORKER_SOURCE_PATH}#runtime`, "entrypoint-missing");
  expect("postgres-regex-template-runtime-export", sourceCase(replaceOnce(source, "export { runtime };\n", "const decoy = `${/}/.test(\"}\") ? `\nexport { runtime };\n` : \"\"}`;\n", "runtime-export")), "ENTRYPOINT_MISSING", `${POSTGRES_WORKER_SOURCE_PATH}#runtime`, "entrypoint-missing");
  expect("postgres-tagged-regex-template-runtime-export", sourceCase(replaceOnce(source, "export { runtime };\n", "const decoy = String.raw`${/}/.test(\"}\") ? `\nexport { runtime };\n` : \"\"}`;\n", "runtime-export")), "ENTRYPOINT_MISSING", `${POSTGRES_WORKER_SOURCE_PATH}#runtime`, "entrypoint-missing");
  expect("postgres-postfix-div-template-runtime-export", sourceCase(replaceOnce(source, "export { runtime };\n", "let i = 0; const q = i++ / 2; const decoy = `\nexport { runtime };\n`;\n", "runtime-export")), "ENTRYPOINT_MISSING", `${POSTGRES_WORKER_SOURCE_PATH}#runtime`, "entrypoint-missing");
  const classExport = `export { ${POSTGRES_DO_CLASSES.join(", ")} };`;
  for (const name of POSTGRES_DO_CLASSES) {
    const without = `export { ${POSTGRES_DO_CLASSES.filter((entry) => entry !== name).join(", ")} };`;
    expect(`postgres-missing-export-${name}`, sourceCase(replaceOnce(source, classExport, without, `class-export-${name}`)), "ENTRYPOINT_MISSING", `${POSTGRES_WORKER_SOURCE_PATH}#${name}`, "entrypoint-missing");
  }
  expect("postgres-missing-runtime-read", sourceCase(replaceOnce(source, "return env.RUNTIME ??", "return undefined ??", "runtime-read")), "ENTRYPOINT_MISSING", `${POSTGRES_WORKER_SOURCE_PATH}#RUNTIME`, "entrypoint-missing");
  const probePath = "samples/meeting-room/src/self-test-probe.ts";
  expect("postgres-raw-hyperdrive-read", () => run(config, source, { ...files, [probePath]: "export const probe = (env: { HYPERDRIVE: unknown }) => env.HYPERDRIVE;\n" }), "RAW_BINDING", probePath, "raw-binding");
  expect("postgres-raw-queue-read", () => run(config, source, { ...files, [probePath]: "export const probe = (env: { DOWNSTREAM_QUEUE: Queue }) => env.DOWNSTREAM_QUEUE.send({});\n" }), "RAW_BINDING", probePath, "raw-binding");
  run(config, source, { ...files, [probePath]: "export const probe = (env: { RUNTIME: Fetcher; SDT_SERVICE_ID: string }) => [env.RUNTIME, env.SDT_SERVICE_ID];\n" });

  const cloudflareComponent = cloudflareManifest.components[0];
  expect("cloudflare-hyperdrive-added", () => validateConfig(cloudflareManifest, cloudflareComponent, { ...cloudflareWorker, hyperdrive: [{ binding: "HYPERDRIVE", id: "REPLACE_WITH_SAMPLE_HYPERDRIVE_ID" }] }, cloudflareMapping), "CARDINALITY", "worker.bindings", "cardinality");
  expect("cloudflare-hyperdrive-shadows-d1", () => validateConfig(cloudflareManifest, cloudflareComponent, { ...cloudflareWorker, hyperdrive: [{ binding: "D1", id: "REPLACE_WITH_SAMPLE_HYPERDRIVE_ID" }] }, cloudflareMapping), "CARDINALITY", "worker.bindings", "cardinality");

  const mappingCanary = structuredClone(mapping); mappingCanary.resources.HYPERDRIVE.id = canaries.hyperdriveId;
  expect("postgres-mapping-hyperdrive-id", () => validatePostgresManifest(manifest, mappingCanary), "RESOURCE_MISMATCH", "resources.HYPERDRIVE.id", "resource-identity-mismatch");
  const rendered = [];
  for (const fn of [...canaryCases.map(([, caseFn]) => caseFn), () => validatePostgresManifest(manifest, mappingCanary)]) {
    try { fn(); throw new Error("canary unexpectedly passed"); } catch (error) {
      if (!(error instanceof CompositionDiagnostic)) throw error;
      rendered.push(JSON.stringify(error.diagnostic), error.message, String(error.stack));
    }
  }
  rendered.push(JSON.stringify(envelope), JSON.stringify(publishedPayload(manifest)), jcs(publishedPayload(manifest)));
  const text = rendered.join("\n");
  for (const value of [...Object.values(canaries), mapping.resources.HYPERDRIVE.id]) if (text.includes(value)) throw new Error("postgres canary or raw identity leaked");
  return envelope;
}

function main() {
  const write = process.argv.includes("--write");
  if (write) {
    writeFileSync(join(root, generatedPath), generateSource(loadManifest()));
    copyCore();
  }
  if (process.argv.includes("--check")) checkTemplateCore();
  if (process.argv.includes("--self-test") || process.argv.includes("--check")) process.stdout.write(`${JSON.stringify(runSelfTest())}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
