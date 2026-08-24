#!/usr/bin/env node
/**
 * Fetches or normalizes Cloudflare Workers telemetry into the compact,
 * manifest-shaped G30 trace artifact. The raw API response is retained as a
 * separate local artifact; this script never invents a missing span or joins
 * by arrival order.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import manifest from "../../contracts/commit-trace-manifest.json" with { type: "json" };
import { assertObservationStream, assertTraceCohort, observationLedgerForPhase } from "../g30-b0-contract.mjs";
import {
  SUCCESS_REQUIRED,
  verifyExportedSuccessTrace as verifyRuntimeSuccessTrace,
} from "../g30-trace-runtime-verifier.mjs";

export { verifyExportedSuccessTrace } from "../g30-trace-runtime-verifier.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function fail(code, message) {
  throw new Error(`g30-trace-export:${code}:${message}`);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function scalar(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

function attributesFor(event) {
  const direct = object(event?.attributes) ?? object(event?.source?.attributes) ?? object(event?.source?.spanAttributes) ?? object(event?.event?.attributes) ?? {};
  const extra = object(event?.source) ?? {};
  // Telemetry exports use both nested attributes and flattened field names.
  return { ...extra, ...direct };
}

function metadataFor(event) {
  // Cloudflare returns root identity primarily under $metadata, while some
  // invocation/log shapes carry it under $workers. Merge both without
  // allowing a later human sidecar to manufacture a join.
  return {
    ...(object(event?.$workers) ?? {}),
    ...(object(event?.workers) ?? {}),
    ...(object(event?.metadata) ?? {}),
    ...(object(event?.$metadata) ?? {}),
  };
}

function parseObject(value) {
  if (object(value) !== undefined) return object(value);
  if (typeof value !== "string") return undefined;
  try { return object(JSON.parse(value)); } catch { return undefined; }
}

/**
 * Workers Logs stores structured console objects in provider-owned event
 * fields.  Accept the documented source/message variants, but never a human
 * sidecar declaration: no matching raw telemetry object means no observation.
 */
function observationPayload(event) {
  const candidates = [
    event?.source,
    event?.$metadata?.message,
    event?.metadata?.message,
    event?.message,
    event?.event?.source,
    event?.event?.message,
    event?.attributes?.message,
  ];
  for (const candidate of candidates) {
    const parsed = parseObject(candidate);
    if (parsed?.schema === "sdt.observe/v1") return parsed;
  }
  return undefined;
}

function nested(objectValue, path) {
  let current = objectValue;
  for (const part of path) {
    if (current === undefined) return undefined;
    current = object(current)?.[part];
  }
  return current;
}

function providerFact(event, paths) {
  const metadata = metadataFor(event);
  const scopes = [
    metadata,
    object(event?.$workers),
    object(event?.workers),
    object(metadata?.$workers),
    object(metadata?.workers),
    event,
  ];
  for (const scope of scopes) {
    for (const path of paths) {
      const value = nested(scope, path);
      if (scalar(value) !== undefined) return value;
    }
  }
  return undefined;
}

function providerFacts(event) {
  const scriptVersion = providerFact(event, [["scriptVersion", "id"], ["script_version", "id"], ["scriptVersion"], ["script_version"]]);
  const colo = providerFact(event, [["colo"], ["coloCode"]]);
  const cpuTimeMs = providerFact(event, [["cpuTimeMs"], ["cpu_time_ms"]]);
  const wallTimeMs = providerFact(event, [["wallTimeMs"], ["wall_time_ms"]]);
  return Object.freeze({
    ...(typeof scriptVersion === "string" && scriptVersion.length > 0 ? { scriptVersion } : {}),
    ...(typeof colo === "string" && colo.length > 0 ? { colo } : {}),
    ...(typeof cpuTimeMs === "number" ? { cpuTimeMs } : {}),
    ...(typeof wallTimeMs === "number" ? { wallTimeMs } : {}),
  });
}

function numberFrom(value, label) {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(result)) fail("time", `${label} is not numeric`);
  return result;
}

function metadataField(metadata, event, names) {
  for (const name of names) {
    const direct = metadata[name] ?? event?.[name];
    if (direct !== undefined && direct !== null) return direct;
  }
  return undefined;
}

const ROWS = manifest.schemas["sdt.commit/v1"].rows;
const ROW_BY_ID = new Map(ROWS.map((row) => [row.rowId, row]));
const ATTRIBUTE_MATRIX = manifest.attributeMatrix.attributes;
const ATTRIBUTE_IDS = new Set(Object.keys(ATTRIBUTE_MATRIX));
const RAW_TAG_KEY = /(^|[._])tag($|[._])/i;
const ROWS_BY_OPERATION = new Map();
for (const row of ROWS) {
  const entries = ROWS_BY_OPERATION.get(row.span) ?? [];
  entries.push(row); ROWS_BY_OPERATION.set(row.span, entries);
}

