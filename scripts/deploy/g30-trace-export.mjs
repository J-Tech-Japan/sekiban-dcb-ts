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

function flattenAttributes(value, prefix = "", output = {}) {
  const record = object(value);
  if (record === undefined) return output;
  for (const [key, child] of Object.entries(record)) {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    if (scalar(child) !== undefined) output[path] = child;
    else if (object(child) !== undefined) flattenAttributes(child, path, output);
  }
  return output;
}

function attributesFor(event) {
  const flattened = {
    ...flattenAttributes(event?.source),
    ...flattenAttributes(event?.event?.source),
  };
  const direct = object(event?.attributes) ?? object(event?.source?.attributes) ?? object(event?.source?.spanAttributes) ?? object(event?.event?.attributes) ?? {};
  // Cloudflare exports custom-span fields under nested source objects while
  // fixtures and some provider versions use a flat attributes object.  The
  // source form is flattened structurally, never reconstructed by an
  // evidence-side parallel table.
  return { ...flattened, ...flattenAttributes(direct) };
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

function telemetryField(metadata, event, attributes, names) {
  const fromMetadata = metadataField(metadata, event, names);
  if (fromMetadata !== undefined) return fromMetadata;
  for (const name of names) {
    const value = attributes[name];
    if (value !== undefined && value !== null) return value;
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
  const startRaw = telemetryField(metadata, event, attributes, ["startTime", "startMs", "timestamp"]);
  const endRaw = telemetryField(metadata, event, attributes, ["endTime", "endMs"]);
  const durationRaw = telemetryField(metadata, event, attributes, ["duration", "durationMs", "durationMS"]);
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
  const attributes = attributesFor(event);
  const start = telemetryField(metadata, event, attributes, ["startTime", "startMs", "timestamp"]);
  const end = telemetryField(metadata, event, attributes, ["endTime", "endMs"]);
  const duration = telemetryField(metadata, event, attributes, ["duration", "durationMs", "durationMS"]);
  return start !== undefined && (end !== undefined || duration !== undefined);
}

function traceGroup(groups, traceId) {
  const existing = groups.get(traceId);
  if (existing !== undefined) return existing;
  const next = { traceId, events: [], providerSpanNames: new Set() };
  groups.set(traceId, next);
  return next;
}

function observationCorrelation(payload) {
  return typeof payload?.correlationId === "string" && payload.correlationId.length > 0
    ? payload.correlationId
    : undefined;
}

function normalizeObservation(payload, event, requestId, traceId, correlationId, workerPlatformRayId) {
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
  if (payload.event === "worker.invocation" && workerPlatformRayId !== undefined && payload.requestId !== workerPlatformRayId) {
    fail("observation-request-id", "structured observation conflicts with its platform request id");
  }
  if (observationCorrelation(payload) !== correlationId) {
    fail("observation-correlation", "structured observation conflicts with its joined trace correlation");
  }
  const platformRequestId = metadataField(metadataFor(event), event, ["requestId", "request_id"]);
  if (typeof platformRequestId !== "string" || platformRequestId.length === 0) {
    fail("observation-platform-request-id", "structured observation has no provider request id");
  }
  return Object.freeze({
    ...payload,
    requestId,
    traceId,
    platformRequestId,
    provider: providerFacts(event),
  });
}

/**
 * Cloudflare structured console logs expose platform request identity but do
 * not expose a trace id.  The runtime therefore retains the existing
 * post-admission correlation in sdt.observe/v1, and this exporter joins
 * observation -> S00 -> client CF-Ray by that correlation.  No time-nearest
 * fallback or manual trace-parent field is accepted.
 */
export function normalizeTelemetryBundle(raw, exportedAtMs = Date.now(), clientRequestIdsByRayId) {
  const groups = new Map();
  const rawObservations = [];
  for (const event of rawEvents(raw)) {
    const metadata = metadataFor(event);
    const traceId = metadataField(metadata, event, ["traceId", "trace_id"]);
    const attributes = attributesFor(event);
    const isCommitSchemaSpan = attributes["schema.version"] === "sdt.commit/v1";
    const observation = observationPayload(event);
    if (isCommitSchemaSpan && (typeof traceId !== "string" || traceId.length === 0)) {
      fail("trace-id", "custom sdt.commit/v1 span has no trace id");
    }
    if (typeof traceId === "string" && traceId.length > 0) {
      const group = traceGroup(groups, traceId);
      // A telemetry log may share a trace ID but is not evidence of a refresh
      // span. Retain names only from timestamped span records.
      const name = hasSpanTiming(event) ? providerSpanName(event) : undefined;
      if (name !== undefined) group.providerSpanNames.add(name);
      const span = normalizedSpan(event, traceId);
      if (span !== undefined) group.events.push({ span });
    }
    if (observation !== undefined) rawObservations.push({ payload: observation, event });
  }

  const rootsByCorrelation = new Map();
  for (const group of groups.values()) {
    const root = group.events.find((entry) => entry.span.rowId === "S00");
    if (root === undefined) continue;
    const correlationId = root.span.attributes["correlation.id"];
    if (typeof correlationId !== "string" || correlationId.length === 0) {
      fail("root-correlation", `S00 trace ${group.traceId} has no post-admission correlation`);
    }
    if (rootsByCorrelation.has(correlationId)) {
      fail("root-correlation", `post-admission correlation ${correlationId} maps to more than one S00 trace`);
    }
    rootsByCorrelation.set(correlationId, { group, root });
  }

  const observationsByCorrelation = new Map();
  for (const observed of rawObservations) {
    const correlationId = observationCorrelation(observed.payload);
    if (correlationId === undefined) {
      fail("observation-correlation", "structured observation has no existing trace correlation");
    }
    const existing = observationsByCorrelation.get(correlationId) ?? [];
    existing.push(observed);
    observationsByCorrelation.set(correlationId, existing);
  }

  const output = [];
  const observations = [];
  for (const [correlationId, joined] of observationsByCorrelation) {
    const rooted = rootsByCorrelation.get(correlationId);
    if (rooted === undefined) fail("observation-root", `structured observation correlation ${correlationId} has no S00 root`);
    const { group } = rooted;
    const worker = joined.filter((entry) => entry.payload.event === "worker.invocation");
    if (worker.length !== 1) fail("observation-worker", `S00 trace ${group.traceId} requires exactly one worker observation`);
    const observedWorkerRequestId = worker[0].payload.requestId;
    if (typeof observedWorkerRequestId !== "string" || observedWorkerRequestId.length === 0) {
      fail("observation-request-id", `S00 trace ${group.traceId} worker observation lacks the client CF-Ray`);
    }
    const platformRayId = clientRequestIdsByRayId === undefined
      ? undefined
      : cloudflareRayId(observedWorkerRequestId, `S00 trace ${group.traceId} worker observation`);
    const requestId = platformRayId === undefined
      ? observedWorkerRequestId
      : clientRequestIdsByRayId.get(platformRayId);
    if (typeof requestId !== "string" || requestId.length === 0) {
      fail("observation-ray-join", `S00 trace ${group.traceId} worker observation has no client CF-Ray ledger join`);
    }
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
    for (const observed of joined) {
      observations.push(normalizeObservation(observed.payload, observed.event, requestId, group.traceId, correlationId, platformRayId));
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
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const raw = await response.json();
  if (!response.ok || raw?.success === false || (Array.isArray(raw?.errors) && raw.errors.length > 0)) {
    fail("api", `Cloudflare telemetry query failed: HTTP ${response.status}`);
  }
  const events = rawEvents(raw);
  const reportedCount = raw?.result?.events?.count;
  // Cloudflare's events count can equal the limit even where the offset
  // cursor is not a complete pagination contract.  G30 therefore uses only
  // cohort-keyed, bounded queries and rejects saturation instead of silently
  // treating the first 2,000 records as a complete trace universe.
  if (events.length >= limit || (typeof reportedCount === "number" && reportedCount >= limit)) {
    fail("query-saturated", "telemetry query reached its bounded result limit");
  }
  return raw;
}

// Workers Observability rejects a request with more than sixteen filter
// nodes. The broadest G30 cohort query contains the two-worker scope group,
// two fixed observation filters, and an OR group of values: 6 + values.
// Keep the normal batch at the exact ten-value boundary and enforce the
// provider limit structurally before issuing any request.
export const CLOUDFLARE_TELEMETRY_MAX_FILTER_NODES = 16;
export const TELEMETRY_QUERY_VALUE_BATCH = 10;

/**
 * The client records the literal cf-ray header (ray plus colo suffix), while
 * Workers Logs indexes the same identity as the sixteen-hex-digit ray ID.
 * Preserve the client header in evidence and use this only for the exact
 * provider-side join; time proximity and a different provider request id are
 * never substitutes.
 */
export function cloudflareRayId(value, label = "cf-ray") {
  if (typeof value !== "string") fail("ray-id", `${label} must be a string`);
  const match = /^([0-9a-f]{16})(?:-[a-z0-9]+)?$/i.exec(value);
  if (match === null) fail("ray-id", `${label} is not a Cloudflare ray id`);
  return match[1].toLowerCase();
}

export function clientRequestIdByPlatformRayId(ledger) {
  if (!Array.isArray(ledger) || ledger.length === 0) fail("cohort-ray", "telemetry cohort needs one or more client ledger rows");
  const result = new Map();
  for (const [index, record] of ledger.entries()) {
    const requestId = typeof record?.requestId === "string" ? record.requestId : undefined;
    if (requestId === undefined || requestId.length === 0) fail("cohort-ray", `ledger[${index}] lacks a client cf-ray`);
    const platformRayId = cloudflareRayId(requestId, `ledger[${index}].requestId`);
    if (result.has(platformRayId)) fail("cohort-ray", `client ledger repeats platform ray ${platformRayId}`);
    result.set(platformRayId, requestId);
  }
  return result;
}

function filterNodeCount(filters) {
  if (!Array.isArray(filters)) return 0;
  return filters.reduce((count, filter) => {
    const nested = filter?.kind === "group" ? filterNodeCount(filter.filters) : 0;
    return count + 1 + nested;
  }, 0);
}

export function telemetryFilterNodeCount(filters) {
  return filterNodeCount(filters);
}

function nonEmptyTelemetryStrings(values, label) {
  if (!Array.isArray(values) || values.length === 0) fail("query-values", `${label} must contain one or more values`);
  const result = [...new Set(values)];
  if (result.some((value) => typeof value !== "string" || value.length === 0)) {
    fail("query-values", `${label} contains an empty value`);
  }
  return result;
}

function chunks(values, size = TELEMETRY_QUERY_VALUE_BATCH) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_unused, index) => values.slice(index * size, (index + 1) * size));
}

function queryFilter(key, value) {
  return { key, operation: "eq", type: "string", value };
}

/**
 * Adds an exact, cohort-owned filter without loosening the template's two
 * worker-name filters.  The outer worker scope stays OR; every G30-specific
 * constraint is ANDed with it.
 */
export function buildBoundedTelemetryQuery(template, filters) {
  const source = structuredClone(template);
  const base = source?.parameters;
  if (base?.filterCombination !== "or" || !Array.isArray(base.filters) || base.filters.length !== 2) {
    fail("query-template", "telemetry template must retain the primary/receiver OR scope");
  }
  if (!Array.isArray(filters) || filters.length === 0) fail("query-template", "bounded telemetry query needs cohort filters");
  const payload = {
    ...source,
    parameters: {
      filterCombination: "and",
      filters: [
        { kind: "group", filterCombination: "or", filters: base.filters },
        ...filters,
      ],
    },
  };
  const nodeCount = telemetryFilterNodeCount(payload.parameters.filters);
  if (nodeCount > CLOUDFLARE_TELEMETRY_MAX_FILTER_NODES) {
    fail("query-node-budget", `telemetry query has ${nodeCount} filter nodes; provider maximum is ${CLOUDFLARE_TELEMETRY_MAX_FILTER_NODES}`);
  }
  return payload;
}

function valuesFilter(key, values) {
  const filters = nonEmptyTelemetryStrings(values, key).map((value) => queryFilter(key, value));
  return filters.length === 1 ? filters[0] : { kind: "group", filterCombination: "or", filters };
}

function mergeTelemetryEvents(raws) {
  const seen = new Set();
  const events = [];
  for (const raw of raws) {
    for (const event of rawEvents(raw)) {
      const metadata = metadataFor(event);
      const key = typeof metadata.id === "string" && metadata.id.length > 0
        ? metadata.id
        : JSON.stringify(event);
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }
  }
  return { events };
}

function payloadsFrom(raws, eventName) {
  return raws.flatMap((raw) => rawEvents(raw)
    .map((event) => ({ payload: observationPayload(event), event }))
    .filter((entry) => entry.payload?.event === eventName));
}

async function queryByValues({ accountId, token, template, key, values, fixedFilters = [], batchSize = TELEMETRY_QUERY_VALUE_BATCH }) {
  const result = [];
  for (const batch of chunks(nonEmptyTelemetryStrings(values, key), batchSize)) {
    const payload = buildBoundedTelemetryQuery(template, [...fixedFilters, valuesFilter(key, batch)]);
    result.push(await queryTelemetry({ accountId, token, payload }));
  }
  return result;
}

/**
 * Query only the G30 B cohort.  A broad worker-time-range query can contain
 * more than 2,000 D1/provider rows and would make loss look like success.
 * The chain is exact: client CF-Ray -> worker observation correlation -> S00
 * trace -> all provider spans and correlated observations.
 */
export async function exportCohortTelemetry({ accountId, token, template, ledger }) {
  const clientRequestIdsByRayId = clientRequestIdByPlatformRayId(ledger);
  const requestIds = [...clientRequestIdsByRayId.values()];
  const platformRayIds = [...clientRequestIdsByRayId.keys()];
  const workerRaws = await queryByValues({
    accountId,
    token,
    template,
    key: "$metadata.rayId",
    values: platformRayIds,
  });
  const workerByRequestId = new Map();
  for (const { payload, event } of payloadsFrom(workerRaws, "worker.invocation")) {
    const providerRayValue = metadataField(metadataFor(event), event, ["rayId", "ray_id"]);
    const providerRayId = cloudflareRayId(providerRayValue, "worker observation provider ray");
    const requestId = clientRequestIdsByRayId.get(providerRayId);
    const correlationId = observationCorrelation(payload);
    if (typeof requestId !== "string" || correlationId === undefined) continue;
    if (cloudflareRayId(payload?.requestId, "worker observation payload ray") !== providerRayId) {
      fail("cohort-worker", "worker observation payload ray conflicts with its provider ray");
    }
    const existing = workerByRequestId.get(requestId) ?? new Set();
    existing.add(correlationId);
    workerByRequestId.set(requestId, existing);
  }
  for (const requestId of requestIds) {
    const correlations = workerByRequestId.get(requestId);
    if (correlations?.size !== 1) fail("cohort-worker", `client request ${requestId} lacks exactly one correlated worker observation`);
  }
  const correlations = [...new Set([...workerByRequestId.values()].flatMap((entries) => [...entries]))];
  const rootRaws = await queryByValues({
    accountId,
    token,
    template,
    key: "correlation.id",
    values: correlations,
    fixedFilters: [queryFilter("schema.version", "sdt.commit/v1"), queryFilter("$metadata.spanName", "sdt.commit")],
  });
  const traceIdsByCorrelation = new Map();
  for (const raw of rootRaws) {
    for (const event of rawEvents(raw)) {
      const attributes = attributesFor(event);
      const correlationId = attributes["correlation.id"];
      const traceId = metadataField(metadataFor(event), event, ["traceId", "trace_id"]);
      if (typeof correlationId === "string" && correlations.includes(correlationId) && typeof traceId === "string" && traceId.length > 0) {
        const existing = traceIdsByCorrelation.get(correlationId) ?? new Set();
        existing.add(traceId);
        traceIdsByCorrelation.set(correlationId, existing);
      }
    }
  }
  for (const correlationId of correlations) {
    if (traceIdsByCorrelation.get(correlationId)?.size !== 1) {
      fail("cohort-root", "every correlated worker observation must resolve exactly one S00 trace");
    }
  }
  const traceIds = new Set([...traceIdsByCorrelation.values()].flatMap((entries) => [...entries]));
  const traceRaws = await queryByValues({
    accountId,
    token,
    template,
    key: "$metadata.traceId",
    values: [...traceIds],
    batchSize: 4,
  });
  const observationRaws = await queryByValues({
    accountId,
    token,
    template,
    key: "correlationId",
    values: correlations,
    fixedFilters: [queryFilter("schema", "sdt.observe/v1")],
  });
  const merged = mergeTelemetryEvents([...workerRaws, ...rootRaws, ...traceRaws, ...observationRaws]);
  // Body-less internal reads intentionally have no attempt identity and are
  // outside the B0 correlation universe. Retain every event that can be
  // joined; fail closed for missing identities in the worker query above.
  return {
    events: merged.events.filter((event) => {
      const payload = observationPayload(event);
      return payload === undefined || correlations.includes(observationCorrelation(payload));
    }),
  };
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
  return /g30-b0:(?:trace-count|trace-loss|observation-trace-loss|observation-worker|observation-trace-complete)|g30-trace-export:(?:cohort-worker|cohort-root|observation-root|observation-worker|observation-request-id)/.test(message);
}

async function main() {
  const ledgerPath = required("--ledger", argument("--ledger"));
  const output = argument("--output", ".artifacts/g30-b0-traces.json");
  const rawOutput = argument("--raw-output");
  const ledgerDocument = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const observationLedger = observationLedgerForPhase(ledgerDocument);
  let raw;
  const input = argument("--input");
  if (input !== undefined) {
    raw = JSON.parse(readFileSync(input, "utf8"));
  } else {
    const accountId = required("--account-id", argument("--account-id", process.env.CLOUDFLARE_ACCOUNT_ID));
    const token = readFileSync(required("--api-token-file", argument("--api-token-file", process.env.G30_OBSERVABILITY_TOKEN_FILE)), "utf8").trim();
    const queryPath = required("--query", argument("--query"));
    if (token.length === 0) fail("token", "observability token is empty");
    raw = await exportCohortTelemetry({ accountId, token, template: JSON.parse(readFileSync(queryPath, "utf8")), ledger: observationLedger });
  }
  const deadline = exportDeadline(ledgerDocument.ledger);
  let bundle;
  let traces;
  let proof;
  for (;;) {
    try {
      bundle = normalizeTelemetryBundle(raw, Date.now(), clientRequestIdByPlatformRayId(observationLedger));
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
      raw = await exportCohortTelemetry({ accountId, token, template: JSON.parse(readFileSync(queryPath, "utf8")), ledger: observationLedger });
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
  if (rawOutput !== undefined) {
    mkdirSync(dirname(rawOutput), { recursive: true });
    writeFileSync(rawOutput, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  }
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ traceCount: traces.length, observationTraceCount: bundle.traces.length, observationCount: bundle.observations.length, requestCount: proof.requestCount, observationLedgerCount: observationLedger.length }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
