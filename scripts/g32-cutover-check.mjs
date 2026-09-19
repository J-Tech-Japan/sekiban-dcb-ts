#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { runDeployGate } from "./g100-deploy-gate.mjs";

function arraysEqual(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export function assertBridgeEvidence(evidence, cutover) {
  if (evidence?.candidateCommit !== cutover.bridge.candidateCommit || evidence?.sourceCommit !== cutover.bridge.candidateCommit || evidence?.protocol?.oldFormatOnly !== true || evidence?.protocol?.freezeOnly !== true) {
    throw new Error("G32 sealed bridge identity/evidence is invalid");
  }
  if (!arraysEqual(evidence?.freezeAcknowledgements?.componentSet ?? [], cutover.final.requiredComponents)) throw new Error("G32 bridge component acknowledgements are incomplete");
  if (!arraysEqual(evidence?.freezeAcknowledgements?.writerEntrypointSet ?? [], cutover.final.requiredWriterEntrypoints)) throw new Error("G32 bridge writer coverage is incomplete");
  if (evidence?.freezePreconditions?.inFlight !== 0 || evidence?.freezePreconditions?.pendingOutbox?.disposition !== "explicitly-discarded") {
    throw new Error("G32 bridge freeze preconditions are incomplete");
  }
  return { bridgeCandidate: evidence.candidateCommit, bridgeCoverage: evidence.freezeAcknowledgements.writerEntrypointSet.length };
}

export function runCutoverCheck() {
  if (process.env.SDT_G32_CUTOVER_FORCE_FAILURE === "1") throw new Error("SDT-G32 cutover forced failure");
  const cutover = JSON.parse(readFileSync("contracts/g32-cutover.json", "utf8"));
  const evidence = JSON.parse(readFileSync(cutover.bridge.evidencePath, "utf8"));
  const bridge = assertBridgeEvidence(evidence, cutover);
  const gate = runDeployGate();
  return { ...bridge, digest: gate.digest };
}

const entry = process.argv[1] !== undefined && process.argv[1].endsWith("g32-cutover-check.mjs");
if (entry) {
  try {
    process.stdout.write(`${JSON.stringify(runCutoverCheck())}\n`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
