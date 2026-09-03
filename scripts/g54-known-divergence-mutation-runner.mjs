#!/usr/bin/env node
/**
 * SDT-G54 mutation proof for the temporary SDT-G56 known-divergence contract.
 * The runner flag simulates a runtime accepting the four empty-head V1
 * witnesses; the checked-in expectations must turn that run red.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();

function fail(message) {
  throw new Error(`SDT-G54 known-divergence mutation: ${message}`);
}

function main() {
  const result = spawnSync(process.execPath, ["scripts/g54-interop-runner.mjs", "--unexpected-acceptance-mutant"], {
    cwd: root,
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status === 0) fail("unexpected-acceptance mutant was vacuous: the known-divergence runner stayed green");
  if (!output.includes("known-divergence unexpectedly accepted")) {
    fail(`unexpected-acceptance mutant failed for the wrong reason: ${output}`);
  }
  process.stdout.write(`${JSON.stringify({ result: "known-divergence-unexpected-acceptance-mutant-red", resolvingUnit: "SDT-G56", fixtures: 4 })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
