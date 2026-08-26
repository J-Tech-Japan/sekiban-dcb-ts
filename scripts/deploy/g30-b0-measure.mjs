#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const SAMPLE_COUNT = 100;
const CADENCE_MS = 2_000;
// AC7 permits a bounded number of *new* windows after an indeterminate
// request. It never permits resending the indeterminate request itself.
export const MAX_WINDOW_RESETS = 5;
const IDLE_SCHEDULE_MS = Object.freeze([2_000, 15_000, 180_000]);
const FIXTURE_VERSION = "sdt-g30-b0-v1";
const FIXTURE_TAG = "room:g30-baseline";
const SORTABLE_UNIQUE_ID = /^\d{30}$/;
// Worker version activation and the secret bundled with it are eventually
// consistent at the edge.  Retry only the unauthenticated first point read;
// any real conformance/read failure retains its exact response and stops.
export const CONFORMANCE_RETRY_ATTEMPTS = 15;
export const CONFORMANCE_RETRY_DELAY_MS = 1_000;
// Use a registered Meeting Room event rather than a synthetic payload so the
// exact same B0 command crosses the production admission parser as well as
// the normal commit path. The payload deliberately carries no discriminator.
const FIXTURE_PAYLOAD = JSON.stringify({ roomId: "g30-baseline", name: "SDT-G30 attribution baseline" });

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function sha(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function redactEvidenceText(value) {
  if (typeof value !== "string") return value;
  return value
    .replaceAll(FIXTURE_TAG, "[redacted-tag]")
    .replaceAll(FIXTURE_PAYLOAD, "[redacted-payload]")
    .replaceAll(encodedPayload(), "[redacted-payload]")
    .replace(/Bearer\s+[^\s"'}]+/gi, "Bearer [redacted]");
}

function redactEvidenceValue(value) {
  if (typeof value === "string") return redactEvidenceText(value);
  if (Array.isArray(value)) return value.map(redactEvidenceValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
      key,
      /^(?:authorization|token|tag)$/i.test(key) ? "[redacted]" : redactEvidenceValue(nested),
    ]));
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function encodedPayload() {
  return Buffer.from(FIXTURE_PAYLOAD, "utf8").toString("base64");
}

function eventCandidates() {
  return [{ payload: encodedPayload(), eventPayloadName: "RoomCreated", tags: [FIXTURE_TAG] }];
}

/**
 * The trace-completeness window deliberately exercises the normal
 * consistency-reservation fan-out. The expected head is external client
 * state, updated from each accepted response; it is not a phase config or a
 * G30 protocol extension.
 */
export function commitEnvelope(consistencyHead) {
  if (typeof consistencyHead !== "string" || !SORTABLE_UNIQUE_ID.test(consistencyHead)) {
    throw new Error("G30 B0 consistency head must be a 30-digit SortableUniqueId");
  }
  return {
    version: 1,
    eventCandidates: eventCandidates(),
    consistencyTags: [{ tag: FIXTURE_TAG, lastSortableUniqueId: consistencyHead }],
  };
}

function seedEnvelope() {
  return { version: 1, eventCandidates: eventCandidates(), consistencyTags: [] };
}

async function request(baseUrl, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-cache");
  const startedAtMs = Date.now();
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, { ...init, headers, cache: "no-store" });
  // Capture this at the response boundary, rather than after parsing the
  // body, so a failed fixed-tag read has an exact provider-response time.
  const receivedAtMs = Date.now();
  const raw = await response.text();
  let body;
  try { body = raw.length === 0 ? {} : JSON.parse(raw); } catch { body = { raw }; }
  return {
    response,
    body,
    raw,
    startedAtMs,
    receivedAtMs,
    receivedAt: new Date(receivedAtMs).toISOString(),
  };
}

function requestId(response) {
  const value = response.headers.get("cf-ray");
  if (typeof value !== "string" || value.length === 0) throw new Error("Cloudflare did not return cf-ray; cannot create a 1:1 client/trace ledger");
  return value;
}

function nullableRequestId(response) {
  const value = response.headers.get("cf-ray");
  return typeof value === "string" && value.length > 0 ? value : null;
}

function responseEvidence(result) {
  return Object.freeze({
    status: result.response.status,
    cfRay: nullableRequestId(result.response),
    startedAtMs: result.startedAtMs,
    receivedAtMs: result.receivedAtMs,
    receivedAt: result.receivedAt,
    body: redactEvidenceValue(result.body),
    rawBody: redactEvidenceText(result.raw),
  });
}

function transportEvidence(error, startedAtMs) {
  const receivedAtMs = Date.now();
  return Object.freeze({
    errorClass: error instanceof Error ? error.name : typeof error,
    // A transport failure has no HTTP body to retain. Keep only a scrubbed
    // message so a fetch implementation cannot turn credentials into evidence.
    message: redactEvidenceText(error instanceof Error ? error.message : String(error)),
    startedAtMs,
    receivedAtMs,
    receivedAt: new Date(receivedAtMs).toISOString(),
  });
}

function assertCommit(result) {
  if (result.response.status !== 200 || !Array.isArray(result.body?.writtenEvents) || result.body.writtenEvents.length === 0) {
    throw new Error(`G30 B0 commit was not an eligible non-empty HTTP-200 result: ${JSON.stringify({ status: result.response.status, body: result.body })}`);
  }
  return result.body.writtenEvents[0];
}

function nextConsistencyHead(result) {
  const event = assertCommit(result);
  const head = event?.sortableUniqueIdValue;
  if (typeof head !== "string" || !SORTABLE_UNIQUE_ID.test(head)) {
    throw new Error("G30 B0 commit response lacks a 30-digit written-event SortableUniqueId");
  }
  return Object.freeze({ event, head });
}

export class G30HeadReadFailure extends Error {
  constructor(record) {
    super(`G30 B0 could not read the fixed tag head: HTTP ${record.response.status}`);
    this.name = "G30HeadReadFailure";
    this.record = Object.freeze(record);
  }
}

/**
 * A B0 phase can only continue after a non-200/transport outcome by starting
 * a fresh eligible window from a durable fixed-tag reread.  This error carries
 * the complete redacted reset trail when that cannot be done safely (or when
 * AC7's reset bound is exceeded).
 */
export class G30PhaseMeasurementFailure extends Error {
  constructor(record) {
    super(`G30 B0 ${record.phase} phase cannot continue safely: ${record.reason}`);
    this.name = "G30PhaseMeasurementFailure";
    this.record = Object.freeze(record);
  }
}

function headReadFailure(result) {
  return new G30HeadReadFailure({
    task: "SDT-G30",
    kind: "fixed-tag-head-read-failure",
    endpoint: "/conformance/v1/api/sekiban/serialized/tag-latest-sortable",
    capturedAt: result.receivedAt,
    response: {
      status: result.response.status,
      cfRay: result.response.headers.get("cf-ray"),
      receivedAtMs: result.receivedAtMs,
      receivedAt: result.receivedAt,
      // The authenticated conformance error detail is retained in both its
      // parsed and original form. The request body and credential are never
      // part of this record.
      body: result.body,
      rawBody: result.raw,
    },
  });
}

function successfulHeadReadEvidence(result, head) {
  return Object.freeze({
    kind: "fixed-tag-head-reread",
    endpoint: "/conformance/v1/api/sekiban/serialized/tag-latest-sortable",
    head,
    statusRaw: {
      httpStatus: result.response.status,
      cfRay: nullableRequestId(result.response),
      receivedAtMs: result.receivedAtMs,
      receivedAt: result.receivedAt,
    },
  });
}

async function readConsistencyHeadRecord(baseUrl, token) {
  const result = await request(baseUrl, "/conformance/v1/api/sekiban/serialized/tag-latest-sortable", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ tag: FIXTURE_TAG }),
  });
  if (result.response.status !== 200 || typeof result.body?.exists !== "boolean" || typeof result.body?.lastSortableUniqueId !== "string") {
    throw headReadFailure(result);
  }
  if (result.body.exists === false) {
    if (result.body.lastSortableUniqueId !== "") throw new Error("G30 B0 empty fixed tag read must carry the V1 empty head");
    return Object.freeze({ head: undefined, evidence: successfulHeadReadEvidence(result, undefined) });
  }
  if (!SORTABLE_UNIQUE_ID.test(result.body.lastSortableUniqueId)) {
    throw new Error("G30 B0 fixed tag head is not a 30-digit SortableUniqueId");
  }
  return Object.freeze({ head: result.body.lastSortableUniqueId, evidence: successfulHeadReadEvidence(result, result.body.lastSortableUniqueId) });
}

