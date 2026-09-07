#!/usr/bin/env node
/** G66 receipt and red-capable acceptance guard. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS = "scripts/deploy/g66-e2e.mjs";

function fail(message) { throw new Error(`SDT-G66 guard failed: ${message}`); }
function read(path) { return readFileSync(resolve(path), "utf8"); }

export function assertG66HarnessSource(source) {
  for (const expected of [
    "read-through", "snapshot-only", "coverageHistory", "safeLanePasses", "tagReads", "queryReads",
    "UNSAFE_BOUND_MS", "SAFE_BOUND_MS", "censored", "writeReceipt(options.reportPath, report)",
  ]) if (!source.includes(expected)) fail(`harness omitted ${expected}`);
  if (!source.includes("if (sample.safe.disposition !== \"pass\")")) fail("safe lane is not fail-closed");
  if (!source.includes("if (commit.status !== 200 || commit.kind !== \"committed\" || commit.suid === null)")) fail("paused/failed writes are not censored");
  return { requiredSections: 10 };
}

function sampleShape(sample, index) {
  if (sample === null || typeof sample !== "object") fail(`sample ${index} is not an object`);
  if (sample.commit?.status !== 200 || sample.commit?.kind !== "committed" || typeof sample.commit?.suid !== "string") fail(`sample ${index} accepted commit is missing`);
  if (!Number.isFinite(sample.commit.responseMs)) fail(`sample ${index} response clock is missing`);
  if (!Array.isArray(sample.healthSnapshots) || sample.healthSnapshots.length === 0) fail(`sample ${index} has no per-tick health receipt`);
  if (!sample.healthSnapshots.every((entry) => entry.coverage !== undefined && Array.isArray(entry.coverageHistory) && Array.isArray(entry.safeLanePasses))) fail(`sample ${index} has incomplete coverage/frontier receipt`);
  if (!Array.isArray(sample.tagReads) || sample.tagReads.length === 0) fail(`sample ${index} has no tag-state read`);
  if (sample.queryReads?.room?.status !== 200 || sample.queryReads?.reservations?.status !== 200) fail(`sample ${index} has incomplete query reads`);
  if (sample.unsafe?.disposition !== "pass" && sample.unsafe?.disposition !== "censored") fail(`sample ${index} unsafe is neither pass nor explicit censored`);
  if (sample.safe?.disposition !== "pass" && sample.safe?.disposition !== "censored") fail(`sample ${index} safe is neither pass nor explicit censored`);
}

export function inspectG66Receipt(receipt) {
  if (receipt?.schema !== "sdt-g66-public-e2e/v1") fail("wrong receipt schema");
  if (receipt?.contract?.coldFirst !== true) fail("cold-first requirement is absent");
  if (!Number.isSafeInteger(receipt?.contract?.minimumInterSampleMs) || receipt.contract.minimumInterSampleMs < 10_000) fail("10-second pacing is absent");
  if (!Array.isArray(receipt.commands) || receipt.commands.length < 10) fail("fewer than ten command rows");
  receipt.commands.forEach(sampleShape);
  if (!receipt.commands.some((sample) => sample.commit.executor?.readMode === "read-through")) fail("no read-through command");
  if (!receipt.commands.some((sample) => sample.commit.executor?.readMode === "snapshot-only")) fail("no snapshot-only command");
  if (!Array.isArray(receipt.healthSnapshots) || receipt.healthSnapshots.length === 0) fail("no cohort health receipt");
  const acceptance = {
    allAccepted: receipt.commands.every((sample) => sample.commit.status === 200 && sample.commit.kind === "committed"),
    allUnsafeWithinBound: receipt.commands.every((sample) => sample.unsafe.disposition === "pass"),
    allSafeWithinBound: receipt.commands.every((sample) => sample.safe.disposition === "pass"),
    tagStateAndQueryReads: receipt.commands.every((sample) => sample.tagReads.length > 0 && sample.queryReads.room.status === 200 && sample.queryReads.reservations.status === 200),
    coverageAndFrontierObserved: receipt.healthSnapshots.every((entry) => entry.coverage !== undefined && Array.isArray(entry.coverageHistory) && Array.isArray(entry.safeLanePasses)),
  };
  return Object.freeze({ shape: "pass", acceptance, passed: Object.values(acceptance).every(Boolean) });
}

function fixture() {
  const health = { coverage: { kind: "SETTLED", frontierSuid: "000000000000000000000000000010" }, coverageHistory: [], safeLanePasses: [] };
  return {
    schema: "sdt-g66-public-e2e/v1",
    contract: { coldFirst: true, minimumInterSampleMs: 10_000 },
    healthSnapshots: [health],
    commands: Array.from({ length: 10 }, (_, index) => ({
      commit: { status: 200, kind: "committed", suid: String(index + 1).padStart(30, "0"), responseMs: 12, executor: { readMode: index === 0 ? "read-through" : "snapshot-only" } },
      healthSnapshots: [health],
      tagReads: [{ status: 200 }],
      queryReads: { room: { status: 200 }, reservations: { status: 200 } },
      unsafe: { disposition: "pass" },
      safe: { disposition: "pass" },
    })),
  };
}

export function selfTest() {
  assertG66HarnessSource(read(HARNESS));
  const good = fixture();
  if (!inspectG66Receipt(good).passed) fail("good fixture did not pass");
  const censored = structuredClone(good);
  censored.commands[0].safe = { disposition: "censored" };
  if (inspectG66Receipt(censored).passed) fail("censored safe mutant passed");
  const paused = structuredClone(good);
  paused.commands[0].commit.status = 504;
  let pausedRed = false;
  try { inspectG66Receipt(paused); } catch { pausedRed = true; }
  if (!pausedRed) fail("paused-write mutant did not go red");
  const noCoverage = structuredClone(good);
  noCoverage.commands[0].healthSnapshots[0].coverageHistory = null;
  let coverageRed = false;
  try { inspectG66Receipt(noCoverage); } catch { coverageRed = true; }
  if (!coverageRed) fail("coverage/frontier mutant did not go red");
  process.stdout.write(`${JSON.stringify({ selfTest: "sdt-g66-e2e-guards", censoredSafeRed: true, pausedWriteRed: true, missingCoverageRed: true })}\n`);
}

function main() {
  const input = process.argv[process.argv.indexOf("--input") + 1];
  if (typeof input !== "string" || input.startsWith("--")) fail("--input is required");
  const receipt = JSON.parse(read(input));
  const result = inspectG66Receipt(receipt);
  mkdirSync(resolve(".artifacts"), { recursive: true });
  const output = resolve(process.env.G66_GUARD_OUTPUT ?? ".artifacts/sdt-g66-e2e-guard.json");
  writeFileSync(output, `${JSON.stringify({ schema: "sdt-g66-e2e-guard/v1", input, ...result }, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ guard: "sdt-g66-e2e", output, ...result })}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.includes("--self-test")) selfTest();
  else main();
}
