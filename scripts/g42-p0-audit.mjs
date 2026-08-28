#!/usr/bin/env node
/**
 * Read-only SDT-G42 P0 audit over the already captured G37 A-5 cohort.
 * It deliberately never creates traffic to fill a missing provider-retained
 * observation.  A handler fact without an exact row marker remains UNKNOWN;
 * timestamp-nearness is not a join rule.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SCHEMA = "sdt.g42.p0-audit/v1";
const REQUIRED_ROWS = ["S04", "S05a", "S05b", "S05c", "S05d"];

function fail(message) {
  throw new Error(`g42-p0:${message}`);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(`${label} must be a non-negative finite number`);
  return value;
}

function hashIdentity(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function nearestRank(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * fraction) - 1];
}

function distribution(values) {
  if (values.length === 0) return null;
  const histogram = new Map();
  const buckets = [0, 1, 25, 50, 100, 200, 400, 800, 1_600, 3_200];
  for (const value of values) {
    const lower = [...buckets].reverse().find((candidate) => value >= candidate) ?? 0;
    const upper = buckets.find((candidate) => candidate > lower);
    const label = upper === undefined ? `${lower}+` : lower === 0 ? "0" : `${lower}-${upper - 1}`;
    histogram.set(label, (histogram.get(label) ?? 0) + 1);
  }
  return Object.freeze({
    count: values.length,
    min: Math.min(...values),
    p50: nearestRank(values, 0.5),
    p95: nearestRank(values, 0.95),
    max: Math.max(...values),
    histogram: Object.freeze(Object.fromEntries([...histogram.entries()])),
  });
}

function sourceHeader(source) {
  const value = object(source, "source");
  const query = object(value.query, "source.query");
  const provider = object(value.provider, "source.provider");
  const response = object(query.response, "source.query.response");
  return Object.freeze({ value, query, provider, response });
}

function handlerFact(value, label) {
  const fact = object(value, label);
  if (fact.event !== "do.handler" || fact.actorClass !== "JOURNAL") return undefined;
  const activationId = string(fact.activationId, `${label}.activationId`);
  const activationFirst = typeof fact.activationFirst === "boolean" ? fact.activationFirst : fail(`${label}.activationFirst must be boolean`);
  const constructorToHandlerMs = finite(fact.constructorToHandlerMs, `${label}.constructorToHandlerMs`);
  const firstStorageReadMs = fact.firstStorageReadMs === null ? null : finite(fact.firstStorageReadMs, `${label}.firstStorageReadMs`);
  return Object.freeze({
    activationId,
    activationFirst,
    constructorToHandlerMs,
    firstStorageReadMs,
    ...(typeof fact.rowId === "string" ? { rowId: fact.rowId } : {}),
  });
}

function normalizeSource(source) {
  const { value, query, provider, response } = sourceHeader(source);
  const availability = string(response.availability, "source.query.response.availability");
  if (availability === "SOURCE_UNAVAILABLE") {
    return Object.freeze({ value, query, provider, response, available: false });
  }
  if (availability !== "AVAILABLE") fail("source.query.response.availability must be AVAILABLE or SOURCE_UNAVAILABLE");
  const cohort = object(value.cohort, "source.cohort");
  const telemetry = object(value.telemetry, "source.telemetry");
  return Object.freeze({
    value,
    query,
    provider,
    response,
    available: true,
    ledger: array(cohort.ledger, "source.cohort.ledger"),
    traces: array(telemetry.traces, "source.telemetry.traces"),
    observations: array(telemetry.observations, "source.telemetry.observations"),
  });
}

/**
 * Produces a typed audit. It calls no provider API; callers provide a retained
 * raw export or a SOURCE_UNAVAILABLE response record from their query step.
 */
