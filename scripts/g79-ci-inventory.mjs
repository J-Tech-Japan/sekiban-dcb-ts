#!/usr/bin/env node
/**
 * Emit the hosted test/proof invocations declared by the repository CI lanes.
 *
 * This is an inventory of the workflow surface, not a claim that every lane
 * exposes assertion-level timing. Each row therefore carries an explicit
 * measurement status and budget-evidence location. G79's per-test reporter
 * supplies complete rows only for the G43 invocation; other lanes remain
 * honestly marked as partial or missing rather than inferred from file time.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const workflowPath = resolve(root, ".github/workflows/ci.yml");
const historicalSourceHead = "21427a58534efe8af4b3553322268f84fd6cbbd6";
const reviewedHead = "cd15a2729ea2aa062515012ad1938266856ede2b";

function commitSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function sourceReceiptClass(sha) {
  if (sha === historicalSourceHead) return "historical-source-head-21427a5";
  if (sha === reviewedHead) return "reviewed-head-cd15a27-docs-only-equivalent";
  return "current-source-head";
}

function laneMeasurement(job) {
  if (job === "ci-g43") {
    return {
      status: "complete-per-test-json",
      budgetLocation: "test/g43-tag-sql.spec.ts (AC6 10,000 ms); test/g43-measurement.spec.ts (60,000 ms retained)",
      basis: "SDT-G79_HOSTED_TEST_TIMING rows emit each assertion duration, budget, source, margin, and classification",
    };
  }
  if (job === "ci-foundation") {
    return {
      status: "partial-named-receipts",
      budgetLocation: "test/g67-safe-lane.spec.ts AC3 10,000 ms; other Vitest tests inherit vitest.config.ts default",
      basis: "hosted logs expose the named G67 AC3 duration; no universal assertion-level timing receipt is emitted by this lane",
    };
  }
  if (job === "ci-g44") {
    return {
      status: "partial-named-receipts",
      budgetLocation: "test/g67-safe-lane.spec.ts AC3 10,000 ms; remaining G44-family tests use their source/default budgets",
      basis: "hosted logs expose the named G67 AC3 duration; other lane invocations have no G79 assertion-level receipt",
    };
  }
  if (job === "ci-g46") {
    return {
      status: "partial-suite-and-g43-receipt",
      budgetLocation: "test/g43-measurement.spec.ts retained 60,000 ms; remaining G46 tests use source/default budgets",
      basis: "hosted logs expose suite and G43 measurement receipts, not a complete per-test inventory for the lane",
    };
  }
  return {
    status: "missing-per-test-receipt",
    budgetLocation: "not measured by SDT-G79; source-local budget or Vitest inherited default must be checked separately",
    basis: "workflow invocation is inventoried, but no supported per-test hosted timing receipt is available in this lane",
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

function inventory() {
  const jobs = parseJobs(readFileSync(workflowPath, "utf8"));
  const sha = commitSha();
  const rows = jobs.flatMap((job) => {
    const measurement = laneMeasurement(job.name);
    return job.commands.map((command, index) => ({
      workflowRunId: process.env.GITHUB_RUN_ID ?? null,
      workflowAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      commitSha: sha,
      sourceReceiptClass: sourceReceiptClass(sha),
      workflow: process.env.GITHUB_WORKFLOW ?? "CI",
      hostedJob: job.name,
      invocation: index + 1,
      command,
      ...measurement,
    }));
  });
  return { workflowPath, commitSha: sha, jobs: jobs.map((job) => job.name), invocations: rows };
}

function selfTest() {
  const result = inventory();
  const requiredJobs = [
    "ci-foundation",
    "ci-g43",
    "ci-g44",
    "ci-g46",
    "cosmos-emulator",
    "ci-coverage",
  ];
  const missingJobs = requiredJobs.filter((job) => !result.jobs.includes(job));
  if (missingJobs.length > 0) throw new Error(`SDT-G79 CI inventory missing jobs: ${missingJobs.join(", ")}`);
  if (!result.invocations.some((row) => row.hostedJob === "ci-g43" && row.command.includes("npm run test:g43"))) {
    throw new Error("SDT-G79 CI inventory did not find the G43 hosted invocation");
  }
  if (!result.invocations.some((row) => row.hostedJob === "ci-foundation" && row.command.includes("npm test"))) {
    throw new Error("SDT-G79 CI inventory did not find the foundation npm test invocation");
  }
  if (!result.invocations.some((row) => row.status === "missing-per-test-receipt")) {
    throw new Error("SDT-G79 CI inventory unexpectedly has complete timing for every lane");
  }
  console.log(JSON.stringify({
    jobs: result.jobs.length,
    invocations: result.invocations.length,
    selfTest: "required-lanes-and-explicit-missing-measurements-present",
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
    commitSha: result.commitSha,
    sourceReceiptClass: sourceReceiptClass(result.commitSha),
    workflowRunId: process.env.GITHUB_RUN_ID ?? null,
    workflowAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    workflow: process.env.GITHUB_WORKFLOW ?? "CI",
    jobs: result.jobs.length,
    invocations: result.invocations.length,
    completePerTestJobs: result.jobs.filter((job) => laneMeasurement(job).status === "complete-per-test-json"),
    partialMeasurementJobs: result.jobs.filter((job) => laneMeasurement(job).status.startsWith("partial-")),
    missingMeasurementJobs: result.jobs.filter((job) => laneMeasurement(job).status === "missing-per-test-receipt"),
  })}`);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file:").href) main();
