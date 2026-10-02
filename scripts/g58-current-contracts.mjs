#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");

const paths = Object.freeze({
  runtime: "packages/dcb-runtime/src/cloudflare.ts",
  live: "packages/dcb-runtime/src/projection/LiveProjectionWorker.ts",
  projection: "packages/dcb-runtime/src/projection/ProjectionRuntime.ts",
  worker: "samples/meeting-room/src/worker.cloudflare-only.ts",
  mv: "samples/meeting-room/src/d1-mv.ts",
  catchUp: "packages/dcb-runtime/src/mv/MaterializedViewCatchUp.ts",
  unsafe: "packages/dcb-runtime/src/mv/UnsafeWindowMaterializedView.ts",
  completeness: "packages/dcb-runtime/src/completeness/GlobalCompletenessReconciler.ts",
  migration: "migrations/d1/g32/0004_g58_live_poll_health.sql",
  safeLaneMigration: "migrations/d1/g32/0003_g58_safe_lane_health.sql",
  historyMigration: "migrations/d1/g32/0005_g58_safe_lane_history.sql",
  delivery: "packages/dcb-runtime/src/downstream/DeliveryCore.ts",
  safeTest: "test/g58-safe-lane.spec.ts",
  diagnosisTest: "test/g58-safe-lane-diagnosis.spec.ts",
  reentryTest: "test/g58-reservation-reentry.spec.ts",
  advancementTest: "test/g58-live-poll-advancement-repair.spec.ts",
  liveTest: "test/g58-live-poll-green-repair.spec.ts",
});

function fail(message) {
  throw new Error(`SDT-G58 current contract check failed: ${message}`);
}

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function snapshot() {
  return Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, read(path)]));
}

function contains(source, expected, label) {
  if (!source.includes(expected)) fail(`${label} is missing ${JSON.stringify(expected)}`);
}

function matches(source, pattern, label) {
  if (!pattern.test(source)) fail(`${label} does not match ${pattern}`);
}

function absent(source, forbidden, label) {
  if (source.includes(forbidden)) fail(`${label} still contains ${JSON.stringify(forbidden)}`);
}

function ordered(source, first, second, label) {
  const firstAt = source.indexOf(first);
  const secondAt = source.indexOf(second, firstAt + first.length);
  if (firstAt < 0 || secondAt < 0 || firstAt >= secondAt) fail(`${label} changed order`);
}

function between(source, start, end, label) {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  if (startAt < 0 || endAt < 0) fail(`${label} section is missing`);
  return source.slice(startAt, endAt);
}

function replaceOnce(source, from, to, label) {
  const count = source.split(from).length - 1;
  if (count !== 1) fail(`${label} anchor expected once, found ${count}`);
  return source.replace(from, to);
}

function replaceAllRequired(source, from, to, label) {
  const count = source.split(from).length - 1;
  if (count < 1) fail(`${label} anchor was not found`);
  return source.replaceAll(from, to);
}

function replaceRegexOnce(source, pattern, replacement, label) {
  const matches = source.match(pattern) ?? [];
  if (matches.length !== 1) fail(`${label} anchor expected once, found ${matches.length}`);
  return source.replace(pattern, replacement);
}

