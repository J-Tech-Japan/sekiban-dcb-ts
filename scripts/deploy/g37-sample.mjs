#!/usr/bin/env node
/**
 * Lightweight SDT-G37 latency sampler.
 *
 * This intentionally does not reuse the SDT-G30 B0 ceremony: it sends one
 * bounded sequential client window, waits a short fixed telemetry settlement,
 * and reports trace loss descriptively.  The G30 exporter is reused only for
 * its exact CF-Ray -> correlation -> traceId join and schema normalization.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function redact(value) {
  if (typeof value !== "string") return value;
  return value
    .replaceAll(FIXTURE_TAG, "[redacted-tag]")
    .replaceAll(FIXTURE_PAYLOAD, "[redacted-payload]")
    .replaceAll(Buffer.from(FIXTURE_PAYLOAD, "utf8").toString("base64"), "[redacted-payload]")
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

function requestId(response) {
  const value = response.headers.get("cf-ray");
  if (typeof value !== "string" || value.length === 0) throw new Error("G37 sample response lacks cf-ray");
  return value;
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

function eventCandidates() {
  return [{
    payload: Buffer.from(FIXTURE_PAYLOAD, "utf8").toString("base64"),
    eventPayloadName: "RoomCreated",
    tags: [FIXTURE_TAG],
  }];
}

function commitEnvelope(head) {
  return {
    version: 1,
    eventCandidates: eventCandidates(),
    consistencyTags: head === undefined ? [] : [{ tag: FIXTURE_TAG, lastSortableUniqueId: head }],
  };
}

function assertedCommit(result) {
  const event = Array.isArray(result.body?.writtenEvents) ? result.body.writtenEvents[0] : undefined;
  const suid = event?.sortableUniqueIdValue;
  if (result.response.status !== 200 || typeof suid !== "string" || !SUID.test(suid)) {
    const error = new Error(`G37 sample commit is not an eligible HTTP 200 (HTTP ${result.response.status})`);
    error.evidence = Object.freeze({
      status: result.response.status,
      cfRay: result.response.headers.get("cf-ray"),
      startedAtMs: result.startedAtMs,
      completedAtMs: result.completedAtMs,
      body: JSON.parse(JSON.stringify(result.body, (_key, value) => typeof value === "string" ? redact(value) : value)),
    });
    throw error;
  }
  return suid;
}

async function readHead(baseUrl, token) {
  const result = await request(baseUrl, "/conformance/v1/api/sekiban/serialized/tag-latest-sortable", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ tag: FIXTURE_TAG }),
  });
  if (result.response.status !== 200 || typeof result.body?.exists !== "boolean" || typeof result.body?.lastSortableUniqueId !== "string") {
    const error = new Error(`G37 sample fixed-tag head read failed (HTTP ${result.response.status})`);
    error.evidence = Object.freeze({
      status: result.response.status,
      cfRay: result.response.headers.get("cf-ray"),
      startedAtMs: result.startedAtMs,
      completedAtMs: result.completedAtMs,
      body: JSON.parse(JSON.stringify(result.body, (_key, value) => typeof value === "string" ? redact(value) : value)),
    });
    throw error;
  }
  if (!result.body.exists) return undefined;
  if (!SUID.test(result.body.lastSortableUniqueId)) throw new Error("G37 sample fixed-tag head is not a 30-digit SUID");
  return result.body.lastSortableUniqueId;
}

/**
 * A just-deployed Worker can briefly return a platform 5xx while its new
 * version activates.  Sampling begins only after the authenticated read
 * path is ready, while retaining each transient failure as evidence instead
 * of silently treating it as a client latency observation.
 */
async function waitForReadyHead(baseUrl, token, timeoutMs) {
  const startedAtMs = Date.now();
  const failures = [];
  for (;;) {
    try {
      const head = await readHead(baseUrl, token);
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

export async function captureG37Sample({
  baseUrl,
  token,
  accountId,
  observabilityToken,
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
  let telemetry;
  try {
    const earliest = Math.min(...ledger.map((entry) => entry.startedAtMs));
    const latest = Math.max(...ledger.map((entry) => entry.completedAtMs));
    const query = structuredClone(template);
    query.timeframe = { from: Math.max(0, earliest - 60_000), to: latest + 5 * 60_000 };
    const raw = await exportCohortTelemetry({ accountId, token: observabilityToken, template: query, ledger });
    const bundle = normalizeTelemetryBundle(raw, Date.now(), clientRequestIdByPlatformRayId(ledger));
    const observedRequestIds = new Set(bundle.traces.map((trace) => trace.requestId));
    const completeTraceCount = bundle.traces.filter((trace) => trace.complete === true && trace.runtimeVerified === true).length;
    telemetry = Object.freeze({
      queryWindow: query.timeframe,
      observedTraceCount: observedRequestIds.size,
      schemaCompleteTraceCount: completeTraceCount,
      descriptiveLossCount: ledger.length - observedRequestIds.size,
      workerColoDistribution: workerColos(bundle.observations),
      perHopDescriptiveMedians: perHopMedians(bundle.traces),
    });
  } catch (error) {
    telemetry = Object.freeze({
      status: "unavailable",
      reason: redact(error instanceof Error ? error.message : String(error)),
      descriptiveLossCount: null,
      perHopDescriptiveMedians: [],
    });
  }

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

async function main() {
  const baseUrl = required("--base-url", argument("--base-url", process.env.G37_BASE_URL));
  const token = readFileSync(required("--token-file", argument("--token-file", process.env.G37_CONFORMANCE_TOKEN_FILE)), "utf8").trim();
  const accountId = required("--account-id", argument("--account-id", process.env.CLOUDFLARE_ACCOUNT_ID));
  const observabilityToken = readFileSync(required("--observability-token-file", argument("--observability-token-file", process.env.G37_OBSERVABILITY_TOKEN_FILE)), "utf8").trim();
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
  if (token.length === 0 || observabilityToken.length === 0) throw new Error("G37 token file is empty");
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

  const sample = await captureG37Sample({ baseUrl, token, accountId, observabilityToken, template, candidate, sourceCommit, sampleCount, settleMs, readyTimeoutMs, deployment });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(sample, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ candidate, samples: sample.sampleCount, client: sample.client, telemetry: sample.telemetry }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const detail = error instanceof Error && "evidence" in error ? error.evidence : undefined;
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), ...(detail === undefined ? {} : { evidence: detail }) }));
    process.exitCode = 1;
  });
}