async function readConsistencyHeadRecordAfterConformancePropagation(baseUrl, token, attempts, delayMs) {
  let lastFailure;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await readConsistencyHeadRecord(baseUrl, token);
    } catch (error) {
      // A fresh file-fed token may reach a newly deployed version a few edge
      // seconds before that version's secret is visible.  Never retry a
      // successful authentication with an application failure: those errors
      // carry the attribution detail required for fail-closed evidence.
      if (!(error instanceof G30HeadReadFailure) || error.record.response.status !== 403 || attempt === attempts) {
        throw error;
      }
      lastFailure = error;
      await sleep(delayMs);
    }
  }
  throw lastFailure;
}

async function readConsistencyHeadAfterConformancePropagation(baseUrl, token, attempts, delayMs) {
  return (await readConsistencyHeadRecordAfterConformancePropagation(baseUrl, token, attempts, delayMs)).head;
}

/**
 * Persist the full authenticated conformance failure before the runbook exits.
 * This is deliberately limited to the fixed-tag point read: no request tag,
 * request body, or conformance credential is written to evidence.
 */
export function buildHeadReadFailureEvidence({ phase, sourceCommit, configDigest }, failure) {
  if (!(failure instanceof G30HeadReadFailure)) throw new Error("G30 B0 failure evidence requires a fixed-tag head-read failure");
  return Object.freeze({
    ...failure.record,
    phase,
    sourceCommit,
    configDigest,
  });
}

