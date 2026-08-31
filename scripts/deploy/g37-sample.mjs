#!/usr/bin/env node
/**
 * Lightweight SDT-G37 latency sampler, including the SDT-G47 history-length
 * profile.
 *
 * This intentionally does not reuse the SDT-G30 B0 ceremony: it sends one
 * bounded sequential client window(s), waits a short fixed telemetry settlement,
 * and reports trace loss descriptively.  The G30 exporter is reused only for
 * its exact CF-Ray -> correlation -> traceId join and schema normalization.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  clientRequestIdByPlatformRayId,
  exportCohortTelemetry,
  normalizeTelemetryBundle,
} from "./g30-trace-export.mjs";

const DEFAULT_SAMPLE_COUNT = 50;
const MAX_SAMPLE_COUNT = 100;
const DEFAULT_SETTLE_MS = 60_000;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const READY_RETRY_MS = 2_000;
const HISTORY_LENGTH_PROFILE = "history-length";
const SHORT_HISTORY_LENGTH = 1;
const LONG_HISTORY_LENGTH = 5_000;
const SEED_BATCH_SIZE = 500;
const SERVICE_ID = "g32-9043d626fe1149cb";
const FIXTURE_TAG = "room:g37-speedup";
const FIXTURE_PAYLOAD = JSON.stringify({ roomId: "g37-speedup", name: "SDT-G37 hop-reduction sample" });
const SUID = /^\d{30}$/;

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name, value, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer in 1..${maximum}`);
  }
  return parsed;
}

function nonNegativeInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function sha(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function redact(value, additionalValues = []) {
  if (typeof value !== "string") return value;
  const values = [
    [FIXTURE_TAG, "[redacted-tag]"],
    [FIXTURE_PAYLOAD, "[redacted-payload]"],
    [Buffer.from(FIXTURE_PAYLOAD, "utf8").toString("base64"), "[redacted-payload]"],
    ...additionalValues.filter((candidate) => typeof candidate === "string" && candidate.length > 0)
      .map((candidate) => [candidate, "[redacted-profile-value]"]),
  ];
  let result = value;
  for (const [candidate, replacement] of values) result = result.replaceAll(candidate, replacement);
  return result
    .replace(/Bearer\s+[^\s"'}]+/gi, "Bearer [redacted]");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] ?? null;
}

function summary(values) {
  return Object.freeze({
    count: values.length,
    p50: percentile(values, 0.50),
    p95: percentile(values, 0.95),
  });
}

function requestIdentity(response) {
  const value = response.headers.get("cf-ray");
  if (typeof value !== "string" || value.length === 0) throw new Error("G37 sample response lacks cf-ray");
  const suffix = value.lastIndexOf("-");
  return Object.freeze({
    requestId: value,
    colo: suffix < 0 ? null : value.slice(suffix + 1).toUpperCase() || null,
  });
}

function requestId(response) {
  return requestIdentity(response).requestId;
}

async function request(baseUrl, path, init) {
  const startedAtMs = Date.now();
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, { ...init, cache: "no-store" });
  const completedAtMs = Date.now();
  const raw = await response.text();
  let body;
  try {
    body = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    body = { raw: redact(raw) };
  }
  return { response, body, startedAtMs, completedAtMs };
}

function eventCandidates(tag = FIXTURE_TAG, payload = FIXTURE_PAYLOAD, count = 1) {
  const encodedPayload = Buffer.from(payload, "utf8").toString("base64");
  return Array.from({ length: count }, () => ({
    payload: encodedPayload,
    eventPayloadName: "RoomCreated",
    tags: [tag],
  }));
}

function commitEnvelope(head, tag = FIXTURE_TAG, payload = FIXTURE_PAYLOAD, candidateCount = 1) {
  return {
    version: 1,
    eventCandidates: eventCandidates(tag, payload, candidateCount),
    consistencyTags: head === undefined ? [] : [{ tag, lastSortableUniqueId: head }],
  };
}

function assertedCommit(result, expectedCount = 1, redactionValues = []) {
  const events = Array.isArray(result.body?.writtenEvents) ? result.body.writtenEvents : [];
  const event = events.at(-1);
  const suid = event?.sortableUniqueIdValue;
  if (result.response.status !== 200 || events.length !== expectedCount || typeof suid !== "string" || !SUID.test(suid)) {
    const error = new Error(`G37 sample commit is not an eligible HTTP 200 (HTTP ${result.response.status})`);
    error.evidence = Object.freeze({
      status: result.response.status,
      cfRay: result.response.headers.get("cf-ray"),
      startedAtMs: result.startedAtMs,
      completedAtMs: result.completedAtMs,
      expectedWrittenEventCount: expectedCount,
      actualWrittenEventCount: events.length,
      body: JSON.parse(JSON.stringify(result.body, (_key, value) => typeof value === "string" ? redact(value, redactionValues) : value)),
    });
    throw error;
  }
  return suid;
}

async function readHeadObservation(baseUrl, token, tag = FIXTURE_TAG) {
  const result = await request(baseUrl, "/conformance/v1/api/sekiban/serialized/tag-latest-sortable", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ tag }),
  });
  if (result.response.status !== 200 || typeof result.body?.exists !== "boolean" || typeof result.body?.lastSortableUniqueId !== "string") {
    const error = new Error(`G37 sample tag head read failed (HTTP ${result.response.status})`);
    error.evidence = Object.freeze({
      status: result.response.status,
      cfRay: result.response.headers.get("cf-ray"),
      startedAtMs: result.startedAtMs,
      completedAtMs: result.completedAtMs,
      body: JSON.parse(JSON.stringify(result.body, (_key, value) => typeof value === "string" ? redact(value, [tag]) : value)),
    });
    throw error;
  }
  if (result.body.exists && !SUID.test(result.body.lastSortableUniqueId)) throw new Error("G37 sample tag head is not a 30-digit SUID");
  return Object.freeze({
    exists: result.body.exists,
    head: result.body.exists ? result.body.lastSortableUniqueId : undefined,
    requestId: requestId(result.response),
    colo: requestIdentity(result.response).colo,
    startedAtMs: result.startedAtMs,
    completedAtMs: result.completedAtMs,
    clientLatencyMs: result.completedAtMs - result.startedAtMs,
    status: result.response.status,
  });
}

async function readHead(baseUrl, token, tag = FIXTURE_TAG) {
  return (await readHeadObservation(baseUrl, token, tag)).head;
}

/**
 * A just-deployed Worker can briefly return a platform 5xx while its new
 * version activates.  Sampling begins only after the authenticated read
 * path is ready, while retaining each transient failure as evidence instead
 * of silently treating it as a client latency observation.
 */
