#!/usr/bin/env node
/**
 * SDT-G50 app-surface commit latency sampler.
 *
 * This is deliberately a small extension of the G37 sampling flow: it keeps
 * the exact CF-Ray -> correlation -> trace telemetry join, but drives the
 * deployed meeting-room app command rather than the authenticated conformance
 * endpoint. One accepted warm-up command is retained and excluded before the
 * exactly-N accepted client samples.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { summary, telemetryForLedger } from "./g37-sample.mjs";
import { DEFAULT_COHORT_INGESTION_TIMEOUT_MS } from "./g30-trace-export.mjs";
import { assertLiveTipIdentity, G99_TIP_SERVICE } from "./g99-tip-identity.mjs";

export const TASK = "SDT-G50";
export const DEFAULT_SAMPLE_COUNT = 50;
export const DEFAULT_INGESTION_TIMEOUT_MS = DEFAULT_COHORT_INGESTION_TIMEOUT_MS;
export const MAX_INGESTION_TIMEOUT_MS = 15 * 60 * 1_000;
export const ACTIVE_PER_HOP_ROWS = Object.freeze([
  "S00",
  "S01",
  "S02",
  "S03",
  "S06",
  "S07",
  "S08",
  "S09",
  "S10",
  "S11",
  "S12",
  "S13",
  "S14",
  "S15",
  "S16",
]);
export const STRUCTURALLY_REMOVED_G41_ROWS = Object.freeze(["S04", "S05a", "S05b", "S05c", "S05d"]);

function fail(message) {
  throw new Error(`g50-commit-latency:${message}`);
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) fail(`${name} is required`);
  return value;
}

function positiveInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < DEFAULT_SAMPLE_COUNT || parsed > 100) {
    fail(`${name} must be an integer in ${DEFAULT_SAMPLE_COUNT}..100`);
  }
  return parsed;
}

function boundedPositiveInteger(name, value, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) fail(`${name} must be an integer in 1..${maximum}`);
  return parsed;
}

function nonNegativeInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(`${name} must be a non-negative integer`);
  return parsed;
}

function sleepForInterval(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function safeRunId(value) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(value)) fail("--run-id must be 8..64 URL-safe characters");
  return value;
}

function sourceCommit(value) {
  if (!/^[0-9a-f]{40}$/.test(value)) fail("--source-commit must be a 40-character lowercase SHA");
  return value;
}

function measurementTask(value) {
  if (typeof value !== "string" || !/^SDT-G\d+$/.test(value)) fail("task must be an SDT-G task identifier");
  return value;
}

function responseIdentity(response) {
  const requestId = response.headers.get("cf-ray");
  if (typeof requestId !== "string" || requestId.length === 0) fail("app command response lacks cf-ray");
  const suffix = requestId.lastIndexOf("-");
  return Object.freeze({
    requestId,
    colo: suffix < 0 ? null : requestId.slice(suffix + 1).toUpperCase() || null,
  });
}

async function request(fetchImpl, baseUrl, path, init, now) {
  const startedAtMs = now();
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}${path}`, { ...init, cache: "no-store" });
  const completedAtMs = now();
  const raw = await response.text();
  let body;
  try {
    body = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    body = { raw: "[non-json response omitted]" };
  }
  return Object.freeze({ response, body, startedAtMs, completedAtMs });
}

function committedEvent(result, roomId) {
  const response = result.body?.response && typeof result.body.response === "object"
    ? result.body.response
    : result.body;
  const events = Array.isArray(response?.writtenEvents) ? response.writtenEvents : [];
  const event = events.at(-1);
  if (result.response.status !== 200 || result.body?.kind !== "committed" || events.length === 0
      || typeof event?.sortableUniqueIdValue !== "string") {
    const error = new Error(`app create-room was not an accepted commit (HTTP ${result.response.status})`);
    error.evidence = Object.freeze({
      status: result.response.status,
      kind: result.body?.kind ?? null,
      roomId,
      cfRay: result.response.headers.get("cf-ray"),
      startedAtMs: result.startedAtMs,
      completedAtMs: result.completedAtMs,
    });
    throw error;
  }
  return event.sortableUniqueIdValue;
}

async function createRoomCommit({ fetchImpl, baseUrl, runId, ordinal, phase, task = TASK, now }) {
  const taskName = measurementTask(task);
  const roomId = `${taskName.toLowerCase()}-${runId.slice(0, 24)}-${String(ordinal).padStart(3, "0")}`;
  const result = await request(fetchImpl, baseUrl, "/api/commands/create-room", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": `${taskName}-commit-latency/1.0` },
    body: JSON.stringify({ roomId, name: `${taskName} ${phase} ${ordinal}` }),
  }, now);
  const suid = committedEvent(result, roomId);
  const identity = responseIdentity(result.response);
  return Object.freeze({
    ordinal,
    phase,
    endpoint: "POST /api/commands/create-room",
    roomId,
    requestId: identity.requestId,
    colo: identity.colo,
    startedAtMs: result.startedAtMs,
    completedAtMs: result.completedAtMs,
    clientLatencyMs: result.completedAtMs - result.startedAtMs,
    status: result.response.status,
    committedSuid: suid,
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

function assessTelemetryRows(telemetry) {
  const rows = Array.isArray(telemetry?.perHopDescriptiveMedians) ? telemetry.perHopDescriptiveMedians : [];
  const byRow = new Map(rows.map((row) => [row?.rowId, row]));
  const missing = ACTIVE_PER_HOP_ROWS.filter((rowId) => {
    const row = byRow.get(rowId);
    return !Number.isFinite(row?.medianMs) || !Number.isSafeInteger(row?.observedSpanCount) || row.observedSpanCount < 1;
  });
  return Object.freeze({
    rows,
    missingActivePerHopRows: missing,
    retainedTraceCount: Array.isArray(telemetry?.retainedTraceTelemetry?.traces)
      ? telemetry.retainedTraceTelemetry.traces.length
      : 0,
  });
}

async function defaultCaptureTelemetry(input) {
  return telemetryForLedger({ ...input, required: true, retainTelemetry: true });
}

/**
 * Capture exactly one post-G41 app-command window. The optional dependencies
 * are only for non-live guards; production callers use the G37 telemetry path.
 */
