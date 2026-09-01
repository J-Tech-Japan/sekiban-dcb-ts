#!/usr/bin/env node
/** Recompute the SDT-G50 committed client and retained-trace summaries. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACTIVE_PER_HOP_ROWS, STRUCTURALLY_REMOVED_G41_ROWS } from "./g50-commit-latency.mjs";

const root = process.cwd();

function fail(message) {
  throw new Error(`g50-commit-latency-check:${message}`);
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] ?? null;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label} expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
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
      if (!ACTIVE_PER_HOP_ROWS.includes(span?.rowId) || !Number.isFinite(span?.startMs) || !Number.isFinite(span?.endMs)) continue;
      const durations = byRow.get(span.rowId) ?? [];
      durations.push(Math.max(0, span.endMs - span.startMs));
      byRow.set(span.rowId, durations);
    }
  }
  return new Map([...byRow.entries()].map(([rowId, durations]) => [rowId, {
    observedSpanCount: durations.length,
    medianMs: percentile(durations, 0.50),
  }]));
}

export function validateG50Sample(sample) {
  if (sample?.schema !== "sdt-g50-commit-latency/v1" || sample?.task !== "SDT-G50") fail("sample schema/task is invalid");
  if (typeof sample?.deployed?.serviceId !== "string" || typeof sample?.deployed?.versionId !== "string" || !/^[0-9a-f]{40}$/.test(sample?.deployed?.sourceCommit ?? "")) {
    fail("deployed identity is incomplete");
  }
  const ledger = sample.ledger;
  if (!Array.isArray(ledger) || ledger.length < 50) fail("sample has fewer than 50 accepted ledger rows");
  if (sample?.protocol?.appSurface !== "POST /api/commands/create-room" || sample?.protocol?.acceptedSampleRequests !== ledger.length
      || sample?.protocol?.discardedWarmupRequests !== 1 || sample?.protocol?.discardedFailedRequests !== 0) {
    fail("app-surface or discard accounting is invalid");
  }
  if (sample?.warmup?.phase !== "discarded-warmup" || sample?.warmup?.status !== 200) fail("warm-up receipt is invalid");
  for (const [index, row] of ledger.entries()) {
    if (row?.ordinal !== index + 1 || row?.phase !== "sample" || row?.endpoint !== "POST /api/commands/create-room" || row?.status !== 200
        || typeof row?.requestId !== "string" || !Number.isFinite(row?.clientLatencyMs)) {
      fail(`ledger row ${index + 1} is not an accepted app-surface commit`);
    }
  }
  const latencies = ledger.map((row) => row.clientLatencyMs);
  assertEqual(sample?.client?.count, ledger.length, "client count");
  assertEqual(sample?.client?.p50, percentile(latencies, 0.50), "client p50");
  assertEqual(sample?.client?.p95, percentile(latencies, 0.95), "client p95");
  assertEqual(JSON.stringify(sample?.callerColoDistribution), JSON.stringify(distribution(ledger)), "caller colo distribution");
  assertEqual(JSON.stringify(sample?.protocol?.structurallyRemovedG41Rows), JSON.stringify(STRUCTURALLY_REMOVED_G41_ROWS), "removed Journal rows");
  assertEqual(JSON.stringify(sample?.protocol?.activePerHopRows), JSON.stringify(ACTIVE_PER_HOP_ROWS), "active per-hop row contract");

  const telemetry = sample?.telemetry;
  const traces = telemetry?.retainedTraceTelemetry?.traces;
  if (!Array.isArray(traces)) fail("retained trace telemetry is absent");
  if (!Number.isFinite(telemetry?.queryWindow?.from) || !Number.isFinite(telemetry?.queryWindow?.to)
      || telemetry.queryWindow.to < telemetry.queryWindow.from) {
    fail("retained trace query window is invalid");
  }
  if (telemetry?.perHopStatus === "blocked-by-defect") {
    assertEqual(traces.length, 0, "blocked retained trace count");
    assertEqual(telemetry?.retainedTraceCount, 0, "blocked retained trace receipt");
    assertEqual(telemetry?.observedTraceCount, 0, "blocked observed trace count");
    assertEqual(telemetry?.schemaCompleteTraceCount, 0, "blocked schema-complete trace count");
    assertEqual(telemetry?.descriptiveLossCount, ledger.length, "blocked descriptive loss count");
    assertEqual(JSON.stringify(telemetry?.perHopDescriptiveMedians), JSON.stringify([]), "blocked per-hop medians");
    assertEqual(JSON.stringify(telemetry?.activePerHopRowsMissing), JSON.stringify(ACTIVE_PER_HOP_ROWS), "blocked active per-hop rows");
    return Object.freeze({
      sampleCount: ledger.length,
      client: sample.client,
      callerColoDistribution: sample.callerColoDistribution,
      activeRows: 0,
      perHopStatus: telemetry.perHopStatus,
    });
  }
  if (telemetry?.perHopStatus !== "available") fail("per-hop status is neither available nor blocked-by-defect");
  if (traces.length === 0) fail("retained trace telemetry is absent");
  assertEqual(telemetry?.retainedTraceCount, traces.length, "retained trace receipt");
  const ledgerRequestIds = new Set(ledger.map((row) => row.requestId));
  if (!traces.every((trace) => ledgerRequestIds.has(trace?.requestId))) fail("retained trace telemetry contains a non-window request");
  const actual = perHop(traces);
  const reported = new Map((telemetry?.perHopDescriptiveMedians ?? []).map((row) => [row?.rowId, row]));
  for (const rowId of ACTIVE_PER_HOP_ROWS) {
    const expected = actual.get(rowId);
    const row = reported.get(rowId);
    if (expected === undefined || row === undefined) fail(`active per-hop row ${rowId} is missing`);
    assertEqual(row.observedSpanCount, expected.observedSpanCount, `${rowId} observed span count`);
    assertEqual(row.medianMs, expected.medianMs, `${rowId} median`);
  }
  return Object.freeze({
    sampleCount: ledger.length,
    client: sample.client,
    callerColoDistribution: sample.callerColoDistribution,
    activeRows: ACTIVE_PER_HOP_ROWS.length,
    perHopStatus: telemetry.perHopStatus,
  });
}

function assertMutantRejected(sample, mutate, label) {
  const mutant = structuredClone(sample);
  mutate(mutant);
  let rejected = false;
  try {
    validateG50Sample(mutant);
  } catch {
    rejected = true;
  }
  if (!rejected) fail(`${label} mutant was accepted`);
  return "red";
}

try {
  const samplePath = argument("--sample");
  if (typeof samplePath !== "string" || samplePath.length === 0) fail("--sample is required");
  const sample = JSON.parse(readFileSync(resolve(root, samplePath), "utf8"));
  const result = validateG50Sample(sample);
  const selfTest = process.argv.includes("--self-test")
    ? {
      clientPercentileMutation: assertMutantRejected(sample, (mutant) => { mutant.client.p95 += 1; }, "client percentile"),
      activeHopMutation: assertMutantRejected(sample, (mutant) => {
        if (mutant.telemetry.perHopStatus === "blocked-by-defect") {
          mutant.telemetry.activePerHopRowsMissing = mutant.telemetry.activePerHopRowsMissing.filter((rowId) => rowId !== "S14");
          return;
        }
        mutant.telemetry.perHopDescriptiveMedians.find((row) => row.rowId === "S14").medianMs += 1;
      }, "active per-hop"),
      appRouteMutation: assertMutantRejected(sample, (mutant) => { mutant.ledger[0].endpoint = "POST /conformance/v1/api/sekiban/serialized/commit"; }, "app route"),
    }
    : undefined;
  process.stdout.write(`${JSON.stringify({ result: "g50-commit-latency-valid", ...result, ...(selfTest === undefined ? {} : { selfTest }) }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
