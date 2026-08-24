#!/usr/bin/env node
/**
 * Materializes the raw Workers Observability events query from the B ledger.
 * It deliberately has no operator-authored request IDs or observation claims:
 * the resulting time window is derived solely from the client-captured B
 * canonical, warmup, and idle request timelines.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_TEMPLATE = "scripts/deploy/g30-observability-query.json";
const BEFORE_MS = 2 * 60_000;
const AFTER_MS = 10 * 60_000;

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`G30 telemetry query ${label} must be finite`);
  return value;
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`G30 telemetry query ${label} must be an object`);
  return value;
}

export function observationRequestTimeline(phaseB) {
  const canonical = phaseB?.ledger;
  const warmup = phaseB?.warmup?.requests;
  const idle = phaseB?.idleExperiment?.requests;
  if (!Array.isArray(canonical) || !Array.isArray(warmup) || !Array.isArray(idle)) {
    throw new Error("G30 telemetry query needs canonical, warmup, and idle B ledgers");
  }
  const requests = [...canonical, ...warmup, ...idle];
  if (requests.length < 108) throw new Error("G30 telemetry query needs all B canonical/warmup/idle requests");
  return requests.map((record, index) => Object.freeze({
    startedAtMs: finite(record?.startedAtMs, `request[${index}].startedAtMs`),
    completedAtMs: finite(record?.completedAtMs, `request[${index}].completedAtMs`),
  }));
}

/** Builds a bounded, events-view request without changing any saved query. */
export function buildG30ObservabilityQuery(phaseB, template) {
  const source = structuredClone(object(template, "template"));
  if (source.view !== "events" || source.dry !== true || !Number.isSafeInteger(source.limit) || source.limit < 1 || source.limit > 2000) {
    throw new Error("G30 telemetry query template must be a bounded dry events query");
  }
  const parameters = object(source.parameters, "template.parameters");
  if (parameters.filterCombination !== "or" || !Array.isArray(parameters.filters) || parameters.filters.length !== 2) {
    throw new Error("G30 telemetry query template must retain both primary and receiver filters");
  }
  const requests = observationRequestTimeline(phaseB);
  const earliest = Math.min(...requests.map((record) => record.startedAtMs));
  const latest = Math.max(...requests.map((record) => record.completedAtMs));
  return Object.freeze({
    ...source,
    timeframe: Object.freeze({ from: Math.max(0, earliest - BEFORE_MS), to: latest + AFTER_MS }),
  });
}

export function selfTest() {
  const template = JSON.parse(readFileSync(DEFAULT_TEMPLATE, "utf8"));
  const phaseB = {
    ledger: Array.from({ length: 100 }, (_, index) => ({ startedAtMs: 1_000 + index, completedAtMs: 1_100 + index })),
    warmup: { requests: Array.from({ length: 5 }, (_, index) => ({ startedAtMs: 900 + index, completedAtMs: 950 + index })) },
    idleExperiment: { requests: Array.from({ length: 3 }, (_, index) => ({ startedAtMs: 2_000 + index, completedAtMs: 2_050 + index })) },
  };
  const query = buildG30ObservabilityQuery(phaseB, template);
  if (query.timeframe.from !== 0 || query.timeframe.to !== 602_052) throw new Error("G30 telemetry query bounds self-test failed");
  let filterRed = false;
  try { const altered = structuredClone(template); altered.parameters.filters.pop(); buildG30ObservabilityQuery(phaseB, altered); } catch (error) { filterRed = String(error).includes("primary and receiver"); }
  if (!filterRed) throw new Error("G30 telemetry query filter mutation unexpectedly passed");
  return Object.freeze({ requests: 108, from: query.timeframe.from, to: query.timeframe.to, mutations: ["receiver-filter"] });
}

function main() {
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify(selfTest(), null, 2));
    return;
  }
  const ledger = JSON.parse(readFileSync(required("--ledger", argument("--ledger")), "utf8"));
  const template = JSON.parse(readFileSync(argument("--template", DEFAULT_TEMPLATE), "utf8"));
  const output = argument("--output", ".artifacts/g30-observability-query.json");
  const query = buildG30ObservabilityQuery(ledger, template);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(query, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ view: query.view, limit: query.limit, timeframe: query.timeframe }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
