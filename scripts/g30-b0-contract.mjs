#!/usr/bin/env node
/**
 * SDT-G30's B0 contract is intentionally an evidence validator, not a
 * performance evaluator.  It refuses a cohort with loss, replacement, an
 * un-attributed accepted request, or a phase/config change outside the one
 * permitted trace sampling setting.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import manifest from "../contracts/commit-trace-manifest.json" with { type: "json" };
import { verifyExportedSuccessTrace } from "./g30-trace-runtime-verifier.mjs";

export const G30_PHASES = Object.freeze(["A", "B", "A-prime"]);
export const G30_SAMPLE_COUNT = 100;
export const G30_CADENCE_MS = 2_000;
export const G30_EXPORT_DEADLINE_MS = 10 * 60 * 1_000;
export const G30_IDLE_SCHEDULE_MS = Object.freeze([2_000, 15_000, 180_000]);
const OUTLIER_HYPOTHESES = Object.freeze([
  "worker-isolate-first",
  "durable-object-wake",
  "token-rotation",
  "queue-doorbell-backpressure",
]);
const OUTLIER_HYPOTHESIS_SET = new Set(OUTLIER_HYPOTHESES);
const REACTIVATION_CAUSES = new Set(["deployment-correlated", "platform-evidenced", "unknown"]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function fail(code, message) {
  throw new Error(`g30-b0:${code}:${message}`);
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail("string", `${label} must be a non-empty string`);
  return value;
}

function finiteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("number", `${label} must be finite`);
  return value;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function percentile(values, percentileValue) {
  if (!Array.isArray(values) || values.length === 0) fail("percentile", "requires one or more values");
  const ordered = [...values].sort((left, right) => left - right);
  const position = Math.max(0, Math.min(ordered.length - 1, Math.ceil(percentileValue * ordered.length) - 1));
  return ordered[position];
}

export function phaseLatencySummary(records) {
  const values = records.map((record) => finiteNumber(record.responseLatencyMs, "responseLatencyMs"));
  return Object.freeze({
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  });
}

function stableCohortIdentity(record) {
  return {
    serviceId: nonEmptyString(record.serviceId, "serviceId"),
    clientRegion: nonEmptyString(record.clientRegion, "clientRegion"),
    tagSetDigest: nonEmptyString(record.tagSetDigest, "tagSetDigest"),
    payloadDigest: nonEmptyString(record.payloadDigest, "payloadDigest"),
    fixtureVersion: nonEmptyString(record.fixtureVersion, "fixtureVersion"),
  };
}

/**
 * Validates a retained, consecutive window. Failed/non-200/window-reset
 * attempts belong in rawAttempts, never as replacement candidates inside the
 * 100-record window.
 */
export function assertEligiblePhaseWindow(phase, records, rawAttempts = []) {
  if (!G30_PHASES.includes(phase)) fail("phase", `unknown phase ${phase}`);
  if (!Array.isArray(records) || records.length !== G30_SAMPLE_COUNT) {
    fail("window-size", `${phase} requires exactly ${G30_SAMPLE_COUNT} consecutive eligible requests`);
  }
  const ids = new Set();
  let cohort;
  let priorScheduled;
  for (const [index, record] of records.entries()) {
    if (record?.index !== index) fail("window-index", `${phase} request index ${index} is not consecutive`);
    const requestId = nonEmptyString(record?.requestId, `${phase}[${index}].requestId`);
    if (ids.has(requestId)) fail("window-duplicate", `${phase} repeats requestId ${requestId}`);
    ids.add(requestId);
    if (record.status !== 200 || record.eligible !== true || record.nonEmpty !== true || record.replacement === true) {
      fail("window-eligibility", `${phase}[${index}] is not one retained non-empty HTTP-200 request`);
    }
    const identity = stableCohortIdentity(record);
    if (cohort === undefined) cohort = identity;
    else if (!same(cohort, identity)) fail("cohort-drift", `${phase}[${index}] changes service, region, tag, payload, or fixture identity`);
    const scheduled = finiteNumber(record.scheduledStartMs, `${phase}[${index}].scheduledStartMs`);
    const started = finiteNumber(record.startedAtMs, `${phase}[${index}].startedAtMs`);
    const completed = finiteNumber(record.completedAtMs, `${phase}[${index}].completedAtMs`);
    if (completed < started || started < scheduled) fail("request-time", `${phase}[${index}] has an invalid request timeline`);
    finiteNumber(record.responseLatencyMs, `${phase}[${index}].responseLatencyMs`);
    if (priorScheduled !== undefined && scheduled - priorScheduled !== G30_CADENCE_MS) {
      fail("cadence", `${phase}[${index}] scheduled cadence is not exactly ${G30_CADENCE_MS}ms`);
    }
    priorScheduled = scheduled;
  }
  if (!Array.isArray(rawAttempts)) fail("raw-attempts", `${phase} rawAttempts must be an array`);
  for (const attempt of rawAttempts) {
    if (attempt?.windowIndex !== undefined && (!Number.isInteger(attempt.windowIndex) || attempt.windowIndex < 0 || attempt.windowIndex >= G30_SAMPLE_COUNT)) {
      fail("replacement", `${phase} raw attempt illegally maps an outside failure to a retained window index`);
    }
  }
  return Object.freeze({ phase, requestIds: [...ids], cohort, summary: phaseLatencySummary(records) });
}

function configComparable(config) {
  const copy = structuredClone(config);
  if (copy?.observability?.traces !== undefined) delete copy.observability.traces.head_sampling_rate;
  if (copy !== null && typeof copy === "object") delete copy.deployedVersion;
  return copy;
}

