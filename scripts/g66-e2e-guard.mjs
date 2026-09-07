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
    "responseRelativeMs", "publicQuery", "continuousWrites", "affectedTagReads",
    "waitForSortableUniqueId", "expectedFinalState", "finalConsistency", "safePredicate", "terminal-state",
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
  const target = sample.safePredicate ?? sample.target;
  if (target?.kind === "room") {
    const result = room.result ?? parsed(room.body?.resultJson, null);
    return result !== null && typeof result === "object" && Number(result.count) === 1;
  }
  const rows = Array.isArray(reservations.rows) ? reservations.rows : parsed(reservations.body?.itemsJson, null);
  return Array.isArray(rows)
    && atLeast(reservations.readHead, sample.commit.suid)
    && rows.filter((row) => row?.reservationId === target?.id).length === 1
    && rows.some((row) => row?.reservationId === target?.id && row?.status === target?.expectedStatus);
}

function expectedTags(sample) {
  const outer = sample.commit?.body !== null && typeof sample.commit?.body === "object" ? sample.commit.body : {};
  const response = outer.response !== null && typeof outer.response === "object" ? outer.response : {};
  const events = Array.isArray(response.writtenEvents) ? response.writtenEvents : Array.isArray(outer.writtenEvents) ? outer.writtenEvents : [];
  const tags = [];
  for (const event of events) {
    const expectedSuid = typeof event?.sortableUniqueIdValue === "string" ? event.sortableUniqueIdValue : sample.commit.suid;
    for (const tag of Array.isArray(event?.tags) ? event.tags : []) {
      if (typeof tag !== "string") continue;
      const projector = tag.startsWith("room:") ? "RoomProjector" : tag.startsWith("reservation:") ? "ReservationProjector" : "";
      if (projector.length > 0) tags.push({ tag, projector, expectedSuid });
    }
  }
  return tags;
}

function exactFinalQuery(receipt) {
  const expected = receipt.expectedFinalState?.reservations;
  const rows = receipt.finalQuery?.reservations?.rows;
  if (!Array.isArray(expected) || !Array.isArray(rows) || receipt.finalQuery?.reservations?.status !== 200) return false;
  if (rows.length !== expected.length) return false;
  const ids = rows.map((row) => row?.reservationId);
  if (new Set(ids).size !== ids.length) return false;
  const observed = new Map(rows.map((row) => [row?.reservationId, row]));
  return expected.every((row) => {
    const actual = observed.get(row.reservationId);
    return actual?.roomId === row.roomId && actual?.status === row.status;
  });
}

function observedClock(sample, lane) {
  const observation = lane === "unsafe" ? sample.unsafe : sample.safe;
  const bound = lane === "unsafe" ? 5_000 : 180_000;
  if (observation?.disposition !== "pass" || observation.boundMs !== bound) return false;
  if (!finite(observation.firstVisibleAtMs) || !finite(observation.responseRelativeMs)) return false;
  if (observation.firstVisibleAtMs - sample.commit.completedAtMs !== observation.responseRelativeMs) return false;
  if (observation.responseRelativeMs < 0 || observation.responseRelativeMs > bound) return false;
  return observation.observedAtMs === undefined || observation.observedAtMs === observation.firstVisibleAtMs;
}

