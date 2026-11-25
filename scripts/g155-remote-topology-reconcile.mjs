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
// This gate never contacts the provider: the live-fetch flag only refuses.
// The frozen g34 queue-topology predicate is a separate, hard-coded neighbour
// (it rejects extra row fields; this gate tolerates them) and is not called.

export const PROFILE_ID = "meeting-room-cloudflare";
export const WORK_QUEUE_RESOURCE_ID = "work-queue";
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

// Pure: workerNames of components with a consumer-attachment edge to the work
// queue resource; sorted and unique. No loader and no validateManifest here.
export function declaredConsumers(manifest) {
  const queueIds = new Set(manifest.resources.filter((resource) => resource.id === WORK_QUEUE_RESOURCE_ID).map((resource) => resource.id));
  const fromIds = new Set(manifest.edges.filter((edge) => edge.kind === CONSUMER_EDGE_KIND && queueIds.has(edge.to)).map((edge) => edge.from));
  const names = manifest.components.filter((component) => fromIds.has(component.id)).map((component) => component.workerName);
  return [...new Set(names)].sort();
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
  return { declared: declaredConsumers(manifest), queue: mapping.resources.DOWNSTREAM_QUEUE.consumerQueue };
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

function checkEnvelope(snapshot, mappedQueue) {
  if (!isPlainObject(snapshot)) fail("REMOTE_SHAPE", "snapshot");
  if (JSON.stringify(Object.keys(snapshot).sort()) !== JSON.stringify(["consumers", "queue"])) fail("REMOTE_SHAPE", "snapshot");
  if (typeof snapshot.queue !== "string" || snapshot.queue.length === 0) fail("REMOTE_SHAPE", "queue");
  if (!Array.isArray(snapshot.consumers)) fail("REMOTE_SHAPE", "consumers");
  if (snapshot.queue !== mappedQueue) fail("REMOTE_QUEUE_MISMATCH", "queue");
  return snapshot.consumers;
}

function rowIdentities(consumers) {
  const identities = [];
  for (const [index, row] of consumers.entries()) {
    if (!isPlainObject(row)) fail("REMOTE_SHAPE", `consumers/${index}`);
    const present = IDENTITY_ALIASES.filter((alias) => Object.hasOwn(row, alias));
    if (present.length === 0) fail("UNDECLARED_REMOTE", `consumers/${index}`);
    for (const alias of present) {
      if (typeof row[alias] !== "string" || row[alias].length === 0) fail("REMOTE_IDENTITY", `consumers/${index}/${alias}`);
    }
    const identity = row[present[0]];
    if (present.some((alias) => row[alias] !== identity)) fail("REMOTE_IDENTITY", `consumers/${index}`);
    identities.push(identity);
  }
  return identities;
}

function compareSets(identities, declared) {
  const seen = new Set();
  for (const [index, identity] of identities.entries()) {
    if (seen.has(identity)) fail("REMOTE_CARDINALITY", `consumers/${index}`);
    seen.add(identity);
  }
  if (declared.some((name) => !seen.has(name))) fail("MISSING_REMOTE", "consumers");
  const declaredSet = new Set(declared);
  const undeclared = identities.findIndex((identity) => !declaredSet.has(identity));
  if (undeclared !== -1) fail("UNDECLARED_REMOTE", `consumers/${undeclared}`);
}

// Single entry. Stages: 1 flags, 2 composition load, 3 snapshot read,
// 4 envelope and queue bind, 5 row walk, 6 duplicate identities, 7 set compare.
export function run(argv, deps = defaultDeps) {
  const invocation = checkArgv(argv);
  if (invocation.mode === "self-test") return runSelfTest();
  const composition = loadComposition(deps);
  const snapshot = parseSnapshot(readSnapshotText(deps, invocation.snapshotPath));
  const consumers = checkEnvelope(snapshot, composition.queue);
  const identities = rowIdentities(consumers);
  compareSets(identities, composition.declared);
  return { result: "ok", profileId: PROFILE_ID, queue: composition.queue, declared: composition.declared, remoteConsumers: consumers.length };
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
  const queue = baseMapping.resources.DOWNSTREAM_QUEUE.consumerQueue;
  if (JSON.stringify(declared) !== JSON.stringify(["sekiban-dcb-meeting-room-cloudflare-only"])) throw new SelfTestFailure("declared-set");
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

  const green = envelope([{ script: worker }]);
  const staleExtra = envelope([{ script: worker }, { script: CANARIES.remoteScript }]);

  // Green rows. With SDT_G155_FORCE_FAILURE=1 the green row is fed the stale
  // snapshot while still expecting success, so the comparison itself fails.
  expectOk("green", viaSnapshot(forceFailure ? staleExtra : green));
  expectOk("green-extra-fields", viaSnapshot(envelope([{ script: worker, type: "worker", settings: { batch_size: 10, note: CANARIES.fieldValue }, [CANARIES.key]: CANARIES.fieldValue }])));
  expectOk("green-aliases", viaSnapshot(envelope([{ script: worker, worker, name: worker }])));

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

  // In-process derivation mutant: an unvalidated copy changes the derived set.
  if (JSON.stringify(declaredConsumers(renamedManifest())) !== JSON.stringify([CANARIES.workerName])) throw new SelfTestFailure("derivation");
  mutations.push("derivation");

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
