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
import { assertTraceCohort } from "../g30-b0-contract.mjs";
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
  return object(event?.$metadata) ?? object(event?.metadata) ?? {};
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
 * Groups custom spans by Cloudflare trace ID and anchors the group to the
 * S00 request's ray/request identifier. No chronological "nearest span"
 * fallback is allowed, so a propagation break remains visible as trace loss.
 */
export function normalizeTelemetryExport(raw, exportedAtMs = Date.now()) {
  const groups = new Map();
  for (const event of rawEvents(raw)) {
    const metadata = metadataFor(event);
    const traceId = metadataField(metadata, event, ["traceId", "trace_id"]);
    const span = normalizedSpan(event, typeof traceId === "string" ? traceId : "");
    if (span === undefined) continue;
    if (typeof traceId !== "string" || traceId.length === 0) fail("trace-id", `custom ${span.rowId} span has no trace id`);
    const group = groups.get(traceId) ?? { traceId, events: [] };
    group.events.push({ span, metadata }); groups.set(traceId, group);
  }
  const output = [];
  for (const group of groups.values()) {
    const root = group.events.find((entry) => entry.span.rowId === "S00");
    if (root === undefined) continue;
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
      spans,
    };
    if (complete) verifyRuntimeSuccessTrace(trace);
    output.push({
      ...trace,
      runtimeVerified: complete,
    });
  }
  return output.sort((left, right) => left.requestId.localeCompare(right.requestId));
}

export async function queryTelemetry({ accountId, token, payload }) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/observability/telemetry/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const raw = await response.json();
  if (!response.ok || raw?.success === false || (Array.isArray(raw?.errors) && raw.errors.length > 0)) {
    fail("api", `Cloudflare telemetry query failed: HTTP ${response.status}`);
  }
  return raw;
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
  const traces = normalizeTelemetryExport(raw);
  const proof = assertTraceCohort(ledgerDocument.ledger, traces, Date.now());
  const result = { task: "SDT-G30", phase: "B", exportedAt: new Date().toISOString(), exportCompletedAtMs: Date.now(), proof, traces };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ traceCount: traces.length, requestCount: proof.requestCount }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