function sampleShape(sample, index) {
  if (sample === null || typeof sample !== "object") fail(`sample ${index} is not an object`);
  if (sample.commit?.status !== 200 || sample.commit?.kind !== "committed" || !SUID.test(sample.commit?.suid ?? "")) fail(`sample ${index} accepted commit is missing`);
  if (!finite(sample.commit.startedAtMs) || !finite(sample.commit.completedAtMs) || !finite(sample.commit.responseMs)) fail(`sample ${index} command clocks are missing`);
  if (sample.commit.completedAtMs < sample.commit.startedAtMs || sample.commit.responseMs < 0 || sample.commit.completedAtMs - sample.commit.startedAtMs !== sample.commit.responseMs) fail(`sample ${index} command clock order is invalid`);
  if (!Array.isArray(sample.healthSnapshots) || sample.healthSnapshots.length === 0) fail(`sample ${index} has no per-tick health receipt`);
  if (!sample.healthSnapshots.every((entry) => entry.coverage !== undefined && Array.isArray(entry.coverageHistory) && Array.isArray(entry.safeLanePasses))) fail(`sample ${index} has incomplete coverage/frontier receipt`);
  const safePredicate = sample.safePredicate;
  if (safePredicate?.mode !== "terminal-state" || safePredicate.kind !== sample.target.kind || safePredicate.id !== sample.target.id || typeof safePredicate.expectedStatus !== "string") fail(`sample ${index} has no terminal safe predicate`);
  const expected = expectedTags(sample);
  if (!Array.isArray(sample.tagReads) || sample.tagReads.length !== expected.length || expected.length === 0) fail(`sample ${index} has incomplete affected-tag set`);
  const tagKeys = new Set(sample.tagReads.map((tag) => `${tag.tag}:${tag.projector}`));
  if (tagKeys.size !== sample.tagReads.length || !expected.every((tag) => tagKeys.has(`${tag.tag}:${tag.projector}`))) fail(`sample ${index} has missing or unrelated affected-tag evidence`);
  if (!sample.tagReads.every((tag) => tag.status === 200 && Number.isSafeInteger(tag.version) && Number.isSafeInteger(tag.expectedVersion) && tag.version >= tag.expectedVersion && atLeast(tag.lastSortedUniqueId, tag.expectedSuid))) fail(`sample ${index} has incomplete committed tag evidence`);
  if (sample.unsafe?.disposition !== "pass" && sample.unsafe?.disposition !== "censored") fail(`sample ${index} unsafe is neither pass nor explicit censored`);
  if (sample.safe?.disposition !== "pass" && sample.safe?.disposition !== "censored") fail(`sample ${index} safe is neither pass nor explicit censored`);
  if (sample.unsafe?.disposition === "pass") {
    if (!observedClock(sample, "unsafe") || !Array.isArray(sample.unsafe.observations) || sample.unsafe.observations.length === 0) fail(`sample ${index} has invalid unsafe clock/bound`);
    if (!sample.unsafe.observations.some((observation) => observation.visible === true && observation.completedAtMs === sample.unsafe.firstVisibleAtMs)) fail(`sample ${index} has no observed unsafe visibility at its claimed clock`);
  }
  if (sample.safe?.disposition === "pass") {
    if (!observedClock(sample, "safe") || sample.safe.publicQuery?.status !== 200 || sample.safe.publicQuery?.visible !== true) fail(`sample ${index} has invalid safe clock/bound/public proof`);
    if (!atLeast(sample.safe.safeHead, sample.commit.suid)) fail(`sample ${index} safe materialized-view head is behind its commit`);
    if (safePredicate.kind === "reservation" && !atLeast(sample.safe.publicQuery.readHead, sample.commit.suid)) fail(`sample ${index} safe readHead is behind its commit`);
  }
}

function laterSafePredicateMutation(receipt, index) {
  const sample = receipt.commands[index];
  if (sample?.target?.kind !== "reservation") return null;
  return receipt.commands.slice(index + 1).find((candidate) => candidate?.commandId === "cancel-reservation"
    && candidate.target?.kind === "reservation"
    && candidate.target.id === sample.target.id
    && candidate.commit?.status === 200
    && candidate.commit?.kind === "committed") ?? null;
}

export function inspectG66Receipt(receipt) {
  if (receipt?.schema !== "sdt-g66-public-e2e/v1") fail("wrong receipt schema");
  if (receipt?.contract?.coldFirst !== true) fail("cold-first requirement is absent");
  if (!Number.isSafeInteger(receipt?.contract?.minimumInterSampleMs) || receipt.contract.minimumInterSampleMs < 10_000) fail("10-second pacing is absent");
  if (!Array.isArray(receipt.commands) || receipt.commands.length < 10) fail("fewer than ten command rows");
  receipt.commands.forEach(sampleShape);
  receipt.commands.forEach((sample, index) => {
    const later = laterSafePredicateMutation(receipt, index);
    if (later === null) return;
    const predicate = sample.safePredicate;
    if (predicate?.mode !== "terminal-state"
      || predicate.terminalMutationOrdinal !== later.ordinal
      || predicate.expectedStatus !== later.target.expectedStatus) {
      fail(`sample ${index} safe predicate was mutated by later sample ${later.ordinal}`);
    }
  });
  if (!receipt.commands.some((sample) => sample.commit.executor?.readMode === "read-through")) fail("no read-through command");
  if (!receipt.commands.some((sample) => sample.commit.executor?.readMode === "snapshot-only")) fail("no snapshot-only command");
  if (!Array.isArray(receipt.healthSnapshots) || receipt.healthSnapshots.length === 0) fail("no cohort health receipt");
  const paced = receipt.commands.every((sample, index) => index === 0 || sample.commit.startedAtMs - receipt.commands[index - 1].commit.startedAtMs >= receipt.contract.minimumInterSampleMs);
  const continuous = receipt.commands.some((sample, index) => index > 0
    && finite(receipt.commands[index - 1].safe?.firstVisibleAtMs)
    && sample.commit.startedAtMs < receipt.commands[index - 1].safe.firstVisibleAtMs);
  const acceptance = {
    allAccepted: receipt.commands.every((sample) => sample.commit.status === 200 && sample.commit.kind === "committed"),
    allUnsafeWithinBound: receipt.commands.every((sample) => observedClock(sample, "unsafe")),
    allSafeWithinBound: receipt.commands.every((sample) => observedClock(sample, "safe")),
    continuousPacedWrites: paced && continuous,
    tagStateAndQueryReads: receipt.commands.every((sample) => sample.tagReads.length > 0 && publicQueryEvidence(sample)),
    coverageAndFrontierObserved: receipt.healthSnapshots.every((entry) => entry.coverage !== undefined && Array.isArray(entry.coverageHistory) && Array.isArray(entry.safeLanePasses)),
    observedResponseRelativeReads: receipt.commands.every((sample) => observedClock(sample, "unsafe") && observedClock(sample, "safe")),
    finalQueryConsistency: receipt.finalConsistency?.exactReservationSet === true && exactFinalQuery(receipt),
  };
  return Object.freeze({ shape: "pass", acceptance, passed: Object.values(acceptance).every(Boolean) });
}