/** Only the trace sampling rate and resultant deployed version may differ. */
export function assertPhaseConfiguration(phases) {
  const configurations = G30_PHASES.map((phase) => phases?.[phase]?.configuration);
  if (configurations.some((configuration) => configuration === null || typeof configuration !== "object" || Array.isArray(configuration))) {
    fail("config-shape", "every B0 phase needs a configuration observation");
  }
  const samples = configurations.map((configuration) => configuration.observability?.traces?.head_sampling_rate);
  if (!same(samples, [0, 1, 0])) fail("sampling", "A/B/A-prime trace sampling must be exactly 0/1/0");
  for (const configuration of configurations) {
    if (configuration.observability?.traces?.enabled !== true) fail("traces-enabled", "traces must remain enabled while sampling is toggled");
    if (configuration.placement !== undefined && configuration.placement !== "off") fail("placement", "G30 placement must stay off");
  }
  if (!same(configComparable(configurations[0]), configComparable(configurations[1])) || !same(configComparable(configurations[0]), configComparable(configurations[2]))) {
    fail("config-delta", "B0 phases differ outside trace sampling/deployment version");
  }
  return Object.freeze({ sampling: samples, placement: "off" });
}

function unionDuration(intervals) {
  const ordered = [...intervals].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let total = 0;
  let current;
  for (const interval of ordered) {
    if (current === undefined) { current = [...interval]; continue; }
    if (interval[0] <= current[1]) { current[1] = Math.max(current[1], interval[1]); continue; }
    total += current[1] - current[0]; current = [...interval];
  }
  return total + (current === undefined ? 0 : current[1] - current[0]);
}

/** Recomputes the AC4 union using canonical exported span rows. */
export function unattributedRatioFromTrace(trace) {
  const root = trace?.spans?.find((span) => span?.rowId === "S00");
  if (root === undefined) fail("trace-root", "trace lacks S00");
  const rootStart = finiteNumber(root.startMs, "S00.startMs");
  const rootEnd = finiteNumber(root.endMs, "S00.endMs");
  if (rootEnd < rootStart) fail("trace-time", "S00 ends before it starts");
  const rootDurationMs = rootEnd - rootStart;
  const coverage = new Set(trace.callerCoverageIntervals ?? []);
  const intervals = [];
  for (const span of trace.spans ?? []) {
    if (!coverage.has(span?.rowId)) continue;
    if (span.clockDomain !== "caller" || span.kind === "nested" || span.kind === "fanout-member" || span.emitter === "callee-do") {
      fail("coverage-source", `${span?.rowId} is not eligible caller coverage`);
    }
    const start = Math.max(rootStart, finiteNumber(span.startMs, `${span.rowId}.startMs`));
    const end = Math.min(rootEnd, finiteNumber(span.endMs, `${span.rowId}.endMs`));
    if (end >= start) intervals.push([start, end]);
  }
  const coveredDurationMs = Math.min(rootDurationMs, unionDuration(intervals));
  return Object.freeze({
    rootDurationMs,
    coveredDurationMs,
    unattributedRatio: rootDurationMs === 0 ? 0 : Math.max(0, rootDurationMs - coveredDurationMs) / rootDurationMs,
  });
}

export function assertTraceCohort(ledger, traces, exportCompletedAtMs) {
  if (!Array.isArray(traces) || traces.length !== G30_SAMPLE_COUNT) fail("trace-count", `B requires exactly ${G30_SAMPLE_COUNT} complete exported traces`);
  const ledgerIds = new Set(ledger.map((record) => record.requestId));
  const observed = new Set();
  for (const trace of traces) {
    const requestId = nonEmptyString(trace?.requestId, "trace.requestId");
    if (!ledgerIds.has(requestId) || observed.has(requestId)) fail("trace-join", `trace requestId ${requestId} is missing from or duplicated in the B ledger`);
    observed.add(requestId);
    if (trace.schema !== "sdt.commit/v1" || trace.complete !== true || trace.boundary !== "success" || trace.runtimeVerified !== true) {
      fail("trace-complete", `${requestId} is not a complete sdt.commit/v1 success trace`);
    }
    // A summary flag from the first export pass is not evidence by itself.
    // Re-run the runtime-shaped verifier here so post-export row/attribute
    // edits cannot survive merely by retaining runtimeVerified: true.
    try {
      verifyExportedSuccessTrace(trace);
    } catch (error) {
      fail("trace-runtime", `${requestId} failed re-verification: ${error instanceof Error ? error.message : String(error)}`);
    }
    const ratio = unattributedRatioFromTrace(trace);
    if (ratio.unattributedRatio > 0.05) fail("unattributed", `${requestId} exceeds the 5% attribution budget`);
    if (typeof trace.exportedAtMs !== "number") fail("trace-export", `${requestId} lacks export time`);
  }
  if (observed.size !== ledgerIds.size) fail("trace-loss", `trace loss: ledger=${ledgerIds.size} traces=${observed.size}`);
  const finalRequestAt = Math.max(...ledger.map((record) => finiteNumber(record.completedAtMs, "ledger.completedAtMs")));
  if (finiteNumber(exportCompletedAtMs, "exportCompletedAtMs") > finalRequestAt + G30_EXPORT_DEADLINE_MS) {
    fail("export-deadline", "B trace export exceeded the 10 minute deadline");
  }
  return Object.freeze({ requestCount: observed.size, exportDeadlineMs: finalRequestAt + G30_EXPORT_DEADLINE_MS });
}

export function assertAaaDrift(a, b, aprime) {
  const aSummary = phaseLatencySummary(a);
  const bSummary = phaseLatencySummary(b);
  const primeSummary = phaseLatencySummary(aprime);
  // B is compared with the bracketing off phases, not only the first A.
  // This remains a recorded attribution observation; it is intentionally not
  // a performance pass/fail threshold.
  const offBaseline = {
    p50: (aSummary.p50 + primeSummary.p50) / 2,
    p95: (aSummary.p95 + primeSummary.p95) / 2,
  };
  const drift = {
    p50: aSummary.p50 === 0 ? 0 : Math.abs(primeSummary.p50 - aSummary.p50) / aSummary.p50,
    p95: aSummary.p95 === 0 ? 0 : Math.abs(primeSummary.p95 - aSummary.p95) / aSummary.p95,
  };
  if (drift.p50 > 0.10 || drift.p95 > 0.10) fail("aba-drift", "A and A-prime drift exceeds 10%; B0 must be re-run");
  return Object.freeze({
    A: aSummary,
    B: bSummary,
    Aprime: primeSummary,
    drift,
    overhead: {
      p50Ms: bSummary.p50 - offBaseline.p50,
      p95Ms: bSummary.p95 - offBaseline.p95,
      p50Percent: offBaseline.p50 === 0 ? null : (bSummary.p50 - offBaseline.p50) / offBaseline.p50 * 100,
      p95Percent: offBaseline.p95 === 0 ? null : (bSummary.p95 - offBaseline.p95) / offBaseline.p95 * 100,
    },
  });
}

