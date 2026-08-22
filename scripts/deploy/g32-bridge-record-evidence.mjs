#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { aggregateBridgeAcks } from "./g32-bridge-witness.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

export function buildBridgeEvidence(witness) {
  const sourceCommit = requiredString(witness?.sourceCommit, "bridge sourceCommit");
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("G32 bridge sourceCommit must be a full SHA");
  const configDigest = requiredString(witness?.configDigest, "bridge configDigest");
  if (!/^[0-9a-f]{64}$/.test(configDigest)) throw new Error("G32 bridge configDigest must be SHA-256");
  const tokenFingerprint = requiredString(witness?.tokenFingerprint, "bridge tokenFingerprint");
  if (!/^[0-9a-f]{64}$/.test(tokenFingerprint)) throw new Error("G32 bridge token fingerprint must be SHA-256");
  const coverage = aggregateBridgeAcks(witness?.acknowledgements);
  const settlement = witness?.settlement;
  if (settlement?.phase !== "bridge-freeze" || settlement?.queueDisposition !== "old-format messages are explicitly discarded by the bridge consumer; final C binds a new queue") {
    throw new Error("G32 bridge disposition settlement is incomplete");
  }
  if (Number(settlement?.pipeline?.pendingArrivals) !== 0) throw new Error("G32 bridge has pending delivery arrivals after freeze");
  if (settlement?.allocator?.alarmAt !== null || settlement?.bootstrap?.alarmAt !== null) {
    throw new Error("G32 bridge allocator/bootstrap alarms are not settled");
  }
  return {
    task: "SDT-G32",
    phase: "bridge-freeze",
    status: "sealed B deployed and freeze acknowledged before final-C new-store cutover",
    candidateCommit: sourceCommit,
    sourceCommit,
    bridgeConfigDigest: configDigest,
    freezeTokenFingerprint: tokenFingerprint,
    protocol: {
      candidate: "B is immutable old-format freeze-only code. It contains no G32 event-record reader or writer.",
      bookkeeping: "This evidence was recorded after B deployment; it cannot change B's source/configuration/digest authority.",
      oldFormatOnly: true,
      freezeOnly: true,
      requiredBeforeFinalC: true,
    },
    freezeAcknowledgements: witness.acknowledgements,
    writerCoverage: coverage,
    freezePreconditions: {
      inFlight: 0,
      pendingOutbox: settlement.outboxDiscarded === 0 ? "zero-observed" : "explicitly-discarded",
      pendingArrivals: settlement.pipeline.pendingArrivals,
      queueDisposition: settlement.queueDisposition,
      allocatorAlarm: settlement.allocator.alarmAt,
      bootstrapAlarm: settlement.bootstrap.alarmAt,
      tagInventory: settlement.tagInventory,
      rationale: "The bridge accepts no writer route; old Queue payloads are explicitly discarded and final C receives a new Queue and service identity.",
    },
    cutoverBoundary: {
      oldServiceId: settlement.serviceId,
      oldFormatReader: "not present in bridge",
      finalCRequired: "new D1 database IDs, new Queue, new serviceId, and G32 30-digit-only ingress gates",
    },
    secrets: "redacted",
  };
}

function main() {
  const witness = readJson(argument("--witness", ".artifacts/g32-bridge-witness.json"));
  const output = argument("--output", "docs/SDT-G32-bridge-evidence.json");
  const evidence = buildBridgeEvidence(witness);
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ candidateCommit: evidence.candidateCommit, components: evidence.writerCoverage.components, pendingOutbox: evidence.freezePreconditions.pendingOutbox }, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
