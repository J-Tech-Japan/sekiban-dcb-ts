#!/usr/bin/env node
/**
 * SDT-G52 retained-log resume sampler.
 *
 * A query-only resume is deliberately separate from the original 1+50
 * sampler.  Its only live read is `exportCohortTelemetry` constrained by the
 * immutable CF-Ray set saved while requests were accepted.  It has no route
 * that calls the application surface.  The paced fallback uses the same
 * persisted-state format, writes each acceptance before proceeding, and is
 * guarded to one cohort per state file.
 */
import { readFileSync } from "node:fs";
import {
  ACTIVE_PER_HOP_ROWS,
  captureG50AppCommitLatency,
  STRUCTURALLY_REMOVED_G41_ROWS,
} from "./deploy/g50-commit-latency.mjs";
import {
  clientRequestIdByPlatformRayId,
  exportCohortWindowTelemetry,
  normalizeTelemetryBundle,
  SNAPSHOT_LOG_DO_OWNED_ROWS,
} from "./g30-trace-export.mjs";

export const TASK = "SDT-G52";
export const RESUME_STATE_SCHEMA = "sdt-g52-resume-query-state/v1";
export const SAMPLE_COUNT = 50;
export const COHORT_REQUEST_COUNT = SAMPLE_COUNT + 1;
export const RESUME_THRESHOLD = 40;
export const RESUME_BOUND_MS = 24 * 60 * 60 * 1_000;
export const RESUME_INTERVAL_MS = 15 * 60 * 1_000;
export const PACED_SAMPLE_INTERVAL_MS = 10 * 1_000;
export const PACED_FALLBACK_DELAY_MS = 2 * 60 * 60 * 1_000;
// Per-hop snapshot timing is Worker-owned only. Tag member rows S07/S12/S14,
// allocator S09, and remote callback S16 are represented only by retained
// do.handler observations grouped by actorClass.
export const SNAPSHOT_PER_HOP_ROWS = Object.freeze(ACTIVE_PER_HOP_ROWS.filter(
  (rowId) => !SNAPSHOT_LOG_DO_OWNED_ROWS.includes(rowId),
));
export const WINDOWED_RESUME_QUERY_SCOPE = "persisted-cohort-window-standard-script-type-filters-client-side-exact-ray-intersection";
const HOP_WAIT = Object.freeze({
  S00: "the complete app-command commit window",
  S01: "request decoding and exact payload admission",
  S02: "BOOTSTRAP admission",
  S03: "BOOTSTRAP release",
  S06: "reservation fan-out settlement",
  S07: "one consistency-tag reservation",
  S08: "allocator vector allocation",
  S10: "final BOOTSTRAP fence before append",
  S11: "tag append fan-out settlement",
  S12: "one authoritative tag append",
  S13: "result-state fan-out settlement",
  S14: "one tag result-state read",
  S15: "response assembly after durable reads",
});

export function fail(message) {
  throw new Error(`g52-resume-query:${message}`);
}
export function required(name, value) {
  if (typeof value !== "string" || value.length === 0) fail(`${name} is required`);
  return value;
}

export function sourceCommit(value) {
  if (!/^[0-9a-f]{40}$/.test(value)) fail("source commit must be a 40-character lowercase SHA");
  return value;
}

export function runId(value) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(value)) fail("run id must be 8..64 URL-safe characters");
  return value;
}

export function finiteTimestamp(name, value) {
  if (!Number.isFinite(value)) fail(`${name} must be a finite timestamp`);
  return value;
}

function nearestRank(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] ?? null;
}

function clientSummary(ledger) {
  const values = ledger.map((entry) => entry.clientLatencyMs);
  return Object.freeze({ count: values.length, p50: nearestRank(values, 0.5), p95: nearestRank(values, 0.95) });
}

function callerColoDistribution(ledger) {
  const counts = new Map();
  for (const entry of ledger) {
    const colo = typeof entry?.colo === "string" && entry.colo.length > 0 ? entry.colo : "UNKNOWN";
    counts.set(colo, (counts.get(colo) ?? 0) + 1);
  }
  return Object.freeze(Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right))));
}