export function auditG42P0(source) {
  const normalized = normalizeSource(source);
  const queryRecord = Object.freeze({
    request: normalized.query.request,
    response: normalized.response,
    providerRetention: normalized.provider.retention,
    providerConfig: normalized.provider.config,
  });
  if (!normalized.available) {
    // A query may be unavailable while the historical G37 ledger itself is
    // still present locally. Preserve that known identity universe as UNKNOWN
    // instead of silently turning it into a zero-row cohort.
    const unavailableCohort = normalized.value.cohort === undefined
      ? []
      : array(object(normalized.value.cohort, "source.cohort").ledger ?? [], "source.cohort.ledger");
    const unknowns = unavailableCohort.map((rawLedger, ordinal) => {
      const ledger = object(rawLedger, `source.cohort.ledger[${ordinal}]`);
      const requestId = string(ledger.requestId, `source.cohort.ledger[${ordinal}].requestId`);
      return Object.freeze({ ordinal: ordinal + 1, identityHash: hashIdentity(requestId), stage: "source-unavailable" });
    });
    return Object.freeze({
      schema: SCHEMA,
      outcome: "SOURCE_UNAVAILABLE",
      cohort: { expectedIdentityCount: unavailableCohort.length, joinedIdentityCount: 0, exactJoinedIdentityCount: 0, unknownIdentityCount: unknowns.length },
      query: queryRecord,
      unknowns: Object.freeze(unknowns),
      distributions: null,
      semanticLimits: semanticLimits(),
      note: "No new traffic was generated; the provider source was unavailable before a G37 correlation join could begin.",
    });
  }
  const tracesByRequest = new Map();
  for (const [index, rawTrace] of normalized.traces.entries()) {
    const trace = object(rawTrace, `source.telemetry.traces[${index}]`);
    const requestId = string(trace.requestId, `source.telemetry.traces[${index}].requestId`);
    if (tracesByRequest.has(requestId)) fail(`telemetry repeats trace request identity ${requestId}`);
    tracesByRequest.set(requestId, trace);
  }
  const handlersByRequest = new Map();
  for (const [index, rawObservation] of normalized.observations.entries()) {
    const observation = object(rawObservation, `source.telemetry.observations[${index}]`);
    const requestId = observation.requestId;
    if (typeof requestId !== "string" || requestId.length === 0) continue;
    const handler = handlerFact(observation, `source.telemetry.observations[${index}]`);
    if (handler === undefined) continue;
    const entries = handlersByRequest.get(requestId) ?? [];
    entries.push(handler);
    handlersByRequest.set(requestId, entries);
  }
  const unknowns = [];
  const joined = [];
  const constructorValues = [];
  const firstStorageValues = [];
  const exactS04ActivationFirst = [];
  const exactS04SharesS05Activation = [];
  for (const [ordinal, rawLedger] of normalized.ledger.entries()) {
    const ledger = object(rawLedger, `source.cohort.ledger[${ordinal}]`);
    const requestId = string(ledger.requestId, `source.cohort.ledger[${ordinal}].requestId`);
    const trace = tracesByRequest.get(requestId);
    const handlers = handlersByRequest.get(requestId) ?? [];
    const identity = Object.freeze({ ordinal: ordinal + 1, identityHash: hashIdentity(requestId) });
    if (trace === undefined) {
      unknowns.push(Object.freeze({ ...identity, stage: "root-absent" }));
      continue;
    }
    const rowIds = new Set(array(trace.spans, `trace.${identity.identityHash}.spans`)
      .map((span, spanIndex) => object(span, `trace.${identity.identityHash}.spans[${spanIndex}]`).rowId)
      .filter((rowId) => typeof rowId === "string"));
    const missingRows = REQUIRED_ROWS.filter((rowId) => !rowIds.has(rowId));
    if (missingRows.length > 0) {
      unknowns.push(Object.freeze({ ...identity, stage: "trace-incomplete", missingRows: Object.freeze(missingRows) }));
      continue;
    }
    if (handlers.length === 0) {
      unknowns.push(Object.freeze({ ...identity, stage: "journal-handler-absent" }));
      continue;
    }
    const activationIds = new Set(handlers.map((handler) => handler.activationId));
    const exactByRow = REQUIRED_ROWS.every((rowId) => handlers.filter((handler) => handler.rowId === rowId).length === 1);
    const exactS04 = handlers.find((handler) => handler.rowId === "S04");
    const direct = exactByRow && exactS04 !== undefined;
    // Facts are preserved even when their per-row mapping is unavailable. The
    // output never promotes this correlation-group-only evidence to COMPLETE.
    for (const handler of handlers) {
      constructorValues.push(handler.constructorToHandlerMs);
      if (handler.firstStorageReadMs !== null) firstStorageValues.push(handler.firstStorageReadMs);
    }
    joined.push(Object.freeze({
      ...identity,
      mapping: direct ? "exact-row" : "correlation-group-only",
      journalHandlerFactCount: handlers.length,
      activationIdCount: activationIds.size,
      ...(direct ? {
        s04ActivationFirst: exactS04.activationFirst,
        s04ActivationIdMatchesS05: REQUIRED_ROWS.slice(1).every((rowId) => handlers.find((handler) => handler.rowId === rowId)?.activationId === exactS04.activationId),
      } : {
        s04ActivationFirst: "UNKNOWN",
        s04ActivationIdMatchesS05: "UNKNOWN",
        correlationGroupActivationFirstCount: handlers.filter((handler) => handler.activationFirst).length,
        correlationGroupActivationFalseCount: handlers.filter((handler) => !handler.activationFirst).length,
      }),
    }));
    if (direct) {
      exactS04ActivationFirst.push(exactS04.activationFirst);
      exactS04SharesS05Activation.push(REQUIRED_ROWS.slice(1).every((rowId) => handlers.find((handler) => handler.rowId === rowId)?.activationId === exactS04.activationId));
    }
  }
  const exactJoined = joined.filter((entry) => entry.mapping === "exact-row");
  const countBy = (values) => Object.freeze(Object.fromEntries([...new Set(values)].sort((left, right) => Number(left) - Number(right)).map((value) => [value, values.filter((entry) => entry === value).length])));
  const outcome = unknowns.length === 0 && exactJoined.length === normalized.ledger.length ? "COMPLETE" : "PARTIAL";
  return Object.freeze({
    schema: SCHEMA,
    outcome,
    cohort: Object.freeze({
      expectedIdentityCount: normalized.ledger.length,
      joinedIdentityCount: joined.length,
      exactJoinedIdentityCount: exactJoined.length,
      unknownIdentityCount: unknowns.length,
    }),
    query: queryRecord,
    joined: Object.freeze(joined),
    unknowns: Object.freeze(unknowns),
    correlationGroupSummary: Object.freeze({
      activationIdCountHistogram: countBy(joined.map((entry) => entry.activationIdCount)),
      handlerFactCountHistogram: countBy(joined.map((entry) => entry.journalHandlerFactCount)),
      interpretation: "A correlation group with one activationId shows that its retained JOURNAL facts agree at group scope; without rowId it does not identify which fact belongs to S04 or an individual S05 row.",
    }),
    distributions: Object.freeze({
      journalHandlerConstructorToHandlerMs: distribution(constructorValues),
      journalHandlerFirstStorageReadMs: distribution(firstStorageValues),
      scope: "All correlation-joined JOURNAL do.handler facts; exact per-row S04 distributions are reported only when rowId is present in the retained source.",
    }),
    exactS04Conclusions: Object.freeze({
      mappedIdentityCount: exactJoined.length,
      activationFirstTrueCount: exactS04ActivationFirst.filter(Boolean).length,
      activationFirstFalseCount: exactS04ActivationFirst.filter((value) => !value).length,
      activationFirstUnknownCount: joined.length - exactS04ActivationFirst.length + unknowns.length,
      sharesActivationIdWithAllS05TrueCount: exactS04SharesS05Activation.filter(Boolean).length,
      sharesActivationIdWithAllS05FalseCount: exactS04SharesS05Activation.filter((value) => !value).length,
      sharesActivationIdUnknownCount: joined.length - exactS04SharesS05Activation.length + unknowns.length,
      statement: exactJoined.length === normalized.ledger.length
        ? "Exact row mapping covers the cohort."
        : "Existing do.handler facts retain correlation but no S04/S05 row identity for one or more joins; S04-specific claims remain UNKNOWN rather than inferred from observation order.",
    }),
    semanticLimits: semanticLimits(),
    noNewTraffic: true,
  });
}

