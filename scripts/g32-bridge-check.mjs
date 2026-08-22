#!/usr/bin/env node
import { readFileSync } from "node:fs";

const REQUIRED = Object.freeze([
  "commit-http",
  "queue-consumer",
  "tag-do-outbox-alarm",
  "cron",
  "bootstrap-import-dump-restore",
  "mv-apply",
  "doorbell-receiver",
]);
const COMPONENTS = Object.freeze(["primary", "receiver"]);

export function assertBridgeCoverage(contract) {
  if (contract?.schemaVersion !== 1 || contract?.task !== "SDT-G32" || contract?.candidate !== "B") {
    throw new Error("G32 bridge coverage manifest identity is invalid");
  }
  if (JSON.stringify(contract.expectedComponents) !== JSON.stringify(COMPONENTS)) {
    throw new Error("G32 bridge expected component set is invalid");
  }
  if (!Array.isArray(contract.writerEntrypoints)) throw new Error("G32 bridge writer coverage is missing");
  const ids = contract.writerEntrypoints.map((entry) => entry?.id).sort();
  if (new Set(ids).size !== ids.length || JSON.stringify(ids) !== JSON.stringify([...REQUIRED].sort())) {
    throw new Error("G32 bridge writer entrypoint set is incomplete or has an extra entry");
  }
  for (const entry of contract.writerEntrypoints) {
    if (!COMPONENTS.includes(entry.component) || typeof entry.freeze !== "string" || entry.freeze.length === 0) {
      throw new Error(`G32 bridge writer entrypoint is invalid: ${String(entry?.id)}`);
    }
  }
  const primary = contract.writerEntrypoints.filter((entry) => entry.component === "primary").length;
  const receiver = contract.writerEntrypoints.filter((entry) => entry.component === "receiver").length;
  if (primary !== 6 || receiver !== 1) throw new Error("G32 bridge writer entrypoints are not attributed to both deployed components");
  return { entrypoints: ids.length, primary, receiver };
}

export function runSelfTest(contract) {
  const baseline = assertBridgeCoverage(contract);
  let missingRed = false;
  try { assertBridgeCoverage({ ...contract, writerEntrypoints: contract.writerEntrypoints.filter((entry) => entry.id !== "doorbell-receiver") }); }
  catch (error) { missingRed = String(error).includes("incomplete"); }
  if (!missingRed) throw new Error("G32 bridge one-entry-missing mutation unexpectedly passed");
  let attributionRed = false;
  try { assertBridgeCoverage({ ...contract, writerEntrypoints: contract.writerEntrypoints.map((entry) => entry.id === "doorbell-receiver" ? { ...entry, component: "primary" } : entry) }); }
  catch (error) { attributionRed = String(error).includes("not attributed"); }
  if (!attributionRed) throw new Error("G32 bridge component-attribution mutation unexpectedly passed");
  return { ...baseline, mutations: ["one-entry-missing", "receiver-attribution"] };
}

function main() {
  if (process.env.SDT_G32_BRIDGE_FORCE_FAILURE === "1") throw new Error("SDT-G32 bridge forced failure");
  const contract = JSON.parse(readFileSync("contracts/g32-bridge-writer-coverage.json", "utf8"));
  console.log(JSON.stringify(runSelfTest(contract), null, 2));
}

main();
