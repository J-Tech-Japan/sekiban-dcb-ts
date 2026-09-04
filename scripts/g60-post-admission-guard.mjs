#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const stages = [
  "post-record-delivery-global-receipt-readback",
  "source-tag-acknowledgement",
  "completeness-coverage",
  "detector",
  "unsafe-view-apply",
];
const views = ["RoomProjector", "ReservationProjector"];
const boundaries = ["start", "end"];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function sourceWiring() {
  const required = [
    ["packages/dcb-runtime/src/diagnostics/G60DurableHop.ts", "post-admission observer module"],
    ["migrations/d1/g32/0007_g60_post_admission_decomposition.sql", "post-admission migration"],
    ["packages/dcb-runtime/src/downstream/DeliveryCore.ts", "delivery-core boundaries"],
    ["packages/dcb-runtime/src/downstream/DownstreamAdapter.ts", "adapter boundaries"],
    ["test/helpers/g44-d1-migration.ts", "test migration wiring"],
    ["test/d1-pipeline.spec.ts", "D1 oracle coverage"],
  ];
  const missing = required.filter(([relativePath]) => !fs.existsSync(path.join(root, relativePath)));
  if (missing.length > 0) return { ok: false, missing: missing.map(([, label]) => label) };
  const checks = [
    ["packages/dcb-runtime/src/diagnostics/G60DurableHop.ts", "G60_POST_ADMISSION_STAGES"],
    ["packages/dcb-runtime/src/diagnostics/G60DurableHop.ts", "recordDurableHopSubstep"],
    ["packages/dcb-runtime/src/diagnostics/G60DurableHop.ts", "observeSubstep"],
    ["packages/dcb-runtime/src/diagnostics/G60DurableHop.ts", "waitUntil(write)"],
    ["migrations/d1/g32/0007_g60_post_admission_decomposition.sql", "serialized_dcb_hop_submeasurements"],
    ["packages/dcb-runtime/src/downstream/DeliveryCore.ts", "post-record-delivery-global-receipt-readback"],
    ["packages/dcb-runtime/src/downstream/DeliveryCore.ts", "unsafe-view-apply"],
    ["packages/dcb-runtime/src/downstream/DownstreamAdapter.ts", "source-tag-acknowledgement"],
    ["packages/dcb-runtime/src/downstream/DownstreamAdapter.ts", "completeness-coverage"],
    ["packages/dcb-runtime/src/cloudflare.ts", "recordDurableHopSubstep"],
  ];
  const absent = checks.filter(([relativePath, needle]) => !read(relativePath).includes(needle));
  return absent.length === 0
    ? { ok: true, missing: [] }
    : { ok: false, missing: absent.map(([, needle]) => needle) };
}

function key(record) {
  return `${record.stage}|${record.boundary}|${record.viewId ?? ""}`;
}

function expectedKeys() {
  return stages.flatMap((stage) => {
    const targets = stage === "unsafe-view-apply" ? views : [""];
    return targets.flatMap((viewId) => boundaries.map((boundary) => `${stage}|${boundary}|${viewId}`));
  });
}

function assertComplete(records) {
  const expectedKeysList = expectedKeys();
  if (!Array.isArray(records) || records.length !== expectedKeysList.length) {
    throw new Error(`expected exactly ${expectedKeysList.length} post-admission boundaries`);
  }
  const identity = records[0];
  if (identity === undefined) throw new Error("post-admission identity is missing");
  const seen = new Set();
  let previousOrdinal = -1;
  let previousObservedAt = -Infinity;
  let unsafeViewEndSeen = false;
  const unsafeViewStarts = new Set();
  const unsafeViewEnds = new Set();
  for (const record of records) {
    if (record === null || typeof record !== "object") throw new Error("post-admission record is not an object");
    for (const field of ["serviceId", "eventId", "suid", "attemptId", "stage", "boundary", "outcome"]) {
      if (typeof record[field] !== "string" || record[field].length === 0) throw new Error(`post-admission record is missing ${field}`);
    }
    if (!Number.isSafeInteger(record.observedAt) || record.observedAt < 0) {
      throw new Error("post-admission timestamp is not a non-negative safe integer");
    }
    for (const field of ["serviceId", "eventId", "suid", "attemptId"]) {
      if (record[field] !== identity[field]) throw new Error(`post-admission correlation changed at ${record.stage}: ${field}`);
    }
    if (!stages.includes(record.stage)) throw new Error(`unknown post-admission stage: ${record.stage}`);
    if (!boundaries.includes(record.boundary)) throw new Error(`unknown post-admission boundary: ${record.boundary}`);
    if (record.stage === "unsafe-view-apply" && !views.includes(record.viewId)) {
      throw new Error(`unknown unsafe view: ${record.viewId}`);
    }
    if (record.stage !== "unsafe-view-apply" && (record.viewId ?? "") !== "") {
      throw new Error(`non-view stage has view identity: ${record.stage}`);
    }
    if (record.stage === "source-tag-acknowledgement" && (typeof record.partitionTag !== "string" || record.partitionTag.length === 0)) {
      throw new Error("source acknowledgement is missing partitionTag");
    }
    if (seen.has(key(record))) throw new Error(`duplicate post-admission boundary: ${key(record)}`);
    seen.add(key(record));
    const stageOrdinal = stages.indexOf(record.stage);
    if (record.stage === "unsafe-view-apply") {
      if (record.boundary === "start") {
        if (unsafeViewEndSeen) throw new Error(`post-admission view start followed an end at ${key(record)}`);
        unsafeViewStarts.add(record.viewId);
      } else {
        if (!unsafeViewStarts.has(record.viewId)) throw new Error(`post-admission view end preceded its start at ${key(record)}`);
        unsafeViewEndSeen = true;
        unsafeViewEnds.add(record.viewId);
      }
    } else {
      const boundaryOrdinal = boundaries.indexOf(record.boundary);
      const ordinal = stageOrdinal * 100 + boundaryOrdinal;
      if (ordinal < previousOrdinal) throw new Error(`post-admission order regressed at ${key(record)}`);
      previousOrdinal = ordinal;
    }
    if (record.observedAt < previousObservedAt) throw new Error(`post-admission timestamp regressed at ${key(record)}`);
    previousObservedAt = record.observedAt;
    if (record.boundary === "start" && record.outcome !== "started") {
      throw new Error(`start boundary has unexpected outcome: ${key(record)}`);
    }
    if (record.boundary === "end" && record.outcome === "started") {
      throw new Error(`end boundary has no outcome: ${key(record)}`);
    }
  }
  for (const expected of expectedKeysList) {
    if (!seen.has(expected)) throw new Error(`missing post-admission boundary: ${expected}`);
  }
  for (const viewId of views) {
    if (!unsafeViewStarts.has(viewId) || !unsafeViewEnds.has(viewId)) throw new Error(`missing unsafe-view boundary: ${viewId}`);
  }
  return {
    status: "green",
    boundaryCount: records.length,
    identity: {
      serviceId: identity.serviceId,
      eventId: identity.eventId,
      suid: identity.suid,
      attemptId: identity.attemptId,
    },
  };
}