export async function captureG50AppCommitLatency({
  baseUrl,
  accountId,
  observabilityToken,
  serviceId,
  versionId,
  sourceCommit: deployedSourceCommit,
  sampleCount = DEFAULT_SAMPLE_COUNT,
  ingestionTimeoutMs = DEFAULT_INGESTION_TIMEOUT_MS,
  ingestionPollIntervalMs,
  runId = randomUUID().replaceAll("-", ""),
  task = TASK,
  queryTemplate,
  fetchImpl = globalThis.fetch,
  captureTelemetry = defaultCaptureTelemetry,
  sampleIntervalMs = 0,
  sleepFor = sleepForInterval,
  now,
  onWarmupAccepted,
  onSampleAccepted,
}) {
  const acceptedSampleCount = positiveInteger("sampleCount", String(sampleCount));
  const measurementRunId = safeRunId(runId);
  const targetServiceId = required("serviceId", serviceId);
  const targetVersionId = required("versionId", versionId);
  const targetSourceCommit = sourceCommit(required("sourceCommit", deployedSourceCommit));
  const measurementTaskName = measurementTask(task);
  const intervalMs = nonNegativeInteger("sampleIntervalMs", sampleIntervalMs);
  if (typeof fetchImpl !== "function") fail("fetchImpl must be a function");
  if (typeof captureTelemetry !== "function") fail("captureTelemetry must be a function");
  if (typeof sleepFor !== "function") fail("sleepFor must be a function");
  if (now !== undefined && typeof now !== "function") fail("now must be a function");
  const readNow = now ?? (() => Date.now());
  if (onWarmupAccepted !== undefined && typeof onWarmupAccepted !== "function") fail("onWarmupAccepted must be a function when supplied");
  if (onSampleAccepted !== undefined && typeof onSampleAccepted !== "function") fail("onSampleAccepted must be a function when supplied");

  const warmup = await createRoomCommit({
    fetchImpl,
    baseUrl,
    runId: measurementRunId,
    ordinal: 0,
    phase: "discarded-warmup",
    task: measurementTaskName,
    now: readNow,
  });
  if (onWarmupAccepted !== undefined) await onWarmupAccepted(warmup);
  const ledger = [];
  for (let index = 0; index < acceptedSampleCount; index += 1) {
    // This starts every paced sample only after the preceding accepted sample
    // has been durably recorded and its configured interval elapsed.  Default
    // G50 callers retain their original immediately-sequential behavior.
    if (index > 0 && intervalMs > 0) await sleepFor(intervalMs);
    const accepted = await createRoomCommit({
      fetchImpl,
      baseUrl,
      runId: measurementRunId,
      ordinal: index + 1,
      phase: "sample",
      task: measurementTaskName,
      now: readNow,
    });
    ledger.push(accepted);
    if (onSampleAccepted !== undefined) {
      await onSampleAccepted(accepted, Object.freeze({
        warmup,
        acceptedSampleRequests: ledger.length,
      }));
    }
  }

  const telemetry = await captureTelemetry({
    accountId: required("accountId", accountId),
    observabilityToken: required("observabilityToken", observabilityToken),
    observabilityTokenReason: "SDT-G50 supplied observability token file",
    template: queryTemplate,
    ledger,
    ingestionTimeoutMs,
    ...(ingestionPollIntervalMs === undefined ? {} : { ingestionPollIntervalMs }),
  });
  // A retained-query schema defect must not discard an otherwise coherent
  // client cohort. Preserve the raw telemetry and name missing S-rows for the
  // evidence document; callers may not fabricate a per-hop table from it.
  const telemetryAssessment = assessTelemetryRows(telemetry);

  return Object.freeze({
    schema: "sdt-g50-commit-latency/v1",
    task: measurementTaskName,
    capturedAt: new Date().toISOString(),
    runId: measurementRunId,
    deployed: Object.freeze({
      serviceId: targetServiceId,
      versionId: targetVersionId,
      sourceCommit: targetSourceCommit,
      baseUrl,
    }),
    protocol: Object.freeze({
      appSurface: "POST /api/commands/create-room",
      requestMode: "one sequential process; no retries or replacement requests",
      warmCondition: "WARM app-command window: one accepted create-room request was discarded before the 50 accepted sampled requests.",
      discardedWarmupRequests: 1,
      discardedFailedRequests: 0,
      acceptedSampleRequests: ledger.length,
      structurallyRemovedG41Rows: STRUCTURALLY_REMOVED_G41_ROWS,
      activePerHopRows: ACTIVE_PER_HOP_ROWS,
    }),
    warmup,
    client: summary(ledger.map((entry) => entry.clientLatencyMs)),
    callerColoDistribution: clientColoDistribution(ledger),
    telemetry: Object.freeze({
      ...telemetry,
      perHopDescriptiveMedians: telemetryAssessment.rows,
      activePerHopRowsMissing: telemetryAssessment.missingActivePerHopRows,
      retainedTraceCount: telemetryAssessment.retainedTraceCount,
      perHopStatus: telemetryAssessment.missingActivePerHopRows.length === 0 ? "available" : "blocked-by-defect",
    }),
    ledger,
  });
}

