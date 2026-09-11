#!/usr/bin/env node
/** Prove G84's tier and pinned-history mutations are rejected by the G40 checker. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const root = process.cwd();
const checker = resolve(root, "scripts/g40-ci-coverage-check.mjs");
const manifestPath = resolve(root, "ci/lanes.json");
const REQUIRED_COSMOS_HISTORY_SHA = "38219c8a6526a0209295e9f06450cce9e2217005";

function fail(message) {
  throw new Error(`g40-ci-mutation-proof:${message}`);
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
    process.stdout.write(`${JSON.stringify({ schema: "sdt-g40-ci-mutation-self-test/v1", validators: ["dropped-tier-lane", "local-lane-without-command", "pinned-cosmos-history-sha"] }, null, 2)}\n`);
    return;
  }
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
    command.command = command.command.replace(REQUIRED_COSMOS_HISTORY_SHA, `0${REQUIRED_COSMOS_HISTORY_SHA.slice(1)}`);
  });
  process.stdout.write(`${JSON.stringify({ schema: "sdt-g40-ci-mutation-proof/v3", mutations: [droppedLane, unrunnableLocal, pinnedHistory] }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