function uniqueRequestIds(ledger, label) {
  if (!Array.isArray(ledger) || ledger.length === 0) fail(`${label} must contain one or more ledger rows`);
  const seen = new Set();
  for (const [index, entry] of ledger.entries()) {
    if (typeof entry?.requestId !== "string" || entry.requestId.length === 0) fail(`${label}[${index}] lacks a CF-Ray`);
    if (seen.has(entry.requestId)) fail(`${label} repeats a CF-Ray`);
    seen.add(entry.requestId);
  }
  return Object.freeze([...seen]);
}

function isSchemaCompleteSnapshot(trace) {
  if (trace?.rootSource !== "snapshot-log" || trace?.snapshotLogTruncated !== false || trace?.complete !== true || trace?.runtimeVerified !== true) {
    return false;
  }
  const rows = new Set((trace?.spans ?? []).map((span) => span?.rowId));
  return SNAPSHOT_PER_HOP_ROWS.every((rowId) => rows.has(rowId));
}

function perHopMedians(traces) {
  const byRow = new Map();
  for (const trace of traces) {
    for (const span of trace?.spans ?? []) {
      if (!SNAPSHOT_PER_HOP_ROWS.includes(span?.rowId) || !Number.isFinite(span?.startMs) || !Number.isFinite(span?.endMs)) continue;
      const values = byRow.get(span.rowId) ?? [];
      values.push(Math.max(0, span.endMs - span.startMs));
      byRow.set(span.rowId, values);
    }
  }
  return Object.freeze(SNAPSHOT_PER_HOP_ROWS.map((rowId) => {
    const values = byRow.get(rowId) ?? [];
    return Object.freeze({ rowId, observedSpanCount: values.length, medianMs: nearestRank(values, 0.5) });
  }));
}

function doObservationMedians(observations, sampleRequestIds) {
  const byActor = new Map();
  for (const observation of observations ?? []) {
    if (observation?.event !== "do.handler" || !sampleRequestIds.has(observation?.requestId) || typeof observation?.actorClass !== "string") continue;
    const values = byActor.get(observation.actorClass) ?? {
      observationCount: 0,
      constructorToHandlerMs: [],
      firstStorageReadMs: [],
      subrequestWallMs: [],
    };
    values.observationCount += 1;
    for (const key of ["constructorToHandlerMs", "firstStorageReadMs", "subrequestWallMs"]) {
      if (Number.isFinite(observation[key])) values[key].push(observation[key]);
    }
    byActor.set(observation.actorClass, values);
  }
  return Object.freeze([...byActor.entries()].map(([actorClass, values]) => Object.freeze({
    actorClass,
    observationCount: values.observationCount,
    constructorToHandlerMs: nearestRank(values.constructorToHandlerMs, 0.5),
    firstStorageReadMs: nearestRank(values.firstStorageReadMs, 0.5),
    subrequestWallMs: nearestRank(values.subrequestWallMs, 0.5),
  })).sort((left, right) => left.actorClass.localeCompare(right.actorClass)));
}

function residualRanking(rows) {
  return Object.freeze(rows
    .filter((row) => Number.isFinite(row?.medianMs))
    .map((row) => Object.freeze({
      rowId: row.rowId,
      medianMs: row.medianMs,
      observedSpanCount: row.observedSpanCount,
      waitsOn: HOP_WAIT[row.rowId] ?? "the recorded trace boundary",
    }))
    .sort((left, right) => right.medianMs - left.medianMs || left.rowId.localeCompare(right.rowId)));
}

function stateDeadlineFromWarmup(warmup) {
  return finiteTimestamp("warmup.startedAtMs", warmup?.startedAtMs) + RESUME_BOUND_MS;
}

function expectedPacedState(state) {
  if (state?.schema !== RESUME_STATE_SCHEMA || state?.task !== TASK || state?.cohortKind !== "paced") {
    fail("state is not a paced SDT-G52 resume ledger");
  }
  if (state?.warmup?.phase !== "discarded-warmup" || state.warmup?.status !== 200) fail("paced state has no accepted discarded warm-up");
  if (!Array.isArray(state.ledger) || state.ledger.length !== SAMPLE_COUNT) fail("paced state must contain exactly 50 accepted requests");
  for (const [index, entry] of state.ledger.entries()) {
    if (entry?.ordinal !== index + 1 || entry?.phase !== "sample" || entry?.status !== 200) {
      fail(`paced ledger row ${index + 1} is not an accepted app-surface commit`);
    }
  }
  const all = Object.freeze([state.warmup, ...state.ledger]);
  const requestIds = uniqueRequestIds(all, "paced exact CF-Ray ledger");
  if (JSON.stringify(state.exactRaySet) !== JSON.stringify(requestIds)) fail("paced state exactRaySet does not match its immutable ledger");
  return Object.freeze({ all, requestIds, sampleRequestIds: new Set(state.ledger.map((entry) => entry.requestId)) });
}

