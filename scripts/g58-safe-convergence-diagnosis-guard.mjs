#!/usr/bin/env node
/**
 * SDT-G58 W119 safe-convergence attribution guard.
 *
 * W118 recorded the scheduled coverage kind/reason and both MV safe heads,
 * but its public health receipt did not record the proven frontier SUID.  The
 * guard therefore stays red on the current evidence instead of equating a
 * materialized safe head with the completeness frontier.  Its local model
 * proves that the missing field is decisive: equal frontier/head is Outcome A
 * while an advanced frontier with a stale head is Outcome B.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const ac2Path = ".artifacts/sdt-g58-w118-ac2-paced-cohort.json";
const ac6Path = ".artifacts/sdt-g58-w118-ac6-e2e.json";
const reportPath = ".artifacts/sdt-g58-w119-safe-convergence-diagnosis-guard.json";
const workerPath = "samples/meeting-room/src/worker.cloudflare-only.ts";
const completenessPath = "packages/dcb-runtime/src/completeness/GlobalCompletenessReconciler.ts";
const healthPath = "samples/meeting-room/src/d1-mv.ts";
const migrationPath = "migrations/d1/g32/0003_g58_safe_lane_health.sql";

const OLD_SAFE_HEAD = "063924050289760000000088044272";

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function fail(message) {
  throw new Error(`SDT-G58 W119 safe-convergence diagnosis guard failed: ${message}`);
}

function requireContains(source, expected, label) {
  if (!source.includes(expected)) fail(`${label} is missing ${JSON.stringify(expected)}`);
}

function iso(value) {
  return Number.isSafeInteger(value) ? new Date(value).toISOString() : null;
}

function viewMap(snapshot) {
  return new Map((snapshot?.materializedViews ?? []).map((view) => [view.viewId, view]));
}

function frontierFrom(snapshot) {
  const coverage = snapshot?.coverage;
  if (typeof coverage?.frontierSuid === "string" && coverage.frontierSuid.length > 0) return coverage.frontierSuid;
  if (typeof coverage?.settledFrontierSuid === "string" && coverage.settledFrontierSuid.length > 0) return coverage.settledFrontierSuid;
  if (typeof coverage?.settled_frontier_suid === "string" && coverage.settled_frontier_suid.length > 0) return coverage.settled_frontier_suid;
  return null;
}

function coverageGroups(receipt) {
  const byObservedAt = new Map();
  for (const snapshot of receipt.healthSnapshots ?? []) {
    const observedAt = snapshot?.coverage?.observedAt;
    if (!Number.isSafeInteger(observedAt)) fail("health snapshot omitted integer coverage.observedAt");
    const values = byObservedAt.get(observedAt) ?? [];
    values.push(snapshot);
    byObservedAt.set(observedAt, values);
  }
  return [...byObservedAt.entries()].map(([observedAt, snapshots]) => {
    const last = snapshots.at(-1);
    const views = viewMap(last);
    return {
      observedAt,
      observedAtIso: iso(observedAt),
      samples: snapshots.length,
      kind: snapshots[0]?.coverage?.kind ?? null,
      reason: snapshots[0]?.coverage?.reason ?? null,
      partitionTag: snapshots[0]?.coverage?.partitionTag ?? null,
      frontierSuid: frontierFrom(last),
      roomSafeHead: views.get("RoomProjector")?.safeHead ?? null,
      reservationSafeHead: views.get("ReservationProjector")?.safeHead ?? null,
      firstReceivedAtMs: snapshots[0]?.receivedAtMs ?? null,
      lastReceivedAtMs: last?.receivedAtMs ?? null,
    };
  });
}

function classifyFrontierRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) fail("frontier comparison requires at least one row");
  if (rows.some((row) => typeof row.frontierSuid !== "string" || row.frontierSuid.length === 0)) {
    throw new Error("frontier_not_persisted_for_tick");
  }
  const classifications = rows.map((row) => {
    if (row.frontierSuid === row.safeHead) return "A_FRONTIER_STAYED_PUT";
    if (row.frontierSuid > row.safeHead) return "B_FRONTIER_ADVANCED_SAFE_HEAD_BEHIND";
    return "FENCE_CONTRADICTION_SAFE_HEAD_AHEAD";
  });
  if (classifications.includes("FENCE_CONTRADICTION_SAFE_HEAD_AHEAD")) fail("safe head crossed a proven frontier in the local model");
  return classifications;
}

function sourceContracts() {
  const worker = read(workerPath);
  const completeness = read(completenessPath);
  const health = read(healthPath);
  const migration = read(migrationPath);
  requireContains(worker, "await input.catchUp(coverage.frontierSuid);", "BLOCK retained-frontier catch-up");
  requireContains(worker, "await input.drainUnsafeKicks(coverage.frontierSuid);", "BLOCK retained-frontier unsafe drain");
  requireContains(completeness, "cursor_json = COALESCE(excluded.cursor_json, serialized_dcb_completeness_scanner_health.cursor_json)", "retained scanner cursor");
  requireContains(completeness, "frontierSuid: await this.settledFrontierAtSnapshot(serviceId, snapshots)", "FULL frontier calculation");
  requireContains(migration, "service_id TEXT PRIMARY KEY", "safe-lane single-row schema");
  requireContains(migration, "settled_frontier_suid TEXT NOT NULL", "persisted frontier column");
  const publicHealthQuery = "SELECT coverage_kind, coverage_reason, coverage_partition_tag, observed_at";
  requireContains(health, publicHealthQuery, "W118 public-health coverage query");
  return {
    retainedFrontierCatchUp: true,
    retainedFrontierCursor: true,
    frontierColumnExists: true,
    historicalRows: false,
    receiptFrontierFieldOmittedByW118Surface: true,
    publicHealthQuery,
  };
}

function mutationSelfTest() {
  const old = OLD_SAFE_HEAD;
  const next = "063924053251522000001725631009";
  const equalFrontier = [
    { frontierSuid: old, safeHead: old },
    { frontierSuid: old, safeHead: old },
    { frontierSuid: old, safeHead: old },
  ];
  const advancingFrontier = [{ frontierSuid: next, safeHead: old }];
  if (!classifyFrontierRows(equalFrontier).every((value) => value === "A_FRONTIER_STAYED_PUT")) {
    fail("equal frontier/head fixture did not classify as Outcome A");
  }
  if (classifyFrontierRows(advancingFrontier)[0] !== "B_FRONTIER_ADVANCED_SAFE_HEAD_BEHIND") {
    fail("advanced frontier/stale head fixture did not classify as Outcome B");
  }
  let missingFieldRed = false;
  try {
    classifyFrontierRows([{ frontierSuid: null, safeHead: old }]);
  } catch (error) {
    missingFieldRed = String(error).includes("frontier_not_persisted_for_tick");
  }
  if (!missingFieldRed) fail("missing per-tick frontier did not turn the guard red");
  return {
    equalFrontierOutcomeA: true,
    advancedFrontierOutcomeB: true,
    missingFrontierRed: true,
  };
}

function loadReceipts() {
  const ac2 = JSON.parse(read(ac2Path));
  const ac6 = JSON.parse(read(ac6Path));
  if (ac2.status !== "failed") fail(`W118 AC2 receipt status changed: ${String(ac2.status)}`);
  if (ac2.mode !== "paced" || ac2.reservations?.length !== 10) fail("W118 AC2 is not the preserved ten-commit paced receipt");
  if (ac2.failure !== "safe lane did not reach 063924053251522000001725631009 within the 180000ms paced safe acceptance line") {
    fail("W118 AC2 failure text changed");
  }
  if (ac6.status !== "completed") fail(`W118 AC6 receipt status changed: ${String(ac6.status)}`);
  return { ac2, ac6 };
}

function buildDiagnosis() {
  const { ac2, ac6 } = loadReceipts();
  const groups = coverageGroups(ac2);
  const blockGroups = groups.filter((group) => group.kind === "BLOCK/UNSETTLED");
  if (blockGroups.length !== 3) fail(`preserved W118 receipt has ${blockGroups.length} BLOCK groups, expected its recorded three`);
  if (blockGroups.some((group) => group.reason !== "source_partition_set_changed_during_scan")) {
    fail("a W118 BLOCK group changed reason");
  }
  if (blockGroups.some((group) => group.roomSafeHead !== OLD_SAFE_HEAD || group.reservationSafeHead !== OLD_SAFE_HEAD)) {
    fail("a W118 BLOCK group changed its persisted MV safe head");
  }
  const missingFrontierGroups = blockGroups.filter((group) => group.frontierSuid === null);
  const lastAc2 = ac2.lastHealth;
  const lastAc2Views = viewMap(lastAc2);
  const ac6BeforeViews = viewMap(ac6.healthBefore);
  const ac6FinalViews = viewMap(ac6.healthAfter ?? ac6.lastHealth ?? ac6.finalHealth);
  const rawFacts = {
    ac2RunId: ac2.runId,
    ac2StartedAt: ac2.startedAt,
    ac2FinishedAt: ac2.finishedAt,
    ac2FirstCommitAt: ac2.reservations[0]?.commit?.receivedAtMs ?? null,
    ac2FirstCommitDeadlineAt: Number.isSafeInteger(ac2.reservations[0]?.commit?.receivedAtMs)
      ? ac2.reservations[0].commit.receivedAtMs + 180000
      : null,
    ac2FirstCommitSuid: ac2.reservations[0]?.suid ?? null,
    ac2FinalCommitSuid: ac2.reservations.at(-1)?.suid ?? null,
    ac2FinalGlobalHead: lastAc2?.globalHead ?? null,
    ac2FinalRoomSafeHead: lastAc2Views.get("RoomProjector")?.safeHead ?? null,
    ac2FinalReservationSafeHead: lastAc2Views.get("ReservationProjector")?.safeHead ?? null,
    ac6RunId: ac6.runId,
    ac6StartedAt: ac6.startedAt,
    ac6FinishedAt: ac6.finishedAt,
    ac6SafeMs: ac6.reservations?.[0]?.safe?.commitToSafeMs ?? null,
    ac6BeforeReceivedAtMs: ac6.healthBefore?.receivedAtMs ?? null,
    ac6BeforeRoomSafeHead: ac6BeforeViews.get("RoomProjector")?.safeHead ?? null,
    ac6BeforeReservationSafeHead: ac6BeforeViews.get("ReservationProjector")?.safeHead ?? null,
    ac6BeforeCoverageObservedAt: ac6.healthBefore?.coverage?.observedAt ?? null,
    ac6FinalRoomSafeHead: ac6.reservations?.[0]?.safe?.safeHead ?? ac6FinalViews.get("RoomProjector")?.safeHead ?? null,
    ac6FinalReservationSafeHead: ac6.reservations?.[0]?.safe?.safeHead ?? ac6FinalViews.get("ReservationProjector")?.safeHead ?? null,
  };
  return {
    ac2,
    ac6,
    groups,
    blockGroups,
    missingFrontierGroups,
    rawFacts,
  };
}

function runSelfTest() {
  const sources = sourceContracts();
  const mutations = mutationSelfTest();
  process.stdout.write(`${JSON.stringify({ selfTest: "g58-w119-frontier-attribution-red-capable", sources, mutations })}\n`);
}

function main() {
  const sources = sourceContracts();
  const mutations = mutationSelfTest();
  const diagnosis = buildDiagnosis();
  const report = {
    schema: "sdt-g58-w119-safe-convergence-diagnosis/v1",
    task: "SDT-G58-SAFE-CONVERGENCE-DIAGNOSIS-W119",
    status: "red-baseline",
    currentPathFails: true,
    failure: "per-tick proven completeness frontier is absent from the preserved W118 receipt; Outcome A/B cannot be classified without equating safeHead to frontier",
    sourceReceipts: [ac2Path, ac6Path],
    scheduledCoverageGroups: diagnosis.groups,
    blockTicks: diagnosis.blockGroups,
    frontierAttribution: {
      observedFrontierSuidPerBlockTick: diagnosis.blockGroups.map((group) => ({ observedAt: group.observedAt, frontierSuid: group.frontierSuid })),
      missingFrontierGroups: diagnosis.missingFrontierGroups.length,
      outcomeA: "not proven: requires each BLOCK tick frontierSuid to remain equal to its prior PROVEN value",
      outcomeB: "not proven: requires a persisted BLOCK tick frontierSuid greater than its MV safeHead",
    },
    rawFacts: diagnosis.rawFacts,
    sourceContracts: sources,
    redCapableGuard: {
      mutations,
      invariant: "never substitute a materialized-view safeHead for the G44 proven completeness frontier; safe head may not cross an unproven gap",
    },
    bounds: {
      safeAcceptanceMs: 180000,
      safeWindowFloorMs: 20000,
      safeWindowCeilingMs: 120000,
      unsafeBoundMs: 5000,
      g44FencePreserved: true,
      outboxQueueGlobalAdmissionTouched: false,
    },
  };
  mkdirSync(resolve(root, ".artifacts"), { recursive: true });
  writeFileSync(resolve(root, reportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ guard: "g58-w119-frontier-attribution", status: report.status, report: reportPath, blockTicks: diagnosis.blockGroups.length, missingFrontierGroups: diagnosis.missingFrontierGroups.length })}\n`);
}

if (process.argv.includes("--self-test")) runSelfTest();
else main();