export function writeHeadReadFailureEvidence(output, context, failure) {
  const evidence = buildHeadReadFailureEvidence(context, failure);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return evidence;
}

export function buildPhaseMeasurementFailureEvidence({ phase, sourceCommit, configDigest }, failure) {
  if (!(failure instanceof G30PhaseMeasurementFailure)) throw new Error("G30 B0 failure evidence requires a phase measurement failure");
  return Object.freeze({
    ...failure.record,
    phase,
    sourceCommit,
    configDigest,
  });
}

export function writePhaseMeasurementFailureEvidence(output, context, failure) {
  const evidence = buildPhaseMeasurementFailureEvidence(context, failure);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return evidence;
}

/**
 * Reuse the fixed tag when it already has a durable head. On a genuinely new
 * service only, establish that head once before phase A's warmup; the seed is
 * outside all A/B/A-prime ledgers and is never a replacement.
 */
export async function establishB0Consistency({
  baseUrl,
  token,
  conformanceRetryAttempts = CONFORMANCE_RETRY_ATTEMPTS,
  conformanceRetryDelayMs = CONFORMANCE_RETRY_DELAY_MS,
}) {
  const attempts = positiveInteger("G30 conformance retry attempts", conformanceRetryAttempts);
  const delayMs = nonNegativeInteger("G30 conformance retry delay", conformanceRetryDelayMs);
  const existingHead = await readConsistencyHeadAfterConformancePropagation(baseUrl, token, attempts, delayMs);
  if (existingHead !== undefined) {
    return Object.freeze({ head: existingHead, source: "existing-fixed-tag-head", seeded: false });
  }
  const result = await request(baseUrl, "/conformance/v1/api/sekiban/serialized/commit", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(seedEnvelope()),
  });
  const committed = nextConsistencyHead(result);
  return Object.freeze({
    head: committed.head,
    source: "one-time-fixed-tag-seed",
    seeded: true,
    seedEventId: typeof committed.event?.id === "string" ? committed.event.id : null,
  });
}

