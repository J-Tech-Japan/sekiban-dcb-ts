#!/usr/bin/env node
/**
 * Prove that the current Cosmos lane remains reachable through the manifest
 * and the full-tier workflow, including the runner's protected-key handling.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadSnapshot } from "./g40-ci-step-inventory.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = process.env.CI_MANIFEST_PATH ?? `${root}ci/lanes.json`;
const fullWorkflowPath = process.env.CI_FULL_WORKFLOW_PATH ?? `${root}.github/workflows/ci-full.yml`;
const runnerPath = process.env.CI_LOCAL_RUNNER_PATH ?? `${root}scripts/ci-local.mjs`;
const packagePath = process.env.PACKAGE_JSON_PATH ?? `${root}package.json`;

function findCosmosLane(manifest) {
  assert.ok(Array.isArray(manifest?.lanes), "manifest must contain lanes");
  const lane = manifest.lanes.find((entry) => entry?.name === "cosmos");
  assert.ok(lane !== undefined, "manifest must retain the cosmos lane");
  assert.equal(lane.tier, "pr", "the Cosmos lane must be in the pull-request tier");
  assert.ok(Array.isArray(lane.commands), "the Cosmos lane must contain commands");
  return lane;
}

function assertManifest(manifest) {
  const lane = findCosmosLane(manifest);
  assert.ok(lane.services.includes("cosmos"), "the Cosmos lane must own the Cosmos service");
  assert.ok(lane.commands.some((entry) => entry?.id === "cosmos" && entry.command === "npm run test:cosmos"), "the Cosmos lane must execute the real Cosmos contract");
  assert.ok(lane.commands.some((entry) => entry?.id === "g22-cosmos" && entry.command === "npm run test:bootstrap:providers:cosmos"), "the Cosmos lane must execute the G22 Cosmos contract");
  assert.ok(lane.commands.some((entry) => entry?.id === "cosmos-wiring" && entry.command === "npm run test:cosmos-wiring"), "the Cosmos lane must execute its wiring guard");
  assert.ok(lane.commands.some((entry) => entry?.id === "cosmos-contract" && entry.command === "npm run test:cosmos:contract"), "the Cosmos lane must execute its non-emulator contract");
  const requiredPaths = [
    "contracts/cosmos-layout.json", "packages/dcb-runtime/src/cosmos.ts", "packages/dcb-runtime/src/store/provider.ts",
    "packages/create-dcb/template/cosmos.experimental.json", "scripts/cosmos-layout-contract.mjs", "scripts/ci-local.mjs",
    "test/cosmos-selection.spec.ts", ".github/workflows/ci.yml",
  ];
  for (const path of requiredPaths) assert.ok(lane.affectedPaths?.includes(path), `the Cosmos lane must cover ${path}`);
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

function assertPullRequestWorkflow(workflow) {
  const job = workflow?.jobs?.["ci-cosmos-emulator"];
  assert.ok(job !== undefined, "ci.yml must define ci-cosmos-emulator");
  assert.equal(job["runs-on"], "ubuntu-latest", "Cosmos hosted job must run on Ubuntu");
  assert.equal(job["timeout-minutes"], 30, "Cosmos hosted job must have a bounded timeout");
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const checkout = steps.find((step) => String(step?.uses ?? "").startsWith("actions/checkout@"));
  assert.equal(checkout?.with?.["fetch-depth"], 0, "Cosmos hosted job must use full history");
  assert.ok(steps.some((step) => String(step?.run ?? "") === "npm ci"), "Cosmos hosted job must install dependencies");
  assert.ok(steps.some((step) => String(step?.run ?? "") === "node scripts/ci-local.mjs --lane cosmos"), "Cosmos hosted job must run the real lane without --ci");
  const needs = workflow?.jobs?.verify?.needs;
  assert.ok(Array.isArray(needs) && needs.includes("ci-cosmos-emulator"), "verify must depend on ci-cosmos-emulator");
}

function assertFullWorkflow(workflow, manifest) {
  assert.match(workflow, /^\s{2}full:\s*$/m, "the full workflow must define its full job");
  assert.match(workflow, /^\s+run:\s+node scripts\/ci-local\.mjs\s+--full\s*$/m, "the full workflow must execute the full manifest tier");
  assert.ok(manifest.tiers?.full?.includes?.includes("local"), "the full tier must include local lanes");
  assert.ok(manifest.lanes.some((entry) => entry?.name === "cosmos" && ["pr", "local"].includes(entry.tier)), "the full workflow's manifest closure must include the Cosmos lane");
}

function assertRunnerSecurity(runner, packageJson) {
  assert.match(runner, /services\.has\("cosmos"\)/, "the local runner must start the manifest Cosmos service");
  assert.match(runner, /spawnSync\("openssl", \["rand", "-base64", "64"\]/, "the local runner must create an ephemeral Cosmos key");
  assert.match(runner, /writeFileSync\(keyFile/, "the local runner must persist the Cosmos key in a protected file");
  assert.match(runner, /COSMOS_KEY_FILE/, "the local runner must pass the Cosmos key through a protected file");
  assert.match(runner, /"--key-file", "\/cosmos\.key"/, "the local runner must mount the key file into the emulator");
  assert.match(runner, /deleteCosmosKeyFile|remove\(keyFile/, "the local runner must delete the Cosmos key file");
  assert.match(runner, /COSMOS_KEY.*delete|delete.*COSMOS_KEY/, "the local runner must remove inherited COSMOS_KEY from child environments");
  assert.match(runner, /cleanup.*failed|service cleanup failed/, "the local runner must fail when cleanup fails");
  assert.doesNotMatch(runner, /COSMOS_KEY\s*[:=]\s*\$\{\{/, "the local runner must not expose a committed Cosmos credential");
  assert.match(String(packageJson.scripts?.["test:cosmos"] ?? ""), /--require-real-cosmos/, "the real Cosmos store command must require the emulator");
  assert.match(String(packageJson.scripts?.["test:bootstrap:providers:cosmos"] ?? ""), /--require-real-cosmos/, "the real Cosmos bootstrap command must require the emulator");
  const keyRegistration = runner.indexOf("cleanup.push(() => deleteCosmosKeyFile(keyFile));");
  const chmod = runner.indexOf("chmodSync(keyFile, 0o600);");
  const start = runner.indexOf('dockerCommand(["run"');
  const containerRegistration = runner.indexOf("cleanup.push(() => cleanupCosmosContainer(container, dockerCommand));");
  assert.ok(keyRegistration >= 0, "Cosmos key cleanup must be registered");
  assert.ok(keyRegistration < chmod && chmod < start, "Cosmos key cleanup must be registered before chmod and startup");
  assert.ok(start < containerRegistration, "Cosmos container cleanup must be registered after startup");
  assert.ok(containerRegistration > keyRegistration, "container cleanup must follow key cleanup registration");
}

function validate(manifest, workflow, pullRequestWorkflow, runner, packageJson) {
  const cosmos = assertManifest(manifest);
  assertFullWorkflow(workflow, manifest);
  assertPullRequestWorkflow(pullRequestWorkflow);
  assertRunnerSecurity(runner, packageJson);
  return cosmos;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const [manifest, workflow, runner, packageJson] = await Promise.all([
    readJson(manifestPath),
    readFile(fullWorkflowPath, "utf8"),
    readFile(runnerPath, "utf8"),
    readJson(packagePath),
  ]);
  const snapshot = loadSnapshot(root);
  const parsedWorkflow = snapshot.workflows.find((entry) => entry.path === ".github/workflows/ci.yml")?.document;
  assert.ok(parsedWorkflow !== undefined, "ci.yml must be loadable");
  const healthy = validate(manifest, workflow, parsedWorkflow, runner, packageJson);
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
    const removedHostedJob = structuredClone(parsedWorkflow);
    delete removedHostedJob.jobs["ci-cosmos-emulator"];
    assert.throws(() => assertPullRequestWorkflow(removedHostedJob), /ci-cosmos-emulator/);
    const removedVerifyEdge = structuredClone(parsedWorkflow);
    removedVerifyEdge.jobs.verify.needs = ["ci-foundation", "ci-pr-cheap"];
    assert.throws(() => assertPullRequestWorkflow(removedVerifyEdge), /verify/);
    const unready = structuredClone(manifest);
    unready.services.cosmos.readiness = "http://127.0.0.1:8080/health";
    assert.throws(() => assertManifest(unready), /readiness/);
    const missingRealFlag = { ...packageJson, scripts: { ...packageJson.scripts, "test:cosmos": "npm run build:packages && node scripts/store-contract.mjs" } };
    assert.throws(() => assertRunnerSecurity(runner, missingRealFlag), /require the emulator/);
    const missingBootstrapRealFlag = { ...packageJson, scripts: { ...packageJson.scripts, "test:bootstrap:providers:cosmos": "npm run build:packages && node scripts/g22-bootstrap-cosmos-contract.mjs" } };
    assert.throws(() => assertRunnerSecurity(runner, missingBootstrapRealFlag), /require the emulator/);
    const missingService = structuredClone(manifest);
    findCosmosLane(missingService).services = [];
    assert.throws(() => assertManifest(missingService), /own the Cosmos service/);
    const missingPort = structuredClone(manifest);
    missingPort.services.cosmos.ports = [8080, 8081];
    assert.throws(() => assertManifest(missingPort), /ports/);
    const missingCleanup = runner.replace("cleanup.push(() => deleteCosmosKeyFile(keyFile));", "");
    assert.throws(() => assertRunnerSecurity(missingCleanup, packageJson), /key cleanup must be registered/);
    process.stdout.write(`${JSON.stringify({
      result: "cosmos-wiring-self-test-passed",
      healthy,
      mutation: { name: "remove-cosmos-lane", result: "red", error: mutationError },
      unpinnedImageMutation: { name: "cosmos-image-unpinned", result: "red", error: unpinnedError },
      hostedJobMutation: { name: "remove-hosted-job", result: "red" },
      verifyNeedsMutation: { name: "remove-verify-edge", result: "red" },
      readinessMutation: { name: "change-readiness-path", result: "red" },
      realFlagMutation: { name: "remove-real-contract-flag", result: "red" },
      bootstrapRealFlagMutation: { name: "remove-bootstrap-real-contract-flag", result: "red" },
      missingServiceMutation: { name: "remove-cosmos-service", result: "red" },
      missingPortsMutation: { name: "remove-cosmos-port", result: "red" },
      missingCleanupMutation: { name: "remove-key-cleanup-registration", result: "red" },
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ result: "cosmos-wiring-passed", ...healthy })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