function main() {
  const baseUrl = required("--base-url", argument("--base-url", process.env.G50_BASE_URL));
  const accountId = required("--account-id", argument("--account-id", process.env.CLOUDFLARE_ACCOUNT_ID));
  const serviceId = required("--service-id", argument("--service-id", process.env.SDT_SERVICE_ID ?? G99_TIP_SERVICE));
  const versionId = required("--version-id", argument("--version-id", process.env.G50_VERSION_ID));
  const deployedSourceCommit = sourceCommit(required("--source-commit", argument("--source-commit", process.env.G50_SOURCE_COMMIT)));
  const wrangler = argument("--wrangler", "./node_modules/.bin/wrangler");
  // Fail closed unless the active 100% deployment is the G99 npm-consumer tip
  // under test (same worker; message marker + commit + version id).
  assertLiveTipIdentity({
    wrangler,
    service: serviceId,
    expectedCommit: deployedSourceCommit,
    expectedVersionId: versionId,
  });
  const tokenFile = required("--observability-token-file", argument("--observability-token-file", process.env.G50_OBSERVABILITY_TOKEN_FILE));
  if (!existsSync(tokenFile)) fail("observability token file does not exist");
  const observabilityToken = readFileSync(tokenFile, "utf8").trim();
  if (observabilityToken.length === 0) fail("observability token file is empty");
  const queryTemplatePath = argument("--query-template", "scripts/g37-observability-query.json");
  const queryTemplate = JSON.parse(readFileSync(queryTemplatePath, "utf8"));
  const sampleCount = positiveInteger("--samples", argument("--samples", String(DEFAULT_SAMPLE_COUNT)));
  const ingestionTimeoutMs = boundedPositiveInteger(
    "--ingestion-timeout-ms",
    argument("--ingestion-timeout-ms", String(DEFAULT_INGESTION_TIMEOUT_MS)),
    MAX_INGESTION_TIMEOUT_MS,
  );
  const output = argument("--output", ".artifacts/sdt-g50-commit-latency.json");
  const runId = argument("--run-id", randomUUID().replaceAll("-", ""));
  return captureG50AppCommitLatency({
    baseUrl,
    accountId,
    observabilityToken,
    serviceId,
    versionId,
    sourceCommit: deployedSourceCommit,
    sampleCount,
    ingestionTimeoutMs,
    runId,
    queryTemplate,
  }).then((sample) => {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(sample, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({
      task: sample.task,
      output,
      deployed: sample.deployed,
      client: sample.client,
      callerColoDistribution: sample.callerColoDistribution,
      perHopDescriptiveMedians: sample.telemetry.perHopDescriptiveMedians,
    }, null, 2)}\n`);
  });
}

if (import.meta.url === `file://${resolve(process.argv[1] ?? "")}`) {
  main().catch((error) => {
    const evidence = error instanceof Error && "evidence" in error ? error.evidence : undefined;
    process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error), ...(evidence === undefined ? {} : { evidence }) })}\n`);
    process.exitCode = 1;
  });
}