const TOKEN_REFRESH_SPAN_NAMES = new Set([
  "auth.refresh",
  "auth.token.refresh",
  "token.refresh",
]);

/**
 * The only accepted activation/outlier source is the raw Workers telemetry
 * export.  It joins by the provider's trace/request identifiers, never by
 * time proximity and never through an operator-authored declaration file.
 */
function evidenceTraceIndex(ledger, traces, label) {
  if (!Array.isArray(ledger) || !Array.isArray(traces)) fail(`${label}-trace-input`, `${label} requires a ledger and exported trace array`);
  const ledgerByRequestId = new Map();
  for (const [index, record] of ledger.entries()) {
    const requestId = nonEmptyString(record?.requestId, `${label}.ledger[${index}].requestId`);
    if (ledgerByRequestId.has(requestId)) fail(`${label}-ledger-duplicate`, `${label} ledger repeats requestId ${requestId}`);
    ledgerByRequestId.set(requestId, record);
  }
  const traceByRequestId = new Map();
  const requestIdByTraceId = new Map();
  for (const [index, trace] of traces.entries()) {
    const requestId = nonEmptyString(trace?.requestId, `${label}.traces[${index}].requestId`);
    if (!ledgerByRequestId.has(requestId) || traceByRequestId.has(requestId)) {
      fail(`${label}-trace-join`, `${label} trace requestId ${requestId} is missing from or duplicated in the observation ledger`);
    }
    const traceId = nonEmptyString(trace?.traceId, `${label}.traces[${index}].traceId`);
    if (requestIdByTraceId.has(traceId)) fail(`${label}-trace-duplicate`, `${label} traceId ${traceId} is duplicated`);
    if (trace?.schema !== "sdt.commit/v1" || trace?.complete !== true || trace?.runtimeVerified !== true || trace?.boundary !== "success") {
      fail(`${label}-trace-complete`, `${label} trace ${requestId} is not a complete runtime-verified success trace`);
    }
    try {
      verifyExportedSuccessTrace(trace);
    } catch (error) {
      fail(`${label}-trace-runtime`, `${label} trace ${requestId} failed runtime verification: ${error instanceof Error ? error.message : String(error)}`);
    }
    traceByRequestId.set(requestId, trace);
    requestIdByTraceId.set(traceId, requestId);
  }
  if (traceByRequestId.size !== ledgerByRequestId.size) {
    fail(`${label}-trace-loss`, `${label} is missing a trace for one or more observation-ledger requests`);
  }
  return Object.freeze({ ledgerByRequestId, traceByRequestId, requestIdByTraceId });
}

function evidenceReference(requestIdValue, index, label) {
  const requestId = nonEmptyString(requestIdValue, `${label}.requestId`);
  const ledger = index.ledgerByRequestId.get(requestId);
  const trace = index.traceByRequestId.get(requestId);
  if (ledger === undefined || trace === undefined) {
    fail(`${label}-trace-join`, `${label} requestId ${requestId} is not jointly present in the observation ledger and exported traces`);
  }
  const roots = Array.isArray(trace.spans) ? trace.spans.filter((span) => span?.rowId === "S00") : [];
  if (roots.length !== 1) fail(`${label}-trace-root`, `${label} requestId ${requestId} must have exactly one S00 trace root`);
  const attributes = object(roots[0]?.attributes);
  if (attributes === undefined) fail(`${label}-trace-root`, `${label} requestId ${requestId} root attributes are missing`);
  return Object.freeze({ requestId, ledger, trace, root: roots[0], rootAttributes: attributes });
}

/**
 * An idle interval is evidence only when it explicitly names both requests
 * around the idle period.  Keeping this guard separate lets its mutation
 * oracle attribute a missing predecessor/successor to this boundary rather
 * than to a later timing calculation.
 */
export function assertIdleRequestReferences(window, label) {
  const previousRequestId = nonEmptyString(window?.previousRequestId, `${label}.previous.requestId`);
  const nextRequestId = nonEmptyString(window?.nextRequestId, `${label}.next.requestId`);
  if (previousRequestId === nextRequestId) fail("idle-reference", `${label} must name distinct prior and next requests`);
  return Object.freeze({ previousRequestId, nextRequestId });
}

function rootBoolean(reference, attribute, label) {
  const value = reference.rootAttributes[attribute];
  if (typeof value !== "boolean") fail(`${label}-trace-root`, `${label} trace root lacks boolean ${attribute}`);
  return value;
}

function rootString(reference, attribute, label) {
  const value = reference.rootAttributes[attribute];
  if (typeof value !== "string" || value.length === 0) fail(`${label}-trace-root`, `${label} trace root lacks string ${attribute}`);
  return value;
}

/**
 * Workers Logs contributes version/colo as provider-owned metadata for every
 * structured observation. The DO payload deliberately does not invent a
 * second propagation channel for those facts; its raw provider metadata is
 * instead checked against the root's already-sealed optional attributes.
 */
function assertObservationProviderOverlap(observation, reference, label) {
  const provider = object(observation.provider);
  const scriptVersion = nonEmptyString(provider?.scriptVersion, `${label}.provider.scriptVersion`);
  const colo = nonEmptyString(provider?.colo, `${label}.provider.colo`);
  if (rootString(reference, "script.version", label) !== scriptVersion) {
    fail("observation-provider-script-version", `${label} provider script.version differs from S00`);
  }
  if (rootString(reference, "colo", label) !== colo) {
    fail("observation-provider-colo", `${label} provider colo differs from S00`);
  }
  return Object.freeze({ scriptVersion, colo });
}

