#!/usr/bin/env node
/**
 * SDT-G51 AC5 probe-ladder sampler.
 *
 * This intentionally does not reuse the strict native-row sampler.  A probe
 * rung asks one narrow question about a fixed, fresh cohort: did a named
 * custom span with its one expected attribute reach retained telemetry for
 * every exact client CF-Ray?  It emits only redacted client facts, never raw
 * provider events, request identities, request bodies, or token material.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  COHORT_INGESTION_POLL_INTERVAL_MS,
  DEFAULT_COHORT_INGESTION_TIMEOUT_MS,
  pollCohortTelemetry,
  queryNamedSpanCohort,
} from "./g30-trace-export.mjs";
import { summary } from "./g37-sample.mjs";

const SAMPLE_COUNT = 10;
const MAX_INGESTION_TIMEOUT_MS = 15 * 60 * 1_000;
const PROBES = Object.freeze({
  P1: Object.freeze({
    spanName: "sdt.g51.probe.p1",
    attributeKey: "sdt.g51.probe",
    attributeValue: "p1",
    location: "sample Worker fetch handler before command dispatch",
  }),
  P2: Object.freeze({
    spanName: "sdt.g51.probe.p2",
    attributeKey: "sdt.g51.probe",
    attributeValue: "p2",
    location: "sample Worker in-isolate runtimeFetch call",
  }),
});

function fail(message) {
  throw new Error(`g51-ac5-probe-ladder:${message}`);
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) fail(`${name} is required`);
  return value;
}

function sourceCommit(value) {
  if (!/^[0-9a-f]{40}$/.test(value)) fail("--source-commit must be a 40-character lower-case SHA");
  return value;
}

function positiveTimeout(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_INGESTION_TIMEOUT_MS) {
    fail(`--ingestion-timeout-ms must be an integer in 1..${MAX_INGESTION_TIMEOUT_MS}`);
  }
  return parsed;
}

function probeRung(value) {
  if (value !== "P1" && value !== "P2") fail("--rung must be P1 or P2");
  return value;
}

function runId(value) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(value)) fail("--run-id must be 8..64 URL-safe characters");
  return value;
}

function responseIdentity(response) {
  const requestId = response.headers.get("cf-ray");
  if (typeof requestId !== "string" || requestId.length === 0) fail("app command response lacks cf-ray");
  const suffix = requestId.lastIndexOf("-");
  return Object.freeze({ requestId, colo: suffix < 0 ? null : requestId.slice(suffix + 1).toUpperCase() || null });
}

async function createRoomCommit(baseUrl, sampleRunId, ordinal, phase) {
  const roomId = `sdt-g51-${sampleRunId.slice(0, 24)}-${String(ordinal).padStart(3, "0")}`;
  const startedAtMs = Date.now();
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/commands/create-room`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "SDT-G51-AC5-probe-ladder/1.0",
    },
    body: JSON.stringify({ roomId, name: `SDT-G51 ${phase} ${ordinal}` }),
    cache: "no-store",
  });
  const completedAtMs = Date.now();
  const raw = await response.text();
  let body;
  try { body = raw.length === 0 ? {} : JSON.parse(raw); } catch { body = {}; }
  const command = body?.response && typeof body.response === "object" ? body.response : body;
  const committedSuid = Array.isArray(command?.writtenEvents) ? command.writtenEvents.at(-1)?.sortableUniqueIdValue : undefined;
  if (response.status !== 200 || body?.kind !== "committed" || typeof committedSuid !== "string") {
    fail(`create-room ${phase} ${ordinal} was not an accepted commit (HTTP ${response.status}, kind ${String(body?.kind ?? "unknown")})`);
  }
  const identity = responseIdentity(response);
  return Object.freeze({
    ordinal,
    phase,
    requestId: identity.requestId,
    colo: identity.colo,
    startedAtMs,
    completedAtMs,
    clientLatencyMs: completedAtMs - startedAtMs,
    status: response.status,
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

function redactedLedger(ledger) {
  return Object.freeze(ledger.map((entry) => Object.freeze({
    ordinal: entry.ordinal,
    colo: entry.colo,
    status: entry.status,
    clientLatencyMs: entry.clientLatencyMs,
    requestIdentity: "retained-in-memory-only",
  })));
}

function redactedIngestion(ingestion) {
  return Object.freeze({
    status: ingestion.status,
    expectedRequestCount: ingestion.expectedRequestCount,
    observedRequestCount: ingestion.observedRequestCount,
    missingRequestCount: Array.isArray(ingestion.missingRequestIds) ? ingestion.missingRequestIds.length : 0,
    startedAtMs: ingestion.startedAtMs,
    deadlineMs: ingestion.deadlineMs,
    completedAtMs: ingestion.completedAtMs,
    attempts: ingestion.attempts,
    ...(ingestion.lastErrorClass === undefined ? {} : { lastErrorClass: ingestion.lastErrorClass }),
  });
}

function probeSummary(bundle, expectedRequestCount) {
  const value = bundle?.probe;
  if (value === undefined) {
    return Object.freeze({
      retainedSpanCount: 0,
      retainedRequestCount: 0,
      attributeMatchedSpanCount: 0,
      attributeMatchedRequestCount: 0,
      unjoinableRetainedSpanCount: 0,
      missingAttributeMatchedRequestCount: expectedRequestCount,
    });
  }
  return Object.freeze({
    retainedSpanCount: value.retainedSpanCount,
    retainedRequestCount: value.retainedRequestCount,
    attributeMatchedSpanCount: value.attributeMatchedSpanCount,
    attributeMatchedRequestCount: value.attributeMatchedRequestCount,
    unjoinableRetainedSpanCount: value.unjoinableRetainedSpanCount,
    missingAttributeMatchedRequestCount: Math.max(0, expectedRequestCount - value.attributeMatchedRequestCount),
  });
}

export async function captureG51ProbeRung({
  baseUrl,
  accountId,
  serviceId,
  versionId,
  sourceCommit: deployedSourceCommit,
  observabilityToken,
  queryTemplate,
  rung = "P1",
  ingestionTimeoutMs = DEFAULT_COHORT_INGESTION_TIMEOUT_MS,
  ingestionPollIntervalMs = COHORT_INGESTION_POLL_INTERVAL_MS,
  sampleRunId = randomUUID().replaceAll("-", ""),
}) {
  const selectedRung = probeRung(rung);
  const probe = PROBES[selectedRung];
  const acceptedRunId = runId(sampleRunId);
  const warmup = await createRoomCommit(required("baseUrl", baseUrl), acceptedRunId, 0, "discarded-warmup");
  const ledger = [];
  for (let ordinal = 1; ordinal <= SAMPLE_COUNT; ordinal += 1) {
    ledger.push(await createRoomCommit(baseUrl, acceptedRunId, ordinal, "sample"));
  }

  const earliest = Math.min(...ledger.map((entry) => entry.startedAtMs));
  const latest = Math.max(...ledger.map((entry) => entry.completedAtMs));
  let queryWindow;
  const acquisition = await pollCohortTelemetry({
    ledger,
    timeoutMs: positiveTimeout(String(ingestionTimeoutMs)),
    intervalMs: positiveTimeout(String(ingestionPollIntervalMs)),
    fetchCohort: async () => {
      const query = structuredClone(queryTemplate);
      query.timeframe = {
        from: Math.max(0, earliest - 60_000),
        to: Math.max(latest + 60_000, Date.now() + 60_000),
      };
      queryWindow = query.timeframe;
      return queryNamedSpanCohort({
        accountId: required("accountId", accountId),
        token: required("observabilityToken", observabilityToken),
        template: query,
        ledger,
        ...probe,
      });
    },
    normalize: (probeResult) => Object.freeze({
      traces: probeResult.attributeMatchedRequestIds.map((requestId) => Object.freeze({ requestId })),
      probe: probeResult,
    }),
  });
  const ingestion = redactedIngestion(acquisition.ingestion);
  const probeEvidence = probeSummary(acquisition.bundle, ledger.length);

  return Object.freeze({
    schema: "sdt-g51-ac5-probe-ladder/v1",
    task: "SDT-G51",
    capturedAt: new Date().toISOString(),
    deployed: Object.freeze({
      serviceId: required("serviceId", serviceId),
      versionId: required("versionId", versionId),
      sourceCommit: sourceCommit(required("sourceCommit", deployedSourceCommit)),
      baseUrl: required("baseUrl", baseUrl),
    }),
    probe: Object.freeze({ rung: selectedRung, ...probe }),
    protocol: Object.freeze({
      appSurface: "POST /api/commands/create-room",
      requestMode: "one discarded warm-up then exactly ten sequential accepted commits; no retries or replacement requests",
      discardedWarmupRequests: 1,
      acceptedSampleRequests: ledger.length,
      clientRequestIdentities: "used only in the bounded live query; omitted from this artifact",
    }),
    warmup: Object.freeze({ status: warmup.status, colo: warmup.colo, clientLatencyMs: warmup.clientLatencyMs, accepted: true }),
    client: summary(ledger.map((entry) => entry.clientLatencyMs)),
    callerColoDistribution: coloDistribution(ledger),
    telemetry: Object.freeze({
      queryWindow,
      ingestion,
      observedIngestionLagMs: Math.max(0, ingestion.completedAtMs - latest),
      ...probeEvidence,
      verdict: ingestion.status === "unavailable"
        ? "query-unavailable"
        : probeEvidence.attributeMatchedRequestCount === ledger.length
          ? "retained-for-every-exact-cohort-ray"
          : probeEvidence.retainedSpanCount === 0
            ? "no-retained-probe-span-for-exact-cohort"
            : "retained-but-incomplete-or-unjoinable",
    }),
    ledger: redactedLedger(ledger),
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
  const output = argument("--output", ".artifacts/sdt-g51-ac5-probe-ladder.json");
  const sample = await captureG51ProbeRung({
    baseUrl,
    accountId,
    serviceId,
    versionId,
    sourceCommit: deployedSourceCommit,
    observabilityToken,
    queryTemplate,
    rung: probeRung(argument("--rung", "P1")),
    ingestionTimeoutMs: positiveTimeout(argument("--ingestion-timeout-ms", String(DEFAULT_COHORT_INGESTION_TIMEOUT_MS))),
    sampleRunId: runId(argument("--run-id", randomUUID().replaceAll("-", ""))),
  });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(sample, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    output,
    deployed: sample.deployed,
    rung: sample.probe.rung,
    acceptedSamples: sample.protocol.acceptedSampleRequests,
    ingestion: sample.telemetry.ingestion,
    retainedSpanCount: sample.telemetry.retainedSpanCount,
    attributeMatchedRequestCount: sample.telemetry.attributeMatchedRequestCount,
    verdict: sample.telemetry.verdict,
  }, null, 2)}\n`);
  if (sample.telemetry.verdict === "query-unavailable") {
    fail("bounded retained-probe query was unavailable; redacted artifact was written before stopping");
  }
}

if (import.meta.url === `file://${resolve(process.argv[1] ?? "")}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
