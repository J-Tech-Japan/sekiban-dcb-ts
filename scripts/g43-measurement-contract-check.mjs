#!/usr/bin/env node
/**
 * Packet-owned AC8 decision checker. The executable measurement lives in the
 * Miniflare test; this checker supplies an independent, fail-closed oracle for
 * the all-points and range-plan rules and proves their boundary mutations.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const spec = JSON.parse(readFileSync(resolve(root, "contracts/g43-measurement-spec.json"), "utf8"));

function fail(message) {
  throw new Error(`G43 measurement contract failed: ${message}`);
}

function pointKey(point) {
  return `${point.operation}\u0000${point.historySize}\u0000${point.metric}`;
}

export function assertCompleteGrid(rows) {
  const expected = new Set();
  for (const operation of spec.operations) {
    for (const historySize of spec.historySizes) {
      for (const metric of spec.metrics) expected.add(`${operation.id}\u0000${historySize}\u0000${metric}`);
    }
  }
  const actual = new Set();
  for (const row of rows) {
    const key = pointKey(row);
    if (!expected.has(key)) fail(`unexpected measurement row ${key}`);
    if (actual.has(key)) fail(`duplicate measurement row ${key}`);
    const operation = spec.operations.find((candidate) => candidate.id === row.operation);
    if (row.consumer !== (operation.class === "inherently-linear" ? "informational" : "decision")) {
      fail(`wrong consumer for ${key}`);
    }
    actual.add(key);
  }
  if (actual.size !== expected.size || [...expected].some((key) => !actual.has(key))) {
    fail("missing measurement point, including informational rows");
  }
}

export function allPointsWithinSpread(values, allowedSpread) {
  if (!Array.isArray(values) || values.length !== spec.historySizes.length) fail("bounded series has the wrong number of history points");
  return Math.max(...values) - Math.min(...values) <= allowedSpread;
}

export function readAfterWithinOverhead(rowsRead, returnedRows) {
  return rowsRead <= returnedRows + spec.decisionRules.proportionalToResult.constantOverhead;
}

export function acceptsRangePlan(details, indexIdentity) {
  const search = new RegExp(`\\bSEARCH\\s+tag_event\\s+USING\\s+(?:COVERING\\s+)?INDEX\\s+${indexIdentity}\\b`, "i");
  const scan = /\bSCAN\s+tag_event\b/i;
  return details.some((detail) => search.test(detail)) && !details.some((detail) => scan.test(detail));
}

function fullSyntheticGrid() {
  return spec.operations.flatMap((operation) => spec.historySizes.flatMap((historySize) => spec.metrics.map((metric) => ({
    operation: operation.id,
    historySize,
    metric,
    value: 0,
    consumer: operation.class === "inherently-linear" ? "informational" : "decision",
  }))));
}

export function verifyMeasurementContract() {
  if (spec.schemaVersion !== 2 || spec.owner !== "SDT-G43") fail("wrong packet-owned measurement spec identity");
  if (spec.collection.repetitionsPerPoint !== 3 || spec.collection.aggregate !== "median") fail("unexpected collection contract");
  if (spec.decisionRules.bounded.allowedSpread.rowsRead !== 2 || spec.decisionRules.proportionalToResult.constantOverhead !== 4) {
    fail("unexpected literal decision thresholds");
  }
  assertCompleteGrid(fullSyntheticGrid());
  return { result: "measurement-spec-v2-check-passed", points: spec.operations.length * spec.historySizes.length * spec.metrics.length };
}

function selfTest() {
  const spread = spec.decisionRules.bounded.allowedSpread.rowsRead;
  if (!allPointsWithinSpread([100, 100 + spread, 100, 100, 100], spread)) fail("exact-bound pass mutation failed");
  for (const values of [
    [100, 100 + spread + 1, 100, 100, 100],
    [100, 100 + spread + 1, 100 + spread + 1, 100 + spread + 1, 1],
    [100, 100, 100, 100 + spread + 1, 100],
  ]) {
    if (allPointsWithinSpread(values, spread)) fail("intermediate bounded-growth mutation was accepted");
  }
  if (!readAfterWithinOverhead(50 + 4, 50)) fail("exact proportional boundary was rejected");
  if (readAfterWithinOverhead(50 + 5, 50)) fail("over-bound proportional mutation was accepted");
  if (!acceptsRangePlan(["SEARCH tag_event USING INDEX tag_event_suid_idx (suid>?)"], "tag_event_suid_idx")) {
    fail("exact index plan was rejected");
  }
  if (acceptsRangePlan(["SCAN tag_event"], "tag_event_suid_idx")) fail("SCAN plan mutation was accepted");
  const missing = fullSyntheticGrid().slice(0, -spec.metrics.length);
  try {
    assertCompleteGrid(missing);
    fail("missing informational rows mutation was accepted");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("missing measurement point")) throw error;
  }
  process.stdout.write(`${JSON.stringify({ selfTest: "all-boundaries-red", ...verifyMeasurementContract() })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  process.stdout.write(`${JSON.stringify(verifyMeasurementContract())}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
