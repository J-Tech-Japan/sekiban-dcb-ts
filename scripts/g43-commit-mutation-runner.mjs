#!/usr/bin/env node
/**
 * G43's commit-fact rule is a runtime mutation check, not a source-text tally.
 * Each mutant suppresses one production transaction write, rebuilds the
 * Worker bundle, and proves the SQLite fact oracle turns red. The original
 * source is restored and rebuilt in `finally` after every case.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const sourceFile = "packages/dcb-runtime/src/tag/TagDurableObject.ts";
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");
const oracleTitle = "AC2/AC3: commits event, head, membership, obligation, and receipt together in literal normalized tables";
const oracleFullTitle = `SDT-G43 normalized Tag SQLite authority ${oracleTitle}`;

export const G43_ORACLE_FACT_MARKERS = Object.freeze({
  event: "G43 event-count assertion",
  committedMembership: "G43 committed-membership-count assertion",
  outbox_obligation: "G43 obligation-count assertion",
  head: "G43 head-count assertion",
  commit_receipt: "G43 receipt-count assertion",
  commit_receipt_written_version: "G43 stored-versus-response written-version assertion",
});

export const G43_COMMIT_FACT_MUTATIONS = Object.freeze([
  { fact: "event", from: "this.writeCommittedSqlEvent(sql, serviceId, event);", to: "void 0; // G43 mutant: omit event fact" },
  { fact: "committedMembership", from: "this.writeCommittedSqlMembership(sql, serviceId, event.eventId, tag, committedAt);", to: "void 0; // G43 mutant: omit membership fact" },
  { fact: "outbox_obligation", from: "this.writeCommittedSqlObligation(sql, serviceId, tag, event, artifact, trackSourcePartitionRegistration);", to: "void 0; // G43 mutant: omit obligation fact" },
  { fact: "head", from: "this.writeCommittedSqlHead(sql, serviceId, head, version + 1, committedAt);", to: "void 0; // G43 mutant: omit head fact" },
  { fact: "commit_receipt", from: "this.writeCommittedSqlReceipt(sql, input, committedAt, events.length, head, confirmsReservation, version + 1);", to: "void 0; // G43 mutant: omit receipt fact" },
  { fact: "commit_receipt_written_version", from: "this.writeCommittedSqlReceipt(sql, input, committedAt, events.length, head, confirmsReservation, version + 1);", to: "this.writeCommittedSqlReceipt(sql, input, committedAt, events.length, head, confirmsReservation, version);" },
]);

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", env: { ...process.env, CI: "1" } });
  return { label, status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function requirePass(result) {
  if (result.status === 0) return;
  throw new Error(`${result.label} unexpectedly failed:\n${result.output}`);
}

export function classifyOracleResult(result, fact) {
  const marker = G43_ORACLE_FACT_MARKERS[fact];
  if (marker === undefined) return { killed: false, reason: `unknown mutation fact ${fact}` };
  if (result.status === 0) return { killed: false, reason: "oracle exited zero" };
  if (result.report === undefined || result.report === null || typeof result.report !== "object") {
    return { killed: false, reason: "oracle produced no structured JSON report" };
  }

  const report = result.report;
  if (typeof report.numTotalTests !== "number" || report.numTotalTests < 1 || report.numFailedTests !== 1 || report.numPassedTests !== 0 || report.numFailedTests + report.numPassedTests !== 1) {
    return { killed: false, reason: "oracle report did not contain exactly one executed, failed test" };
  }
  if (!Array.isArray(report.testResults) || report.testResults.length !== 1) {
    return { killed: false, reason: "oracle report did not contain exactly one test result" };
  }
  const [fileResult] = report.testResults;
  if (fileResult.status !== "failed" || !Array.isArray(fileResult.assertionResults)) {
    return { killed: false, reason: "oracle report contained a collection or assertion failure" };
  }
  const executedAssertions = fileResult.assertionResults.filter((assertion) => assertion.status === "passed" || assertion.status === "failed");
  if (executedAssertions.length !== 1) {
    return { killed: false, reason: "oracle report did not contain exactly one executed assertion" };
  }
  const [assertion] = executedAssertions;
  if (assertion.status !== "failed" || assertion.title !== oracleTitle || assertion.fullName !== oracleFullTitle) {
    return { killed: false, reason: "oracle report failed the wrong test title" };
  }
  if (!Array.isArray(assertion.failureMessages) || !assertion.failureMessages.some((message) => typeof message === "string" && message.includes(marker))) {
    return { killed: false, reason: `oracle failure did not contain marker ${marker}` };
  }
  return { killed: true, marker };
}

function requireRed(result, fact) {
  const classification = classifyOracleResult(result, fact);
  if (classification.killed) return;
  throw new Error(`G43 ${fact} mutation was a wrong failure: ${classification.reason}`);
}

function build() {
  return run("npm", ["run", "build:packages", "--silent"], "build:packages");
}

function oracle() {
  const temporary = mkdtempSync(join(tmpdir(), "sdt-g43-oracle-"));
  const outputFile = join(temporary, "vitest.json");
  try {
    const result = run(process.execPath, [
      vitest,
      "run",
      "--config", "vitest.config.ts",
      "test/g43-tag-sql.spec.ts",
      "--testNamePattern", oracleTitle,
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${outputFile}`,
    ], "G43 six-fact SQLite oracle");
    let report;
    try {
      report = JSON.parse(readFileSync(outputFile, "utf8"));
    } catch {
      report = undefined;
    }
    return { ...result, report };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function mutate(original, mutation) {
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) {
    throw new Error(`G43 ${mutation.fact} mutation anchor expected once in ${sourceFile}, found ${occurrences}`);
  }
  return original.replace(mutation.from, mutation.to);
}

function runMutation(mutation) {
  const sourcePath = resolve(root, sourceFile);
  const original = readFileSync(sourcePath, "utf8");
  try {
    requirePass(oracle());
    writeFileSync(sourcePath, mutate(original, mutation), "utf8");
    requirePass(build());
    requireRed(oracle(), mutation.fact);
  } finally {
    writeFileSync(sourcePath, original, "utf8");
    requirePass(build());
  }
  return { fact: mutation.fact, result: "production-mutant-red" };
}

function selfTest() {
  const source = readFileSync(resolve(root, sourceFile), "utf8");
  for (const mutation of G43_COMMIT_FACT_MUTATIONS) mutate(source, mutation);
  const syntheticReport = (overrides = {}) => ({
    numTotalTests: 1,
    numFailedTests: 1,
    numPassedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [{
      status: "failed",
      assertionResults: [{
        status: "failed",
        title: oracleTitle,
        fullName: oracleFullTitle,
        failureMessages: [G43_ORACLE_FACT_MARKERS.event],
      }],
    }],
    ...overrides,
  });
  const checks = [
    ["correct kill", classifyOracleResult({ status: 1, report: syntheticReport() }, "event"), true],
    ["wrong title", classifyOracleResult({ status: 1, report: syntheticReport({ testResults: [{ status: "failed", assertionResults: [{ status: "failed", title: "wrong title", fullName: "wrong title", failureMessages: [G43_ORACLE_FACT_MARKERS.event] }] }] }) }, "event"), false],
    ["wrong marker", classifyOracleResult({ status: 1, report: syntheticReport({ testResults: [{ status: "failed", assertionResults: [{ status: "failed", title: oracleTitle, fullName: oracleFullTitle, failureMessages: ["unrelated assertion"] }] }] }) }, "event"), false],
    ["zero tests", classifyOracleResult({ status: 1, report: syntheticReport({ numTotalTests: 0, numFailedTests: 0, testResults: [] }) }, "event"), false],
    ["infrastructure error", classifyOracleResult({ status: 1, report: undefined }, "event"), false],
  ];
  for (const [name, result, expected] of checks) {
    if (result.killed !== expected) throw new Error(`G43 classifier self-test failed for ${name}`);
  }
  process.stdout.write(`${JSON.stringify({ facts: G43_COMMIT_FACT_MUTATIONS.map(({ fact }) => fact), classifier: checks.map(([name]) => name), selfTest: "anchors-unique-and-classifier-proven" })}\n`);
}

function main() {
  selfTest();
  if (process.argv.includes("--self-test")) return;
  requirePass(build());
  const results = G43_COMMIT_FACT_MUTATIONS.map(runMutation);
  process.stdout.write(`${JSON.stringify({ result: "all-six-production-mutants-red", rows: results })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