function semanticLimits() {
  return Object.freeze({
    constructorToHandlerMs: "Begins only after the platform has instantiated the JavaScript class. It excludes routing, placement, and pre-construction startup; it is not a platform cold-start timer.",
    firstStorageReadMs: "Captured immediately before the first durable read or transaction begins. It is handler-entry-to-storage-touch, not storage-read latency.",
  });
}

export function selfTest() {
  const source = {
    query: { request: { mode: "fixture" }, response: { availability: "AVAILABLE", status: 200 } },
    provider: { retention: { documentedDays: 3 }, config: { view: "events" } },
    cohort: { ledger: [{ requestId: "fixture-request" }] },
    telemetry: {
      traces: [{ requestId: "fixture-request", spans: REQUIRED_ROWS.map((rowId) => ({ rowId })) }],
      observations: REQUIRED_ROWS.map((rowId, index) => ({
        requestId: "fixture-request",
        event: "do.handler",
        actorClass: "JOURNAL",
        rowId,
        activationId: "fixture-activation",
        activationFirst: rowId === "S04",
        constructorToHandlerMs: index + 1,
        firstStorageReadMs: index + 2,
      })),
    },
  };
  const complete = auditG42P0(source);
  if (complete.outcome !== "COMPLETE" || complete.cohort.exactJoinedIdentityCount !== 1) fail("complete fixture did not join exactly");
  const partialSource = structuredClone(source);
  delete partialSource.telemetry.observations[0].rowId;
  const partial = auditG42P0(partialSource);
  if (partial.outcome !== "PARTIAL") fail("rowless handler fixture did not remain PARTIAL");
  const unavailable = auditG42P0({
    query: { request: { mode: "fixture" }, response: { availability: "SOURCE_UNAVAILABLE", status: 404 } },
    provider: { retention: { documentedDays: 3 }, config: { view: "events" } },
    cohort: { ledger: [{ requestId: "unavailable-fixture-request" }] },
  });
  if (unavailable.outcome !== "SOURCE_UNAVAILABLE" || unavailable.cohort.unknownIdentityCount !== 1) {
    fail("source-unavailable fixture did not retain the known identity as UNKNOWN");
  }
  return Object.freeze({ outcomes: [complete.outcome, partial.outcome, unavailable.outcome], expectedRows: REQUIRED_ROWS });
}

function main() {
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify(selfTest(), null, 2));
    return;
  }
  const input = process.argv.indexOf("--input");
  const output = process.argv.indexOf("--output");
  if (input < 0 || output < 0) fail("--input and --output are required");
  const result = auditG42P0(JSON.parse(readFileSync(process.argv[input + 1], "utf8")));
  mkdirSync(dirname(process.argv[output + 1]), { recursive: true });
  writeFileSync(process.argv[output + 1], `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outcome: result.outcome, cohort: result.cohort }, null, 2));
}

if (import.meta.url === `file://${resolve(process.argv[1] ?? "")}`) main();
