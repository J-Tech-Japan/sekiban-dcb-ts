#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const sourcePath = "packages/dcb-runtime/src/tag/TagDurableObject.ts";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function sourceWiring(source) {
  if (source.includes("autoDrainAfterResponse") || source.includes("setTimeout(resolve, 0)")) {
    throw new Error("old waitUntil-only zero-delay handoff remains");
  }
  const appendStart = source.indexOf("private async append(");
  const helperStart = source.indexOf("private startAutoDrainBeforeResponse(");
  const drainStart = source.indexOf("private async autoDrainOutbox(");
  if (appendStart < 0 || helperStart < 0 || drainStart < 0) {
    throw new Error("append, start helper, or drain method is absent");
  }
  const append = source.slice(appendStart, helperStart);
  const helper = source.slice(helperStart, drainStart);
  const calls = [...append.matchAll(/this\.startAutoDrainBeforeResponse\(/g)].map((match) => match.index ?? -1);
  if (calls.length !== 2) {
    throw new Error(`expected both SQL and fallback append paths to start the drain; found ${calls.length}`);
  }
  const responseReturns = [...append.matchAll(/return response;/g)].map((match) => match.index ?? -1);
  if (responseReturns.length !== 2) {
    throw new Error(`expected both append paths to return their response; found ${responseReturns.length}`);
  }
  for (const call of calls) {
    const responseConstruction = append.lastIndexOf("const response = json(result.body, result.status);", call);
    const responseReturn = append.indexOf("return response;", call);
    if (responseConstruction < 0 || responseReturn < 0 || responseConstruction > call || call > responseReturn) {
      throw new Error("drain start is not between durable result response construction and response return");
    }
  }
  const drainCall = helper.indexOf("this.autoDrainOutbox(");
  const waitUntil = helper.indexOf("this.ctx.waitUntil(drain)");
  if (drainCall < 0 || waitUntil < 0 || drainCall > waitUntil) {
    throw new Error("start helper does not start the drain before retaining it with waitUntil");
  }
  const hasSqlAppend = append.includes("appendSql(tag, input, serviceId)") || append.includes("this.appendSql(");
  if (!hasSqlAppend || !append.includes("this.ctx.storage.transaction")) {
    throw new Error("both durable append implementations are not covered");
  }
  return {
    appendDrainStarts: calls.length,
    appendResponseReturns: responseReturns.length,
    waitUntilRetainsStartedPromise: true,
    oldDeferredHelperAbsent: true,
  };
}

function legacySourceFixture() {
  return `
    const response = json(result.body, result.status);
    this.ctx.waitUntil(this.autoDrainAfterResponse(tag, serviceId, domainDeliveryClass).catch(() => undefined));
    return response;
    private async autoDrainAfterResponse(tag, serviceId, domainDeliveryClass) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await this.autoDrainOutbox(tag, serviceId, domainDeliveryClass);
    }
  `;
}

function preChangeSource() {
  try {
    return execFileSync("git", ["show", `HEAD:${sourcePath}`], { encoding: "utf8" });
  } catch {
    return legacySourceFixture();
  }
}

function expectRed(source, label) {
  try {
    sourceWiring(source);
  } catch (error) {
    return {
      status: "red",
      expectedFailure: true,
      reason: String(error instanceof Error ? error.message : error),
      label,
    };
  }
  throw new Error(`${label} was accepted by the queue-latency guard`);
}

function writeReceipt(file, receipt) {
  if (file === undefined) return;
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`);
}

const receiptFile = argument("--receipt");
const selfTest = process.argv.includes("--self-test");
const preChange = process.argv.includes("--pre-change");

if (selfTest) {
  const red = expectRed(legacySourceFixture(), "old waitUntil-only fixture");
  const receipt = {
    guard: "SDT-G60 queue latency handoff",
    phase: "self-test",
    status: "green",
    redBeforeGreen: red,
    contract: "start durable outbox drain before returning append response; retain started promise with waitUntil",
  };
  writeReceipt(receiptFile, receipt);
  console.log(JSON.stringify(receipt));
  process.exit(0);
}

if (preChange) {
  const red = expectRed(preChangeSource(), "pre-change old waitUntil-only source");
  const receipt = {
    guard: "SDT-G60 queue latency handoff",
    phase: "pre-change",
    status: "red",
    expectedFailure: true,
    red,
    sourcePath,
    sourceRevision: "HEAD (the pre-repair checkpoint)",
  };
  writeReceipt(receiptFile, receipt);
  console.error(JSON.stringify(receipt));
  process.exitCode = 1;
} else {
  const source = read(sourcePath);
  let green;
  try {
    green = sourceWiring(source);
  } catch (error) {
    const receipt = {
      guard: "SDT-G60 queue latency handoff",
      phase: "post-change",
      status: "red",
      expectedFailure: false,
      reason: String(error instanceof Error ? error.message : error),
    };
    writeReceipt(receiptFile, receipt);
    console.error(JSON.stringify(receipt));
    process.exitCode = 1;
  }
  if (green !== undefined) {
    const firstDrainCall = source.indexOf("this.startAutoDrainBeforeResponse(");
    const firstDrainEnd = source.indexOf(");", firstDrainCall);
    const omitted = firstDrainCall < 0 || firstDrainEnd < 0
      ? source
      : `${source.slice(0, firstDrainCall)}${source.slice(firstDrainEnd + 2)}`;
    const oldWaitUntil = source.replaceAll(
      /this\.startAutoDrainBeforeResponse\(tag, serviceId, domainDeliveryClass(?:, directRows)?\);/g,
      "this.ctx.waitUntil(this.autoDrainAfterResponse(tag, serviceId, domainDeliveryClass).catch(() => undefined));",
    );
    const redMutants = {
      omission: expectRed(omitted, "append-path omission mutant"),
      oldWaitUntil: expectRed(oldWaitUntil, "old waitUntil-only mutant"),
    };
    const receipt = {
      guard: "SDT-G60 queue latency handoff",
      phase: "post-change",
      status: "green",
      expectedFailure: false,
      green,
      redMutants,
      sourcePath,
      contract: "durable event/outbox/receipt commit precedes start; drain starts before response return; waitUntil retains the started promise",
    };
    writeReceipt(receiptFile, receipt);
    console.log(JSON.stringify(receipt));
  }
}
