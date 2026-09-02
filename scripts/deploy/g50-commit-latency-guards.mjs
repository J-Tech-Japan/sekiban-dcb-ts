#!/usr/bin/env node
/** Non-live guards for the SDT-G50 app-surface sampler. */
import { captureG50AppCommitLatency, ACTIVE_PER_HOP_ROWS } from "./g50-commit-latency.mjs";

function fail(message) {
  throw new Error(`g50-commit-latency-guards:${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function committedResponse(requestNumber) {
  return new Response(JSON.stringify({
    kind: "committed",
    response: {
      writtenEvents: [{ sortableUniqueIdValue: String(requestNumber).padStart(30, "0") }],
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json", "cf-ray": `${requestNumber.toString(16).padStart(16, "0")}-SJC` },
  });
}

function retainedTelemetry() {
  return {
    queryWindow: { from: 1, to: 2 },
    observedTraceCount: 50,
    schemaCompleteTraceCount: 50,
    descriptiveLossCount: 0,
    workerColoDistribution: { SJC: 50 },
    perHopDescriptiveMedians: ACTIVE_PER_HOP_ROWS.map((rowId, index) => ({
      rowId,
      observedSpanCount: 50,
      medianMs: index + 1,
    })),
    retainedTraceTelemetry: {
      traces: [{ requestId: "0000000000000001-SJC", spans: ACTIVE_PER_HOP_ROWS.map((rowId, index) => ({ rowId, startMs: index, endMs: index + 1 })) }],
      observations: [],
    },
  };
}

async function appSurfaceAndWarmupGuard() {
  const originalNow = Date.now;
  let clock = 10_000;
  let requests = 0;
  const paths = [];
  Date.now = () => {
    clock += 10;
    return clock;
  };
  try {
    const sample = await captureG50AppCommitLatency({
      baseUrl: "https://guard.invalid",
      accountId: "guard-account",
      observabilityToken: "guard-observability-token",
      serviceId: "guard-service",
      versionId: "guard-version",
      sourceCommit: "a".repeat(40),
      sampleCount: 50,
      settleMs: 0,
      runId: "guard-run-0001",
      queryTemplate: {},
      fetchImpl: async (url, init) => {
        requests += 1;
        const path = new URL(url).pathname;
        paths.push({ path, method: init?.method, body: JSON.parse(init?.body ?? "{}") });
        return committedResponse(requests);
      },
      captureTelemetry: async ({ ledger }) => {
        assert(ledger.length === 50, "telemetry did not receive exactly 50 accepted requests");
        assert(ledger.every((entry) => entry.endpoint === "POST /api/commands/create-room"), "telemetry received a non-app command ledger entry");
        return retainedTelemetry();
      },
    });
    assert(requests === 51, "sampler did not issue exactly one warmup plus 50 samples");
    assert(paths.every((entry) => entry.path === "/api/commands/create-room" && entry.method === "POST"), "sampler left the app command surface");
    assert(paths.every((entry) => typeof entry.body.roomId === "string"), "sampler did not use unique room app commands");
    assert(sample.protocol.discardedWarmupRequests === 1 && sample.protocol.discardedFailedRequests === 0, "discard accounting drifted");
    assert(sample.warmup.phase === "discarded-warmup" && sample.ledger.every((entry) => entry.phase === "sample"), "warmup leaked into the measured ledger");
    assert(sample.client.count === 50 && sample.client.p50 === 10 && sample.client.p95 === 10, "nearest-rank client summary drifted");
    assert(sample.telemetry.perHopDescriptiveMedians.length === ACTIVE_PER_HOP_ROWS.length, "per-hop table lost an active row");
    return {
      passed: true,
      appRequests: requests,
      acceptedSamples: sample.client.count,
      discardedWarmups: sample.protocol.discardedWarmupRequests,
      p50: sample.client.p50,
      p95: sample.client.p95,
    };
  } finally {
    Date.now = originalNow;
  }
}

async function blockedByDefectGuard() {
  const sample = await captureG50AppCommitLatency({
    baseUrl: "https://guard.invalid",
    accountId: "guard-account",
    observabilityToken: "guard-observability-token",
    serviceId: "guard-service",
    versionId: "guard-version",
    sourceCommit: "b".repeat(40),
    sampleCount: 50,
    settleMs: 0,
    runId: "guard-run-0002",
    queryTemplate: {},
    fetchImpl: async () => committedResponse(1),
    captureTelemetry: async () => ({
      queryWindow: { from: 1, to: 2 },
      observedTraceCount: 0,
      schemaCompleteTraceCount: 0,
      descriptiveLossCount: 50,
      workerColoDistribution: {},
      perHopDescriptiveMedians: [],
      retainedTraceTelemetry: { traces: [], observations: [] },
    }),
  });
  assert(sample.telemetry.perHopStatus === "blocked-by-defect", "zero-trace telemetry was not named as blocked-by-defect");
  assert(sample.telemetry.retainedTraceCount === 0, "zero-trace telemetry reported retained traces");
  assert(sample.telemetry.perHopDescriptiveMedians.length === 0, "zero-trace telemetry invented per-hop medians");
  assert(JSON.stringify(sample.telemetry.activePerHopRowsMissing) === JSON.stringify(ACTIVE_PER_HOP_ROWS), "zero-trace telemetry did not retain every missing active row");
  return { result: "blocked-by-defect", missingActiveRows: sample.telemetry.activePerHopRowsMissing.length };
}

async function rejectedCommandStopsGuard() {
  let requests = 0;
  let rejected = false;
  try {
    await captureG50AppCommitLatency({
      baseUrl: "https://guard.invalid",
      accountId: "guard-account",
      observabilityToken: "guard-observability-token",
      serviceId: "guard-service",
      versionId: "guard-version",
      sourceCommit: "c".repeat(40),
      sampleCount: 50,
      settleMs: 0,
      runId: "guard-run-0003",
      queryTemplate: {},
      fetchImpl: async () => {
        requests += 1;
        return new Response(JSON.stringify({ kind: "failed" }), { status: 500, headers: { "content-type": "application/json", "cf-ray": "0000000000000001-SJC" } });
      },
      captureTelemetry: async () => retainedTelemetry(),
    });
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("not an accepted commit");
  }
  assert(rejected, "rejected warmup command was accepted");
  assert(requests === 1, "sampler continued after a rejected app command");
  return { result: "red", rejectedRequestsBeforeStop: requests };
}

const results = {
  appSurfaceAndWarmup: await appSurfaceAndWarmupGuard(),
  blockedByDefect: await blockedByDefectGuard(),
  rejectedCommandStops: await rejectedCommandStopsGuard(),
};
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
