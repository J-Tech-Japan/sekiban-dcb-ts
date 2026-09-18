#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const sourcePath = "samples/meeting-room/src/worker.cloudflare-receiver-support.ts";
const ringImplementationPath = "packages/dcb-runtime/src/diagnostics/G65DirectRing.ts";
const preChangeRef = process.env.SDT_G65_RING_PRE_CHANGE_REF ?? "5edfd6413b1ff446e6f7475eef18c947b0ca93fe";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function sourceAtRevision(revision) {
  try {
    return execFileSync("git", ["show", `${revision}:${sourcePath}`], { cwd: root, encoding: "utf8" });
  } catch {
    return "";
  }
}

function writeReceipt(relativePath, receipt) {
  if (relativePath === undefined) return;
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`);
}

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  return startIndex < 0 ? "" : source.slice(startIndex, endIndex < 0 ? source.length : endIndex);
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
  if (apply.includes('const outcome = result.fastDisposition === "failed"')) missing.push("apply ledger trusts aggregate full-core disposition");
  if (!apply.includes("failureId:")) missing.push("DeliveryCore failure IDs/classes are recorded");
  if (!read(ringImplementationPath).includes("G65_DIRECT_RING_BUDGET_MS = 100")) missing.push("100 ms ring budget");
  return { ok: missing.length === 0, missing };
}

function assertRed(label, operation) {
  try {
    operation();
  } catch (error) {
    return {
      label,
      status: "red",
      expectedFailure: true,
      reason: String(error instanceof Error ? error.message : error),
    };
  }
  throw new Error(`${label} unexpectedly passed`);
}

const receiptFile = argument("--receipt");
const selfTest = process.argv.includes("--self-test");
const preChange = process.argv.includes("--pre-change");

if (preChange) {
  const result = assertRed("pre-RING/APPLY receiver source", () => {
    const result = wiring(sourceAtRevision(preChangeRef));
    if (!result.ok) throw new Error(`pre-change source lacks RING/APPLY wiring: ${result.missing.join(", ")}`);
  });
  const receipt = { guard: "SDT-G65 RING/APPLY receiver guard", phase: "pre-change", status: "red", sourceRevision: preChangeRef, red: result };
  writeReceipt(receiptFile, receipt);
  console.error(JSON.stringify(receipt));
  process.exitCode = 1;
} else {
  const source = read(sourcePath);
  const current = wiring(source);
  if (!current.ok) {
    const receipt = { guard: "SDT-G65 RING/APPLY receiver guard", phase: selfTest ? "self-test" : "post-change", status: "red", expectedFailure: false, wiring: current };
    writeReceipt(receiptFile, receipt);
    console.error(JSON.stringify(receipt));
    process.exitCode = 1;
  } else {
    const awaitedApplyMutant = source.replace(
      "ctx.waitUntil(apply.catch((error) => {",
      "await applyG65DirectRing(env, ctx, message, config); ctx.waitUntil(Promise.resolve().catch((error) => {",
    );
    const redMutant = assertRed("awaited-apply mutant", () => {
      const mutant = wiring(awaitedApplyMutant);
      if (!mutant.ok) throw new Error(`mutant detected: ${mutant.missing.join(", ")}`);
    });
    const aggregateDispositionMutant = source.replace(
      "const outcome = classifyG65DirectApplyOutcome(result, config);",
      'const outcome = result.fastDisposition === "failed" ? "failed" : classifyG65DirectApplyOutcome(result, config);',
    );
    const aggregateDispositionRedMutant = assertRed("aggregate full-core disposition mutant", () => {
      const mutant = wiring(aggregateDispositionMutant);
      if (!mutant.ok) throw new Error(`mutant detected: ${mutant.missing.join(", ")}`);
    });
    const receipt = {
      guard: "SDT-G65 RING/APPLY receiver guard",
      phase: selfTest ? "self-test" : "post-change",
      status: "green",
      sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      budgetMs: 100,
      green: current,
      redMutants: { awaitedApply: redMutant, aggregateDisposition: aggregateDispositionRedMutant },
      contract: "the receiver durably rings the immutable envelope before returning; selected independent-unsafe view outcomes determine the direct apply ledger while full-core failures remain diagnostic and Queue remains the durable replay guarantee",
    };
    writeReceipt(receiptFile, receipt);
    console.log(JSON.stringify(receipt));
  }
}
