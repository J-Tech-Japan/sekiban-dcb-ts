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

// The Node runner is a schema/mutation gate only.  The observed values are
// produced by the shared TypeScript fixture in test/g29-mapping.spec.ts for
// both the DO-ts and portable paths.  Keeping the expectation artifact here,
// rather than copying it into a second JavaScript table, makes an artifact
// mutation visible to the real execution assertion.
export function observePortableMappingContract(mapping = loadMapping()) {
  return Object.fromEntries(mapping.rows.map((row) => [row.rowId, { ...row }]));
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