async function waitForReadyHead(baseUrl, token, timeoutMs, tag = FIXTURE_TAG) {
  const startedAtMs = Date.now();
  const failures = [];
  for (;;) {
    try {
      const head = await readHead(baseUrl, token, tag);
      return Object.freeze({
        head,
        attempts: failures.length + 1,
        ...(failures.length === 0 ? {} : { transientFailures: Object.freeze(failures) }),
      });
    } catch (error) {
      const evidence = error instanceof Error && "evidence" in error
        ? error.evidence
        : undefined;
      const status = typeof evidence === "object" && evidence !== null && "status" in evidence
        ? evidence.status
        : undefined;
      if (typeof status !== "number" || status < 500 || Date.now() - startedAtMs >= timeoutMs) throw error;
      failures.push(Object.freeze({
        status,
        cfRay: typeof evidence === "object" && evidence !== null && "cfRay" in evidence ? evidence.cfRay : null,
        observedAtMs: Date.now(),
      }));
      await sleep(READY_RETRY_MS);
    }
  }
}

function perHopMedians(traces) {
  const durationsByRow = new Map();
  for (const trace of traces) {
    for (const span of trace.spans ?? []) {
      if (!Number.isFinite(span?.startMs) || !Number.isFinite(span?.endMs) || typeof span?.rowId !== "string") continue;
      const durations = durationsByRow.get(span.rowId) ?? [];
      durations.push(Math.max(0, span.endMs - span.startMs));
      durationsByRow.set(span.rowId, durations);
    }
  }
  return Object.freeze([...durationsByRow.entries()]
    .map(([rowId, durations]) => Object.freeze({ rowId, observedSpanCount: durations.length, medianMs: percentile(durations, 0.50) }))
    .sort((left, right) => left.rowId.localeCompare(right.rowId)));
}

