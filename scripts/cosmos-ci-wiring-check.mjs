#!/usr/bin/env node
/**
 * Prove that the current Cosmos lane remains reachable through the manifest
 * and the full-tier workflow, including the runner's protected-key handling.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = process.env.CI_MANIFEST_PATH ?? `${root}ci/lanes.json`;
const fullWorkflowPath = process.env.CI_FULL_WORKFLOW_PATH ?? `${root}.github/workflows/ci-full.yml`;
const runnerPath = process.env.CI_LOCAL_RUNNER_PATH ?? `${root}scripts/ci-local.mjs`;

function findCosmosLane(manifest) {
  assert.ok(Array.isArray(manifest?.lanes), "manifest must contain lanes");
  const lane = manifest.lanes.find((entry) => entry?.name === "cosmos");
  assert.ok(lane !== undefined, "manifest must retain the cosmos lane");
  assert.equal(lane.tier, "local", "the Cosmos lane must remain in the local tier");
  assert.ok(Array.isArray(lane.commands), "the Cosmos lane must contain commands");
  return lane;
}

function assertManifest(manifest) {
  const lane = findCosmosLane(manifest);
  assert.ok(lane.commands.some((entry) => entry?.id === "cosmos" && entry.command === "npm run test:cosmos"), "the Cosmos lane must execute the real Cosmos contract");
  assert.ok(lane.commands.some((entry) => entry?.id === "g22-cosmos" && entry.command === "npm run test:bootstrap:providers:cosmos"), "the Cosmos lane must execute the G22 Cosmos contract");
  assert.ok(lane.commands.some((entry) => entry?.id === "cosmos-wiring" && entry.command === "npm run test:cosmos-wiring"), "the Cosmos lane must execute its wiring guard");
  const image = manifest.services?.cosmos?.image;
  assert.match(
    String(image ?? ""),
    /^mcr\.microsoft\.com\/cosmosdb\/linux\/azure-cosmos-emulator:vnext-preview@sha256:[0-9a-f]{64}$/,
    "the manifest must pin the current Cosmos emulator image by digest",
  );
  assert.deepEqual(manifest.services?.cosmos?.ports, [8080, 8081, 1234], "the manifest must retain the Cosmos ports");
  assert.equal(manifest.services?.cosmos?.readiness, "http://127.0.0.1:8080/ready", "the manifest must retain the Cosmos readiness endpoint");
  return { lane: lane.name, tier: lane.tier, commandCount: lane.commands.length };
}

function assertFullWorkflow(workflow, manifest) {
  assert.match(workflow, /^\s{2}full:\s*$/m, "the full workflow must define its full job");
  assert.match(workflow, /^\s+run:\s+node scripts\/ci-local\.mjs\s+--full\s*$/m, "the full workflow must execute the full manifest tier");
  assert.ok(manifest.tiers?.full?.includes?.includes("local"), "the full tier must include local lanes");
  assert.ok(manifest.lanes.some((entry) => entry?.name === "cosmos" && entry.tier === "local"), "the full workflow's manifest closure must include the Cosmos lane");
}

function assertRunnerSecurity(runner) {
  assert.match(runner, /services\.has\("cosmos"\)/, "the local runner must start the manifest Cosmos service");
  assert.match(runner, /spawnSync\("openssl", \["rand", "-base64", "64"\]/, "the local runner must create an ephemeral Cosmos key");
  assert.match(runner, /writeFileSync\(keyFile/, "the local runner must persist the Cosmos key in a protected file");
  assert.match(runner, /COSMOS_KEY_FILE/, "the local runner must pass the Cosmos key through a protected file");
  assert.match(runner, /"--key-file", "\/cosmos\.key"/, "the local runner must mount the key file into the emulator");
  assert.doesNotMatch(runner, /COSMOS_KEY\s*[:=]\s*\$\{\{/, "the local runner must not expose a committed Cosmos credential");
}

function validate(manifest, workflow, runner) {
  const cosmos = assertManifest(manifest);
  assertFullWorkflow(workflow, manifest);
  assertRunnerSecurity(runner);
  return cosmos;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const [manifest, workflow, runner] = await Promise.all([
    readJson(manifestPath),
    readFile(fullWorkflowPath, "utf8"),
    readFile(runnerPath, "utf8"),
  ]);
  const healthy = validate(manifest, workflow, runner);
  if (process.argv.includes("--self-test")) {
    const removedCosmos = structuredClone(manifest);
    removedCosmos.lanes = removedCosmos.lanes.filter((entry) => entry?.name !== "cosmos");
    let mutationError = null;
    try {
      assertManifest(removedCosmos);
    } catch (error) {
      mutationError = error instanceof Error ? error.message : String(error);
    }
    assert.ok(mutationError !== null, "removing the Cosmos lane must be rejected");
    const unpinnedImage = structuredClone(manifest);
    unpinnedImage.services.cosmos.image = String(unpinnedImage.services.cosmos.image).split("@")[0];
    let unpinnedError = null;
    try {
      assertManifest(unpinnedImage);
    } catch (error) {
      unpinnedError = error instanceof Error ? error.message : String(error);
    }
    assert.ok(unpinnedError !== null, "removing the Cosmos image digest must be rejected");
    process.stdout.write(`${JSON.stringify({
      result: "cosmos-wiring-self-test-passed",
      healthy,
      mutation: { name: "remove-cosmos-lane", result: "red", error: mutationError },
      unpinnedImageMutation: { name: "cosmos-image-unpinned", result: "red", error: unpinnedError },
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ result: "cosmos-wiring-passed", ...healthy })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
