#!/usr/bin/env node
/**
 * SDT-G58 W110 live-poll diagnosis guard.
 *
 * This guard is deliberately diagnostic.  It keeps the immutable W109
 * receipt as a red witness and proves the exact observability seam exposed by
 * that witness: a scheduled poll has no durable attempt/outcome surface and
 * the read-health lastPollAt value is derived only from checkpoint.updatedAt.
 * Therefore a bootstrap admission/store/list failure, an empty poll, or an
 * unadvanced fenced poll all look like a poll that never ran.  W111 adds the
 * smallest production outcome surface; this file must remain a red-capable
 * baseline until that repair is applied.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const receiptPath = ".artifacts/sdt-g58-w109-ac5-single.json";
const reportPath = ".artifacts/sdt-g58-w110-red-guard.json";
const runtimePath = "packages/dcb-runtime/src/cloudflare.ts";
const workerPath = "samples/meeting-room/src/worker.cloudflare-only.ts";
const livePath = "packages/dcb-runtime/src/projection/LiveProjectionWorker.ts";
const projectionPath = "packages/dcb-runtime/src/projection/ProjectionRuntime.ts";
const mvPath = "samples/meeting-room/src/d1-mv.ts";
const completenessPath = "packages/dcb-runtime/src/completeness/GlobalCompletenessReconciler.ts";

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function fail(message) {
  throw new Error(`SDT-G58 W110 live-poll diagnosis guard failed: ${message}`);
}

function requireContains(source, expected, label) {
  if (!source.includes(expected)) fail(`${label} is missing ${JSON.stringify(expected)}`);
}

function requireAbsent(source, forbidden, label) {
  if (source.includes(forbidden)) fail(`${label} still contains ${JSON.stringify(forbidden)}`);
}

function loadReceipt() {
  let receipt;
  try {
    receipt = JSON.parse(read(receiptPath));
  } catch (error) {
    fail(`immutable W109 receipt is unreadable: ${String(error)}`);
  }
  if (receipt.status !== "failed") fail(`W109 status changed from failed: ${String(receipt.status)}`);
  if (!Array.isArray(receipt.healthSnapshots) || receipt.healthSnapshots.length !== 58) {
    fail(`W109 must retain all 58 health snapshots, found ${receipt.healthSnapshots?.length ?? "none"}`);
  }
  if (receipt.failure !== "safe lane or live projections did not reach 063924032953080000000952631413 by safeWindowMs + 120000ms") {
    fail(`W109 failure text changed: ${String(receipt.failure)}`);
  }
  const target = receipt.liveProjectionProof?.targetSuid;
  if (target !== "063924032953080000000952631413") fail(`unexpected W109 target SUID ${String(target)}`);
  return receipt;
}

function coverageGroups(receipt) {
  const groups = new Map();
  for (const snapshot of receipt.healthSnapshots) {
    const observedAt = snapshot?.coverage?.observedAt;
    if (!Number.isSafeInteger(observedAt)) fail("health snapshot omitted integer coverage.observedAt");
    const samples = groups.get(observedAt) ?? [];
    samples.push(snapshot);
    groups.set(observedAt, samples);
  }
  return [...groups.entries()].map(([observedAt, samples]) => ({
    observedAt,
    observedAtIso: new Date(observedAt).toISOString(),
    samples: samples.length,
    coverage: {
      kind: samples[0]?.coverage?.kind,
      reason: samples[0]?.coverage?.reason ?? null,
    },
    first: samples[0],
    last: samples.at(-1),
  }));
}

function validateReceipt(receipt, groups) {
  // This is three scheduled observedAt groups, not 58 cron ticks.  HTTP
  // health polling is intentionally not counted as scheduler execution.
  if (groups.length !== 3) fail(`expected three distinct scheduled coverage groups, found ${groups.length}`);
  if (groups.some((group) => group.coverage.kind !== "SETTLED" || group.coverage.reason !== null)) {
    fail(`W109 coverage was not continuously SETTLED: ${JSON.stringify(groups.map((group) => group.coverage))}`);
  }
  const target = receipt.liveProjectionProof.targetSuid;
  const last = receipt.healthSnapshots.at(-1);
  if (last?.coverage?.kind !== "SETTLED" || last.coverage.reason !== null) {
    fail("last W109 health snapshot no longer records SETTLED/null coverage");
  }
  if (last.globalHead !== target) fail("global head did not reach the W109 target");
  for (const view of last.materializedViews ?? []) {
    if (view.safeHead !== target) fail(`${view.viewId} materialized safe head did not reach target`);
  }
  for (const tagState of receipt.liveProjectionProof.tagState ?? []) {
    if (tagState.lastSortedUniqueId !== target) fail(`${tagState.tagStateId} tag state did not reach target`);
  }
  const firstLive = receipt.healthSnapshots[0]?.liveProjections ?? [];
  const lastLive = last.liveProjections ?? [];
  if (firstLive.length !== 2 || lastLive.length !== 2) fail("W109 must contain both RoomProjector and ReservationProjector");
  const frozenAt = firstLive[0]?.lastPollAt;
  for (const projectorId of ["RoomProjector", "ReservationProjector"]) {
    const first = firstLive.find((row) => row.projectorId === projectorId);
    const final = lastLive.find((row) => row.projectorId === projectorId);
    if (first === undefined || final === undefined) fail(`W109 omitted ${projectorId}`);
    if (first.lastPollAt !== frozenAt || final.lastPollAt !== frozenAt) {
      fail(`${projectorId} lastPollAt was not frozen at the historical value`);
    }
    if (final.head === target) fail(`${projectorId} unexpectedly reached the target`);
  }
  for (const lag of receipt.liveProjectionProof.projectionLag ?? []) {
    if (lag.behindEvents <= 0) fail(`${lag.tagStateId} no longer records a live projection lag shortfall`);
  }
  return {
    target,
    frozenLastPollAt: frozenAt,
    finalLive: lastLive,
    finalMaterialized: last.materializedViews,
    tagState: receipt.liveProjectionProof.tagState,
    projectionLag: receipt.liveProjectionProof.projectionLag,
  };
}

function sourceContracts(sources) {
  const { runtime, worker, live, projection, mv, completeness } = sources;
  const reconcile = "const scan = await new GlobalCompletenessReconciler(env.D1, env.TAG).reconcile(serviceId, Date.now());";
  const hook = "const safeLane = await options.beforeLiveProjectionPoll?.({ env, serviceId, scan });";
  const poll = "await pollLiveProjections(env, {";
  const reconcileAt = runtime.indexOf(reconcile);
  const hookAt = runtime.indexOf(hook, reconcileAt);
  const pollAt = runtime.indexOf(poll, hookAt);
  if (reconcileAt < 0 || hookAt < 0 || pollAt < 0 || reconcileAt > hookAt || hookAt > pollAt) {
    fail("scheduled reconcile → retained-frontier hook → live poll ordering changed");
  }
  requireAbsent(runtime, "if (scan.kind !== \"FULL\") return;", "retired non-FULL early return");
  requireContains(runtime, "maximumSuid: scheduledLiveProjectionMaximumSuid(scan, safeLane?.frontierSuid),", "scheduled high-water fence");
  requireContains(runtime, "export function scheduledLiveProjectionMaximumSuid(", "frontier mapper");
  requireContains(worker, "await runtime.scheduled?.(controller, env, ctx);", "sample scheduled handoff");
  requireContains(live, "async function admitBootstrapRoute", "bootstrap admission stage");
  requireContains(live, "await admitBootstrapRoute(env, serviceId);", "bootstrap admission invocation");
  requireContains(live, "await store.initialize();", "projection store initialization stage");
  requireContains(live, "const results = await runtime.pollRegistered(serviceId, attemptedAt, options.maximumSuid);", "registered projector polling stage");
  requireContains(projection, "const tags = await this.store.listProjectionTags(serviceId);", "tag discovery stage");
  requireContains(projection, "for (const tag of tags)", "all-tag poll loop");
  requireContains(projection, "for (const projector of this.registry.registered())", "both projector loop");
  requireContains(projection, "options.maximumSuid === null", "non-FULL null fence");
  requireContains(projection, "compareSuid(event.suid, options.maximumSuid) > 0", "non-FULL high-water fence");
  requireContains(mv, "SELECT projection_id, last_suid, updated_at", "checkpoint health query");
  requireContains(mv, "const lastPollAt = observation?.attemptedAt ?? null;", "attempt-derived lastPollAt");
  requireContains(completeness, "assertSnapshotUniverseUnchanged", "G44 snapshot-universe fence");
}

const OUTCOMES = [
  "never-invoked",
  "invoked-and-threw",
  "invoked-but-no-work",
  "explicitly-gated",
  "advanced",
];

function healthAttemptSurface(states) {
  if (!Array.isArray(states) || states.length !== 2) throw new Error("both projector attempt states are required");
  for (const state of states) {
    if (!OUTCOMES.includes(state.outcome)) throw new Error(`unknown live-poll outcome for ${String(state.projectorId)}`);
    if (!Number.isSafeInteger(state.attemptedAt) || state.attemptedAt < 1) throw new Error(`missing live-poll attemptedAt for ${String(state.projectorId)}`);
    if (state.outcome === "invoked-and-threw" && (typeof state.reason !== "string" || state.reason.length === 0)) {
      throw new Error(`throwing ${String(state.projectorId)} poll omitted a reason`);
    }
    if (state.outcome === "explicitly-gated" && (typeof state.reason !== "string" || state.reason.length === 0)) {
      throw new Error(`gated ${String(state.projectorId)} poll omitted a reason`);
    }
  }
  return true;
}

function outcomeMutationSelfTest() {
  const valid = [
    { projectorId: "RoomProjector", outcome: "invoked-but-no-work", attemptedAt: 200 },
    { projectorId: "ReservationProjector", outcome: "advanced", attemptedAt: 200 },
  ];
  healthAttemptSurface(valid);
  let missingAttemptRed = false;
  try {
    healthAttemptSurface(valid.map((state) => ({ ...state, attemptedAt: null })));
  } catch {
    missingAttemptRed = true;
  }
  if (!missingAttemptRed) fail("removing attemptedAt did not turn the diagnosis contract red");
  let missingThrowReasonRed = false;
  try {
    healthAttemptSurface(valid.map((state) => ({ ...state, outcome: "invoked-and-threw", reason: "" })));
  } catch {
    missingThrowReasonRed = true;
  }
  if (!missingThrowReasonRed) fail("removing a throwing-poll reason did not turn the diagnosis contract red");
  return { missingAttemptRed, missingThrowReasonRed, outcomes: OUTCOMES };
}

function sourceMutationSelfTest(sources) {
  const pollMutation = sources.runtime.replace("await pollLiveProjections(env, {", "await removedLiveProjectionPoll(env, {");
  let pollRed = false;
  try { sourceContracts({ ...sources, runtime: pollMutation }); } catch { pollRed = true; }
  if (!pollRed) fail("removing scheduled live polling did not turn the guard red");
  const fenceMutation = sources.projection.replace("compareSuid(event.suid, options.maximumSuid) > 0", "false");
  let fenceRed = false;
  try { sourceContracts({ ...sources, projection: fenceMutation }); } catch { fenceRed = true; }
  if (!fenceRed) fail("removing the retained-frontier comparison did not turn the guard red");
  const lastPollMutation = sources.mv.replace(
    "const lastPollAt = observation?.attemptedAt ?? null;",
    "const lastPollAt = null;",
  );
  let lastPollRed = false;
  try { sourceContracts({ ...sources, mv: lastPollMutation }); } catch { lastPollRed = true; }
  if (!lastPollRed) fail("removing checkpoint lastPollAt derivation did not turn the guard red");
  return { scheduledPollRemovalRed: pollRed, frontierFenceRemovalRed: fenceRed, lastPollDerivationRemovalRed: lastPollRed };
}

function loadSources() {
  return {
    runtime: read(runtimePath),
    worker: read(workerPath),
    live: read(livePath),
    projection: read(projectionPath),
    mv: read(mvPath),
    completeness: read(completenessPath),
  };
}

function runSelfTest() {
  const sources = loadSources();
  sourceContracts(sources);
  const mutations = sourceMutationSelfTest(sources);
  const outcomes = outcomeMutationSelfTest();
  process.stdout.write(`${JSON.stringify({ selfTest: "g58-w110-live-poll-diagnosis-red-capable", mutations, outcomes })}\n`);
}

function main() {
  const receipt = loadReceipt();
  const groups = coverageGroups(receipt);
  const facts = validateReceipt(receipt, groups);
  const sources = loadSources();
  sourceContracts(sources);
  const mutations = sourceMutationSelfTest(sources);
  const outcomeContract = outcomeMutationSelfTest();
  const report = {
    schema: "sdt-g58-w110-live-poll-diagnosis/v1",
    status: "red-baseline",
    task: "SDT-G58-LIVE-POLL-DIAGNOSIS-W110",
    sourceReceipt: receiptPath,
    immutableReceipt: { status: receipt.status, runId: receipt.runId, healthSamples: receipt.healthSnapshots.length },
    scheduledCoverageGroups: groups.map((group) => ({
      observedAt: group.observedAt,
      observedAtIso: group.observedAtIso,
      samples: group.samples,
      kind: group.coverage.kind,
      reason: group.coverage.reason,
    })),
    witness: facts,
    diagnosis: {
      schedulerReachedReconciliation: "coverage observedAt changed across three groups and all groups are SETTLED; materialized safe heads and tag-state rows reached the target",
      nonFullFence: "not implicated by this witness: every group is SETTLED and the target frontier is the scanned global/materialized head",
      livePollInvocation: "the committed scheduler orders pollLiveProjections after reconciliation and the W109 health surface proves no checkpoint advancement, but no receipt records whether admission, initialization, tag discovery, catch-up, or an empty result occurred",
      wrongIdentityOrRegistry: "not supported by the receipt: both named projector rows and target tag-state rows are present; no wrong-service/empty-registry fact is observable",
      healthAggregation: "not a stale-read selection: read-health and projection-lag report the same stale checkpoint rows while global/materialized/tag-state authorities are at target",
      causalSeam: "live poll attempt/outcome is not durably observable; readMeetingRoomHealth derives lastPollAt only from serialized_dcb_projection_checkpoints.updated_at, which changes only after an event advances",
      indistinguishableLowerLevel: ["invoked-and-threw at bootstrap admission/store initialization/list discovery", "invoked-but-no-work or fenced/no-advance"],
      repairPlan: "wrap the scheduled poll with a per-projector attempt lifecycle and persist attemptedAt, outcome, and bounded reason for both RoomProjector and ReservationProjector; make lastPollAt represent the attempt while retaining checkpoint head separately; preserve explicit non-FULL gating/fences and G44 snapshot-universe assertions",
    },
    redCapableGuard: {
      sourceMutations: mutations,
      outcomeContract: outcomeContract,
      invariant: "a SETTLED scheduled tick must either advance a projector or persist an explicit attempted poll outcome/blocker; stale checkpoint.updatedAt alone is insufficient",
    },
    bounds: {
      safeWindowFloorMs: 20000,
      safeWindowCeilingMs: 120000,
      unsafeBoundMs: 5000,
      g44FencePreserved: true,
      upstreamOutboxQueueGlobalAdmission: "held SDT-G60; not modified",
      noDeploymentOrNewRequests: true,
    },
  };
  mkdirSync(resolve(root, ".artifacts"), { recursive: true });
  writeFileSync(resolve(root, reportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ guard: "g58-w110-live-poll-diagnosis", status: report.status, report: reportPath, scheduledCoverageGroups: groups.length, healthSamples: receipt.healthSnapshots.length })}\n`);
}

if (process.argv.includes("--self-test")) runSelfTest();
else main();