/** A fresh empty state is persisted before the paced warm-up is sent. */
export function createPacedResumeState({
  baseUrl,
  accountId,
  serviceId,
  versionId,
  sourceCommit: deployedSourceCommit,
  runId: suppliedRunId,
  now = Date.now,
}) {
  const createdAtMs = finiteTimestamp("now", now());
  return Object.freeze({
    schema: RESUME_STATE_SCHEMA,
    task: TASK,
    cohortKind: "paced",
    runId: runId(suppliedRunId),
    createdAtMs,
    deployed: Object.freeze({
      baseUrl: required("baseUrl", baseUrl),
      accountId: required("accountId", accountId),
      serviceId: required("serviceId", serviceId),
      versionId: required("versionId", versionId),
      sourceCommit: sourceCommit(required("sourceCommit", deployedSourceCommit)),
    }),
    protocol: Object.freeze({
      appSurface: "POST /api/commands/create-room",
      requestMode: "one discarded accepted warm-up, then exactly 50 sequential accepted commits paced at least 10000 ms apart; no retries or replacements",
      discardedWarmupRequests: 1,
      acceptedSampleRequests: SAMPLE_COUNT,
      minimumSampleIntervalMs: PACED_SAMPLE_INTERVAL_MS,
      structurallyRemovedG41Rows: STRUCTURALLY_REMOVED_G41_ROWS,
    }),
    warmup: null,
    ledger: Object.freeze([]),
    exactRaySet: Object.freeze([]),
    resume: Object.freeze({
      lifecycle: "capturing-paced-cohort",
      threshold: RESUME_THRESHOLD,
      deadlineAtMs: null,
      nextQueryAtMs: null,
      queries: Object.freeze([]),
      firstSeenAtMsByRequestId: Object.freeze({}),
      latest: null,
    }),
  });
}

export function mutableCopy(value) {
  return structuredClone(value);
}

function updateExactRaySet(state) {
  const rows = state.warmup === null ? state.ledger : [state.warmup, ...state.ledger];
  state.exactRaySet = [...new Set(rows.map((entry) => entry?.requestId).filter((entry) => typeof entry === "string"))];
}

/**
 * Sends the single permitted paced cohort.  The state writer runs immediately
 * after the warm-up and after every accepted sample, before a subsequent
 * request is allowed to begin.
 */
export async function capturePacedCohort({
  state: initialState,
  persist,
  fetchImpl = globalThis.fetch,
  sleepFor,
  now,
}) {
  if (typeof persist !== "function") fail("persist must be a function");
  if (typeof fetchImpl !== "function") fail("fetchImpl must be a function");
  if (now !== undefined && typeof now !== "function") fail("now must be a function");
  const readNow = now ?? (() => Date.now());
  const state = mutableCopy(initialState);
  if (state.resume?.lifecycle !== "capturing-paced-cohort" || state.warmup !== null || state.ledger.length !== 0) {
    fail("paced cohort state is not empty; a replacement cohort is forbidden");
  }
  await persist(state);
  const base = await captureG50AppCommitLatency({
    baseUrl: state.deployed.baseUrl,
    accountId: state.deployed.accountId,
    observabilityToken: "resume-query-defers-telemetry-until-ledger-is-persisted",
    serviceId: state.deployed.serviceId,
    versionId: state.deployed.versionId,
    sourceCommit: state.deployed.sourceCommit,
    sampleCount: SAMPLE_COUNT,
    runId: state.runId,
    task: TASK,
    queryTemplate: {},
    fetchImpl,
    sampleIntervalMs: PACED_SAMPLE_INTERVAL_MS,
    ...(sleepFor === undefined ? {} : { sleepFor }),
    now: readNow,
    captureTelemetry: async () => Object.freeze({
      status: "deferred-to-resume-query",
      perHopDescriptiveMedians: Object.freeze([]),
      retainedTraceTelemetry: Object.freeze({ traces: Object.freeze([]), observations: Object.freeze([]) }),
    }),
    onWarmupAccepted: async (warmup) => {
      state.warmup = warmup;
      state.resume.deadlineAtMs = stateDeadlineFromWarmup(warmup);
      updateExactRaySet(state);
      await persist(state);
    },
    onSampleAccepted: async (entry) => {
      state.ledger.push(entry);
      updateExactRaySet(state);
      await persist(state);
    },
  });
  if (state.ledger.length !== SAMPLE_COUNT || base.ledger.length !== SAMPLE_COUNT) fail("paced cohort persistence did not receive exactly 50 accepted requests");
  if (JSON.stringify(state.ledger) !== JSON.stringify(base.ledger)) fail("paced persisted ledger differs from the accepted client ledger");
  state.client = clientSummary(state.ledger);
  state.callerColoDistribution = callerColoDistribution(state.ledger);
  state.cohortWindow = Object.freeze({
    from: state.warmup.startedAtMs,
    to: state.ledger.at(-1).completedAtMs,
  });
  state.resume.lifecycle = "ready-for-exact-ray-query";
  state.resume.nextQueryAtMs = readNow();
  await persist(state);
  return Object.freeze(state);
}

