#!/usr/bin/env node
/**
 * SDT-G58 W103 safe/live starvation diagnosis guard.
 *
 * This is a read-only diagnosis guard.  It deliberately preserves the
 * current BLOCK early-return as a red baseline: a future focused repair must
 * make the BLOCK scheduled tick poll live projections without changing the
 * retained-frontier fence.  The guard also turns the W102 receipt into a
 * compact, reviewable tick/progress table and checks the serial per-view and
 * minimum-across-tags source contracts.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const receiptPath = ".artifacts/sdt-g58-w102-safe-proof-cohort.json";
const reportPath = ".artifacts/sdt-g58-w103-red-guard.json";
const runtimePath = "packages/dcb-runtime/src/cloudflare.ts";
const workerPath = "samples/meeting-room/src/worker.cloudflare-only.ts";
const mvPath = "samples/meeting-room/src/d1-mv.ts";
const deliveryPath = "packages/dcb-runtime/src/downstream/DeliveryCore.ts";
const catchUpPath = "packages/dcb-runtime/src/mv/MaterializedViewCatchUp.ts";
const livePath = "packages/dcb-runtime/src/projection/ProjectionRuntime.ts";

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function fail(message) {
  throw new Error(`SDT-G58 W103 starvation guard failed: ${message}`);
}

function requireContains(source, expected, label) {
  if (!source.includes(expected)) fail(`${label} is missing ${JSON.stringify(expected)}`);
}

function requireUnique(source, expected, label) {
  const count = source.split(expected).length - 1;
  if (count !== 1) fail(`${label} expected one occurrence of ${JSON.stringify(expected)}, found ${count}`);
}

function compareSuid(left, right) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function minimumSuid(values) {
  return values.reduce((minimum, value) => minimum === "" || compareSuid(value, minimum) < 0 ? value : minimum, "");
}

function minimumNumber(values) {
  return Math.min(...values);
}

function replaceAfter(source, anchor, from, to) {
  const anchorAt = source.indexOf(anchor);
  const fromAt = source.indexOf(from, anchorAt);
  if (anchorAt < 0 || fromAt < 0) fail(`mutation anchor ${JSON.stringify(from)} was not found after ${JSON.stringify(anchor)}`);
  return `${source.slice(0, fromAt)}${to}${source.slice(fromAt + from.length)}`;
}

function parseReceipt() {
  let receipt;
  try {
    receipt = JSON.parse(read(receiptPath));
  } catch (error) {
    fail(`W102 receipt is unreadable: ${String(error)}`);
  }
  if (!Array.isArray(receipt.healthSnapshots)) fail("W102 receipt omitted healthSnapshots");
  if (receipt.healthSnapshots.length !== 91) fail(`expected 91 HTTP health samples, found ${receipt.healthSnapshots.length}`);
  if (!Array.isArray(receipt.reservations) || receipt.reservations.length !== 10) {
    fail("W102 receipt did not contain exactly ten reservation records");
  }
  return receipt;
}

function coverageGroups(receipt) {
  const grouped = new Map();
  for (const snapshot of receipt.healthSnapshots) {
    const observedAt = snapshot?.coverage?.observedAt;
    if (typeof observedAt !== "number") fail("a health sample omitted coverage.observedAt");
    const key = String(observedAt);
    const samples = grouped.get(key) ?? [];
    samples.push(snapshot);
    grouped.set(key, samples);
  }
  return [...grouped.entries()].map(([observedAt, samples]) => {
    const first = samples[0];
    const last = samples.at(-1);
    const materializedViews = first.materializedViews.map((view) => {
      const final = last.materializedViews.find((candidate) => candidate.viewId === view.viewId);
      return {
        viewId: view.viewId,
        firstSafeHead: view.safeHead,
        lastSafeHead: final?.safeHead ?? "",
        firstUnsafeRows: view.unsafeRows,
        lastUnsafeRows: final?.unsafeRows ?? null,
        firstUnsafeReceipts: view.unsafeReceipts,
        lastUnsafeReceipts: final?.unsafeReceipts ?? null,
      };
    });
    const liveProjections = first.liveProjections.map((projection) => {
      const final = last.liveProjections.find((candidate) => candidate.projectorId === projection.projectorId);
      return {
        projectorId: projection.projectorId,
        firstHead: projection.head,
        lastHead: final?.head ?? "",
        firstLastPollAt: projection.lastPollAt,
        lastPollAt: final?.lastPollAt ?? null,
      };
    });
    return {
      observedAt: Number(observedAt),
      observedAtIso: new Date(Number(observedAt)).toISOString(),
      httpSamples: samples.length,
      coverage: {
        kind: first.coverage.kind,
        reason: first.coverage.reason ?? null,
      },
      materializedViews,
      liveProjections,
      firstGlobalHead: first.globalHead,
      lastGlobalHead: last.globalHead,
    };
  });
}

function validateReceiptFacts(receipt, groups) {
  if (groups.length !== 4) fail(`expected four scheduled coverage observedAt values, found ${groups.length}`);
  const block = groups.find((group) => group.coverage.kind === "BLOCK/UNSETTLED");
  if (block === undefined) fail("W102 receipt omitted the BLOCK/UNSETTLED tick");
  if (block.httpSamples !== 72 || block.coverage.reason !== "source_partition_set_changed_during_scan") {
    fail(`unexpected BLOCK group shape: ${JSON.stringify({ samples: block.httpSamples, reason: block.coverage.reason })}`);
  }
  const final = groups.at(-1);
  const finalRoom = final.materializedViews.find((view) => view.viewId === "RoomProjector");
  const finalReservation = final.materializedViews.find((view) => view.viewId === "ReservationProjector");
  if (finalRoom?.lastSafeHead !== receipt.reservations.at(-1).suid) fail("RoomProjector did not end at W102 row 10");
  if (finalReservation?.lastSafeHead !== receipt.reservations[2].suid) fail("ReservationProjector did not end at W102 row 3");
  if (finalReservation.lastUnsafeRows !== 6) fail("W102 final ReservationProjector unsafe row count was not six");
  if (finalRoom.lastUnsafeRows !== 0) fail("W102 final RoomProjector unsafe row count was not zero");
  if (final.liveProjections.some((projection) => projection.lastPollAt !== 1788426228497)) {
    fail("W102 final live-projection lastPollAt changed unexpectedly");
  }
  if (receipt.lastHealth?.globalHead !== receipt.reservations.at(-1).suid) fail("W102 global head did not reach row 10");
  if (receipt.lastHealth?.liveProjections?.some((projection) => projection.head === receipt.reservations.at(-1).suid)) {
    fail("W102 live head unexpectedly reached the cohort");
  }
}

function assertSourceContracts(sources) {
  const { runtime, worker, mv, delivery, catchUp, live } = sources;
  const earlyReturn = "if (scan.kind !== \"FULL\") return;";
  requireUnique(runtime, earlyReturn, "scheduled BLOCK gate");
  requireContains(runtime, "await options.beforeLiveProjectionPoll?.({ env, serviceId, scan, ctx });", "fresh scheduled hook");
  requireContains(runtime, "await pollLiveProjections(env, { registry: composition.projectors", "scheduled live poll");
  requireContains(worker, "await input.catchUp(coverage.frontierSuid);", "retained-frontier catch-up");
  requireContains(worker, "await input.drainUnsafeKicks(coverage.frontierSuid);", "retained-frontier unsafe drain");
  requireContains(worker, "await input.runGenericScheduledWork();", "same-tick generic seam");

  const catchUpStart = mv.indexOf("export async function catchUpMeetingRoomMaterializedViews");
  const catchUpLoop = mv.indexOf("for (const materializer of fanoutMaterializers", catchUpStart);
  const catchUpFollow = mv.indexOf("await runtime.follow(serviceId, materializer", catchUpLoop);
  const drainStart = mv.indexOf("export async function drainMeetingRoomUnsafeKicks");
  if (catchUpStart < 0 || catchUpLoop < catchUpStart || (drainStart >= 0 && catchUpLoop > drainStart) || catchUpFollow < catchUpLoop) fail("MV catch-up is not serial per materializer");
  const drainLoop = mv.indexOf("for (const materializer of fanoutMaterializers", drainStart);
  const drainFollow = mv.indexOf("await runtime.follow(serviceId, materializer", drainLoop);
  if (drainStart < 0 || drainLoop < drainStart || drainFollow < drainLoop) fail("unsafe kick drain is not serial per materializer");
  requireContains(delivery, "const viewOutcomes = await Promise.all(views.map(async (view) => {", "independent delivery view branches");
  requireContains(catchUp, "if (event.lastArrivedAt > nowMs - windowMs)", "first-unsafe safe-window barrier");
  requireContains(catchUp, "return {\n            instance: current,", "first-unsafe bounded return");

  requireContains(live, "for (const tag of tags)", "all-tag polling loop");
  requireContains(live, "for (const projector of this.registry.registered())", "all-projector polling loop");
  requireContains(live, "results.push(await this.catchUp(serviceId, identity, nowMs));", "sequential projector catch-up");
  requireContains(mv, "checkpoint.head < minimum", "minimum head aggregation");
  requireContains(mv, "Math.min(...states.map((state) => state.updatedAt))", "minimum lastPollAt aggregation");
}

function runtimeSkipsLivePollOnBlock(runtimeSource) {
  return runtimeSource.includes("if (scan.kind !== \"FULL\") return;");
}

function simulateRuntime(runtimeSource, scanKind) {
  const order = ["stabilize-downstream", "reconcile", "before-live-projection-hook"];
  if (scanKind !== "FULL" && runtimeSkipsLivePollOnBlock(runtimeSource)) {
    return { order, livePollCalled: false, safeLane: "retained-frontier-only" };
  }
  order.push("pollLiveProjections");
  return { order, livePollCalled: true, safeLane: "fresh-frontier" };
}

function projectionPollOrder(tags, projectors) {
  const order = [];
  for (const tag of tags) {
    for (const projector of projectors) order.push(`${tag}:${projector}`);
  }
  return order;
}

function aggregateLive(states, projectorId) {
  const matching = states.filter((state) => state.projectorId === projectorId);
  return {
    head: minimumSuid(matching.map((state) => state.head)),
    lastPollAt: minimumNumber(matching.map((state) => state.lastPollAt)),
  };
}

function selfTest() {
  const sources = {
    runtime: read(runtimePath),
    worker: read(workerPath),
    mv: read(mvPath),
    delivery: read(deliveryPath),
    catchUp: read(catchUpPath),
    live: read(livePath),
  };
  assertSourceContracts(sources);
  const current = simulateRuntime(sources.runtime, "BLOCK/UNSETTLED");
  if (current.livePollCalled || !runtimeSkipsLivePollOnBlock(sources.runtime)) {
    fail("the current runtime no longer exposes the W103 BLOCK live-poll red baseline");
  }
  const repairedSource = sources.runtime.replace(
    "if (scan.kind !== \"FULL\") return;",
    "if (false) return;",
  );
  const repaired = simulateRuntime(repairedSource, "BLOCK/UNSETTLED");
  if (repaired.livePollCalled !== true) fail("removing the BLOCK early return did not turn the live-poll witness green");
  const states = [
    { projectorId: "RoomProjector", head: "063924022962293000001512609674", lastPollAt: 100 },
    { projectorId: "RoomProjector", head: "063924025191103000001618685662", lastPollAt: 200 },
    { projectorId: "ReservationProjector", head: "063924022962293000001512609674", lastPollAt: 100 },
    { projectorId: "ReservationProjector", head: "063924025106891000001134410415", lastPollAt: 200 },
  ];
  const room = aggregateLive(states, "RoomProjector");
  if (room.head !== states[0].head || room.lastPollAt !== 100) fail("minimum-across-tags aggregation model did not retain the stale state");
  const order = projectionPollOrder(["old-tag", "cohort-tag"], ["RoomProjector", "ReservationProjector"]);
  if (order.join(",") !== "old-tag:RoomProjector,old-tag:ReservationProjector,cohort-tag:RoomProjector,cohort-tag:ReservationProjector") {
    fail("serial all-tag/projector polling model changed unexpectedly");
  }
  const minMutant = states.map((state) => state.projectorId === "RoomProjector" ? { ...state, head: "063924025191103000001618685662", lastPollAt: 200 } : state);
  if (aggregateLive(minMutant, "RoomProjector").head === room.head) fail("minimum head mutation did not turn the stale-head witness green");
  const serialMutant = replaceAfter(
    sources.mv,
    "export async function catchUpMeetingRoomMaterializedViews",
    "for (const materializer of fanoutMaterializers(configuredViewCount(env.G26_VIEW_COUNT))) {",
    "for (const materializer of [] as never[]) {",
  );
  let serialRed = false;
  try { assertSourceContracts({ ...sources, mv: serialMutant }); } catch { serialRed = true; }
  if (!serialRed) fail("removing serial MV iteration did not turn the guard red");
  const minSourceMutant = sources.mv.replace("checkpoint.head < minimum", "checkpoint.head > minimum");
  let minRed = false;
  try { assertSourceContracts({ ...sources, mv: minSourceMutant }); } catch { minRed = true; }
  if (!minRed) fail("reversing minimum head aggregation did not turn the guard red");
  const unsafeBarrierMutant = sources.catchUp.replace("if (event.lastArrivedAt > nowMs - windowMs)", "if (false)");
  let barrierRed = false;
  try { assertSourceContracts({ ...sources, catchUp: unsafeBarrierMutant }); } catch { barrierRed = true; }
  if (!barrierRed) fail("removing the first-unsafe safe-window barrier did not turn the guard red");
  process.stdout.write(`${JSON.stringify({ selfTest: "g58-w103-starvation-red-capable", baseline: current, serialPollOrder: order })}\n`);
}

function main() {
  const receipt = parseReceipt();
  const groups = coverageGroups(receipt);
  validateReceiptFacts(receipt, groups);
  const sources = {
    runtime: read(runtimePath),
    worker: read(workerPath),
    mv: read(mvPath),
    delivery: read(deliveryPath),
    catchUp: read(catchUpPath),
    live: read(livePath),
  };
  assertSourceContracts(sources);
  const blockGroup = groups.find((group) => group.coverage.kind === "BLOCK/UNSETTLED");
  const finalGroup = groups.at(-1);
  const finalRoom = finalGroup.materializedViews.find((view) => view.viewId === "RoomProjector");
  const finalReservation = finalGroup.materializedViews.find((view) => view.viewId === "ReservationProjector");
  const serialViews = {
    sourceOrder: ["RoomProjector", "ReservationProjector"],
    observedFinalProgress: {
      RoomProjector: { safeHead: finalRoom.lastSafeHead, unsafeRows: finalRoom.lastUnsafeRows },
      ReservationProjector: { safeHead: finalReservation.lastSafeHead, unsafeRows: finalReservation.lastUnsafeRows },
    },
    receiptInterpretation: "catch-up and unsafe-kick draining iterate RoomProjector before ReservationProjector; independent Queue view branches run concurrently, and the Reservation branch retained six unsafe rows while Room reached row 10. The receipt proves per-view starvation, but read-only health has no CAS/lease exception field, so it does not claim a lower-level winner that was not observed.",
  };
  const aggregateStates = [
    { projectorId: "RoomProjector", head: "063924022962293000001512609674", lastPollAt: 1788426228497 },
    { projectorId: "RoomProjector", head: finalRoom.lastSafeHead, lastPollAt: finalGroup.observedAt },
    { projectorId: "ReservationProjector", head: "063924022962293000001512609674", lastPollAt: 1788426228497 },
    { projectorId: "ReservationProjector", head: finalReservation.lastSafeHead, lastPollAt: finalGroup.observedAt },
  ];
  const aggregation = {
    sourceOrder: projectionPollOrder(["old-tag", "cohort-tag"], ["RoomProjector", "ReservationProjector"]),
    model: {
      RoomProjector: aggregateLive(aggregateStates, "RoomProjector"),
      ReservationProjector: aggregateLive(aggregateStates, "ReservationProjector"),
    },
    receiptObservation: finalGroup.liveProjections,
    interpretation: "pollRegistered is serial over every tag and registered projector; readMeetingRoomHealth then reports the minimum head and minimum lastPollAt per projector, so one stale tag state keeps the aggregate behind even if another state advances.",
  };
  const runtimeDiagnosis = {
    source: runtimePath,
    baseline: "red-baseline",
    scanDecision: "BLOCK/UNSETTLED",
    earlyReturn: "if (scan.kind !== \"FULL\") return;",
    livePollCalled: simulateRuntime(sources.runtime, "BLOCK/UNSETTLED").livePollCalled,
    retainedFrontierWork: "beforeLiveProjectionPoll runs the fenced safe catch-up/drain hook, then scheduled() returns before pollLiveProjections.",
    focusedGreenRepairSeam: "invoke pollLiveProjections on a BLOCK tick after the retained-frontier safe pass, while keeping the retained frontier and G44 fence intact.",
  };
  const report = {
    schema: "sdt-g58-w103-safe-live-starvation/v1",
    status: "red-baseline",
    task: "SDT-G58-SAFE-LIVE-STARVATION-DIAGNOSIS-W103",
    sourceReceipt: receiptPath,
    httpHealthSamples: receipt.healthSnapshots.length,
    scheduledCoverageTicks: groups.length,
    coverageGroups: groups,
    blockTick: blockGroup,
    runtimeDiagnosis,
    serialViews,
    aggregation,
    redCapableGuards: {
      runtimeBlockLivePoll: "self-test mutation removes the scan.kind !== FULL return and requires the BLOCK model to call pollLiveProjections",
      serialViewCatchUp: "source mutation removing the serial materializer loop is rejected",
      minimumAcrossTags: "source mutation reversing minimum head aggregation is rejected",
    },
    unsafeObservation: {
      singleLateSampleMs: 5289,
      contractMs: 5000,
      classification: "W99/W102 harness evidence is an unsafe miss/late observation; this W103 receipt has no new cohort and cannot establish a new unsafe-lane cause.",
    },
    bounds: {
      safeWindowFloorMs: 20000,
      safeWindowCeilingMs: 120000,
      unsafeBoundMs: 5000,
      g44Unmodified: true,
      upstreamOutboxQueueGlobalAdmission: "held SDT-G60; not inspected or modified by this guard",
    },
  };
  mkdirSync(resolve(root, ".artifacts"), { recursive: true });
  writeFileSync(resolve(root, reportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ guard: "g58-w103-safe-live-starvation", status: report.status, report: reportPath, scheduledCoverageTicks: groups.length, httpHealthSamples: receipt.healthSnapshots.length })}\n`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