function workerColos(observations) {
  const counts = new Map();
  for (const observation of observations) {
    if (observation?.event !== "worker.invocation" || typeof observation?.colo !== "string") continue;
    counts.set(observation.colo, (counts.get(observation.colo) ?? 0) + 1);
  }
  return Object.freeze(Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right))));
}

function deploymentWitness(priorVersions, versions, message) {
  const priorIds = new Set(priorVersions.map((version) => version?.id).filter((id) => typeof id === "string"));
  const matches = versions.filter((version) =>
    !priorIds.has(version?.id) && version?.annotations?.["workers/message"] === message,
  );
  if (matches.length !== 1) throw new Error(`G37 expected one newly deployed version for message; found ${matches.length}`);
  const version = matches[0];
  return Object.freeze({
    id: version.id,
    number: version.number,
    createdOn: version?.metadata?.created_on,
    message,
  });
}

async function telemetryForLedger({ accountId, observabilityToken, observabilityTokenReason, template, ledger }) {
  if (typeof observabilityToken !== "string" || observabilityToken.length === 0) {
    return Object.freeze({
      status: "unavailable",
      ac4PerHopStatus: "UNKNOWN",
      reason: `${observabilityTokenReason ?? "G37 observability token file is unavailable"}; per-hop telemetry was not queried, so AC4 per-hop values are UNKNOWN.`,
      descriptiveLossCount: null,
      perHopDescriptiveMedians: [],
    });
  }
  try {
    const earliest = Math.min(...ledger.map((entry) => entry.startedAtMs));
    const latest = Math.max(...ledger.map((entry) => entry.completedAtMs));
    const query = structuredClone(template);
    query.timeframe = { from: Math.max(0, earliest - 60_000), to: latest + 5 * 60_000 };
    const raw = await exportCohortTelemetry({ accountId, token: observabilityToken, template: query, ledger });
    const bundle = normalizeTelemetryBundle(raw, Date.now(), clientRequestIdByPlatformRayId(ledger));
    const observedRequestIds = new Set(bundle.traces.map((trace) => trace.requestId));
    const completeTraceCount = bundle.traces.filter((trace) => trace.complete === true && trace.runtimeVerified === true).length;
    return Object.freeze({
      queryWindow: query.timeframe,
      observedTraceCount: observedRequestIds.size,
      schemaCompleteTraceCount: completeTraceCount,
      descriptiveLossCount: ledger.length - observedRequestIds.size,
      workerColoDistribution: workerColos(bundle.observations),
      perHopDescriptiveMedians: perHopMedians(bundle.traces),
    });
  } catch (error) {
    return Object.freeze({
      status: "unavailable",
      ac4PerHopStatus: "UNKNOWN",
      reason: redact(error instanceof Error ? error.message : String(error)),
      descriptiveLossCount: null,
      perHopDescriptiveMedians: [],
    });
  }
}

