#!/usr/bin/env node
/**
 * SDT-G52 deployed-composition and retained-snapshot omission guards.
 *
 * The self-test exercises both C-12 mutants in memory. It never writes a
 * source file or reaches Cloudflare, so CI proves the guard is red without
 * risking a temporary deployment composition change.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeTelemetryBundle } from "./deploy/g30-trace-export.mjs";

const root = process.cwd();
const compositionFiles = Object.freeze([
  "packages/dcb-runtime/src/cloudflare.ts",
  "packages/dcb-runtime/src/index.ts",
]);

function fail(message) {
  throw new Error(`g52-commit-snapshot-guard:${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function read(relative) {
  return readFileSync(resolve(root, relative), "utf8");
}

export function assertDeployedCompositionSink(sources) {
  for (const [relative, source] of Object.entries(sources)) {
    assert(source.includes('import { createCommitTraceConsoleSink } from "./trace/CommitTraceConsoleSink";'), `${relative} does not import the retained snapshot sink`);
    assert(source.includes("commitTraceSink: createCommitTraceConsoleSink({"), `${relative} does not supply commitTraceSink to the deployed commit handler`);
    assert(source.includes('platformRequestId: request.headers.get("cf-ray") ?? undefined'), `${relative} does not retain the known ingress CF-Ray for the snapshot join`);
  }
  return Object.freeze({ files: Object.keys(sources).sort(), result: "deployed-commit-snapshot-sink-present" });
}

function assertExporterSource(source) {
  for (const required of [
    "function snapshotPayload(event)",
    "function normalizedSnapshotLog(payload, event)",
    'rootSource: "snapshot-log"',
    "snapshot log is missing mapped success row(s)",
  ]) {
    assert(source.includes(required), `exporter does not retain required snapshot-log guard anchor ${required}`);
  }
  return "snapshot-log-root-and-row-guard-present";
}

function expectRed(callback, label) {
  try {
    callback();
  } catch {
    return "red";
  }
  fail(`${label} omission mutant was accepted`);
}

function snapshotMissingMappedRowFixture() {
  return {
    events: [{
      source: {
        schema: "sdt.commit-snapshot/v1",
        event: "commit.snapshot",
        snapshotSchema: "sdt.commit/v1",
        correlationId: "g52-guard-correlation",
        serviceId: "g52-guard-service",
        platformRequestId: "0000000000000052-SJC",
        rootId: "g52-guard-root",
        rootStartedAtMs: 1_000,
        rootEndedAtMs: 1_100,
        // S00 is deliberately the only retained row: the exporter must fail
        // before an incomplete log can be classified as a healthy trace.
        rows: [{
          rowId: "S00",
          name: "sdt.commit",
          "sdt.row.id": "S00",
          startOffsetMs: 0,
          endOffsetMs: 100,
          durationMs: 100,
          face: "accepted",
          clockDomain: "caller",
          zeroDurationPlatformLimited: false,
          attributes: {
            "schema.version": "sdt.commit/v1",
            "correlation.id": "g52-guard-correlation",
            "service.id": "g52-guard-service",
            "attempt.id": "00000000-0000-4000-8000-000000000052",
            operation: "sdt.commit",
            "span.kind": "internal",
            outcome: "success",
            "http.status": 200,
          },
        }],
      },
    }],
  };
}

function sourcesFromDisk() {
  return Object.fromEntries(compositionFiles.map((relative) => [relative, read(relative)]));
}

function selfTest() {
  const sources = sourcesFromDisk();
  const sourceWithOmittedSink = Object.fromEntries(Object.entries(sources).map(([relative, source]) => [
    relative,
    relative === "packages/dcb-runtime/src/cloudflare.ts"
      ? source.replace(/\n\s*commitTraceSink: createCommitTraceConsoleSink\(\{[\s\S]*?\n\s*\}\),/, "")
      : source,
  ]));
  return Object.freeze({
    deployedCompositionSinkOmissionMutant: expectRed(
      () => assertDeployedCompositionSink(sourceWithOmittedSink),
      "deployed composition sink",
    ),
    snapshotMappedRowOmissionMutant: expectRed(
      () => normalizeTelemetryBundle(snapshotMissingMappedRowFixture(), 1_200),
      "snapshot mapped row",
    ),
    result: "g52-omission-mutants-red",
  });
}

function main() {
  const composition = assertDeployedCompositionSink(sourcesFromDisk());
  const exporter = assertExporterSource(read("scripts/deploy/g30-trace-export.mjs"));
  const result = {
    composition,
    exporter,
    ...(process.argv.includes("--self-test") ? { selfTest: selfTest() } : {}),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main();