export function createG66GuardFixture() {
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
      const safeExpectedStatus = !isRoom && index === 8 ? "cancelled" : expectedStatus;
      const tag = `${isRoom ? "room" : "reservation"}:${id}`;
      const queryRows = isRoom ? [] : [{ reservationId: id, roomId: "room-1", status: safeExpectedStatus }];
      const completedAtMs = index * 10_000 + 10;
      return {
        target: { kind: isRoom ? "room" : "reservation", id, expectedStatus: isRoom ? "created" : expectedStatus },
        safePredicate: {
          mode: "terminal-state",
          kind: isRoom ? "room" : "reservation",
          id,
          expectedStatus: isRoom ? "created" : safeExpectedStatus,
          terminalMutationOrdinal: !isRoom && index === 8 ? 10 : null,
        },
        commit: {
          status: 200,
          kind: "committed",
          suid,
          startedAtMs: index * 10_000,
          completedAtMs,
          responseMs: 10,
          executor: { readMode: isRoom || index === 1 ? "read-through" : "snapshot-only" },
          body: { response: { writtenEvents: [{ sortableUniqueIdValue: suid, tags: [tag] }] } },
        },
        healthSnapshots: [health],
        tagReads: [{ tag, projector: isRoom ? "RoomProjector" : "ReservationProjector", status: 200, version: 1, expectedVersion: 1, lastSortedUniqueId: suid, expectedSuid: suid }],
        queryReads: {
          room: { status: 200, result: { count: 1 }, readHead: null },
          reservations: { status: 200, readHead: suid, rows: queryRows },
        },
        unsafe: { disposition: "pass", boundMs: 5_000, firstVisibleAtMs: completedAtMs + 10, responseRelativeMs: 10, observations: [{ visible: true, completedAtMs: completedAtMs + 10 }] },
        safe: {
          disposition: "pass",
          boundMs: 180_000,
          firstVisibleAtMs: completedAtMs + 19_990,
          observedAtMs: completedAtMs + 19_990,
          responseRelativeMs: 19_990,
          safeHead: suid,
          publicQuery: { status: 200, visible: true, readHead: suid, completedAtMs: completedAtMs + 19_990, body: { itemsJson: JSON.stringify(queryRows) } },
        },
      };
    }),
    expectedFinalState: { roomId: "room-1", reservations: [{ reservationId: "reservation-1", roomId: "room-1", status: "cancelled" }] },
    finalQuery: { reservations: { status: 200, rows: [{ reservationId: "reservation-1", roomId: "room-1", status: "cancelled" }] } },
    finalConsistency: { exactReservationSet: true },
  };
}

function passes(receipt) {
  try { return inspectG66Receipt(receipt).passed; } catch { return false; }
}

