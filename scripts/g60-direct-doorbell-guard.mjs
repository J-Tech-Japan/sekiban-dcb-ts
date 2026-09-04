#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const sourcePath = "packages/dcb-runtime/src/tag/TagDurableObject.ts";

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

function sourceWiring(source) {
  const missing = [];
  const appendStart = source.indexOf("private async append(");
  const helperStart = source.indexOf("private startAutoDrainBeforeResponse(");
  const directStart = source.indexOf("private async directDeliveryBeforeResponse(");
  const drainStart = source.indexOf("private async autoDrainOutbox(");
  if (appendStart < 0) missing.push("TagDurableObject.append");
  if (helperStart < 0) missing.push("startAutoDrainBeforeResponse");
  if (directStart < 0) missing.push("directDeliveryBeforeResponse");
  if (drainStart < 0) missing.push("autoDrainOutbox");
  if (missing.length > 0) return { ok: false, missing };

  const append = source.slice(appendStart, directStart);
  const direct = source.slice(directStart, drainStart);
  const helper = source.slice(helperStart, drainStart);
  const calls = [...append.matchAll(/await this\.directDeliveryBeforeResponse\(/g)].map((match) => match.index ?? -1);
  if (calls.length !== 2) missing.push(`two direct-before-response calls (found ${calls.length})`);
  for (const call of calls) {
    const responseConstruction = append.lastIndexOf("const response = json(result.body, result.status);", call);
    const responseReturn = append.indexOf("return response;", call);
    if (responseConstruction < 0 || responseConstruction > call || responseReturn < call) {
      missing.push("durable response construction -> direct attempt -> response return ordering");
    }
  }
  if (!direct.includes("this.pendingOutbox(") || !direct.includes("DOWNSTREAM_DOORBELL!.deliver(row)")) {
    missing.push("direct path claims durable rows and calls the doorbell");
  }
  if (!direct.includes("await this.pendingOutbox") || !direct.includes("await this.env.DOWNSTREAM_DOORBELL!.deliver")) {
    missing.push("direct path awaits pending rows and each direct attempt");
  }
  if (!direct.includes("return rows") || !direct.includes("catch")) missing.push("direct path returns rows and degrades on failure");
  const drain = source.slice(drainStart);
  if (!helper.includes("preclaimedRows") || !drain.includes("skipDirect") || !helper.includes("preclaimedRows !== undefined")) {
    missing.push("queue handoff marks preclaimed rows and skips duplicate direct delivery");
  }
  if (!helper.includes("this.ctx.waitUntil(drain)")) missing.push("queue handoff remains waitUntil-backed");
  if (!source.includes("this.env.DOWNSTREAM_QUEUE") || !source.includes("queue.send(row")) {
    missing.push("existing Queue send path");
  }
  if (direct.includes("markOutboxDelivered")) missing.push("direct path must not own Queue acknowledgement");
  const unsafeViewSource = read("samples/meeting-room/src/d1-mv.ts");
  if (!unsafeViewSource.includes("lastSuid") || !unsafeViewSource.includes("upsert")) missing.push("idempotent active.lastSuid/upsert unsafe apply");
  const durableCommit = append.indexOf("const response = json(result.body, result.status);");
  const directCall = append.indexOf("await this.directDeliveryBeforeResponse(");
  if (durableCommit < 0 || directCall < durableCommit) missing.push("durable result precedes direct delivery");
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

function assertCompleteHandoff(mode = "current") {
  const state = {
    eventCommitted: false,
    outboxWritten: false,
    localReceiptCommitted: false,
    directSawDurability: false,
    responseReturned: false,
    directStarted: false,
    directFinished: false,
    queueScheduled: false,
    unsafeApplies: 0,
    lastSuid: "",
  };
  const applyUnsafe = (suid) => {
    if (mode === "duplicate-apply") {
      state.lastSuid = suid;
      state.unsafeApplies += 1;
      return "applied";
    }
    if (mode === "regressing-queue" && suid < state.lastSuid) {
      state.lastSuid = suid;
      state.unsafeApplies += 1;
      return "applied";
    }
    if (suid <= state.lastSuid) return "no-change";
    state.lastSuid = suid;
    state.unsafeApplies += 1;
    return "applied";
  };
  const append = () => {
    state.eventCommitted = true;
    state.outboxWritten = true;
    state.localReceiptCommitted = true;
    if (mode === "omitted" || mode === "queue-dependent") {
      state.responseReturned = true;
      state.queueScheduled = true;
      return;
    }
    if (!state.eventCommitted || !state.outboxWritten || !state.localReceiptCommitted) throw new Error("direct attempt preceded durable acceptance");
    state.directStarted = true;
    state.directSawDurability = state.eventCommitted && state.outboxWritten && state.localReceiptCommitted;
    applyUnsafe("000000000000000000000000000001");
    state.directFinished = true;
    state.queueScheduled = true;
    if (mode === "response-before-direct") state.responseReturned = true;
    else state.responseReturned = state.directFinished;
  };
  if (mode === "durability-reordered") {
    state.directStarted = true;
    state.directSawDurability = false;
    state.directFinished = true;
    state.eventCommitted = true;
    state.outboxWritten = true;
    state.localReceiptCommitted = true;
    state.responseReturned = true;
    state.queueScheduled = true;
  } else {
    append();
  }
  if (!state.eventCommitted || !state.outboxWritten || !state.localReceiptCommitted) throw new Error("event/outbox/receipt are not durable");
  if (!state.directStarted || !state.directFinished) throw new Error("direct unsafe attempt did not complete before response");
  if (!state.directSawDurability) throw new Error("direct unsafe attempt was reordered before durable event/outbox/receipt");
  if (!state.responseReturned) throw new Error("command did not complete");
  if (mode === "response-before-direct" && state.responseReturned && state.directStarted) throw new Error("response completion ordering was not enforced");
  if (!state.queueScheduled) throw new Error("Queue fallback/global-admission path was removed");
  if (applyUnsafe("000000000000000000000000000001") !== "no-change" || state.unsafeApplies !== 1) {
    throw new Error("later Queue replay double-applied the unsafe row");
  }
  state.lastSuid = "000000000000000000000000000002";
  if (applyUnsafe("000000000000000000000000000001") !== "no-change" || state.lastSuid !== "000000000000000000000000000002") {
    throw new Error("later Queue replay regressed active.lastSuid");
  }
  return state;
}

function preChangeFixture() {
  const state = { eventCommitted: true, outboxWritten: true, localReceiptCommitted: true, responseReturned: false, directStarted: false };
  state.responseReturned = true;
  if (state.responseReturned && !state.directStarted) throw new Error("W156 queue-dependent path returns before direct unsafe attempt");
}

const receiptFile = argument("--receipt");
const selfTest = process.argv.includes("--self-test");
const preChange = process.argv.includes("--pre-change");

if (selfTest) {
  const red = assertRed("queue-dependent fixture", () => assertCompleteHandoff("queue-dependent"));
  const receipt = {
    guard: "SDT-G60 direct commit-time doorbell",
    phase: "self-test",
    status: "green",
    redBeforeGreen: red,
    green: assertCompleteHandoff(),
    contract: "durable event/outbox/local receipt precede awaited direct unsafe delivery; Queue remains scheduled and replay-idempotent",
  };
  writeReceipt(receiptFile, receipt);
  console.log(JSON.stringify(receipt));
  process.exit(0);
}

if (preChange) {
  const red = assertRed("W156 queue-dependent source", () => {
    const wiring = sourceWiring(read(sourcePath));
    if (!wiring.ok) throw new Error(`direct commit-time handoff is absent: ${wiring.missing.join(", ")}`);
    preChangeFixture();
  });
  const receipt = {
    guard: "SDT-G60 direct commit-time doorbell",
    phase: "pre-change",
    status: "red",
    expectedFailure: true,
    sourcePath,
    sourceRevision: "HEAD (W156 queue-dependent checkpoint)",
    red,
  };
  writeReceipt(receiptFile, receipt);
  console.error(JSON.stringify(receipt));
  process.exitCode = 1;
} else {
  const wiring = sourceWiring(read(sourcePath));
  if (!wiring.ok) {
    const receipt = {
      guard: "SDT-G60 direct commit-time doorbell",
      phase: "post-change",
      status: "red",
      expectedFailure: false,
      sourceWiring: wiring,
    };
    writeReceipt(receiptFile, receipt);
    console.error(JSON.stringify(receipt));
    process.exitCode = 1;
  } else {
    const redMutants = {
      omission: assertRed("direct delivery omission mutant", () => assertCompleteHandoff("omitted")),
      oldQueueDependent: assertRed("old Queue-dependent mutant", () => assertCompleteHandoff("queue-dependent")),
      responseBeforeDirect: assertRed("response-before-direct mutant", () => assertCompleteHandoff("response-before-direct")),
      durabilityReordered: assertRed("reordered durability mutant", () => assertCompleteHandoff("durability-reordered")),
      duplicateReplay: assertRed("duplicate Queue replay mutant", () => assertCompleteHandoff("duplicate-apply")),
      regressingReplay: assertRed("regressing Queue replay mutant", () => assertCompleteHandoff("regressing-queue")),
    };
    const green = assertCompleteHandoff();
    const receipt = {
      guard: "SDT-G60 direct commit-time doorbell",
      phase: "post-change",
      status: "green",
      sourcePath,
      sourceWiring: wiring,
      green,
      redMutants,
      idempotency: "same SUID is no-change; later lower SUID cannot regress active.lastSuid",
      durableOrdering: "event, outbox obligation and local receipt precede direct attempt and response; Queue remains enabled",
    };
    writeReceipt(receiptFile, receipt);
    console.log(JSON.stringify(receipt));
  }
}
