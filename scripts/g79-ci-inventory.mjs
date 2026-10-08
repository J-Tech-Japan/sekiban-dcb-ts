#!/usr/bin/env node
/**
 * Emit the hosted test/proof invocations declared by the repository CI lanes.
 *
 * This is an inventory of the workflow surface. Every Vitest invocation is
 * wired to the same hosted reporter, including commands reached through an
 * npm script and the alternate Vitest configs. Non-Vitest proof commands are
 * retained as proof-only rows instead of being misreported as test timing.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const workflowPath = resolve(root, ".github/workflows/ci.yml");
const manifestPath = resolve(root, "ci/lanes.json");
const packageJsonPath = resolve(root, "package.json");

function checkedOutCommitSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function sourceHeadSha(checkoutSha) {
  if (!checkoutSha) return null;
  try {
    const parents = execFileSync("git", ["rev-list", "--parents", "-n", "1", checkoutSha], {
      cwd: root,
      encoding: "utf8",
    }).trim().split(/\s+/);
    // pull_request workflows check out a synthetic merge commit.  Keep both
    // identities: commitSha is the PR source head, while workflowCheckoutSha
    // records the actual merge commit tested by Actions.
    if (parents.length >= 3 && (process.env.GITHUB_EVENT_NAME === "pull_request" || process.env.GITHUB_HEAD_REF)) {
      return parents[2];
    }
  } catch {
    // A shallow non-PR checkout may not expose a parent graph.
  }
  return checkoutSha;
}

function packageScripts() {
  try {
    return JSON.parse(readFileSync(packageJsonPath, "utf8")).scripts ?? {};
  } catch {
    return {};
  }
}

function laneManifest() {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return { lanes: [] };
  }
}

function expandsToVitest(command, scripts, seen = new Set()) {
  if (/\bvitest(?:\s+run)?\b/.test(command)) return true;
  const references = [...command.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g)].map((match) => match[1]);
  for (const reference of references) {
    if (seen.has(reference) || scripts[reference] === undefined) continue;
    const next = new Set(seen);
    next.add(reference);
    if (expandsToVitest(scripts[reference], scripts, next)) return true;
  }
  if (/\bnpm\s+test\b/.test(command) && scripts.test !== undefined && !seen.has("test")) {
    return expandsToVitest(scripts.test, scripts, new Set([...seen, "test"]));
  }
  return false;
}

function laneMeasurement(command, scripts) {
  if (expandsToVitest(command, scripts)) {
    return {
      status: "per-test-reporter-required",
      budgetLocation: "test source declaration, CLI --testTimeout when present, or Vitest inherited default; emitted by g79-vitest-hosted-reporter.mjs",
      basis: "supported Vitest TestCase diagnostics emit each observed duration, budget origin, margin classification, and censored state",
      receipt: "SDT-G79_HOSTED_TEST_TIMING",
    };
  }
  return {
    status: "proof-only-no-test-cases",
    budgetLocation: "not applicable: this invocation runs a guard, mutation oracle, build, packaging, or other non-Vitest proof",
    basis: "retain the command in the lane inventory without inventing a per-test timing receipt",
    receipt: "command exit status and guard-specific receipt",
  };
}

function isTestInvocation(command) {
  return /(?:npm\s+(?:run\s+)?test|npm\s+run\s+(?:e2e|measure|conformance)|vitest\s+run|node\s+(?:scripts|tools)|python3\s+scripts|bash\s+scripts)/i.test(command);
}

function parseJobs(workflow) {
  const lines = workflow.split(/\r?\n/);
  const jobs = [];
  let current = null;
  let inJobs = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "jobs:") {
      inJobs = true;
      continue;
    }
    const jobHeader = inJobs ? line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/) : null;
    if (jobHeader) {
      current = { name: jobHeader[1], commands: [] };
      jobs.push(current);
      continue;
    }
    if (!current) continue;
    const run = line.match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!run) continue;
    const indent = run[1].length;
    const value = run[2].trim();
    const commandLines = [];
    if (value !== "|" && value !== ">-" && value !== ">") {
      commandLines.push(value);
    } else {
      for (let next = index + 1; next < lines.length; next += 1) {
        const continuation = lines[next];
        if (continuation.trim() === "") continue;
        const continuationIndent = continuation.match(/^\s*/)[0].length;
        if (continuationIndent <= indent) break;
        commandLines.push(continuation.trim());
        index = next;
      }
    }
    for (const command of commandLines) {
      if (isTestInvocation(command)) current.commands.push(command);
    }
  }
  return jobs;
}

function expandManifestRunnerCommand(command, manifest) {
  const match = command.match(/node scripts\/ci-local\.mjs --lane ([A-Za-z0-9-]+) --ci/);
  if (!match) return null;
  const lane = manifest?.lanes?.find((entry) => entry?.name === match[1]);
  if (!lane) return null;
  return lane.commands.map((entry) => ({
    command: entry.command,
    executionTier: lane.tier,
    lane: lane.name,
    commandId: entry.id,
  }));
}

