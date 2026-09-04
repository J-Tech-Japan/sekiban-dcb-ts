#!/usr/bin/env node
/**
 * SDT-G54 mutation proof for the SDT-G56 accepted-positive contract.
 * The runner flag simulates restoring the old empty-head rejection; the
 * checked-in acceptance expectations must turn that run red.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();

function fail(message) {
  throw new Error(`SDT-G54 accepted-positive mutation: ${message}`);
}

function main() {
  const result = spawnSync(process.execPath, ["scripts/g54-interop-runner.mjs", "--unexpected-acceptance-mutant"], {
    cwd: root,
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status === 0) fail("empty-head omission mutant was vacuous: the acceptance runner stayed green");
  if (!output.includes("accepted-positive unexpectedly rejected")) {
    fail(`empty-head omission mutant failed for the wrong reason: ${output}`);
  }
  process.stdout.write(`${JSON.stringify({ result: "accepted-positive-empty-head-mutant-red", resolvingUnit: "SDT-G56", fixtures: 4 })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
