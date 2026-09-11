#!/usr/bin/env node
/** Prove G84's tier and pinned-history mutations are rejected by the G40 checker. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const root = process.cwd();
const checker = resolve(root, "scripts/g40-ci-coverage-check.mjs");
const manifestPath = resolve(root, "ci/lanes.json");
const baselinePath = resolve(root, "docs/evidence/SDT-G40-ci-step-inventory-baseline.json");

function fail(message) {
  throw new Error(`g40-ci-mutation-proof:${message}`);
}

function normalizeCommand(command) {
  return command.trim().split(/\s+/).join(" ");
}

function deriveBaselineCosmosHistorySha() {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const candidates = baseline.leafCommands?.filter((entry) =>
    entry?.type === "workflow-run" &&
    Array.isArray(entry.sources) &&
    entry.sources.some((source) => source?.job === "cosmos-emulator") &&
    typeof entry.command === "string" &&
    normalizeCommand(entry.command).startsWith("git fetch --no-tags origin ")
  ) ?? [];
  if (candidates.length !== 1) fail(`baseline must identify exactly one Cosmos retained-history fetch, found ${candidates.length}`);
  const shas = normalizeCommand(candidates[0].command).match(/\b[0-9a-f]{40}\b/g) ?? [];
  if (shas.length < 3) fail("baseline Cosmos retained-history fetch must contain at least three object IDs");
  return shas[2];
}

function runMutation(label, mutate) {
  const temporary = mkdtempSync(resolve(tmpdir(), "sdt-g40-tier-mutation-"));
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    mutate(manifest);
    const path = resolve(temporary, `${label}.json`);
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    const result = spawnSync(process.execPath, [checker, "--manifest", path], { cwd: root, encoding: "utf8" });
    if (result.error !== undefined) throw result.error;
    if (result.status === 0) fail(`${label} mutation unexpectedly passed`);
    return { label, exitStatus: result.status, rejected: true };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function main() {
  if (process.argv.includes("--self-test")) {
    const baselinePin = deriveBaselineCosmosHistorySha();
    process.stdout.write(`${JSON.stringify({ schema: "sdt-g40-ci-mutation-self-test/v1", validators: ["dropped-tier-lane", "local-lane-without-command", "pinned-cosmos-history-sha"], baselinePinDerived: baselinePin.length === 40 }, null, 2)}\n`);
    return;
  }
  const baselinePin = deriveBaselineCosmosHistorySha();
  const droppedLane = runMutation("dropped-tier-lane", (manifest) => {
    manifest.lanes = manifest.lanes.filter((lane) => lane.name !== "g43");
  });
  const unrunnableLocal = runMutation("local-lane-without-command", (manifest) => {
    const lane = manifest.lanes.find((entry) => entry.tier === "local");
    if (lane === undefined) fail("fixture has no local lane");
    lane.commands = [];
  });
  const pinnedHistory = runMutation("pinned-cosmos-history-sha", (manifest) => {
    const lane = manifest.lanes.find((entry) => entry.name === "cosmos");
    const command = lane?.commands?.find((entry) => entry.id === "cosmos-retained-history");
    if (command === undefined) fail("fixture has no cosmos retained-history command");
    const occurrences = command.command.split(baselinePin).length - 1;
    if (occurrences !== 1) fail(`manifest must contain exactly one baseline Cosmos pin, found ${occurrences}`);
    const replacement = baselinePin[0] === "0" ? "1" : "0";
    command.command = command.command.replace(baselinePin, `${replacement}${baselinePin.slice(1)}`);
  });
  process.stdout.write(`${JSON.stringify({ schema: "sdt-g40-ci-mutation-proof/v3", mutations: [droppedLane, unrunnableLocal, pinnedHistory] }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
