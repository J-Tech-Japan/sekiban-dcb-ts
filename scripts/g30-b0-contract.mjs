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

/**
 * The warm-up proof is collected from the platform trace/log export rather
 * than guessed by this client. Every reusable participant must report five
 * consecutive non-first handler entries, with no shortcut past 30 attempts.
 */
export function assertWarmupProof(phase, warmup) {
  if (warmup === null || typeof warmup !== "object" || Array.isArray(warmup)) fail("warmup", `${phase} warmup proof is missing`);
  if (!Number.isSafeInteger(warmup.attempts) || warmup.attempts < 5 || warmup.attempts > 30) fail("warmup-attempts", `${phase} warmup attempts must be 5..30`);
  if (typeof warmup.source !== "string" || warmup.source.length === 0) fail("warmup-source", `${phase} warmup source is missing`);
  for (const actor of ["WORKER", "BOOTSTRAP", "ALLOCATOR", "TAG"]) {
    const values = warmup.actors?.[actor];
    if (!Array.isArray(values) || values.length < 5 || values.slice(-5).some((value) => value !== false)) {
      fail("warmup-activation", `${phase} ${actor} does not have five consecutive activation.first=false observations`);
    }
  }
  return Object.freeze({ phase, attempts: warmup.attempts, actors: ["WORKER", "BOOTSTRAP", "ALLOCATOR", "TAG"] });
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
 * Operator-supplied evidence is not authoritative merely because it is
 * structurally well-formed. Every observation must name one independently
 * retained B ledger request and its exported trace; no arrival-order or time
 * proximity fallback is allowed.
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
  for (const [index, trace] of traces.entries()) {
    const requestId = nonEmptyString(trace?.requestId, `${label}.traces[${index}].requestId`);
    if (!ledgerByRequestId.has(requestId) || traceByRequestId.has(requestId)) {
      fail(`${label}-trace-join`, `${label} trace requestId ${requestId} is missing from or duplicated in the B ledger`);
    }
    traceByRequestId.set(requestId, trace);
  }
  return Object.freeze({ ledgerByRequestId, traceByRequestId });
}