function rowIdFor(attributes) {
  const explicit = attributes["sdt.row.id"] ?? attributes.rowId;
  if (typeof explicit === "string" && ROW_BY_ID.has(explicit)) return explicit;
  const operation = attributes.operation;
  if (typeof operation !== "string") return undefined;
  const candidates = ROWS_BY_OPERATION.get(operation) ?? [];
  if (candidates.length === 1) return candidates[0].rowId;
  if (operation === "journal.transition") {
    const ordinal = attributes["phase.ordinal"];
    return ["S05a", "S05b", "S05c", "S05d", "S05e"][Number(ordinal)];
  }
  return undefined;
}

function normalizableAttributes(raw) {
  for (const [key, value] of Object.entries(raw)) {
    if (key !== "tag.key_hash" && RAW_TAG_KEY.test(key) && scalar(value) !== undefined) {
      fail("raw-tag", `telemetry emitted raw tag-like attribute ${key}`);
    }
  }
  return Object.fromEntries(Object.entries(raw).filter(([key, value]) => ATTRIBUTE_IDS.has(key) && scalar(value) !== undefined));
}

function normalizedSpan(event, traceId) {
  const attributes = attributesFor(event);
  if (attributes["schema.version"] !== "sdt.commit/v1") return undefined;
  const rowId = rowIdFor(attributes);
  if (rowId === undefined) fail("row", `cannot map operation ${String(attributes.operation)} to an authority row`);
  const row = ROW_BY_ID.get(rowId);
  const metadata = metadataFor(event);
  const startRaw = metadataField(metadata, event, ["startTime", "startMs", "timestamp"]);
  const endRaw = metadataField(metadata, event, ["endTime", "endMs"]);
  const durationRaw = metadataField(metadata, event, ["duration", "durationMs"]);
  const startMs = numberFrom(startRaw, `${rowId}.start`);
  const endMs = endRaw === undefined ? startMs + numberFrom(durationRaw, `${rowId}.duration`) : numberFrom(endRaw, `${rowId}.end`);
  if (endMs < startMs) fail("time", `${rowId} ends before it begins`);
  return {
    rowId,
    schema: "sdt.commit/v1",
    face: typeof attributes["attempt.id"] === "string" ? "accepted" : "pre-admission",
    span: row.span,
    startMs,
    endMs,
    emitter: row.emitter,
    kind: row.kind,
    logicalParent: row.logicalParent,
    rootId: traceId,
    clockDomain: row.logicalParent === "provider-subrequest" ? "callee" : "caller",
    present: true,
    zeroDurationPlatformLimited: startMs === endMs,
    attributes: normalizableAttributes(attributes),
  };
}

function rawEvents(raw) {
  const candidates = [
    raw?.result?.events?.events,
    raw?.events?.events,
    raw?.events,
    raw?.result?.data,
    raw?.data,
  ];
  const events = candidates.find(Array.isArray);
  if (!Array.isArray(events)) fail("input", "telemetry export contains no event array");
  return events;
}

/**
 * Preserve only the provider span name needed to prove that a credential
 * refresh was (or was not) on the same exported request trace.  Raw provider
 * attributes remain in the local source artifact and are never copied into
 * the candidate evidence document.
 */
function providerSpanName(event) {
  const attributes = attributesFor(event);
  const metadata = metadataFor(event);
  const candidates = [
    attributes["span.name"],
    attributes.spanName,
    attributes.operation,
    metadata.name,
    metadata.operationName,
    event?.name,
    event?.operationName,
  ];
  return candidates.find((value) => typeof value === "string" && value.length > 0);
}

function hasSpanTiming(event) {
  const metadata = metadataFor(event);
  const start = metadataField(metadata, event, ["startTime", "startMs", "timestamp"]);
  const end = metadataField(metadata, event, ["endTime", "endMs"]);
  const duration = metadataField(metadata, event, ["duration", "durationMs"]);
  return start !== undefined && (end !== undefined || duration !== undefined);
}

function traceGroup(groups, traceId) {
  const existing = groups.get(traceId);
  if (existing !== undefined) return existing;
  const next = { traceId, events: [], observations: [], providerSpanNames: new Set() };
  groups.set(traceId, next);
  return next;
}