export function assertDeploymentWitness(witness, phase, sourceCommit, configDigest) {
  if (
    witness?.task !== "SDT-G30" || witness?.phase !== phase || witness?.sourceCommit !== sourceCommit ||
    witness?.configDigest !== configDigest || witness?.placement !== "off" ||
    typeof witness?.serviceId !== "string" || witness.serviceId.length === 0 ||
    typeof witness?.worker !== "string" || witness.worker.length === 0 ||
    typeof witness?.deployedVersion?.id !== "string" || witness.deployedVersion.id.length === 0 ||
    !Number.isSafeInteger(witness?.deployedVersion?.number) ||
    typeof witness?.deployedVersion?.createdOn !== "string" || witness.deployedVersion.createdOn.length === 0 ||
    witness?.deployedVersion?.message !== `SDT-G30 B0 ${phase} ${witness.serviceId} ${sourceCommit} ${configDigest}`
  ) throw new Error("G30 external deployment witness is invalid");
  return witness;
}

function classifyReadback(expectedConsistencyHead, observedConsistencyHead) {
  if (observedConsistencyHead === undefined) return "empty";
  if (observedConsistencyHead === expectedConsistencyHead) return "unchanged";
  return observedConsistencyHead > expectedConsistencyHead ? "advanced" : "regressed";
}

function discardedWindowAttempt(entry, resetNumber) {
  return Object.freeze({
    kind: "discarded-window-entry",
    resetNumber,
    priorWindowOrdinal: entry.index,
    // Preserve the original raw client ledger entry outside the new canonical
    // window. It is evidence of the reset, never a replacement sample.
    record: entry,
  });
}

async function measuredCommitAttempt(baseUrl, endpoint, authorization, consistencyHead) {
  const startedAtMs = Date.now();
  try {
    const result = await request(baseUrl, endpoint, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify(commitEnvelope(consistencyHead)),
    });
    if (result.response.status === 200) return Object.freeze({ kind: "http-200", result });
    return Object.freeze({
      kind: "ineligible",
      trigger: Object.freeze({
        trigger: "http-non-200",
        expectedConsistencyHead: consistencyHead,
        response: responseEvidence(result),
      }),
    });
  } catch (error) {
    return Object.freeze({
      kind: "ineligible",
      trigger: Object.freeze({
        trigger: "transport-error",
        expectedConsistencyHead: consistencyHead,
        transport: transportEvidence(error, startedAtMs),
      }),
    });
  }
}

function measurementFailure({ phase, sourceCommit, configDigest, endpoint, reason, resetCount, rawAttempts, expectedConsistencyHead, readback }) {
  return new G30PhaseMeasurementFailure({
    task: "SDT-G30",
    kind: "phase-window-reset-failure",
    phase,
    sourceCommit,
    configDigest,
    endpoint,
    reason,
    resetCount,
    resetLimit: MAX_WINDOW_RESETS,
    expectedConsistencyHead,
    rawAttempts,
    ...(readback === undefined ? {} : { readback }),
    capturedAt: new Date().toISOString(),
  });
}

/**
 * Sends the exact same V1 payload/tag fixture at a fixed 2-second schedule.
 * The body carries no G30 diagnostic extension.  cf-ray is a platform header
 * used solely to join the independent client ledger to Cloudflare telemetry.
 */
