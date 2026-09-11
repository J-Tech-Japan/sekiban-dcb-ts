#!/usr/bin/env node
/**
 * SDT-G40's tiered command-coverage gate.
 *
 * The historical inventory comparison remains useful for catching accidental
 * command loss. G84 adds the manifest checks: every manifest command has one
 * tier, every command is runnable, the PR workflow invokes only the PR lanes,
 * and verify aggregates exactly those jobs.
 */
import { readFileSync } from "node:fs";
import { generateInventory, readWorkspacePackageTexts } from "./g40-ci-step-inventory.mjs";

const DEFAULT_BASELINE = "docs/evidence/SDT-G40-ci-step-inventory-baseline.json";
const DEFAULT_WORKFLOW = ".github/workflows/ci.yml";
const DEFAULT_PACKAGE = "package.json";
const DEFAULT_MANIFEST = "ci/lanes.json";

function fail(message) {
  throw new Error(`g40-ci-coverage-check:${message}`);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function parseArguments(argv) {
  const options = { baseline: DEFAULT_BASELINE, workflow: DEFAULT_WORKFLOW, packagePath: DEFAULT_PACKAGE, manifest: DEFAULT_MANIFEST, selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--baseline") options.baseline = argv[++index];
    else if (argument === "--workflow") options.workflow = argv[++index];
    else if (argument === "--package") options.packagePath = argv[++index];
    else if (argument === "--manifest") options.manifest = argv[++index];
    else if (argument === "--self-test") options.selfTest = true;
    else fail(`unknown argument ${argument}`);
  }
  return options;
}

function extractJobBlocks(workflow) {
  const jobsOffset = workflow.indexOf("\njobs:\n");
  if (jobsOffset < 0) fail("workflow has no jobs section");
  const jobsText = workflow.slice(jobsOffset + "\njobs:\n".length);
  const matches = [...jobsText.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/gm)];
  if (matches.length === 0) fail("workflow has no jobs");
  return new Map(matches.map((match, index) => {
    const end = matches[index + 1]?.index ?? jobsText.length;
    return [match[1], jobsText.slice(match.index, end)];
  }));
}

function assertPullRequestReachability(workflow, jobs, manifest) {
  if (!/^ {2}pull_request:\s*$/m.test(workflow)) fail("ci.yml no longer has a pull_request trigger");
  if (/^\s+schedule:\s*$/m.test(workflow)) fail("scheduled execution is not allowed in the pull-request workflow");
  if (!/^concurrency:\s*$/m.test(workflow)) fail("ci.yml must define a concurrency group");
  if (!/cancel-in-progress:\s*true/m.test(workflow)) fail("ci.yml concurrency must cancel superseded runs");
  const ignored = manifest.pathsIgnore ?? [];
  if (!Array.isArray(ignored) || ignored.length === 0) fail("manifest.pathsIgnore must be non-empty");
  for (const path of ignored) {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`^\\s+-\\s+${escaped}\\s*$`, "m").test(workflow)) fail(`ci.yml is missing guarded paths-ignore entry ${path}`);
  }
  for (const [name, block] of jobs) {
    if (/github\.event_name\s*(?:==|!=)\s*['"]schedule['"]/.test(block)) fail(`${name} makes PR reachability conditional on schedule`);
  }
}

function assertVerifyAggregation(jobs, expectedPrJobs) {
  const verify = jobs.get("verify");
  if (verify === undefined) fail("aggregate job named verify is missing");
  if (!/^ {4}if:\s*\$\{\{\s*always\(\)\s*\}\}\s*$/m.test(verify)) fail("verify must use always() so failed or skipped dependencies are observed");
  const needsMatch = verify.match(/^ {4}needs:\s*\[([^\]]+)\]\s*$/m);
  if (needsMatch === null) fail("verify needs must be an explicit list");
  const actualNeeds = new Set(needsMatch[1].split(",").map((entry) => entry.trim()).filter(Boolean));
  const expectedNeeds = new Set(expectedPrJobs);
  const missing = [...expectedNeeds].filter((name) => !actualNeeds.has(name));
  const unexpected = [...actualNeeds].filter((name) => !expectedNeeds.has(name));
  if (missing.length > 0 || unexpected.length > 0) fail(`verify needs mismatch; missing=[${missing.join(", ")}], unexpected=[${unexpected.join(", ")}]`);
  if (!/G40_VERIFY_NEEDS_JSON:\s*\$\{\{\s*toJson\(needs\)\s*\}\}/.test(verify)) fail("verify does not pass the complete needs result set to its aggregator checker");
  if (!/node scripts\/g40-verify-needs\.mjs/.test(verify)) fail("verify does not execute the dependency-result checker");
}

