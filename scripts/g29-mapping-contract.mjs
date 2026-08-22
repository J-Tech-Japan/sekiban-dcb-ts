#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Vitest's Workers pool evaluates this module from a generated module URL;
// the repository working directory is the stable artifact root for both the
// executable runner and the test adapter.
const root = process.cwd();
const mappingPath = resolve(root, "docs/SDT-G29-mapping.json");
const requiredRows = Object.freeze([
  "event-payload", "business-time", "canonical-identity", "event-id", "suid",
  "tags", "state", "projector", "command-input", "read-set", "decision-log",
  "terminal-outcome", "view-descriptor",
]);
const requiredColumns = Object.freeze(["field", "wire", "owner", "doTs", "portable", "version", "unsupported"]);

export function validateMapping(mapping) {
  if (mapping.schemaVersion !== 1 || !Array.isArray(mapping.rows) || !Array.isArray(mapping.columns)) {
    throw new Error("SDT-G29 mapping schema must be version 1 with rows and columns");
  }
  if (JSON.stringify(mapping.columns) !== JSON.stringify(requiredColumns)) {
    throw new Error("SDT-G29 mapping columns are not the published contract");
  }
  const ids = mapping.rows.map((row) => row?.rowId);
  if (JSON.stringify(ids) !== JSON.stringify(requiredRows)) {
    throw new Error(`SDT-G29 mapping row order/ids mismatch: ${ids.join(",")}`);
  }
  for (const row of mapping.rows) {
    for (const column of requiredColumns) {
      if (typeof row[column] !== "string" || row[column].length === 0) {
        throw new Error(`${row.rowId ?? "unknown"}:${column} is required`);
      }
    }
  }
  return Object.freeze({
    ...mapping,
    rows: Object.freeze(mapping.rows.map((row) => Object.freeze(row))),
    columns: Object.freeze([...mapping.columns]),
  });
}

export function loadMapping(read = (path) => readFileSync(path, "utf8")) {
  return validateMapping(JSON.parse(read(mappingPath)));
}

export function assertMappingContract(actual, mapping = loadMapping()) {
  for (const row of mapping.rows) {
    const observed = actual?.[row.rowId];
    if (observed === undefined || observed === null) {
      throw new Error(`${row.rowId}:row missing`);
    }
    for (const column of mapping.columns) {
      if (observed[column] !== row[column]) {
        throw new Error(`${row.rowId}:${column} expected ${JSON.stringify(row[column])}`);
      }
    }
  }
  return { rows: mapping.rows.length, columns: mapping.columns.length };
}

export function mutateMapping(actual, rowId, column) {
  const copy = structuredClone(actual);
  if (copy[rowId] === undefined) throw new Error(`${rowId}:row missing`);
  delete copy[rowId][column];
  return copy;
}

// The executable runner is deliberately independent of docs/SDT-G29-mapping.json.
// Vitest obtains the same observations from the real TypeScript session and
// bridge; this portable runner keeps a small adapter-neutral observation for
// the Node-only CI lane instead of copying the expectation artifact.
export function observePortableMappingContract() {
  const rows = [
    ["event-payload", ["event payload", "V1 eventCandidates[].payload (base64 JSON); stored payload is lossless JSON", "registered event definition schema", "event.make(payload) and event.create(payload)", "JsonValue payload without runtime brands", "event definition version, default 1", "caller-selected eventPayloadVersion"]],
    ["business-time", ["business time", "DecisionLog.now / command candidate now", "single command execution clock capture", "context.now()", "FixedNow (string | number | bigint)", "one value for every retry attempt", "allocator time used as business time"]],
    ["canonical-identity", ["canonical identity", "eventPayloadName:decimalVersion", "registered domain definition at commit admission", "event.eventType", "eventType string", "name-local decimal version", "identity derived from eventId or payload sniffing"]],
    ["event-id", ["eventId", "StoredEvent.eventId / downstream envelope eventId", "allocator and commit admission", "absent from authoring decision", "optional transport metadata only", "G27 runtime identity", "authoring command manufactures eventId"]],
    ["suid", ["SUID", "StoredEvent.suid / receipt key", "OrderClock allocator", "absent from authoring decision", "optional transport metadata only", "monotone allocated ordinal", "business clock or client ordinal as SUID"]],
    ["tags", ["tags", "eventCandidates[].tags and stored eventTags", "event definition tag deriver", "event.tags(payload)", "readonly Tag[] with family/value/id", "derived once and preserved per hop", "re-derived tags from mutable payload after append"]],
    ["state", ["state", "tag-state payload and materialized row", "projector state union", "projector.validateState / projector handlers", "JSON-serializable discriminated state", "projector definition version", "unvalidated arbitrary state cast"]],
    ["projector", ["projector", "tagProjector and projector version", "registered projector definition", "projector(id, tag family, events)", "projector id/version descriptor", "positive projector version", "projector inferred from payload discriminator"]],
    ["command-input", ["command input", "V1 request commandId/input", "command input schema", "command.parseInput", "validated JSON input", "command definition id", "handler-side unchecked object cast"]],
    ["read-set", ["read-set", "consistencyTags and candidate read claims", "command reads declaration", "read/readSet/readExists", "immutable per-tag head claims", "one claim per declared projector/tag cell", "undeclared snapshot read"]],
    ["decision-log", ["DecisionLog", "internal diagnostic only; never V1 body", "session lifecycle", "executeCommand session log", "now, staged events, read claims, terminal decision", "schemaVersion 1", "eventId/SUID allocation fields"]],
    ["terminal-outcome", ["terminal outcome", "committed/noop/rejected/typed conflict", "command decision plus commit port", "done/none/reject", "discriminated outcome union", "V1-compatible result mapping", "silent fallback from typed reject"]],
    ["view-descriptor", ["view descriptor", "tagProjector/query view identity; no V1 shape change", "domain view registration and deployment policy", "domain.views entry", "id/source/projector/deliveryClass descriptor", "descriptor schemaVersion 1", "global deployment variable overriding a view"]],
  ];
  return Object.fromEntries(rows.map(([rowId, values]) => [rowId, Object.fromEntries(requiredColumns.map((column, index) => [column, values[index]]))]));
}

export function runSelfTest() {
  const mapping = loadMapping();
  const actual = observePortableMappingContract();
  assertMappingContract(actual, mapping);
  let failed = false;
  try {
    assertMappingContract(mutateMapping(actual, "canonical-identity", "owner"), mapping);
  } catch (error) {
    failed = String(error).includes("canonical-identity:owner");
  }
  if (!failed) throw new Error("mapping mutation did not fail at canonical-identity:owner");
  return { rows: mapping.rows.length, columns: mapping.columns.length, mutation: "canonical-identity:owner" };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.SDT_G29_MAPPING_FORCE_FAILURE === "1") throw new Error("SDT-G29 mapping forced-red proof");
  console.log(JSON.stringify(runSelfTest(), null, 2));
}