export async function measureB0Phase({
  baseUrl,
  token,
  phase,
  sourceCommit,
  configDigest,
  deploymentWitness,
  consistencyHead,
  samples = SAMPLE_COUNT,
  warmup = 5,
  sleepFor = sleep,
  conformanceRetryAttempts = CONFORMANCE_RETRY_ATTEMPTS,
  conformanceRetryDelayMs = CONFORMANCE_RETRY_DELAY_MS,
}) {
  if (!["A", "B", "A-prime"].includes(phase)) throw new Error("G30 phase must be A, B, or A-prime");
  if (samples !== SAMPLE_COUNT) throw new Error(`G30 B0 requires exactly ${SAMPLE_COUNT} retained samples`);
  if (!Number.isSafeInteger(warmup) || warmup < 5 || warmup > 30) throw new Error("G30 warmup must be 5..30 requests");
  if (typeof consistencyHead !== "string" || !SORTABLE_UNIQUE_ID.test(consistencyHead)) throw new Error("G30 B0 phase requires the observed fixed-tag consistency head");
  const readbackAttempts = positiveInteger("G30 conformance retry attempts", conformanceRetryAttempts);
  const readbackDelayMs = nonNegativeInteger("G30 conformance retry delay", conformanceRetryDelayMs);
  const authorization = { authorization: `Bearer ${token}` };
  const configWitness = assertDeploymentWitness(deploymentWitness, phase, sourceCommit, configDigest);
  const endpoint = "/conformance/v1/api/sekiban/serialized/commit";
  const initialConsistencyHead = consistencyHead;
  let expectedConsistencyHead = consistencyHead;
  const warmupLedger = [];
  for (let index = 0; index < warmup; index += 1) {
    const startedAtMs = Date.now();
    const result = await request(baseUrl, endpoint, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify(commitEnvelope(expectedConsistencyHead)),
    });
    const completedAtMs = Date.now();
    const committed = nextConsistencyHead(result);
    warmupLedger.push({ index, requestId: requestId(result.response), startedAtMs, completedAtMs, eventId: committed.event.id ?? null, status: result.response.status, consistencyHead: expectedConsistencyHead });
    expectedConsistencyHead = committed.head;
    await sleepFor(CADENCE_MS);
  }
  let fixedStartMs = Date.now() + CADENCE_MS;
  const ledger = [];
  const rawAttempts = [];
  let windowResets = 0;

  const resetEligibleWindow = async (trigger) => {
    const resetNumber = windowResets + 1;
    const discarded = ledger.splice(0, ledger.length);
    rawAttempts.push(...discarded.map((entry) => discardedWindowAttempt(entry, resetNumber)));
    const reset = {
      kind: "window-reset-trigger",
      resetNumber,
      priorWindowCount: discarded.length,
      sameAttemptResent: false,
      ...trigger,
    };
    rawAttempts.push(reset);

    let reread;
    try {
      reread = await readConsistencyHeadRecordAfterConformancePropagation(baseUrl, token, readbackAttempts, readbackDelayMs);
    } catch (error) {
      reset.readback = error instanceof G30HeadReadFailure
        ? { result: "failed", failure: error.record }
        : { result: "failed", errorClass: error instanceof Error ? error.name : typeof error, message: redactEvidenceText(error instanceof Error ? error.message : String(error)) };
      throw measurementFailure({
        phase,
        sourceCommit,
        configDigest,
        endpoint,
        reason: "durable-fixed-tag-reread-failed-after-indeterminate-attempt",
        resetCount: resetNumber,
        rawAttempts,
        expectedConsistencyHead,
        readback: reset.readback,
      });
    }

    const classification = classifyReadback(expectedConsistencyHead, reread.head);
    reset.readback = { ...reread.evidence, classification };
    // A new attempt may follow only a non-regressing durable authority. An
    // advanced head is evidence that state progressed, not a claim that the
    // indeterminate request itself landed; we never resend that request.
    if (classification === "empty" || classification === "regressed") {
      throw measurementFailure({
        phase,
        sourceCommit,
        configDigest,
        endpoint,
        reason: `durable-fixed-tag-reread-${classification}-after-indeterminate-attempt`,
        resetCount: resetNumber,
        rawAttempts,
        expectedConsistencyHead,
        readback: reset.readback,
      });
    }
    windowResets = resetNumber;
    if (windowResets > MAX_WINDOW_RESETS) {
      throw measurementFailure({
        phase,
        sourceCommit,
        configDigest,
        endpoint,
        reason: "window-reset-limit-exceeded",
        resetCount: windowResets,
        rawAttempts,
        expectedConsistencyHead,
        readback: reset.readback,
      });
    }
    expectedConsistencyHead = reread.head;
    // The new 100-request window starts only after durable reread. No failed
    // attempt occupies an index in the retained cadence.
    fixedStartMs = Date.now() + CADENCE_MS;
  };

  while (ledger.length < samples) {
    const index = ledger.length;
    const scheduledStartMs = fixedStartMs + index * CADENCE_MS;
    await sleepFor(scheduledStartMs - Date.now());
    const attempt = await measuredCommitAttempt(baseUrl, endpoint, authorization, expectedConsistencyHead);
    if (attempt.kind === "ineligible") {
      await resetEligibleWindow(attempt.trigger);
      continue;
    }
    const result = attempt.result;
    const startedAtMs = result.startedAtMs;
    const completedAtMs = Date.now();
    const committed = nextConsistencyHead(result);
    ledger.push({
      index,
      requestId: requestId(result.response),
      status: result.response.status,
      eligible: true,
      nonEmpty: true,
      replacement: false,
      serviceId: configWitness.serviceId,
      clientRegion: process.env.G30_CLIENT_REGION ?? "unspecified-client-region",
      tagSetDigest: sha(FIXTURE_TAG),
      payloadDigest: sha(FIXTURE_PAYLOAD),
      fixtureVersion: FIXTURE_VERSION,
      scheduledStartMs,
      startedAtMs,
      completedAtMs,
      responseLatencyMs: completedAtMs - startedAtMs,
      eventId: typeof committed.event?.id === "string" ? committed.event.id : null,
      committedSuid: committed.head,
      consistencyHead: expectedConsistencyHead,
      statusRaw: { httpStatus: result.response.status, cfRay: requestId(result.response) },
    });
    expectedConsistencyHead = committed.head;
  }
  // B is the sole trace-sampled phase.  Its idle experiment is a sequence of
  // real V1 commits whose previous/next request ids and timestamps are
  // retained. The B0 contract derives gaps from these records; no caller may
  // supply a claimed activation or idle result.
  let idleExperiment;
  if (phase === "B") {
    const requests = [];
    const windows = [];
    let previous = ledger.at(-1);
    if (previous === undefined) throw new Error("G30 B idle experiment requires a retained canonical request");
    for (const scheduledGapMs of IDLE_SCHEDULE_MS) {
      await sleepFor(scheduledGapMs);
      const startedAtMs = Date.now();
      const result = await request(baseUrl, endpoint, {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify(commitEnvelope(expectedConsistencyHead)),
      });
      const completedAtMs = Date.now();
      const committed = nextConsistencyHead(result);
      const next = {
        requestId: requestId(result.response),
        status: result.response.status,
        startedAtMs,
        completedAtMs,
        responseLatencyMs: completedAtMs - startedAtMs,
        eventId: typeof committed.event?.id === "string" ? committed.event.id : null,
        committedSuid: committed.head,
        consistencyHead: expectedConsistencyHead,
        statusRaw: { httpStatus: result.response.status, cfRay: requestId(result.response) },
      };
      expectedConsistencyHead = committed.head;
      requests.push(next);
      windows.push({
        scheduledGapMs,
        previousRequestId: previous.requestId,
        nextRequestId: next.requestId,
      });
      previous = next;
    }
    idleExperiment = Object.freeze({ scheduleMs: IDLE_SCHEDULE_MS, requests, windows });
  }
  return {
    task: "SDT-G30",
    phase,
    capturedAt: new Date().toISOString(),
    endpoint,
    deploymentWitness: configWitness,
    fixture: { version: FIXTURE_VERSION, payloadDigest: sha(FIXTURE_PAYLOAD), tagSetDigest: sha(FIXTURE_TAG), rawValues: "redacted-from-trace; fixed values are defined in the runbook source" },
    consistency: { tagSetDigest: sha(FIXTURE_TAG), initialHead: initialConsistencyHead, finalHead: expectedConsistencyHead, authority: "previous accepted fixed-tag response" },
    configuration: {
      serviceId: configWitness.serviceId,
      placement: configWitness.placement,
      deployedVersion: configWitness.deployedVersion.id,
      sourceCommit,
      configDigest,
      // The deployed config file is the authority for this value.  It is
      // deliberately not mirrored through a phase-specific Worker variable:
      // A(off)->B(on)->A'(off) may change sampling, but no diagnostic runtime
      // config is permitted to vary with the phase.
      observability: { traces: { enabled: true, head_sampling_rate: phase === "B" ? 1 : 0 } },
    },
    warmup: { requested: warmup, requests: warmupLedger },
    rawAttempts,
    windowResets,
    ledger,
    ...(idleExperiment === undefined ? {} : { idleExperiment }),
  };
}

