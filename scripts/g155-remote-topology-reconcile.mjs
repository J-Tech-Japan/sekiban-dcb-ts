import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CompositionDiagnostic,
  loadManifest,
  loadMapping,
  validateManifest,
} from "./g34-provider-composition.mjs";
import { parseJsonc } from "./lib/offline-provider-validation.mjs";

// Offline declared-to-remote Queue consumer reconcile gate for the
// meeting-room-cloudflare profile. The declared work-queue consumers come from
// the provider composition; the remote side is an operator-supplied,
// queue-bound snapshot {"queue", "consumers"}. The comparison is an exact set.
// A bundle snapshot {"queues": [two envelopes]} also checks the dead-letter
// queue consumer set (declared from the same composition), bound by queue name.
// Each work-queue row must also carry dead_letter_queue equal to the mapped
// dead-letter queue, checked after the set compare; dead-letter queue rows are
// not field-checked.
// This gate never contacts the provider: the live-fetch flag only refuses.
// The frozen g34 queue-topology predicate is a separate, hard-coded neighbour
// (it rejects extra row fields; this gate tolerates other extra row fields) and is not called.

export const PROFILE_ID = "meeting-room-cloudflare";
export const WORK_QUEUE_RESOURCE_ID = "work-queue";
export const DLQ_RESOURCE_ID = "dlq-queue";
export const CONSUMER_EDGE_KIND = "consumer-attachment";
export const IDENTITY_ALIASES = Object.freeze(["script", "worker", "name"]);
export const LIVE_FETCH_FLAG = "--fetch-live";
export const LIVE_FETCH_REFUSAL =
  "--fetch-live is refused: no network request was attempted and live remote reconciliation remains open.";

export const REASONS = Object.freeze({
  USAGE: "usage",
  LIVE_FETCH_REFUSED: "live-fetch-refused",
  MISSING_SNAPSHOT: "missing-snapshot",
  REMOTE_SHAPE: "remote-shape",
  REMOTE_QUEUE_MISMATCH: "remote-queue-mismatch",
  REMOTE_IDENTITY: "remote-identity",
  REMOTE_CARDINALITY: "remote-cardinality",
  MISSING_REMOTE: "missing-remote",
  UNDECLARED_REMOTE: "undeclared-remote",
  INTERNAL: "internal",
});

const INTERNAL_LINE = JSON.stringify({ code: "INTERNAL", path: "-", reason: REASONS.INTERNAL });

export class RemoteTopologyDiagnostic extends Error {
  constructor(code) {
    super(code);
    this.name = "RemoteTopologyDiagnostic";
  }
}

class SelfTestFailure extends Error {
  constructor(id) {
    super(`self-test failed: ${id}`);
    this.name = "SelfTestFailure";
    this.mutationId = id;
  }
}

function fail(code, path) {
  if (!Object.hasOwn(REASONS, code)) throw new Error("g155 code is not in the finite set");
  const error = new RemoteTopologyDiagnostic(code);
  error.diagnostic = Object.freeze({ code, path, reason: REASONS[code] });
  throw error;
}

