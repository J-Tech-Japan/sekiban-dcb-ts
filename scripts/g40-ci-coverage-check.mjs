#!/usr/bin/env node
/** Enforce SDT-G40's pre-split CI command inventory as a set inclusion gate. */
import { readFileSync } from "node:fs";
import { generateInventory, readWorkspacePackageTexts } from "./g40-ci-step-inventory.mjs";

const DEFAULT_BASELINE = "docs/evidence/SDT-G40-ci-step-inventory-baseline.json";
const DEFAULT_WORKFLOW = ".github/workflows/ci.yml";
const DEFAULT_PACKAGE = "package.json";

function fail(message) {
  throw new Error(`g40-ci-coverage-check:${message}`);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function parseArguments(argv) {
  const options = { baseline: DEFAULT_BASELINE, workflow: DEFAULT_WORKFLOW, packagePath: DEFAULT_PACKAGE };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--baseline") options.baseline = argv[++index];
    else if (argument === "--workflow") options.workflow = argv[++index];
    else if (argument === "--package") options.packagePath = argv[++index];
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

function assertPullRequestReachability(workflow, jobs) {
  if (!/^ {2}pull_request:\s*$/m.test(workflow)) fail("ci.yml no longer has a pull_request trigger");
  if (/^\s*schedule:\s*$/m.test(workflow)) fail("scheduled execution is not an allowed G40 relocation target");
  for (const [name, block] of jobs) {
    if (/github\.event_name\s*(?:==|!=)\s*['"]schedule['"]/.test(block)) {
      fail(`${name} makes CI reachability conditional on schedule`);
    }
  }
}

function assertVerifyAggregation(jobs) {
  const verify = jobs.get("verify");
  if (verify === undefined) fail("aggregate job named verify is missing");
  if (!/^ {4}if:\s*\$\{\{\s*always\(\)\s*\}\}\s*$/m.test(verify)) {
    fail("verify must use always() so failed or skipped dependencies are observed");
  }
  const needsMatch = verify.match(/^ {4}needs:\s*\[([^\]]+)\]\s*$/m);
  if (needsMatch === null) fail("verify needs must be an explicit list");
  const actualNeeds = new Set(needsMatch[1].split(",").map((entry) => entry.trim()).filter(Boolean));
  const expectedNeeds = new Set([...jobs.keys()].filter((name) => name !== "verify"));
  const missing = [...expectedNeeds].filter((name) => !actualNeeds.has(name));
  const unexpected = [...actualNeeds].filter((name) => !expectedNeeds.has(name));
  if (missing.length > 0 || unexpected.length > 0) {
    fail(`verify needs mismatch; missing=[${missing.join(", ")}], unexpected=[${unexpected.join(", ")}]`);
  }
  if (!/G40_VERIFY_NEEDS_JSON:\s*\$\{\{\s*toJson\(needs\)\s*\}\}/.test(verify)) {
    fail("verify does not pass the complete needs result set to its aggregator checker");
  }
  if (!/node scripts\/g40-verify-needs\.mjs/.test(verify)) fail("verify does not execute the dependency-result checker");
}

function inventoryEntries(document, label) {
  object(document, label);
  if (document.schema !== "sdt-g40-ci-step-inventory/v1") fail(`${label} has an unexpected schema`);
  if (!Array.isArray(document.leafCommands) || document.leafCommands.length === 0) fail(`${label}.leafCommands must be a non-empty array`);
  const entries = new Map();
  for (const entry of document.leafCommands) {
    object(entry, `${label}.leafCommands[]`);
    if (typeof entry.id !== "string" || entry.id.length === 0 || typeof entry.command !== "string") {
      fail(`${label} has an invalid command entry`);
    }
    if (entries.has(entry.id)) fail(`${label} repeats command id ${entry.id}`);
    entries.set(entry.id, entry);
  }
  return entries;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const workflow = readFileSync(options.workflow, "utf8");
  const packageText = readFileSync(options.packagePath, "utf8");
  const baseline = JSON.parse(readFileSync(options.baseline, "utf8"));
  const current = generateInventory({
    workflowText: workflow,
    packageText,
    workspacePackageTexts: readWorkspacePackageTexts(packageText, (path) => readFileSync(path, "utf8")),
    source: { workflow: options.workflow, packageJson: options.packagePath, ref: "working-tree" },
  });
  const baselineEntries = inventoryEntries(baseline, "baseline");
  const currentEntries = inventoryEntries(current, "current");
  const missing = [...baselineEntries.values()].filter((entry) => !currentEntries.has(entry.id));
  const additions = [...currentEntries.values()].filter((entry) => !baselineEntries.has(entry.id));

  const jobs = extractJobBlocks(workflow);
  assertPullRequestReachability(workflow, jobs);
  assertVerifyAggregation(jobs);

  const result = {
    schema: "sdt-g40-ci-coverage-check/v1",
    baselineLeafCommandCount: baselineEntries.size,
    currentLeafCommandCount: currentEntries.size,
    missing,
    additions,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (missing.length > 0) {
    fail(`pre-split command inventory has ${missing.length} missing entry(s): ${missing.map((entry) => entry.id).join(", ")}`);
  }
}

main();
