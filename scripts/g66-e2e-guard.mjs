#!/usr/bin/env node
/** G66 receipt and red-capable acceptance guard. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS = "scripts/deploy/g66-e2e.mjs";
const SUID = /^\d{30}$/;

function fail(message) { throw new Error(`SDT-G66 guard failed: ${message}`); }
function read(path) { return readFileSync(resolve(path), "utf8"); }
function finite(value) { return Number.isFinite(value); }
function atLeast(actual, expected) { return SUID.test(actual ?? "") && SUID.test(expected ?? "") && actual.localeCompare(expected) >= 0; }
function parsed(value, fallback) {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function assertG66HarnessSource(source) {
  for (const expected of [
    "read-through", "snapshot-only", "coverageHistory", "safeLanePasses", "tagReads", "queryReads",
    "UNSAFE_BOUND_MS", "SAFE_BOUND_MS", "censored", "writeReceipt(options.reportPath, report)",
    "responseRelativeMs", "publicSafeQuery", "continuousWrites", "affectedTagReads",
  ]) if (!source.includes(expected)) fail(`harness omitted ${expected}`);
  if (!source.includes("if (sample.safe.disposition !== \"pass\")")) fail("safe lane is not fail-closed");
  if (!source.includes("if (commit.status !== 200 || commit.kind !== \"committed\" || commit.suid === null)")) fail("failed writes are not censored");
  if (!source.includes("const observations = []")) fail("visibility observations still gate command issuance");
  return { requiredSections: 14 };
}

function publicQueryEvidence(sample) {
  const room = sample.queryReads?.room;
  const reservations = sample.queryReads?.reservations;
  if (room?.status !== 200 || reservations?.status !== 200) return false;
  const target = sample.target;
  if (target?.kind === "room") {
    const result = room.result ?? parsed(room.body?.resultJson, null);
    return result !== null && typeof result === "object" && Number(result.count) >= 1;
  }
  const rows = Array.isArray(reservations.rows) ? reservations.rows : parsed(reservations.body?.itemsJson, null);
  return Array.isArray(rows)
    && typeof reservations.readHead === "string" && SUID.test(reservations.readHead)
    && rows.filter((row) => row?.reservationId === target?.id).length === 1
    && rows.some((row) => row?.reservationId === target?.id && row?.status === target?.expectedStatus);
}

function sampleShape(sample, index) {
  if (sample === null || typeof sample !== "object") fail(`sample ${index} is not an object`);
  if (sample.commit?.status !== 200 || sample.commit?.kind !== "committed" || !SUID.test(sample.commit?.suid ?? "")) fail(`sample ${index} accepted commit is missing`);
  if (!finite(sample.commit.startedAtMs) || !finite(sample.commit.completedAtMs) || !finite(sample.commit.responseMs)) fail(`sample ${index} command clocks are missing`);
  if (sample.commit.completedAtMs < sample.commit.startedAtMs || sample.commit.responseMs < 0) fail(`sample ${index} command clock order is invalid`);
  if (!Array.isArray(sample.healthSnapshots) || sample.healthSnapshots.length === 0) fail(`sample ${index} has no per-tick health receipt`);
  if (!sample.healthSnapshots.every((entry) => entry.coverage !== undefined && Array.isArray(entry.coverageHistory) && Array.isArray(entry.safeLanePasses))) fail(`sample ${index} has incomplete coverage/frontier receipt`);
  if (!Array.isArray(sample.tagReads) || sample.tagReads.length === 0) fail(`sample ${index} has no affected-tag read`);
  if (!sample.tagReads.every((tag) => tag.status === 200 && Number.isSafeInteger(tag.version) && (tag.expectedVersion === null || tag.version >= tag.expectedVersion) && atLeast(tag.lastSortedUniqueId, tag.expectedSuid))) fail(`sample ${index} has incomplete committed tag evidence`);
  if (sample.unsafe?.disposition !== "pass" && sample.unsafe?.disposition !== "censored") fail(`sample ${index} unsafe is neither pass nor explicit censored`);
  if (sample.safe?.disposition !== "pass" && sample.safe?.disposition !== "censored") fail(`sample ${index} safe is neither pass nor explicit censored`);
  if (sample.unsafe?.disposition === "pass") {
    if (!Array.isArray(sample.unsafe.observations) || sample.unsafe.observations.length === 0) fail(`sample ${index} has no unsafe observations`);
  }
  if (sample.safe?.disposition === "pass") {
    if (sample.safe.publicQuery !== undefined && sample.safe.publicQuery?.status !== 200) fail(`sample ${index} safe public read returned an error`);
  }
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
  const paced = receipt.commands.every((sample, index) => index === 0 || sample.commit.startedAtMs - receipt.commands[index - 1].commit.startedAtMs >= receipt.contract.minimumInterSampleMs);
  const continuous = receipt.commands.some((sample, index) => index > 0
    && finite(receipt.commands[index - 1].safe?.firstVisibleAtMs)
    && sample.commit.startedAtMs < receipt.commands[index - 1].safe.firstVisibleAtMs);
  const acceptance = {
    allAccepted: receipt.commands.every((sample) => sample.commit.status === 200 && sample.commit.kind === "committed"),
    allUnsafeWithinBound: receipt.commands.every((sample) => sample.unsafe.disposition === "pass" && finite(sample.unsafe.firstVisibleAtMs) && finite(sample.unsafe.responseRelativeMs) && sample.unsafe.responseRelativeMs >= 0 && sample.unsafe.responseRelativeMs <= sample.unsafe.boundMs),
    allSafeWithinBound: receipt.commands.every((sample) => sample.safe.disposition === "pass" && finite(sample.safe.firstVisibleAtMs) && finite(sample.safe.responseRelativeMs) && sample.safe.responseRelativeMs >= 0 && sample.safe.responseRelativeMs <= sample.safe.boundMs && SUID.test(sample.safe.safeHead ?? "") && sample.safe.publicQuery?.status === 200),
    continuousPacedWrites: paced && continuous,
    tagStateAndQueryReads: receipt.commands.every((sample) => sample.tagReads.length > 0 && sample.tagReads.every((tag) => tag.status === 200 && Number.isSafeInteger(tag.version) && atLeast(tag.lastSortedUniqueId, tag.expectedSuid)) && publicQueryEvidence(sample)),
    coverageAndFrontierObserved: receipt.healthSnapshots.every((entry) => entry.coverage !== undefined && Array.isArray(entry.coverageHistory) && Array.isArray(entry.safeLanePasses)),
    observedResponseRelativeReads: receipt.commands.every((sample) => finite(sample.unsafe.responseRelativeMs) && finite(sample.safe.responseRelativeMs)),
  };
  return Object.freeze({ shape: "pass", acceptance, passed: Object.values(acceptance).every(Boolean) });
}

function fixture() {
  const health = { coverage: { kind: "SETTLED" }, coverageHistory: [], safeLanePasses: [] };
  return {
    schema: "sdt-g66-public-e2e/v1",
    contract: { coldFirst: true, minimumInterSampleMs: 10_000 },
    healthSnapshots: [health],
    commands: Array.from({ length: 10 }, (_, index) => {
      const suid = String(index + 1).padStart(30, "0");
      const isRoom = index === 0;
      const id = isRoom ? "room-1" : "reservation-1";
      const expectedStatus = index === 9 ? "cancelled" : "reserved";
      const queryRows = isRoom ? [] : [{ reservationId: id, roomId: "room-1", status: expectedStatus }];
      return {
        target: { kind: isRoom ? "room" : "reservation", id, expectedStatus: isRoom ? "created" : expectedStatus },
        commit: {
          status: 200,
          kind: "committed",
          suid,
          startedAtMs: index * 10_000,
          completedAtMs: index * 10_000 + 10,
          responseMs: 10,
          executor: { readMode: isRoom || index === 1 ? "read-through" : "snapshot-only" },
        },
        healthSnapshots: [health],
        tagReads: [{ status: 200, version: 1, expectedVersion: 1, lastSortedUniqueId: suid, expectedSuid: suid }],
        queryReads: {
          room: { status: 200, result: { count: 1 }, readHead: null },
          reservations: { status: 200, readHead: suid, rows: queryRows },
        },
        unsafe: { disposition: "pass", boundMs: 5_000, firstVisibleAtMs: index * 10_000 + 20, responseRelativeMs: 10, observations: [{ visible: true }] },
        safe: {
          disposition: "pass",
          boundMs: 180_000,
          firstVisibleAtMs: index * 10_000 + 20_000,
          responseRelativeMs: 19_990,
          safeHead: suid,
          publicQuery: { status: 200 },
        },
      };
    }),
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
  paused.commands[1].commit.startedAtMs = paused.commands[0].safe.firstVisibleAtMs + good.contract.minimumInterSampleMs;
  paused.commands[1].commit.completedAtMs = paused.commands[1].commit.startedAtMs + paused.commands[1].commit.responseMs;
  if (inspectG66Receipt(paused).passed) fail("pause-to-safe mutant passed");

  const noUnsafeClock = structuredClone(good);
  delete noUnsafeClock.commands[0].unsafe.firstVisibleAtMs;
  delete noUnsafeClock.commands[0].unsafe.responseRelativeMs;
  if (inspectG66Receipt(noUnsafeClock).passed) fail("unsafe clock mutant passed");

  const badPublicRead = structuredClone(good);
  badPublicRead.commands[0].queryReads.reservations = { status: 500 };
  if (inspectG66Receipt(badPublicRead).passed) fail("public-query mutant passed");

  const late = structuredClone(good);
  late.commands[0].safe.firstVisibleAtMs = late.commands[0].commit.completedAtMs + 180_001;
  late.commands[0].safe.responseRelativeMs = 180_001;
  if (inspectG66Receipt(late).passed) fail("late-success mutant passed");

  const failedWrite = structuredClone(good);
  failedWrite.commands[0].commit.status = 504;
  let failedWriteRed = false;
  try { inspectG66Receipt(failedWrite); } catch { failedWriteRed = true; }
  if (!failedWriteRed) fail("failed-write mutant did not go red");

  const noCoverage = structuredClone(good);
  noCoverage.commands[0].healthSnapshots[0].coverageHistory = null;
  let coverageRed = false;
  try { inspectG66Receipt(noCoverage); } catch { coverageRed = true; }
  if (!coverageRed) fail("coverage/frontier mutant did not go red");

  process.stdout.write(`${JSON.stringify({ selfTest: "sdt-g66-e2e-guards", censoredSafeRed: true, pauseToSafeRed: true, unsafeClockRed: true, publicQueryRed: true, lateSuccessRed: true, failedWriteRed, missingCoverageRed: coverageRed })}\n`);
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