function evidenceReference(requestIdValue, index, label) {
  const requestId = nonEmptyString(requestIdValue, `${label}.requestId`);
  const ledger = index.ledgerByRequestId.get(requestId);
  const trace = index.traceByRequestId.get(requestId);
  if (ledger === undefined || trace === undefined) {
    fail(`${label}-trace-join`, `${label} requestId ${requestId} is not jointly present in the B ledger and exported traces`);
  }
  const roots = Array.isArray(trace.spans) ? trace.spans.filter((span) => span?.rowId === "S00") : [];
  if (roots.length !== 1) fail(`${label}-trace-root`, `${label} requestId ${requestId} must have exactly one S00 trace root`);
  const attributes = object(roots[0]?.attributes);
  if (attributes === undefined) fail(`${label}-trace-root`, `${label} requestId ${requestId} root attributes are missing`);
  return Object.freeze({ requestId, ledger, trace, root: roots[0], rootAttributes: attributes });
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
  if (reference.trace.providerSpanNames.length === 0) {
    fail(`${label}-provider-spans`, `${label} trace has no provider span names from which to exclude refresh`);
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

/**
 * The activation proof is an external trace/export ledger. It records the
 * exact experiment schedule and values observed in the matching root row,
 * while proving that none became Durable Object storage, a control input, or
 * a public response field.
 */
export function assertActivationIdleEvidence(activationIdle, ledger, traces) {
  const evidence = object(activationIdle);
  if (evidence === undefined) fail("activation-idle", "activation/idle evidence is missing");
  const traceIndex = evidenceTraceIndex(ledger, traces, "activation");
  if (!same(evidence.scheduleMs, G30_IDLE_SCHEDULE_MS)) {
    fail("idle-schedule", "idle experiment must use exactly 2000/15000/180000ms");
  }
  if (!Array.isArray(evidence.observations) || evidence.observations.length < G30_IDLE_SCHEDULE_MS.length) {
    fail("idle-observations", "activation/idle evidence needs one or more observations for every scheduled gap");
  }
  const observedSchedule = new Set();
  for (const [index, entry] of evidence.observations.entries()) {
    const observation = object(entry);
    if (observation === undefined) fail("idle-observation", `idle observation ${index} must be an object`);
    const scheduledGapMs = finiteNumber(observation.scheduledGapMs, `idle[${index}].scheduledGapMs`);
    if (!G30_IDLE_SCHEDULE_MS.includes(scheduledGapMs)) fail("idle-schedule", `idle observation ${index} uses an undeclared schedule`);
    observedSchedule.add(scheduledGapMs);
    finiteNumber(observation.actualGapMs, `idle[${index}].actualGapMs`);
    if (typeof observation.activationFirst !== "boolean") fail("activation-first", `idle observation ${index} needs activation.first`);
    const scriptVersion = nonEmptyString(observation.scriptVersion, `idle[${index}].scriptVersion`);
    const colo = nonEmptyString(observation.colo, `idle[${index}].colo`);
    const reference = evidenceReference(observation.requestId, traceIndex, `activation[${index}]`);
    if (rootBoolean(reference, "activation.first", `activation[${index}]`) !== observation.activationFirst) {
      fail("activation-trace-activation-first", `idle observation ${index} activation.first differs from trace ${reference.requestId}`);
    }
    if (rootString(reference, "script.version", `activation[${index}]`) !== scriptVersion) {
      fail("activation-trace-script-version", `idle observation ${index} scriptVersion differs from trace ${reference.requestId}`);
    }
    if (rootString(reference, "colo", `activation[${index}]`) !== colo) {
      fail("activation-trace-colo", `idle observation ${index} colo differs from trace ${reference.requestId}`);
    }
    if (typeof observation.previousComplete !== "boolean") fail("idle-ledger", `idle observation ${index} needs previousComplete`);
    const lowerBound = observation.observedIdleGapLowerBoundMs;
    if (observation.previousComplete === false && lowerBound !== null) {
      fail("idle-ledger", `idle observation ${index} must leave an incomplete prior gap null`);
    }
    if (observation.previousComplete === true && (typeof lowerBound !== "number" || !Number.isFinite(lowerBound) || lowerBound < 0)) {
      fail("idle-ledger", `idle observation ${index} needs a non-negative complete-ledger lower bound`);
    }
    if (!REACTIVATION_CAUSES.has(observation.reactivationCause)) {
      fail("reactivation-cause", `idle observation ${index} has an unsupported reactivation cause`);
    }
    if (observation.storageWrites !== 0 || observation.usedForControl !== false || observation.exposedInPublicResponse !== false) {
      fail("activation-isolation", `idle observation ${index} records activation data outside observation-only scope`);
    }
  }
  if (!same([...observedSchedule].sort((left, right) => left - right), G30_IDLE_SCHEDULE_MS)) {
    fail("idle-schedule", "activation/idle evidence does not cover every required gap");
  }
  return Object.freeze({ scheduleMs: G30_IDLE_SCHEDULE_MS, observations: evidence.observations.length });
}

function evidenceObjects(outlier, hypothesis) {
  if (!Array.isArray(outlier.rawEvidence) || outlier.rawEvidence.length === 0) {
    fail("outlier-evidence", `${hypothesis} lacks raw evidence`);
  }
  return outlier.rawEvidence.map((entry, index) => {
    const evidence = object(entry);
    if (evidence === undefined) fail("outlier-evidence", `${hypothesis} raw evidence ${index} must be an object`);
    return evidence;
  });
}

function assertWorkerIsolateEvidence(evidence, reference) {
  nonEmptyString(evidence.isolateInstanceId, "worker-isolate-first.isolateInstanceId");
  if (typeof evidence.firstInvocation !== "boolean") fail("outlier-evidence", "worker-isolate-first.firstInvocation must be boolean");
  if (nonEmptyString(evidence.rootVersion, "worker-isolate-first.rootVersion") !== rootString(reference, "script.version", "worker-isolate-first")) {
    fail("worker-isolate-trace-version", "worker-isolate-first rootVersion differs from its trace root");
  }
  if (nonEmptyString(evidence.colo, "worker-isolate-first.colo") !== rootString(reference, "colo", "worker-isolate-first")) {
    fail("worker-isolate-trace-colo", "worker-isolate-first colo differs from its trace root");
  }
  finiteNumber(evidence.cpuTimeMs, "worker-isolate-first.cpuTimeMs");
  finiteNumber(evidence.wallTimeMs, "worker-isolate-first.wallTimeMs");
  nonEmptyString(evidence.warmComparison, "worker-isolate-first.warmComparison");
}

function assertDurableObjectWakeEvidence(evidence) {
  nonEmptyString(evidence.actorClass, "durable-object-wake.actorClass");
  finiteNumber(evidence.idleGapMs, "durable-object-wake.idleGapMs");
  finiteNumber(evidence.constructorToHandlerMs, "durable-object-wake.constructorToHandlerMs");
  finiteNumber(evidence.firstStorageReadMs, "durable-object-wake.firstStorageReadMs");
  finiteNumber(evidence.subrequestWallMs, "durable-object-wake.subrequestWallMs");
  if (evidence.variedOneClass !== true) fail("outlier-evidence", "durable-object-wake must vary exactly one actor class");
}

function assertTokenRotationEvidence(evidence, disposition, references, traceIndex) {
  if (evidence.authBranch !== "synchronous-string-comparison") {
    fail("outlier-evidence", "token-rotation must record the synchronous auth branch");
  }
  nonEmptyString(evidence.deployedVersion, "token-rotation.deployedVersion");
  nonEmptyString(evidence.configDigest, "token-rotation.configDigest");
  finiteNumber(evidence.httpOutcome, "token-rotation.httpOutcome");
  if (Object.hasOwn(evidence, "refreshSpanPresent")) {
    fail("token-rotation-declaration", "token-rotation refreshSpanPresent is computed from exported traces, never operator-declared");
  }
  const refreshes = refreshRequestIds(traceIndex, "token-rotation");
  if (refreshes.size === 0 && disposition !== "excluded") {
    fail("token-rotation", "token rotation without an exported refresh span must be excluded from the commit path");
  }
  if (refreshes.size > 0 && disposition !== "attributed") {
    fail("token-rotation", "an exported refresh span must be attributed to token rotation");
  }
  if (refreshes.size > 0 && !references.some((reference) => refreshes.has(reference.requestId))) {
    fail("token-rotation", "token rotation must cite an exported trace that contains the refresh span");
  }
}

function assertQueueDoorbellEvidence(evidence, disposition, reference) {
  if (evidence.faultBarrier !== true) fail("outlier-evidence", "queue/doorbell evidence must use the fault barrier");
  const appendResponse = finiteNumber(evidence.appendResponse, "queue-doorbell-backpressure.appendResponse");
  const followingStateRead = finiteNumber(evidence.followingStateRead, "queue-doorbell-backpressure.followingStateRead");
  if (Object.hasOwn(evidence, "withinBound")) {
    fail("queue-bound-declaration", "queue/doorbell withinBound is computed from measured ledger and trace values, never operator-declared");
  }
  const traceRootLatency = rootDuration(reference, "queue-doorbell-backpressure");
  const ledgerResponseLatency = finiteNumber(reference.ledger?.responseLatencyMs, "queue-doorbell-backpressure.ledger.responseLatencyMs");
  if (appendResponse > ledgerResponseLatency || followingStateRead > ledgerResponseLatency || traceRootLatency > ledgerResponseLatency) {
    fail("queue-bound", "queue/doorbell measurements exceed the joined client-ledger response bound");
  }
  if (!["no-queue-difference", "same-tag-event-loop-or-input-ordering"].includes(evidence.classification)) {
    fail("queue-classification", "queue/doorbell evidence must not name queue backlog as the cause");
  }
  if (disposition !== "excluded") fail("queue-classification", "queue/doorbell is an exclusion probe, not an attributed queue-backlog cause");
}

/**
 * A single 21.5s outlier cannot be bucketed vaguely.  The evidence contains
 * one independently attributable-or-excluded record for every design
 * hypothesis, with the raw fields needed to reproduce that judgment.
 */
export function assertOutlierClassification(outliers, ledger, traces) {
  if (!Array.isArray(outliers) || outliers.length !== OUTLIER_HYPOTHESES.length) {
    fail("outliers", "outlier discrimination must contain exactly the four required hypotheses");
  }
  const traceIndex = evidenceTraceIndex(ledger, traces, "outlier");
  const seen = new Set();
  for (const outlier of outliers) {
    const hypothesis = outlier?.hypothesis;
    if (!OUTLIER_HYPOTHESIS_SET.has(hypothesis) || seen.has(hypothesis)) {
      fail("outlier", "outlier discrimination has an unsupported, collapsed, or duplicate hypothesis");
    }
    seen.add(hypothesis);
    if (outlier?.classified !== true || !["attributed", "excluded"].includes(outlier?.disposition)) {
      fail("outlier", `${hypothesis} must be explicitly attributed or excluded`);
    }
    const evidence = evidenceObjects(outlier, hypothesis);
    const references = evidence.map((entry, index) => evidenceReference(entry.requestId, traceIndex, `${hypothesis}[${index}]`));
    if (hypothesis === "worker-isolate-first") assertWorkerIsolateEvidence(evidence[0], references[0]);
    if (hypothesis === "durable-object-wake") assertDurableObjectWakeEvidence(evidence[0]);
    if (hypothesis === "token-rotation") assertTokenRotationEvidence(evidence[0], outlier.disposition, references, traceIndex);
    if (hypothesis === "queue-doorbell-backpressure") assertQueueDoorbellEvidence(evidence[0], outlier.disposition, references[0]);
  }
  if (!same([...seen].sort(), [...OUTLIER_HYPOTHESES].sort())) fail("outlier", "one or more required hypotheses is absent");
  return Object.freeze({ classifiedOutliers: seen.size, unclassifiedOutliers: 0 });
}

export function assertB0Evidence(evidence) {
  if (evidence?.task !== "SDT-G30" || evidence?.baseline !== "B0" || evidence?.purpose !== "attribution-only-not-g37-denominator") {
    fail("identity", "evidence must identify G30 B0 as attribution-only");
  }
  const phases = evidence.phases;
  const windows = Object.fromEntries(G30_PHASES.map((phase) => [phase, assertEligiblePhaseWindow(phase, phases?.[phase]?.ledger, phases?.[phase]?.rawAttempts)]));
  if (!same(windows.A.cohort, windows.B.cohort) || !same(windows.A.cohort, windows["A-prime"].cohort)) {
    fail("cohort-cross-phase", "A/B/A-prime cohort identity differs");
  }
  const config = assertPhaseConfiguration(phases);
  const warmup = Object.fromEntries(G30_PHASES.map((phase) => [phase, assertWarmupProof(phase, phases?.[phase]?.warmup)]));
  const traces = assertTraceCohort(phases.B.ledger, evidence.traces, evidence.traceExportCompletedAtMs);
  const latency = assertAaaDrift(phases.A.ledger, phases.B.ledger, phases["A-prime"].ledger);
  const activationIdle = assertActivationIdleEvidence(evidence.activationIdle, phases.B.ledger, evidence.traces);
  const outliers = assertOutlierClassification(evidence.outlierDiscrimination, phases.B.ledger, evidence.traces);
  return Object.freeze({ windows, config, warmup, traces, latency, activationIdle, outliers });
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
      "service.id": record.serviceId,
      "actor.class": row.emitter === "allocator-do" ? "ALLOCATOR" : "ROOT",
      operation: row.span,
      "span.kind": row.kind,
      outcome: "success",
      ...(face === "pre-admission" ? {} : { "attempt.id": `attempt-${record.requestId}`, "actor.key_hash": "a".repeat(64) }),
      ...(/^S05[a-e]$/.test(rowId) ? { "phase.ordinal": "abcde".indexOf(rowId.at(-1)) } : {}),
      ...(manifest.attributeMatrix.attributes["member.index"].rowScope?.includes(rowId) ? { "member.index": 0 } : {}),
      ...(manifest.attributeMatrix.attributes["tag.key_hash"].rowScope?.includes(rowId) ? { "tag.key_hash": "b".repeat(64) } : {}),
      ...(rowId === "S00" ? {
        "activation.first": Number(record.requestId.slice(record.requestId.lastIndexOf("-") + 1)) === 2,
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

function makeActivationIdle() {
  return {
    scheduleMs: [...G30_IDLE_SCHEDULE_MS],
    observations: G30_IDLE_SCHEDULE_MS.map((scheduledGapMs, index) => ({
      requestId: `b-${index}`,
      scheduledGapMs,
      actualGapMs: scheduledGapMs + index,
      activationFirst: index === 2,
      scriptVersion: "g30-synthetic",
      colo: "test-colo",
      previousComplete: index !== 0,
      observedIdleGapLowerBoundMs: index === 0 ? null : scheduledGapMs,
      reactivationCause: "unknown",
      storageWrites: 0,
      usedForControl: false,
      exposedInPublicResponse: false,
    })),
  };
}

function makeOutlierDiscrimination() {
  return [
    {
      hypothesis: "worker-isolate-first",
      disposition: "excluded",
      classified: true,
      rawEvidence: [{
        requestId: "b-10",
        isolateInstanceId: "isolate-synthetic",
        firstInvocation: true,
        rootVersion: "g30-synthetic",
        colo: "test-colo",
        cpuTimeMs: 1,
        wallTimeMs: 100,
        warmComparison: "warm roots held durable actors warm",
      }],
    },
    {
      hypothesis: "durable-object-wake",
      disposition: "excluded",
      classified: true,
      rawEvidence: [{
        requestId: "b-11",
        actorClass: "TAG",
        idleGapMs: 15_001,
        constructorToHandlerMs: 2,
        firstStorageReadMs: 3,
        subrequestWallMs: 5,
        variedOneClass: true,
      }],
    },
    {
      hypothesis: "token-rotation",
      disposition: "excluded",
      classified: true,
      rawEvidence: [{
        requestId: "b-12",
        authBranch: "synchronous-string-comparison",
        deployedVersion: "g30-synthetic",
        configDigest: "d".repeat(64),
        httpOutcome: 200,
      }],
    },
    {
      hypothesis: "queue-doorbell-backpressure",
      disposition: "excluded",
      classified: true,
      rawEvidence: [{
        requestId: "b-13",
        faultBarrier: true,
        appendResponse: 20,
        followingStateRead: 10,
        classification: "no-queue-difference",
      }],
    },
  ];
}

export function selfTest() {
  const a = makeRecords("A", 100);
  const b = makeRecords("B", 110);
  const prime = makeRecords("A-prime", 102);
  const baseConfig = { placement: "off", serviceId: "g32-9043d626fe1149cb", observability: { traces: { enabled: true, head_sampling_rate: 0 } } };
  const evidence = {
    task: "SDT-G30",
    baseline: "B0",
    purpose: "attribution-only-not-g37-denominator",
    phases: {
      A: { ledger: a, rawAttempts: [], configuration: baseConfig, warmup: { attempts: 5, source: "synthetic", actors: { WORKER: [false, false, false, false, false], BOOTSTRAP: [false, false, false, false, false], ALLOCATOR: [false, false, false, false, false], TAG: [false, false, false, false, false] } } },
      B: { ledger: b, rawAttempts: [], configuration: { ...baseConfig, deployedVersion: "on", observability: { traces: { enabled: true, head_sampling_rate: 1 } } }, warmup: { attempts: 5, source: "synthetic", actors: { WORKER: [false, false, false, false, false], BOOTSTRAP: [false, false, false, false, false], ALLOCATOR: [false, false, false, false, false], TAG: [false, false, false, false, false] } } },
      "A-prime": { ledger: prime, rawAttempts: [], configuration: { ...baseConfig, deployedVersion: "off-prime" }, warmup: { attempts: 5, source: "synthetic", actors: { WORKER: [false, false, false, false, false], BOOTSTRAP: [false, false, false, false, false], ALLOCATOR: [false, false, false, false, false], TAG: [false, false, false, false, false] } } },
    },
    traces: b.map(makeTrace),
    traceExportCompletedAtMs: b.at(-1).completedAtMs + 10,
    activationIdle: makeActivationIdle(),
    outlierDiscrimination: makeOutlierDiscrimination(),
  };
  assertB0Evidence(evidence);
  const failures = {};
  for (const [name, mutate, marker] of [
    ["trace-loss", (value) => { value.traces.pop(); }, "trace-count"],
    ["out-of-window-replacement", (value) => { value.phases.B.ledger[99].replacement = true; }, "window-eligibility"],
    ["sampling-delta", (value) => { value.phases.B.configuration.placement = "smart"; }, "placement"],
    ["unattributed", (value) => {
      for (const span of value.traces[0].spans) {
        if (span.rowId !== "S00") span.endMs = span.startMs + 1;
      }
    }, "unattributed"],
    ["outlier-unclassified", (value) => { value.outlierDiscrimination[0].classified = false; }, "outlier"],
    ["outlier-collapsed", (value) => { value.outlierDiscrimination[1].hypothesis = "worker-isolate-first"; }, "outlier"],
    ["outlier-evidence-free", (value) => { delete value.outlierDiscrimination[0].rawEvidence[0].warmComparison; }, "string"],
    ["outlier-raw-evidence-missing", (value) => { value.outlierDiscrimination[0].rawEvidence = []; }, "outlier-evidence"],
    ["idle-schedule", (value) => { value.activationIdle.scheduleMs[2] = 179_000; }, "idle-schedule"],
    ["activation-storage", (value) => { value.activationIdle.observations[0].storageWrites = 1; }, "activation-isolation"],
    ["activation-unknown-request", (value) => { value.activationIdle.observations[0].requestId = "missing-request"; }, "activation[0]-trace-join"],
    ["activation-first-mismatch", (value) => { value.activationIdle.observations[0].activationFirst = !value.activationIdle.observations[0].activationFirst; }, "activation-trace-activation-first"],
    ["activation-script-version-mismatch", (value) => { value.activationIdle.observations[0].scriptVersion = "different-script"; }, "activation-trace-script-version"],
    ["activation-colo-mismatch", (value) => { value.activationIdle.observations[0].colo = "different-colo"; }, "activation-trace-colo"],
    ["token-refresh-declaration", (value) => { value.outlierDiscrimination[2].rawEvidence[0].refreshSpanPresent = true; }, "token-rotation-declaration"],
    ["outlier-unknown-request", (value) => { value.outlierDiscrimination[0].rawEvidence[0].requestId = "missing-request"; }, "worker-isolate-first[0]-trace-join"],
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
