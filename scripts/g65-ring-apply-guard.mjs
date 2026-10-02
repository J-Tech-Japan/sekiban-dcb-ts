#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const sourcePath = "samples/meeting-room/src/worker.cloudflare-receiver-support.ts";
const ringImplementationPath = "packages/dcb-runtime/src/diagnostics/G65DirectRing.ts";

function fail(message) {
  throw new Error(`SDT-G65 RING/APPLY check failed: ${message}`);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  return startIndex < 0 ? "" : source.slice(startIndex, endIndex < 0 ? source.length : endIndex);
}

function replaceOnce(source, from, to, label) {
  const count = source.split(from).length - 1;
  if (count !== 1) fail(`${label} anchor expected once, found ${count}`);
  return source.replace(from, to);
}

function wiring(source) {
  const missing = [];
  const delivery = between(source, "export async function deliverMeetingRoomDoorbell(", "async function applyMeetingRoomDoorbell(");
  const ring = between(source, "async function ringMeetingRoomDoorbell(", "async function applyG65DirectRing(");
  const apply = between(source, "async function applyG65DirectRing(", "function waitForTestFaultBarrier(");
  if (!source.includes("G65_DIRECT_RING_BUDGET_MS")) missing.push("bounded direct ring budget");
  if (!delivery.includes("return ringMeetingRoomDoorbell(env, ctx, message, config)")) missing.push("receiver enters the ring path");
  if (!ring.includes("recordG65DirectRing(pipelineD1(env)!, message, ringStartedAt)")) missing.push("durable receiver ring");
  if (!ring.includes("ctx.waitUntil(apply.catch")) missing.push("receiver apply is waitUntil-backed");
  if (ring.includes("await applyG65DirectRing(")) missing.push("ring awaits the full apply");
  if (!apply.includes("readG65DirectRing(pipelineD1(env)!, fallbackMessage)")) missing.push("apply reads retained ring bytes");
  if (!apply.includes("markG65DirectApplyStarted") || !apply.includes("markG65DirectApplyFinished")) missing.push("apply ledger boundaries");
  if (!apply.includes("classifyG65DirectApplyOutcome(result, config)")) missing.push("apply classifies selected unsafe view outcomes");
  if (apply.includes('const outcome = result.fastDisposition === "failed"')) missing.push("apply trusts aggregate full-core disposition");
  if (!apply.includes("failureId:")) missing.push("failure IDs/classes are recorded");
  if (!read(ringImplementationPath).includes("G65_DIRECT_RING_BUDGET_MS = 100")) missing.push("100 ms ring budget");
  return { ok: missing.length === 0, missing };
}

function assertRed(label, operation) {
  try {
    operation();
  } catch (error) {
    return { label, result: "red", reason: String(error instanceof Error ? error.message : error) };
  }
  fail(`${label} unexpectedly passed`);
}

function main() {
  const source = read(sourcePath);
  const current = wiring(source);
  if (!current.ok) fail(current.missing.join(", "));

  const awaitedApplyMutant = replaceOnce(
    source,
    "ctx.waitUntil(apply.catch((error) => {",
    "await applyG65DirectRing(env, ctx, message, config); ctx.waitUntil(Promise.resolve().catch((error) => {",
    "awaited-apply",
  );
  const aggregateDispositionMutant = replaceOnce(
    source,
    "const outcome = classifyG65DirectApplyOutcome(result, config);",
    'const outcome = result.fastDisposition === "failed" ? "failed" : classifyG65DirectApplyOutcome(result, config);',
    "aggregate-disposition",
  );
  const mutants = [
    assertRed("awaited-apply", () => {
      const result = wiring(awaitedApplyMutant);
      if (!result.ok) throw new Error(result.missing.join(", "));
    }),
    assertRed("aggregate-disposition", () => {
      const result = wiring(aggregateDispositionMutant);
      if (!result.ok) throw new Error(result.missing.join(", "));
    }),
  ];
  process.stdout.write(`${JSON.stringify({ check: "g65-ring-apply", baseline: "pass", mutants, mode: process.argv.includes("--self-test") ? "self-test" : "run" })}\n`);
}

main();