export async function captureG37Sample({
  baseUrl,
  token,
  accountId,
  observabilityToken,
  observabilityTokenReason,
  template,
  candidate,
  sourceCommit,
  sampleCount = DEFAULT_SAMPLE_COUNT,
  settleMs = DEFAULT_SETTLE_MS,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  deployment,
}) {
  const readiness = await waitForReadyHead(baseUrl, token, readyTimeoutMs);
  const establishedHead = readiness.head;
  let head = establishedHead;
  let seed;
  if (head === undefined) {
    const result = await request(baseUrl, "/conformance/v1/api/sekiban/serialized/commit", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(commitEnvelope(undefined)),
    });
    head = assertedCommit(result);
    seed = Object.freeze({ status: result.response.status, cfRay: requestId(result.response), excludedFromSample: true });
  }

  const ledger = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const result = await request(baseUrl, "/conformance/v1/api/sekiban/serialized/commit", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(commitEnvelope(head)),
    });
    const committedSuid = assertedCommit(result);
    ledger.push(Object.freeze({
      ordinal: index + 1,
      requestId: requestId(result.response),
      startedAtMs: result.startedAtMs,
      completedAtMs: result.completedAtMs,
      clientLatencyMs: result.completedAtMs - result.startedAtMs,
      status: result.response.status,
    }));
    head = committedSuid;
  }

  await sleep(settleMs);
  const telemetry = await telemetryForLedger({ accountId, observabilityToken, observabilityTokenReason, template, ledger });

  return Object.freeze({
    task: "SDT-G37",
    candidate,
    sourceCommit,
    capturedAt: new Date().toISOString(),
    serviceId: SERVICE_ID,
    sampleCount: ledger.length,
    fixture: Object.freeze({ tagDigest: sha(FIXTURE_TAG), payloadDigest: sha(FIXTURE_PAYLOAD), rawValues: "redacted" }),
    readiness,
    ...(seed === undefined ? {} : { seed }),
    deployment,
    client: summary(ledger.map((entry) => entry.clientLatencyMs)),
    telemetry,
    ledger,
  });
}

function profileTag(candidate, label) {
  const safeCandidate = candidate.replace(/[^a-z0-9._-]/gi, "-").slice(0, 48);
  return `room:sdt-g47-${safeCandidate}-${label}`;
}

function profilePayload(candidate, label, ordinal) {
  const safeCandidate = candidate.replace(/[^a-z0-9._-]/gi, "-").slice(0, 48);
  return JSON.stringify({
    roomId: `sdt-g47-${safeCandidate}-${label}`,
    name: `SDT-G47 ${label} history sample ${ordinal}`,
  });
}

function clientColoDistribution(ledger) {
  const counts = new Map();
  for (const entry of ledger) {
    const colo = typeof entry?.colo === "string" && entry.colo.length > 0 ? entry.colo : "UNKNOWN";
    counts.set(colo, (counts.get(colo) ?? 0) + 1);
  }
  return Object.freeze(Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right))));
}

async function readTagStateObservation(baseUrl, token, tag) {
  const result = await request(baseUrl, "/conformance/v1/api/sekiban/serialized/tag-state", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ tagStateId: `${tag}:RoomProjector` }),
  });
  const identity = requestIdentity(result.response);
  return Object.freeze({
    body: result.body,
    requestId: identity.requestId,
    colo: identity.colo,
    startedAtMs: result.startedAtMs,
    completedAtMs: result.completedAtMs,
    clientLatencyMs: result.completedAtMs - result.startedAtMs,
    status: result.response.status,
  });
}

function assertedTagStateRead(result, tag, payload) {
  if (
    result.status !== 200 ||
    typeof result.body?.payload !== "string" ||
    !Number.isSafeInteger(result.body?.version) ||
    typeof result.body?.lastSortedUniqueId !== "string" ||
    result.body?.tagProjector !== "RoomProjector"
  ) {
    const error = new Error(`G47 TagState read is not an eligible HTTP 200 (HTTP ${result.status})`);
    error.evidence = Object.freeze({
      status: result.status,
      cfRay: result.requestId,
      startedAtMs: result.startedAtMs,
      completedAtMs: result.completedAtMs,
      body: JSON.parse(JSON.stringify(result.body, (_key, value) => typeof value === "string" ? redact(value, [tag, payload]) : value)),
    });
    throw error;
  }
  return result;
}

async function completeColdTagStateReplay({ baseUrl, token, tag, payload, historyLength }) {
  const startedAtMs = Date.now();
  const observations = [];
  const maxReads = Math.ceil(historyLength / 64) + 2;
  for (let attempt = 1; attempt <= maxReads; attempt += 1) {
    const result = await readTagStateObservation(baseUrl, token, tag);
    observations.push(result);
    if (result.status === 200) {
      assertedTagStateRead(result, tag, payload);
      const completedAtMs = result.completedAtMs;
      return Object.freeze({
        informational: true,
        historyLength,
        sourcePageLimit: 64,
        requestCount: observations.length,
        rebuildInProgressResponseCount: observations.filter((entry) => entry.status === 503).length,
        firstResponseStatus: observations[0].status,
        finalResponseStatus: result.status,
        startedAtMs,
        completedAtMs,
        durationMs: completedAtMs - startedAtMs,
        clientColoDistribution: clientColoDistribution(observations),
      });
    }
    if (result.status !== 503 || result.body?.code !== "tag_state_rebuild_in_progress") {
      assertedTagStateRead(result, tag, payload);
    }
  }
  throw new Error(`G47 cold TagState replay did not reach READY within ${maxReads} bounded reads (${historyLength} events)`);
}