function normalizeObservation(payload, event, requestId, traceId) {
  if (payload.schema !== "sdt.observe/v1") fail("observation-schema", "structured observation has an unsupported schema");
  if (![
    "worker.invocation",
    "do.handler",
    "fault.barrier",
  ].includes(payload.event)) {
    fail("observation-event", `structured observation has an unsupported event ${String(payload.event)}`);
  }
  if (typeof payload.emittedAtMs !== "number" || !Number.isFinite(payload.emittedAtMs)) {
    fail("observation-time", "structured observation lacks a finite emittedAtMs");
  }
  if (payload.storageWrites !== 0 || payload.usedForControl !== false || payload.exposedInPublicResponse !== false) {
    fail("observation-isolation", "structured observation is not observation-only");
  }
  if (payload.requestId !== undefined && payload.requestId !== requestId) {
    fail("observation-request-id", "structured observation conflicts with its platform request id");
  }
  return Object.freeze({
    ...payload,
    requestId,
    traceId,
    provider: providerFacts(event),
  });
}

/**
 * Groups custom spans by Cloudflare trace ID and anchors the group to the
 * S00 request's ray/request identifier. No chronological "nearest span"
 * fallback is allowed, so a propagation break remains visible as trace loss.
 */
export function normalizeTelemetryBundle(raw, exportedAtMs = Date.now()) {
  const groups = new Map();
  for (const event of rawEvents(raw)) {
    const metadata = metadataFor(event);
    const traceId = metadataField(metadata, event, ["traceId", "trace_id"]);
    const attributes = attributesFor(event);
    const isCommitSchemaSpan = attributes["schema.version"] === "sdt.commit/v1";
    const observation = observationPayload(event);
    if (typeof traceId !== "string" || traceId.length === 0) {
      if (isCommitSchemaSpan) fail("trace-id", "custom sdt.commit/v1 span has no trace id");
      if (observation !== undefined) fail("observation-trace-id", "structured observation has no platform trace id");
      continue;
    }
    const group = traceGroup(groups, traceId);
    // A telemetry log may share a trace ID but is not evidence of a refresh
    // span. Retain names only from timestamped span records.
    const name = hasSpanTiming(event) ? providerSpanName(event) : undefined;
    if (name !== undefined) group.providerSpanNames.add(name);
    const span = normalizedSpan(event, traceId);
    if (span !== undefined) group.events.push({ span, metadata });
    if (observation !== undefined) group.observations.push({ payload: observation, event });
  }
  const output = [];
  const observations = [];
  for (const group of groups.values()) {
    const root = group.events.find((entry) => entry.span.rowId === "S00");
    if (root === undefined) {
      if (group.observations.length > 0) fail("observation-root", `structured observation trace ${group.traceId} has no S00 root`);
      continue;
    }
    const requestId = metadataField(root.metadata, root, ["rayId", "requestId"]);
    if (typeof requestId !== "string" || requestId.length === 0) fail("request-id", `S00 trace ${group.traceId} has no ray/request id`);
    const spans = group.events.map((entry) => entry.span);
    const rowCounts = new Map(spans.map((span) => [span.rowId, 0]));
    for (const span of spans) rowCounts.set(span.rowId, (rowCounts.get(span.rowId) ?? 0) + 1);
    const complete = SUCCESS_REQUIRED.every((rowId) => (rowCounts.get(rowId) ?? 0) > 0);
    const trace = {
      requestId,
      traceId: group.traceId,
      schema: "sdt.commit/v1",
      boundary: "success",
      complete,
      exportedAtMs,
      callerCoverageIntervals: manifest.schemas["sdt.commit/v1"].callerCoverageIntervals,
      providerSpanNames: [...group.providerSpanNames].sort(),
      spans,
    };
    if (complete) verifyRuntimeSuccessTrace(trace);
    output.push({
      ...trace,
      runtimeVerified: complete,
    });
    for (const observed of group.observations) {
      observations.push(normalizeObservation(observed.payload, observed.event, requestId, group.traceId));
    }
  }
  return Object.freeze({
    traces: output.sort((left, right) => left.requestId.localeCompare(right.requestId)),
    observations: observations.sort((left, right) =>
      left.requestId.localeCompare(right.requestId) || left.emittedAtMs - right.emittedAtMs,
    ),
  });
}

export function normalizeTelemetryExport(raw, exportedAtMs = Date.now()) {
  return normalizeTelemetryBundle(raw, exportedAtMs).traces;
}