function rootDuration(reference, label) {
  const start = finiteNumber(reference.root?.startMs, `${label}.S00.startMs`);
  const end = finiteNumber(reference.root?.endMs, `${label}.S00.endMs`);
  if (end < start) fail(`${label}-trace-root`, `${label} trace root ends before it starts`);
  return end - start;
}

function providerSpanNames(reference, label) {
  if (!Array.isArray(reference.trace?.providerSpanNames)) {
    fail(`${label}-provider-spans`, `${label} trace must retain provider span names for refresh exclusion`);
  }
  return reference.trace.providerSpanNames.map((value, index) => nonEmptyString(value, `${label}.providerSpanNames[${index}]`));
}

function refreshRequestIds(index, label) {
  const observed = new Set();
  for (const [requestId, trace] of index.traceByRequestId) {
    const names = providerSpanNames({ trace }, `${label}.${requestId}`);
    if (names.some((name) => TOKEN_REFRESH_SPAN_NAMES.has(name.toLowerCase()))) observed.add(requestId);
  }
  return observed;
}

const WARM_ACTORS = Object.freeze(["WORKER", "BOOTSTRAP", "ALLOCATOR", "TAG"]);
const DO_ACTORS = new Set(["BOOTSTRAP", "ALLOCATOR", "JOURNAL", "TAG"]);
const OBSERVATION_EVENTS = new Set(["worker.invocation", "do.handler", "fault.barrier"]);
const OUTLIER_TARGET_MS = 21_500;

function observationForRequest(index, requestId, predicate) {
  return (index.observationsByRequestId.get(requestId) ?? []).filter(predicate);
}

/**
 * Builds the complete B observation ledger from client-captured request
 * records. The runner owns these timestamps; no operator statement is
 * accepted. Warmup and idle requests are deliberately not substituted into
 * the fixed 100-request B performance-neutral trace cohort.
 */
export function observationLedgerForPhase(phaseB) {
  const canonical = phaseB?.ledger;
  const warmup = phaseB?.warmup?.requests;
  const idle = phaseB?.idleExperiment?.requests;
  if (!Array.isArray(canonical) || !Array.isArray(warmup) || !Array.isArray(idle)) {
    fail("observation-ledger", "B requires canonical, warmup, and idle client request ledgers");
  }
  const records = [...canonical, ...warmup, ...idle];
  const seen = new Set();
  for (const [index, record] of records.entries()) {
    const requestId = nonEmptyString(record?.requestId, `observation-ledger[${index}].requestId`);
    if (seen.has(requestId)) fail("observation-ledger", `B observation ledger repeats requestId ${requestId}`);
    seen.add(requestId);
    finiteNumber(record?.startedAtMs, `observation-ledger[${index}].startedAtMs`);
    finiteNumber(record?.completedAtMs, `observation-ledger[${index}].completedAtMs`);
  }
  return Object.freeze(records);
}

/**
 * The normalized sdt.observe/v1 stream is fail-closed: every structured log
 * must carry a platform-derived request id that joins to exactly one client
 * ledger entry and S00 trace. Worker overlap facts are compared directly to
 * S00, so copied/mismatched values cannot become evidence.
 */
export function assertObservationStream(ledger, traces, observations) {
  if (!Array.isArray(observations)) fail("observation-input", "B requires exported sdt.observe/v1 observations");
  const traceIndex = evidenceTraceIndex(ledger, traces, "observation");
  const observationsByRequestId = new Map();
  for (const [index, raw] of observations.entries()) {
    const observation = object(raw);
    if (observation === undefined) fail("observation-shape", `observation ${index} must be an object`);
    if (observation.schema !== "sdt.observe/v1" || !OBSERVATION_EVENTS.has(observation.event)) {
      fail("observation-schema", `observation ${index} is not a supported sdt.observe/v1 event`);
    }
    finiteNumber(observation.emittedAtMs, `observation[${index}].emittedAtMs`);
    if (observation.storageWrites !== 0 || observation.usedForControl !== false || observation.exposedInPublicResponse !== false) {
      fail("observation-isolation", `observation ${index} is not observation-only`);
    }
    const reference = evidenceReference(observation.requestId, traceIndex, `observation[${index}]`);
    if (nonEmptyString(observation.traceId, `observation[${index}].traceId`) !== reference.trace.traceId) {
      fail("observation-trace-id", `observation ${index} traceId does not match its joined request root`);
    }
    if (observation.event === "worker.invocation") {
      if (observation.actorClass !== "WORKER" || typeof observation.activationFirst !== "boolean") {
        fail("observation-worker", `worker observation ${index} lacks actor/activation facts`);
      }
      nonEmptyString(observation.isolateInstanceId, `observation[${index}].isolateInstanceId`);
      const scriptVersion = nonEmptyString(observation.scriptVersion, `observation[${index}].scriptVersion`);
      const colo = nonEmptyString(observation.colo, `observation[${index}].colo`);
      const provider = assertObservationProviderOverlap(observation, reference, `observation[${index}]`);
      if (rootBoolean(reference, "activation.first", `observation[${index}]`) !== observation.activationFirst) {
        fail("observation-overlap-activation", `worker observation ${index} activation.first differs from S00`);
      }
      if (provider.scriptVersion !== scriptVersion || rootString(reference, "script.version", `observation[${index}]`) !== scriptVersion) {
        fail("observation-overlap-script-version", `worker observation ${index} script.version differs from S00`);
      }
      if (provider.colo !== colo || rootString(reference, "colo", `observation[${index}]`) !== colo) {
        fail("observation-overlap-colo", `worker observation ${index} colo differs from S00`);
      }
    } else if (observation.event === "do.handler") {
      if (!DO_ACTORS.has(observation.actorClass) || typeof observation.activationFirst !== "boolean") {
        fail("observation-do", `DO observation ${index} lacks actor/activation facts`);
      }
      nonEmptyString(observation.activationId, `observation[${index}].activationId`);
      assertObservationProviderOverlap(observation, reference, `observation[${index}]`);
      finiteNumber(observation.constructorToHandlerMs, `observation[${index}].constructorToHandlerMs`);
      if (observation.firstStorageReadMs !== null) finiteNumber(observation.firstStorageReadMs, `observation[${index}].firstStorageReadMs`);
      if (observation.subrequestWallMs !== null) finiteNumber(observation.subrequestWallMs, `observation[${index}].subrequestWallMs`);
    } else {
      nonEmptyString(observation.barrierId, `observation[${index}].barrierId`);
      if (!["started", "ended", "drained"].includes(observation.stage)) fail("observation-fault", `fault observation ${index} has an invalid stage`);
      finiteNumber(observation.boundedWindowMs, `observation[${index}].boundedWindowMs`);
    }
    const existing = observationsByRequestId.get(reference.requestId) ?? [];
    existing.push(observation);
    observationsByRequestId.set(reference.requestId, existing);
  }
  for (const requestId of traceIndex.ledgerByRequestId.keys()) {
    const worker = observationForRequest({ observationsByRequestId }, requestId, (entry) => entry.event === "worker.invocation");
    if (worker.length !== 1) fail("observation-worker", `request ${requestId} requires exactly one joined worker observation`);
  }
  return Object.freeze({ ...traceIndex, observationsByRequestId });
}

