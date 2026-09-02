#!/usr/bin/env node
/**
 * Small deployed SDT-G51 proof: one discarded app command followed by a
 * bounded sequential cohort whose retained traces must expose every active
 * commit S-row. This is not a latency measurement and never retries or
 * replaces a rejected request.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { summary, telemetryForLedger } from "./g37-sample.mjs";

const DEFAULT_SAMPLE_COUNT = 10;
const MAX_SAMPLE_COUNT = 20;
const DEFAULT_INGESTION_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_INGESTION_TIMEOUT_MS = 15 * 60 * 1_000;
const ACTIVE_S_ROWS = Object.freeze([
  "S00", "S01", "S02", "S03", "S06", "S07", "S08", "S09", "S10", "S11", "S12", "S13", "S14", "S15", "S16",
]);

function fail(message) {
  throw new Error(`g51-native-span-sample:${message}`);
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) fail(`${name} is required`);
  return value;
}

function sampleCount(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < DEFAULT_SAMPLE_COUNT || parsed > MAX_SAMPLE_COUNT) {
    fail(`--samples must be an integer in ${DEFAULT_SAMPLE_COUNT}..${MAX_SAMPLE_COUNT}`);
  }
  return parsed;
}

function timeout(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_INGESTION_TIMEOUT_MS) {
    fail(`--ingestion-timeout-ms must be an integer in 1..${MAX_INGESTION_TIMEOUT_MS}`);
  }
  return parsed;
}

function sourceCommit(value) {
  if (!/^[0-9a-f]{40}$/.test(value)) fail("--source-commit must be a 40-character lower-case SHA");
  return value;
}

function safeRunId(value) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(value)) fail("--run-id must be 8..64 URL-safe characters");
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

async function createRoomCommit(baseUrl, runId, ordinal, phase) {
  const roomId = `sdt-g51-${runId.slice(0, 24)}-${String(ordinal).padStart(3, "0")}`;
  const startedAtMs = Date.now();
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/commands/create-room`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "SDT-G51-native-span-proof/1.0",
    },
    body: JSON.stringify({ roomId, name: `SDT-G51 ${phase} ${ordinal}` }),
    cache: "no-store",
  });
  const completedAtMs = Date.now();
  const raw = await response.text();
  let body;
  try { body = raw.length === 0 ? {} : JSON.parse(raw); } catch { body = {}; }
  const command = body?.response && typeof body.response === "object" ? body.response : body;
  const events = Array.isArray(command?.writtenEvents) ? command.writtenEvents : [];
  const committedSuid = events.at(-1)?.sortableUniqueIdValue;
  if (response.status !== 200 || body?.kind !== "committed" || typeof committedSuid !== "string") {
    fail(`create-room ${phase} ${ordinal} was not an accepted commit (HTTP ${response.status}, kind ${String(body?.kind ?? "unknown")})`);
  }
  const identity = responseIdentity(response);
  return Object.freeze({
    ordinal,
    phase,
    endpoint: "POST /api/commands/create-room",
    requestId: identity.requestId,
    colo: identity.colo,
    startedAtMs,
    completedAtMs,
    clientLatencyMs: completedAtMs - startedAtMs,
    status: response.status,
    committedSuid,
  });
}

function coloDistribution(ledger) {
  const counts = new Map();
  for (const entry of ledger) {
    const colo = typeof entry.colo === "string" && entry.colo.length > 0 ? entry.colo : "UNKNOWN";
    counts.set(colo, (counts.get(colo) ?? 0) + 1);
  }
  return Object.freeze(Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right))));
}

function spanTallies(traces) {
  const names = new Map();
  const rows = new Map();
  const nativeRows = new Map();
  for (const trace of traces) {
    for (const span of trace?.spans ?? []) {
      if (typeof span?.span === "string") names.set(span.span, (names.get(span.span) ?? 0) + 1);
      if (typeof span?.rowId === "string") rows.set(span.rowId, (rows.get(span.rowId) ?? 0) + 1);
      if (typeof span?.nativeRowId === "string") nativeRows.set(span.nativeRowId, (nativeRows.get(span.nativeRowId) ?? 0) + 1);
    }
  }
  return Object.freeze({
    spanNameTally: Object.freeze(Object.fromEntries([...names.entries()].sort(([left], [right]) => left.localeCompare(right)))),
    rowIdTally: Object.freeze(Object.fromEntries([...rows.entries()].sort(([left], [right]) => left.localeCompare(right)))),
    nativeRowIdTally: Object.freeze(Object.fromEntries([...nativeRows.entries()].sort(([left], [right]) => left.localeCompare(right)))),
  });
}

export async function captureG51NativeSpanSample({
  baseUrl,
  accountId,
  serviceId,
  versionId,
  sourceCommit: deployedSourceCommit,
  observabilityToken,
  queryTemplate,
  sampleCount: requestedSampleCount = DEFAULT_SAMPLE_COUNT,
  ingestionTimeoutMs = DEFAULT_INGESTION_TIMEOUT_MS,
  runId = randomUUID().replaceAll("-", ""),
}) {
  const count = sampleCount(String(requestedSampleCount));
  const acceptedRunId = safeRunId(runId);
  const warmup = await createRoomCommit(required("baseUrl", baseUrl), acceptedRunId, 0, "discarded-warmup");
  const ledger = [];
  for (let ordinal = 1; ordinal <= count; ordinal += 1) {
    ledger.push(await createRoomCommit(baseUrl, acceptedRunId, ordinal, "sample"));
  }
  const telemetry = await telemetryForLedger({
    accountId: required("accountId", accountId),
    observabilityToken: required("observabilityToken", observabilityToken),
    observabilityTokenReason: "SDT-G51 supplied G50_OBSERVABILITY_TOKEN_FILE",
    template: queryTemplate,
    ledger,
    required: true,
    retainTelemetry: true,
    ingestionTimeoutMs: timeout(String(ingestionTimeoutMs)),
  });
  const traces = telemetry.retainedTraceTelemetry?.traces ?? [];
  const tallies = spanTallies(traces);
  const missingRowsByRequest = traces.map((trace) => Object.freeze({
    requestId: trace.requestId,
    missingRows: Object.freeze(ACTIVE_S_ROWS.filter((rowId) => !trace.spans?.some((span) => span?.nativeRowId === rowId))),
  }));
  const incompleteTrace = missingRowsByRequest.find((entry) => entry.missingRows.length > 0);
  if (telemetry.ingestion.status !== "settled" || traces.length !== ledger.length || incompleteTrace !== undefined) {
    fail(`retained trace proof is incomplete (status ${telemetry.ingestion.status}, traces ${traces.length}/${ledger.length}, ${incompleteTrace === undefined ? "all native rows present" : `${incompleteTrace.requestId} missing ${incompleteTrace.missingRows.join(",")}`})`);
  }
  return Object.freeze({
    schema: "sdt-g51-native-span-sample/v1",
    task: "SDT-G51",
    capturedAt: new Date().toISOString(),
    deployed: Object.freeze({
      serviceId: required("serviceId", serviceId),
      versionId: required("versionId", versionId),
      sourceCommit: sourceCommit(required("sourceCommit", deployedSourceCommit)),
      baseUrl: required("baseUrl", baseUrl),
    }),
    protocol: Object.freeze({
      appSurface: "POST /api/commands/create-room",
      requestMode: "one sequential process; no retries or replacement requests",
      discardedWarmupRequests: 1,
      acceptedSampleRequests: ledger.length,
      requiredNativeRows: ACTIVE_S_ROWS,
    }),
    warmup,
    client: summary(ledger.map((entry) => entry.clientLatencyMs)),
    callerColoDistribution: coloDistribution(ledger),
    telemetry: Object.freeze({
      queryWindow: telemetry.queryWindow,
      ingestion: telemetry.ingestion,
      observedIngestionLagMs: telemetry.observedIngestionLagMs,
      observedTraceCount: telemetry.observedTraceCount,
      schemaCompleteTraceCount: telemetry.schemaCompleteTraceCount,
      perHopDescriptiveMedians: telemetry.perHopDescriptiveMedians,
      missingRowsByRequest,
      ...tallies,
    }),
    ledger: Object.freeze(ledger),
  });
}

async function main() {
  const baseUrl = required("--base-url", argument("--base-url", process.env.G51_BASE_URL));
  const accountId = required("--account-id", argument("--account-id", process.env.CLOUDFLARE_ACCOUNT_ID));
  const serviceId = required("--service-id", argument("--service-id", process.env.SDT_SERVICE_ID));
  const versionId = required("--version-id", argument("--version-id", process.env.G51_VERSION_ID));
  const deployedSourceCommit = sourceCommit(required("--source-commit", argument("--source-commit", process.env.G51_SOURCE_COMMIT)));
  const tokenFile = required("G50_OBSERVABILITY_TOKEN_FILE", process.env.G50_OBSERVABILITY_TOKEN_FILE);
  if (!existsSync(tokenFile)) fail("G50_OBSERVABILITY_TOKEN_FILE does not exist");
  const observabilityToken = readFileSync(tokenFile, "utf8").trim();
  if (observabilityToken.length === 0) fail("G50_OBSERVABILITY_TOKEN_FILE is empty");
  const queryTemplate = JSON.parse(readFileSync(argument("--query-template", "scripts/deploy/g37-observability-query.json"), "utf8"));
  const output = argument("--output", ".artifacts/sdt-g51-native-span-sample.json");
  const sample = await captureG51NativeSpanSample({
    baseUrl,
    accountId,
    serviceId,
    versionId,
    sourceCommit: deployedSourceCommit,
    observabilityToken,
    queryTemplate,
    sampleCount: sampleCount(argument("--samples", String(DEFAULT_SAMPLE_COUNT))),
    ingestionTimeoutMs: timeout(argument("--ingestion-timeout-ms", String(DEFAULT_INGESTION_TIMEOUT_MS))),
    runId: safeRunId(argument("--run-id", randomUUID().replaceAll("-", ""))),
  });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(sample, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    output,
    deployed: sample.deployed,
    acceptedSamples: sample.protocol.acceptedSampleRequests,
    observedIngestionLagMs: sample.telemetry.observedIngestionLagMs,
    spanNameTally: sample.telemetry.spanNameTally,
    nativeRowIdTally: sample.telemetry.nativeRowIdTally,
    perHopDescriptiveMedians: sample.telemetry.perHopDescriptiveMedians,
  }, null, 2)}\n`);
}

if (import.meta.url === `file://${resolve(process.argv[1] ?? "")}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