function queryWindowForLedger(ledger, nowMs) {
  const from = Math.min(...ledger.map((entry) => entry.startedAtMs)) - 60_000;
  const to = Math.max(...ledger.map((entry) => entry.completedAtMs), nowMs) + 60_000;
  return Object.freeze({ from: Math.max(0, from), to });
}

function latestFromBundle(state, bundle, queriedAtMs, resumeQuery, cohortDoHandlerObservations) {
  const { all, sampleRequestIds } = expectedPacedState(state);
  const requestById = new Map(all.map((entry) => [entry.requestId, entry]));
  const cohortRequestIds = new Set(all.map((entry) => entry.requestId));
  const sampleTraces = (bundle?.traces ?? []).filter((trace) => sampleRequestIds.has(trace?.requestId));
  const sampleSnapshotRoots = sampleTraces.filter((trace) => trace?.rootSource === "snapshot-log" && trace?.snapshotLogTruncated === false);
  const schemaComplete = sampleTraces.filter(isSchemaCompleteSnapshot);
  const missingSampleRequestIds = state.ledger
    .map((entry) => entry.requestId)
    .filter((requestId) => !schemaComplete.some((trace) => trace.requestId === requestId));
  const firstSeen = { ...(state.resume.firstSeenAtMsByRequestId ?? {}) };
  for (const trace of schemaComplete) {
    if (firstSeen[trace.requestId] === undefined) firstSeen[trace.requestId] = queriedAtMs;
  }
  state.resume.firstSeenAtMsByRequestId = firstSeen;
  const lagDistribution = Object.keys(firstSeen).sort().map((requestId) => Object.freeze({
    requestId,
    requestStartedAtMs: requestById.get(requestId)?.startedAtMs ?? null,
    firstSeenAtMs: firstSeen[requestId],
    firstSeenLagMs: Number.isFinite(requestById.get(requestId)?.startedAtMs)
      ? Math.max(0, firstSeen[requestId] - requestById.get(requestId).startedAtMs)
      : null,
    firstSeenDefinition: "first exact-CF-Ray resume query that observed a schema-complete snapshot root",
  }));
  const perHop = perHopMedians(schemaComplete);
  const observations = (bundle?.observations ?? []).filter((observation) => sampleRequestIds.has(observation?.requestId));
  const wholeCohortDoHandlers = Array.isArray(cohortDoHandlerObservations)
    ? cohortDoHandlerObservations
    : observations;
  const allRoots = (bundle?.traces ?? []).filter((trace) => trace?.rootSource === "snapshot-log" && trace?.snapshotLogTruncated === false);
  return Object.freeze({
    queriedAtMs,
    queryWindow: resumeQuery?.window ?? queryWindowForLedger(all, queriedAtMs),
    queryShape: resumeQuery?.shape ?? WINDOWED_RESUME_QUERY_SCOPE,
    telemetryQuery: resumeQuery ?? null,
    retainedInvocationRoots: allRoots.length,
    retainedSampleRoots: sampleSnapshotRoots.length,
    schemaCompleteSampleRoots: schemaComplete.length,
    missingSampleRequestIds: Object.freeze(missingSampleRequestIds),
    firstSeenLagDistribution: Object.freeze(lagDistribution),
    client: clientSummary(state.ledger),
    callerColoDistribution: callerColoDistribution(state.ledger),
    perHopDescriptiveMedians: perHop,
    doObservationSource: Array.isArray(cohortDoHandlerObservations)
      ? "sdt.observe/v1 do.handler from persisted cohort window with client-side exact-CF-Ray intersection"
      : "joined trace observations",
    doObservationCohortRequestCount: new Set(wholeCohortDoHandlers
      .filter((observation) => cohortRequestIds.has(observation?.requestId))
      .map((observation) => observation.requestId)).size,
    cohortDoHandlerObservations: Object.freeze(wholeCohortDoHandlers
      .filter((observation) => cohortRequestIds.has(observation?.requestId))),
    doObservationMedians: doObservationMedians(wholeCohortDoHandlers, cohortRequestIds),
    residualRanking: residualRanking(perHop),
    traces: Object.freeze(schemaComplete),
    observations: Object.freeze(observations),
    retentionRatio: Object.freeze({
      invocationRoots: Object.freeze({ retained: allRoots.length, sent: COHORT_REQUEST_COUNT }),
      snapshotRoots: Object.freeze({ retained: allRoots.length, sent: COHORT_REQUEST_COUNT }),
      acceptedSampleSchemaCompleteRoots: Object.freeze({ retained: schemaComplete.length, sent: SAMPLE_COUNT }),
    }),
  });
}