function isDiagnostic(error) {
  return error instanceof RemoteTopologyDiagnostic || error instanceof CompositionDiagnostic;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Pure: workerNames of components with a consumer-attachment edge to the given
// queue resource; sorted and unique. An absent resource is an internal fault,
// never an empty set. No loader and no validateManifest here.
export function declaredConsumersFor(manifest, resourceId) {
  if (!manifest.resources.some((resource) => resource.id === resourceId)) fail("INTERNAL", "-");
  const fromIds = new Set(manifest.edges.filter((edge) => edge.kind === CONSUMER_EDGE_KIND && edge.to === resourceId).map((edge) => edge.from));
  const names = manifest.components.filter((component) => fromIds.has(component.id)).map((component) => component.workerName);
  return [...new Set(names)].sort();
}

export function declaredConsumers(manifest) {
  return declaredConsumersFor(manifest, WORK_QUEUE_RESOURCE_ID);
}

export function readSnapshot(path) {
  return readFileSync(path, "utf8");
}

export const defaultDeps = Object.freeze({ loadManifest, loadMapping, validateManifest, readSnapshot });

function checkArgv(argv) {
  if (argv.some((value) => value === LIVE_FETCH_FLAG || String(value).startsWith(`${LIVE_FETCH_FLAG}=`))) fail("LIVE_FETCH_REFUSED", "argv");
  if (argv.length === 1 && argv[0] === "--self-test") return { mode: "self-test" };
  if (argv.length === 2 && argv[0] === "--remote-snapshot" && typeof argv[1] === "string" && argv[1].length > 0 && !argv[1].startsWith("--")) {
    return { mode: "snapshot", snapshotPath: argv[1] };
  }
  fail("USAGE", "argv");
}

function loadComposition(deps) {
  const manifest = deps.loadManifest();
  const mapping = deps.loadMapping();
  deps.validateManifest(manifest, mapping);
  return {
    declared: declaredConsumers(manifest),
    queue: mapping.resources.DOWNSTREAM_QUEUE.consumerQueue,
    dlqDeclared: declaredConsumersFor(manifest, DLQ_RESOURCE_ID),
    dlqQueue: mapping.resources.DOWNSTREAM_QUEUE.dead_letter_queue,
  };
}

function readSnapshotText(deps, snapshotPath) {
  try {
    const text = deps.readSnapshot(snapshotPath);
    if (typeof text !== "string") fail("REMOTE_SHAPE", "snapshot");
    return text;
  } catch (error) {
    if (error instanceof RemoteTopologyDiagnostic) throw error;
    if (error?.code === "ENOENT") fail("MISSING_SNAPSHOT", "snapshot");
    fail("REMOTE_SHAPE", "snapshot");
  }
}

function parseSnapshot(text) {
  // The shared core reports duplicate keys with input-key paths and parse
  // failures with engine detail; neither record is forwarded.
  try {
    return parseJsonc(text, "snapshot", () => fail("REMOTE_SHAPE", "snapshot"));
  } catch (error) {
    if (error instanceof RemoteTopologyDiagnostic) throw error;
    fail("REMOTE_SHAPE", "snapshot");
  }
}

const ENVELOPE_KEYS = JSON.stringify(["consumers", "queue"]);
const BUNDLE_KEYS = JSON.stringify(["queues"]);

// Exact top-level key set only: consumers+queue is single, queues alone is a
// bundle, anything else is a shape fault at the snapshot.
export function classifySnapshot(snapshot) {
  if (!isPlainObject(snapshot)) fail("REMOTE_SHAPE", "snapshot");
  const keys = JSON.stringify(Object.keys(snapshot).sort());
  if (keys === ENVELOPE_KEYS) return "single";
  if (keys === BUNDLE_KEYS) return "bundle";
  fail("REMOTE_SHAPE", "snapshot");
}

function checkEnvelope(snapshot, mappedQueue) {
  if (typeof snapshot.queue !== "string" || snapshot.queue.length === 0) fail("REMOTE_SHAPE", "queue");
  if (!Array.isArray(snapshot.consumers)) fail("REMOTE_SHAPE", "consumers");
  if (snapshot.queue !== mappedQueue) fail("REMOTE_QUEUE_MISMATCH", "queue");
  return snapshot.consumers;
}

// Every element's shape is checked, in array order, before any name bind.
function checkBundleShape(snapshot) {
  const { queues } = snapshot;
  if (!Array.isArray(queues) || queues.length !== 2) fail("REMOTE_SHAPE", "queues");
  for (const [index, element] of queues.entries()) {
    if (!isPlainObject(element) || JSON.stringify(Object.keys(element).sort()) !== ENVELOPE_KEYS) fail("REMOTE_SHAPE", `queues/${index}`);
    if (typeof element.queue !== "string" || element.queue.length === 0) fail("REMOTE_SHAPE", `queues/${index}/queue`);
    if (!Array.isArray(element.consumers)) fail("REMOTE_SHAPE", `queues/${index}/consumers`);
  }
  return queues;
}

// Binds shape-valid envelopes to the work and DLQ roles by mapped queue name,
// in array order. Remote names are compared, never echoed.
export function bindBundle(envelopes, names) {
  const roles = new Map([
    [names.queue, "work"],
    [names.dlqQueue, "dlq"],
  ]);
  const bound = {};
  for (const [index, envelope] of envelopes.entries()) {
    const role = roles.get(envelope.queue);
    if (role === undefined) fail("REMOTE_QUEUE_MISMATCH", `queues/${index}/queue`);
    if (Object.hasOwn(bound, role)) fail("REMOTE_CARDINALITY", `queues/${index}/queue`);
    bound[role] = envelope;
  }
  if (!Object.hasOwn(bound, "work") || !Object.hasOwn(bound, "dlq")) fail("MISSING_REMOTE", "queues");
  return { work: bound.work, dlq: bound.dlq };
}

function rowIdentities(consumers, prefix) {
  const identities = [];
  for (const [index, row] of consumers.entries()) {
    if (!isPlainObject(row)) fail("REMOTE_SHAPE", `${prefix}/${index}`);
    const present = IDENTITY_ALIASES.filter((alias) => Object.hasOwn(row, alias));
    if (present.length === 0) fail("UNDECLARED_REMOTE", `${prefix}/${index}`);
    for (const alias of present) {
      if (typeof row[alias] !== "string" || row[alias].length === 0) fail("REMOTE_IDENTITY", `${prefix}/${index}/${alias}`);
    }
    const identity = row[present[0]];
    if (present.some((alias) => row[alias] !== identity)) fail("REMOTE_IDENTITY", `${prefix}/${index}`);
    identities.push(identity);
  }
  return identities;
}

function compareSets(identities, declared, prefix) {
  const seen = new Set();
  for (const [index, identity] of identities.entries()) {
    if (seen.has(identity)) fail("REMOTE_CARDINALITY", `${prefix}/${index}`);
    seen.add(identity);
  }
  if (declared.some((name) => !seen.has(name))) fail("MISSING_REMOTE", prefix);
  const declaredSet = new Set(declared);
  const undeclared = identities.findIndex((identity) => !declaredSet.has(identity));
  if (undeclared !== -1) fail("UNDECLARED_REMOTE", `${prefix}/${undeclared}`);
}

function reconcile(consumers, declared, prefix) {
  compareSets(rowIdentities(consumers, prefix), declared, prefix);
}

// Work-queue envelope only, after the identity set compare. Values are
// compared, never echoed. The DLQ envelope is never passed here.
export function checkWorkDeadLetterFields(consumers, expectedDlq, prefix) {
  for (const [index, row] of consumers.entries()) {
    const path = `${prefix}/${index}/dead_letter_queue`;
    if (!Object.hasOwn(row, "dead_letter_queue")) fail("REMOTE_IDENTITY", path);
    const value = row.dead_letter_queue;
    if (typeof value !== "string" || value.length === 0) fail("REMOTE_IDENTITY", path);
    if (value !== expectedDlq) fail("REMOTE_IDENTITY", path);
  }
}

// Single entry. Stages: 1 flags, 2 composition load, 3 snapshot read,
// 4 classify; single: envelope and queue bind, then rows, duplicate
// identities, set compare, then each row's dead_letter_queue field. Bundle:
// length, per-index shape, name bind, then the work-queue envelope fully
// (rows, set compare, dead_letter_queue field) before the DLQ envelope, which
// stops after its set compare.
export function run(argv, deps = defaultDeps) {
  const invocation = checkArgv(argv);
  if (invocation.mode === "self-test") return runSelfTest();
  const composition = loadComposition(deps);
  const snapshot = parseSnapshot(readSnapshotText(deps, invocation.snapshotPath));
  if (classifySnapshot(snapshot) === "single") {
    const consumers = checkEnvelope(snapshot, composition.queue);
    reconcile(consumers, composition.declared, "consumers");
    checkWorkDeadLetterFields(consumers, composition.dlqQueue, "consumers");
    return { result: "ok", profileId: PROFILE_ID, queue: composition.queue, declared: composition.declared, remoteConsumers: consumers.length };
  }
  const { work, dlq } = bindBundle(checkBundleShape(snapshot), composition);
  reconcile(work.consumers, composition.declared, "work-queue/consumers");
  checkWorkDeadLetterFields(work.consumers, composition.dlqQueue, "work-queue/consumers");
  reconcile(dlq.consumers, composition.dlqDeclared, "dlq/consumers");
  return {
    result: "ok",
    profileId: PROFILE_ID,
    mode: "bundle",
    queues: {
      "work-queue": { queue: composition.queue, declared: composition.declared, remoteConsumers: work.consumers.length },
      dlq: { queue: composition.dlqQueue, declared: composition.dlqDeclared, remoteConsumers: dlq.consumers.length },
    },
  };
}

const CANARIES = Object.freeze({
  remoteScript: "g155-canary-remote-script",
  fieldValue: "g155-canary-field-value",
  key: "g155-canary-key",
  malformed: "g155-canary-malformed",
  file: "g155-canary-file",
  queue: "g155-canary-queue",
  token: "g155-canary-token",
  workerName: "g155-canary-worker-name",
  bundleUnknownQueue: "g155-canary-bundle-queue",
  dlqStaleScript: "g155-canary-dlq-script",
});

const ALLOWED_IMPORTS = ["./g34-provider-composition.mjs", "./lib/offline-provider-validation.mjs", "node:fs", "node:path", "node:url"];

function selfScan() {
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  for (const needle of ["child_" + "process", "fet" + "ch(", "wran" + "gler", "htt" + "ps:"]) {
    if (source.includes(needle)) throw new SelfTestFailure("self-scan");
  }
  const imports = [...source.matchAll(/^import[\s\S]*?from "([^"]+)";$/gm)].map((match) => match[1]).sort();
  if (JSON.stringify(imports) !== JSON.stringify(ALLOWED_IMPORTS)) throw new SelfTestFailure("self-scan-imports");
}

function spyDeps(calls) {
  const spy = (name) => () => {
    calls.push(name);
    throw new Error("g155 spy dependency must not run");
  };
  return { loadManifest: spy("loadManifest"), loadMapping: spy("loadMapping"), validateManifest: spy("validateManifest"), readSnapshot: spy("readSnapshot") };
}

export function runSelfTest() {
  const forceFailure = process.env.SDT_G155_FORCE_FAILURE === "1";
  const baseManifest = loadManifest();
  const baseMapping = loadMapping();
  validateManifest(baseManifest, baseMapping);
  const declared = declaredConsumers(baseManifest);
  const dlqDeclared = declaredConsumersFor(baseManifest, DLQ_RESOURCE_ID);
  const queue = baseMapping.resources.DOWNSTREAM_QUEUE.consumerQueue;
  const dlqQueue = baseMapping.resources.DOWNSTREAM_QUEUE.dead_letter_queue;
  if (JSON.stringify(declared) !== JSON.stringify(["sekiban-dcb-meeting-room-cloudflare-only"])) throw new SelfTestFailure("declared-set");
  if (JSON.stringify(dlqDeclared) !== JSON.stringify([])) throw new SelfTestFailure("declared-set");
  const [worker] = declared;

  const mutations = [];
  const rendered = [];
  const envelope = (consumers, extra = {}) => JSON.stringify({ queue, consumers, ...extra });
  const snapshotDeps = (text, overrides = {}) => ({
    loadManifest: () => structuredClone(baseManifest),
    loadMapping: () => structuredClone(baseMapping),
    validateManifest,
    readSnapshot: () => text,
    ...overrides,
  });
  const snapshotArgv = ["--remote-snapshot", `/tmp/${CANARIES.file}.json`];

  const expectOk = (id, fn) => {
    let result;
    try {
      result = fn();
    } catch (error) {
      if (!isDiagnostic(error)) throw error;
      rendered.push(JSON.stringify(error.diagnostic), error.message, String(error.stack));
      throw new SelfTestFailure(id);
    }
    if (result?.result !== "ok" || JSON.stringify(result.declared) !== JSON.stringify(declared) || result.queue !== queue) throw new SelfTestFailure(id);
    rendered.push(JSON.stringify(result));
    mutations.push(id);
    return result;
  };
  // Bundle success: exact line built from the mapping and the composition only.
  const expectedBundle = JSON.stringify({
    result: "ok",
    profileId: PROFILE_ID,
    mode: "bundle",
    queues: {
      "work-queue": { queue, declared, remoteConsumers: 1 },
      dlq: { queue: dlqQueue, declared: dlqDeclared, remoteConsumers: 0 },
    },
  });
  const expectBundleOk = (id, fn) => {
    let result;
    try {
      result = fn();
    } catch (error) {
      if (!isDiagnostic(error)) throw error;
      rendered.push(JSON.stringify(error.diagnostic), error.message, String(error.stack));
      throw new SelfTestFailure(id);
    }
    const line = JSON.stringify(result);
    if (line !== expectedBundle || line.includes('"dead_letter_queue"')) throw new SelfTestFailure(id);
    rendered.push(line);
    mutations.push(id);
    return result;
  };
  const expectFail = (id, fn, code, path) => {
    let failures = 0;
    let caught;
    try {
      fn();
    } catch (error) {
      failures += 1;
      caught = error;
    }
    if (failures !== 1 || !isDiagnostic(caught)) throw new SelfTestFailure(id);
    const { diagnostic } = caught;
    const reason = caught instanceof CompositionDiagnostic ? diagnostic.reason : REASONS[code];
    if (diagnostic.code !== code || diagnostic.path !== path || diagnostic.reason !== reason) throw new SelfTestFailure(id);
    if (Object.keys(diagnostic).sort().join(",") !== "code,path,reason") throw new SelfTestFailure(id);
    rendered.push(JSON.stringify(diagnostic), caught.message, String(caught.stack));
    mutations.push(id);
    return diagnostic;
  };
  const viaSnapshot = (text, overrides) => () => run(snapshotArgv, snapshotDeps(text, overrides));

  const green = envelope([{ script: worker, dead_letter_queue: dlqQueue }]);
  const staleExtra = envelope([{ script: worker }, { script: CANARIES.remoteScript }]);

  // Bundle envelopes: W is the green work-queue envelope (its row names the
  // mapped dead-letter queue), D the green DLQ one.
  const W = { queue, consumers: [{ script: worker, dead_letter_queue: dlqQueue }] };
  const D = { queue: dlqQueue, consumers: [] };
  const bundle = (...queues) => JSON.stringify({ queues });
  const workWith = (consumers) => ({ queue, consumers });
  const dlqWith = (consumers) => ({ queue: dlqQueue, consumers });
  const workStaleExtra = workWith([{ script: worker }, { script: CANARIES.remoteScript }]);
  const dlqStaleExtra = bundle(W, dlqWith([{ script: CANARIES.dlqStaleScript }]));

  // Green rows. With SDT_G155_FORCE_FAILURE=1 the bundle green row runs first
  // and is fed a bundle whose DLQ envelope holds a stale script while still
  // expecting success, so the bundle comparison itself fails. The single green
  // row keeps its stale-extra injection if it is ever reached.
  if (forceFailure) expectBundleOk("green-bundle", viaSnapshot(dlqStaleExtra));
  expectOk("green", viaSnapshot(forceFailure ? staleExtra : green));
  expectOk("green-extra-fields", viaSnapshot(envelope([{ script: worker, dead_letter_queue: dlqQueue, type: "worker", settings: { batch_size: 10, note: CANARIES.fieldValue }, [CANARIES.key]: CANARIES.fieldValue }])));
  expectOk("green-aliases", viaSnapshot(envelope([{ script: worker, worker, name: worker, dead_letter_queue: dlqQueue }])));
  if (!forceFailure) expectBundleOk("green-bundle", viaSnapshot(bundle(W, D)));
  expectBundleOk("green-bundle-reversed", viaSnapshot(bundle(D, W)));
  expectBundleOk("green-bundle-extra-fields", viaSnapshot(bundle(workWith([{ script: worker, dead_letter_queue: dlqQueue, max_retries: 3, settings: { note: CANARIES.fieldValue }, [CANARIES.key]: CANARIES.fieldValue }]), D)));

  // Pinned mutants, each built from the green envelope with one cause.
  expectFail("wrong-queue", viaSnapshot(JSON.stringify({ queue: CANARIES.queue, consumers: [{ script: worker }] })), "REMOTE_QUEUE_MISMATCH", "queue");
  expectFail("empty-consumers", viaSnapshot(envelope([])), "MISSING_REMOTE", "consumers");
  expectFail("replaced", viaSnapshot(envelope([{ script: CANARIES.remoteScript }])), "MISSING_REMOTE", "consumers");
  expectFail("stale-extra", viaSnapshot(staleExtra), "UNDECLARED_REMOTE", "consumers/1");
  expectFail("duplicate", viaSnapshot(envelope([{ script: worker }, { script: worker }])), "REMOTE_CARDINALITY", "consumers/1");
  expectFail("alias-conflict", viaSnapshot(envelope([{ script: worker, worker: CANARIES.remoteScript }])), "REMOTE_IDENTITY", "consumers/0");
  expectFail("script-empty", viaSnapshot(envelope([{ script: "" }])), "REMOTE_IDENTITY", "consumers/0/script");
  expectFail("script-number", viaSnapshot(envelope([{ script: 42 }])), "REMOTE_IDENTITY", "consumers/0/script");
  expectFail("http-pull", viaSnapshot(envelope([{ type: "http_pull" }])), "UNDECLARED_REMOTE", "consumers/0");
  expectFail("http-pull-then-number", viaSnapshot(envelope([{ type: "http_pull" }, 42])), "UNDECLARED_REMOTE", "consumers/0");
  expectFail("number-then-http-pull", viaSnapshot(envelope([42, { type: "http_pull" }])), "REMOTE_SHAPE", "consumers/0");
  expectFail("array-row", viaSnapshot(envelope([[]])), "REMOTE_SHAPE", "consumers/0");
  expectFail("bare-array", viaSnapshot(JSON.stringify([{ script: worker }])), "REMOTE_SHAPE", "snapshot");
  expectFail("envelope-extra-key", viaSnapshot(envelope([{ script: worker }], { [CANARIES.key]: CANARIES.fieldValue })), "REMOTE_SHAPE", "snapshot");
  expectFail("queue-missing", viaSnapshot(JSON.stringify({ consumers: [{ script: worker }] })), "REMOTE_SHAPE", "snapshot");
  expectFail("consumers-not-array", viaSnapshot(JSON.stringify({ queue, consumers: {} })), "REMOTE_SHAPE", "consumers");
  expectFail("duplicate-key", viaSnapshot(`{"queue":${JSON.stringify(queue)},"consumers":[{"script":${JSON.stringify(worker)},"${CANARIES.key}":"${CANARIES.fieldValue}","${CANARIES.key}":2}]}`), "REMOTE_SHAPE", "snapshot");
  expectFail("malformed", viaSnapshot(`not json ${CANARIES.malformed}`), "REMOTE_SHAPE", "snapshot");
  const enoent = () => {
    const error = new Error(`ENOENT: no such file or directory, open '/tmp/${CANARIES.file}.json'`);
    error.code = "ENOENT";
    throw error;
  };
  expectFail("missing-snapshot", viaSnapshot("", { readSnapshot: enoent }), "MISSING_SNAPSHOT", "snapshot");
  const renamedManifest = () => {
    const copy = structuredClone(baseManifest);
    copy.components[0].workerName = CANARIES.workerName;
    return copy;
  };
  expectFail("cli-worker-name", viaSnapshot(green, { loadManifest: renamedManifest }), "CARDINALITY", "worker.workerName");

  // Bundle classification, length and per-index shape (before any bind).
  expectFail("bundle-mixed-keys", viaSnapshot(JSON.stringify({ queue, consumers: [{ script: worker }], queues: [W, D] })), "REMOTE_SHAPE", "snapshot");
  expectFail("bundle-queues-not-array", viaSnapshot(JSON.stringify({ queues: {} })), "REMOTE_SHAPE", "queues");
  expectFail("bundle-empty", viaSnapshot(bundle()), "REMOTE_SHAPE", "queues");
  expectFail("bundle-one", viaSnapshot(bundle(W)), "REMOTE_SHAPE", "queues");
  expectFail("bundle-three", viaSnapshot(bundle(W, D, D)), "REMOTE_SHAPE", "queues");
  expectFail("bundle-element-not-object", viaSnapshot(bundle(W, 42)), "REMOTE_SHAPE", "queues/1");
  expectFail("bundle-element-extra-key", viaSnapshot(bundle(W, { ...D, [CANARIES.key]: CANARIES.fieldValue })), "REMOTE_SHAPE", "queues/1");
  expectFail("bundle-element-queue-empty", viaSnapshot(bundle({ queue: "", consumers: [] }, D)), "REMOTE_SHAPE", "queues/0/queue");
  expectFail("bundle-element-consumers-not-array", viaSnapshot(bundle(W, dlqWith({}))), "REMOTE_SHAPE", "queues/1/consumers");
  // Name bind.
  expectFail("bundle-unknown-queue", viaSnapshot(bundle(W, { queue: CANARIES.bundleUnknownQueue, consumers: [] })), "REMOTE_QUEUE_MISMATCH", "queues/1/queue");
  expectFail("bundle-single-queue-name", viaSnapshot(bundle(W, W)), "REMOTE_CARDINALITY", "queues/1/queue");
  expectFail("bundle-dlq-twice", viaSnapshot(bundle(D, D)), "REMOTE_CARDINALITY", "queues/1/queue");
  // Defensive guard: not reachable through run (exactly two elements), so the
  // exported bind helper is called in process with one shape-valid envelope.
  expectFail("bind-missing-role", () => bindBundle([structuredClone(W)], { queue, dlqQueue }), "MISSING_REMOTE", "queues");
  // Work-queue envelope after bind.
  expectFail("bundle-work-stale", viaSnapshot(bundle(workStaleExtra, D)), "UNDECLARED_REMOTE", "work-queue/consumers/1");
  expectFail("bundle-work-empty", viaSnapshot(bundle(workWith([]), D)), "MISSING_REMOTE", "work-queue/consumers");
  expectFail("bundle-work-duplicate", viaSnapshot(bundle(workWith([{ script: worker }, { script: worker }]), D)), "REMOTE_CARDINALITY", "work-queue/consumers/1");
  expectFail("bundle-work-identity", viaSnapshot(bundle(workWith([{ script: 42 }]), D)), "REMOTE_IDENTITY", "work-queue/consumers/0/script");
  // DLQ envelope after bind: declared set is empty.
  expectFail("dlq-stale-extra", viaSnapshot(dlqStaleExtra), "UNDECLARED_REMOTE", "dlq/consumers/0");
  expectFail("dlq-work-worker", viaSnapshot(bundle(W, dlqWith([{ script: worker }]))), "UNDECLARED_REMOTE", "dlq/consumers/0");
  expectFail("dlq-http-pull", viaSnapshot(bundle(W, dlqWith([{ type: "http_pull" }]))), "UNDECLARED_REMOTE", "dlq/consumers/0");
  expectFail("dlq-duplicate", viaSnapshot(bundle(W, dlqWith([{ script: CANARIES.dlqStaleScript }, { script: CANARIES.dlqStaleScript }]))), "REMOTE_CARDINALITY", "dlq/consumers/1");
  expectFail("dlq-identity", viaSnapshot(bundle(W, dlqWith([{ script: 42 }]))), "REMOTE_IDENTITY", "dlq/consumers/0/script");
  expectFail("dlq-row-shape", viaSnapshot(bundle(W, dlqWith([42]))), "REMOTE_SHAPE", "dlq/consumers/0");
  // Post-bind double faults report the work queue in both array orders.
  const dlqStale = dlqWith([{ script: CANARIES.dlqStaleScript }]);
  expectFail("double-fault-work-first", viaSnapshot(bundle(workStaleExtra, dlqStale)), "UNDECLARED_REMOTE", "work-queue/consumers/1");
  expectFail("double-fault-dlq-first", viaSnapshot(bundle(dlqStale, workStaleExtra)), "UNDECLARED_REMOTE", "work-queue/consumers/1");
  expectFail("double-fault-rows-dlq-first", viaSnapshot(bundle(dlqWith([42]), workWith([{ script: 42 }]))), "REMOTE_IDENTITY", "work-queue/consumers/0/script");
  // Pre-bind shape faults follow array index order.
  expectFail("prebind-index-order", viaSnapshot(bundle(dlqWith({}), workWith({}))), "REMOTE_SHAPE", "queues/0/consumers");
  expectFail("prebind-shape-beats-work-rows", viaSnapshot(bundle(dlqWith({}), workStaleExtra)), "REMOTE_SHAPE", "queues/0/consumers");
  expectFail("prebind-shape-beats-bind", viaSnapshot(bundle({ queue: CANARIES.bundleUnknownQueue, consumers: [] }, workWith({}))), "REMOTE_SHAPE", "queues/1/consumers");
  // Bundle text faults.
  expectFail("bundle-duplicate-key", viaSnapshot(`{"queues":[${JSON.stringify(W)},{"queue":${JSON.stringify(dlqQueue)},"consumers":[],"${CANARIES.key}":"${CANARIES.fieldValue}","${CANARIES.key}":2}]}`), "REMOTE_SHAPE", "snapshot");
  expectFail("bundle-malformed", viaSnapshot(`{"queues":[${CANARIES.malformed}`), "REMOTE_SHAPE", "snapshot");

  // Work-queue dead_letter_queue field, checked after the set compare. Wrong
  // values are canaries, so the redaction scan proves they are never echoed.
  const fv = CANARIES.fieldValue;
  const fieldRow = (value) => [{ script: worker, dead_letter_queue: value }];
  const W0 = workWith([{ script: worker }]);
  const singleFieldPath = "consumers/0/dead_letter_queue";
  const workFieldPath = "work-queue/consumers/0/dead_letter_queue";
  expectFail("dlq-field-wrong", viaSnapshot(envelope(fieldRow(fv))), "REMOTE_IDENTITY", singleFieldPath);
  expectFail("dlq-field-absent", viaSnapshot(envelope([{ script: worker }])), "REMOTE_IDENTITY", singleFieldPath);
  expectFail("dlq-field-empty", viaSnapshot(envelope(fieldRow(""))), "REMOTE_IDENTITY", singleFieldPath);
  expectFail("dlq-field-non-string", viaSnapshot(envelope(fieldRow(42))), "REMOTE_IDENTITY", singleFieldPath);
  expectFail("dlq-field-null", viaSnapshot(envelope(fieldRow(null))), "REMOTE_IDENTITY", singleFieldPath);
  expectFail("dlq-field-array", viaSnapshot(envelope(fieldRow([fv]))), "REMOTE_IDENTITY", singleFieldPath);
  expectFail("dlq-field-work-queue-name", viaSnapshot(envelope(fieldRow(queue))), "REMOTE_IDENTITY", singleFieldPath);
  expectFail("bundle-dlq-field-wrong", viaSnapshot(bundle(workWith(fieldRow(fv)), D)), "REMOTE_IDENTITY", workFieldPath);
  expectFail("bundle-dlq-field-absent", viaSnapshot(bundle(W0, D)), "REMOTE_IDENTITY", workFieldPath);
  expectFail("bundle-dlq-field-non-string", viaSnapshot(bundle(workWith(fieldRow(42)), D)), "REMOTE_IDENTITY", workFieldPath);
  expectFail("bundle-reversed-dlq-field-absent", viaSnapshot(bundle(D, W0)), "REMOTE_IDENTITY", workFieldPath);
  // Row, duplicate and set faults precede the field pass.
  expectFail("field-vs-identity", viaSnapshot(envelope([{ script: worker }, { script: 42 }])), "REMOTE_IDENTITY", "consumers/1/script");
  expectFail("field-vs-row-shape", viaSnapshot(envelope([...fieldRow(fv), 42])), "REMOTE_SHAPE", "consumers/1");
  expectFail("field-vs-duplicate", viaSnapshot(envelope([...fieldRow(fv), ...fieldRow(dlqQueue)])), "REMOTE_CARDINALITY", "consumers/1");
  expectFail("field-vs-missing", viaSnapshot(envelope([{ script: CANARIES.remoteScript, dead_letter_queue: fv }])), "MISSING_REMOTE", "consumers");
  expectFail("field-vs-undeclared", viaSnapshot(envelope([...fieldRow(fv), { script: CANARIES.remoteScript }])), "UNDECLARED_REMOTE", "consumers/1");
  expectFail("bundle-field-vs-identity", viaSnapshot(bundle(workWith([{ script: worker }, { script: 42 }]), D)), "REMOTE_IDENTITY", "work-queue/consumers/1/script");
  expectFail("bundle-field-vs-duplicate", viaSnapshot(bundle(workWith([...fieldRow(fv), ...fieldRow(dlqQueue)]), D)), "REMOTE_CARDINALITY", "work-queue/consumers/1");
  // Pre-bind shape and bind faults precede the field pass.
  expectFail("prebind-shape-beats-field", viaSnapshot(bundle(dlqWith({}), W0)), "REMOTE_SHAPE", "queues/0/consumers");
  expectFail("bind-beats-field", viaSnapshot(bundle(W0, { queue: CANARIES.bundleUnknownQueue, consumers: [] })), "REMOTE_QUEUE_MISMATCH", "queues/1/queue");
  // The work envelope (incl. its field) completes before the DLQ envelope, in
  // both array orders.
  expectFail("field-vs-dlq-work-first", viaSnapshot(bundle(workWith(fieldRow(fv)), dlqStale)), "REMOTE_IDENTITY", workFieldPath);
  expectFail("field-vs-dlq-dlq-first", viaSnapshot(bundle(dlqStale, workWith(fieldRow(fv)))), "REMOTE_IDENTITY", workFieldPath);
  expectFail("field-vs-dlq-shape-dlq-first", viaSnapshot(bundle(dlqWith([42]), W0)), "REMOTE_IDENTITY", workFieldPath);

  // DLQ rows are not field-checked. With the real (empty) declared DLQ set any
  // DLQ row fails the set compare first, so an unvalidated manifest copy
  // attaches the worker to the DLQ and the success line is compared exactly.
  const dlqAttachedManifest = () => {
    const copy = structuredClone(baseManifest);
    copy.edges.push({ kind: CONSUMER_EDGE_KIND, from: "worker", to: DLQ_RESOURCE_ID });
    return copy;
  };
  const expectedExemptBundle = JSON.stringify({
    result: "ok",
    profileId: PROFILE_ID,
    mode: "bundle",
    queues: {
      "work-queue": { queue, declared, remoteConsumers: 1 },
      dlq: { queue: dlqQueue, declared: [worker], remoteConsumers: 1 },
    },
  });
  const expectExempt = (id, dlqRow) => {
    let result;
    try {
      result = run(snapshotArgv, snapshotDeps(bundle(W, dlqWith([dlqRow])), { loadManifest: dlqAttachedManifest, validateManifest: () => {} }));
    } catch (error) {
      if (!isDiagnostic(error)) throw error;
      rendered.push(JSON.stringify(error.diagnostic), error.message, String(error.stack));
      throw new SelfTestFailure(id);
    }
    const line = JSON.stringify(result);
    if (line !== expectedExemptBundle || line.includes('"dead_letter_queue"')) throw new SelfTestFailure(id);
    rendered.push(line);
    mutations.push(id);
  };
  expectExempt("dlq-rows-field-exempt-absent", { script: worker });
  expectExempt("dlq-rows-field-exempt-wrong", { script: worker, dead_letter_queue: fv });

  // Field pass in process: the only proof of left-to-right order across rows.
  expectFail("field-pass-left-to-right", () => checkWorkDeadLetterFields([{ script: "a", dead_letter_queue: dlqQueue }, { script: "b" }], dlqQueue, "consumers"), "REMOTE_IDENTITY", "consumers/1/dead_letter_queue");
  expectFail("field-pass-first-fault", () => checkWorkDeadLetterFields([{ script: "a", dead_letter_queue: fv }, { script: "b" }], dlqQueue, "consumers"), "REMOTE_IDENTITY", "consumers/0/dead_letter_queue");
  expectFail("field-pass-undefined-expected", () => checkWorkDeadLetterFields([{ script: "a", dead_letter_queue: dlqQueue }], undefined, "consumers"), "REMOTE_IDENTITY", "consumers/0/dead_letter_queue");
  try {
    checkWorkDeadLetterFields([{ script: "a", dead_letter_queue: dlqQueue }], dlqQueue, "consumers");
  } catch {
    throw new SelfTestFailure("field-pass-ok");
  }

  // In-process derivation mutant: an unvalidated copy changes the derived set.
  if (JSON.stringify(declaredConsumers(renamedManifest())) !== JSON.stringify([CANARIES.workerName])) throw new SelfTestFailure("derivation");
  mutations.push("derivation");
  expectFail("dlq-declared-for-unknown", () => declaredConsumersFor(structuredClone(baseManifest), "dlq_queue"), "INTERNAL", "-");
  const dlqAttached = structuredClone(baseManifest);
  dlqAttached.edges.push({ kind: CONSUMER_EDGE_KIND, from: "worker", to: DLQ_RESOURCE_ID });
  if (JSON.stringify(declaredConsumersFor(dlqAttached, DLQ_RESOURCE_ID)) !== JSON.stringify([worker])) throw new SelfTestFailure("dlq-derivation");
  mutations.push("dlq-derivation");
  for (const manifest of [structuredClone(baseManifest), renamedManifest()]) {
    if (JSON.stringify(declaredConsumers(manifest)) !== JSON.stringify(declaredConsumersFor(manifest, WORK_QUEUE_RESOURCE_ID))) throw new SelfTestFailure("work-alias");
  }
  mutations.push("work-alias");

  // Live fetch refusal and usage: no dependency may run.
  const refusalRuns = (id, argv, code, env) => {
    const calls = [];
    const previous = process.env.CLOUDFLARE_API_TOKEN;
    if (env === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = env;
    let result;
    try {
      result = expectFail(id, () => run(argv, spyDeps(calls)), code, "argv");
    } finally {
      if (previous === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = previous;
    }
    if (calls.length !== 0) throw new SelfTestFailure(id);
    return result;
  };
  const fetchLiveCases = [
    ["fetch-live", ["--fetch-live"]],
    ["fetch-live-snapshot", ["--fetch-live", "--remote-snapshot", "x.json"]],
    ["fetch-live-self-test", ["--self-test", "--fetch-live"]],
    ["fetch-live-unknown", ["--bogus", "--fetch-live"]],
    ["fetch-live-as-value", ["--remote-snapshot", "--fetch-live"]],
    ["fetch-live-equals", ["--fetch-live=1"]],
  ];
  for (const [id, argv] of fetchLiveCases) {
    const unset = refusalRuns(id, argv, "LIVE_FETCH_REFUSED", undefined);
    const canary = refusalRuns(`${id}-token`, argv, "LIVE_FETCH_REFUSED", CANARIES.token);
    if (JSON.stringify(unset) !== JSON.stringify(canary)) throw new SelfTestFailure(`${id}-token`);
  }
  const usageCases = [
    ["usage-bare", []],
    ["usage-unknown", ["--bogus"]],
    ["usage-missing-value", ["--remote-snapshot"]],
    ["usage-self-test-snapshot", ["--self-test", "--remote-snapshot", "x.json"]],
    ["usage-repeated", ["--self-test", "--self-test"]],
  ];
  for (const [id, argv] of usageCases) refusalRuns(id, argv, "USAGE", undefined);

  // Redaction: no canary in any diagnostic JSON, message, stack, or success line.
  const text = rendered.join("\n");
  for (const value of Object.values(CANARIES)) {
    if (text.includes(value)) throw new SelfTestFailure("redaction");
  }
  selfScan();
  mutations.push("redaction", "self-scan");

  return { result: "ok", profileId: PROFILE_ID, queue, declared, mutations };
}

function main() {
  try {
    const result = run(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    if (isDiagnostic(error)) {
      process.stderr.write(`${JSON.stringify(error.diagnostic)}\n`);
      if (error.diagnostic.code === "LIVE_FETCH_REFUSED") process.stderr.write(`${LIVE_FETCH_REFUSAL}\n`);
      process.exitCode = error.diagnostic.code === "USAGE" ? 2 : 1;
      return;
    }
    if (error instanceof SelfTestFailure) {
      process.stderr.write(`${INTERNAL_LINE}\n`);
      process.stderr.write(`self-test failed: ${error.mutationId}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${INTERNAL_LINE}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