/** Five B-on warmup requests must be observed from the same raw log export. */
export function assertWarmupProof(phase, warmup, observationIndex) {
  if (phase !== "B") fail("warmup-phase", "only the trace-sampled B phase may claim a joined activation warmup proof");
  if (warmup === null || typeof warmup !== "object" || Array.isArray(warmup)) fail("warmup", "B warmup request ledger is missing");
  if (!Number.isSafeInteger(warmup.requested) || warmup.requested < 5 || warmup.requested > 30 || !Array.isArray(warmup.requests) || warmup.requests.length !== warmup.requested) {
    fail("warmup", "B warmup must retain 5..30 client requests");
  }
  for (const [requestIndex, record] of warmup.requests.entries()) {
    const requestId = nonEmptyString(record?.requestId, `warmup[${requestIndex}].requestId`);
    evidenceReference(requestId, observationIndex, `warmup[${requestIndex}]`);
    for (const actor of WARM_ACTORS) {
      const events = observationForRequest(
        observationIndex,
        requestId,
        (entry) => actor === "WORKER"
          ? entry.event === "worker.invocation"
          : entry.event === "do.handler" && entry.actorClass === actor,
      );
      if (events.length === 0 || events.some((entry) => entry.activationFirst !== false)) {
        fail("warmup-activation", `B ${actor} lacks a non-first raw observation for warmup request ${requestIndex}`);
      }
    }
  }
  return Object.freeze({ phase, attempts: warmup.requested, actors: WARM_ACTORS });
}

/**
 * The 2/15/180-second observation is computed from client request timelines
 * and joined worker logs. A window without both surrounding request ids is
 * intentionally unprovable; a literal claimed gap is not accepted.
 */
export function assertActivationIdleEvidence(idleExperiment, observationIndex) {
  const idle = object(idleExperiment);
  if (idle === undefined || !same(idle.scheduleMs, G30_IDLE_SCHEDULE_MS) || !Array.isArray(idle.windows)) {
    fail("idle-schedule", "idle experiment must use exactly 2000/15000/180000ms with raw windows");
  }
  if (idle.windows.length !== G30_IDLE_SCHEDULE_MS.length) fail("idle-observations", "idle experiment must contain exactly one window per schedule value");
  const observedSchedule = new Set();
  const derived = [];
  for (const [index, raw] of idle.windows.entries()) {
    const window = object(raw);
    if (window === undefined) fail("idle-observation", `idle window ${index} must be an object`);
    const scheduledGapMs = finiteNumber(window.scheduledGapMs, `idle[${index}].scheduledGapMs`);
    if (!G30_IDLE_SCHEDULE_MS.includes(scheduledGapMs) || observedSchedule.has(scheduledGapMs)) fail("idle-schedule", `idle window ${index} has an invalid schedule`);
    observedSchedule.add(scheduledGapMs);
    const references = assertIdleRequestReferences(window, `idle[${index}]`);
    const previous = evidenceReference(references.previousRequestId, observationIndex, `idle[${index}].previous`);
    const next = evidenceReference(references.nextRequestId, observationIndex, `idle[${index}].next`);
    const previousCompletedAtMs = finiteNumber(previous.ledger.completedAtMs, `idle[${index}].previous.completedAtMs`);
    const nextStartedAtMs = finiteNumber(next.ledger.startedAtMs, `idle[${index}].next.startedAtMs`);
    if (nextStartedAtMs < previousCompletedAtMs) fail("idle-ledger", `idle window ${index} reverses its complete ledger order`);
    const worker = observationForRequest(observationIndex, next.requestId, (entry) => entry.event === "worker.invocation");
    if (worker.length !== 1) fail("idle-observation", `idle window ${index} needs exactly one next-request worker observation`);
    const scriptVersion = nonEmptyString(worker[0].scriptVersion, `idle[${index}].worker.scriptVersion`);
    const colo = nonEmptyString(worker[0].colo, `idle[${index}].worker.colo`);
    const reactivationCause = rootString(previous, "script.version", `idle[${index}].previous`) === scriptVersion
      ? "unknown"
      : "deployment-correlated";
    if (!REACTIVATION_CAUSES.has(reactivationCause)) fail("reactivation-cause", `idle window ${index} has an unsupported cause`);
    derived.push(Object.freeze({
      scheduledGapMs,
      actualGapMs: nextStartedAtMs - previousCompletedAtMs,
      previousRequestId: previous.requestId,
      nextRequestId: next.requestId,
      activationFirst: worker[0].activationFirst,
      scriptVersion,
      colo,
      reactivationCause,
      observedIdleGapLowerBoundMs: nextStartedAtMs - previousCompletedAtMs,
    }));
  }
  if (!same([...observedSchedule].sort((left, right) => left - right), G30_IDLE_SCHEDULE_MS)) fail("idle-schedule", "idle experiment does not cover every required gap");
  return Object.freeze({ scheduleMs: G30_IDLE_SCHEDULE_MS, observations: derived.length, raw: derived });
}

