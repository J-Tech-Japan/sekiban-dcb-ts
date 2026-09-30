#!/usr/bin/env node
/**
 * SDT-G58 W111 green-repair guard.
 *
 * The W110 receipt remains the immutable red baseline.  This guard proves the
 * smallest AC5 repair: a scheduled poll starts an observation lifecycle for
 * every registered projector, terminal outcomes are durable, and health uses
 * the attempt timestamp separately from the checkpoint head.  It also keeps
 * the G44 source-universe/high-water fence contracts red-capable.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const w110Report = ".artifacts/sdt-g58-w110-red-guard.json";
const reportPath = ".artifacts/ci-local/g58-live-poll-green.json";
const runtimePath = "packages/dcb-runtime/src/cloudflare.ts";
const livePath = "packages/dcb-runtime/src/projection/LiveProjectionWorker.ts";
const projectionPath = "packages/dcb-runtime/src/projection/ProjectionRuntime.ts";
const mvPath = "samples/meeting-room/src/d1-mv.ts";
const workerPath = "samples/meeting-room/src/worker.cloudflare-only.ts";
const completenessPath = "packages/dcb-runtime/src/completeness/GlobalCompletenessReconciler.ts";
const migrationPath = "migrations/d1/g32/0004_g58_live_poll_health.sql";

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function fail(message) {
  throw new Error(`SDT-G58 W111 live-poll green guard failed: ${message}`);
}

function contains(source, value, label) {
  if (!source.includes(value)) fail(`${label} is missing ${JSON.stringify(value)}`);
}

function loadSources() {
  return {
    runtime: read(runtimePath),
    live: read(livePath),
    projection: read(projectionPath),
    mv: read(mvPath),
    worker: read(workerPath),
    completeness: read(completenessPath),
    migration: read(migrationPath),
  };
}

function sourceContracts(sources) {
  const { runtime, live, projection, mv, worker, completeness, migration } = sources;
  contains(runtime, "observer: options.liveProjectionPollObserver,", "scheduled observer handoff");
  contains(runtime, "const scan = await new GlobalCompletenessReconciler(env.D1, env.TAG).reconcile(serviceId, Date.now());", "fresh reconciliation");
  contains(runtime, "maximumSuid: scheduledLiveProjectionMaximumSuid(scan, safeLane?.frontierSuid),", "scheduled high-water fence");
  contains(live, "export const LIVE_PROJECTION_POLL_OUTCOMES", "outcome vocabulary");
  contains(live, "await notifyObserver(options.observer, \"onAttempt\", { env, serviceId, projectorIds, attemptedAt });", "attempt lifecycle");
  contains(live, "await notifyOutcomes(options.observer, serviceId, projectorIds, attemptedAt, results, options.maximumSuid, env);", "successful outcome lifecycle");
  contains(live, "await notifyOutcomes(options.observer, serviceId, projectorIds, attemptedAt, [], options.maximumSuid, env, error);", "throwing outcome lifecycle");
  contains(live, "await admitBootstrapRoute(env, serviceId);", "bootstrap admission ordering");
  contains(live, "await store.initialize();", "store initialization ordering");
  contains(projection, "readonly projectorId: string;", "projector identity result");
  contains(projection, "readonly tag: string;", "tag identity result");
  contains(projection, "options.maximumSuid === null", "null retained-frontier fence");
  contains(projection, "compareSuid(event.suid, options.maximumSuid) > 0", "high-water retained-frontier fence");
  contains(mv, "FROM serialized_dcb_live_poll_health", "live-poll health query");
  contains(mv, "const lastPollAt = observation?.attemptedAt ?? null;", "attempt-derived lastPollAt");
  contains(mv, "pollStatus: observation?.outcome ?? \"never-invoked\"", "explicit health outcome");
  contains(mv, "pollReason: observation?.reason ?? \"scheduled_live_poll_has_not_run\"", "explicit blocker reason");
  contains(worker, "recordMeetingRoomLivePollAttempt", "sample attempt persistence");
  contains(worker, "recordMeetingRoomLivePollOutcome", "sample outcome persistence");
  contains(completeness, "assertSnapshotUniverseUnchanged", "G44 snapshot-universe fence");
  contains(migration, "serialized_dcb_live_poll_health", "live-poll health migration table");
  for (const outcome of ["never-invoked", "invoked-and-threw", "invoked-but-no-work", "explicitly-gated", "advanced"]) {
    contains(migration, `'${outcome}'`, `migration outcome ${outcome}`);
  }
}

function mutationSelfTest(sources) {
  const cases = [
    ["scheduledObserverHandoffRemovalRed", sources.runtime.replace("observer: options.liveProjectionPollObserver,", "observer: undefined,")],
    ["attemptLifecycleRemovalRed", sources.live.replace("await notifyObserver(options.observer, \"onAttempt\", { env, serviceId, projectorIds, attemptedAt });", "void options.observer;"), "live"],
    ["outcomeLifecycleRemovalRed", sources.live.replaceAll("await notifyOutcomes(options.observer, serviceId, projectorIds, attemptedAt, results, options.maximumSuid, env);", "return results;"), "live"],
    ["lastPollAttemptRemovalRed", sources.mv.replace("const lastPollAt = observation?.attemptedAt ?? null;", "const lastPollAt = null;"), "mv"],
    ["frontierFenceRemovalRed", sources.projection.replace("compareSuid(event.suid, options.maximumSuid) > 0", "false"), "projection"],
  ];
  const red = {};
  for (const [name, mutated, sourceName = "runtime"] of cases) {
    const mutatedSources = { ...sources, [sourceName]: mutated };
    let failed = false;
    try { sourceContracts(mutatedSources); } catch { failed = true; }
    if (!failed) fail(`${name} did not turn the guard red`);
    red[name] = true;
  }
  return red;
}

function requireW110Baseline() {
  let report;
  try { report = JSON.parse(read(w110Report)); } catch (error) { fail(`W110 red receipt is unreadable: ${String(error)}`); }
  if (report.status !== "red-baseline") fail(`W110 red receipt status changed: ${String(report.status)}`);
  if (report.task !== "SDT-G58-LIVE-POLL-DIAGNOSIS-W110") fail("W110 red receipt task changed");
  return { status: report.status, sourceReceipt: report.sourceReceipt, healthSamples: report.immutableReceipt?.healthSamples };
}

function runFocusedTest() {
  const result = spawnSync("npm", ["exec", "vitest", "run", "--config", "vitest.config.ts", "test/g58-live-poll-green-repair.spec.ts"], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    fail(`focused lifecycle test failed with exit ${String(result.status)}: ${(result.stderr || result.stdout || "").slice(-4000)}`);
  }
  return {
    command: "npm exec vitest run --config vitest.config.ts test/g58-live-poll-green-repair.spec.ts",
    exitCode: result.status,
    stdoutBytes: Buffer.byteLength(result.stdout ?? ""),
    stderrBytes: Buffer.byteLength(result.stderr ?? ""),
  };
}

function selfTest() {
  const sources = loadSources();
  sourceContracts(sources);
  const mutations = mutationSelfTest(sources);
  process.stdout.write(`${JSON.stringify({ selfTest: "g58-w111-live-poll-green-repair-red-capable", mutations })}\n`);
}

function main() {
  const sources = loadSources();
  const baseline = requireW110Baseline();
  sourceContracts(sources);
  const mutations = mutationSelfTest(sources);
  const focused = runFocusedTest();
  const report = {
    schema: "sdt-g58-w111-live-poll-green-repair/v1",
    status: "green",
    task: "SDT-G58-LIVE-POLL-GREEN-REPAIR-W111",
    predecessor: { commit: "aa6f101", immutableRedBaseline: baseline },
    repair: {
      observer: "scheduled poll records one attempt timestamp and one terminal outcome per registered projector; observation failures are ancillary and cannot alter projection semantics",
      outcomes: ["never-invoked", "invoked-and-threw", "invoked-but-no-work", "explicitly-gated", "advanced"],
      health: "lastPollAt is the attempted poll timestamp; head/headAgeMs remain checkpoint-derived",
      fences: "G44 snapshot-universe and maximumSuid retained-frontier fences are unchanged",
    },
    mutationRed: mutations,
    focusedTest: focused,
    bounds: { safeWindowFloorMs: 20000, safeWindowCeilingMs: 120000, unsafeBoundMs: 5000, noDeployment: true, noNewRequests: true },
  };
  mkdirSync(resolve(root, ".artifacts/ci-local"), { recursive: true });
  writeFileSync(resolve(root, reportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ guard: "g58-w111-live-poll-green-repair", status: report.status, report: reportPath, focused: focused.exitCode })}\n`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