function replaceSection(source, start, end, mutate, label) {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  if (startAt < 0 || endAt < 0) fail(`${label} section is missing`);
  const section = source.slice(startAt, endAt);
  const mutated = mutate(section);
  if (mutated === section) fail(`${label} did not change its intended section`);
  return `${source.slice(0, startAt)}${mutated}${source.slice(endAt)}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function assertSourceContracts(sources) {
  const {
    runtime,
    live,
    projection,
    worker,
    mv,
    catchUp,
    unsafe,
    completeness,
    migration,
    safeLaneMigration,
    historyMigration,
    delivery,
  } = sources;
  const reconcile = "const scan = await new GlobalCompletenessReconciler(env.D1, env.TAG).reconcile(serviceId, Date.now());";
  const hook = "const safeLane = await options.beforeLiveProjectionPoll?.({ env, serviceId, scan, ctx });";
  const poll = "await pollLiveProjections(env, {";
  ordered(runtime, reconcile, hook, "scheduled reconciliation and safe-lane hook");
  ordered(runtime, hook, poll, "safe-lane hook and scheduled poll");
  absent(runtime, "if (scan.kind !== \"FULL\") return;", "BLOCK early return");
  contains(runtime, "maximumSuid: scheduledLiveProjectionMaximumSuid(scan, safeLane?.frontierSuid),", "scheduled retained-frontier fence");
  contains(runtime, "observer: options.liveProjectionPollObserver,", "scheduled observer handoff");
  contains(runtime, "export function scheduledLiveProjectionMaximumSuid(", "scheduled frontier mapper");

  const maintenanceStart = worker.indexOf("export async function runMeetingRoomScheduledMaintenance");
  if (maintenanceStart < 0) fail("scheduled maintenance section is missing");
  const maintenance = worker.slice(maintenanceStart);
  const freshMaintenance = between(maintenance, "if (input.freshCoverage !== undefined) {", "if (input.globalCoverage !== undefined)", "fresh scheduled maintenance");
  ordered(freshMaintenance, "await input.catchUp(coverage.frontierSuid);", "await input.drainUnsafeKicks(coverage.frontierSuid);", "safe catch-up and unsafe drain");
  contains(freshMaintenance, "await input.runGenericScheduledWork();", "same-tick scheduled work");
  contains(worker, "return { frontierSuid: coverage.frontierSuid };", "sample frontier handoff");
  contains(worker, "await runtime.scheduled?.(controller, env, ctx);", "sample scheduled runtime handoff");
  contains(worker, '"/conformance/v1/read-health"', "authenticated read-health route");
  contains(worker, '"/conformance/v1/internal/projection/lag"', "authenticated projection-lag relay");
  contains(worker, "recordMeetingRoomLivePollAttempt", "sample attempt persistence");
  contains(worker, "recordMeetingRoomLivePollOutcome", "sample outcome persistence");
  contains(worker, "recordMeetingRoomSafeLaneCoverage", "sample safe-lane coverage persistence");

  contains(live, "maximumSuid?: string | null;", "live-poll maximum frontier option");
  contains(live, "{ maximumSuid: options.maximumSuid },", "single-tag maximum frontier propagation");
  contains(live, "const results = await runtime.pollRegistered(serviceId, attemptedAt, options.maximumSuid);", "registered maximum frontier propagation");
  contains(live, "await notifyObserver(options.observer, \"onAttempt\", { env, serviceId, projectorIds, attemptedAt });", "attempt lifecycle");
  contains(live, "await notifyOutcomes(options.observer, serviceId, projectorIds, attemptedAt, results, options.maximumSuid, env);", "successful outcome lifecycle");
  contains(live, "await notifyOutcomes(options.observer, serviceId, projectorIds, attemptedAt, [], options.maximumSuid, env, error);", "throwing outcome lifecycle");
  contains(live, "reason = boundedErrorReason(error);", "bounded throwing outcome reason");
  contains(live, "export const LIVE_PROJECTION_POLL_OUTCOMES", "live-poll outcome vocabulary");
  contains(live, "async function admitBootstrapRoute", "bootstrap admission stage");
  contains(live, "await admitBootstrapRoute(env, serviceId);", "bootstrap admission ordering");
  contains(live, "await store.initialize();", "store initialization ordering");

  contains(projection, "export const MAX_LIVE_PROJECTION_CONCURRENCY = 8;", "bounded live-poll width");
  contains(projection, "const jobs: Array<{ readonly tag: string; readonly projector: string }> = [];", "live-poll job list");
  contains(projection, "const worker = async (): Promise<void> => {", "bounded live-poll worker");
  contains(projection, "const workerCount = Math.min(MAX_LIVE_PROJECTION_CONCURRENCY, jobs.length);", "bounded live-poll worker count");
  contains(projection, "await Promise.all(Array.from({ length: workerCount }, () => worker()));", "parallel live-poll pool");
  contains(projection, "results[index] = await this.catchUp", "stable live-poll result placement");
  contains(projection, "readonly projectorId: string;", "projector identity result");
  contains(projection, "readonly tag: string;", "tag identity result");
  contains(projection, "const tags = await this.store.listProjectionTags(serviceId);", "tag discovery stage");
  contains(projection, "for (const tag of tags)", "all-tag poll loop");
  contains(projection, "for (const projector of this.registry.registered())", "all-projector poll loop");
  contains(projection, "async pollRegistered(\n    serviceId: string,\n    nowMs: number,\n    maximumSuid?: string | null,", "pollRegistered frontier API");
  contains(projection, "options.maximumSuid === null", "null retained-frontier fence");
  contains(projection, "compareSuid(event.suid, options.maximumSuid) > 0", "retained high-water fence");
  contains(projection, "Stop at the first unsafe source event", "first-unsafe barrier");

  const catchSection = between(mv, "export async function catchUpMeetingRoomMaterializedViews", "export async function drainMeetingRoomUnsafeKicks", "safe MV catch-up");
  const drainSection = mv.slice(mv.indexOf("export async function drainMeetingRoomUnsafeKicks"));
  contains(catchSection, "for (const materializer of fanoutMaterializers(configuredViewCount(env.G26_VIEW_COUNT))) {", "serial safe MV iteration");
  contains(catchSection, "maximumSuid: frontierSuid", "safe MV retained frontier");
  contains(drainSection, "for (const materializer of fanoutMaterializers(configuredViewCount(env.G26_VIEW_COUNT))) {", "serial unsafe MV iteration");
  contains(drainSection, "const result = await runtime.follow(serviceId, materializer, nowMs, {}, { maximumSuid: frontierSuid });", "unsafe drain result frontier");
  contains(drainSection, "await runtime.follow(serviceId, materializer, nowMs, {}, { maximumSuid: frontierSuid });", "unsafe drain retained frontier");
  contains(drainSection, "await unsafe.finishKick(serviceId, materializer.id, owner, result.instance.lastSuid);", "unsafe drain reached checkpoint handoff");
  contains(mv, "return [roomMaterializer, reservationMaterializer] as const;", "Room-before-Reservation materializer order");
  contains(catchSection, "await runtime.follow(serviceId, materializer, Date.now(), hooks, { maximumSuid: frontierSuid });", "safe MV retained-frontier follow");
  contains(catchUp, "if (error instanceof MaterializedViewCasError)", "typed MV CAS contention handling");
  contains(mv, "const head = states.reduce((minimum, checkpoint) => minimum === \"\" || checkpoint.head < minimum ? checkpoint.head : minimum, \"\");", "minimum live head aggregation");
  contains(mv, "const checkpointUpdatedAt = states.length === 0 ? null : Math.min(...states.map((state) => state.updatedAt));", "minimum live timestamp aggregation");
  contains(mv, "const lastPollAt = observation?.attemptedAt ?? null;", "attempt-derived lastPollAt");
  contains(mv, "SELECT projection_id, last_suid, updated_at", "checkpoint health query");
  contains(mv, "FROM serialized_dcb_live_poll_health", "live-poll health query");
  contains(mv, "pollStatus: observation?.outcome ?? \"never-invoked\"", "explicit health outcome");
  contains(mv, "pollReason: observation?.reason ?? \"scheduled_live_poll_has_not_run\"", "explicit blocker reason");
  contains(mv, "export async function readMeetingRoomHealth", "read-only health reader");
  contains(mv, "serialized_dcb_safe_lane_health", "scheduled health authority");
  contains(mv, "safeWindowCeilingExceeded", "lag ceiling observation");
  contains(mv, "export function meetingRoomSafeLaneTickId", "stable tick identity");
  contains(mv, "serialized_dcb_safe_lane_history", "append-only history table");
  contains(mv, "ON CONFLICT (service_id, tick_id) DO NOTHING", "history insert must not update");
  contains(mv, "coverageHistory", "health history surface");
  contains(mv, "settled_frontier_suid", "persisted proven frontier");
  contains(catchUp, "if (options.maximumSuid === null || (\n          options.maximumSuid !== undefined && compareSuid(event.suid, options.maximumSuid) > 0\n        )) {", "no-frontier source hold");
  contains(catchUp, "if (event.lastArrivedAt > nowMs - windowMs)", "first-unsafe SafeWindow barrier");
  contains(catchUp, "return {\n            instance: current,", "bounded first-unsafe return");
  contains(catchUp, "const MAX_CAS_RETRIES = 8;", "bounded MV retry policy");
  contains(unsafe, "async finishKick(serviceId: string, viewId: string, owner: string, reachedSuid: string)", "kick reached checkpoint argument");
  contains(unsafe, "target_suid COLLATE BINARY > ? COLLATE BINARY", "kick target comparison");
  contains(unsafe, ".bind(reachedSuid, reachedSuid, serviceId, viewId, owner)", "kick reached checkpoint bind");
  contains(completeness, "assertSnapshotUniverseUnchanged", "snapshot universe fence");
  contains(completeness, "frontierSuid: await this.settledFrontierAtSnapshot(serviceId, snapshots)", "FULL frontier calculation");
  contains(completeness, "sdt-g58-settled-frontier/v1", "frontier cursor schema");
  contains(completeness, "COALESCE(excluded.cursor_json", "prior FULL frontier retention");
  contains(migration, "serialized_dcb_live_poll_health", "live-poll health table");
  contains(safeLaneMigration, "service_id TEXT PRIMARY KEY", "safe-lane single-row schema");
  contains(safeLaneMigration, "settled_frontier_suid TEXT NOT NULL", "persisted frontier column");
  contains(historyMigration, "PRIMARY KEY (service_id, tick_id)", "stable history primary key");
  contains(historyMigration, "UNIQUE (service_id, observed_at)", "one row per scheduled tick");
  contains(historyMigration, "coverage_kind", "persisted coverage kind");
  contains(historyMigration, "coverage_reason", "persisted coverage reason");
  contains(historyMigration, "coverage_partition_tag", "persisted partition tag");
  contains(historyMigration, "observed_at", "persisted observation time");
  contains(sources.safeTest, "decayedLagEstimateMs", "lag decay function fixture");
  contains(sources.safeTest, "scheduled coverage history append-only", "append-only history oracle");
  contains(sources.safeTest, "safe_lane_history_tick_conflict", "same-tick mutation oracle");
  contains(delivery, "const outcomes = await Promise.all(views.map(async (view) => {", "independent delivery view branches");
  for (const outcome of ["never-invoked", "invoked-and-threw", "invoked-but-no-work", "explicitly-gated", "advanced"]) {
    contains(migration, `'${outcome}'`, `live-poll outcome ${outcome}`);
  }

  contains(sources.safeTest, "continues a BLOCK tick through only the retained FULL frontier", "BLOCK direct test");
  contains(sources.safeTest, "returns the bearer-only health surface", "health direct test");
  contains(sources.safeTest, "decays a retired lag estimate", "lag direct test");
  contains(sources.safeTest, "aggregates each projector's live head from its minimum checkpoint across two tags", "two-checkpoint minimum-head direct test");
  contains(sources.diagnosisTest, "W97 GREEN: applies a freshly scanned FULL frontier in the same scheduled tick", "same-tick direct test");
  contains(sources.diagnosisTest, "last proven frontier", "retained-frontier direct test");
  contains(sources.diagnosisTest, "freshCoverage", "fresh-frontier seam fixture");
  contains(worker, "beforeLiveProjectionPoll: async ({ env, serviceId, ctx })", "sample fresh-reconcile hook");
  contains(safeLaneMigration, "serialized_dcb_safe_lane_health", "operational health migration");
  contains(sources.reentryTest, 'const ROOM_VIEW = "RoomProjector";', "Room re-entry fixture");
  contains(sources.reentryTest, 'const RESERVATION_VIEW = "ReservationProjector";', "Reservation re-entry fixture");
  contains(sources.reentryTest, "maximumSuid: targetSuid", "re-entry frontier fixture");
  contains(sources.reentryTest, "finishKick", "re-entry settlement fixture");
  contains(sources.advancementTest, 'new ProjectorRegistry([projector("RoomProjector"), projector("ReservationProjector")])', "two-projector fixture");
  contains(sources.advancementTest, "maximumConcurrentReads", "concurrency fixture");
  contains(sources.advancementTest, "toBeGreaterThan(1)", "parallelism assertion");
  contains(sources.liveTest, "records an attempted no-work outcome for both registered projectors", "attempt outcome direct test");
  contains(sources.liveTest, "records both projector failures when bootstrap admission rejects the poll", "bootstrap failure direct test");
  contains(sources.liveTest, "records initialization failure for both projectors without hiding the failure", "initialization failure direct test");
  contains(sources.reentryTest, "const nowMs = 1_788_428_500_000;", "controlled re-entry clock");
  contains(sources.reentryTest, "lastArrivedAt", "controlled arrival timestamps");
  contains(sources.reentryTest, "expect(await kickRow(serviceId)).toEqual({ targetSuid, dirty: 1, leaseOwner: null });", "re-armed kick assertion");
  contains(sources.reentryTest, "const eligibleAt = nowMs + 21_000;", "SafeWindow-eligible re-entry clock");
  contains(sources.reentryTest, "expect((await views.readActive(serviceId, ROOM_VIEW))?.lastSuid).toBe(targetSuid);", "independent Room convergence");
  matches(unsafe, /dirty\s*=\s*CASE[\s\S]*?target_suid COLLATE BINARY > \? COLLATE BINARY[\s\S]*?END/, "kick target comparison");
}

function contractMutationResults(sources) {
  const projectionFence = "if (options.maximumSuid === null || (\n          options.maximumSuid !== undefined && compareSuid(event.suid, options.maximumSuid) > 0\n        )) {";
  const liveProjectionFence = "compareSuid(event.suid, options.maximumSuid) > 0";
  const workerFrontier = "await input.catchUp(coverage.frontierSuid);";
  const workerOrder = "await input.catchUp(coverage.frontierSuid);\n    await input.drainUnsafeKicks(coverage.frontierSuid);";
  const mvLoop = "for (const materializer of fanoutMaterializers(configuredViewCount(env.G26_VIEW_COUNT))) {";
  const outcomeCall = "await notifyOutcomes(options.observer, serviceId, projectorIds, attemptedAt, results, options.maximumSuid, env);";
  const cases = [
    ["reintroduce-BLOCK-early-return", (value) => ({ ...value, runtime: replaceOnce(value.runtime, "const safeLane = await options.beforeLiveProjectionPoll?.({ env, serviceId, scan, ctx });", "const safeLane = await options.beforeLiveProjectionPoll?.({ env, serviceId, scan, ctx });\n      if (scan.kind !== \"FULL\") return;", "BLOCK early return") })],
    ["remove-scheduled-retained-frontier-fence", (value) => ({ ...value, runtime: replaceOnce(value.runtime, "maximumSuid: scheduledLiveProjectionMaximumSuid(scan, safeLane?.frontierSuid),", "maximumSuid: undefined,", "scheduled frontier") })],
    ["remove-projection-high-water-check", (value) => ({ ...value, projection: replaceOnce(value.projection, projectionFence, "if (false) {", "projection high-water fence") })],
    ["remove-observer-handoff", (value) => ({ ...value, runtime: replaceOnce(value.runtime, "observer: options.liveProjectionPollObserver,", "observer: undefined,", "observer handoff") })],
    ["remove-attempt-lifecycle", (value) => ({ ...value, live: replaceOnce(value.live, "await notifyObserver(options.observer, \"onAttempt\", { env, serviceId, projectorIds, attemptedAt });", "void options.observer;", "attempt lifecycle") })],
    ["remove-terminal-outcome-lifecycle", (value) => ({ ...value, live: replaceAllRequired(value.live, outcomeCall, "return results;", "terminal outcome lifecycle") })],
    ["erase-attempt-derived-lastPollAt", (value) => ({ ...value, mv: replaceOnce(value.mv, "const lastPollAt = observation?.attemptedAt ?? null;", "const lastPollAt = null;", "attempt-derived lastPollAt") })],
    ["remove-live-projection-frontier-fence", (value) => ({ ...value, projection: replaceOnce(value.projection, liveProjectionFence, "false", "live projection frontier") })],
    ["serialize-live-poll-pool", (value) => ({ ...value, projection: replaceOnce(value.projection, "await Promise.all(Array.from({ length: workerCount }, () => worker()));", "await worker();", "live-poll pool") })],
    ["set-live-poll-width-to-one", (value) => ({ ...value, projection: replaceOnce(value.projection, "export const MAX_LIVE_PROJECTION_CONCURRENCY = 8;", "export const MAX_LIVE_PROJECTION_CONCURRENCY = 1;", "live-poll width") })],
    ["drop-second-projector", (value) => ({ ...value, advancementTest: replaceOnce(value.advancementTest, 'new ProjectorRegistry([projector("RoomProjector"), projector("ReservationProjector")])', 'new ProjectorRegistry([projector("RoomProjector")])', "projector fixture") })],
    ["remove-no-frontier-source-hold", (value) => ({ ...value, catchUp: replaceOnce(value.catchUp, "options.maximumSuid === null", "false", "no-frontier hold") })],
    ["remove-safe-catch-up-retained-frontier", (value) => ({
      ...value,
      worker: replaceSection(
        value.worker,
        "if (input.freshCoverage !== undefined) {",
        "if (input.globalCoverage !== undefined)",
        (section) => replaceOnce(section, workerFrontier, "await input.catchUp();", "safe catch-up frontier"),
        "fresh scheduled maintenance",
      ),
    })],
    ["remove-scheduled-live-poll", (value) => ({ ...value, runtime: replaceOnce(value.runtime, "await pollLiveProjections(env, {", "await removedLiveProjectionPoll(env, {", "scheduled live poll") })],
    ["remove-serial-safe-mv-iteration", (value) => {
      const catchSection = between(value.mv, "export async function catchUpMeetingRoomMaterializedViews", "export async function drainMeetingRoomUnsafeKicks", "safe MV catch-up mutant");
      const mutatedCatch = replaceOnce(catchSection, mvLoop, "for (const materializer of [] as never[]) {", "serial safe MV iteration");
      return { ...value, mv: value.mv.replace(catchSection, mutatedCatch) };
    }],
    ["swap-safe-catch-up-and-unsafe-drain", (value) => ({ ...value, worker: replaceOnce(value.worker, workerOrder, "await input.drainUnsafeKicks(coverage.frontierSuid);\n    await input.catchUp(coverage.frontierSuid);", "safe/drain order") })],
    ["remove-kick-target-comparison", (value) => ({ ...value, unsafe: replaceRegexOnce(value.unsafe, /dirty\s*=\s*CASE[\s\S]*?END/, "dirty = 0", "kick target comparison") })],
    ["omit-reached-checkpoint-handoff", (value) => ({ ...value, mv: replaceOnce(value.mv, "await unsafe.finishKick(serviceId, materializer.id, owner, result.instance.lastSuid);", "await unsafe.finishKick(serviceId, materializer.id, owner);", "reached checkpoint handoff") })],
    ["remove-first-unsafe-barrier", (value) => ({ ...value, catchUp: replaceOnce(value.catchUp, "if (event.lastArrivedAt > nowMs - windowMs)", "if (false)", "first-unsafe barrier") })],
    ["remove-unsafe-drain-frontier", (value) => ({ ...value, mv: replaceOnce(value.mv, "await runtime.follow(serviceId, materializer, nowMs, {}, { maximumSuid: frontierSuid });", "await runtime.follow(serviceId, materializer, nowMs, {}, { maximumSuid: undefined });", "unsafe drain frontier") })],
  ];

  return cases.map(([label, mutate]) => {
    assertSourceContracts(sources);
    const mutated = mutate(sources);
    const changedSources = Object.keys(sources).filter((name) => mutated[name] !== sources[name]);
    if (changedSources.length === 0) fail(`${label} did not change a source`);
    let red = false;
    let reason = "";
    try {
      assertSourceContracts(mutated);
    } catch (error) {
      red = true;
      reason = errorMessage(error);
    }
    if (!red) fail(`${label} unexpectedly stayed green`);
    return { label, oracle: "current-source-contract", baseline: "pass", mutant: "red", reason };
  });
}

function runVitest(testFile, pattern, label) {
  const result = spawnSync(process.execPath, [
    vitest,
    "run",
    "--config", "vitest.config.ts",
    "--no-cache",
    "--maxWorkers=1",
    testFile,
    "--testNamePattern", pattern,
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    label,
    exitCode: result.status ?? 1,
    signal: result.signal,
    stdoutBytes: Buffer.byteLength(result.stdout ?? ""),
    stderrBytes: Buffer.byteLength(result.stderr ?? ""),
    failureReason: result.status === 0 ? null : `${(result.stderr || result.stdout || `exit ${String(result.status ?? 1)}`).trim().split(/\r?\n/).slice(-3).join(" ")}`.slice(-1200),
  };
}

function directMutationResult({ label, sourcePath, from, to, testFile, pattern }) {
  const absolutePath = resolve(root, sourcePath);
  const original = readFileSync(absolutePath, "utf8");
  const baseline = runVitest(testFile, pattern, `${label} baseline`);
  if (baseline.exitCode !== 0) fail(`${label} baseline was red (exit ${baseline.exitCode})`);
  const mutated = replaceOnce(original, from, to, label);
  if (mutated === original) fail(`${label} did not change its source`);
  let mutant;
  try {
    writeFileSync(absolutePath, mutated, "utf8");
    mutant = runVitest(testFile, pattern, `${label} mutant`);
  } finally {
    writeFileSync(absolutePath, original, "utf8");
  }
  if (readFileSync(absolutePath, "utf8") !== original) fail(`${label} source was not restored`);
  if (mutant.exitCode === 0) fail(`${label} unexpectedly stayed green`);
  return {
    label,
    oracle: `${testFile} :: ${pattern}`,
    baselineExitCode: baseline.exitCode,
    mutantExitCode: mutant.exitCode,
    reason: mutant.failureReason ?? `vitest exited ${mutant.exitCode}`,
    result: "red",
  };
}

function directMutationResults() {
  return [
    directMutationResult({
      label: "omit-live-poll-attemptedAt",
      sourcePath: paths.live,
      from: "      attemptedAt,\n      outcome,",
      to: "      outcome,",
      testFile: paths.liveTest,
      pattern: "records an attempted no-work outcome for both registered projectors",
    }),
    directMutationResult({
      label: "omit-throwing-live-poll-reason",
      sourcePath: paths.live,
      from: "      reason = boundedErrorReason(error);",
      to: "      void error;",
      testFile: paths.liveTest,
      pattern: "records both projector failures when bootstrap admission rejects the poll|records initialization failure for both projectors without hiding the failure",
    }),
    directMutationResult({
      label: "reverse-minimum-head-aggregation",
      sourcePath: paths.mv,
      from: "checkpoint.head < minimum",
      to: "checkpoint.head > minimum",
      testFile: paths.safeTest,
      pattern: "aggregates each projector's live head from its minimum checkpoint across two tags",
    }),
  ];
}

function main() {
  const sources = snapshot();
  assertSourceContracts(sources);
  if (process.argv.includes("--self-test")) {
    const contracts = contractMutationResults(sources);
    process.stdout.write(`${JSON.stringify({ check: "g58-current-contracts", labels: contracts.map(({ label }) => label), contracts, result: "anchors-and-red-contracts-pass" })}\n`);
    return;
  }
  const contracts = contractMutationResults(sources);
  const direct = directMutationResults();
  process.stdout.write(`${JSON.stringify({ check: "g58-current-contracts", contracts, direct })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