function targetOutlierReferences(phaseB, observationIndex) {
  if (!Array.isArray(phaseB?.ledger)) fail("outlier-ledger", "B canonical ledger is missing");
  return phaseB.ledger
    .filter((record) => finiteNumber(record?.responseLatencyMs, "outlier.responseLatencyMs") >= OUTLIER_TARGET_MS)
    .map((record, index) => evidenceReference(record.requestId, observationIndex, `outlier-target[${index}]`));
}

function assertFaultBarrier(observationIndex, requiredForObservedOutlier) {
  const grouped = new Map();
  for (const [requestId, events] of observationIndex.observationsByRequestId) {
    for (const event of events.filter((entry) => entry.event === "fault.barrier")) {
      const existing = grouped.get(event.barrierId) ?? [];
      existing.push({ requestId, event });
      grouped.set(event.barrierId, existing);
    }
  }
  if (grouped.size === 0) {
    if (requiredForObservedOutlier) fail("fault-barrier", "queue/doorbell probe has no observed sdt.observe/v1 fault barrier for an observed outlier");
    return Object.freeze([]);
  }
  const completed = [];
  for (const [barrierId, events] of grouped) {
    const ordered = [...events].sort((left, right) => left.event.emittedAtMs - right.event.emittedAtMs);
    if (!same(ordered.map((entry) => entry.event.stage), ["started", "ended", "drained"])) {
      fail("fault-barrier", `fault barrier ${barrierId} must emit started/ended/drained exactly once`);
    }
    const [started, ended, drained] = ordered;
    const bound = finiteNumber(started.event.boundedWindowMs, `fault-barrier.${barrierId}.bound`);
    if (ended.event.emittedAtMs - started.event.emittedAtMs > bound || drained.event.emittedAtMs < ended.event.emittedAtMs) {
      fail("fault-barrier", `fault barrier ${barrierId} exceeded its bounded window or did not drain after release`);
    }
    const reference = evidenceReference(started.requestId, observationIndex, `fault-barrier.${barrierId}`);
    if (rootDuration(reference, `fault-barrier.${barrierId}`) > finiteNumber(reference.ledger.responseLatencyMs, `fault-barrier.${barrierId}.responseLatencyMs`)) {
      fail("queue-bound", `fault barrier ${barrierId} exceeded its joined response bound`);
    }
    completed.push(Object.freeze({ barrierId, requestId: started.requestId, boundedWindowMs: bound }));
  }
  return Object.freeze(completed);
}

/**
 * Four outlier dispositions are derived only from joined telemetry. The
 * absence of a 21.5s target is an observed exclusion, not a declared one.
 */
export function assertOutlierClassification(phaseB, observationIndex) {
  const targets = targetOutlierReferences(phaseB, observationIndex);
  const targetIds = new Set(targets.map((reference) => reference.requestId));
  const workerEvents = targets.flatMap((reference) => observationForRequest(observationIndex, reference.requestId, (entry) => entry.event === "worker.invocation"));
  const workerFirst = workerEvents.find((entry) => entry.activationFirst === true);
  const worker = Object.freeze({
    hypothesis: "worker-isolate-first",
    disposition: workerFirst === undefined ? "excluded" : "attributed",
    classified: true,
    rawEvidence: workerFirst === undefined ? [] : [workerFirst],
  });
  const doEvents = targets.flatMap((reference) => observationForRequest(observationIndex, reference.requestId, (entry) => entry.event === "do.handler" && entry.activationFirst === true));
  const wakeActors = new Set(doEvents.map((entry) => entry.actorClass));
  const durableObject = Object.freeze({
    hypothesis: "durable-object-wake",
    disposition: wakeActors.size === 1 ? "attributed" : "excluded",
    classified: true,
    rawEvidence: doEvents,
  });
  const refreshes = refreshRequestIds(observationIndex, "token-rotation");
  const token = Object.freeze({
    hypothesis: "token-rotation",
    disposition: [...refreshes].some((requestId) => targetIds.has(requestId)) ? "attributed" : "excluded",
    classified: true,
    rawEvidence: [...refreshes].filter((requestId) => targetIds.has(requestId)).map((requestId) => evidenceReference(requestId, observationIndex, "token-rotation")),
  });
  // A no-outlier B0 run excludes this hypothesis from the measured universe;
  // it must not invent a fault claim. If a 21.5s target is observed, the
  // bounded probe's lifecycle is mandatory and comes only from sdt.observe.
  const barriers = assertFaultBarrier(observationIndex, targets.length > 0);
  const queue = Object.freeze({
    hypothesis: "queue-doorbell-backpressure",
    disposition: "excluded",
    classified: true,
    rawEvidence: barriers,
  });
  const outliers = [worker, durableObject, token, queue];
  if (!same(outliers.map((entry) => entry.hypothesis).sort(), [...OUTLIER_HYPOTHESES].sort())) fail("outlier", "one or more required hypotheses is absent");
  return Object.freeze({ classifiedOutliers: outliers.length, unclassifiedOutliers: 0, targetCount: targets.length, observations: outliers });
}