/**
 * Read only the exact persisted CF-Ray set.  No base URL, app route, or
 * request sender is accepted here, making a resume call incapable of sending
 * a replacement application request.
 */
export async function resumeExactRayQuery({
  state: originalState,
  accountId,
  token,
  template,
  now = Date.now,
  queryCohort = exportCohortWindowTelemetry,
  normalizeBundle = normalizeTelemetryBundle,
}) {
  if (typeof queryCohort !== "function" || typeof normalizeBundle !== "function") fail("resume query dependencies must be functions");
  const state = mutableCopy(originalState);
  const { all } = expectedPacedState(state);
  const queriedAtMs = finiteTimestamp("now", now());
  const window = state?.cohortWindow;
  if (!Number.isFinite(window?.from) || !Number.isFinite(window?.to) || window.to <= window.from) {
    fail("paced state has no valid persisted cohort window");
  }
  const raw = await queryCohort({
    accountId: required("accountId", accountId),
    token: required("observability token", token),
    template: structuredClone(template),
    ledger: all,
    fromMs: window.from,
    toMs: window.to,
  });
  const bundle = normalizeBundle(raw, queriedAtMs, clientRequestIdByPlatformRayId(all));
  const latest = latestFromBundle(state, bundle, queriedAtMs, raw?.resumeQuery, raw?.cohortDoHandlerObservations);
  const queryAttempt = Object.freeze({
    attempt: state.resume.queries.length + 1,
    queriedAtMs,
    queryScope: latest.queryShape,
    expectedSampleRequests: SAMPLE_COUNT,
    retainedSampleRoots: latest.retainedSampleRoots,
    schemaCompleteSampleRoots: latest.schemaCompleteSampleRoots,
    missingSampleRequestIds: latest.missingSampleRequestIds,
  });
  state.resume.queries.push(queryAttempt);
  state.resume.latest = latest;
  const deadline = finiteTimestamp("state resume deadline", state.resume.deadlineAtMs);
  if (latest.schemaCompleteSampleRoots >= RESUME_THRESHOLD) {
    state.resume.lifecycle = "threshold-reached";
    state.resume.nextQueryAtMs = null;
  } else if (queriedAtMs >= deadline) {
    state.resume.lifecycle = "deadline-partial";
    state.resume.nextQueryAtMs = null;
  } else {
    state.resume.lifecycle = "awaiting-resume-query";
    state.resume.nextQueryAtMs = Math.min(deadline, queriedAtMs + RESUME_INTERVAL_MS);
  }
  return Object.freeze(state);
}

export function readResumeState(path) {
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (state?.schema !== RESUME_STATE_SCHEMA) fail("resume state schema is invalid");
  return state;
}