function fixture() {
  const identity = {
    serviceId: "g60-post-admission-guard",
    eventId: "event-1",
    suid: "000000000000000000000000000001",
    attemptId: "attempt-1",
    partitionTag: "reservation:guard",
    transport: "queue",
  };
  let observedAt = 1000;
  return stages.flatMap((stage) => {
    if (stage === "unsafe-view-apply") {
      return [
        ...views.map((viewId) => ({ ...identity, stage, boundary: "start", outcome: "started", viewId, observedAt: observedAt++ })),
        ...views.map((viewId) => ({ ...identity, stage, boundary: "end", outcome: "applied", viewId, observedAt: observedAt++ })),
      ];
    }
    return boundaries.map((boundary) => ({
      ...identity,
      stage,
      boundary,
      outcome: boundary === "start" ? "started" : stage === "completeness-coverage" ? "SETTLED" : "applied",
      viewId: "",
      observedAt: observedAt++,
    }));
  });
}

function legacyFixture() {
  return [
    "command-receipt",
    "tag-append-committed",
    "outbox-obligation-written",
    "queue-send-returned",
    "consumer-invocation-started",
    "record-delivery-batch-committed",
    "first-unsafe-visible-read",
  ].map((stage, index) => ({
    serviceId: "g60-post-admission-guard",
    eventId: "event-1",
    suid: "000000000000000000000000000001",
    attemptId: "attempt-1",
    stage,
    boundary: "end",
    outcome: "legacy",
    observedAt: index,
  }));
}

function writeReceipt(file, receipt) {
  if (file === undefined) return;
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), `${JSON.stringify(receipt, null, 2)}\n`);
}

const receiptFile = argument("--receipt");
const preChange = process.argv.includes("--pre-change");
if (preChange) {
  let reason;
  try {
    assertComplete(legacyFixture());
    throw new Error("pre-change legacy fixture was accepted");
  } catch (error) {
    reason = String(error instanceof Error ? error.message : error);
  }
  const receipt = {
    guard: "SDT-G60 post-admission decomposition",
    phase: "pre-change",
    status: "red",
    expectedFailure: true,
    reason,
    legacyStageCount: 7,
    requiredBoundaryCount: expectedKeys().length,
    stages,
    views,
  };
  writeReceipt(receiptFile, receipt);
  console.error(JSON.stringify(receipt));
  process.exitCode = 1;
} else {
  const wiring = sourceWiring();
  if (!wiring.ok) {
    const receipt = { guard: "SDT-G60 post-admission decomposition", phase: "post-change", status: "red", expectedFailure: false, reason: `required wiring is absent: ${wiring.missing.join(", ")}`, sourceWiring: wiring, stages, views };
    writeReceipt(receiptFile, receipt);
    console.error(JSON.stringify(receipt));
    process.exitCode = 1;
  } else {
    const green = assertComplete(fixture());
    const omitted = fixture();
    omitted.splice(5, 1);
    let omissionReason;
    try {
      assertComplete(omitted);
      throw new Error("boundary omission mutant was accepted");
    } catch (error) {
      omissionReason = String(error instanceof Error ? error.message : error);
    }
    const reordered = fixture();
    [reordered[6], reordered[7]] = [reordered[7], reordered[6]];
    let reorderReason;
    try {
      assertComplete(reordered);
      throw new Error("boundary reorder mutant was accepted");
    } catch (error) {
      reorderReason = String(error instanceof Error ? error.message : error);
    }
    const receipt = {
      guard: "SDT-G60 post-admission decomposition",
      phase: "post-change",
      status: "green",
      expectedFailure: false,
      green,
      redMutants: {
        omission: { status: "red", expectedFailure: true, reason: omissionReason },
        reorder: { status: "red", expectedFailure: true, reason: reorderReason },
      },
      sourceWiring: wiring,
      stages,
      views,
    };
    writeReceipt(receiptFile, receipt);
    console.log(JSON.stringify(receipt));
  }
}
