#!/usr/bin/env node
/**
 * SDT-G52 deployed app-surface sampler.
 *
 * It reuses the G50 sequential command and bounded exact-CF-Ray polling
 * discipline, then requires the retained CommitTrace snapshot-log root for
 * every accepted client request. No request is retried or replaced.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  ACTIVE_PER_HOP_ROWS,
  DEFAULT_INGESTION_TIMEOUT_MS,
  MAX_INGESTION_TIMEOUT_MS,
  STRUCTURALLY_REMOVED_G41_ROWS,
  captureG50AppCommitLatency,
} from "./g50-commit-latency.mjs";

export const TASK = "SDT-G52";
export const SAMPLE_COUNT = 50;
// S09 and S16 are DO-owned native callback rows, not Worker-local snapshot
// rows. Their bounded handler observations are reported in the adjacent DO
// table; this table remains a truthful log-root breakdown.
export const SNAPSHOT_PER_HOP_ROWS = Object.freeze(ACTIVE_PER_HOP_ROWS.filter(
  (rowId) => rowId !== "S09" && rowId !== "S16",
));

const HOP_WAIT = Object.freeze({
  S00: "the complete app-command commit window",
  S01: "request decoding and exact payload admission",
  S02: "BOOTSTRAP admission",
  S03: "BOOTSTRAP release",
  S06: "reservation fan-out settlement",
  S07: "one consistency-tag reservation",
  S08: "allocator vector allocation",
  S09: "allocator-side BOOTSTRAP finalize",
  S10: "final BOOTSTRAP fence before append",
  S11: "tag append fan-out settlement",
  S12: "one authoritative tag append",
  S13: "result-state fan-out settlement",
  S14: "one tag result-state read",
  S15: "response assembly after durable reads",
  S16: "callee actor callback",
});

function fail(message) {
  throw new Error(`g52-commit-breakdown:${message}`);
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
  if (!/^[0-9a-f]{40}$/.test(value)) fail("--source-commit must be a 40-character lowercase SHA");
  return value;
}

function safeRunId(value) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(value)) fail("--run-id must be 8..64 URL-safe characters");
  return value;
}

function boundedTimeout(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_INGESTION_TIMEOUT_MS) {
    fail(`--ingestion-timeout-ms must be an integer in 1..${MAX_INGESTION_TIMEOUT_MS}`);
  }
  return parsed;
}

function nearestRank(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] ?? null;
}

function descriptiveMedian(values) {
  return nearestRank(values, 0.5);
}

function perActorObservationMedians(observations) {
  const byActor = new Map();
  for (const observation of observations ?? []) {
    if (observation?.event !== "do.handler" || typeof observation?.actorClass !== "string") continue;
    const entry = byActor.get(observation.actorClass) ?? {
      constructorToHandlerMs: [],
      firstStorageReadMs: [],
      subrequestWallMs: [],
      observationCount: 0,
    };
    entry.observationCount += 1;
    for (const key of ["constructorToHandlerMs", "firstStorageReadMs", "subrequestWallMs"]) {
      if (Number.isFinite(observation[key])) entry[key].push(observation[key]);
    }
    byActor.set(observation.actorClass, entry);
  }
  return Object.freeze([...byActor.entries()].map(([actorClass, values]) => Object.freeze({
    actorClass,
    observationCount: values.observationCount,
    constructorToHandlerMs: descriptiveMedian(values.constructorToHandlerMs),
    firstStorageReadMs: descriptiveMedian(values.firstStorageReadMs),
    subrequestWallMs: descriptiveMedian(values.subrequestWallMs),
  })).sort((left, right) => left.actorClass.localeCompare(right.actorClass)));
}

function residualRanking(rows) {
  return Object.freeze(rows
    .filter((row) => SNAPSHOT_PER_HOP_ROWS.includes(row?.rowId) && Number.isFinite(row?.medianMs))
    .map((row) => Object.freeze({
      rowId: row.rowId,
      medianMs: row.medianMs,
      observedSpanCount: row.observedSpanCount,
      waitsOn: HOP_WAIT[row.rowId] ?? "the recorded trace boundary",
    }))
    .sort((left, right) => right.medianMs - left.medianMs || left.rowId.localeCompare(right.rowId)));
}

function snapshotRootReceipt(telemetry, expectedCount) {
  const traces = telemetry?.retainedTraceTelemetry?.traces;
  if (!Array.isArray(traces) || traces.length !== expectedCount) {
    fail(`retained snapshot trace count is ${Array.isArray(traces) ? traces.length : "absent"}; expected ${expectedCount}`);
  }
  if (telemetry?.ingestion?.status !== "settled") fail(`bounded telemetry ingestion ended ${String(telemetry?.ingestion?.status)}`);
  if (telemetry?.schemaCompleteTraceCount !== expectedCount) {
    fail(`schema-complete trace count is ${String(telemetry?.schemaCompleteTraceCount)}; expected ${expectedCount}`);
  }
  const nonSnapshot = traces.filter((trace) => trace?.rootSource !== "snapshot-log");
  if (nonSnapshot.length > 0) fail(`retained cohort contains ${nonSnapshot.length} non-snapshot root(s)`);
  const truncatedLogs = traces.filter((trace) => trace?.snapshotLogTruncated !== false);
  if (truncatedLogs.length > 0) fail(`retained cohort contains ${truncatedLogs.length} truncated snapshot log(s)`);
  const incompleteWorkerSnapshots = traces.filter((trace) => {
    const rows = new Set(Array.isArray(trace?.spans) ? trace.spans.map((span) => span?.rowId) : []);
    return SNAPSHOT_PER_HOP_ROWS.some((rowId) => !rows.has(rowId));
  });
  if (incompleteWorkerSnapshots.length > 0) {
    fail(`retained cohort contains ${incompleteWorkerSnapshots.length} snapshot(s) missing a Worker per-hop row`);
  }
  return Object.freeze({
    rootSource: "snapshot-log",
    retainedTraceCount: traces.length,
    schemaCompleteTraceCount: telemetry.schemaCompleteTraceCount,
    observedTraceCount: telemetry.observedTraceCount,
    descriptiveLossCount: telemetry.descriptiveLossCount,
    untruncatedLogRootCount: traces.length,
    ingestion: telemetry.ingestion,
  });
}

export async function captureG52CommitBreakdown(input) {
  const base = await captureG50AppCommitLatency({
    ...input,
    task: TASK,
    sampleCount: SAMPLE_COUNT,
  });
  const snapshotRoots = snapshotRootReceipt(base.telemetry, SAMPLE_COUNT);
  const retained = base.telemetry.retainedTraceTelemetry;
  const perHopDescriptiveMedians = Object.freeze(base.telemetry.perHopDescriptiveMedians.filter(
    (row) => SNAPSHOT_PER_HOP_ROWS.includes(row?.rowId) && !STRUCTURALLY_REMOVED_G41_ROWS.includes(row?.rowId),
  ));
  return Object.freeze({
    ...base,
    schema: "sdt-g52-commit-breakdown/v1",
    task: TASK,
    protocol: Object.freeze({
      ...base.protocol,
      retainedRootSource: "snapshot-log",
      retainedRootSourceRule: "one retained root source per trace; native-span rows are never mixed with snapshot-log rows",
    }),
    telemetry: Object.freeze({
      ...base.telemetry,
      snapshotRoots,
      perHopDescriptiveMedians,
      doObservationMedians: perActorObservationMedians(retained?.observations),
      residualRanking: residualRanking(perHopDescriptiveMedians),
    }),
  });
}

async function main() {
  const baseUrl = required("--base-url", argument("--base-url", process.env.G52_BASE_URL));
  const accountId = required("--account-id", argument("--account-id", process.env.CLOUDFLARE_ACCOUNT_ID));
  const serviceId = required("--service-id", argument("--service-id", process.env.SDT_SERVICE_ID));
  const versionId = required("--version-id", argument("--version-id", process.env.G52_VERSION_ID));
  const deployedSourceCommit = sourceCommit(required("--source-commit", argument("--source-commit", process.env.G52_SOURCE_COMMIT)));
  const tokenFile = required("G50_OBSERVABILITY_TOKEN_FILE", process.env.G50_OBSERVABILITY_TOKEN_FILE);
  if (!existsSync(tokenFile)) fail("G50_OBSERVABILITY_TOKEN_FILE does not exist");
  const observabilityToken = readFileSync(tokenFile, "utf8").trim();
  if (observabilityToken.length === 0) fail("G50_OBSERVABILITY_TOKEN_FILE is empty");
  const queryTemplate = JSON.parse(readFileSync(argument("--query-template", "scripts/deploy/g37-observability-query.json"), "utf8"));
  const output = argument("--output", ".artifacts/sdt-g52-commit-breakdown.json");
  const sample = await captureG52CommitBreakdown({
    baseUrl,
    accountId,
    serviceId,
    versionId,
    sourceCommit: deployedSourceCommit,
    observabilityToken,
    queryTemplate,
    ingestionTimeoutMs: boundedTimeout(argument("--ingestion-timeout-ms", String(DEFAULT_INGESTION_TIMEOUT_MS))),
    runId: safeRunId(argument("--run-id", randomUUID().replaceAll("-", ""))),
  });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(sample, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    task: sample.task,
    output,
    deployed: sample.deployed,
    acceptedSampleRequests: sample.protocol.acceptedSampleRequests,
    client: sample.client,
    callerColoDistribution: sample.callerColoDistribution,
    rootSource: sample.telemetry.snapshotRoots.rootSource,
    perHopDescriptiveMedians: sample.telemetry.perHopDescriptiveMedians,
    doObservationMedians: sample.telemetry.doObservationMedians,
  }, null, 2)}\n`);
}

if (import.meta.url === `file://${resolve(process.argv[1] ?? "")}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
