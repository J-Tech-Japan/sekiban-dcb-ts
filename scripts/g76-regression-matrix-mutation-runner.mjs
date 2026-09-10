#!/usr/bin/env node
/**
 * Prove the G76 outcome matrix is behavioral rather than a source-shape
 * check. Each temporary CommitWorker mutation is exercised by one focused
 * public-response/durable-facts oracle and the source is restored in finally.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");
const sourceFile = "packages/dcb-runtime/src/commit/CommitWorker.ts";

export const G76_MUTATIONS = Object.freeze([
  {
    fact: "recognized_partial_write_becomes_unknown",
    from: "return this.partialWriteOutcome(input, allocatedCandidates, writes, attemptId, fault !== undefined);",
    to: "return this.noApplicationOutcome(attemptId, true);",
    oracle: "AC3 mutant target: a recognized partial write remains definite and non-retryable",
    publicAssertion: "G76 public assertion: partial-write status must remain 500",
  },
  {
    fact: "incomplete_fence_acknowledgement_becomes_partial_write",
    from: "if (!await this.installPartialWriteFences(writes.pendingTags, attemptId, traceState?.scope)) {",
    to: "if (false) {",
    oracle: "AC3 mutant target: an incomplete fence acknowledgement remains unknown",
    publicAssertion: "G76 public assertion: incomplete fence acknowledgement must remain 504",
  },
  {
    fact: "partial_write_retryable_flips_true",
    from: "retryable: false,",
    to: "retryable: true,",
    oracle: "AC3 mutant target: partial.retryable remains false",
    publicAssertion: "G76 public assertion: partial retryable must remain false",
  },
  {
    fact: "all_pending_fences_weaken_to_any_one",
    from: "return installed.every((result) => result.status === \"fulfilled\" && result.value);",
    to: "return installed.some((result) => result.status === \"fulfilled\" && result.value);",
    oracle: "AC3 mutant target: every pending participant fence is required",
    publicAssertion: "G76 public assertion: every pending participant fence is required",
  },
]);

let reportDirectory;
let reportCounter = 0;

function nextReportPath(label) {
  reportDirectory ??= mkdtempSync(join(tmpdir(), "sdt-g76-mutation-"));
  reportCounter += 1;
  return join(reportDirectory, `${reportCounter}-${label.replaceAll(/[^a-z0-9-]/gi, "_")}.json`);
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
  try {
    return JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    return undefined;
  }
}

function run(command, args, label) {
  const reportPath = nextReportPath(label);
  let result;
  try {
    result = spawnSync(command, [...args, "--reporter=json", "--outputFile", reportPath], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CI: "1" },
    });
  } catch (error) {
    return {
      label,
      status: null,
      signal: null,
      error: serializeSpawnError(error),
      output: "",
      report: readStructuredReport(reportPath),
    };
  }
  return {
    label,
    status: result.status,
    signal: result.signal,
    error: serializeSpawnError(result.error),
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    report: readStructuredReport(reportPath),
  };
}

function assertionResults(result) {
  const files = result.report?.testResults;
  if (!Array.isArray(files)) return [];
  return files.flatMap((file) => Array.isArray(file?.assertionResults) ? file.assertionResults : []);
}

function processReceipt(result) {
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
  };
}

function requirePass(result, mutation) {
  if (result.status !== 0 || result.signal !== null || result.error !== undefined) {
    throw new Error(`${result.label} did not produce a clean process result: ${JSON.stringify(processReceipt(result))}\n${result.output}`);
  }
  if (result.report?.success !== true) {
    throw new Error(`${result.label} did not produce a successful structured Vitest report`);
  }
  const named = assertionResults(result).filter((assertion) => assertion?.title === mutation.oracle);
  if (named.length !== 1 || named[0]?.status !== "passed") {
    throw new Error(`${result.label} did not pass exactly the named oracle: ${JSON.stringify(named)}`);
  }
}

function requireRed(result, mutation) {
  if (result.status !== 1 || result.signal !== null || result.error !== undefined) {
    throw new Error(`${mutation.fact} was not a clean semantic test failure: ${JSON.stringify(processReceipt(result))}`);
  }
  if (result.report?.success !== false) {
    throw new Error(`${mutation.fact} did not produce a failed structured Vitest report`);
  }
  const assertions = assertionResults(result);
  const named = assertions.filter((assertion) => assertion?.title === mutation.oracle);
  if (named.length !== 1 || named[0]?.status !== "failed") {
    throw new Error(`${mutation.fact} did not fail exactly the named oracle: ${JSON.stringify(named)}`);
  }
  const failed = assertions.filter((assertion) => assertion?.status === "failed");
  if (failed.length !== 1) {
    throw new Error(`${mutation.fact} had unrelated or multiple failed assertions: ${JSON.stringify(failed)}`);
  }
  const failures = Array.isArray(named[0].failureMessages) ? named[0].failureMessages : [];
  if (!failures.some((message) => typeof message === "string" && message.includes(mutation.publicAssertion))) {
    throw new Error(`${mutation.fact} did not fail its expected public assertion ${JSON.stringify(mutation.publicAssertion)}: ${JSON.stringify(failures)}`);
  }
}

function expectRejected(label, result, mutation) {
  try {
    requireRed(result, mutation);
  } catch {
    return;
  }
  throw new Error(`validator self-test accepted ${label}`);
}

function mutate(original, mutation) {
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) {
    throw new Error(`${mutation.fact} anchor expected once in ${sourceFile}, found ${occurrences}`);
  }
  return original.replace(mutation.from, mutation.to);
}

function oracle(mutation) {
  return run(process.execPath, [
    vitest,
    "run",
    "--config",
    "vitest.config.ts",
    "--no-cache",
    "--maxWorkers=1",
    "test/g76-regression-matrix.spec.ts",
    "--testNamePattern",
    mutation.oracle,
  ], `G76 focused public oracle (${mutation.fact})`);
}

function runMutation(mutation) {
  const sourcePath = resolve(root, sourceFile);
  const original = readFileSync(sourcePath, "utf8");
  try {
    requirePass(oracle(mutation), mutation);
    writeFileSync(sourcePath, mutate(original, mutation), "utf8");
    const red = oracle(mutation);
    requireRed(red, mutation);
    return {
      fact: mutation.fact,
      result: "behavioral-mutant-red",
      process: processReceipt(red),
      namedOracle: mutation.oracle,
      publicAssertion: mutation.publicAssertion,
      structuredReport: {
        success: red.report?.success,
        failedTests: red.report?.numFailedTests,
        namedFailureCount: assertionResults(red).filter((assertion) => assertion?.title === mutation.oracle).length,
      },
      output: red.output,
    };
  } finally {
    writeFileSync(sourcePath, original, "utf8");
  }
}

function selfTest() {
  const original = readFileSync(resolve(root, sourceFile), "utf8");
  for (const mutation of G76_MUTATIONS) mutate(original, mutation);
  const mutation = G76_MUTATIONS[0];
  const validReport = {
    success: false,
    numFailedTests: 1,
    testResults: [{
      assertionResults: [{
        title: mutation.oracle,
        status: "failed",
        failureMessages: [mutation.publicAssertion],
      }],
    }],
  };
  requireRed({ status: 1, signal: null, error: undefined, report: validReport, output: "" }, mutation);
  expectRejected("green escape", { status: 0, signal: null, error: undefined, report: { ...validReport, success: true }, output: "" }, mutation);
  expectRejected("missing report", { status: 1, signal: null, error: undefined, report: undefined, output: "" }, mutation);
  expectRejected("signal termination", { status: null, signal: "SIGTERM", error: undefined, report: validReport, output: "" }, mutation);
  expectRejected("spawn error", { status: null, signal: null, error: { name: "Error", message: "spawn failed" }, report: undefined, output: "" }, mutation);
  expectRejected("timeout", {
    status: 1,
    signal: null,
    error: undefined,
    report: {
      ...validReport,
      testResults: [{ assertionResults: [{ title: mutation.oracle, status: "failed", failureMessages: ["Test timed out in 5000ms"] }] }],
    },
    output: "",
  }, mutation);
  expectRejected("setup/import failure", {
    status: 1,
    signal: null,
    error: undefined,
    report: {
      ...validReport,
      testResults: [{ assertionResults: [{ title: "setup/import failure", status: "failed", failureMessages: ["Cannot find module"] }] }],
    },
    output: "",
  }, mutation);
  expectRejected("unrelated assertion", {
    status: 1,
    signal: null,
    error: undefined,
    report: {
      ...validReport,
      testResults: [{ assertionResults: [
        { title: mutation.oracle, status: "passed", failureMessages: [] },
        { title: "unrelated assertion", status: "failed", failureMessages: [mutation.publicAssertion] },
      ] }],
    },
    output: "",
  }, mutation);
  process.stdout.write(`${JSON.stringify({
    sourceFile,
    mutations: G76_MUTATIONS.map(({ fact }) => fact),
    selfTest: "anchors-and-structured-red-receipts",
    rejected: ["green", "missing-report", "signal", "spawn-error", "timeout", "setup-import", "unrelated"],
  })}\n`);
}

function main() {
  try {
    if (process.argv.includes("--self-test")) return selfTest();
    const rows = G76_MUTATIONS.map(runMutation);
    process.stdout.write(`${JSON.stringify({ result: "all-g76-behavioral-mutants-red", rows })}\n`);
  } finally {
    if (reportDirectory !== undefined) rmSync(reportDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