async function seedHistory({ baseUrl, token, candidate, tag, payload, historyLength }) {
  const initialRead = await readHeadObservation(baseUrl, token, tag);
  if (initialRead.exists) {
    throw new Error(`G47 history tag already exists; exact history length cannot be established (${tag})`);
  }

  let head;
  let remaining = historyLength;
  let offset = 0;
  const batches = [];
  while (remaining > 0) {
    const batchCount = Math.min(remaining, SEED_BATCH_SIZE);
    const result = await request(baseUrl, "/conformance/v1/api/sekiban/serialized/commit", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(commitEnvelope(head, tag, payload, batchCount)),
    });
    const nextHead = assertedCommit(result, batchCount, [tag, payload]);
    const identity = requestIdentity(result.response);
    batches.push(Object.freeze({
      ordinal: batches.length + 1,
      firstHistoryOrdinal: offset + 1,
      lastHistoryOrdinal: offset + batchCount,
      writtenEventCount: batchCount,
      status: result.response.status,
      requestId: identity.requestId,
      colo: identity.colo,
      startedAtMs: result.startedAtMs,
      completedAtMs: result.completedAtMs,
      clientLatencyMs: result.completedAtMs - result.startedAtMs,
    }));
    head = nextHead;
    offset += batchCount;
    remaining -= batchCount;
  }

  return Object.freeze({
    requestedHistoryLength: historyLength,
    committedHistoryLength: offset,
    seedBatchSize: SEED_BATCH_SIZE,
    seedBatchCount: batches.length,
    initialHeadRead: Object.freeze({
      exists: initialRead.exists,
      status: initialRead.status,
      requestId: initialRead.requestId,
      colo: initialRead.colo,
      clientLatencyMs: initialRead.clientLatencyMs,
      excludedFromSample: true,
    }),
    batches: Object.freeze(batches),
    candidate,
  });
}

async function captureHistoryLengthWindow({
  baseUrl,
  token,
  accountId,
  observabilityToken,
  observabilityTokenReason,
  template,
  candidate,
  sampleCount,
  settleMs,
  tag,
  payload,
  historyLength,
  label,
}) {
  const seed = await seedHistory({ baseUrl, token, candidate, tag, payload, historyLength });
  const coldReplay = await completeColdTagStateReplay({ baseUrl, token, tag, payload, historyLength });
  const warmupRead = await readTagStateObservation(baseUrl, token, tag);
  assertedTagStateRead(warmupRead, tag, payload);

  // This is deliberately exactly one successful READY read after the cold
  // replay and before the sampled reads. Its result is discarded; its
  // duration is retained separately from the sampled client latencies.
  const warmup = Object.freeze({
    endpoint: "/conformance/v1/api/sekiban/serialized/tag-state",
    kind: "single discarded READY warm-up read",
    stateRead: "TagStateDO",
    discardedResponse: true,
    status: warmupRead.status,
    requestId: warmupRead.requestId,
    colo: warmupRead.colo,
    startedAtMs: warmupRead.startedAtMs,
    completedAtMs: warmupRead.completedAtMs,
    clientLatencyMs: warmupRead.clientLatencyMs,
    historyLengthBeforeWindow: historyLength,
  });

  const ledger = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const result = await readTagStateObservation(baseUrl, token, tag);
    assertedTagStateRead(result, tag, payload);
    ledger.push(Object.freeze({
      ordinal: index + 1,
      requestId: result.requestId,
      colo: result.colo,
      startedAtMs: result.startedAtMs,
      completedAtMs: result.completedAtMs,
      clientLatencyMs: result.clientLatencyMs,
      status: result.status,
      historyLengthBefore: historyLength + index,
      historyLengthAfter: historyLength + index,
    }));
  }

  await sleep(settleMs);
  const telemetry = await telemetryForLedger({
    accountId,
    observabilityToken,
    observabilityTokenReason,
    template,
    ledger,
  });
  return Object.freeze({
    label,
    tagDigest: sha(tag),
    payloadDigest: sha(payload),
    rawValues: "redacted",
    historyLengthBeforeWindow: historyLength,
    historyLengthAfterWindow: historyLength,
    sampleCount: ledger.length,
    seed,
    coldReplay,
    warmup,
    client: summary(ledger.map((entry) => entry.clientLatencyMs)),
    clientColoDistribution: clientColoDistribution(ledger),
    telemetry,
    ledger,
  });
}

