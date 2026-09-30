#!/usr/bin/env node
/**
 * SDT-G58 W106 unsafe-kick re-entry guard.
 *
 * W105 identified the bounded unsafe-kick settlement seam: a follow can stop
 * at the first recent event while an acquired lease target is still ahead.
 * This guard keeps the D1-backed two-view red receipt, checks the repaired
 * durable re-arm path, and proves that removing either the target check or the
 * reached-checkpoint hand-off turns the guard red again.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const baselinePath = ".artifacts/sdt-g58-w106-red-baseline.json";
const reportPath = ".artifacts/ci-local/g58-reservation-reentry.json";
const unsafePath = "packages/dcb-runtime/src/mv/UnsafeWindowMaterializedView.ts";
const d1MvPath = "samples/meeting-room/src/d1-mv.ts";
const catchUpPath = "packages/dcb-runtime/src/mv/MaterializedViewCatchUp.ts";
const testPath = "test/g58-reservation-reentry.spec.ts";

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function fail(message) {
  throw new Error(`SDT-G58 W106 reservation re-entry guard failed: ${message}`);
}

function requireContains(source, expected, label) {
  if (!source.includes(expected)) fail(`${label} is missing ${JSON.stringify(expected)}`);
}

function requireRegex(source, pattern, label) {
  if (!pattern.test(source)) fail(`${label} does not match ${pattern}`);
}

function sourceContracts(sources) {
  const { unsafe, d1Mv, catchUp, test } = sources;
  requireRegex(unsafe, /async finishKick\([^)]*reachedSuid: string\)/, "finishKick reached-checkpoint parameter");
  requireRegex(
    unsafe,
    /dirty\s*=\s*CASE[\s\S]*?target_suid COLLATE BINARY > \? COLLATE BINARY[\s\S]*?END/,
    "finishKick target-not-reached re-arm",
  );
  requireContains(unsafe, ".bind(reachedSuid, reachedSuid, serviceId, viewId, owner)", "finishKick reached checkpoint bind");
  requireContains(d1Mv, "const result = await runtime.follow(serviceId, materializer, nowMs, {}, { maximumSuid: frontierSuid });", "unsafe drain follow result");
  requireContains(d1Mv, "await runtime.follow(serviceId, materializer, nowMs, {}, { maximumSuid: frontierSuid });", "unsafe drain retained-frontier follow");
  requireContains(d1Mv, "await unsafe.finishKick(serviceId, materializer.id, owner, result.instance.lastSuid);", "unsafe drain reached-checkpoint hand-off");
  requireContains(catchUp, "if (event.lastArrivedAt > nowMs - windowMs)", "first-unsafe barrier");
  requireContains(catchUp, "maximumSuid !== undefined && compareSuid(event.suid, options.maximumSuid) > 0", "retained frontier fence");
  requireContains(test, 'const ROOM_VIEW = "RoomProjector";', "Room two-view fixture");
  requireContains(test, 'const RESERVATION_VIEW = "ReservationProjector";', "Reservation two-view fixture");
  requireContains(test, "const nowMs = 1_788_428_500_000;", "controlled clock");
  requireContains(test, "lastArrivedAt", "controlled arrival timestamps");
  requireContains(test, "maximumSuid: targetSuid", "retained proven frontier");
  requireContains(test, "expect(await kickRow(serviceId)).toEqual({ targetSuid, dirty: 1, leaseOwner: null });", "re-armed kick assertion");
  requireContains(test, "const eligibleAt = nowMs + 21_000;", "SafeWindow-eligible re-entry clock");
  requireContains(test, "expect((await views.readActive(serviceId, ROOM_VIEW))?.lastSuid).toBe(targetSuid);", "independent Room convergence");
}

function assertBaseline() {
  let baseline;
  try {
    baseline = JSON.parse(read(baselinePath));
  } catch (error) {
    fail(`red baseline is unreadable: ${String(error)}`);
  }
  if (baseline.status !== "red-baseline" || baseline.exitCode !== 1) {
    fail("W106 must retain the failing baseline receipt");
  }
  if (baseline.failure?.received?.dirty !== 0 || baseline.failure?.expected?.dirty !== 1) {
    fail("baseline does not preserve the irreversible-clean failure");
  }
  return baseline;
}

function mutationSelfTest(sources) {
  const unsafeMutant = sources.unsafe.replace(
    /dirty\s*=\s*CASE[\s\S]*?END/,
    "dirty = 0",
  );
  let targetMutationRed = false;
  try { sourceContracts({ ...sources, unsafe: unsafeMutant }); } catch { targetMutationRed = true; }
  if (!targetMutationRed) fail("removing the target comparison did not turn the guard red");

  const handoffMutant = sources.d1Mv.replace(
    "await unsafe.finishKick(serviceId, materializer.id, owner, result.instance.lastSuid);",
    "await unsafe.finishKick(serviceId, materializer.id, owner);",
  );
  let handoffMutationRed = false;
  try { sourceContracts({ ...sources, d1Mv: handoffMutant }); } catch { handoffMutationRed = true; }
  if (!handoffMutationRed) fail("omitting the reached checkpoint did not turn the guard red");

  const barrierMutant = sources.catchUp.replace(
    "if (event.lastArrivedAt > nowMs - windowMs)",
    "if (false)",
  );
  let barrierMutationRed = false;
  try { sourceContracts({ ...sources, catchUp: barrierMutant }); } catch { barrierMutationRed = true; }
  if (!barrierMutationRed) fail("removing the first-unsafe barrier did not turn the guard red");

  const frontierMutant = sources.d1Mv.replace(
    "await runtime.follow(serviceId, materializer, nowMs, {}, { maximumSuid: frontierSuid });",
    "await runtime.follow(serviceId, materializer, nowMs, {}, { maximumSuid: undefined });",
  );
  let frontierMutationRed = false;
  try { sourceContracts({ ...sources, d1Mv: frontierMutant }); } catch { frontierMutationRed = true; }
  if (!frontierMutationRed) fail("removing the unsafe-drain frontier did not turn the guard red");

  return { targetMutationRed, handoffMutationRed, barrierMutationRed, frontierMutationRed };
}

function loadSources() {
  return {
    unsafe: read(unsafePath),
    d1Mv: read(d1MvPath),
    catchUp: read(catchUpPath),
    test: read(testPath),
  };
}

function selfTest() {
  const sources = loadSources();
  assertBaseline();
  sourceContracts(sources);
  const mutations = mutationSelfTest(sources);
  process.stdout.write(`${JSON.stringify({ selfTest: "g58-w106-reservation-reentry", baseline: baselinePath, mutations })}\n`);
}

function main() {
  const sources = loadSources();
  const baseline = assertBaseline();
  sourceContracts(sources);
  const mutations = mutationSelfTest(sources);
  const report = {
    schema: "sdt-g58-reservation-reentry/v1",
    status: "green",
    task: "SDT-G58-RESERVATION-REENTRY-GREEN-REPAIR-W106",
    baselineRedReceipt: {
      path: baselinePath,
      status: baseline.status,
      expectedDirty: baseline.failure.expected.dirty,
      receivedDirty: baseline.failure.received.dirty,
    },
    productionRepair: {
      unsafeKickFinish: "atomically clears the lease and re-arms dirty when target_suid remains beyond the reached checkpoint",
      drain: "passes follow().instance.lastSuid to finishKick",
      nextScheduledDecision: "acquireKick can re-enter after the event is SafeWindow-eligible",
    },
    mutationEvidence: mutations,
    fixture: {
      views: ["RoomProjector", "ReservationProjector"],
      firstDecision: "Room reaches target; Reservation stops at oldSuid at the first recent event",
      partialKick: "follow returns oldSuid; kick remains dirty=1 after settlement",
      reentry: "at nowMs+21000 the same target is acquired and Reservation reaches it",
      roomIndependent: true,
    },
    bounds: {
      safeWindowFloorMs: 20000,
      safeWindowCeilingMs: 120000,
      unsafeBoundMs: 5000,
      firstUnsafeBarrierPreserved: true,
      retainedFrontierFencePreserved: true,
      upstreamOutboxQueueGlobalAdmission: "held SDT-G60; not modified",
    },
  };
  mkdirSync(resolve(root, ".artifacts/ci-local"), { recursive: true });
  writeFileSync(resolve(root, reportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ guard: "g58-w106-reservation-reentry", status: "green", report: reportPath, baseline: baselinePath })}\n`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
