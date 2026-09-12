#!/usr/bin/env node
/**
 * Prove that the Cosmos lane remains reachable through the G84 manifest and
 * full-tier workflow after Cosmos was moved out of pull-request CI.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("..", import.meta.url).pathname;
const manifestPath = process.env.CI_MANIFEST_PATH ?? `${root}ci/lanes.json`;
const baselinePath = process.env.CI_BASELINE_PATH ?? `${root}docs/evidence/SDT-G40-ci-step-inventory-baseline.json`;
const fullWorkflowPath = process.env.CI_FULL_WORKFLOW_PATH ?? `${root}.github/workflows/ci-full.yml`;
const runnerPath = process.env.CI_LOCAL_RUNNER_PATH ?? `${root}scripts/ci-local.mjs`;

function normalizeCommand(command) {
  return command.trim().split(/\s+/).join(" ");
}

function deriveBaselineHistory(baseline) {
  const candidates = baseline?.leafCommands?.filter((entry) =>
    entry?.type === "workflow-run" &&
    Array.isArray(entry.sources) &&
    entry.sources.some((source) => source?.job === "cosmos-emulator") &&
    typeof entry.command === "string" &&
    normalizeCommand(entry.command).startsWith("git fetch --no-tags origin "),
  ) ?? [];
  assert.equal(candidates.length, 1, "baseline must identify exactly one Cosmos retained-history fetch");
  const normalizedCommand = normalizeCommand(candidates[0].command);
  const shas = normalizedCommand.match(/\b[0-9a-f]{40}\b/g) ?? [];
  assert.ok(shas.length >= 3, "baseline Cosmos retained-history fetch must contain at least three object IDs");
  return { normalizedCommand, pinnedSha: shas[2] };
}

function findCosmosLane(manifest) {
  assert.ok(Array.isArray(manifest?.lanes), "manifest must contain lanes");
  const lane = manifest.lanes.find((entry) => entry?.name === "cosmos");
  assert.ok(lane !== undefined, "manifest must retain the cosmos lane");
  assert.equal(lane.tier, "local", "the Cosmos lane must remain in the local tier");
  assert.ok(Array.isArray(lane.commands), "the Cosmos lane must contain commands");
  return lane;
}

function assertManifest(manifest, baselineHistory) {
  const lane = findCosmosLane(manifest);
  const retained = lane.commands.find((entry) => entry?.id === "cosmos-retained-history");
  assert.ok(retained !== undefined, "the Cosmos lane must retain its history command");
  assert.equal(
    normalizeCommand(retained.command),
    baselineHistory.normalizedCommand,
    "the Cosmos retained-history command must match the baseline-derived command",
  );
  assert.ok(
    lane.commands.some((entry) => entry?.id === "cosmos" && entry.command === "npm run test:cosmos"),
    "the Cosmos lane must execute the real Cosmos contract",
  );
  assert.ok(
    lane.commands.some((entry) => entry?.id === "g22-cosmos" && entry.command === "npm run test:g22:cosmos"),
    "the Cosmos lane must execute the G22 Cosmos contract",
  );
  assert.ok(
    lane.commands.some((entry) => entry?.id === "cosmos-wiring" && entry.command === "npm run test:cosmos-wiring"),
    "the Cosmos lane must execute its wiring guard",
  );
  assert.ok(manifest.services?.cosmos?.image?.includes("azure-cosmos-emulator:vnext-preview"), "the manifest must pin the Cosmos emulator image");
  assert.equal(manifest.services?.cosmos?.readiness, "http://127.0.0.1:8080/ready", "the manifest must retain the Cosmos readiness endpoint");
  return { lane: lane.name, tier: lane.tier, pinnedSha: baselineHistory.pinnedSha, commandCount: lane.commands.length };
}

function assertFullWorkflow(workflow, manifest) {
  assert.match(workflow, /^\s{2}full:\s*$/m, "the full workflow must define its full job");
  assert.match(workflow, /^\s+run:\s+node scripts\/ci-local\.mjs\s+--full\s*$/m, "the full workflow must execute the full manifest tier");
  assert.ok(manifest.tiers?.full?.includes?.includes("local"), "the full tier must include local lanes");
  assert.ok(manifest.lanes.some((entry) => entry?.name === "cosmos" && entry.tier === "local"), "the full workflow's manifest closure must include the Cosmos job");
}

function assertRunnerSecurity(runner) {
  assert.match(runner, /services\.has\("cosmos"\)/, "the local runner must start the manifest Cosmos service");
  assert.match(runner, /spawnSync\("openssl", \["rand", "-base64", "64"\]/, "the local runner must create an ephemeral Cosmos key");
  assert.match(runner, /writeFileSync\(keyFile/, "the local runner must persist the Cosmos key in a protected file");
  assert.match(runner, /COSMOS_KEY_FILE/, "the local runner must pass the Cosmos key through a protected file");
  assert.match(runner, /"--key-file", "\/cosmos\.key"/, "the local runner must mount the key file into the emulator");
  assert.doesNotMatch(runner, /COSMOS_KEY\s*[:=]\s*\$\{\{/, "the local runner must not expose a committed Cosmos credential");
}

function validate(manifest, workflow, runner, baselineHistory) {
  const cosmos = assertManifest(manifest, baselineHistory);
  assertFullWorkflow(workflow, manifest);
  assertRunnerSecurity(runner);
  return cosmos;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const [manifest, baseline, workflow, runner] = await Promise.all([
    readJson(manifestPath),
    readJson(baselinePath),
    readFile(fullWorkflowPath, "utf8"),
    readFile(runnerPath, "utf8"),
  ]);
  const baselineHistory = deriveBaselineHistory(baseline);
  const healthy = validate(manifest, workflow, runner, baselineHistory);
  if (process.argv.includes("--self-test")) {
    const removedCosmos = structuredClone(manifest);
    removedCosmos.lanes = removedCosmos.lanes.filter((entry) => entry?.name !== "cosmos");
    let mutationError = null;
    try {
      assertManifest(removedCosmos, baselineHistory);
    } catch (error) {
      mutationError = error instanceof Error ? error.message : String(error);
    }
    assert.ok(mutationError !== null, "removing the Cosmos lane must be rejected");
    console.log(JSON.stringify({
      result: "cosmos-wiring-self-test-passed",
      healthy,
      mutation: { name: "remove-cosmos-lane", result: "red", error: mutationError },
    }));
    return;
  }
  console.log(JSON.stringify({ result: "cosmos-wiring-passed", ...healthy }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