function inventoryEntries(document, label) {
  object(document, label);
  if (document.schema !== "sdt-g40-ci-step-inventory/v1") fail(`${label} has an unexpected schema`);
  if (!Array.isArray(document.leafCommands) || document.leafCommands.length === 0) fail(`${label}.leafCommands must be a non-empty array`);
  const entries = new Map();
  for (const entry of document.leafCommands) {
    object(entry, `${label}.leafCommands[]`);
    if (typeof entry.id !== "string" || entry.id.length === 0 || typeof entry.command !== "string") fail(`${label} has an invalid command entry`);
    if (entries.has(entry.id)) fail(`${label} repeats command id ${entry.id}`);
    entries.set(entry.id, entry);
  }
  return entries;
}

function loadManifest(path) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read manifest ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  object(manifest, "manifest");
  if (manifest.schema !== "sdt-ci-lanes/v1") fail("manifest schema must be sdt-ci-lanes/v1");
  object(manifest.tiers, "manifest.tiers");
  for (const tier of ["pr", "local", "full"]) object(manifest.tiers[tier], `manifest.tiers.${tier}`);
  if (!Array.isArray(manifest.tiers.full.includes) || !manifest.tiers.full.includes.includes("pr") || !manifest.tiers.full.includes.includes("local")) fail("full tier must include pr and local");
  if (!Array.isArray(manifest.lanes) || manifest.lanes.length === 0) fail("manifest.lanes must be non-empty");
  const laneNames = new Set();
  const commandIds = new Set();
  const commandTiers = new Map();
  for (const lane of manifest.lanes) {
    object(lane, "manifest.lanes[]");
    if (typeof lane.name !== "string" || lane.name.length === 0) fail("every lane needs a name");
    if (laneNames.has(lane.name)) fail(`duplicate lane ${lane.name}`);
    laneNames.add(lane.name);
    if (!["pr", "local"].includes(lane.tier)) fail(`${lane.name} must have exactly one runnable tier: pr or local`);
    if (!Array.isArray(lane.commands) || lane.commands.length === 0) fail(`${lane.name} must have runnable commands`);
    for (const command of lane.commands) {
      object(command, `${lane.name}.commands[]`);
      if (typeof command.id !== "string" || command.id.length === 0) fail(`${lane.name} has a command without an id`);
      if (typeof command.command !== "string" || command.command.trim().length === 0) fail(`${lane.name}/${command.id} has an empty command`);
      if (commandIds.has(command.id)) fail(`command id ${command.id} occurs more than once`);
      commandIds.add(command.id);
      const key = command.command.trim();
      const priorTier = commandTiers.get(key);
      if (priorTier !== undefined && priorTier !== lane.tier) fail(`command '${key}' is assigned to both ${priorTier} and ${lane.tier}`);
      commandTiers.set(key, lane.tier);
    }
  }
  if (!Array.isArray(manifest.requiredLanes) || manifest.requiredLanes.length === 0) fail("manifest.requiredLanes must be non-empty");
  const missingRequired = manifest.requiredLanes.filter((name) => !laneNames.has(name));
  if (missingRequired.length > 0) fail(`manifest dropped required lane(s): ${missingRequired.join(", ")}`);
  return { manifest, commandTiers };
}