export async function captureG47HistoryLengthSample({
  baseUrl,
  token,
  accountId,
  observabilityToken,
  observabilityTokenReason,
  template,
  candidate,
  sourceCommit,
  sampleCount = DEFAULT_SAMPLE_COUNT,
  settleMs = DEFAULT_SETTLE_MS,
  deployment,
}) {
  const shortTag = profileTag(candidate, "short");
  const longTag = profileTag(candidate, "long");
  const shortPayload = profilePayload(candidate, "short", 1);
  const longPayload = profilePayload(candidate, "long", 1);
  const shortWindow = await captureHistoryLengthWindow({
    baseUrl,
    token,
    accountId,
    observabilityToken,
    observabilityTokenReason,
    template,
    candidate,
    sampleCount,
    settleMs,
    tag: shortTag,
    payload: shortPayload,
    historyLength: SHORT_HISTORY_LENGTH,
    label: "short",
  });
  const longWindow = await captureHistoryLengthWindow({
    baseUrl,
    token,
    accountId,
    observabilityToken,
    observabilityTokenReason,
    template,
    candidate,
    sampleCount,
    settleMs,
    tag: longTag,
    payload: longPayload,
    historyLength: LONG_HISTORY_LENGTH,
    label: "long",
  });
  const p50DifferenceMs = longWindow.client.p50 - shortWindow.client.p50;
  const p95DifferenceMs = longWindow.client.p95 - shortWindow.client.p95;
  const colos = new Set([
    ...Object.keys(shortWindow.clientColoDistribution),
    ...Object.keys(longWindow.clientColoDistribution),
  ]);
  return Object.freeze({
    task: "SDT-G47",
    profile: HISTORY_LENGTH_PROFILE,
    candidate,
    sourceCommit,
    capturedAt: new Date().toISOString(),
    serviceId: SERVICE_ID,
    sampleCount,
    deployment,
    protocol: Object.freeze({
      deploymentCount: 1,
      session: "one sequential g37-sample.mjs process",
      windows: ["short", "long"],
      discardedWarmupsPerWindow: 1,
      measurement: "client latency of authenticated TagStateDO reads",
      warmCondition: "the bounded cold replay reached READY, then exactly one TagStateDO read was discarded before the sampled window",
      historyLengths: Object.freeze({ short: SHORT_HISTORY_LENGTH, long: LONG_HISTORY_LENGTH }),
      clientColos: Object.freeze([...colos].sort()),
    }),
    windows: Object.freeze([shortWindow, longWindow]),
    comparison: Object.freeze({
      p50DifferenceMs,
      p95DifferenceMs,
      claim: colos.size === 1
        ? `for a WARM TagStateDO, the client p50/p95 difference between a 1-event and a 5000-event tag was ${p50DifferenceMs}/${p95DifferenceMs} ms.`
        : "Same-colo claim withdrawn because the client windows did not share one colo.",
      sameColo: colos.size === 1,
    }),
  });
}

