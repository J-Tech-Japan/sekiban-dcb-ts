#!/usr/bin/env node
/**
 * SDT-G58 W120 append-only coverage-frontier history guard.
 *
 * W119's preserved red receipt proves why a materialized-view safe head may
 * not stand in for the G44 proven frontier.  W120 adds the scheduled-tick
 * history needed to make that distinction reviewable after deployment.  The
 * local model is deliberately red for a missing frontier and for a safe head
 * crossing an unproven frontier; it classifies only persisted history rows.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const w119RedPath = ".artifacts/sdt-g58-w119-safe-convergence-diagnosis-guard.json";
const preFixReportPath = ".artifacts/ci-local/g58-frontier-history-before.json";
const finalReportPath = ".artifacts/ci-local/g58-frontier-history.json";

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function readJson(path) {
  return JSON.parse(read(path));
}

function writeJson(path, value) {
  const output = resolve(root, path);
  mkdirSync(resolve(root, ".artifacts/ci-local"), { recursive: true });
  writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fail(message) {
  throw new Error(`SDT-G58 W120 frontier-history guard failed: ${message}`);
}

function requireContains(source, expected, label) {
  if (!source.includes(expected)) fail(`${label} is missing ${JSON.stringify(expected)}`);
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

function sourceContracts() {
  const health = read("samples/meeting-room/src/d1-mv.ts");
  const migration = read("migrations/d1/g32/0005_g58_safe_lane_history.sql");
  const test = read("test/g58-safe-lane.spec.ts");
  const e2e = read("scripts/deploy/g58-safe-lane-e2e.mjs");
  const completeness = read("packages/dcb-runtime/src/completeness/GlobalCompletenessReconciler.ts");
  const catchUp = read("packages/dcb-runtime/src/mv/MaterializedViewCatchUp.ts");
  requireContains(health, "export function meetingRoomSafeLaneTickId", "stable tick identity");
  requireContains(health, "serialized_dcb_safe_lane_history", "append-only history table");
  requireContains(health, "ON CONFLICT (service_id, tick_id) DO NOTHING", "history insert must not update");
  requireContains(health, "coverageHistory", "health history surface");
  requireContains(health, "settled_frontier_suid", "persisted proven frontier");
  requireContains(migration, "PRIMARY KEY (service_id, tick_id)", "stable history primary key");
  requireContains(migration, "UNIQUE (service_id, observed_at)", "one row per scheduled tick");
  requireContains(migration, "coverage_kind", "persisted coverage kind");
  requireContains(migration, "coverage_reason", "persisted coverage reason");
  requireContains(migration, "coverage_partition_tag", "persisted partition tag");
  requireContains(migration, "observed_at", "persisted observation time");
  requireContains(test, "scheduled coverage history append-only", "append-only history oracle");
  requireContains(test, "safe_lane_history_tick_conflict", "same-tick mutation oracle");
  requireContains(e2e, "persistedCoverageHistory", "raw per-tick receipt checkpoint");
  requireContains(completeness, "assertSnapshotUniverseUnchanged", "G44 snapshot-universe fence");
  requireContains(catchUp, "options.maximumSuid === null", "no-frontier source hold");
  return {
    stableTickIdentity: true,
    appendOnlyHistory: true,
    healthHistorySurface: true,
    persistedFrontier: true,
    g44FencePresent: true,
  };
}

function preservedW119RedEvidence() {
  const receipt = readJson(w119RedPath);
  if (receipt.status !== "red-baseline" || receipt.currentPathFails !== true) {
    fail("preserved W119 receipt is no longer the red pre-fix evidence");
  }
  const missing = receipt.frontierAttribution?.missingFrontierGroups;
  if (!Number.isSafeInteger(missing) || missing < 1) fail("W119 red receipt does not prove a missing frontier");
  return {
    path: w119RedPath,
    status: receipt.status,
    blockTicks: receipt.blockTicks?.length ?? 0,
    missingFrontierGroups: missing,
    currentPathFails: receipt.currentPathFails,
  };
}

function normalizeRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("no persisted coverage history rows");
  const seen = new Set();
  const normalized = rows.map((row) => {
    if (row === null || typeof row !== "object") throw new Error("coverage history row was not an object");
    const tickId = typeof row.tickId === "string" ? row.tickId : "";
    const observedAt = row.observedAt;
    if (tickId.length === 0 || !Number.isSafeInteger(observedAt)) throw new Error("coverage history row omitted tick identity or observedAt");
    if (seen.has(tickId)) throw new Error(`duplicate persisted tick ${tickId}`);
    seen.add(tickId);
    if (tickId !== `scheduled:${String(observedAt)}`) throw new Error(`unstable tick identity ${tickId}`);
    return {
      tickId,
      kind: row.kind,
      reason: Object.hasOwn(row, "reason") ? row.reason : undefined,
      partitionTag: Object.hasOwn(row, "partitionTag") ? row.partitionTag : undefined,
      frontierSuid: typeof row.frontierSuid === "string" && row.frontierSuid.length > 0 ? row.frontierSuid : null,
      observedAt,
      roomSafeHead: typeof row.roomSafeHead === "string" ? row.roomSafeHead : null,
      reservationSafeHead: typeof row.reservationSafeHead === "string" ? row.reservationSafeHead : null,
    };
  });
  normalized.sort((left, right) => left.observedAt - right.observedAt || left.tickId.localeCompare(right.tickId));
  return normalized;
}

function classifyPersistedHistory(rows) {
  const normalized = normalizeRows(rows);
  const missing = normalized.find((row) => row.frontierSuid === null);
  if (missing !== undefined) throw new Error(`frontier_not_persisted_for_tick:${missing.tickId}`);
  const incompleteHeads = normalized.find((row) => row.roomSafeHead === null || row.reservationSafeHead === null);
  if (incompleteHeads !== undefined) throw new Error(`safe_heads_not_recorded_for_tick:${incompleteHeads.tickId}`);
  const crossed = normalized.find((row) =>
    compareSuid(row.roomSafeHead, row.frontierSuid) > 0
      || compareSuid(row.reservationSafeHead, row.frontierSuid) > 0);
  if (crossed !== undefined) throw new Error(`safe_head_crossed_proven_frontier:${crossed.tickId}`);

  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    const frontierOrder = compareSuid(current.frontierSuid, previous.frontierSuid);
    if (frontierOrder < 0) throw new Error(`proven_frontier_regressed:${current.tickId}`);
    if (frontierOrder > 0) {
      const roomBehind = compareSuid(current.roomSafeHead, current.frontierSuid) < 0;
      const reservationBehind = compareSuid(current.reservationSafeHead, current.frontierSuid) < 0;
      if (roomBehind || reservationBehind) {
        return {
          outcome: "B_FRONTIER_ADVANCED_SAFE_HEAD_BEHIND",
          basis: "a persisted proven frontier advanced while at least one persisted MV safe head remained behind it",
          advancedTickId: current.tickId,
          rows: normalized,
        };
      }
    }
  }

  const blockRows = normalized.filter((row) => row.kind === "BLOCK/UNSETTLED");
  if (blockRows.length === 0) throw new Error("no persisted BLOCK/UNSETTLED tick to classify");
  const blockFrontiers = new Set(blockRows.map((row) => row.frontierSuid));
  if (blockFrontiers.size === 1) {
    return {
      outcome: "A_FRONTIER_STAYED_PUT",
      basis: "the persisted proven frontier value stayed unchanged across every BLOCK/UNSETTLED tick",
      blockTickIds: blockRows.map((row) => row.tickId),
      rows: normalized,
    };
  }
  return {
    outcome: "UNCLASSIFIABLE",
    basis: "persisted frontier values changed, but no stale-MV-head transition identified the WAKE-103 Outcome B case",
    blockTickIds: blockRows.map((row) => row.tickId),
    rows: normalized,
  };
}

function redCapableMutationSelfTest() {
  const oldFrontier = "000000000000000000000000000001";
  const newFrontier = "000000000000000000000000000002";
  const equal = [
    { tickId: "scheduled:1", kind: "SETTLED", reason: null, partitionTag: null, frontierSuid: oldFrontier, observedAt: 1, roomSafeHead: oldFrontier, reservationSafeHead: oldFrontier },
    { tickId: "scheduled:2", kind: "BLOCK/UNSETTLED", reason: "source_partition_set_changed_during_scan", partitionTag: "reservation:r1", frontierSuid: oldFrontier, observedAt: 2, roomSafeHead: oldFrontier, reservationSafeHead: oldFrontier },
    { tickId: "scheduled:3", kind: "BLOCK/UNSETTLED", reason: "source_partition_set_changed_during_scan", partitionTag: "reservation:r2", frontierSuid: oldFrontier, observedAt: 3, roomSafeHead: oldFrontier, reservationSafeHead: oldFrontier },
  ];
  if (classifyPersistedHistory(equal).outcome !== "A_FRONTIER_STAYED_PUT") fail("equal frontier fixture did not classify Outcome A");
  const advanced = [...equal, {
    tickId: "scheduled:4",
    kind: "BLOCK/UNSETTLED",
    reason: "source_partition_set_changed_during_scan",
    partitionTag: "reservation:r3",
    frontierSuid: newFrontier,
    observedAt: 4,
    roomSafeHead: oldFrontier,
    reservationSafeHead: oldFrontier,
  }];
  if (classifyPersistedHistory(advanced).outcome !== "B_FRONTIER_ADVANCED_SAFE_HEAD_BEHIND") fail("advanced frontier fixture did not classify Outcome B");
  let missingRed = false;
  try {
    classifyPersistedHistory([{ ...equal[1], frontierSuid: null }]);
  } catch (error) {
    missingRed = String(error).includes("frontier_not_persisted_for_tick");
  }
  if (!missingRed) fail("missing frontier mutation unexpectedly stayed green");
  let fenceRed = false;
  try {
    classifyPersistedHistory([{ ...equal[0], roomSafeHead: newFrontier, reservationSafeHead: newFrontier }]);
  } catch (error) {
    fenceRed = String(error).includes("safe_head_crossed_proven_frontier");
  }
  if (!fenceRed) fail("safe-head crossing fixture did not remain non-green");
  return { outcomeA: true, outcomeB: true, missingFrontierRed: true, fenceMutationRed: true };
}

function preFixReceipt() {
  const preserved = preservedW119RedEvidence();
  return {
    schema: "sdt-g58-w120-frontier-history-red-before-green/v1",
    task: "SDT-G58-FRONTIER-HISTORY-CLASSIFICATION-W120",
    status: "red-before-green",
    preservedW119RedEvidence: preserved,
    redInvariant: "a scheduled tick without a persisted proven frontier is red; no materialized-view head is substituted",
    mutation: "missing frontier",
  };
}

function main() {
  const sources = sourceContracts();
  const preserved = preservedW119RedEvidence();
  const mutations = redCapableMutationSelfTest();
  if (process.argv.includes("--self-test")) {
    process.stdout.write(`${JSON.stringify({ selfTest: "g58-frontier-history-red-capable", sources, preserved, mutations })}\n`);
    return;
  }
  if (process.argv.includes("--pre-fix")) {
    const evidence = preFixReceipt();
    writeJson(preFixReportPath, evidence);
    process.stdout.write(`${JSON.stringify({ guard: "g58-frontier-history", status: evidence.status, report: preFixReportPath })}\n`);
    return;
  }

  const cohortIndex = process.argv.indexOf("--cohort");
  const cohortPath = cohortIndex === -1 ? undefined : process.argv[cohortIndex + 1];
  if (typeof cohortPath !== "string" || cohortPath.startsWith("--")) fail("--cohort is required");
  const cohort = readJson(cohortPath);
  if (cohort.schema !== "sdt-g58-safe-lane-e2e/v1" || cohort.mode !== "paced") fail("final receipt is not the paced G58 cohort schema");
  if (!Array.isArray(cohort.reservations) || cohort.reservations.length < 10) fail("final cohort has fewer than ten reservations");
  const pacing = cohort.reservations.map((reservation) => reservation.pacing?.previousCommitToThisCommitMs);
  if (pacing.some((value) => !Number.isSafeInteger(value) || value < 10_000)) fail("final cohort is not paced at least ten seconds apart");
  const persistedRows = cohort.persistedCoverageHistory;
  let classification = null;
  let classificationError = null;
  try {
    classification = classifyPersistedHistory(persistedRows);
  } catch (error) {
    classificationError = error instanceof Error ? error.message : String(error);
  }
  const report = {
    schema: "sdt-g58-w120-frontier-history-guard/v1",
    task: "SDT-G58-FRONTIER-HISTORY-CLASSIFICATION-W120",
    status: classification === null ? "red-unclassifiable" : classification.outcome === "UNCLASSIFIABLE" ? "unclassifiable" : "pass",
    sourceReceipt: cohortPath,
    preservedW119RedEvidence: preserved,
    redCapableMutations: mutations,
    classification,
    classificationError,
    rawCohortStatus: cohort.status,
    bounds: { pacedMinimumMs: 10_000, safeAcceptanceMs: 180_000, safeWindowFloorMs: 20_000, safeWindowCeilingMs: 120_000, unsafeBoundMs: 5_000 },
    invariants: { g44FencePreserved: true, outboxQueueGlobalAdmissionTouched: false, projectorHeadConvergenceOwnedBy: "SDT-G61" },
  };
  writeJson(finalReportPath, report);
  process.stdout.write(`${JSON.stringify({ guard: "g58-frontier-history", status: report.status, report: finalReportPath, outcome: classification?.outcome ?? null, classificationError })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
