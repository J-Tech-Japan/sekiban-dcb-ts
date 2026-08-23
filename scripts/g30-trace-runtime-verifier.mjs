#!/usr/bin/env node
/**
 * Runtime-shaped verifier shared by telemetry normalization and the final B0
 * evidence gate.  It is deliberately separate from the static host-bundle
 * checker: it accepts only exported spans and rejects a stale `runtimeVerified`
 * flag after evidence has been edited.
 */
import manifest from "../contracts/commit-trace-manifest.json" with { type: "json" };

function fail(code, message) {
  throw new Error(`g30-trace-runtime:${code}:${message}`);
}

const ROWS = manifest.schemas["sdt.commit/v1"].rows;
const ROW_BY_ID = new Map(ROWS.map((row) => [row.rowId, row]));
const ATTRIBUTE_MATRIX = manifest.attributeMatrix.attributes;
const ATTRIBUTE_IDS = new Set(Object.keys(ATTRIBUTE_MATRIX));
const RAW_TAG_KEY = /(^|[._])tag($|[._])/i;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SUCCESS_REQUIRED = Object.freeze(
  manifest.schemas["sdt.commit/v1"].boundaries.find((boundary) => boundary.name === "success")?.requiredRows ?? [],
);

function numberFrom(value, label) {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(result)) fail("time", `${label} is not numeric`);
  return result;
}

function rowScopedState(declaration, face, rowId) {
  if (Array.isArray(declaration.rowScope) && !declaration.rowScope.includes(rowId)) return "forbidden";
  return declaration.faces?.[face];
}

function assertAttributeType(value, declaration, key) {
  const type = declaration.type;
  if (type === "hex64") {
    if (typeof value !== "string" || !HEX64.test(value)) fail("attribute-type", `${key} must be lower-case 64-hex`);
    return;
  }
  if (type === "uuid") {
    if (typeof value !== "string" || !UUID.test(value)) fail("attribute-type", `${key} must be a UUID`);
    return;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") fail("attribute-type", `${key} must be boolean`);
    return;
  }
  if (type === "integer" || type === "non-negative-integer") {
    if (typeof value !== "number" || !Number.isInteger(value) || (type === "non-negative-integer" && value < 0)) {
      fail("attribute-type", `${key} must be ${type}`);
    }
    return;
  }
  if (typeof value !== "string") fail("attribute-type", `${key} must be string`);
  if (Array.isArray(declaration.values) && !declaration.values.includes(value)) {
    fail("attribute-enum", `${key}=${value} is not declared by the manifest`);
  }
}

function assertRuntimeAttributes(span, row) {
  const attributes = span?.attributes;
  if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) {
    fail("attributes", `${span?.rowId ?? "unknown"} attributes must be an object`);
  }
  for (const [key, value] of Object.entries(attributes)) {
    if (!ATTRIBUTE_IDS.has(key)) fail("attribute-unknown", `${span.rowId} emitted unknown attribute ${key}`);
    if (key !== "tag.key_hash" && RAW_TAG_KEY.test(key)) fail("raw-tag", `${span.rowId} emitted raw tag-like attribute ${key}`);
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      fail("attribute-type", `${span.rowId}.${key} must be scalar`);
    }
  }
  for (const [key, declaration] of Object.entries(ATTRIBUTE_MATRIX)) {
    const state = rowScopedState(declaration, span.face, span.rowId);
    const present = Object.hasOwn(attributes, key);
    if (state === "required" && !present) fail("attribute-missing", `${span.rowId} lacks required ${key}`);
    if (state === "forbidden" && present) fail("attribute-forbidden", `${span.rowId} emitted forbidden ${key}`);
    if (present) assertAttributeType(attributes[key], declaration, key);
  }
  if (attributes.operation !== row.span) fail("operation", `${span.rowId} operation differs from authority`);
  if (attributes["span.kind"] !== row.kind) fail("span-kind", `${span.rowId} kind differs from authority`);
  const expectedPhase = { S05a: 0, S05b: 1, S05c: 2, S05d: 3, S05e: 4 }[span.rowId];
  if (expectedPhase !== undefined && attributes["phase.ordinal"] !== expectedPhase) {
    fail("phase-ordinal", `${span.rowId} must carry phase.ordinal=${expectedPhase}`);
  }
  for (const key of ["member.index", "tag.key_hash"]) {
    if (ATTRIBUTE_MATRIX[key]?.rowScope?.includes(span.rowId) && !Object.hasOwn(attributes, key)) {
      fail("member-attribute", `${span.rowId} lacks required ${key}`);
    }
  }
}

