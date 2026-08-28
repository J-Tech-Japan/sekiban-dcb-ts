#!/usr/bin/env node
/**
 * Verifies the committed, privacy-safe A-5 sample data used by the SDT-G37
 * before/after evidence.  It deliberately performs no network I/O: this is
 * a reproducibility check for the recorded windows, not a new measurement.
 */
import { readFileSync } from "node:fs";

const DEFAULT_INPUT = "docs/evidence/SDT-G37-a5-sanitized-samples.json";
const WINDOW_NAMES = new Set(["immediate-before", "after", "repeat"]);
const FORBIDDEN_KEYS = new Set([
  "requestId",
  "rayId",
  "correlationId",
  "traceId",
  "suid",
  "serviceId",
  "fixture",
  "tag",
  "payload",
  "token",
]);

function fail(message) {
  throw new Error(`g37-sanitized-evidence:${message}`);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} must be an integer >= ${minimum}`);
  return value;
}

function nearestRank(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) fail("nearest-rank needs at least one value");
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * fraction) - 1];
}

function expandedHistogram(histogram, label) {
  const record = object(histogram, label);
  const values = [];
  for (const [durationText, count] of Object.entries(record)) {
    if (!/^\d+$/.test(durationText)) fail(`${label} duration key is not a non-negative integer`);
    const duration = Number(durationText);
    integer(duration, `${label}.${durationText}`);
    const multiplicity = integer(count, `${label}.${durationText}.count`, 1);
    values.push(...Array.from({ length: multiplicity }, () => duration));
  }
  if (values.length === 0) fail(`${label} is empty`);
  return values;
}

function assertSanitized(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSanitized(entry, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) fail(`${path}.${key} is forbidden in committed evidence`);
      assertSanitized(entry, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string") {
    if (/Bearer\s+/i.test(value)) fail(`${path} contains a bearer credential`);
    if (/\b\d{30}\b/.test(value)) fail(`${path} contains a 30-digit SUID`);
  }
}

function inspectWindow(window) {
  const record = object(window, "window");
  if (!WINDOW_NAMES.has(record.name)) fail(`unexpected window name ${String(record.name)}`);
  const provenance = object(record.provenance, `${record.name}.provenance`);
  if (typeof provenance.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(provenance.sourceCommit)) {
    fail(`${record.name}.provenance.sourceCommit must be a full commit SHA`);
  }
  const deployedVersion = object(provenance.deployedVersion, `${record.name}.provenance.deployedVersion`);
  if (typeof deployedVersion.id !== "string" || deployedVersion.id.length === 0) fail(`${record.name} lacks deployed version provenance`);
  integer(deployedVersion.number, `${record.name}.provenance.deployedVersion.number`, 1);

  const client = object(record.client, `${record.name}.client`);
  if (client.acceptedHttpStatus !== 200) fail(`${record.name}.client must represent accepted HTTP 200 samples`);
  if (client.sampleCount !== 50) fail(`${record.name}.client sampleCount must be exactly 50`);
  if (client.estimator !== "nearest-rank") fail(`${record.name}.client estimator must be nearest-rank`);
  if (!Array.isArray(client.ordinalLatencyMs) || client.ordinalLatencyMs.length !== 50) {
    fail(`${record.name}.client needs exactly 50 ordinal latency values`);
  }
  const latencies = client.ordinalLatencyMs.map((sample, index) => {
    const entry = object(sample, `${record.name}.client.ordinalLatencyMs[${index}]`);
    if (entry.ordinal !== index + 1) fail(`${record.name}.client ordinal ${index + 1} is missing or reordered`);
    return integer(entry.clientLatencyMs, `${record.name}.client latency at ordinal ${index + 1}`);
  });
  const reported = object(client.reported, `${record.name}.client.reported`);
  const p50 = nearestRank(latencies, 0.50);
  const p95 = nearestRank(latencies, 0.95);
  if (reported.p50 !== p50 || reported.p95 !== p95) {
    fail(`${record.name}.client nearest-rank mismatch: expected ${p50}/${p95}, recorded ${reported.p50}/${reported.p95}`);
  }

  const telemetry = object(record.telemetry, `${record.name}.telemetry`);
  integer(telemetry.observedTraceCount, `${record.name}.telemetry.observedTraceCount`);
  integer(telemetry.schemaCompleteTraceCount, `${record.name}.telemetry.schemaCompleteTraceCount`);
  integer(telemetry.descriptiveLossCount, `${record.name}.telemetry.descriptiveLossCount`);
  if (!Array.isArray(telemetry.perHopDurationInputs) || telemetry.perHopDurationInputs.length === 0) {
    fail(`${record.name}.telemetry needs per-hop duration inputs`);
  }
  const rowIds = new Set();
  for (const row of telemetry.perHopDurationInputs) {
    const input = object(row, `${record.name}.telemetry.perHopDurationInputs[]`);
    if (typeof input.rowId !== "string" || !/^S\d{2}[a-e]?$/.test(input.rowId)) {
      fail(`${record.name} has an invalid row ID`);
    }
    if (rowIds.has(input.rowId)) fail(`${record.name} repeats per-hop row ${input.rowId}`);
    rowIds.add(input.rowId);
    const values = expandedHistogram(input.durationHistogramMs, `${record.name}.${input.rowId}.durationHistogramMs`);
    if (values.length !== integer(input.observedSpanCount, `${record.name}.${input.rowId}.observedSpanCount`, 1)) {
      fail(`${record.name}.${input.rowId} histogram count does not match observedSpanCount`);
    }
    const median = nearestRank(values, 0.50);
    if (median !== input.reportedMedianMs) {
      fail(`${record.name}.${input.rowId} median mismatch: expected ${median}, recorded ${input.reportedMedianMs}`);
    }
  }
  return { name: record.name, p50, p95, rows: rowIds.size };
}

const input = process.argv[2] ?? DEFAULT_INPUT;
const document = JSON.parse(readFileSync(input, "utf8"));
object(document, "document");
if (document.schema !== "sdt-g37-sanitized-samples/v1") fail("unexpected evidence schema");
assertSanitized(document);
if (!Array.isArray(document.windows) || document.windows.length !== WINDOW_NAMES.size) {
  fail("evidence must contain exactly the immediate-before, after, and repeat windows");
}
const summaries = document.windows.map(inspectWindow);
if (new Set(summaries.map(({ name }) => name)).size !== WINDOW_NAMES.size) fail("evidence repeats a window name");
for (const name of WINDOW_NAMES) {
  if (!summaries.some((summary) => summary.name === name)) fail(`evidence is missing ${name}`);
}
console.log(JSON.stringify({ schema: document.schema, verified: summaries }, null, 2));
