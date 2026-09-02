#!/usr/bin/env node
/** Focused non-live checks for G51's bounded retained-trace ingestion poll. */
import { telemetryForLedger } from "./g37-sample.mjs";

const ledger = Object.freeze([
  Object.freeze({ requestId: "0000000000000001-SJC", startedAtMs: 1_000, completedAtMs: 1_020 }),
  Object.freeze({ requestId: "0000000000000002-SJC", startedAtMs: 1_030, completedAtMs: 1_050 }),
]);

function fail(message) {
  throw new Error(`g51-ingestion-poll-guards:${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function clockedDependencies(results) {
  let clock = 1_050;
  let calls = 0;
  const windows = [];
  return {
    now: () => clock,
    sleepFor: async (milliseconds) => { clock += milliseconds; },
    queryCohort: async ({ template }) => {
      calls += 1;
      windows.push(template.timeframe);
      return { call: calls };
    },
    normalizeBundle: (raw) => ({
      traces: results[Math.min(raw.call - 1, results.length - 1)],
      observations: [],
    }),
    calls: () => calls,
    windows: () => windows,
  };
}

async function settlesWhenEveryRayArrives() {
  const dependencies = clockedDependencies([
    [{ requestId: ledger[0].requestId, spans: [] }],
    [{ requestId: ledger[0].requestId, spans: [] }, { requestId: ledger[1].requestId, spans: [] }],
  ]);
  const telemetry = await telemetryForLedger({
    accountId: "guard-account",
    observabilityToken: "guard-observability-token",
    template: {},
    ledger,
    ingestionTimeoutMs: 30,
    ingestionPollIntervalMs: 10,
    ...dependencies,
  });
  assert(telemetry.status === "available", "complete ray cohort was not marked available");
  assert(telemetry.ingestion.status === "settled", "complete ray cohort did not settle");
  assert(telemetry.ingestion.attempts.length === 2 && dependencies.calls() === 2, "poll did not re-query for the missing ray");
  assert(telemetry.observedIngestionLagMs === 10, "ingestion lag was not measured from client completion");
  assert(dependencies.windows().every((window) => Number.isFinite(window.from) && Number.isFinite(window.to)), "poll did not retain bounded query windows");
  return { attempts: telemetry.ingestion.attempts.length, observedIngestionLagMs: telemetry.observedIngestionLagMs };
}

async function reportsBoundedShortfall() {
  const dependencies = clockedDependencies([
    [{ requestId: ledger[0].requestId, spans: [] }],
  ]);
  const telemetry = await telemetryForLedger({
    accountId: "guard-account",
    observabilityToken: "guard-observability-token",
    template: {},
    ledger,
    ingestionTimeoutMs: 20,
    ingestionPollIntervalMs: 10,
    ...dependencies,
  });
  assert(telemetry.status === "shortfall", "bounded missing ray was not retained as a shortfall");
  assert(telemetry.ingestion.status === "shortfall", "bounded poll did not name its shortfall");
  assert(telemetry.ingestion.missingRequestIds.length === 1, "shortfall did not retain the missing cohort ray");
  assert(telemetry.observedTraceCount === 1 && telemetry.descriptiveLossCount === 1, "shortfall became an empty or fabricated tally");
  assert(dependencies.calls() === 3, "shortfall did not stop at the exact bounded deadline");
  return { attempts: telemetry.ingestion.attempts.length, missingRequestCount: telemetry.ingestion.missingRequestIds.length };
}

process.stdout.write(`${JSON.stringify({
  settled: await settlesWhenEveryRayArrives(),
  shortfall: await reportsBoundedShortfall(),
  result: "g51-bounded-ingestion-poll-guards-passed",
}, null, 2)}\n`);
