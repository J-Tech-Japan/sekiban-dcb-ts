#!/usr/bin/env node
/** Recomputes the committed SDT-G52 client, snapshot-root, and DO summaries. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { STRUCTURALLY_REMOVED_G41_ROWS } from "./g50-commit-latency.mjs";
import { SNAPSHOT_PER_HOP_ROWS } from "./g52-commit-breakdown.mjs";

function fail(message) {
  throw new Error(`g52-commit-breakdown-check:${message}`);
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} does not recompute from the raw sample`);
}

function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] ?? null;
}

function distribution(ledger) {
  const counts = new Map();
  for (const entry of ledger) {
    const colo = typeof entry?.colo === "string" && entry.colo.length > 0 ? entry.colo : "UNKNOWN";
    counts.set(colo, (counts.get(colo) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function perHop(traces) {
  const byRow = new Map();
  for (const trace of traces) {
    for (const span of trace?.spans ?? []) {
      if (!SNAPSHOT_PER_HOP_ROWS.includes(span?.rowId) || !Number.isFinite(span?.startMs) || !Number.isFinite(span?.endMs)) continue;
      const durations = byRow.get(span.rowId) ?? [];
      durations.push(Math.max(0, span.endMs - span.startMs));
      byRow.set(span.rowId, durations);
    }
  }
  return SNAPSHOT_PER_HOP_ROWS.map((rowId) => {
    const values = byRow.get(rowId);
    if (!Array.isArray(values) || values.length === 0) fail(`active snapshot row ${rowId} is absent`);
    return { rowId, observedSpanCount: values.length, medianMs: percentile(values, 0.5) };
  });
}

function actorMedians(observations) {
  const byActor = new Map();
  for (const observation of observations) {
    if (observation?.event !== "do.handler" || typeof observation?.actorClass !== "string") continue;
    const current = byActor.get(observation.actorClass) ?? {
      observationCount: 0,
      constructorToHandlerMs: [],
      firstStorageReadMs: [],
      subrequestWallMs: [],
    };
    current.observationCount += 1;
    for (const field of ["constructorToHandlerMs", "firstStorageReadMs", "subrequestWallMs"]) {
      if (Number.isFinite(observation[field])) current[field].push(observation[field]);
    }
    byActor.set(observation.actorClass, current);
  }
  return [...byActor.entries()].map(([actorClass, values]) => ({
    actorClass,
    observationCount: values.observationCount,
    constructorToHandlerMs: percentile(values.constructorToHandlerMs, 0.5),
    firstStorageReadMs: percentile(values.firstStorageReadMs, 0.5),
    subrequestWallMs: percentile(values.subrequestWallMs, 0.5),
  })).sort((left, right) => left.actorClass.localeCompare(right.actorClass));
}

function residualRanking(rows) {
  return rows.map((row) => ({
    rowId: row.rowId,
    medianMs: row.medianMs,
    observedSpanCount: row.observedSpanCount,
  })).sort((left, right) => right.medianMs - left.medianMs || left.rowId.localeCompare(right.rowId));
}

export function validateG52Sample(sample) {
  if (sample?.schema !== "sdt-g52-commit-breakdown/v1" || sample?.task !== "SDT-G52") fail("sample schema/task is invalid");
  if (typeof sample?.deployed?.serviceId !== "string" || typeof sample?.deployed?.versionId !== "string" || !/^[0-9a-f]{40}$/.test(sample?.deployed?.sourceCommit ?? "")) {
    fail("deployed identity is incomplete");
  }
  const ledger = sample?.ledger;
  if (!Array.isArray(ledger) || ledger.length !== 50) fail("sample must contain exactly 50 accepted app-surface commits");
  if (sample?.protocol?.discardedWarmupRequests !== 1 || sample?.protocol?.discardedFailedRequests !== 0
      || sample?.protocol?.acceptedSampleRequests !== 50 || sample?.protocol?.appSurface !== "POST /api/commands/create-room") {
    fail("warm-up or accepted-window receipt is invalid");
  }
  if (sample?.warmup?.phase !== "discarded-warmup" || sample?.warmup?.status !== 200) fail("discarded warm-up receipt is invalid");
  const requestIds = new Set();
  for (const [index, entry] of ledger.entries()) {
    if (entry?.ordinal !== index + 1 || entry?.phase !== "sample" || entry?.endpoint !== "POST /api/commands/create-room" || entry?.status !== 200
        || typeof entry?.requestId !== "string" || requestIds.has(entry.requestId) || !Number.isFinite(entry?.clientLatencyMs)) {
      fail(`ledger row ${index + 1} is not a unique accepted app-surface commit`);
    }
    requestIds.add(entry.requestId);
  }
  const latencies = ledger.map((entry) => entry.clientLatencyMs);
  assertEqual(sample.client, { count: 50, p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) }, "client nearest-rank summary");
  assertEqual(sample.callerColoDistribution, distribution(ledger), "caller colo distribution");
  assertEqual(sample?.protocol?.structurallyRemovedG41Rows, STRUCTURALLY_REMOVED_G41_ROWS, "G41/G47 structurally removed rows");

  const telemetry = sample?.telemetry;
  const traces = telemetry?.retainedTraceTelemetry?.traces;
  const observations = telemetry?.retainedTraceTelemetry?.observations;
  if (!Array.isArray(traces) || !Array.isArray(observations)) fail("retained snapshot telemetry is absent");
  if (telemetry?.ingestion?.status !== "settled" || telemetry?.snapshotRoots?.rootSource !== "snapshot-log"
      || telemetry?.snapshotRoots?.retainedTraceCount !== 50 || telemetry?.snapshotRoots?.schemaCompleteTraceCount !== 50
      || telemetry?.observedTraceCount !== 50 || telemetry?.schemaCompleteTraceCount !== 50 || telemetry?.descriptiveLossCount !== 0) {
    fail("snapshot-root ingestion receipt is incomplete");
  }
  if (traces.length !== 50 || !traces.every((trace) => trace?.rootSource === "snapshot-log" && trace?.snapshotLogTruncated === false)) {
    fail("retained cohort is not wholly rooted in snapshot logs");
  }
  const recomputedPerHop = perHop(traces);
  assertEqual(telemetry?.perHopDescriptiveMedians, recomputedPerHop, "per-hop medians");
  assertEqual(telemetry?.doObservationMedians, actorMedians(observations), "DO observation medians");
  const expectedRanking = residualRanking(recomputedPerHop);
  const recordedRanking = (telemetry?.residualRanking ?? []).map((entry) => ({
    rowId: entry?.rowId,
    medianMs: entry?.medianMs,
    observedSpanCount: entry?.observedSpanCount,
  }));
  assertEqual(recordedRanking, expectedRanking, "residual ranking");
  return Object.freeze({
    sampleCount: ledger.length,
    client: sample.client,
    callerColoDistribution: sample.callerColoDistribution,
    rootSource: telemetry.snapshotRoots.rootSource,
    activePerHopRows: recomputedPerHop.length,
    doActorClasses: telemetry.doObservationMedians.length,
  });
}

function assertMutantRejected(sample, mutate, label) {
  const mutant = structuredClone(sample);
  mutate(mutant);
  try {
    validateG52Sample(mutant);
  } catch {
    return "red";
  }
  fail(`${label} mutant was accepted`);
}

function main() {
  const path = argument("--sample");
  if (typeof path !== "string" || path.length === 0) fail("--sample is required");
  const sample = JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8"));
  const result = validateG52Sample(sample);
  const selfTest = process.argv.includes("--self-test") ? {
    rootSourceOmission: assertMutantRejected(sample, (mutant) => { mutant.telemetry.retainedTraceTelemetry.traces[0].rootSource = "native-span"; }, "snapshot root source"),
    perHopOmission: assertMutantRejected(sample, (mutant) => { mutant.telemetry.perHopDescriptiveMedians.pop(); }, "per-hop row"),
    percentileMutation: assertMutantRejected(sample, (mutant) => { mutant.client.p95 += 1; }, "client percentile"),
  } : undefined;
  process.stdout.write(`${JSON.stringify({ result: "g52-commit-breakdown-valid", ...result, ...(selfTest === undefined ? {} : { selfTest }) }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