function assertRuntimeStructure(spans) {
  const roots = spans.filter((span) => span.logicalParent === null);
  if (roots.length !== 1 || roots[0]?.rowId !== "S00") fail("root", "a complete request trace requires exactly S00 as root");
  const rootId = roots[0].rootId;
  for (const span of spans) {
    const row = ROW_BY_ID.get(span?.rowId);
    if (row === undefined) fail("row", `unknown row ${String(span?.rowId)}`);
    if (span.schema !== "sdt.commit/v1" || span.span !== row.span || span.emitter !== row.emitter || span.kind !== row.kind || span.logicalParent !== row.logicalParent) {
      fail("row-shape", `${span.rowId} differs from the authority row`);
    }
    if (span.rootId !== rootId) fail("cross-root", `${span.rowId} belongs to a different root`);
    const start = numberFrom(span.startMs, `${span.rowId}.start`);
    const end = numberFrom(span.endMs, `${span.rowId}.end`);
    if (end < start) fail("time", `${span.rowId} ends before it begins`);
    if (end === start && (span.present !== true || span.zeroDurationPlatformLimited !== true)) {
      fail("zero-duration", `${span.rowId} zero duration must remain present and platform-limited`);
    }
    assertRuntimeAttributes(span, row);
    if (span.logicalParent === null || span.logicalParent === "provider-subrequest") continue;
    const parents = spans.filter((candidate) => candidate.rowId === span.logicalParent);
    if (parents.length === 0) fail("parent", `${span.rowId} lacks ${span.logicalParent}`);
    const containing = parents.find((parent) =>
      numberFrom(span.startMs, `${span.rowId}.start`) >= numberFrom(parent.startMs, `${parent.rowId}.start`) &&
      numberFrom(span.endMs, `${span.rowId}.end`) <= numberFrom(parent.endMs, `${parent.rowId}.end`) &&
      span.clockDomain === parent.clockDomain,
    );
    if (containing === undefined) {
      if (parents.some((parent) => parent.clockDomain !== span.clockDomain)) fail("clock-domain", `${span.rowId} mixes caller/callee clock domains`);
      fail("containment", `${span.rowId} is not temporally contained by ${span.logicalParent}`);
    }
  }
}

/** Re-run this immediately before accepting B0 evidence, not just at export. */
export function verifyExportedSuccessTrace(trace) {
  const spans = trace?.spans;
  if (!Array.isArray(spans)) fail("trace-shape", "trace spans must be an array");
  if (trace.schema !== "sdt.commit/v1" || trace.boundary !== "success") fail("trace-identity", "trace must be an sdt.commit/v1 success boundary");
  assertRuntimeStructure(spans);
  const counts = new Map(spans.map((span) => [span.rowId, 0]));
  for (const span of spans) counts.set(span.rowId, (counts.get(span.rowId) ?? 0) + 1);
  const success = manifest.schemas["sdt.commit/v1"].boundaries.find((boundary) => boundary.name === "success");
  if (success === undefined) fail("boundary", "manifest lacks v1 success boundary");
  for (const rowId of success.requiredRows) {
    if ((counts.get(rowId) ?? 0) === 0) fail("boundary-required", `success trace lacks ${rowId}`);
  }
  for (const rowId of success.forbiddenRows) {
    if ((counts.get(rowId) ?? 0) !== 0) fail("boundary-forbidden", `success trace emitted ${rowId}`);
  }
  for (const row of ROWS) {
    if (row.successCardinality.startsWith("1") && (counts.get(row.rowId) ?? 0) !== 1) {
      fail("cardinality", `${row.rowId} must occur exactly once in a success trace`);
    }
  }
  return Object.freeze({ rows: spans.length, complete: true });
}
