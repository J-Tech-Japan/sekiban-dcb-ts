#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve(process.cwd(), "docs/SDT-G29-delivery-matrix.json");
const required = [
  "immediate-enabled-allowed",
  "immediate-enabled-not-allowed",
  "immediate-disabled-allowed",
  "immediate-disabled-not-allowed",
  "queued-enabled-allowed",
  "queued-enabled-not-allowed",
  "queued-disabled-allowed",
  "queued-disabled-not-allowed",
];

export function loadDeliveryMatrix(read = (file) => readFileSync(file, "utf8")) {
  const value = JSON.parse(read(path));
  if (value.schemaVersion !== 1 || !Array.isArray(value.rows) || value.rows.length !== required.length) throw new Error("G29 delivery matrix schema invalid");
  const ids = value.rows.map((row) => row?.rowId);
  if (JSON.stringify(ids) !== JSON.stringify(required)) throw new Error("G29 delivery matrix row order changed");
  return value;
}

export function assertDeliveryMatrix(actual, expected = loadDeliveryMatrix()) {
  for (const row of expected.rows) {
    const value = actual[row.rowId];
    if (JSON.stringify(value?.descriptor) !== JSON.stringify(row.expectedDescriptor)) throw new Error(`${row.rowId}:descriptor`);
    if (value?.status !== row.expectedStatus) throw new Error(`${row.rowId}:status`);
    if (value?.reason !== row.expectedReason) throw new Error(`${row.rowId}:reason`);
    if (JSON.stringify(value.views) !== JSON.stringify(row.expectedViews)) throw new Error(`${row.rowId}:views`);
    if (value?.directInvocations !== row.directInvocations) throw new Error(`${row.rowId}:directInvocations`);
    if (value?.queueInvocations !== row.queueInvocations) throw new Error(`${row.rowId}:queueInvocations`);
  }
  return { rows: expected.rows.length };
}

export function runSelfTest() {
  const matrix = loadDeliveryMatrix();
  const actual = Object.fromEntries(matrix.rows.map((row) => [row.rowId, {
    descriptor: row.expectedDescriptor,
    status: row.expectedStatus,
    reason: row.expectedReason,
    views: row.expectedViews,
    directInvocations: row.directInvocations,
    queueInvocations: row.queueInvocations,
  }]));
  assertDeliveryMatrix(actual, matrix);
  let failed = false;
  try { assertDeliveryMatrix({ ...actual, "immediate-enabled-allowed": { ...actual["immediate-enabled-allowed"], views: ["ReservationProjector"] } }, matrix); } catch (error) { failed = String(error).includes("immediate-enabled-allowed:views"); }
  if (!failed) throw new Error("G29 delivery policy mutation did not fail");
  return { rows: matrix.rows.length, mutation: "immediate-enabled-allowed:views" };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.SDT_G29_DELIVERY_FORCE_FAILURE === "1") throw new Error("SDT-G29 delivery matrix forced-red proof");
  console.log(JSON.stringify(runSelfTest(), null, 2));
}