async function main() {
  const baseUrl = required("--base-url", argument("--base-url", process.env.G37_BASE_URL));
  const token = readFileSync(required("--token-file", argument("--token-file", process.env.G37_CONFORMANCE_TOKEN_FILE)), "utf8").trim();
  const accountId = required("--account-id", argument("--account-id", process.env.CLOUDFLARE_ACCOUNT_ID));
  const profile = argument("--profile", process.env.G37_PROFILE ?? "single");
  const observabilityTokenFile = argument(
    "--observability-token-file",
    process.env.G37_OBSERVABILITY_TOKEN_FILE || process.env.G30_OBSERVABILITY_TOKEN_FILE,
  );
  let observabilityToken;
  let observabilityTokenReason;
  if (typeof observabilityTokenFile !== "string" || observabilityTokenFile.length === 0) {
    observabilityTokenReason = "G37 observability token file was not supplied";
  } else if (!existsSync(observabilityTokenFile)) {
    observabilityTokenReason = "G37 observability token file was not found";
  } else {
    try {
      observabilityToken = readFileSync(observabilityTokenFile, "utf8").trim();
      if (observabilityToken.length === 0) {
        observabilityToken = undefined;
        observabilityTokenReason = "G37 observability token file was empty";
      }
    } catch {
      observabilityToken = undefined;
      observabilityTokenReason = "G37 observability token file could not be read";
    }
  }
  const template = JSON.parse(readFileSync(argument("--query-template", "scripts/deploy/g37-observability-query.json"), "utf8"));
  const candidate = required("--candidate", argument("--candidate"));
  const sourceCommit = required("--source-commit", argument("--source-commit"));
  const sampleCount = positiveInteger("--samples", argument("--samples", String(DEFAULT_SAMPLE_COUNT)), MAX_SAMPLE_COUNT);
  const settleMs = nonNegativeInteger("--settle-ms", argument("--settle-ms", String(DEFAULT_SETTLE_MS)));
  const readyTimeoutMs = nonNegativeInteger("--ready-timeout-ms", argument("--ready-timeout-ms", String(DEFAULT_READY_TIMEOUT_MS)));
  const output = argument("--output", `.artifacts/g37-${candidate.replace(/[^a-z0-9._-]/gi, "-")}.json`);
  const priorVersionsPath = argument("--prior-versions");
  const versionsPath = argument("--versions");
  const deploymentMessage = argument("--deployment-message");
  if (token.length === 0) throw new Error("G37 conformance token file is empty");
  if (profile !== "single" && profile !== HISTORY_LENGTH_PROFILE) throw new Error(`Unknown G37 sampler profile: ${profile}`);
  if ([priorVersionsPath, versionsPath, deploymentMessage].some((value) => value !== undefined) &&
    [priorVersionsPath, versionsPath, deploymentMessage].some((value) => value === undefined)) {
    throw new Error("G37 deployment witness needs --prior-versions, --versions, and --deployment-message together");
  }
  const deployment = priorVersionsPath === undefined
    ? undefined
    : deploymentWitness(
      JSON.parse(readFileSync(priorVersionsPath, "utf8")),
      JSON.parse(readFileSync(versionsPath, "utf8")),
      deploymentMessage,
    );

  const sample = profile === HISTORY_LENGTH_PROFILE
    ? await captureG47HistoryLengthSample({
      baseUrl,
      token,
      accountId,
      observabilityToken,
      observabilityTokenReason,
      template,
      candidate,
      sourceCommit,
      sampleCount,
      settleMs,
      deployment,
    })
    : await captureG37Sample({
      baseUrl,
      token,
      accountId,
      observabilityToken,
      observabilityTokenReason,
      template,
      candidate,
      sourceCommit,
      sampleCount,
      settleMs,
      readyTimeoutMs,
      deployment,
    });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(sample, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    candidate,
    profile,
    samples: sample.sampleCount,
    ...(profile === HISTORY_LENGTH_PROFILE
      ? { comparison: sample.comparison, windows: sample.windows.map((window) => ({ label: window.label, client: window.client, telemetry: window.telemetry })) }
      : { client: sample.client, telemetry: sample.telemetry }),
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const detail = error instanceof Error && "evidence" in error ? error.evidence : undefined;
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), ...(detail === undefined ? {} : { evidence: detail }) }));
    process.exitCode = 1;
  });
}