function assertManifestScripts(manifest, packageDocument) {
  const scripts = packageDocument.scripts;
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) fail("package.json scripts must be an object");
  const missing = [];
  for (const lane of manifest.lanes) {
    for (const command of lane.commands) {
      for (const match of command.command.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g)) {
        if (typeof scripts[match[1]] !== "string") missing.push(`${lane.name}/${command.id}: npm run ${match[1]}`);
      }
      if (/\bnpm\s+test\b/.test(command.command) && typeof scripts.test !== "string") missing.push(`${lane.name}/${command.id}: npm test`);
    }
  }
  if (missing.length > 0) fail(`manifest invokes undefined package scripts: ${missing.join(", ")}`);
}

function assertWorkflowUsesManifest(workflow, manifest) {
  const jobs = extractJobBlocks(workflow);
  const prLanes = manifest.lanes.filter((lane) => lane.tier === "pr");
  const expectedJobs = new Set(["ci-foundation", "ci-pr-cheap"]);
  for (const lane of prLanes) {
    if (!workflow.includes(`node scripts/ci-local.mjs --lane ${lane.name} --ci`)) fail(`ci.yml does not execute PR lane ${lane.name} from the manifest`);
  }
  if (workflow.includes("--full") || workflow.includes("--tier local")) fail("ci.yml must not execute local/full lanes");
  assertPullRequestReachability(workflow, jobs, manifest);
  assertVerifyAggregation(jobs, [...expectedJobs]);
  return { jobs, expectedJobs: [...expectedJobs] };
}

function runSelfTest(options) {
  const { manifest } = loadManifest(options.manifest);
  if (!manifest.lanes.some((lane) => lane.tier === "pr") || !manifest.lanes.some((lane) => lane.tier === "local")) fail("self-test requires PR and local lanes");
  process.stdout.write(`${JSON.stringify({ schema: "sdt-g40-ci-coverage-self-test/v1", lanes: manifest.lanes.length, verified: ["one-tier-per-command", "runnable-local-lane", "full-includes-pr-and-local"] }, null, 2)}\n`);
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.selfTest) {
    runSelfTest(options);
    return;
  }
  const workflow = readFileSync(options.workflow, "utf8");
  const packageText = readFileSync(options.packagePath, "utf8");
  const packageDocument = JSON.parse(packageText);
  const baseline = JSON.parse(readFileSync(options.baseline, "utf8"));
  const { manifest, commandTiers } = loadManifest(options.manifest);
  assertManifestScripts(manifest, packageDocument);
  const current = generateInventory({
    workflowText: workflow,
    packageText,
    workspacePackageTexts: readWorkspacePackageTexts(packageText, (path) => readFileSync(path, "utf8")),
    manifestText: readFileSync(options.manifest, "utf8"),
    source: { workflow: options.workflow, packageJson: options.packagePath, ref: "working-tree" },
  });
  const baselineEntries = inventoryEntries(baseline, "baseline");
  const currentEntries = inventoryEntries(current, "current");
  const missing = [...baselineEntries.values()].filter((entry) => !currentEntries.has(entry.id));
  const additions = [...currentEntries.values()].filter((entry) => !baselineEntries.has(entry.id));
  const { jobs, expectedJobs } = assertWorkflowUsesManifest(workflow, manifest);
  const result = {
    schema: "sdt-g40-ci-coverage-check/v2",
    tierCounts: Object.fromEntries(["pr", "local"].map((tier) => [tier, manifest.lanes.filter((lane) => lane.tier === tier).length])),
    manifestCommandCount: commandTiers.size,
    baselineLeafCommandCount: baselineEntries.size,
    currentLeafCommandCount: currentEntries.size,
    missing,
    additions,
    prJobs: expectedJobs,
    workflowJobs: [...jobs.keys()],
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (missing.length > 0) fail(`generated inventory has ${missing.length} missing historical command(s): ${missing.map((entry) => entry.id).join(", ")}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