export function selfTest() {
  assertG66HarnessSource(read(HARNESS));
  const good = createG66GuardFixture();
  if (!inspectG66Receipt(good).passed) fail("good fixture did not pass");

  const censored = structuredClone(good);
  censored.commands[0].safe = { disposition: "censored" };
  if (passes(censored)) fail("censored safe mutant passed");

  const paused = structuredClone(good);
  paused.commands[1].commit.startedAtMs = paused.commands[0].safe.firstVisibleAtMs + good.contract.minimumInterSampleMs;
  paused.commands[1].commit.completedAtMs = paused.commands[1].commit.startedAtMs + paused.commands[1].commit.responseMs;
  paused.commands[1].unsafe.firstVisibleAtMs = paused.commands[1].commit.completedAtMs + 10;
  paused.commands[1].unsafe.observations[0].completedAtMs = paused.commands[1].unsafe.firstVisibleAtMs;
  paused.commands[1].safe.firstVisibleAtMs = paused.commands[1].commit.completedAtMs + 19_990;
  paused.commands[1].safe.observedAtMs = paused.commands[1].safe.firstVisibleAtMs;
  paused.commands[1].safe.responseRelativeMs = 19_990;
  paused.commands[1].safe.publicQuery.completedAtMs = paused.commands[1].safe.firstVisibleAtMs;
  if (passes(paused)) fail("pause-to-safe mutant passed");

  const chronological = structuredClone(good);
  for (let index = 1; index < chronological.commands.length; index += 1) {
    const previous = chronological.commands[index - 1];
    const current = chronological.commands[index];
    current.commit.startedAtMs = previous.safe.firstVisibleAtMs + good.contract.minimumInterSampleMs;
    current.commit.completedAtMs = current.commit.startedAtMs + current.commit.responseMs;
    current.unsafe.firstVisibleAtMs = current.commit.completedAtMs + 10;
    current.unsafe.responseRelativeMs = 10;
    current.unsafe.observations[0].completedAtMs = current.unsafe.firstVisibleAtMs;
    current.safe.firstVisibleAtMs = current.commit.completedAtMs + 19_990;
    current.safe.observedAtMs = current.safe.firstVisibleAtMs;
    current.safe.responseRelativeMs = 19_990;
    current.safe.publicQuery.completedAtMs = current.safe.firstVisibleAtMs;
  }
  if (passes(chronological)) fail("fully chronological pause-to-safe mutant passed");

  const noUnsafeClock = structuredClone(good);
  delete noUnsafeClock.commands[0].unsafe.firstVisibleAtMs;
  delete noUnsafeClock.commands[0].unsafe.responseRelativeMs;
  if (passes(noUnsafeClock)) fail("unsafe clock mutant passed");

  const badPublicRead = structuredClone(good);
  badPublicRead.commands[0].queryReads.reservations = { status: 500 };
  if (passes(badPublicRead)) fail("public-query mutant passed");

  const late = structuredClone(good);
  late.commands[0].safe.firstVisibleAtMs = late.commands[0].commit.completedAtMs + 180_001;
  late.commands[0].safe.observedAtMs = late.commands[0].safe.firstVisibleAtMs;
  late.commands[0].safe.responseRelativeMs = 180_001;
  if (passes(late)) fail("late-success mutant passed");

  const absoluteClock = structuredClone(good);
  absoluteClock.commands.forEach((sample) => { sample.unsafe.firstVisibleAtMs = sample.commit.completedAtMs + 999_999; });
  if (passes(absoluteClock)) fail("absolute-clock mutant passed");

  const safeHead = structuredClone(good);
  safeHead.commands[0].safe.safeHead = "000000000000000000000000000000";
  safeHead.commands[0].safe.publicQuery.readHead = "000000000000000000000000000000";
  if (passes(safeHead)) fail("safe-head mutant passed");

  const inflatedBound = structuredClone(good);
  inflatedBound.commands[0].unsafe.boundMs = 999_999;
  inflatedBound.commands[0].safe.boundMs = 999_999;
  if (passes(inflatedBound)) fail("inflated-bound mutant passed");

  const unsafeObservation = structuredClone(good);
  unsafeObservation.commands[0].unsafe.observations = [{ visible: false, status: 500, completedAtMs: unsafeObservation.commands[0].unsafe.firstVisibleAtMs }];
  if (passes(unsafeObservation)) fail("unsafe-observation mutant passed");

  const duplicateFinal = structuredClone(good);
  duplicateFinal.finalQuery.reservations.rows.push({ reservationId: "reservation-1", roomId: "room-1", status: "cancelled" });
  duplicateFinal.finalConsistency.exactReservationSet = false;
  if (passes(duplicateFinal)) fail("duplicate-final-query mutant passed");

  const staleReadHead = structuredClone(good);
  staleReadHead.commands[1].safe.publicQuery.readHead = staleReadHead.commands[0].commit.suid;
  if (passes(staleReadHead)) fail("stale-read-head mutant passed");

  const laterSafePredicate = structuredClone(good);
  laterSafePredicate.commands[8].safePredicate.expectedStatus = "reserved";
  laterSafePredicate.commands[8].safePredicate.terminalMutationOrdinal = null;
  if (passes(laterSafePredicate)) fail("later-safe-predicate-mutation mutant passed");

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

  process.stdout.write(`${JSON.stringify({ selfTest: "sdt-g66-e2e-guards", censoredSafeRed: true, pauseToSafeRed: true, chronologicalPauseRed: true, unsafeClockRed: true, publicQueryRed: true, lateSuccessRed: true, absoluteClockRed: true, safeHeadRed: true, inflatedBoundRed: true, unsafeObservationRed: true, duplicateFinalRed: true, staleReadHeadRed: true, laterSafePredicateMutationRed: true, failedWriteRed, missingCoverageRed: coverageRed })}\n`);
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