function manifestRows(manifest, scripts, metadata) {
  return (manifest?.lanes ?? [])
    .filter((lane) => lane.tier === "local")
    .flatMap((lane) => lane.commands.map((entry, index) => ({
      ...metadata,
      workflow: "ci-local",
      hostedJob: `local:${lane.name}`,
      executionTier: lane.tier,
      lane: lane.name,
      commandId: entry.id,
      invocation: index + 1,
      command: entry.command,
      ...laneMeasurement(entry.command, scripts),
    })));
}

function inventory() {
  const jobs = parseJobs(readFileSync(workflowPath, "utf8"));
  const manifest = laneManifest();
  const scripts = packageScripts();
  const workflowCheckoutSha = checkedOutCommitSha();
  const sha = sourceHeadSha(workflowCheckoutSha);
  const metadata = {
    workflowRunId: process.env.GITHUB_RUN_ID ?? null,
    workflowAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    commitSha: sha,
    workflowCheckoutSha,
    workflow: process.env.GITHUB_WORKFLOW ?? "CI",
  };
  const workflowRows = jobs.flatMap((job) => job.commands.flatMap((command, index) => {
    const expanded = expandManifestRunnerCommand(command, manifest);
    if (expanded !== null) {
      return expanded.map((entry, expandedIndex) => ({
        ...metadata,
        hostedJob: job.name,
        executionTier: entry.executionTier,
        lane: entry.lane,
        commandId: entry.commandId,
        invocation: expandedIndex + 1,
        command: entry.command,
        ...laneMeasurement(entry.command, scripts),
      }));
    }
    return [{
      ...metadata,
      hostedJob: job.name,
      executionTier: "workflow",
      invocation: index + 1,
      command,
      ...laneMeasurement(command, scripts),
    }];
  }));
  const rows = [...workflowRows, ...manifestRows(manifest, scripts, metadata)];
  return {
    workflowPath,
    manifestPath,
    commitSha: sha,
    workflowCheckoutSha,
    jobs: jobs.map((job) => job.name),
    manifestLanes: (manifest.lanes ?? []).map((lane) => ({ name: lane.name, tier: lane.tier })),
    invocations: rows,
  };
}

function selfTest() {
  const result = inventory();
  const requiredJobs = [
    "ci-foundation",
    "ci-pr-cheap",
    "verify",
  ];
  const missingJobs = requiredJobs.filter((job) => !result.jobs.includes(job));
  if (missingJobs.length > 0) throw new Error(`SDT-G79 CI inventory missing jobs: ${missingJobs.join(", ")}`);
  if (!result.invocations.some((row) => row.hostedJob === "local:tag-sql-measurement" && row.executionTier === "local" && row.command.includes("npm run test:tag-sql:measurement"))) {
    throw new Error("SDT-G79 CI inventory did not find the G43 local-manifest invocation");
  }
  if (!result.invocations.some((row) => row.hostedJob === "ci-foundation" && row.executionTier === "pr" && row.command.includes("npm test"))) {
    throw new Error("SDT-G79 CI inventory did not expand the foundation npm test invocation");
  }
  if (result.invocations.some((row) => row.status === "missing-per-test-receipt" || row.status === "partial-named-receipts")) {
    throw new Error("SDT-G79 CI inventory retained a stale partial/missing timing classification");
  }
  if (!result.invocations.some((row) => row.status === "per-test-reporter-required" && row.hostedJob === "ci-foundation" && row.executionTier === "pr")) {
    throw new Error("SDT-G79 CI inventory did not classify the foundation Vitest invocation for hosted measurement");
  }
  console.log(JSON.stringify({
    jobs: result.jobs.length,
    invocations: result.invocations.length,
    selfTest: "required-lanes-and-reporter-or-proof-classification-present",
  }));
}

function main() {
  const result = inventory();
  if (process.argv.includes("--self-test")) return selfTest();
  for (const row of result.invocations) {
    console.log(`SDT-G79_HOSTED_CI_INVOCATION ${JSON.stringify(row)}`);
  }
  console.log(`SDT-G79_HOSTED_CI_INVOCATION_SUMMARY ${JSON.stringify({
    workflowPath,
    manifestPath,
    commitSha: result.commitSha,
    workflowCheckoutSha: result.workflowCheckoutSha,
    workflowRunId: process.env.GITHUB_RUN_ID ?? null,
    workflowAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    workflow: process.env.GITHUB_WORKFLOW ?? "CI",
    jobs: result.jobs.length,
    invocations: result.invocations.length,
    perTestReporterInvocations: result.invocations.filter((row) => row.status === "per-test-reporter-required").length,
    proofOnlyInvocations: result.invocations.filter((row) => row.status === "proof-only-no-test-cases").length,
  })}`);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file:").href) main();
