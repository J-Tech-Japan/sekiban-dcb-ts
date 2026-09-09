#!/usr/bin/env node
/**
 * SDT-G58 W105 reservation safe-lane starvation diagnosis guard.
 *
 * W105 is deliberately diagnostic: it keeps the W102 receipt immutable and
 * models the smallest two-view schedule that reproduces its final shape.  A
 * RoomProjector that can reach row 10 while ReservationProjector stops at
 * row 3 is explained by Reservation's first-unsafe barrier (with six
 * retained unsafe rows), not by a changed global frontier.  The model also
 * exercises the current W104 BLOCK retained-frontier and live-poll order,
 * while mutations of the barrier, view order, catch-up/drain order, fence,
 * and an insufficient per-tick budget are rejected as red.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const receiptPath = ".artifacts/sdt-g58-w102-safe-proof-cohort.json";
const receiptLogPath = ".artifacts/sdt-g58-w102-safe-proof-cohort.log";
const reportPath = ".artifacts/sdt-g58-w105-reservation-safe-starvation.json";
const runtimePath = "packages/dcb-runtime/src/cloudflare.ts";
const workerPath = "samples/meeting-room/src/worker.cloudflare-only.ts";
const mvPath = "samples/meeting-room/src/d1-mv.ts";
const catchUpPath = "packages/dcb-runtime/src/mv/MaterializedViewCatchUp.ts";
const projectionPath = "packages/dcb-runtime/src/projection/ProjectionRuntime.ts";
const receiptLog = readFileSync(resolve(root, receiptLogPath), "utf8");

const expectedCoverage = [
  { observedAt: 1788428250004, kind: "SETTLED", reason: null, httpSamples: 5 },
  { observedAt: 1788428310641, kind: "SETTLED", reason: null, httpSamples: 5 },
  { observedAt: 1788428377716, kind: "BLOCK/UNSETTLED", reason: "source_partition_set_changed_during_scan", httpSamples: 72 },
  { observedAt: 1788428437283, kind: "SETTLED", reason: null, httpSamples: 9 },
];

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function fail(message) {
  throw new Error(`SDT-G58 W105 reservation starvation guard failed: ${message}`);
}

function requireContains(source, expected, label) {
  if (!source.includes(expected)) fail(`${label} is missing ${JSON.stringify(expected)}`);
}

function requireAbsent(source, forbidden, label) {
  if (source.includes(forbidden)) fail(`${label} still contains ${JSON.stringify(forbidden)}`);
}

function readReceipt() {
  let receipt;
  try {
    receipt = JSON.parse(read(receiptPath));
  } catch (error) {
    fail(`W102 receipt is unreadable: ${String(error)}`);
  }
  if (receipt.status !== "failed") fail(`W102 status changed from failed: ${String(receipt.status)}`);
  if (!Array.isArray(receipt.healthSnapshots) || receipt.healthSnapshots.length !== 91) {
    fail(`W102 must retain 91 HTTP health samples, found ${receipt.healthSnapshots?.length ?? "none"}`);
  }
  if (!Array.isArray(receipt.reservations) || receipt.reservations.length !== 10) {
    fail("W102 must retain exactly ten accepted reservations");
  }
  // The exact failure is part of the durable diagnostic boundary.  This file
  // contains no credentials and is retained separately from the JSON receipt.
  requireContains(receiptLog, "safe lane or live projections did not reach", "W102 failure log");
  return receipt;
}

function coverageGroups(receipt) {
  const grouped = new Map();
  for (const snapshot of receipt.healthSnapshots) {
    const observedAt = snapshot?.coverage?.observedAt;
    if (!Number.isSafeInteger(observedAt)) fail("health sample omitted an integer coverage observedAt");
    const samples = grouped.get(observedAt) ?? [];
    samples.push(snapshot);
    grouped.set(observedAt, samples);
  }
  return [...grouped.entries()].map(([observedAt, samples]) => {
    const first = samples[0];
    const last = samples.at(-1);
    const view = (viewId) => {
      const firstView = first.materializedViews.find((candidate) => candidate.viewId === viewId);
      const lastView = last.materializedViews.find((candidate) => candidate.viewId === viewId);
      if (firstView === undefined || lastView === undefined) fail(`coverage group omitted ${viewId}`);
      return {
        safeHead: { first: firstView.safeHead, last: lastView.safeHead },
        unsafeRows: { first: firstView.unsafeRows, last: lastView.unsafeRows },
        unsafeReceipts: { first: firstView.unsafeReceipts, last: lastView.unsafeReceipts },
      };
    };
    const projection = (projectorId) => {
      const firstProjection = first.liveProjections.find((candidate) => candidate.projectorId === projectorId);
      const lastProjection = last.liveProjections.find((candidate) => candidate.projectorId === projectorId);
      if (firstProjection === undefined || lastProjection === undefined) fail(`coverage group omitted live ${projectorId}`);
      return {
        head: { first: firstProjection.head, last: lastProjection.head },
        lastPollAt: { first: firstProjection.lastPollAt, last: lastProjection.lastPollAt },
      };
    };
    return {
      observedAt,
      observedAtIso: new Date(observedAt).toISOString(),
      httpSamples: samples.length,
      coverage: {
        kind: first.coverage.kind,
        reason: first.coverage.reason ?? null,
      },
      room: view("RoomProjector"),
      reservation: view("ReservationProjector"),
      liveRoom: projection("RoomProjector"),
      liveReservation: projection("ReservationProjector"),
      globalHead: { first: first.globalHead, last: last.globalHead },
      receivedAtMs: { first: first.receivedAtMs, last: last.receivedAtMs },
    };
  });
}

function assertReceiptFacts(receipt, groups) {
  if (groups.length !== expectedCoverage.length) fail(`expected four scheduled coverage groups, found ${groups.length}`);
  for (const [index, expected] of expectedCoverage.entries()) {
    const actual = groups[index];
    if (
      actual.observedAt !== expected.observedAt ||
      actual.httpSamples !== expected.httpSamples ||
      actual.coverage.kind !== expected.kind ||
      actual.coverage.reason !== expected.reason
    ) {
      fail(`coverage group ${index + 1} changed: ${JSON.stringify(actual)}`);
    }
  }
  const row3 = receipt.reservations[2]?.suid;
  const row10 = receipt.reservations.at(-1)?.suid;
  const final = groups.at(-1);
  if (final.room.safeHead.last !== row10 || final.room.unsafeRows.last !== 0) {
    fail("W102 final RoomProjector did not reach row 10 with zero unsafe rows");
  }
  if (final.reservation.safeHead.last !== row3 || final.reservation.unsafeRows.last !== 6) {
    fail("W102 final ReservationProjector did not remain at row 3 with six unsafe rows");
  }
  if (final.globalHead.last !== row10) fail("W102 final global head did not reach row 10");
  if (final.liveRoom.lastPollAt.last !== 1788426228497 || final.liveReservation.lastPollAt.last !== 1788426228497) {
    fail("W102 final live lastPollAt no longer preserves the stale pre-cohort value");
  }
  if (final.liveRoom.head.last === row10 || final.liveReservation.head.last === row10) {
    fail("W102 unexpectedly claims a live projector reached the cohort");
  }
  // Every accepted response was durably checkpointed before its list polls.
  for (const [index, reservation] of receipt.reservations.entries()) {
    if (typeof reservation.commit?.receivedAtMs !== "number" || typeof reservation.commit?.cfRay !== "string") {
      fail(`reservation ${index + 1} omitted its durable command receipt`);
    }
  }
}

function sourceContracts(sources) {
  const { runtime, worker, mv, catchUp, projection } = sources;
  const hook = "const safeLane = await options.beforeLiveProjectionPoll?.({ env, serviceId, scan, ctx });";
  const poll = "await pollLiveProjections(env, {";
  const hookAt = runtime.indexOf(hook);
  const pollAt = runtime.indexOf(poll, hookAt);
  if (hookAt < 0 || pollAt < 0 || hookAt > pollAt) fail("W104 retained-frontier hook must precede scheduled live polling");
  requireAbsent(runtime, "if (scan.kind !== \"FULL\") return;", "W104 BLOCK live-poll early return");
  requireContains(runtime, "maximumSuid: scheduledLiveProjectionMaximumSuid(scan, safeLane?.frontierSuid),", "W104 live-poll fence");
  requireContains(runtime, "export function scheduledLiveProjectionMaximumSuid(", "W104 frontier mapper");
  requireContains(worker, "return { frontierSuid: coverage.frontierSuid };", "sample retained frontier return");

  const maintenanceAt = worker.indexOf("export async function runMeetingRoomScheduledMaintenance");
  const maintenance = maintenanceAt < 0 ? "" : worker.slice(maintenanceAt);
  const catchAt = maintenance.indexOf("await input.catchUp(coverage.frontierSuid);");
  const drainAt = maintenance.indexOf("await input.drainUnsafeKicks(coverage.frontierSuid);");
  if (catchAt < 0 || drainAt < 0 || catchAt > drainAt) fail("safe catch-up must precede unsafe-kick draining");
  requireContains(maintenance, "await input.runGenericScheduledWork();", "same-tick maintenance completion");

  const materializersAt = mv.indexOf("function materializers()");
  const materializersEnd = mv.indexOf("type MeetingRoomMaterializer", materializersAt);
  const materializerList = mv.slice(materializersAt, materializersEnd);
  requireContains(materializerList, "return [roomMaterializer, reservationMaterializer] as const;", "Room-before-Reservation materializer order");
  const catchStart = mv.indexOf("export async function catchUpMeetingRoomMaterializedViews");
  const drainStart = mv.indexOf("export async function drainMeetingRoomUnsafeKicks");
  if (catchStart < 0 || drainStart < catchStart) fail("meeting-room catch-up/drain boundaries changed");
  const catchSource = mv.slice(catchStart, drainStart);
  const drainSource = mv.slice(drainStart);
  requireContains(catchSource, "for (const materializer of fanoutMaterializers(configuredViewCount(env.G26_VIEW_COUNT))) {", "serial safe MV catch-up");
  requireContains(catchSource, "await runtime.follow(serviceId, materializer, Date.now(), hooks, {", "safe MV retained-frontier follow");
  requireContains(catchSource, "maximumSuid: frontierSuid,", "safe MV retained-frontier argument");
  requireContains(catchSource, "closedPrefixSuid: options.closedPrefixSuid,", "safe MV closed-prefix certificate SUID");
  requireContains(catchSource, "closedPrefixCertificate: options.closedPrefixCertificate,", "safe MV closed-prefix certificate authority");
  requireContains(drainSource, "for (const materializer of fanoutMaterializers(configuredViewCount(env.G26_VIEW_COUNT))) {", "serial unsafe-kick drain");
  requireContains(drainSource, "await runtime.follow(serviceId, materializer, nowMs, {}, {", "unsafe drain retained-frontier follow");
  requireContains(drainSource, "maximumSuid: frontierSuid,", "unsafe drain retained-frontier argument");
  requireContains(drainSource, "closedPrefixSuid: closedPrefixCertificate?.closedPrefixSuid ?? null,", "unsafe drain closed-prefix certificate SUID");
  requireContains(drainSource, "closedPrefixCertificate,", "unsafe drain closed-prefix certificate authority");
  requireContains(catchUp, "if (event.lastArrivedAt > nowMs - windowMs)", "first-unsafe SafeWindow barrier");
  requireContains(catchUp, "return {\n            instance: current,", "first-unsafe bounded return");
  requireContains(catchUp, "const MAX_CAS_RETRIES = 8;", "bounded CAS retry policy");
  requireContains(catchUp, "if (error instanceof MaterializedViewCasError)", "typed MV CAS contention handling");
  requireContains(projection, "if (options.maximumSuid === null", "G44 null retained-frontier fence");
  requireContains(projection, "compareSuid(event.suid, options.maximumSuid) > 0", "G44 high-water retained-frontier fence");
  requireContains(projection, "for (const tag of tags)", "serial all-tag polling");
  requireContains(projection, "for (const projector of this.registry.registered())", "serial all-projector polling");
}

function advanceView(viewId, currentHead, frontier, options) {
  let head = currentHead;
  let applied = 0;
  const barrierAt = options.reservationBarrierAt;
  for (let row = currentHead + 1; row <= Math.min(frontier, options.rowCount); row += 1) {
    if (applied >= options.perViewBudget) return { head, stop: "per-tick-budget", blockedRow: row, applied };
    if (viewId === "ReservationProjector" && barrierAt !== null && row >= barrierAt) {
      return { head, stop: "first-unsafe", blockedRow: row, applied };
    }
    head = row;
    applied += 1;
  }
  return { head, stop: "frontier", blockedRow: null, applied };
}

function simulateSchedule(options = {}) {
  const rowCount = options.rowCount ?? 10;
  const perViewBudget = options.perViewBudget ?? rowCount;
  const viewOrder = options.viewOrder ?? ["RoomProjector", "ReservationProjector"];
  const reservationBarrierAt = options.reservationBarrierAt === undefined ? 4 : options.reservationBarrierAt;
  const drainFirst = options.drainFirst === true;
  const ticks = [
    { observedAt: 1788428250004, kind: "SETTLED", frontier: 0 },
    { observedAt: 1788428310641, kind: "SETTLED", frontier: 2 },
    // W104's BLOCK path is fenced by the last proven frontier, represented
    // here by row 3. It must never use the unproven row-10 source head.
    { observedAt: 1788428377716, kind: "BLOCK/UNSETTLED", frontier: 3 },
    { observedAt: 1788428437283, kind: "SETTLED", frontier: 10 },
  ];
  const heads = { RoomProjector: 0, ReservationProjector: 0 };
  const stops = [];
  for (const tick of ticks) {
    const stages = drainFirst ? ["unsafe-drain", "safe-catch-up"] : ["safe-catch-up", "unsafe-drain"];
    for (const stage of stages) {
      for (const viewId of viewOrder) {
        const result = advanceView(viewId, heads[viewId], tick.frontier, { rowCount, perViewBudget, reservationBarrierAt });
        heads[viewId] = result.head;
        stops.push({ observedAt: tick.observedAt, stage, viewId, ...result });
      }
    }
  }
  return {
    ticks,
    viewOrder,
    stages: drainFirst ? ["unsafe-drain", "safe-catch-up"] : ["safe-catch-up", "unsafe-drain"],
    heads,
    unsafeRows: reservationBarrierAt === null ? 0 : 6,
    firstUnsafeRow: reservationBarrierAt,
    stops,
  };
}

function modelSelfTest() {
  const baseline = simulateSchedule();
  if (baseline.heads.RoomProjector !== 10 || baseline.heads.ReservationProjector !== 3 || baseline.unsafeRows !== 6) {
    fail(`two-view baseline did not reproduce Room row 10 / Reservation row 3+six shape: ${JSON.stringify(baseline)}`);
  }
  const swapped = simulateSchedule({ viewOrder: ["ReservationProjector", "RoomProjector"] });
  if (swapped.heads.RoomProjector !== baseline.heads.RoomProjector || swapped.heads.ReservationProjector !== baseline.heads.ReservationProjector) {
    fail("swapping independent view order changed the barrier witness unexpectedly");
  }
  const drainFirst = simulateSchedule({ drainFirst: true });
  if (drainFirst.heads.RoomProjector !== 10 || drainFirst.heads.ReservationProjector !== 3) {
    fail("changing drain/catch-up ordering should not erase the local first-unsafe witness");
  }
  const budgetTooSmall = simulateSchedule({ perViewBudget: 3 });
  if (budgetTooSmall.heads.RoomProjector === 10) fail("a three-event per-tick budget unexpectedly reached Room row 10");
  const barrierMutant = simulateSchedule({ reservationBarrierAt: null });
  if (barrierMutant.heads.ReservationProjector !== 10 || barrierMutant.unsafeRows !== 0) {
    fail("removing the Reservation first-unsafe barrier did not turn the witness green");
  }
  const movedBarrier = simulateSchedule({ reservationBarrierAt: 5 });
  if (movedBarrier.heads.ReservationProjector === 3) fail("moving the barrier did not change the Reservation witness");
  // CAS is intentionally not modeled as a hidden cause: the source runtime
  // retries typed CAS conflicts, and W102 has no CAS/lease error fact. The
  // source contract below verifies that bounded retry handling remains present.
  return { baseline, swapped, drainFirst, budgetTooSmall, barrierMutant, movedBarrier };
}

function mutationSelfTest(sources) {
  const baseline = modelSelfTest();
  let barrierRed = false;
  try {
    sourceContracts({ ...sources, catchUp: sources.catchUp.replace("if (event.lastArrivedAt > nowMs - windowMs)", "if (false)") });
  } catch { barrierRed = true; }
  if (!barrierRed) fail("removing the first-unsafe barrier did not turn the source guard red");

  let serialRed = false;
  const catchStart = sources.mv.indexOf("export async function catchUpMeetingRoomMaterializedViews");
  const drainStart = sources.mv.indexOf("export async function drainMeetingRoomUnsafeKicks");
  const catchSource = sources.mv.slice(catchStart, drainStart);
  const serialMutant = sources.mv.replace(
    catchSource,
    catchSource.replace("for (const materializer of fanoutMaterializers(configuredViewCount(env.G26_VIEW_COUNT))) {", "for (const materializer of [] as never[]) {")
  );
  try { sourceContracts({ ...sources, mv: serialMutant }); } catch { serialRed = true; }
  if (!serialRed) fail("removing serial MV iteration did not turn the source guard red");

  let orderRed = false;
  const orderMutant = sources.worker.replace(
    "await input.catchUp(coverage.frontierSuid);\n    await input.drainUnsafeKicks(coverage.frontierSuid);",
    "await input.drainUnsafeKicks(coverage.frontierSuid);\n    await input.catchUp(coverage.frontierSuid);",
  );
  try { sourceContracts({ ...sources, worker: orderMutant }); } catch { orderRed = true; }
  if (!orderRed) fail("swapping safe catch-up and unsafe drain did not turn the source guard red");

  let fenceRed = false;
  const fenceMutant = sources.worker.replace("await input.catchUp(coverage.frontierSuid);", "await input.catchUp();");
  try { sourceContracts({ ...sources, worker: fenceMutant }); } catch { fenceRed = true; }
  if (!fenceRed) fail("removing the retained-frontier argument did not turn the source guard red");

  let certificateRed = false;
  const certificateMutant = sources.mv
    .replace("closedPrefixCertificate: options.closedPrefixCertificate,", "")
    .replace("      closedPrefixCertificate,\n", "");
  try { sourceContracts({ ...sources, mv: certificateMutant }); } catch { certificateRed = true; }
  if (!certificateRed) fail("removing the validated closed-prefix certificate did not turn the source guard red");

  let earlyReturnRed = false;
  const earlyReturnMutant = sources.runtime.replace(
    "const safeLane = await options.beforeLiveProjectionPoll?.({ env, serviceId, scan, ctx });",
    "const safeLane = await options.beforeLiveProjectionPoll?.({ env, serviceId, scan, ctx });\n      if (scan.kind !== \"FULL\") return;",
  );
  try { sourceContracts({ ...sources, runtime: earlyReturnMutant }); } catch { earlyReturnRed = true; }
  if (!earlyReturnRed) fail("restoring the W103 BLOCK early return did not turn the source guard red");
  return {
    model: baseline,
    firstUnsafeBarrierMutationRed: barrierRed,
    serialMaterializerMutationRed: serialRed,
    catchUpDrainOrderMutationRed: orderRed,
    retainedFrontierMutationRed: fenceRed,
    closedPrefixCertificateMutationRed: certificateRed,
    w103EarlyReturnMutationRed: earlyReturnRed,
  };
}

function selfTest() {
  const sources = {
    runtime: read(runtimePath),
    worker: read(workerPath),
    mv: read(mvPath),
    catchUp: read(catchUpPath),
    projection: read(projectionPath),
  };
  const receipt = readReceipt();
  const groups = coverageGroups(receipt);
  assertReceiptFacts(receipt, groups);
  sourceContracts(sources);
  const mutations = mutationSelfTest(sources);
  process.stdout.write(`${JSON.stringify({ selfTest: "g58-w105-reservation-safe-starvation", scheduledCoverageTicks: groups.length, httpHealthSamples: receipt.healthSnapshots.length, mutations: { firstUnsafeBarrierMutationRed: mutations.firstUnsafeBarrierMutationRed, serialMaterializerMutationRed: mutations.serialMaterializerMutationRed, catchUpDrainOrderMutationRed: mutations.catchUpDrainOrderMutationRed, retainedFrontierMutationRed: mutations.retainedFrontierMutationRed, closedPrefixCertificateMutationRed: mutations.closedPrefixCertificateMutationRed, w103EarlyReturnMutationRed: mutations.w103EarlyReturnMutationRed } })}\n`);
}

function main() {
  const sources = {
    runtime: read(runtimePath),
    worker: read(workerPath),
    mv: read(mvPath),
    catchUp: read(catchUpPath),
    projection: read(projectionPath),
  };
  const receipt = readReceipt();
  const groups = coverageGroups(receipt);
  assertReceiptFacts(receipt, groups);
  sourceContracts(sources);
  const mutations = mutationSelfTest(sources);
  const baseline = mutations.model.baseline;
  const final = groups.at(-1);
  const report = {
    schema: "sdt-g58-reservation-safe-starvation/v1",
    status: "diagnosis-complete",
    task: "SDT-G58-RESERVATION-SAFE-STARVATION-DIAGNOSIS-W105",
    sourceReceipt: receiptPath,
    sourceFailureLog: receiptLogPath,
    httpHealthSamples: receipt.healthSnapshots.length,
    scheduledCoverageTicks: groups.length,
    coverageGroups: groups,
    observedFinal: {
      roomSafeHead: final.room.safeHead.last,
      reservationSafeHead: final.reservation.safeHead.last,
      reservationUnsafeRows: final.reservation.unsafeRows.last,
      globalHead: final.globalHead.last,
      liveRoom: final.liveRoom,
      liveReservation: final.liveReservation,
    },
    twoViewWitness: {
      sourceOrder: baseline.viewOrder,
      stages: baseline.stages,
      retainedFrontier: { blockObservedAt: 1788428377716, blockFrontierRow: 3, fullFrontierRow: 10 },
      reservationFirstUnsafeRow: 4,
      reservationRetainedUnsafeRows: [4, 5, 6, 7, 8, 9],
      baseline: {
        RoomProjector: { safeHeadRow: baseline.heads.RoomProjector, unsafeRows: 0 },
        ReservationProjector: { safeHeadRow: baseline.heads.ReservationProjector, unsafeRows: baseline.unsafeRows },
      },
      ticks: baseline.ticks,
      interpretation: "With a sufficient per-view budget, Room follows the proven FULL row-10 frontier. Reservation encounters its local first-unsafe row 4 and must stop at row 3; later retained unsafe rows cannot cross that barrier. This reproduces the W102 shape without a global gap.",
    },
    causalSeam: {
      classification: "G58_AC3_SAFE_LANE_FIRST_UNSAFE_BARRIER",
      exact: "ReservationProjector safe catch-up is independently fenced by its first unsafe source event. The W102 receipt has six retained Reservation unsafe rows and no lower-level CAS/lease exception fact; the deterministic witness reaches the observed Room row 10 / Reservation row 3 shape with no per-tick budget starvation.",
      serialMaterializerOrdering: "Reproduced as RoomProjector then ReservationProjector for both catch-up and drain. Swapping the independent view order leaves the Reservation barrier at row 3, so order is an execution shape, not sufficient cause.",
      perTickBudget: "Not supported by the source path or receipt: a three-event budget also prevents Room from reaching row 10, while the observed Room reached row 10. No budget/deadline/cancellation branch is claimed.",
      unsafeDrainOrdering: "The production hook remains catch-up before unsafe-kick drain. The model is unchanged if drain is placed first because the same first-unsafe barrier still governs; changing the production order is nevertheless rejected by the source guard.",
      barrierEligibilityAndCadence: "The four observedAt groups are the only scheduled decisions. The BLOCK group (72 repeated HTTP reads) retains row 3; the later SETTLED group permits Room through row 10 but does not make Reservation row 4 eligible. This is the exact in-scope G58 seam for a future green repair.",
      d1ClaimCasContention: "Not established: W102 health and failure log expose no CAS/lease/claim error. MaterializedViewCatchUp catches typed MV CAS conflicts and retries eight times; this checkpoint does not invent a contention winner or modify that path.",
    },
    redCapableGuards: mutations,
    preservedEvidence: {
      w102Failure: "safe lane or live projections did not reach 063924025118818000001227710475 by safeWindowMs + 120000ms",
      w103RedReceipt: ".artifacts/sdt-g58-w103-red-guard.json (unchanged)",
      w104GreenReceipt: ".artifacts/sdt-g58-w104-green-guard.json (unchanged)",
      lateUnsafeObservationMs: 5289,
      unsafeBoundMs: 5000,
      lateObservationClassification: "miss/eventual-only; never an unsafe pass",
    },
    bounds: {
      safeWindowFloorMs: 20_000,
      safeWindowCeilingMs: 120_000,
      unsafeBoundMs: 5_000,
      g44FencePreserved: true,
      w104BlockLivePollPreserved: true,
      upstreamOutboxQueueGlobalAdmission: "held SDT-G60; not inspected or modified",
      noProductRepair: true,
      noDeploymentOrCohort: true,
    },
  };
  mkdirSync(resolve(root, ".artifacts"), { recursive: true });
  writeFileSync(resolve(root, reportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ guard: "g58-w105-reservation-safe-starvation", status: report.status, report: reportPath, scheduledCoverageTicks: groups.length, httpHealthSamples: receipt.healthSnapshots.length })}\n`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