export async function queryTelemetry({ accountId, token, payload }) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/observability/telemetry/query`;
  const limit = typeof payload?.limit === "number" && Number.isSafeInteger(payload.limit) ? payload.limit : 2_000;
  const allEvents = [];
  const cursorIds = new Set();
  let query = structuredClone(payload);
  let first;
  for (let page = 0; page < 50; page += 1) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(query),
    });
    const raw = await response.json();
    if (!response.ok || raw?.success === false || (Array.isArray(raw?.errors) && raw.errors.length > 0)) {
      fail("api", `Cloudflare telemetry query failed: HTTP ${response.status}`);
    }
    if (first === undefined) first = raw;
    const events = rawEvents(raw);
    allEvents.push(...events);
    const reportedCount = raw?.result?.events?.count;
    if (typeof reportedCount === "number" && allEvents.length >= reportedCount) break;
    if (events.length < limit) break;
    const cursor = metadataFor(events.at(-1))?.id;
    if (typeof cursor !== "string" || cursor.length === 0 || cursorIds.has(cursor)) {
      fail("pagination", "telemetry query needs a unique $metadata.id cursor for the next event page");
    }
    cursorIds.add(cursor);
    query = { ...query, offset: cursor, offsetDirection: "next" };
  }
  if (first === undefined) fail("api", "Cloudflare telemetry query returned no page");
  const merged = structuredClone(first);
  if (Array.isArray(merged?.result?.events?.events)) merged.result.events.events = allEvents;
  else if (Array.isArray(merged?.events?.events)) merged.events.events = allEvents;
  else if (Array.isArray(merged?.events)) merged.events = allEvents;
  else if (Array.isArray(merged?.result?.data)) merged.result.data = allEvents;
  else if (Array.isArray(merged?.data)) merged.data = allEvents;
  else fail("pagination", "telemetry query page did not preserve an events container");
  return merged;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function exportDeadline(ledger) {
  if (!Array.isArray(ledger) || ledger.length === 0) fail("ledger", "B trace export needs the canonical ledger");
  return Math.max(...ledger.map((record, index) => numberFrom(record?.completedAtMs, `ledger[${index}].completedAtMs`))) + 10 * 60 * 1_000;
}

function pendingTelemetryError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /g30-b0:(?:trace-count|trace-loss|observation-trace-loss|observation-worker|observation-trace-complete)|g30-trace-export:(?:observation-root|request-id)/.test(message);
}

async function main() {
  const ledgerPath = required("--ledger", argument("--ledger"));
  const output = argument("--output", ".artifacts/g30-b0-traces.json");
  let raw;
  const input = argument("--input");
  if (input !== undefined) {
    raw = JSON.parse(readFileSync(input, "utf8"));
  } else {
    const accountId = required("--account-id", argument("--account-id", process.env.CLOUDFLARE_ACCOUNT_ID));
    const token = readFileSync(required("--api-token-file", argument("--api-token-file", process.env.G30_OBSERVABILITY_TOKEN_FILE)), "utf8").trim();
    const queryPath = required("--query", argument("--query"));
    if (token.length === 0) fail("token", "observability token is empty");
    raw = await queryTelemetry({ accountId, token, payload: JSON.parse(readFileSync(queryPath, "utf8")) });
  }
  const ledgerDocument = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const observationLedger = observationLedgerForPhase(ledgerDocument);
  const deadline = exportDeadline(ledgerDocument.ledger);
  let bundle;
  let traces;
  let proof;
  for (;;) {
    try {
      bundle = normalizeTelemetryBundle(raw);
      const retainedRequestIds = new Set(ledgerDocument.ledger?.map((record) => record?.requestId));
      traces = bundle.traces.filter((trace) => retainedRequestIds.has(trace.requestId));
      proof = assertTraceCohort(ledgerDocument.ledger, traces, Date.now());
      assertObservationStream(observationLedger, bundle.traces, bundle.observations);
      break;
    } catch (error) {
      if (input !== undefined || Date.now() >= deadline || !pendingTelemetryError(error)) throw error;
      await sleep(15_000);
      const accountId = required("--account-id", argument("--account-id", process.env.CLOUDFLARE_ACCOUNT_ID));
      const token = readFileSync(required("--api-token-file", argument("--api-token-file", process.env.G30_OBSERVABILITY_TOKEN_FILE)), "utf8").trim();
      const queryPath = required("--query", argument("--query"));
      raw = await queryTelemetry({ accountId, token, payload: JSON.parse(readFileSync(queryPath, "utf8")) });
    }
  }
  const result = {
    task: "SDT-G30",
    phase: "B",
    exportedAt: new Date().toISOString(),
    exportCompletedAtMs: Date.now(),
    proof,
    traces,
    observationTraces: bundle.traces,
    observations: bundle.observations,
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ traceCount: traces.length, observationTraceCount: bundle.traces.length, observationCount: bundle.observations.length, requestCount: proof.requestCount, observationLedgerCount: observationLedger.length }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
