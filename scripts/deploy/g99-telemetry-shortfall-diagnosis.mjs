#!/usr/bin/env node
/**
 * SDT-G99: diagnose a g50 tip latency receipt for per-hop telemetry shortfall.
 * Read-only; does not claim a product fix.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function fail(message) {
  throw new Error(`g99-telemetry-shortfall-diagnosis:${message}`);
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function diagnose(sample) {
  if (sample?.schema !== "sdt-g50-commit-latency/v1") fail("sample schema must be sdt-g50-commit-latency/v1");
  const telemetry = sample.telemetry ?? {};
  const ingestion = telemetry.ingestion ?? {};
  const clientOk = sample.client?.count === 50
    && sample.protocol?.acceptedSampleRequests === 50
    && sample.protocol?.discardedFailedRequests === 0;
  const tipMessageOk = typeof sample.deployed?.sourceCommit === "string"
    && sample.deployed.sourceCommit.length === 40;
  const observed = Number(ingestion.observedRequestCount ?? telemetry.observedTraceCount ?? 0);
  const expected = Number(ingestion.expectedRequestCount ?? sample.client?.count ?? 0);
  const shortfall = observed === 0 && expected > 0;
  const historicalSameShape = telemetry.perHopStatus === "blocked-by-defect" && shortfall;
  return Object.freeze({
    schema: "sdt-g99-telemetry-shortfall-diagnosis/v1",
    sample: {
      runId: sample.runId ?? null,
      versionId: sample.deployed?.versionId ?? null,
      sourceCommit: sample.deployed?.sourceCommit ?? null,
      clientP50: sample.client?.p50 ?? null,
      clientP95: sample.client?.p95 ?? null,
    },
    findings: Object.freeze({
      clientCohortComplete: clientOk,
      tipIdentityFieldsPresent: tipMessageOk,
      observabilityQueryRan: ingestion.status !== undefined,
      ingestionStatus: ingestion.status ?? null,
      observedRequestCount: observed,
      expectedRequestCount: expected,
      perHopStatus: telemetry.perHopStatus ?? null,
      descriptiveLossCount: telemetry.descriptiveLossCount ?? null,
      attempts: Array.isArray(ingestion.attempts) ? ingestion.attempts.length : 0,
    }),
    classification: shortfall
      ? "workers-observability-ingestion-shortfall"
      : "not-a-full-shortfall",
    likelyNextChecks: Object.freeze([
      "Confirm Workers Observability retained traces exist in dashboard for the tip Version ID during the sample window",
      "Compare CF-Ray / platform ray join in g30-trace-export against tip-emitted spans",
      "Verify npm-consumer tip bundle still emits CommitTrace / native spans (G51 regression path)",
      "Treat as follow-on execution unit if shortfall reproduces on tip after native-span probe",
    ]),
    note: historicalSameShape
      ? "Same blocked-by-defect + observedRequestCount=0 shape as historical .artifacts/sdt-g50-w57-commit-latency.json; tip path did not introduce a new client-cohort failure mode."
      : "Client cohort and ingestion outcomes differ from the historical w57 shortfall shape.",
  });
}

function selfTest() {
  const sample = {
    schema: "sdt-g50-commit-latency/v1",
    runId: "self-test",
    deployed: { versionId: "v", sourceCommit: "a".repeat(40) },
    protocol: { acceptedSampleRequests: 50, discardedFailedRequests: 0 },
    client: { count: 50, p50: 1, p95: 2 },
    telemetry: {
      perHopStatus: "blocked-by-defect",
      observedTraceCount: 0,
      descriptiveLossCount: 50,
      ingestion: { status: "shortfall", expectedRequestCount: 50, observedRequestCount: 0, attempts: [{ attempt: 1 }] },
    },
  };
  const result = diagnose(sample);
  if (result.classification !== "workers-observability-ingestion-shortfall") {
    fail("self-test expected shortfall classification");
  }
  if (!result.findings.clientCohortComplete) fail("self-test client cohort");
  return { status: "PASS", guard: "sdt-g99-telemetry-shortfall-diagnosis", selfTest: true };
}

if (process.argv.includes("--self-test")) {
  process.stdout.write(`${JSON.stringify(selfTest(), null, 2)}\n`);
} else {
  const samplePath = resolve(argument("--sample", ".artifacts/sdt-g99-g50-tip-commit-latency.json"));
  const sample = JSON.parse(await readFile(samplePath, "utf8"));
  process.stdout.write(`${JSON.stringify(diagnose(sample), null, 2)}\n`);
}
