#!/usr/bin/env node
/**
 * SDT-G79 AC3 proof mutations for the G43 backlog fixture.
 *
 * The first mutation removes the tail obligation and runs the real focused
 * Vitest oracle. Its result is accepted only when structured Vitest output
 * identifies the named AC6 test and its expected 33-versus-32 boundary
 * assertion. A timeout, setup error, signal, missing test, or unrelated
 * assertion is not a killed semantic mutant. The second mutation removes
 * only the proof's re-arm assertion and runs the labelled source-shape
 * contract that protects the stated test boundary. The tracked test is
 * restored in every path.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const sourceFile = "test/g43-tag-sql.spec.ts";
const sourcePath = resolve(root, sourceFile);
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");
const oracleTitle = "AC6: a backlog larger than one alarm budget progresses and re-arms instead of starving its tail";
const loopAnchor = "for (let ordinal = 1; ordinal <= 33; ordinal += 1)";
const limitAnchor = 'post(value, "/outbox/pending", { nowMs: Date.now(), limit: 32 })';
const firstRearmAssertion = "expect(await configuredAlarm(value)).not.toBeNull();";
const finalAlarmAssertion = "expect(await configuredAlarm(value)).toBeNull();";
const finalBoundaryAssertion = "expect(new Set(sent)).toHaveLength(33);";
const sqlBoundaryAssertion = "toMatchObject({ rows: { length: 32 } })";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function allAssertions(report) {
  return (report?.testResults ?? []).flatMap((file) => file.assertionResults ?? []);
}

function namedAssertions(report) {
  return allAssertions(report).filter((assertion) => {
    const name = `${assertion.fullName ?? ""} ${assertion.title ?? ""}`;
    return name.includes(oracleTitle);
  });
}

function readStructuredReport(reportPath) {
  if (!existsSync(reportPath)) return null;
  try {
    return JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    throw new Error(`SDT-G79 Vitest JSON report was not valid JSON: ${reportPath}: ${error.message}`);
  }
}

function runOracle(label, reportDirectory) {
  const reportPath = resolve(reportDirectory, `${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`);
  const result = spawnSync(process.execPath, [
    vitest,
    "run",
    "--config", "vitest.config.ts",
    "--no-cache",
    "--maxWorkers=1",
    sourceFile,
    "--testNamePattern", oracleTitle,
    "--reporter=json",
    "--outputFile", reportPath,
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  return {
    label,
    status: result.status,
    signal: result.signal,
    reportPath,
    report: readStructuredReport(reportPath),
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function resultSummary(result) {
  const assertions = namedAssertions(result.report);
  return {
    status: result.status,
    signal: result.signal,
    reportPath: result.reportPath,
    totalTests: result.report?.numTotalTests ?? null,
    passedTests: result.report?.numPassedTests ?? null,
    failedTests: result.report?.numFailedTests ?? null,
    namedAssertions: assertions.map((assertion) => ({
      title: assertion.title,
      fullName: assertion.fullName,
      status: assertion.status,
      failureMessages: assertion.failureMessages ?? [],
    })),
  };
}

function requirePass(result) {
  if (result.status !== 0 || result.signal !== null) {
    throw new Error(`${result.label} unexpectedly failed or was signalled:\n${JSON.stringify(resultSummary(result))}\n${result.output}`);
  }
  if (result.report === null) {
    throw new Error(`${result.label} produced no structured Vitest report`);
  }
  const assertions = namedAssertions(result.report);
  if (assertions.length !== 1 || assertions[0].status !== "passed") {
    throw new Error(`${result.label} did not pass exactly the named AC6 test:\n${JSON.stringify(resultSummary(result))}`);
  }
}

function expectedBoundaryFailure(message) {
  const normalized = String(message).replace(/\s+/g, " ");
  if (
    /(?:length of 33|toHaveLength\(33\)).*(?:got|received|actual).*(?:32)|(?:expected|want).*(?:33).*(?:actual|received|got).*(?:32)/i.test(normalized)
  ) {
    return "tail delivery boundary: expected 33 unique sends, observed 32";
  }
  if (
    /(?:length\s*:\s*32|length of 32|rows[^}]*32).*(?:31)|(?:31).*(?:length\s*:\s*32|length of 32|rows[^}]*32)/i.test(normalized)
  ) {
    return "SQL LIMIT32 boundary: expected 32 selected rows, observed 31";
  }
  return null;
}

function requireSemanticRed(result) {
  if (result.status === 0 || result.signal !== null) {
    throw new Error(`${result.label} was not a normal process-level red result:\n${JSON.stringify(resultSummary(result))}`);
  }
  if (result.report === null) {
    throw new Error(`${result.label} produced no structured Vitest report; timeout/setup/signal/missing-test results are not killed semantic mutants`);
  }
  const assertions = namedAssertions(result.report);
  if (assertions.length !== 1) {
    throw new Error(`${result.label} did not report exactly one named AC6 assertion:\n${JSON.stringify(resultSummary(result))}`);
  }
  const [assertion] = assertions;
  const failures = assertion.failureMessages ?? [];
  const boundary = failures.map(expectedBoundaryFailure).find(Boolean);
  if (assertion.status !== "failed" || failures.length === 0 || boundary === undefined) {
    throw new Error(`${result.label} was not the expected AC6 33-versus-32 boundary failure:\n${JSON.stringify(resultSummary(result))}`);
  }
  if (typeof result.report.numFailedTests === "number" && result.report.numFailedTests !== 1) {
    throw new Error(`${result.label} reported an unexpected failed-test count: ${JSON.stringify(resultSummary(result))}`);
  }
  return {
    ...resultSummary(result),
    semanticFailure: boundary,
  };
}

function backlogBlock(source) {
  const start = source.indexOf(`  it("${oracleTitle}`);
  const end = source.indexOf('  it("AC7:', start + 1);
  if (start < 0 || end < 0) throw new Error("SDT-G79 AC6 backlog test block was not found");
  return source.slice(start, end);
}

function assertProofShape(source) {
  const block = backlogBlock(source);
  const required = [
    loopAnchor,
    limitAnchor,
    sqlBoundaryAssertion,
    "expect(new Set(sent)).toHaveLength(32);",
    firstRearmAssertion,
    finalBoundaryAssertion,
    "expect(new Set(sent)).toHaveLength(33);",
    finalAlarmAssertion,
  ];
  const missing = required.filter((anchor) => !block.includes(anchor));
  if (missing.length > 0) {
    throw new Error(`SDT-G79 AC6 proof contract missing: ${missing.join(" | ")}`);
  }
  if ((block.match(new RegExp(escapeRegExp(loopAnchor), "g")) ?? []).length !== 1) {
    throw new Error("SDT-G79 AC6 backlog loop must remain exactly once");
  }
}

function mutateShrinkBacklog(source) {
  if (source.split(loopAnchor).length - 1 !== 1) {
    throw new Error("SDT-G79 backlog-size mutation anchor expected once");
  }
  return source.replace(loopAnchor, "for (let ordinal = 1; ordinal <= 32; ordinal += 1)");
}

function mutateRemoveRearmAssertion(source) {
  if (source.split(firstRearmAssertion).length - 1 !== 1) {
    throw new Error("SDT-G79 re-arm assertion mutation anchor expected once");
  }
  return source.replace(firstRearmAssertion, "// G79 mutant: re-arm assertion removed");
}

function expectContractRed(source) {
  let red = false;
  try {
    assertProofShape(source);
  } catch {
    red = true;
  }
  if (!red) throw new Error("SDT-G79 re-arm-assertion mutant was green; the proof contract is vacuous");
}

function syntheticResult(overrides = {}) {
  const assertion = {
    title: oracleTitle,
    fullName: oracleTitle,
    status: "failed",
    failureMessages: ["AssertionError: expected [] to have a length of 33 but got 32"],
    ...overrides.assertion,
  };
  return {
    label: "synthetic",
    status: 1,
    signal: null,
    reportPath: "/private/tmp/sdt-g79-self-test.json",
    report: {
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

function expectRejected(label, callback) {
  try {
    callback();
  } catch {
    return;
  }
  throw new Error(`SDT-G79 self-test expected rejection for ${label}`);
}

function selfTest() {
  const source = readFileSync(sourcePath, "utf8");
  assertProofShape(source);
  const shrunk = mutateShrinkBacklog(source);
  if (shrunk.includes(loopAnchor)) throw new Error("SDT-G79 shrink mutant did not change the backlog");
  expectContractRed(mutateRemoveRearmAssertion(source));
  if (source.includes("setTimeout(resolve") || source.includes("process.hrtime")) {
    throw new Error("SDT-G79 proof unexpectedly uses a timer or process clock");
  }

  requirePass(syntheticResult({
    status: 0,
    report: {
      numTotalTests: 1,
      numPassedTests: 1,
      numFailedTests: 0,
      testResults: [{ assertionResults: [{
        title: oracleTitle,
        fullName: oracleTitle,
        status: "passed",
        failureMessages: [],
      }] }],
    },
  }));
  requireSemanticRed(syntheticResult());
  const sqlBoundary = syntheticResult({ assertion: {
    failureMessages: ["Error: expected { rows: [ …(31) ] } to match object { rows: { length: 32 } }"],
  } });
  if (!requireSemanticRed(sqlBoundary).semanticFailure.startsWith("SQL LIMIT32 boundary")) {
    throw new Error("SDT-G79 self-test did not classify the SQL LIMIT32 boundary");
  }
  expectRejected("timeout", () => requireSemanticRed(syntheticResult({
    report: { testResults: [{ assertionResults: [{
      title: oracleTitle,
      fullName: oracleTitle,
      status: "failed",
      failureMessages: ["Test timed out in 10000ms"],
    }] }] },
  })));
  expectRejected("setup failure", () => requireSemanticRed(syntheticResult({
    report: { testResults: [{ assertionResults: [] }] },
  })));
  expectRejected("signal", () => requireSemanticRed(syntheticResult({ signal: "SIGTERM" })));
  expectRejected("missing test", () => requireSemanticRed(syntheticResult({
    report: { testResults: [{ assertionResults: [{
      title: "another test",
      fullName: "another test",
      status: "failed",
      failureMessages: ["expected 33 to be 32"],
    }] }] },
  })));

  console.log(JSON.stringify({
    sourceFile,
    oracleTitle,
    backlog: 33,
    alarmLimit: 32,
    mutations: [
      { name: "shrink-backlog-below-alarm-budget", oracle: "structured Vitest semantic boundary" },
      { name: "remove-rearm-assertion", oracle: "labelled source-shape contract" },
    ],
    selfTest: "healthy-control-and-timeout-setup-signal-missing-test-rejections-validated",
  }));
}

function main() {
  const original = readFileSync(sourcePath, "utf8");
  if (process.argv.includes("--self-test")) return selfTest();
  const reportDirectory = mkdtempSync(resolve(tmpdir(), "sdt-g79-vitest-"));
  try {
    assertProofShape(original);
    requirePass(runOracle("healthy-control", reportDirectory));

    writeFileSync(sourcePath, mutateShrinkBacklog(original), "utf8");
    const shrink = runOracle("shrink-backlog-mutant", reportDirectory);
    const shrinkEvidence = requireSemanticRed(shrink);
    writeFileSync(sourcePath, original, "utf8");
    if (readFileSync(sourcePath, "utf8") !== original) throw new Error("SDT-G79 source was not restored after shrink mutant");

    writeFileSync(sourcePath, mutateRemoveRearmAssertion(original), "utf8");
    expectContractRed(readFileSync(sourcePath, "utf8"));
    writeFileSync(sourcePath, original, "utf8");
    if (readFileSync(sourcePath, "utf8") !== original) throw new Error("SDT-G79 source was not restored after re-arm mutant");

    console.log(JSON.stringify({
      result: "both-red",
      rows: [
        {
          mutant: "shrink-backlog-below-alarm-budget",
          oracle: "structured Vitest AC6 runtime",
          result: "red",
          evidence: shrinkEvidence,
        },
        {
          mutant: "remove-rearm-assertion",
          oracle: "labelled AC6 proof-shape contract (source-shape only)",
          result: "red",
        },
      ],
    }));
  } finally {
    writeFileSync(sourcePath, original, "utf8");
    rmSync(reportDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
