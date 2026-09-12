#!/usr/bin/env node
/**
 * SDT-G83 AC4 proof mutations for the five hosted budget-edge tests.
 *
 * Each temporary mutation changes the behavior exercised by one named test
 * and runs that test through Vitest's JSON reporter. A red result is accepted
 * only when it is a normal status-1 process result whose one named oracle is
 * the sole failed assertion and contains the expected/received boundary
 * values. Setup, import, database, timeout, signal, missing-target, and
 * unrelated failures are rejected. The source file is restored in finally.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const vitest = [
  resolve(root, "node_modules/vitest/vitest.mjs"),
  resolve(root, "../node_modules/vitest/vitest.mjs"),
].find((candidate) => existsSync(candidate));
if (vitest === undefined) throw new Error("SDT-G83 mutation runner: Vitest executable is unavailable");

const mutations = Object.freeze([
  {
    id: "commit-ac7-fault-path",
    sourceFile: "test/commit.spec.ts",
    testFile: "test/commit.spec.ts",
    oracle: "AC7: allocation and cancellation faults leave inspectable allocator and tag facts without Journal recovery",
    from: "}, \"journal-cas-after-allocator\", allocationAttempt);",
    to: "}, \"journal-cas-after-allocator-mutant\", allocationAttempt);",
    expectedValues: ["504", "200"],
    semanticBoundary: "AC7 timeout response must remain 504 rather than a successful 200",
  },
  {
    id: "tag-g5-clear-key",
    sourceFile: "test/tag.spec.ts",
    testFile: "test/tag.spec.ts",
    oracle: "G5: treats fences as an exact-key durable set and gates acquire and append in the specified order",
    from: `      reason: "repair-b",
      attemptId: "fence-owner-b",
      epoch: 1,
    })).status).toBe(200);
    expect((await post(scope, "/append", {`,
    to: `      reason: "repair-b-mutant",
      attemptId: "fence-owner-b",
      epoch: 1,
    })).status).toBe(200);
    expect((await post(scope, "/append", {`,
    expectedValues: ["201", "500"],
    semanticBoundary: "G5 exact-key clear must release the installed fence so the subsequent append returns 201 rather than the blocked 500",
  },
  {
    id: "repair-branch-b-binding-status",
    sourceFile: "test/repair.spec.ts",
    testFile: "test/repair.spec.ts",
    oracle: "takes Branch B without advancing Tag head/version and reaches the provider-internal exclusion binding",
    from: "        return new Response(null, { status: 204 });",
    to: "        return new Response(null, { status: 500 });",
    expectedValues: ["200", "500"],
    semanticBoundary: "Branch B exclusion binding must produce the public 200 result rather than 500",
  },
  {
    id: "repair-six-boundary-fault",
    sourceFile: "test/repair.spec.ts",
    testFile: "test/repair.spec.ts",
    oracle: "re-queries Tag facts across all six crash/race boundaries and converges without a Response.error TypeError",
    from: `      "after-clear-before-final-observation",`,
    to: `      "after-clear-before-final-observation-mutant",`,
    expectedValues: ["202", "200"],
    semanticBoundary: "each named crash boundary must produce the interrupted 202 observation before convergence",
  },
  {
    id: "g69-safe-reader-substitution",
    sourceFile: "test/g69-ordering.spec.ts",
    testFile: "test/g69-ordering.spec.ts",
    oracle: "drives clock schedules through real MV generations and the public safe reader",
    from: `    const safe = await publicGenerationRead(serviceId, mv, "safe");`,
    to: `    const safe = await publicGenerationRead(serviceId, mv, "unsafe");`,
    expectedValues: ["503", "200"],
    semanticBoundary: "a quarantined late-lower case must remain safe 503 rather than unsafe 200",
    configFile: "vitest.g69.config.ts",
  },
]);

let reportDirectory;
let currentOracle;

function nextReportPath(label) {
  reportDirectory ??= mkdtempSync(join(tmpdir(), "sdt-g83-mutation-"));
  return join(reportDirectory, `${label.replaceAll(/[^a-z0-9-]/gi, "_")}.json`);
}

function serializeSpawnError(error) {
  if (error === undefined) return undefined;
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    errno: error.errno,
    syscall: error.syscall,
  };
}

function readStructuredReport(reportPath) {
  if (!existsSync(reportPath)) return undefined;
  try {
    return JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    return undefined;
  }
}

function runOracle(mutation, label) {
  const reportPath = nextReportPath(`${mutation.id}-${label}`);
  let result;
  try {
    result = spawnSync(process.execPath, [
      vitest,
      "run",
      "--config", mutation.configFile ?? "vitest.config.ts",
      "--no-cache",
      "--maxWorkers=1",
      mutation.testFile,
      "--testNamePattern", mutation.oracle,
      "--reporter=json",
      "--outputFile", reportPath,
    ], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, CI: "1" },
    });
  } catch (error) {
    return {
      label,
      status: null,
      signal: null,
      error: serializeSpawnError(error),
      output: "",
      reportPath,
      report: readStructuredReport(reportPath),
    };
  }
  return {
    label,
    status: result.status,
    signal: result.signal,
    error: serializeSpawnError(result.error),
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    reportPath,
    report: readStructuredReport(reportPath),
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertionResults(report) {
  if (!isRecord(report) || !Array.isArray(report.testResults)) return [];
  return report.testResults.flatMap((file) => isRecord(file) && Array.isArray(file.assertionResults)
    ? file.assertionResults
    : []);
}

function namedAssertions(report, oracle = currentOracle) {
  return assertionResults(report).filter((assertion) =>
    isRecord(assertion) && assertion.title === oracle,
  );
}

function processReceipt(result) {
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
  };
}

function resultSummary(result, mutation = undefined) {
  return {
    ...processReceipt(result),
    reportPath: result.reportPath ?? null,
    reportSuccess: result.report?.success ?? null,
    totalTests: result.report?.numTotalTests ?? null,
    failedTests: result.report?.numFailedTests ?? null,
    oracle: mutation?.oracle ?? currentOracle ?? null,
    assertions: assertionResults(result.report).map((assertion) => ({
      title: assertion.title ?? null,
      fullName: assertion.fullName ?? null,
      status: assertion.status ?? null,
      failureMessages: assertion.failureMessages ?? [],
    })),
  };
}

function requirePass(result, mutation) {
  if (result.status !== 0 || result.signal !== null || result.error !== undefined) {
    throw new Error(`${result.label} was not a clean green process result: ${JSON.stringify(resultSummary(result, mutation))}`);
  }
  if (result.report?.success !== true) {
    throw new Error(`${result.label} did not produce a successful structured Vitest report: ${JSON.stringify(resultSummary(result, mutation))}`);
  }
  const matches = namedAssertions(result.report, mutation.oracle);
  if (matches.length !== 1 || matches[0].status !== "passed") {
    throw new Error(`${result.label} did not pass exactly the named oracle: ${JSON.stringify(resultSummary(result, mutation))}`);
  }
}

function containsForbiddenFailureText(message) {
  return /timed?\s*out|timeout|setup|import|database|cannot find module|worker.*(?:killed|exit)|unhandled/i.test(message);
}

function requireSemanticRed(result, mutation) {
  if (result.status !== 1 || result.signal !== null || result.error !== undefined) {
    throw new Error(`${mutation.id} was not a normal status-1 process result: ${JSON.stringify(resultSummary(result, mutation))}`);
  }
  if (result.report?.success !== false) {
    throw new Error(`${mutation.id} did not produce a failed structured Vitest report: ${JSON.stringify(resultSummary(result, mutation))}`);
  }
  const assertions = assertionResults(result.report);
  const named = namedAssertions(result.report, mutation.oracle);
  if (named.length !== 1) {
    throw new Error(`${mutation.id} did not fail exactly the named oracle: ${JSON.stringify(resultSummary(result, mutation))}`);
  }
  const failed = assertions.filter((assertion) => assertion.status === "failed");
  if (failed.length !== 1 || failed[0] !== named[0]) {
    throw new Error(`${mutation.id} had an unrelated or multiple failed assertion: ${JSON.stringify(resultSummary(result, mutation))}`);
  }
  if (named[0].status !== "failed") {
    throw new Error(`${mutation.id} named oracle was not failed: ${JSON.stringify(resultSummary(result, mutation))}`);
  }
  const failures = Array.isArray(named[0].failureMessages)
    ? named[0].failureMessages.filter((message) => typeof message === "string")
    : [];
  if (failures.length === 0) {
    throw new Error(`${mutation.id} named oracle had no failure message: ${JSON.stringify(resultSummary(result, mutation))}`);
  }
  const excerpt = failures.join("\n");
  if (failures.some(containsForbiddenFailureText)) {
    throw new Error(`${mutation.id} was a timeout/setup/import/database failure rather than a semantic assertion: ${JSON.stringify(resultSummary(result, mutation))}`);
  }
  const missingValues = mutation.expectedValues.filter((value) => !excerpt.includes(value));
  if (missingValues.length > 0) {
    throw new Error(`${mutation.id} did not retain expected/received values ${missingValues.join(", ")}: ${JSON.stringify(resultSummary(result, mutation))}`);
  }
  if (typeof result.report.numFailedTests === "number" && result.report.numFailedTests !== 1) {
    throw new Error(`${mutation.id} reported ${result.report.numFailedTests} failed tests: ${JSON.stringify(resultSummary(result, mutation))}`);
  }
  return {
    ...resultSummary(result, mutation),
    semanticBoundary: mutation.semanticBoundary,
    failureExcerpt: excerpt,
    expectedReceivedValues: mutation.expectedValues,
  };
}

function expectRejected(label, callback) {
  try {
    callback();
  } catch {
    return;
  }
  throw new Error(`SDT-G83 validator self-test accepted ${label}`);
}

function syntheticResult(mutation, overrides = {}) {
  const oracle = mutation.oracle;
  const [expected, received] = mutation.expectedValues;
  const assertion = {
    title: oracle,
    fullName: oracle,
    status: "failed",
    failureMessages: [`AssertionError: expected ${expected} to be ${received}`],
    ...overrides.assertion,
  };
  return {
    label: "synthetic",
    status: 1,
    signal: null,
    error: undefined,
    reportPath: "/private/tmp/sdt-g83-self-test.json",
    report: {
      success: false,
      numTotalTests: 1,
      numPassedTests: 0,
      numFailedTests: 1,
      testResults: [{ assertionResults: [assertion] }],
      ...overrides.report,
    },
    output: "",
    ...overrides,
  };
}

function mutate(source, mutation) {
  const occurrences = source.split(mutation.from).length - 1;
  if (occurrences !== 1) {
    throw new Error(`${mutation.id} anchor expected once in ${mutation.sourceFile}, found ${occurrences}`);
  }
  return source.replace(mutation.from, mutation.to);
}

function runMutation(mutation) {
  const sourcePath = resolve(root, mutation.sourceFile);
  const original = readFileSync(sourcePath, "utf8");
  currentOracle = mutation.oracle;
  try {
    requirePass(runOracle(mutation, "healthy-control"), mutation);
    writeFileSync(sourcePath, mutate(original, mutation), "utf8");
    const red = runOracle(mutation, "semantic-mutant");
    const evidence = requireSemanticRed(red, mutation);
    return {
      id: mutation.id,
      sourceFile: mutation.sourceFile,
      testFile: mutation.testFile,
      oracle: mutation.oracle,
      result: "red",
      process: evidence,
      evidence,
    };
  } finally {
    writeFileSync(sourcePath, original, "utf8");
  }
}

function selfTest() {
  for (const mutation of mutations) {
    const original = readFileSync(resolve(root, mutation.sourceFile), "utf8");
    mutate(original, mutation);
  }
  const mutation = mutations[0];
  currentOracle = mutation.oracle;
  const valid = syntheticResult(mutation);
  const accepted = requireSemanticRed(valid, mutation);
  if (!accepted.failureExcerpt.includes(mutation.expectedValues[0])) {
    throw new Error("SDT-G83 self-test did not retain the semantic failure excerpt");
  }
  expectRejected("green escape", () => requireSemanticRed(syntheticResult(mutation, {
    status: 0,
    report: { ...valid.report, success: true },
  }), mutation));
  expectRejected("missing report", () => requireSemanticRed(syntheticResult(mutation, { report: undefined }), mutation));
  expectRejected("signal termination", () => requireSemanticRed(syntheticResult(mutation, { signal: "SIGTERM" }), mutation));
  expectRejected("spawn error", () => requireSemanticRed(syntheticResult(mutation, {
    status: null,
    error: { name: "Error", message: "spawn failed" },
    report: undefined,
  }), mutation));
  expectRejected("timeout", () => requireSemanticRed(syntheticResult(mutation, {
    report: {
      testResults: [{ assertionResults: [{
        title: mutation.oracle,
        fullName: mutation.oracle,
        status: "failed",
        failureMessages: ["Test timed out in 5000ms"],
      }] }],
    },
  }), mutation));
  expectRejected("setup/import/database failure", () => requireSemanticRed(syntheticResult(mutation, {
    report: {
      testResults: [{ assertionResults: [{
        title: "setup/import/database failure",
        fullName: "setup/import/database failure",
        status: "failed",
        failureMessages: ["database setup failed"],
      }] }],
    },
  }), mutation));
  expectRejected("missing target", () => requireSemanticRed(syntheticResult(mutation, {
    report: {
      testResults: [{ assertionResults: [{
        title: "unrelated test",
        fullName: "unrelated test",
        status: "failed",
        failureMessages: ["expected 504 to be 200"],
      }] }],
    },
  }), mutation));
  expectRejected("unrelated assertion", () => requireSemanticRed(syntheticResult(mutation, {
    report: {
      testResults: [{ assertionResults: [
        { title: mutation.oracle, fullName: mutation.oracle, status: "passed", failureMessages: [] },
        { title: "unrelated test", fullName: "unrelated test", status: "failed", failureMessages: ["expected 504 to be 200"] },
      ] }],
    },
  }), mutation));
  process.stdout.write(`${JSON.stringify({
    sourceFiles: [...new Set(mutations.map(({ sourceFile }) => sourceFile))],
    mutations: mutations.map(({ id }) => id),
    selfTest: "anchors-and-structured-semantic-red-validator",
    rejected: ["green", "missing-report", "signal", "spawn-error", "timeout", "setup-import-database", "missing-target", "unrelated"],
  })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  try {
    const rows = mutations.map(runMutation);
    process.stdout.write(`${JSON.stringify({ result: "all-g83-behavioral-mutants-red", rows })}\n`);
  } finally {
    if (reportDirectory !== undefined) rmSync(reportDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
