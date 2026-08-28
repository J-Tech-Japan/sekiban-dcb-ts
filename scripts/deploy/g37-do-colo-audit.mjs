#!/usr/bin/env node
/**
 * Extract the DO-side colo field availability from retained G30 raw telemetry.
 *
 * G37 must not infer placement from a caller colo.  A B-lane candidate is
 * allowed only if provider-owned DO events carry positive cross-colo evidence.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function required(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function events(value) {
  const candidates = [value?.result?.events?.events, value?.events?.events, value?.events, value?.result?.data, value?.data];
  const result = candidates.find(Array.isArray);
  if (!Array.isArray(result)) throw new Error("G37 colo audit input has no telemetry event array");
  return result;
}

function coloFor(event) {
  const values = [
    event?.source?.colo,
    event?.$workers?.event?.request?.cf?.colo,
    event?.$metadata?.colo,
  ];
  return values.find((value) => typeof value === "string" && value.length > 0);
}

export function auditDoColos(raw) {
  const byActor = new Map();
  const callerColos = new Map();
  for (const event of events(raw)) {
    const actorClass = event?.source?.actorClass;
    const executionModel = event?.$workers?.executionModel;
    const colo = coloFor(event);
    if (actorClass === "WORKER" && typeof colo === "string") {
      callerColos.set(colo, (callerColos.get(colo) ?? 0) + 1);
    }
    if (executionModel !== "durableObject" || typeof actorClass !== "string") continue;
    const entry = byActor.get(actorClass) ?? { durableObjectEvents: 0, coloPresent: 0, coloDistribution: new Map() };
    entry.durableObjectEvents += 1;
    if (typeof colo === "string") {
      entry.coloPresent += 1;
      entry.coloDistribution.set(colo, (entry.coloDistribution.get(colo) ?? 0) + 1);
    }
    byActor.set(actorClass, entry);
  }
  const durableObjects = Object.fromEntries([...byActor.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([actorClass, entry]) => [actorClass, {
      durableObjectEvents: entry.durableObjectEvents,
      coloPresent: entry.coloPresent,
      coloAbsent: entry.durableObjectEvents - entry.coloPresent,
      coloDistribution: Object.fromEntries([...entry.coloDistribution.entries()].sort(([left], [right]) => left.localeCompare(right))),
    }]));
  const doEventCount = Object.values(durableObjects).reduce((total, entry) => total + entry.durableObjectEvents, 0);
  const doColoPresent = Object.values(durableObjects).reduce((total, entry) => total + entry.coloPresent, 0);
  return Object.freeze({
    task: "SDT-G37",
    source: "retained G30 raw Workers telemetry",
    callerColoDistribution: Object.fromEntries([...callerColos.entries()].sort(([left], [right]) => left.localeCompare(right))),
    durableObjects,
    doEventCount,
    doColoPresent,
    conclusion: doColoPresent === 0
      ? "DO-side colo is absent from every retained provider event; no positive cross-colo evidence exists, so B-1/B-2 are not justified."
      : "Review durableObjects.coloDistribution before deciding whether B-lane candidates are justified.",
  });
}

function main() {
  const input = required("--input", argument("--input"));
  const output = argument("--output", ".artifacts/g37-do-colo-audit.json");
  const result = { ...auditDoColos(JSON.parse(readFileSync(input, "utf8"))), capturedAt: new Date().toISOString() };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