async function main() {
  const baseUrl = required("--base-url", argument("--base-url", process.env.G30_BASE_URL));
  const token = readFileSync(required("--token-file", argument("--token-file", process.env.G30_CONFORMANCE_TOKEN_FILE)), "utf8").trim();
  const phase = required("--phase", argument("--phase"));
  const sourceCommit = required("--source-commit", argument("--source-commit", process.env.G30_SOURCE_COMMIT));
  const configDigest = required("--config-digest", argument("--config-digest", process.env.G30_CONFIG_DIGEST));
  const deploymentWitness = JSON.parse(readFileSync(required("--deployment-witness", argument("--deployment-witness")), "utf8"));
  if (token.length === 0) throw new Error("G30 conformance token is empty");
  const conformanceRetryAttempts = positiveInteger(
    "--conformance-retry-attempts",
    argument("--conformance-retry-attempts", String(CONFORMANCE_RETRY_ATTEMPTS)),
  );
  const conformanceRetryDelayMs = nonNegativeInteger(
    "--conformance-retry-delay-ms",
    argument("--conformance-retry-delay-ms", String(CONFORMANCE_RETRY_DELAY_MS)),
  );
  const output = argument("--output", `.artifacts/g30-b0-${phase}.json`);
  const failureOutput = argument("--failure-output", process.env.G30_B0_FAILURE_OUTPUT);
  // Each phase starts by reading the durable tag state again.  A local file
  // could be stale after an interrupted phase, whereas this indexed point
  // read is the actual admission authority for the next sequential command.
  try {
    const established = await establishB0Consistency({
      baseUrl,
      token,
      conformanceRetryAttempts,
      conformanceRetryDelayMs,
    });
    const measured = await measureB0Phase({
      baseUrl,
      token,
      phase,
      sourceCommit,
      configDigest,
      deploymentWitness,
      consistencyHead: established.head,
      conformanceRetryAttempts,
      conformanceRetryDelayMs,
    });
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(measured, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ phase, samples: measured.ledger.length, firstRequestId: measured.ledger[0]?.requestId ?? null, consistency: established.source }, null, 2));
  } catch (error) {
    if (failureOutput !== undefined && error instanceof G30HeadReadFailure) {
      const evidence = writeHeadReadFailureEvidence(failureOutput, { phase, sourceCommit, configDigest }, error);
      console.error(`G30 B0 saved fixed-tag head-read failure evidence to ${failureOutput} (HTTP ${evidence.response.status}; cf-ray ${evidence.response.cfRay ?? "absent"})`);
    }
    if (failureOutput !== undefined && error instanceof G30PhaseMeasurementFailure) {
      const evidence = writePhaseMeasurementFailureEvidence(failureOutput, { phase, sourceCommit, configDigest }, error);
      console.error(`G30 B0 saved window-reset failure evidence to ${failureOutput} (${evidence.reason}; resets ${evidence.resetCount}/${evidence.resetLimit})`);
    }
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
