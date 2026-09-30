#!/usr/bin/env node
/**
 * SDT-G58 cohort-evidence contract.
 *
 * The deployed witness is allowed to stop at any bounded read.  This guard
 * makes the accepted-command checkpoint observable before that read and
 * keeps the W99 red receipt available for diagnosis.  Its source mutation is
 * deliberately red-capable: removing the pre-poll write must fail the
 * contract rather than silently restoring the old lossy report shape.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const witnessPath = "scripts/deploy/g58-safe-lane-e2e.mjs";
const baselinePath = ".artifacts/sdt-g58-w99-paced-cohort.json";
const reportPath = ".artifacts/ci-local/g58-cohort-evidence-guard.json";

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function fail(message) {
  throw new Error(`SDT-G58 cohort-evidence guard failed: ${message}`);
}

function requireContains(source, expected, label) {
  if (!source.includes(expected)) fail(`${label} is missing ${JSON.stringify(expected)}`);
}

export function assertCohortEvidenceContract(source) {
  requireContains(source, "function persistReport(options, report)", "checkpoint helper");
  requireContains(source, "writeReport(options.reportPath, report)", "checkpoint write");
  requireContains(source, "reportPath: undefined", "report path option");
  requireContains(source, "options.reportPath = output", "resolved report path");
  requireContains(source, "unsafe: null", "accepted-before-unsafe placeholder");
  requireContains(source, "continueAfterUnsafe", "delegated unsafe continuation option");
  requireContains(source, 'if (options.continueAfterUnsafe) {\n        return {\n          disposition: "miss"', "delegated unsafe miss branch");
  requireContains(source, "eventualFirstVisibleAtMs", "eventual unsafe observation field");
  requireContains(source, "delegated to SDT-G60", "unsafe proof ownership statement");
  const unsafeBoundCheck = source.indexOf("if (result.elapsedMs >= UNSAFE_BOUND_MS)");
  const unsafePassCheck = source.indexOf('if (result.visible) return { disposition: "pass"');
  if (unsafeBoundCheck < 0 || unsafePassCheck < 0 || unsafeBoundCheck > unsafePassCheck) {
    fail("unsafe visibility after the 5000ms bound could be reclassified as a pass");
  }

  const setupAssignment = source.indexOf("report.setupRoom = {");
  const setupCheckpoint = source.indexOf("persistReport(options, report);", setupAssignment);
  if (setupAssignment < 0 || setupCheckpoint < 0 || setupCheckpoint < setupAssignment) {
    fail("accepted setup-room receipt is not checkpointed");
  }

  const reservationPush = source.indexOf("report.reservations.push(reservation);");
  const reservationCheckpoint = source.indexOf("report.reservations.push(reservation);\n      persistReport(options, report);", reservationPush);
  const unsafeRead = source.indexOf("const unsafe = await waitForUnsafe(options, reservationId);", reservationPush);
  if (reservationPush < 0 || reservationCheckpoint !== reservationPush || unsafeRead < 0 || reservationCheckpoint > unsafeRead) {
    fail("accepted reservation receipt is not persisted immediately before unsafe polling");
  }

  const reservationObject = source.indexOf("const reservation = {", reservationPush - 512);
  const placeholder = source.indexOf("unsafe: null", reservationObject);
  if (reservationObject < 0 || placeholder < reservationObject || placeholder > reservationPush) {
    fail("the pre-poll reservation checkpoint does not carry an explicit unsafe placeholder");
  }
  const unsafeCheckpoint = source.indexOf("reservation.unsafe = {", unsafeRead);
  const unsafeWrite = source.indexOf("persistReport(options, report);", unsafeCheckpoint);
  if (unsafeCheckpoint < 0 || unsafeWrite < unsafeCheckpoint) {
    fail("successful unsafe visibility is not checkpointed");
  }
  return Object.freeze({ setupCheckpoint: setupCheckpoint - setupAssignment, reservationCheckpoint: reservationCheckpoint - reservationPush });
}

function baselineReceipt() {
  let baseline;
  try { baseline = JSON.parse(read(baselinePath)); } catch (error) { fail(`W99 baseline receipt is unreadable: ${String(error)}`); }
  if (baseline.status !== "failed" || typeof baseline.failure !== "string" || !baseline.failure.includes("within 5000ms")) {
    fail("W99 baseline-red unsafe receipt is not preserved");
  }
  return {
    path: baselinePath,
    status: baseline.status,
    failure: baseline.failure,
    runId: baseline.runId,
  };
}

function selfTest() {
  const source = read(witnessPath);
  assertCohortEvidenceContract(source);
  const mutated = source.replace(
    "report.reservations.push(reservation);\n      persistReport(options, report);",
    "report.reservations.push(reservation);",
  );
  let red = false;
  try { assertCohortEvidenceContract(mutated); } catch { red = true; }
  if (!red) fail("removing the pre-unsafe checkpoint did not turn the contract red");
  const delegatedMutant = source.replace(
    'if (options.continueAfterUnsafe) {',
    'if (false) {',
  );
  let delegatedRed = false;
  try { assertCohortEvidenceContract(delegatedMutant); } catch { delegatedRed = true; }
  if (!delegatedRed) fail("removing delegated unsafe continuation did not turn the contract red");
  const unsafeOrderMutant = source.replace(
    'if (result.elapsedMs >= UNSAFE_BOUND_MS) {',
    'if (result.visible) return { disposition: "pass", firstVisibleAtMs: result.receivedAtMs, elapsedMs: result.elapsedMs, observations };\n    if (result.elapsedMs >= UNSAFE_BOUND_MS) {',
  );
  let unsafeOrderRed = false;
  try { assertCohortEvidenceContract(unsafeOrderMutant); } catch { unsafeOrderRed = true; }
  if (!unsafeOrderRed) fail("moving the unsafe pass check before the bound did not turn the contract red");
  process.stdout.write(`${JSON.stringify({ selfTest: "g58-cohort-evidence-prepoll-mutation-red" })}\n`);
}

function main() {
  const contract = assertCohortEvidenceContract(read(witnessPath));
  const baseline = baselineReceipt();
  mkdirSync(resolve(root, ".artifacts/ci-local"), { recursive: true });
  writeFileSync(resolve(root, reportPath), `${JSON.stringify({
    schema: "sdt-g58-cohort-evidence/v1",
    status: "pass",
    contract,
    baselineRedReceipt: baseline,
  }, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ guard: "g58-cohort-evidence", status: "pass", report: reportPath, baseline })}\n`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
