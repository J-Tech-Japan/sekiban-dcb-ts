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
import { assertObservationStream, assertTraceCohort, observationLedgerForPhase, reconcileEmittedRowInventory } from "../g30-b0-contract.mjs";
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
const WORKER_ROW_IDS = new Set(ROWS
  .filter((row) => row.emitter === "root-worker" || row.emitter === "caller-worker")
  .map((row) => row.rowId));
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

function normalizedEmittedWorkerRowIds(value) {
  if (!Array.isArray(value)) {
    fail("emitted-row-inventory", "worker observation lacks emittedWorkerRowIds");
  }
  const rows = [];
  const seen = new Set();
  for (const [index, raw] of value.entries()) {
    if (typeof raw !== "string" || raw.length === 0 || !WORKER_ROW_IDS.has(raw)) {
      fail("emitted-row-inventory", `worker observation emittedWorkerRowIds[${index}] is not a Worker-local manifest row`);
    }
    if (seen.has(raw)) fail("emitted-row-inventory", `worker observation repeats emitted row ${raw}`);
    seen.add(raw);
    rows.push(raw);
  }
  return Object.freeze(rows.sort());
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
  const emittedWorkerRowIds = payload.event === "worker.invocation"
    ? normalizedEmittedWorkerRowIds(payload.emittedWorkerRowIds)
    : undefined;
  return Object.freeze({
    ...payload,
    ...(emittedWorkerRowIds === undefined ? {} : { emittedWorkerRowIds }),
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
 * observation -> S00 -> client CF-Ray by that correlation.  The root may not
 * retain a provider CF-Ray, so the live exporter also discovers its trace ID
 * by the same exact correlation before this normalizer runs. No time-nearest
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
      if (span !== undefined) group.events.push({ span, event });
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
  const inventoryObservations = [];
  // The S00 root, rather than an observation's arrival order, is the trace
  // authority.  When running against the live API its provider CF-Ray joins
  // directly back to the client ledger.  That lets AC5 distinguish a missing
  // root from a root whose remaining schema/observation has not arrived.
  for (const [correlationId, rooted] of rootsByCorrelation) {
    const { group, root } = rooted;
    const joined = observationsByCorrelation.get(correlationId) ?? [];
    const worker = joined.filter((entry) => entry.payload.event === "worker.invocation");
    const rootRayValue = metadataField(metadataFor(root.event), root.event, ["rayId", "ray_id"]);
    let requestId;
    let platformRayId;
    if (clientRequestIdsByRayId !== undefined) {
      if (rootRayValue !== undefined && rootRayValue !== null) {
        platformRayId = cloudflareRayId(rootRayValue, `S00 trace ${group.traceId} root provider ray`);
        requestId = clientRequestIdsByRayId.get(platformRayId);
        if (typeof requestId !== "string" || requestId.length === 0) {
          fail("observation-ray-join", `S00 trace ${group.traceId} root has no client CF-Ray ledger join`);
        }
      } else {
        // Cloudflare custom-span roots can omit $metadata.rayId even though
        // their exact post-admission correlation is present on the matching
        // Worker observation.  The caller only supplies such roots after a
        // correlation.id query, so retain the client join through that one
        // observation rather than guessing by timestamp or span proximity.
        if (worker.length !== 1) {
          fail("observation-ray-join", `rayless S00 trace ${group.traceId} lacks one exact worker observation`);
        }
        const observedWorkerRequestId = worker[0].payload.requestId;
        const workerRayId = cloudflareRayId(observedWorkerRequestId, `rayless S00 trace ${group.traceId} worker observation`);
        const joinedRequestId = clientRequestIdsByRayId.get(workerRayId);
        if (typeof joinedRequestId !== "string" || joinedRequestId.length === 0) {
          fail("observation-ray-join", `rayless S00 trace ${group.traceId} worker observation has no client CF-Ray ledger join`);
        }
        platformRayId = workerRayId;
        requestId = joinedRequestId;
      }
    } else if (worker.length === 1 && typeof worker[0].payload.requestId === "string" && worker[0].payload.requestId.length > 0) {
      requestId = worker[0].payload.requestId;
    } else {
      // The input-mode unit fixtures do not supply real CF-Ray values. A
      // root without exactly one worker observation therefore cannot be
      // named in that mode and remains outside the normalized trace set.
      continue;
    }
    if (worker.length === 1) {
      const observedWorkerRequestId = worker[0].payload.requestId;
      if (typeof observedWorkerRequestId !== "string" || observedWorkerRequestId.length === 0) {
        fail("observation-request-id", `S00 trace ${group.traceId} worker observation lacks the client CF-Ray`);
      }
      if (clientRequestIdsByRayId !== undefined) {
        const workerRayId = cloudflareRayId(observedWorkerRequestId, `S00 trace ${group.traceId} worker observation`);
        if (workerRayId !== platformRayId) {
          fail("observation-request-id", `S00 trace ${group.traceId} worker observation conflicts with its root provider ray`);
        }
      } else if (observedWorkerRequestId !== requestId) {
        fail("observation-request-id", `S00 trace ${group.traceId} worker observation conflicts with its root request`);
      }
    }
    const normalizedWorker = worker.length === 1
      ? normalizeObservation(worker[0].payload, worker[0].event, requestId, group.traceId, correlationId, platformRayId)
      : undefined;
    if (normalizedWorker !== undefined) inventoryObservations.push(normalizedWorker);
    const spans = group.events.map((entry) => entry.span);
    const rowCounts = new Map(spans.map((span) => [span.rowId, 0]));
    for (const span of spans) rowCounts.set(span.rowId, (rowCounts.get(span.rowId) ?? 0) + 1);
    const rowsComplete = SUCCESS_REQUIRED.every((rowId) => (rowCounts.get(rowId) ?? 0) > 0);
    // A root with an absent/duplicate worker observation is not a complete
    // schema observation. It remains explicitly represented so the B0
    // contract can record schema-incomplete instead of silently dropping it.
    const complete = rowsComplete && worker.length === 1;
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
    const normalizedTrace = Object.freeze({
      ...trace,
      runtimeVerified: complete,
    });
    output.push(normalizedTrace);
    // Incomplete observations remain in raw telemetry but are not allowed to
    // masquerade as joined evidence for activation/outlier conclusions.
    if (!complete) continue;
    for (const observed of joined) {
      observations.push(observed === worker[0] && normalizedWorker !== undefined
        ? normalizedWorker
        : normalizeObservation(observed.payload, observed.event, requestId, group.traceId, correlationId, platformRayId));
    }
  }
  return Object.freeze({
    traces: output.sort((left, right) => left.requestId.localeCompare(right.requestId)),
    observations: observations.sort((left, right) =>
      left.requestId.localeCompare(right.requestId) || left.emittedAtMs - right.emittedAtMs,
    ),
    inventoryObservations: inventoryObservations.sort((left, right) =>
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
// two fixed observation filters, and one `in` membership leaf. Keep the
// request batch deliberately bounded at ten identities and enforce the
// provider node limit structurally before issuing any request.
export const CLOUDFLARE_TELEMETRY_MAX_FILTER_NODES = 16;
export const TELEMETRY_QUERY_VALUE_BATCH = 10;
// A full commit trace can contain substantially more provider events than a
// root-discovery or observation query.  The live capacity probe recorded a
// 2,000-result saturation for four exact trace IDs while every constituent
// identity was below that ceiling (the largest was 805).  Expand each known
// trace through one exact identity so saturation stays fail-closed rather than
// discarding a valid cohort behind a provider result cap.
export const TELEMETRY_TRACE_ID_BATCH = 1;
export const TELEMETRY_RETRY_DELAY_MS = 15_000;

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

/**
 * The Workers Observability query API's set-membership form is one `in` leaf
 * whose `value` is a comma-separated string.  Do not serialize a cohort as a
 * nested OR group: that shape is structurally valid but does not select the
 * intended multi-value telemetry cohort on the live endpoint.
 */
export function cohortValuesFilter(key, values) {
  return {
    key,
    operation: "in",
    type: "string",
    value: nonEmptyTelemetryStrings(values, key).join(","),
  };
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

function recordRootTraceId(traceIdsByCorrelation, correlationId, traceId) {
  const existing = traceIdsByCorrelation.get(correlationId) ?? new Set();
  existing.add(traceId);
  traceIdsByCorrelation.set(correlationId, existing);
}

async function queryByValues({ accountId, token, template, key, values, fixedFilters = [], batchSize = TELEMETRY_QUERY_VALUE_BATCH }) {
  const result = [];
  for (const batch of chunks(nonEmptyTelemetryStrings(values, key), batchSize)) {
    const payload = buildBoundedTelemetryQuery(template, [...fixedFilters, cohortValuesFilter(key, batch)]);
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
  const platformRayIds = [...clientRequestIdsByRayId.keys()];
  const workerRaws = await queryByValues({
    accountId,
    token,
    template,
    key: "$metadata.rayId",
    values: platformRayIds,
  });
  const workerByRequestId = new Map();
  const requestIdByCorrelation = new Map();
  for (const { payload, event } of payloadsFrom(workerRaws, "worker.invocation")) {
    const providerRayValue = metadataField(metadataFor(event), event, ["rayId", "ray_id"]);
    const providerRayId = cloudflareRayId(providerRayValue, "worker observation provider ray");
    const requestId = clientRequestIdsByRayId.get(providerRayId);
    const correlationId = observationCorrelation(payload);
    if (typeof requestId !== "string") continue;
    if (cloudflareRayId(payload?.requestId, "worker observation payload ray") !== providerRayId) {
      fail("cohort-worker", "worker observation payload ray conflicts with its provider ray");
    }
    if (correlationId === undefined) fail("cohort-worker", `client request ${requestId} worker observation lacks correlation`);
    const existing = workerByRequestId.get(requestId) ?? new Set();
    existing.add(correlationId);
    workerByRequestId.set(requestId, existing);
    const priorRequestId = requestIdByCorrelation.get(correlationId);
    if (priorRequestId !== undefined && priorRequestId !== requestId) {
      fail("cohort-worker", `worker correlation ${correlationId} maps to more than one client request`);
    }
    requestIdByCorrelation.set(correlationId, requestId);
  }
  for (const [requestId, correlations] of workerByRequestId) {
    if (correlations.size !== 1) {
      fail("cohort-worker", `client request ${requestId} has more than one worker correlation`);
    }
  }
  // Query roots directly by the provider identity. A missing Worker Logs
  // observation must not make the root disappear from the AC5 classification:
  // it is either a schema-incomplete root or a root-absent loss, never an
  // arrival-order guess.
  const rootRaws = await queryByValues({
    accountId,
    token,
    template,
    key: "$metadata.rayId",
    values: platformRayIds,
    fixedFilters: [queryFilter("schema.version", "sdt.commit/v1"), queryFilter("$metadata.spanName", "sdt.commit")],
  });
  const traceIdsByCorrelation = new Map();
  for (const raw of rootRaws) {
    for (const event of rawEvents(raw)) {
      const attributes = attributesFor(event);
      const correlationId = attributes["correlation.id"];
      const rootRayValue = metadataField(metadataFor(event), event, ["rayId", "ray_id"]);
      const traceId = metadataField(metadataFor(event), event, ["traceId", "trace_id"]);
      if (
        typeof correlationId === "string"
        && typeof traceId === "string"
        && traceId.length > 0
        && clientRequestIdsByRayId.has(cloudflareRayId(rootRayValue, "S00 root provider ray"))
      ) {
        recordRootTraceId(traceIdsByCorrelation, correlationId, traceId);
      }
    }
  }
  // Some Workers Logs custom-span roots do not retain $metadata.rayId.  The
  // worker.invocation observation does retain a post-admission correlation,
  // however, so use that exact provider-indexed correlation to discover the
  // root trace ID.  This is an additional deterministic route; CF-Ray root
  // discovery above remains authoritative when that provider identity exists.
  const workerCorrelations = [...requestIdByCorrelation.keys()];
  const correlationRootRaws = workerCorrelations.length === 0 ? [] : await queryByValues({
    accountId,
    token,
    template,
    key: "correlation.id",
    values: workerCorrelations,
    fixedFilters: [queryFilter("schema.version", "sdt.commit/v1"), queryFilter("$metadata.spanName", "sdt.commit")],
  });
  for (const raw of correlationRootRaws) {
    for (const event of rawEvents(raw)) {
      const attributes = attributesFor(event);
      const correlationId = attributes["correlation.id"];
      const traceId = metadataField(metadataFor(event), event, ["traceId", "trace_id"]);
      if (typeof correlationId !== "string" || typeof traceId !== "string" || traceId.length === 0) continue;
      if (!requestIdByCorrelation.has(correlationId)) {
        fail("cohort-root", `correlation-root query returned unjoined correlation ${correlationId}`);
      }
      recordRootTraceId(traceIdsByCorrelation, correlationId, traceId);
    }
  }
  for (const [correlationId, traceIds] of traceIdsByCorrelation) {
    if (traceIds.size !== 1) {
      fail("cohort-root", `S00 correlation ${correlationId} resolves to more than one trace`);
    }
  }
  const traceIds = new Set([...traceIdsByCorrelation.values()].flatMap((entries) => [...entries]));
  const correlations = [...new Set([
    ...[...traceIdsByCorrelation.keys()],
    ...[...workerByRequestId.values()].flatMap((entries) => [...entries]),
  ])];
  const traceRaws = traceIds.size === 0 ? [] : await queryByValues({
    accountId,
    token,
    template,
    key: "$metadata.traceId",
    values: [...traceIds],
    batchSize: TELEMETRY_TRACE_ID_BATCH,
  });
  const observationRaws = correlations.length === 0 ? [] : await queryByValues({
    accountId,
    token,
    template,
    key: "correlationId",
    values: correlations,
    fixedFilters: [queryFilter("schema", "sdt.observe/v1")],
  });
  const merged = mergeTelemetryEvents([...workerRaws, ...rootRaws, ...correlationRootRaws, ...traceRaws, ...observationRaws]);
  // Body-less internal reads intentionally have no attempt identity and are
  // outside the B0 correlation universe. Retain every event that can be
  // classified by a queried root or worker observation; no time-nearest join
  // is used for a root-absent loss.
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

export function exportDeadline(ledger) {
  if (!Array.isArray(ledger) || ledger.length === 0) fail("ledger", "B trace export needs the canonical ledger");
  return Math.max(...ledger.map((record, index) => numberFrom(record?.completedAtMs, `ledger[${index}].completedAtMs`))) + 10 * 60 * 1_000;
}

function requestIdOrder(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeFailureClass(error) {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^(g30-(?:trace-export|b0):[a-z0-9-]+)/.exec(message);
  return match?.[1] ?? "unknown";
}

function traceIsSchemaComplete(trace, requestId) {
  const roots = Array.isArray(trace?.spans) ? trace.spans.filter((span) => span?.rowId === "S00") : [];
  if (roots.length !== 1) return false;
  if (trace?.schema !== "sdt.commit/v1" || trace?.boundary !== "success" || trace?.complete !== true || trace?.runtimeVerified !== true) {
    return false;
  }
  try {
    verifyRuntimeSuccessTrace(trace);
    return true;
  } catch {
    // The live failure artifact is a classification record, not a second
    // validator. A failed runtime re-verification remains schema-incomplete.
    return false;
  }
}

/**
 * Captures the immutable client ledger's complete join state when the trace
 * export fails. It deliberately keeps request identity only in the local
 * failure artifact: no raw trace/correlation/tag/token data is copied into
 * it, and the normal evidence copier never publishes this file.
 */
export function buildTraceExportFailureEvidence({ ledger, traces, emittedRowInventory = [], capturedAtMs = Date.now(), deadlineMs, error }) {
  if (!Array.isArray(ledger) || ledger.length === 0) fail("failure-evidence", "failure evidence needs the canonical B ledger");
  if (!Array.isArray(traces)) fail("failure-evidence", "failure evidence needs normalized traces");
  if (!Array.isArray(emittedRowInventory)) fail("failure-evidence", "failure evidence needs emitted-row inventory");
  const tracesByRequestId = new Map();
  for (const trace of traces) {
    if (typeof trace?.requestId === "string" && trace.requestId.length > 0) tracesByRequestId.set(trace.requestId, trace);
  }
  const ranked = ledger.map((record, index) => ({
    record,
    ordinal: index + 1,
    requestId: required(`ledger[${index}].requestId`, record?.requestId),
    clientLatencyMs: numberFrom(record?.responseLatencyMs, `ledger[${index}].responseLatencyMs`),
  })).sort((left, right) => right.clientLatencyMs - left.clientLatencyMs || requestIdOrder(left.requestId, right.requestId));
  const rankByRequestId = new Map(ranked.map((entry, index) => [entry.requestId, index + 1]));
  const requestJoinStates = ledger.map((record, index) => {
    const requestId = required(`ledger[${index}].requestId`, record?.requestId);
    const trace = tracesByRequestId.get(requestId);
    const spans = Array.isArray(trace?.spans) ? trace.spans : [];
    const observedRows = new Set(spans.map((span) => span?.rowId).filter((rowId) => typeof rowId === "string"));
    const rootPresent = observedRows.has("S00");
    const schemaComplete = traceIsSchemaComplete(trace, requestId);
    const stage = schemaComplete ? "schema-complete" : rootPresent ? "schema-incomplete" : "root-absent";
    return Object.freeze({
      requestId,
      ordinal: index + 1,
      fullLedgerRank: rankByRequestId.get(requestId),
      clientLatencyMs: numberFrom(record?.responseLatencyMs, `ledger[${index}].responseLatencyMs`),
      tracePresent: trace !== undefined,
      rootPresent,
      runtimeVerified: trace?.runtimeVerified === true,
      schemaComplete,
      stage,
      observedRequiredRows: Object.freeze(SUCCESS_REQUIRED.filter((rowId) => observedRows.has(rowId))),
      missingRequiredRows: Object.freeze(SUCCESS_REQUIRED.filter((rowId) => !observedRows.has(rowId))),
    });
  });
  const missing = requestJoinStates.filter((entry) => !entry.schemaComplete);
  return Object.freeze({
    task: "SDT-G30",
    phase: "B",
    result: "trace-export-failed",
    capturedAt: new Date(numberFrom(capturedAtMs, "failure.capturedAtMs")).toISOString(),
    exportDeadline: new Date(numberFrom(deadlineMs, "failure.deadlineMs")).toISOString(),
    failureClass: safeFailureClass(error),
    clientCount: requestJoinStates.length,
    schemaCompleteCount: requestJoinStates.length - missing.length,
    missingCount: missing.length,
    missingRequestIds: Object.freeze(missing.map((entry) => entry.requestId)),
    requestJoinStates: Object.freeze(requestJoinStates),
    emittedRowInventory: Object.freeze([...emittedRowInventory]),
    rawDataHandling: "local failure artifact only; no raw telemetry, trace IDs, correlation IDs, tags, payloads, or credentials are retained",
  });
}

function writeTraceExportFailureEvidence(path, evidence) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

function pendingTelemetryError(error) {
  const message = error instanceof Error ? error.message : String(error);
  // A complete-success assertion can fail while the bounded query has already
  // found S00 but one or more child spans have not become query-visible yet.
  // Treat that as the same telemetry-arrival condition as a missing trace;
  // keep the original B ledger and retry only until its fixed export deadline.
  return /g30-b0:(?:delivery-budget|tail-coverage|trace-complete|trace-loss|observation-trace-loss|observation-worker|observation-trace-complete)|g30-trace-export:(?:cohort-worker|cohort-root|observation-worker|observation-request-id)/.test(message);
}

/**
 * Fetch and validate the complete live cohort as one retryable operation.
 * In particular, the *first* Workers Logs query belongs inside this loop:
 * telemetry may arrive after the client request returns, and an incomplete
 * first query is evidence of neither success nor permanent trace loss.
 */
export async function acquireCohortTelemetry({
  fetchCohort,
  validate,
  deadlineMs,
  retry = true,
  now = Date.now,
  sleepFor = sleep,
}) {
  if (typeof fetchCohort !== "function" || typeof validate !== "function") {
    fail("cohort-acquire", "fetchCohort and validate must be functions");
  }
  if (!Number.isFinite(deadlineMs)) fail("cohort-acquire", "deadlineMs must be finite");
  let lastPendingError;
  for (;;) {
    if (lastPendingError !== undefined && now() >= deadlineMs) throw lastPendingError;
    try {
      const raw = await fetchCohort();
      return Object.freeze({ raw, value: await validate(raw) });
    } catch (error) {
      if (!retry || !pendingTelemetryError(error) || now() >= deadlineMs) throw error;
      lastPendingError = error;
      await sleepFor(TELEMETRY_RETRY_DELAY_MS);
    }
  }
}

async function main() {
  const ledgerPath = required("--ledger", argument("--ledger"));
  const output = argument("--output", ".artifacts/g30-b0-traces.json");
  const rawOutput = argument("--raw-output");
  const failureOutput = argument("--failure-output");
  const ledgerDocument = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const observationLedger = observationLedgerForPhase(ledgerDocument);
  const input = argument("--input");
  let fetchCohort;
  if (input !== undefined) {
    fetchCohort = async () => JSON.parse(readFileSync(input, "utf8"));
  } else {
    const accountId = required("--account-id", argument("--account-id", process.env.CLOUDFLARE_ACCOUNT_ID));
    const token = readFileSync(required("--api-token-file", argument("--api-token-file", process.env.G30_OBSERVABILITY_TOKEN_FILE)), "utf8").trim();
    const queryPath = required("--query", argument("--query"));
    if (token.length === 0) fail("token", "observability token is empty");
    const template = JSON.parse(readFileSync(queryPath, "utf8"));
    fetchCohort = async () => exportCohortTelemetry({ accountId, token, template, ledger: observationLedger });
  }
  const deadline = exportDeadline(ledgerDocument.ledger);
  let lastFailureEvidence;
  let acquisition;
  try {
    acquisition = await acquireCohortTelemetry({
      fetchCohort,
      deadlineMs: deadline,
      retry: input === undefined,
      validate: async (raw) => {
        const validationAtMs = Date.now();
        const bundle = normalizeTelemetryBundle(raw, validationAtMs, clientRequestIdByPlatformRayId(observationLedger));
        const retainedRequestIds = new Set(ledgerDocument.ledger?.map((record) => record?.requestId));
        const traces = bundle.traces.filter((trace) => retainedRequestIds.has(trace.requestId));
        const inventoryObservations = bundle.inventoryObservations.filter((observation) => retainedRequestIds.has(observation.requestId));
        const emittedRowInventory = reconcileEmittedRowInventory(ledgerDocument.ledger, traces, inventoryObservations);
        try {
          const proof = assertTraceCohort(ledgerDocument.ledger, traces, validationAtMs);
          const observationTraces = bundle.traces.filter((trace) => trace.complete === true && trace.runtimeVerified === true);
          assertObservationStream(
            observationLedger,
            observationTraces,
            bundle.observations,
            { allowedMissingRequestIds: proof.missingRequestIds },
          );
          return Object.freeze({ bundle, traces, observationTraces, proof, inventoryObservations, emittedRowInventory });
        } catch (error) {
          // Preserve the latest normalized cohort even while the bounded retry
          // loop keeps waiting. If the deadline expires, this is the exact
          // identity-level state that caused the terminal failure.
          lastFailureEvidence = buildTraceExportFailureEvidence({
            ledger: ledgerDocument.ledger,
            traces,
            emittedRowInventory,
            capturedAtMs: validationAtMs,
            deadlineMs: deadline,
            error,
          });
          throw error;
        }
      },
    });
  } catch (error) {
    if (failureOutput !== undefined && lastFailureEvidence !== undefined) {
      writeTraceExportFailureEvidence(failureOutput, lastFailureEvidence);
    }
    throw error;
  }
  const raw = acquisition.raw;
  const { bundle, traces, observationTraces, proof, inventoryObservations, emittedRowInventory } = acquisition.value;
  const result = {
    task: "SDT-G30",
    phase: "B",
    exportedAt: new Date().toISOString(),
    exportCompletedAtMs: Date.now(),
    proof,
    traces,
    observationTraces,
    observations: bundle.observations,
    inventoryObservations,
    emittedRowInventory,
  };
  mkdirSync(dirname(output), { recursive: true });
  if (rawOutput !== undefined) {
    mkdirSync(dirname(rawOutput), { recursive: true });
    writeFileSync(rawOutput, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  }
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ traceCount: traces.length, observationTraceCount: observationTraces.length, observationCount: bundle.observations.length, inventoryObservationCount: inventoryObservations.length, requestCount: proof.requestCount, schemaCompleteCount: proof.schemaCompleteCount, missingCount: proof.missingCount, observationLedgerCount: observationLedger.length }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
