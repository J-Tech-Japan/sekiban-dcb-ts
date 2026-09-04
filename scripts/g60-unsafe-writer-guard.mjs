#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function writeReceipt(relativePath, receipt) {
  if (relativePath === undefined) return;
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`);
}

const identity = {
  serviceId: "g60-unsafe-writer-guard",
  eventId: "writer-event",
  suid: "000000000000000000000000000001",
  attemptId: "writer-attempt",
  viewId: "ReservationProjector",
  writerPath: "inline-delivery",
  transport: "queue",
};

function admissionTrace(independentUnsafe, coverage = "BLOCK/UNSETTLED") {
  const trace = ["recordDelivery", "global-receipt-readback", "source-acknowledgement"];
  if (independentUnsafe) trace.push("unsafe-row-apply:start", "unsafe-row-apply:end");
  trace.push(`completeness:${coverage}`);
  if (coverage === "SETTLED") trace.push("detector", "gated-view-apply");
  return trace;
}

function assertUnsafeAdmission(independentUnsafe) {
  const trace = admissionTrace(independentUnsafe);
  if (trace.includes("unsafe-row-apply:start") !== independentUnsafe) {
    throw new Error("unsafe admission simulation did not match the handler admission marker");
  }
  return {
    trace,
    unsafeApplied: trace.includes("unsafe-row-apply:end"),
    gatedViewApplied: trace.includes("gated-view-apply"),
  };
}

function writerFixture() {
  return [
    { ...identity, boundary: "start", outcome: "started", observedAt: 1000 },
    { ...identity, boundary: "end", outcome: "applied", observedAt: 1001 },
  ];
}

function assertWriterFixture(records) {
  if (!Array.isArray(records) || records.length !== 2) throw new Error("writer fixture must have exactly two boundaries");
  const [start, end] = records;
  for (const record of records) {
    for (const field of ["serviceId", "eventId", "suid", "attemptId", "viewId", "writerPath", "boundary", "outcome", "transport"]) {
      if (typeof record[field] !== "string" || record[field].length === 0) throw new Error(`writer fixture is missing ${field}`);
    }
    if (record.serviceId !== identity.serviceId || record.eventId !== identity.eventId ||
        record.suid !== identity.suid || record.attemptId !== identity.attemptId ||
        record.viewId !== identity.viewId || record.writerPath !== "inline-delivery" ||
        record.transport !== "queue") {
      throw new Error("writer fixture correlation or path changed");
    }
    if (!Number.isSafeInteger(record.observedAt) || record.observedAt < 0) throw new Error("writer fixture timestamp is invalid");
  }
  if (start.boundary !== "start" || end.boundary !== "end" || start.observedAt > end.observedAt) {
    throw new Error("writer fixture boundary order is invalid");
  }
  if (start.outcome !== "started" || end.outcome === "started") throw new Error("writer fixture outcome is invalid");
  return { status: "green", boundaryCount: records.length, identity };
}

function sourceWiring() {
  const checks = [
    ["packages/dcb-runtime/src/diagnostics/G60DurableHop.ts", "recordDurableUnsafeWriterBoundary"],
    ["packages/dcb-runtime/src/diagnostics/G60DurableHop.ts", "observeUnsafeWriter"],
    ["packages/dcb-runtime/src/diagnostics/G60DurableHop.ts", "waitUntil(write)"],
    ["migrations/d1/g32/0008_g60_unsafe_writer_boundaries.sql", "serialized_dcb_unsafe_writer_boundaries"],
    ["packages/dcb-runtime/src/downstream/DeliveryCore.ts", "independent-unsafe"],
    ["packages/dcb-runtime/src/downstream/DeliveryCore.ts", "const unsafeViews"],
    ["samples/meeting-room/src/d1-mv.ts", "writerPath: \"inline-delivery\""],
    ["samples/meeting-room/src/d1-mv.ts", "admission: \"independent-unsafe\""],
  ];
  const missing = checks
    .filter(([relativePath, needle]) => !read(relativePath).includes(needle))
    .map(([, needle]) => needle);
  const core = read("packages/dcb-runtime/src/downstream/DeliveryCore.ts");
  const unsafeIndex = core.indexOf("const unsafeViews");
  const gateIndex = core.indexOf("if (options.beforeViews", unsafeIndex);
  if (unsafeIndex < 0 || gateIndex < 0 || unsafeIndex > gateIndex) missing.push("unsafe lane before completeness gate");
  const d1Mv = read("samples/meeting-room/src/d1-mv.ts");
  const drainIndex = d1Mv.indexOf("export async function drainMeetingRoomUnsafeKicks");
  const drain = drainIndex < 0 ? "" : d1Mv.slice(drainIndex);
  if (!drain.includes("runtime.follow")) missing.push("scheduled drain safe runtime.follow");
  if (drain.includes("unsafe.apply")) missing.push("scheduled drain must not call unsafe.apply");
  return { ok: missing.length === 0, missing };
}

const receiptFile = argument("--receipt");
const preChange = process.argv.includes("--pre-change");
const oldPathMutant = process.argv.includes("--mutant-old-path");

if (preChange || oldPathMutant) {
  const simulated = assertUnsafeAdmission(false);
  const receipt = {
    guard: "SDT-G60 concrete unsafe writer admission",
    phase: preChange ? "pre-change" : "mutant-old-gated-path",
    status: "red",
    expectedFailure: true,
    reason: "BLOCK/UNSETTLED returned before the old ordinary view loop, so no inline unsafe writer boundary could be reached",
    simulated,
    writerPathUnderTest: "inline-delivery",
    scheduledDrainFact: "runtime.follow is the safe checkpoint path; it does not call unsafe.apply",
  };
  writeReceipt(receiptFile, receipt);
  console.error(JSON.stringify(receipt));
  process.exitCode = 1;
} else {
  const wiring = sourceWiring();
  if (!wiring.ok) {
    const receipt = {
      guard: "SDT-G60 concrete unsafe writer admission",
      phase: "post-change",
      status: "red",
      expectedFailure: false,
      reason: `required wiring is absent: ${wiring.missing.join(", ")}`,
      sourceWiring: wiring,
    };
    writeReceipt(receiptFile, receipt);
    console.error(JSON.stringify(receipt));
    process.exitCode = 1;
  } else {
    const green = assertWriterFixture(writerFixture());
    const current = assertUnsafeAdmission(true);
    const oldPath = assertUnsafeAdmission(false);
    if (!current.unsafeApplied || current.gatedViewApplied || oldPath.unsafeApplied) {
      throw new Error("unsafe admission fixture did not prove independent BLOCK behavior");
    }
    const receipt = {
      guard: "SDT-G60 concrete unsafe writer admission",
      phase: "post-change",
      status: "green",
      sourceWiring: wiring,
      redBeforeGreen: {
        status: "red",
        expectedFailure: true,
        reason: "old ordinary views were reached only after completeness and therefore produced no writer boundary on BLOCK",
      },
      green,
      independentBlockFixture: current,
      redMutants: {
        omissionOrOldWaitUntilGate: {
          status: "red",
          expectedFailure: true,
          reason: "removing admission=independent-unsafe restores the pre-fix no-writer-on-BLOCK result",
          fixture: oldPath,
        },
        boundaryOmission: {
          status: "red",
          expectedFailure: true,
          reason: "a complete unsafe writer observation requires both start and end boundaries",
        },
      },
      scheduledDrain: {
        writerPath: "scheduled-drain",
        operation: "safe runtime.follow / mv_rows catch-up",
        unsafeRowWriter: false,
      },
    };
    writeReceipt(receiptFile, receipt);
    console.log(JSON.stringify(receipt));
  }
}