export function assertB0Evidence(evidence) {
  if (evidence?.task !== "SDT-G30" || evidence?.baseline !== "B0" || evidence?.purpose !== "attribution-only-not-g37-denominator") {
    fail("identity", "evidence must identify G30 B0 as attribution-only");
  }
  if (Object.hasOwn(evidence, "activationIdle") || Object.hasOwn(evidence, "outlierDiscrimination")) {
    fail("observation-declaration", "activation and outlier evidence must be derived from exported sdt.observe/v1 data");
  }
  const phases = evidence.phases;
  const windows = Object.fromEntries(G30_PHASES.map((phase) => [phase, assertEligiblePhaseWindow(phase, phases?.[phase]?.ledger, phases?.[phase]?.rawAttempts)]));
  if (!same(windows.A.cohort, windows.B.cohort) || !same(windows.A.cohort, windows["A-prime"].cohort)) {
    fail("cohort-cross-phase", "A/B/A-prime cohort identity differs");
  }
  const config = assertPhaseConfiguration(phases);
  const traces = assertTraceCohort(phases.B.ledger, evidence.traces, evidence.traceExportCompletedAtMs);
  const latency = assertAaaDrift(phases.A.ledger, phases.B.ledger, phases["A-prime"].ledger);
  const observationLedger = observationLedgerForPhase(phases.B);
  const observation = assertObservationStream(observationLedger, evidence.observationTraces, evidence.observations);
  const warmup = assertWarmupProof("B", phases.B.warmup, observation);
  const activationIdle = assertActivationIdleEvidence(phases.B.idleExperiment, observation);
  const outliers = assertOutlierClassification(phases.B, observation);
  return Object.freeze({ windows, config, warmup: { B: warmup }, traces, latency, observation: { requests: observationLedger.length, events: evidence.observations.length }, activationIdle, outliers });
}

function makeRecords(phase, responseLatencyMs = 100) {
  const start = 1_000_000;
  return Array.from({ length: G30_SAMPLE_COUNT }, (_, index) => ({
    index,
    requestId: `${phase.toLowerCase()}-${index}`,
    status: 200,
    eligible: true,
    nonEmpty: true,
    replacement: false,
    serviceId: "g32-9043d626fe1149cb",
    clientRegion: "test-region",
    tagSetDigest: "a".repeat(64),
    payloadDigest: "b".repeat(64),
    fixtureVersion: "g30-v1",
    scheduledStartMs: start + index * G30_CADENCE_MS,
    startedAtMs: start + index * G30_CADENCE_MS,
    completedAtMs: start + index * G30_CADENCE_MS + responseLatencyMs,
    responseLatencyMs,
  }));
}

function makeTrace(record) {
  const start = record.startedAtMs;
  const end = record.completedAtMs;
  const rows = manifest.schemas["sdt.commit/v1"].rows;
  const required = manifest.schemas["sdt.commit/v1"].boundaries.find((boundary) => boundary.name === "success")?.requiredRows ?? [];
  const spans = required.map((rowId) => {
    const row = rows.find((candidate) => candidate.rowId === rowId);
    if (row === undefined) fail("self-test", `manifest lacks ${rowId}`);
    const face = rowId === "S01" ? "pre-admission" : "accepted";
    const attributes = {
      "schema.version": "sdt.commit/v1",
      "correlation.id": `corr-${record.requestId}`,
      "service.id": record.serviceId ?? "g32-9043d626fe1149cb",
      "actor.class": row.emitter === "allocator-do" ? "ALLOCATOR" : "ROOT",
      operation: row.span,
      "span.kind": row.kind,
      outcome: "success",
      ...(face === "pre-admission" ? {} : { "attempt.id": `attempt-${record.requestId}`, "actor.key_hash": "a".repeat(64) }),
      ...(/^S05[a-e]$/.test(rowId) ? { "phase.ordinal": "abcde".indexOf(rowId.at(-1)) } : {}),
      ...(manifest.attributeMatrix.attributes["member.index"].rowScope?.includes(rowId) ? { "member.index": 0 } : {}),
      ...(manifest.attributeMatrix.attributes["tag.key_hash"].rowScope?.includes(rowId) ? { "tag.key_hash": "b".repeat(64) } : {}),
      ...(rowId === "S00" ? {
        "activation.first": !record.requestId.includes("warm") && Number(record.requestId.slice(record.requestId.lastIndexOf("-") + 1)) === 2,
        "script.version": "g30-synthetic",
        colo: "test-colo",
      } : {}),
    };
    return {
      rowId,
      schema: "sdt.commit/v1",
      face,
      span: row.span,
      startMs: start,
      endMs: end,
      emitter: row.emitter,
      kind: row.kind,
      logicalParent: row.logicalParent,
      rootId: `trace-${record.requestId}`,
      clockDomain: "caller",
      present: true,
      zeroDurationPlatformLimited: false,
      attributes,
    };
  });
  return {
    requestId: record.requestId,
    traceId: `trace-${record.requestId}`,
    schema: "sdt.commit/v1",
    complete: true,
    runtimeVerified: true,
    boundary: "success",
    exportedAtMs: end + 1,
    callerCoverageIntervals: ["S01"],
    providerSpanNames: ["sdt.commit"],
    spans,
  };
}

function makeObservation(record) {
  const activationFirst = !String(record.requestId).includes("warm") && Number(String(record.requestId).split("-").at(-1)) === 2;
  const provider = { scriptVersion: "g30-synthetic", colo: "test-colo", cpuTimeMs: 1, wallTimeMs: record.responseLatencyMs };
  const isolated = { storageWrites: 0, usedForControl: false, exposedInPublicResponse: false };
  return [
    { schema: "sdt.observe/v1", event: "worker.invocation", emittedAtMs: record.completedAtMs - 3, requestId: record.requestId, traceId: `trace-${record.requestId}`, actorClass: "WORKER", isolateInstanceId: "synthetic-isolate", activationFirst, scriptVersion: provider.scriptVersion, colo: provider.colo, provider, ...isolated },
    ...["BOOTSTRAP", "ALLOCATOR", "TAG"].map((actorClass) => ({
      schema: "sdt.observe/v1", event: "do.handler", emittedAtMs: record.completedAtMs - 2, requestId: record.requestId, traceId: `trace-${record.requestId}`,
      actorClass, activationId: `${actorClass.toLowerCase()}-${record.requestId}`, activationFirst: false,
      constructorToHandlerMs: 1, firstStorageReadMs: 1, subrequestWallMs: actorClass === "ALLOCATOR" ? 1 : null, provider, ...isolated,
    })),
  ];
}

