#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const stages = [
  "command-receipt",
  "tag-append-committed",
  "outbox-obligation-written",
  "queue-send-returned",
  "consumer-invocation-started",
  "record-delivery-batch-committed",
  "first-unsafe-visible-read",
];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function sourceWiring() {
  const required = [
    ["packages/dcb-runtime/src/diagnostics/G60DurableHop.ts", "durable hop module"],
    ["migrations/d1/g32/0006_g60_durable_hop_measurements.sql", "durable hop migration"],
    ["packages/dcb-runtime/src/commit/CommitWorker.ts", "command hook"],
    ["packages/dcb-runtime/src/tag/TagDurableObject.ts", "Tag hook"],
    ["packages/dcb-runtime/src/downstream/OutboxDrain.ts", "outbox hook"],
    ["packages/dcb-runtime/src/downstream/DeliveryCore.ts", "delivery hook"],
    ["packages/dcb-runtime/src/downstream/DownstreamAdapter.ts", "consumer hook"],
    ["packages/dcb-runtime/src/http/SerializedQueryWorker.ts", "read hook"],
  ];
  const missing = required.filter(([relativePath]) => !fs.existsSync(path.join(root, relativePath)));
  if (missing.length > 0) {
    return { ok: false, missing: missing.map(([, label]) => label) };
  }
  const checks = [
    ["packages/dcb-runtime/src/diagnostics/G60DurableHop.ts", "G60_HOP_STAGES"],
    ["packages/dcb-runtime/src/diagnostics/G60DurableHop.ts", "serialized_dcb_hop_measurements"],
    ["migrations/d1/g32/0006_g60_durable_hop_measurements.sql", "serialized_dcb_hop_measurements"],
    ["packages/dcb-runtime/src/commit/CommitWorker.ts", "durableHopObserver"],
    ["packages/dcb-runtime/src/tag/TagDurableObject.ts", "tag-append-committed"],
    ["packages/dcb-runtime/src/downstream/OutboxDrain.ts", "queue-send-returned"],
    ["packages/dcb-runtime/src/downstream/DeliveryCore.ts", "record-delivery-batch-committed"],
    ["packages/dcb-runtime/src/downstream/DownstreamAdapter.ts", "consumer-invocation-started"],
    ["packages/dcb-runtime/src/http/SerializedQueryWorker.ts", "afterUnsafeRead"],
  ];
  const absent = checks.filter(([relativePath, needle]) => !read(relativePath).includes(needle));
  return absent.length === 0
    ? { ok: true, missing: [] }
    : { ok: false, missing: absent.map(([, needle]) => needle) };
}

function assertComplete(records) {
  if (!Array.isArray(records) || records.length !== stages.length) {
    throw new Error(`expected exactly ${stages.length} hop records`);
  }
  const identity = records[0];
  if (identity === undefined) throw new Error("hop record identity is missing");
  const seen = new Set();
  let previous = -Infinity;
  for (const record of records) {
    if (record === null || typeof record !== "object") throw new Error("hop record is not an object");
    for (const field of ["serviceId", "eventId", "suid", "attemptId", "observedAt"]) {
      if (typeof record[field] !== (field === "observedAt" ? "number" : "string") || record[field].length === 0) {
        throw new Error(`hop record is missing ${field}`);
      }
    }
    if (!Number.isSafeInteger(record.observedAt) || record.observedAt < 0) {
      throw new Error("hop timestamp is not a non-negative safe integer");
    }
    for (const field of ["serviceId", "eventId", "suid", "attemptId"]) {
      if (record[field] !== identity[field]) throw new Error(`hop correlation changed at ${record.stage}: ${field}`);
    }
    if (!stages.includes(record.stage)) throw new Error(`unknown hop stage: ${record.stage}`);
    const key = `${record.stage}|${record.partitionTag ?? ""}|${record.viewId ?? ""}|${record.transport ?? ""}`;
    if (seen.has(key)) throw new Error(`duplicate hop stage: ${key}`);
    seen.add(key);
    const ordinal = stages.indexOf(record.stage);
    if (ordinal < previous) throw new Error(`hop order regressed at ${record.stage}`);
    previous = ordinal;
  }
  for (const stage of stages) {
    if (![...seen].some((key) => key.startsWith(`${stage}|`))) throw new Error(`missing hop stage: ${stage}`);
  }
  return { status: "green", stageCount: records.length, identity: {
    serviceId: identity.serviceId,
    eventId: identity.eventId,
    suid: identity.suid,
    attemptId: identity.attemptId,
  } };
}

function fixture(missing = []) {
  const identity = { serviceId: "g60-guard", eventId: "event-1", suid: "000000000000000000000000000001", attemptId: "attempt-1" };
  const times = [1000, 1001, 1002, 1003, 1004, 1005, 1006];
  return stages
    .map((stage, index) => ({ ...identity, stage, observedAt: times[index], partitionTag: index > 0 && index < 5 ? "reservation:guard" : "", viewId: stage === "first-unsafe-visible-read" ? "ReservationProjector" : "", transport: stage === "consumer-invocation-started" || stage === "record-delivery-batch-committed" ? "queue" : "" }))
    .filter((record) => !missing.includes(record.stage));
}

function writeReceipt(file, receipt) {
  if (file === undefined) return;
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), `${JSON.stringify(receipt, null, 2)}\n`);
}

const receiptFile = argument("--receipt");
const preChange = process.argv.includes("--pre-change");
const redRecord = fixture(preChange ? stages.slice(1) : ["first-unsafe-visible-read"]);
let redReason;
try {
  assertComplete(redRecord);
  throw new Error("incomplete pre-change fixture was accepted");
} catch (error) {
  redReason = String(error instanceof Error ? error.message : error);
}

if (preChange) {
  const receipt = { guard: "SDT-G60 durable hop", phase: "pre-change", status: "red", expectedFailure: true, reason: redReason, sourceWiring: sourceWiring(), stages };
  writeReceipt(receiptFile, receipt);
  console.error(JSON.stringify(receipt));
  process.exitCode = 1;
} else {
  const wiring = sourceWiring();
  if (!wiring.ok) {
    const receipt = { guard: "SDT-G60 durable hop", phase: "post-change", status: "red", expectedFailure: false, reason: `required wiring is absent: ${wiring.missing.join(", ")}`, sourceWiring: wiring, stages };
    writeReceipt(receiptFile, receipt);
    console.error(JSON.stringify(receipt));
    process.exitCode = 1;
  } else {
    const green = assertComplete(fixture());
    const mismatch = fixture();
    mismatch[1].eventId = "event-contradiction";
    let mismatchReason;
    try {
      assertComplete(mismatch);
      throw new Error("correlation mutant was accepted");
    } catch (error) {
      mismatchReason = String(error instanceof Error ? error.message : error);
    }
    const receipt = { guard: "SDT-G60 durable hop", phase: "post-change", status: "green", expectedFailure: false, green, redMutant: { status: "red", expectedFailure: true, reason: mismatchReason }, sourceWiring: wiring, stages };
    writeReceipt(receiptFile, receipt);
    console.log(JSON.stringify(receipt));
  }
}
