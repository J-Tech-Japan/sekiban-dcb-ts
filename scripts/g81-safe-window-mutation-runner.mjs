#!/usr/bin/env node
/**
 * Run SDT-G81's two semantic SafeWindow mutants against one selected public
 * AC3 boundary oracle. Product sources are temporary mutation targets and are
 * restored even when a focused run fails.
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
if (vitest === undefined) {
  throw new Error("G81 SafeWindow mutation runner: Vitest executable is unavailable");
}

const G81_TEST_FILE = "test/read.spec.ts";
const G81_ORACLE_NAME = "[G81] AC3 proves exact 120000 and 120001 ms boundaries through the public reader";
const G81_ORACLE_PATTERN = "\\[G81\\] AC3 proves exact 120000 and 120001 ms boundaries through the public reader";
const G81_PUBLIC_STATUS_ASSERTION = "G81 AC3 boundary capture";
const SGR_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export const G81_MUTATIONS = Object.freeze([
  {
    id: "remove-ceiling-check",
    sourceFile: "packages/dcb-runtime/src/read/SerializedReadWorker.ts",
    from: "if (safeWindowCeilingExceeded(dynamicLagBoundMs)) {",
    to: "if (false) {",
    boundaryLagMs: 120_001,
    expectedStatus: 500,
    receivedStatus: 200,
  },
  {
    id: "ceiling-greater-or-equal",
    sourceFile: "packages/dcb-runtime/src/safeWindow.ts",
    from: "return dynamicLagBoundMs > MAX_PUBLISHED_SAFE_WINDOW_MS;",
    to: "return dynamicLagBoundMs >= MAX_PUBLISHED_SAFE_WINDOW_MS;",
    boundaryLagMs: 120_000,
    expectedStatus: 200,
    receivedStatus: 500,
  },
]);

let reportDirectory;
let reportCounter = 0;

function fail(message) {
  throw new Error("G81 SafeWindow mutation runner: " + message);
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

function processReceipt(result) {
  return {
    status: result.status,
    signal: result.signal,
    error: result.error ?? null,
  };
}

function nextReportPath(label) {
  reportDirectory ??= mkdtempSync(join(tmpdir(), "sdt-g81-mutation-"));
  reportCounter += 1;
  return join(reportDirectory, reportCounter + "-" + label.replaceAll(/[^a-z0-9-]/gi, "_") + ".json");
}

function readStructuredReport(reportPath) {
  if (!existsSync(reportPath)) {
    return {
      report: undefined,
      reportError: "Vitest did not produce a structured JSON report",
    };
  }
  try {
    return {
      report: JSON.parse(readFileSync(reportPath, "utf8")),
      reportError: undefined,
    };
  } catch (error) {
    return {
      report: undefined,
      reportError: "Vitest JSON report could not be parsed: " + String(error),
    };
  }
}

function run(command, args, label) {
  let result;
  try {
    result = spawnSync(command, args, {
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
    };
  }
  return {
    label,
    status: result.status,
    signal: result.signal,
    error: serializeSpawnError(result.error),
    output: (result.stdout ?? "") + (result.stderr ?? ""),
  };
}

function runVitest(args, label) {
  const reportPath = nextReportPath(label);
  let result;
  try {
    result = spawnSync(process.execPath, [
      vitest,
      ...args,
      "--reporter=json",
      "--outputFile",
      reportPath,
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
      report: undefined,
      reportError: "Vitest could not be spawned: " + String(error),
    };
  }
  return {
    label,
    status: result.status,
    signal: result.signal,
    error: serializeSpawnError(result.error),
    output: (result.stdout ?? "") + (result.stderr ?? ""),
    ...readStructuredReport(reportPath),
  };
}

function runOracle(label) {
  return runVitest([
    "run",
    "--config",
    "vitest.config.ts",
    "--no-cache",
    "--maxWorkers=1",
    G81_TEST_FILE,
    "--testNamePattern",
    G81_ORACLE_PATTERN,
  ], label);
}

function buildPackages() {
  return run("npm", ["run", "build:packages", "--silent"], "G81 package build");
}

function requireCleanProcess(result) {
  if (result.status !== 0 || result.signal !== null || result.error !== undefined) {
    fail(result.label + " did not produce a clean process result: " + JSON.stringify(processReceipt(result)) + "\n" + result.output);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertionResults(report) {
  const files = report?.testResults;
  if (!Array.isArray(files)) return [];
  return files.flatMap((file) => Array.isArray(file?.assertionResults) ? file.assertionResults : []);
}

function reportShape(report) {
  const files = report?.testResults;
  const assertions = assertionResults(report);
  const executed = assertions.filter((assertion) => assertion?.status !== "skipped");
  const named = executed.filter((assertion) => isNamedOracle(assertion));
  return { files, assertions, executed, named };
}

function isNamedOracle(assertion) {
  return isRecord(assertion) &&
    assertion.title === G81_ORACLE_NAME &&
    typeof assertion.fullName === "string" &&
    assertion.fullName.endsWith(" " + G81_ORACLE_NAME);
}

function requireG81FileAndOracle(result, expectedStatus) {
  if (!isRecord(result.report) || result.reportError !== undefined) {
    fail(result.label + " did not produce a structured report: " + JSON.stringify({
      reportError: result.reportError,
      report: result.report,
    }));
  }
  const shape = reportShape(result.report);
  if (!Array.isArray(shape.files) || shape.files.length !== 1) {
    fail(result.label + " did not report exactly one test file");
  }
  const fileName = shape.files[0]?.name;
  if (typeof fileName !== "string" || !fileName.endsWith(G81_TEST_FILE)) {
    fail(result.label + " reported an unexpected test file: " + String(fileName));
  }
  if (shape.executed.length !== 1 || shape.named.length !== 1) {
    fail(result.label + " did not select only the named G81 AC3 oracle: " + JSON.stringify({
      executed: shape.executed,
      named: shape.named,
    }));
  }
  if (shape.named[0].status !== expectedStatus) {
    fail(result.label + " named G81 AC3 oracle status was " + String(shape.named[0].status) + ", expected " + expectedStatus);
  }
  return shape.named[0];
}

function requireHealthyOracle(result) {
  requireCleanProcess(result);
  if (result.report?.success !== true) {
    fail(result.label + " did not produce a successful structured Vitest report");
  }
  requireG81FileAndOracle(result, "passed");
}

function stripSgr(value) {
  return value.replace(SGR_SEQUENCE, "");
}

function hasStatusDiffLine(lines, prefix, status) {
  const expected = prefix + " " + String(status);
  const labeled = prefix + " " + (prefix === "-" ? "Expected: " : "Received: ") + String(status);
  return lines.some((line) => line.trim() === expected || line.trim() === labeled);
}

function parseCapture(failureText) {
  const markerIndex = failureText.indexOf(G81_PUBLIC_STATUS_ASSERTION);
  if (markerIndex < 0) return undefined;
  const markerLine = failureText.slice(markerIndex).split(/\r?\n/, 1)[0];
  const jsonStart = markerLine.indexOf("{");
  const jsonEnd = markerLine.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd <= jsonStart) return undefined;
  try {
    return JSON.parse(markerLine.slice(jsonStart, jsonEnd + 1));
  } catch {
    return undefined;
  }
}

function semanticFailureEvidence(result, mutation, sourceHead) {
  const reject = (reason) => {
    throw new Error(mutation.id + " did not produce a semantic red oracle (" + reason + "):\n" + JSON.stringify({
      status: result.status,
      signal: result.signal,
      error: result.error,
      reportError: result.reportError,
      output: result.output,
      report: result.report,
    }, null, 2));
  };

  if (result.status !== 1) reject("process status was not 1");
  if (result.signal !== null) reject("process terminated by signal " + String(result.signal));
  if (result.error !== undefined) reject("process error " + JSON.stringify(result.error));
  if (result.reportError !== undefined) reject(result.reportError);
  if (!isRecord(result.report) || result.report.success !== false) reject("structured report was not a failed run");

  const shape = reportShape(result.report);
  if (!Array.isArray(shape.files) || shape.files.length !== 1) reject("report did not contain exactly one test file");
  const fileName = shape.files[0]?.name;
  if (typeof fileName !== "string" || !fileName.endsWith(G81_TEST_FILE)) {
    reject("report targeted an unexpected test file");
  }
  if (shape.named.length !== 1) reject("the named G81 AC3 oracle was missing or ambiguous");
  if (shape.executed.length !== 1) reject("another test or assertion was executed");
  const oracle = shape.named[0];
  if (oracle.status !== "failed") reject("the named G81 AC3 oracle was not failed");
  if (result.report.numFailedTests !== 1) reject("the structured report contained another failed test");
  const failureMessages = Array.isArray(oracle.failureMessages)
    ? oracle.failureMessages.filter((message) => typeof message === "string" && message.length > 0)
    : [];
  if (failureMessages.length !== 1) reject("the named oracle did not have exactly one failure record");

  const failureText = stripSgr(failureMessages[0]);
  if (!failureText.includes(G81_PUBLIC_STATUS_ASSERTION)) {
    reject("the failure was not the public HTTP-status assertion");
  }
  const forbiddenFailure = /(setup|import|cannot find module|failed to load|database|postgres|connection|timed out|timeout|unhandled|sigterm|sigkill|sigint|sigabrt|killed|typeerror|referenceerror|syntaxerror)/i;
  if (forbiddenFailure.test(failureText)) {
    reject("failure evidence was setup/import/database/timeout/process failure");
  }

  const lines = failureText.split(/\r?\n/).map((line) => stripSgr(line).trim());
  if (!hasStatusDiffLine(lines, "-", mutation.expectedStatus)) {
    reject("expected status " + mutation.expectedStatus + " was not present in the named assertion diff");
  }
  if (!hasStatusDiffLine(lines, "+", mutation.receivedStatus)) {
    reject("received status " + mutation.receivedStatus + " was not present in the named assertion diff");
  }

  const capture = parseCapture(failureText);
  if (!isRecord(capture)) reject("the public assertion capture was missing or malformed");
  if (capture.lagMs !== mutation.boundaryLagMs) {
    reject("wrong boundary: expected " + mutation.boundaryLagMs + ", received " + String(capture.lagMs));
  }
  if (capture.responseStatus !== mutation.receivedStatus) {
    reject("wrong captured received status: expected " + mutation.receivedStatus + ", received " + String(capture.responseStatus));
  }
  if (!isRecord(capture.persistedLag) || capture.persistedLag.estimateMs !== mutation.boundaryLagMs) {
    reject("durable boundary capture did not match the mutation");
  }

  return {
    sourceHead,
    selectedTest: G81_ORACLE_NAME,
    publicAssertion: G81_PUBLIC_STATUS_ASSERTION,
    boundaryLagMs: mutation.boundaryLagMs,
    expectedStatus: mutation.expectedStatus,
    receivedStatus: mutation.receivedStatus,
    process: processReceipt(result),
    structuredReport: {
      success: result.report.success,
      failedTests: result.report.numFailedTests,
      totalTests: result.report.numTotalTests,
      namedOracle: oracle.fullName,
    },
    failedAssertion: {
      title: oracle.title,
      fullName: oracle.fullName,
      failureMessages,
      capture,
    },
  };
}

function mutate(original, mutation) {
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) {
    fail(mutation.id + " anchor expected once in " + mutation.sourceFile + ", found " + occurrences);
  }
  return original.replace(mutation.from, mutation.to);
}

function sourceHead() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0 || result.signal !== null || result.error !== undefined) {
    fail("could not resolve the source head: " + JSON.stringify({
      status: result.status,
      signal: result.signal,
      error: serializeSpawnError(result.error),
      output: (result.stdout ?? "") + (result.stderr ?? ""),
    }));
  }
  const head = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(head)) fail("source head was not a full SHA: " + head);
  return head;
}

function oracleFailureMessage(mutation, capture = {}) {
  return "AssertionError: " + G81_PUBLIC_STATUS_ASSERTION + " " + JSON.stringify({
    lagMs: mutation.boundaryLagMs,
    persistedLag: { estimateMs: mutation.boundaryLagMs, observedAt: 1800000000000 },
    responseStatus: mutation.receivedStatus,
    ...capture,
  }) + "\n- " + mutation.expectedStatus + "\n+ " + mutation.receivedStatus;
}

function syntheticReport(mutation, status, failureMessages = [], extraAssertions = []) {
  const target = {
    ancestorTitles: ["Serialized V1 reads"],
    fullName: "Serialized V1 reads " + G81_ORACLE_NAME,
    title: G81_ORACLE_NAME,
    status,
    failureMessages,
  };
  const assertions = [target, ...extraAssertions];
  const failedTests = assertions.filter((assertion) => assertion.status === "failed").length;
  return {
    success: failedTests === 0,
    numFailedTests: failedTests,
    numTotalTests: assertions.length,
    testResults: [{
      assertionResults: assertions,
      name: resolve(root, G81_TEST_FILE),
    }],
  };
}

function syntheticResult({ status = 1, signal = null, error, report, reportError, output = "" } = {}) {
  return { label: "G81 validator self-test", status, signal, error, report, reportError, output };
}

function assertRejects(label, action) {
  try {
    action();
  } catch {
    return;
  }
  fail("semantic red validator accepted " + label);
}

function selfTest() {
  for (const mutation of G81_MUTATIONS) {
    const original = readFileSync(resolve(root, mutation.sourceFile), "utf8");
    mutate(original, mutation);
  }
  if (!G81_ORACLE_NAME.includes("G81") || !G81_ORACLE_NAME.includes("120000") || !G81_ORACLE_NAME.includes("120001")) {
    fail("oracle is not the named G81 boundary test");
  }
  const selfTestHead = "self-test-source-head";
  const accepted = [];
  for (const mutation of G81_MUTATIONS) {
    const valid = semanticFailureEvidence(syntheticResult({
      report: syntheticReport(mutation, "failed", [oracleFailureMessage(mutation)]),
    }), mutation, selfTestHead);
    accepted.push({
      id: mutation.id,
      boundaryLagMs: valid.boundaryLagMs,
      expectedStatus: valid.expectedStatus,
      receivedStatus: valid.receivedStatus,
    });
    requireHealthyOracle(syntheticResult({
      status: 0,
      report: syntheticReport(mutation, "passed"),
    }));

    assertRejects("green target", () => semanticFailureEvidence(syntheticResult({
      status: 0,
      report: syntheticReport(mutation, "passed"),
    }), mutation, selfTestHead));
    assertRejects("missing report", () => semanticFailureEvidence(syntheticResult({
      reportError: "missing report",
    }), mutation, selfTestHead));
    assertRejects("signal termination", () => semanticFailureEvidence(syntheticResult({
      status: null,
      signal: "SIGTERM",
      report: syntheticReport(mutation, "failed", [oracleFailureMessage(mutation)]),
    }), mutation, selfTestHead));
    assertRejects("setup/import failure", () => semanticFailureEvidence(syntheticResult({
      report: syntheticReport(mutation, "failed", ["Setup Error: Cannot find module setup.mjs"]),
    }), mutation, selfTestHead));
    assertRejects("database failure", () => semanticFailureEvidence(syntheticResult({
      report: syntheticReport(mutation, "failed", [
        oracleFailureMessage(mutation) + "\nDatabase connection failed",
      ]),
    }), mutation, selfTestHead));
    assertRejects("timeout", () => semanticFailureEvidence(syntheticResult({
      report: syntheticReport(mutation, "failed", [
        oracleFailureMessage(mutation) + "\nTest timed out in 5000ms",
      ]),
    }), mutation, selfTestHead));
    assertRejects("missing oracle", () => semanticFailureEvidence(syntheticResult({
      report: syntheticReport(mutation, "failed", ["AssertionError: unrelated assertion"]),
    }), mutation, selfTestHead));
    assertRejects("skipped target", () => semanticFailureEvidence(syntheticResult({
      report: syntheticReport(mutation, "skipped"),
    }), mutation, selfTestHead));
    assertRejects("unrelated assertion", () => semanticFailureEvidence(syntheticResult({
      report: syntheticReport(mutation, "failed", [oracleFailureMessage(mutation)], [
        {
          fullName: "Serialized V1 reads unrelated assertion",
          title: "unrelated assertion",
          status: "failed",
          failureMessages: ["AssertionError: expected 1 to be 2"],
        },
      ]),
    }), mutation, selfTestHead));
    assertRejects("unrelated output", () => semanticFailureEvidence(syntheticResult({
      output: G81_ORACLE_NAME + "\n- " + mutation.expectedStatus + "\n+ " + mutation.receivedStatus,
      report: syntheticReport(mutation, "failed", ["AssertionError: unrelated output only"]),
    }), mutation, selfTestHead));
    assertRejects("wrong boundary", () => semanticFailureEvidence(syntheticResult({
      report: syntheticReport(mutation, "failed", [oracleFailureMessage(mutation, { lagMs: mutation.boundaryLagMs + 1 })]),
    }), mutation, selfTestHead));
    assertRejects("wrong expected/received pair", () => semanticFailureEvidence(syntheticResult({
      report: syntheticReport(mutation, "failed", [oracleFailureMessage(mutation, {
        responseStatus: mutation.expectedStatus,
      })]),
    }), mutation, selfTestHead));
  }
  process.stdout.write(JSON.stringify({
    mutations: G81_MUTATIONS.map((mutation) => ({
      id: mutation.id,
      boundaryLagMs: mutation.boundaryLagMs,
      expectedStatus: mutation.expectedStatus,
      receivedStatus: mutation.receivedStatus,
    })),
    oracle: G81_ORACLE_NAME,
    publicAssertion: G81_PUBLIC_STATUS_ASSERTION,
    testFile: G81_TEST_FILE,
    selfTest: "anchors-g81-only-oracle-structured-red-and-failure-class-controls",
    acceptedSemanticCases: accepted,
    rejectedCases: [
      "green target",
      "missing report",
      "signal termination",
      "setup/import failure",
      "database failure",
      "timeout",
      "missing oracle",
      "skipped target",
      "unrelated assertion",
      "unrelated output",
      "wrong boundary",
      "wrong expected/received pair",
    ],
  }) + "\n");
}

function runMutation(mutation, sourceHeadValue) {
  const sourcePath = resolve(root, mutation.sourceFile);
  const original = readFileSync(sourcePath, "utf8");
  try {
    requireCleanProcess(buildPackages());
    requireHealthyOracle(runOracle("G81 healthy control (" + mutation.id + ")"));
    writeFileSync(sourcePath, mutate(original, mutation), "utf8");
    requireCleanProcess(buildPackages());
    const red = runOracle("G81 semantic mutant (" + mutation.id + ")");
    const redEvidence = semanticFailureEvidence(red, mutation, sourceHeadValue);
    return {
      id: mutation.id,
      sourceFile: mutation.sourceFile,
      result: "semantic-mutant-red",
      ...redEvidence,
    };
  } finally {
    writeFileSync(sourcePath, original, "utf8");
    requireCleanProcess(buildPackages());
  }
}

function main() {
  try {
    if (process.argv.includes("--self-test")) return selfTest();
    const sourceHeadValue = sourceHead();
    requireCleanProcess(buildPackages());
    const rows = G81_MUTATIONS.map((mutation) => runMutation(mutation, sourceHeadValue));
    process.stdout.write(JSON.stringify({
      result: "all-g81-safe-window-mutants-red",
      sourceHead: sourceHeadValue,
      selectedTest: G81_ORACLE_NAME,
      publicAssertion: G81_PUBLIC_STATUS_ASSERTION,
      rows,
    }) + "\n");
  } finally {
    if (reportDirectory !== undefined) rmSync(reportDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