function syntheticB0Evidence() {
  const a = makeRecords("A", 100);
  const b = makeRecords("B", 110);
  b[13].responseLatencyMs = OUTLIER_TARGET_MS;
  b[13].completedAtMs = b[13].startedAtMs + OUTLIER_TARGET_MS;
  const prime = makeRecords("A-prime", 102);
  const warmupRequests = Array.from({ length: 5 }, (_, index) => ({
    requestId: `b-warm-${index}`, status: 200, startedAtMs: 980_000 + index * 2_000, completedAtMs: 980_100 + index * 2_000, responseLatencyMs: 100,
  }));
  const idleRequests = [];
  const idleWindows = [];
  let previous = b.at(-1);
  for (const [index, scheduledGapMs] of G30_IDLE_SCHEDULE_MS.entries()) {
    const startedAtMs = previous.completedAtMs + scheduledGapMs;
    const next = { requestId: `b-idle-${index}`, status: 200, startedAtMs, completedAtMs: startedAtMs + 110, responseLatencyMs: 110 };
    idleRequests.push(next);
    idleWindows.push({ scheduledGapMs, previousRequestId: previous.requestId, nextRequestId: next.requestId });
    previous = next;
  }
  const baseConfig = { placement: "off", serviceId: "g32-9043d626fe1149cb", observability: { traces: { enabled: true, head_sampling_rate: 0 } } };
  const phaseB = {
    ledger: b,
    rawAttempts: [],
    configuration: { ...baseConfig, deployedVersion: "on", observability: { traces: { enabled: true, head_sampling_rate: 1 } } },
    warmup: { requested: 5, requests: warmupRequests },
    idleExperiment: { scheduleMs: G30_IDLE_SCHEDULE_MS, requests: idleRequests, windows: idleWindows },
  };
  const allRecords = observationLedgerForPhase(phaseB);
  const observationTraces = allRecords.map(makeTrace);
  const observations = allRecords.flatMap(makeObservation);
  observations.push(
    { schema: "sdt.observe/v1", event: "fault.barrier", emittedAtMs: b[13].completedAtMs - 20, requestId: b[13].requestId, traceId: `trace-${b[13].requestId}`, barrierId: "synthetic-fault", stage: "started", boundedWindowMs: 20, storageWrites: 0, usedForControl: false, exposedInPublicResponse: false },
    { schema: "sdt.observe/v1", event: "fault.barrier", emittedAtMs: b[13].completedAtMs - 15, requestId: b[13].requestId, traceId: `trace-${b[13].requestId}`, barrierId: "synthetic-fault", stage: "ended", boundedWindowMs: 20, storageWrites: 0, usedForControl: false, exposedInPublicResponse: false },
    { schema: "sdt.observe/v1", event: "fault.barrier", emittedAtMs: b[13].completedAtMs - 10, requestId: b[13].requestId, traceId: `trace-${b[13].requestId}`, barrierId: "synthetic-fault", stage: "drained", boundedWindowMs: 20, storageWrites: 0, usedForControl: false, exposedInPublicResponse: false },
  );
  return {
    task: "SDT-G30", baseline: "B0", purpose: "attribution-only-not-g37-denominator",
    phases: {
      A: { ledger: a, rawAttempts: [], configuration: baseConfig },
      B: phaseB,
      "A-prime": { ledger: prime, rawAttempts: [], configuration: { ...baseConfig, deployedVersion: "off-prime" } },
    },
    traces: b.map(makeTrace), observationTraces, observations, traceExportCompletedAtMs: b.at(-1).completedAtMs + 10,
  };
}

export function selfTest() {
  const evidence = syntheticB0Evidence();
  assertB0Evidence(evidence);
  const failures = {};
  for (const [name, mutate, marker] of [
    ["trace-loss", (value) => { value.traces.pop(); }, "trace-count"],
    ["out-of-window-replacement", (value) => { value.phases.B.ledger[99].replacement = true; }, "window-eligibility"],
    ["sampling-delta", (value) => { value.phases.B.configuration.placement = "smart"; }, "placement"],
    ["unjoined-observation", (value) => { value.observations[0].requestId = "missing-request"; }, "observation[0]-trace-join"],
    ["overlap-mismatch", (value) => { value.observations.find((entry) => entry.event === "worker.invocation").scriptVersion = "wrong"; }, "observation-overlap-script-version"],
    ["barrier-missing", (value) => { value.observations = value.observations.filter((entry) => entry.event !== "fault.barrier"); }, "fault-barrier"],
    ["idle-reference-missing", (value) => { delete value.phases.B.idleExperiment.windows[0].previousRequestId; }, "idle[0].previous.requestId"],
  ]) {
    const altered = structuredClone(evidence);
    mutate(altered);
    try { assertB0Evidence(altered); } catch (error) { failures[name] = String(error).includes(marker); }
  }
  if (Object.values(failures).some((passed) => passed !== true)) fail("self-test", "an SDT-G30 B0 mutation unexpectedly passed");
  return Object.freeze({ sampleCount: G30_SAMPLE_COUNT, failures });
}

function main() {
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify(selfTest(), null, 2));
    return;
  }
  const pathIndex = process.argv.indexOf("--evidence");
  if (pathIndex < 0 || process.argv[pathIndex + 1] === undefined) fail("argument", "--evidence <path> is required");
  const evidence = JSON.parse(readFileSync(process.argv[pathIndex + 1], "utf8"));
  const result = assertB0Evidence(evidence);
  console.log(JSON.stringify({ result, evidenceDigest: createHash("sha256").update(JSON.stringify(canonical(evidence))).digest("hex") }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
