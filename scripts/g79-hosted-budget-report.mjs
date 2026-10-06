#!/usr/bin/env node
/**
 * Emit the supported Vitest JSON assertion durations used by SDT-G79.
 *
 * The G43 lane runs this after the normal test command has produced the JSON
 * report.  It does not make a timing decision or change a test result; it
 * makes the observed body duration, governing budget, remaining margin, and
 * inherited-versus-written source explicit in the hosted log.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";

const root = process.cwd();
const reportPath = resolve(root, process.argv[2] ?? ".artifacts/sdt-g79-vitest.json");
const inheritedBudgetMs = 5_000;
const nearBudgetFraction = 0.5;
const backlogTitle = "AC6: a backlog larger than one alarm budget progresses and re-arms instead of starving its tail";
const measurementTitle = "consumes the packet-owned measurement spec with real Tag DO SQL transitions and a closed range-plan predicate";

function normalizedFileName(fileName) {
  const value = relative(root, fileName).replaceAll("\\", "/");
  return value.startsWith("../") ? fileName.replaceAll("\\", "/") : value;
}

function budgetFor(fileName, title) {
  const normalized = normalizedFileName(fileName);
  if (normalized === "test/g43-tag-sql.spec.ts" && title === backlogTitle) {
    return { budgetMs: 10_000, source: "written per-test budget (SDT-G79)" };
  }
  if (normalized === "test/g43-measurement.spec.ts" && title === measurementTitle) {
    return { budgetMs: 60_000, source: "written per-test measurement budget retained from main" };
  }
  return { budgetMs: inheritedBudgetMs, source: "Vitest inherited default (no local budget)" };
}

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
    // pull_request workflows check out a synthetic merge commit.  The second
    // parent is the actual PR head whose source the receipt measures.
    if (parents.length >= 3 && (process.env.GITHUB_EVENT_NAME === "pull_request" || process.env.GITHUB_HEAD_REF)) {
      return parents[2];
    }
  } catch {
    // Keep the checked-out SHA when the hosted checkout does not expose its
    // parent graph (for example, a shallow non-PR invocation).
  }
  return checkoutSha;
}

function main() {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const files = report.testResults ?? [];
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`SDT-G79 timing report has no test files: ${reportPath}`);
  }

  const checkoutSha = checkedOutCommitSha();
  const commitSha = sourceHeadSha(checkoutSha);
  const receipt = {
    commitSha,
    workflowCheckoutSha: checkoutSha,
    workflowRunId: process.env.GITHUB_RUN_ID ?? null,
    workflowAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    workflow: process.env.GITHUB_WORKFLOW ?? null,
    job: process.env.GITHUB_JOB ?? null,
    invocation: process.env.SDT_G79_INVOCATION ?? "normal",
  };
  const rows = [];
  for (const file of files) {
    for (const assertion of file.assertionResults ?? []) {
      if (typeof assertion.duration !== "number") {
        throw new Error(`SDT-G79 timing report has no assertion duration: ${JSON.stringify(assertion)}`);
      }
      const title = assertion.title ?? assertion.fullName ?? "<unnamed>";
      const budget = budgetFor(file.name, title);
      const marginMs = budget.budgetMs - assertion.duration;
      const utilization = assertion.duration / budget.budgetMs;
      const row = {
        ...receipt,
        runId: process.env.GITHUB_RUN_ID ?? null,
        file: normalizedFileName(file.name),
        title,
        observedDurationMs: assertion.duration,
        budgetMs: budget.budgetMs,
        marginMs,
        utilization: Number(utilization.toFixed(4)),
        budgetSource: budget.source,
        classification: utilization >= nearBudgetFraction ? "near-budget" : "comfortable",
        status: assertion.status,
      };
      if (assertion.status !== "passed") {
        throw new Error(`SDT-G79 timing report contains a non-passing assertion: ${JSON.stringify(row)}`);
      }
      rows.push(row);
      console.log(`SDT-G79_HOSTED_TEST_TIMING ${JSON.stringify(row)}`);
    }
  }
  if (rows.length === 0) throw new Error("SDT-G79 timing report contains no assertions");
  console.log(`SDT-G79_HOSTED_TEST_TIMING_SUMMARY ${JSON.stringify({
    ...receipt,
    runId: process.env.GITHUB_RUN_ID ?? null,
    reportPath,
    inheritedBudgetMs,
    nearBudgetFraction,
    tests: rows.length,
    nearBudget: rows.filter((row) => row.classification === "near-budget").map((row) => row.title),
    comfortable: rows.filter((row) => row.classification === "comfortable").map((row) => row.title),
  })}`);
}

main();
