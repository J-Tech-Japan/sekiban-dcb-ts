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
import { createHash } from "node:crypto";
import { generateInventory, readWorkspacePackageTexts } from "./g40-ci-step-inventory.mjs";

const DEFAULT_BASELINE = "docs/evidence/SDT-G40-ci-step-inventory-baseline.json";
const DEFAULT_WORKFLOW = ".github/workflows/ci.yml";
const DEFAULT_PACKAGE = "package.json";
const DEFAULT_MANIFEST = "ci/lanes.json";
const DEFAULT_ALLOWLIST = "docs/evidence/SDT-G40-ci-step-inventory-allowlist.json";

function fail(message) {
  throw new Error(`g40-ci-coverage-check:${message}`);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function parseArguments(argv) {
  const options = { baseline: DEFAULT_BASELINE, workflow: DEFAULT_WORKFLOW, packagePath: DEFAULT_PACKAGE, manifest: DEFAULT_MANIFEST, allowlist: DEFAULT_ALLOWLIST, selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--baseline") options.baseline = argv[++index];
    else if (argument === "--workflow") options.workflow = argv[++index];
    else if (argument === "--package") options.packagePath = argv[++index];
    else if (argument === "--manifest") options.manifest = argv[++index];
    else if (argument === "--allowlist") options.allowlist = argv[++index];
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

function normalizeCommand(command) {
  return command.trim().split(/\s+/).join(" ");
}

function deriveCosmosHistoryFromBaseline(baseline) {
  if (baseline === null || typeof baseline !== "object" || !Array.isArray(baseline.leafCommands)) {
    fail("baseline must contain a leafCommands array");
  }
  const candidates = baseline.leafCommands.filter((entry) =>
    entry !== null && typeof entry === "object" &&
    entry.type === "workflow-run" &&
    typeof entry.command === "string" &&
    Array.isArray(entry.sources) &&
    entry.sources.some((source) => source?.job === "cosmos-emulator") &&
    normalizeCommand(entry.command).startsWith("git fetch --no-tags origin ")
  );
  if (candidates.length !== 1) fail(`baseline must identify exactly one Cosmos retained-history fetch, found ${candidates.length}`);
  const normalizedCommand = normalizeCommand(candidates[0].command);
  const shas = normalizedCommand.match(/\b[0-9a-f]{40}\b/g) ?? [];
  if (shas.length < 3) fail("baseline Cosmos retained-history fetch must contain at least three object IDs");
  return {
    normalizedCommand,
    pinnedSha: shas[2],
  };
}

function assertCosmosHistoryMatchesBaseline(manifestCommand, baselineHistory) {
  const normalizedCommand = normalizeCommand(manifestCommand);
  if (normalizedCommand !== baselineHistory.normalizedCommand) {
    fail("cosmos-retained-history command must exactly match the historical baseline leaf text");
  }
  return baselineHistory.pinnedSha;
}

function canonicalEntry(entry) {
  return JSON.stringify({
    id: entry.id,
    type: entry.type,
    command: entry.command,
    env: entry.env ?? null,
    commandId: entry.commandId ?? null,
    lane: entry.lane ?? null,
    tier: entry.tier ?? null,
  });
}

function digestEntries(entries) {
  return createHash("sha256")
    .update(entries
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(canonicalEntry)
      .join("\n"))
    .digest("hex");
}

function digestIds(entries) {
  return createHash("sha256")
    .update(entries.slice().map((entry) => entry.id).sort().join("\n"))
    .digest("hex");
}

function loadAllowlist(path) {
  let allowlist;
  let allowlistText;
  try {
    allowlistText = readFileSync(path, "utf8");
    allowlist = JSON.parse(allowlistText);
  } catch (error) {
    fail(`cannot read allowlist ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  object(allowlist, "allowlist");
  if (/\b[0-9a-f]{40}\b|https?:\/\//i.test(allowlistText)) fail("allowlist cannot authorize SHA or URL rewrites");
  if (allowlist.schema !== "sdt-g40-ci-step-inventory-allowlist/v1") fail("allowlist has an unexpected schema");
  if (allowlist.baselineRef !== "origin/main") fail("allowlist must be reviewed against origin/main");
  if (typeof allowlist.reviewedRule !== "string" || allowlist.reviewedRule.length === 0) fail("allowlist.reviewedRule is required");
  for (const key of ["missingHistoricalWorkflow", "addedManifestCommands", "addedManifestClosure", "addedWorkflowSteps"]) {
    object(allowlist[key], `allowlist.${key}`);
    if (!Number.isInteger(allowlist[key].count) || allowlist[key].count < 0) fail(`allowlist.${key}.count must be a non-negative integer`);
    for (const digestKey of ["entrySetSha256", "idSetSha256"]) {
      if (typeof allowlist[key][digestKey] !== "string" || !/^[0-9a-f]{64}$/.test(allowlist[key][digestKey])) {
        fail(`allowlist.${key}.${digestKey} must be a SHA-256 digest`);
      }
    }
    if (typeof allowlist[key].reason !== "string" || allowlist[key].reason.length === 0) fail(`allowlist.${key}.reason is required`);
  }
  return allowlist;
}

function assertAllowlistedExactRewrite(allowlist, missing, additions) {
  const sections = [
    ["missingHistoricalWorkflow", missing, "workflow-run"],
    ["addedManifestCommands", additions.filter((entry) => entry.type === "manifest-command"), "manifest-command"],
    ["addedManifestClosure", additions.filter((entry) => ["npm-script", "npm-workspace-invocation", "npm-workspace-script"].includes(entry.type)), null],
    ["addedWorkflowSteps", additions.filter((entry) => entry.type === "workflow-run"), "workflow-run"],
  ];
  for (const [key, actual, expectedType] of sections) {
    const section = allowlist[key];
    if (expectedType !== null && actual.some((entry) => entry.type !== expectedType)) fail(`${key} contains an unexpected entry type`);
    if (actual.length !== section.count) fail(`${key} count mismatch: expected ${section.count}, got ${actual.length}`);
    const actualEntryDigest = digestEntries(actual);
    if (actualEntryDigest !== section.entrySetSha256) fail(`${key} exact command-text digest mismatch: expected ${section.entrySetSha256}, got ${actualEntryDigest}`);
    const actualIdDigest = digestIds(actual);
    if (actualIdDigest !== section.idSetSha256) fail(`${key} entry identity digest mismatch: expected ${section.idSetSha256}, got ${actualIdDigest}`);
  }
  const expectedMissingTypes = new Set(["workflow-run"]);
  if (new Set(missing.map((entry) => entry.type)).size !== expectedMissingTypes.size || !missing.every((entry) => expectedMissingTypes.has(entry.type))) {
    fail("historical inventory changes outside the reviewed workflow-to-manifest rewrite are not allowlisted");
  }
  const expectedAdditionCount = allowlist.addedManifestCommands.count + allowlist.addedManifestClosure.count + allowlist.addedWorkflowSteps.count;
  if (additions.length !== expectedAdditionCount) fail(`addition count mismatch: expected ${expectedAdditionCount}, got ${additions.length}`);
  return {
    schema: allowlist.schema,
    missingHistoricalWorkflow: allowlist.missingHistoricalWorkflow.count,
    addedManifestCommands: allowlist.addedManifestCommands.count,
    addedManifestClosure: allowlist.addedManifestClosure.count,
    addedWorkflowSteps: allowlist.addedWorkflowSteps.count,
    exactCommandText: true,
  };
}

function loadManifest(path, baselineHistory) {
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
  const cosmosLane = manifest.lanes.find((lane) => lane.name === "cosmos");
  const retainedHistory = cosmosLane?.commands?.find((command) => command.id === "cosmos-retained-history");
  if (retainedHistory === undefined || typeof retainedHistory.command !== "string") fail("cosmos-retained-history command is missing");
  const pinnedCosmosHistorySha = assertCosmosHistoryMatchesBaseline(retainedHistory.command, baselineHistory);
  return { manifest, commandTiers, pinnedCosmosHistorySha };
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
  const baseline = JSON.parse(readFileSync(options.baseline, "utf8"));
  const baselineHistory = deriveCosmosHistoryFromBaseline(baseline);
  const { manifest, pinnedCosmosHistorySha } = loadManifest(options.manifest, baselineHistory);
  const allowlist = loadAllowlist(options.allowlist);
  if (!manifest.lanes.some((lane) => lane.tier === "pr") || !manifest.lanes.some((lane) => lane.tier === "local")) fail("self-test requires PR and local lanes");
  process.stdout.write(`${JSON.stringify({ schema: "sdt-g40-ci-coverage-self-test/v1", lanes: manifest.lanes.length, allowlist: allowlist.schema, pinnedCosmosHistorySha, verified: ["one-tier-per-command", "runnable-local-lane", "full-includes-pr-and-local", "baseline-derived-cosmos-history"] }, null, 2)}\n`);
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
  const baselineHistory = deriveCosmosHistoryFromBaseline(baseline);
  const allowlist = loadAllowlist(options.allowlist);
  const { manifest, commandTiers, pinnedCosmosHistorySha } = loadManifest(options.manifest, baselineHistory);
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
  const allowlistResult = assertAllowlistedExactRewrite(allowlist, missing, additions);
  const { jobs, expectedJobs } = assertWorkflowUsesManifest(workflow, manifest);
  const result = {
    schema: "sdt-g40-ci-coverage-check/v2",
    tierCounts: Object.fromEntries(["pr", "local"].map((tier) => [tier, manifest.lanes.filter((lane) => lane.tier === tier).length])),
    manifestCommandCount: commandTiers.size,
    baselineLeafCommandCount: baselineEntries.size,
    currentLeafCommandCount: currentEntries.size,
    missing,
    additions,
    allowlist: allowlistResult,
    pinnedCosmosHistorySha,
    prJobs: expectedJobs,
    workflowJobs: [...jobs.keys()],
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
