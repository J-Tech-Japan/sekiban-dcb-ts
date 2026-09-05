#!/usr/bin/env node
/** Validate the durable SDT-G57 AC5 comparison receipt and its mutants. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MODES = ["read-through", "snapshot-only"];

function fail(message) {
  throw new Error(`g57-executor-measure-guard:${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] ?? null;
}

function validateMode(mode) {
  assert(MODES.includes(mode?.mode), "unexpected mode");
  assert(Number.isSafeInteger(mode?.sampleCount) && mode.sampleCount >= 50, `${mode?.mode} has fewer than 50 samples`);
  assert(mode?.expectedTagStateReadsPerCommit === (mode.mode === "snapshot-only" ? 0 : 1), `${mode?.mode} read accounting drifted`);
  assert(mode?.expectedTagStateReadsSavedPerCommit === (mode.mode === "snapshot-only" ? 1 : 0), `${mode?.mode} saved-read accounting drifted`);
  assert(mode?.warmup?.phase === "discarded-warmup" && mode.warmup.status === 200, `${mode?.mode} warmup is invalid`);
  assert(Array.isArray(mode?.ledger) && mode.ledger.length === mode.sampleCount, `${mode?.mode} ledger count is invalid`);
  for (const [index, row] of mode.ledger.entries()) {
    assert(row.ordinal === index + 1 && row.phase === "sample" && row.mode === mode.mode, `${mode.mode} row ${index + 1} identity is invalid`);
    assert(row.status === 200 && row.body?.kind === "committed", `${mode.mode} row ${index + 1} was not committed`);
    assert(typeof row.suid === "string" && Number.isFinite(row.clientLatencyMs), `${mode.mode} row ${index + 1} timing is invalid`);
    assert(row.command?.body?.executor?.readMode === mode.mode, `${mode.mode} row ${index + 1} mode envelope is invalid`);
    if (mode.mode === "snapshot-only") {
      assert(row.command.body.executor.snapshots?.length === 1, `${mode.mode} row ${index + 1} omitted its snapshot`);
      assert(row.command.body.executor.snapshots[0]?.head === null && row.command.body.executor.snapshots[0]?.exists === false, `${mode.mode} row ${index + 1} snapshot is not assert-empty`);
    } else {
      assert(Array.isArray(row.command.body.executor.snapshots) && row.command.body.executor.snapshots.length === 0, `${mode.mode} row ${index + 1} unexpectedly supplied a snapshot`);
    }
  }
  const latencies = mode.ledger.map((row) => row.clientLatencyMs);
  assert(mode.client?.count === latencies.length, `${mode.mode} count summary is invalid`);
  assert(mode.client?.p50 === percentile(latencies, 0.50), `${mode.mode} p50 summary is invalid`);
  assert(mode.client?.p95 === percentile(latencies, 0.95), `${mode.mode} p95 summary is invalid`);
}

export function validateMeasurement(sample) {
  assert(sample?.schema === "sdt-g57-executor-g50-comparison/v1", "schema is invalid");
  assert(sample?.task === "SDT-G57", "task is invalid");
  assert(typeof sample?.deployed?.baseUrl === "string" && typeof sample?.deployed?.versionId === "string", "deployed identity is incomplete");
  assert(/^[0-9a-f]{40}$/.test(sample?.deployed?.sourceCommit ?? ""), "source identity is invalid");
  assert(JSON.stringify(sample?.protocol?.modes) === JSON.stringify(MODES), "mode protocol is invalid");
  assert(Array.isArray(sample?.modes) && sample.modes.length === 2, "both mode receipts are required");
  for (const mode of sample.modes) validateMode(mode);
  assert(sample.modes[0].mode === "read-through" && sample.modes[1].mode === "snapshot-only", "mode order is invalid");
  assert(sample.comparison?.expectedTagStateReadsSavedPerCommit === 1, "saved-read comparison is invalid");
  return {
    readThrough: sample.modes[0].client,
    snapshotOnly: sample.modes[1].client,
    expectedTagStateReadsSavedPerCommit: sample.comparison.expectedTagStateReadsSavedPerCommit,
  };
}

function assertMutantRed(sample, mutate, label) {
  const mutant = structuredClone(sample);
  mutate(mutant);
  let red = false;
  try {
    validateMeasurement(mutant);
  } catch {
    red = true;
  }
  assert(red, `${label} mutant was accepted`);
  return "red";
}

const samplePath = process.argv[process.argv.indexOf("--sample") + 1];
if (typeof samplePath !== "string" || samplePath.startsWith("--")) fail("--sample is required");
const sample = JSON.parse(readFileSync(resolve(samplePath), "utf8"));
const result = validateMeasurement(sample);
if (process.argv.includes("--self-test")) {
  result.modeMutant = assertMutantRed(sample, (mutant) => { mutant.modes[1].ledger[0].command.body.executor.readMode = "read-through"; }, "mode");
  result.percentileMutant = assertMutantRed(sample, (mutant) => { mutant.modes[0].client.p95 += 1; }, "percentile");
}
process.stdout.write(`${JSON.stringify({ result: "g57-executor-measurement-valid", ...result }, null, 2)}\n`);
