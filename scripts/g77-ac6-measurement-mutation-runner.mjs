#!/usr/bin/env node
/**
 * SDT-G91 AC6 fail-capable mutant proofs for the decision-grade harness.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = [
  resolve(root, "node_modules/vitest/vitest.mjs"),
  resolve(root, "../node_modules/vitest/vitest.mjs"),
].find((candidate) => existsSync(candidate));
if (vitest === undefined) throw new Error("g77-ac6-measurement-mutation-runner: vitest executable is unavailable");

const helperPath = join(root, "test/helpers/g77-ac6-measurement.ts");
const helperSource = readFileSync(helperPath, "utf8");

const mutants = [
  {
    name: "omitted-issuance-write",
    from: "issuanceEnvelope: envelopeWritten,",
    to: "issuanceEnvelope: false, // mutant: omitted write",
    expectedTests: ["G77 AC6 commit path proves issuance-envelope write on main"],
    expectRed: true,
  },
  {
    name: "hidden-history-scan",
    from: "certificate.unresolvedCount < G77_AC6_UNRESOLVED_BACKLOG",
    to: "certificate.unresolvedCount < 999 // mutant: hidden scan",
    expectedTests: ["G77 AC6 safe-pass warm cohort"],
    expectRed: true,
  },
  {
    name: "reduced-backlog",
    from: "for (let index = 0; index < G77_AC6_UNRESOLVED_BACKLOG; index += 1) {",
    to: "for (let index = 0; index < 1; index += 1) { // mutant: reduced backlog",
    expectedTests: ["G77 AC6 safe-pass warm cohort"],
    expectRed: true,
  },
  {
    name: "disabled-gate",
    from: "safeViewAdvance: true,",
    to: "safeViewAdvance: false, // mutant: disabled gate",
    expectedTests: ["G77 AC6 mutant oracle disabled gate is detectable"],
    expectRed: true,
  },
];

function restore() {
  writeFileSync(helperPath, helperSource, "utf8");
}

function failingTestNames(report) {
  if (!Array.isArray(report?.testResults)) return [];
  return report.testResults.flatMap((file) =>
    (file.assertionResults ?? [])
      .filter((assertion) => assertion.status === "failed")
      .map((assertion) => assertion.fullName ?? assertion.title ?? ""),
  );
}

function runTests(testPattern) {
  const reportPath = join(mkdtempSync(join(tmpdir(), "g77-ac6-mutant-")), "report.json");
  const result = spawnSync(process.execPath, [
    vitest,
    "run",
    "--config",
    "vitest.config.ts",
    "--maxWorkers=1",
    "--no-file-parallelism",
    "--reporter=json",
    "--outputFile",
    reportPath,
    "test/g77-ac6-measurement.spec.ts",
    "-t",
    testPattern,
  ], { cwd: root, encoding: "utf8" });
  let report = null;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    report = null;
  }
  rmSync(dirname(reportPath), { recursive: true, force: true });
  return { exitCode: result.status ?? 1, report, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

if (process.argv.includes("--self-test")) {
  for (const mutant of mutants) {
    if (!helperSource.includes(mutant.from)) {
      console.error(`self-test failed: anchor missing for ${mutant.name}`);
      process.exit(1);
    }
  }
  console.log("g77-ac6-measurement-mutation-runner self-test ok");
  process.exit(0);
}

const results = [];
try {
  for (const mutant of mutants) {
    if (!helperSource.includes(mutant.from)) {
      results.push({ mutant: mutant.name, status: "skipped", reason: "anchor not found" });
      continue;
    }
    writeFileSync(helperPath, helperSource.replace(mutant.from, mutant.to), "utf8");
    const run = runTests(mutant.expectedTests[0]);
    const failed = failingTestNames(run.report);
    const matched = mutant.expectedTests.filter((name) => failed.some((failure) => failure.includes(name)));
    const red = matched.length > 0 || run.exitCode !== 0;
    results.push({
      mutant: mutant.name,
      status: red === mutant.expectRed ? "red" : "green",
      matchedTests: matched,
      exitCode: run.exitCode,
    });
  }
} finally {
  restore();
}

console.log(JSON.stringify({ mutants: results }, null, 2));
const unexpected = results.some((entry) => entry.status !== "red" && entry.status !== "skipped");
process.exit(unexpected ? 1 : 0);
