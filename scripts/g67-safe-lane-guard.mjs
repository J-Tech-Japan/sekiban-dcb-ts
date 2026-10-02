#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const testFile = "test/g67-safe-lane.spec.ts";
const workerFile = "samples/meeting-room/src/worker.cloudflare-only.ts";
const adapterFile = "packages/dcb-runtime/src/downstream/DownstreamAdapter.ts";
const runtimeFile = "packages/dcb-runtime/src/cloudflare.ts";
const schedulerFile = "samples/meeting-room/src/safe-lane-kick.ts";
const observationMigrationFile = "migrations/d1/g32/0013_g67_safe_lane_catch_up_observations.sql";
const fenceExpiryMigrationFile = "migrations/d1/g32/0014_g67_safe_lane_fence_expiry.sql";

const mutations = Object.freeze([
  {
    label: "omit-event-driven-kick",
    file: workerFile,
    from: "return scheduler!(request);",
    to: "return Promise.resolve();",
    pattern: "AC3: ten paced commits converge through kicks",
    reason: "the cron-disabled convergence proof must fail when the kick is omitted",
  },
  {
    label: "cron-bypasses-single-flight-scheduler",
    file: workerFile,
    from: `    scheduleMeetingRoomSafeLaneKick(
      env as MeetingRoomCloudflareEnv,
      serviceId,
      ctx,
      (passEnv, passServiceId, request) => runMeetingRoomSafeLanePass(passEnv, passServiceId, "cron", coverage, request),
      undefined,
      "cron",
    );`,
    to: `    await runMeetingRoomSafeLanePass(env, serviceId, "cron", coverage);`,
    pattern: "AC1: cron and Queue kicks share one effective single-flight scheduler",
    reason: "cron must enter the same single-flight scheduler as Queue and fence-expiry triggers",
  },
  {
    label: "reuse-first-coalesced-owner",
    file: schedulerFile,
    from: "        const runRequest = state.pendingRequest;",
    to: "        const runRequest = request;",
    pattern: "AC1: concurrent kicks",
    reason: "a coalesced delivery must own the effective follow-up pass",
  },
  {
    label: "advance-under-block-frontier",
    file: workerFile,
    from: "    // The caller has just completed this tick's scanner. A FULL/SETTLED\n    // frontier is therefore immediately eligible; a BLOCK frontier is the\n    // last proven cursor retained by the reconciler and remains fenced.\n    await input.catchUp(coverage.frontierSuid);",
    to: "    // The caller has just completed this tick's scanner. A FULL/SETTLED\n    // frontier is therefore immediately eligible; a BLOCK frontier is the\n    // last proven cursor retained by the reconciler and remains fenced.\n    await input.catchUp();",
    pattern: "AC2: a kicked BLOCK/UNSETTLED pass uses only the retained proven frontier",
    reason: "BLOCK/UNSETTLED must remain fenced to the retained proven frontier",
  },
  {
    label: "await-queue-kick-hook",
    file: adapterFile,
    from: "            options.afterStoredQueueDelivery?.({ message: queued.body, result: outcome });",
    to: "            await options.afterStoredQueueDelivery?.({ message: queued.body, result: outcome });",
    pattern: "AC1: Queue kick hook is notification-only",
    reason: "Queue acknowledgement must not await safe-lane work",
  },
  {
    label: "omit-effective-queue-safe-catch-up",
    file: workerFile,
    from: "    // The caller has just completed this tick's scanner. A FULL/SETTLED\n    // frontier is therefore immediately eligible; a BLOCK frontier is the\n    // last proven cursor retained by the reconciler and remains fenced.\n    await input.catchUp(coverage.frontierSuid);\n    await input.drainUnsafeKicks(coverage.frontierSuid);",
    to: "    // The caller has just completed this tick's scanner. A FULL/SETTLED\n    // frontier is therefore immediately eligible; a BLOCK frontier is the\n    // last proven cursor retained by the reconciler and remains fenced.\n    await input.drainUnsafeKicks(coverage.frontierSuid);\n    await input.drainUnsafeKicks(coverage.frontierSuid);",
    pattern: "AC4: cron-disabled Queue delivery reaches coverage, MV catch-up, and the public safe reader",
    reason: "Queue delivery must invoke the effective SafeWindow-fenced MV catch-up",
  },
  {
    label: "omit-fence-expiry-trigger",
    file: workerFile,
    from: "        await scheduleMeetingRoomSafeLaneFollowUp(env, serviceId, followUp);",
    to: "        await Promise.resolve();",
    pattern: "AC4: recent Queue delivery is retried at fence expiry",
    reason: "a recent delivery must schedule the bounded fence-expiry trigger",
  },
]);

function fail(message) {
  throw new Error(`SDT-G67 safe-lane check failed: ${message}`);
}

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function contains(value, expected, label) {
  if (!value.includes(expected)) fail(`${label} is missing ${JSON.stringify(expected)}`);
}

function replaceOnce(source, mutation) {
  const count = source.split(mutation.from).length - 1;
  if (count !== 1) fail(`${mutation.label} anchor expected once, found ${count}`);
  return source.replace(mutation.from, mutation.to);
}

function sourceSnapshot() {
  return {
    worker: read(workerFile),
    adapter: read(adapterFile),
    runtime: read(runtimeFile),
    scheduler: read(schedulerFile),
    test: read(testFile),
    migration: read(observationMigrationFile),
    fenceExpiryMigration: read(fenceExpiryMigrationFile),
  };
}

function assertContract(value) {
  contains(value.adapter, "afterStoredQueueDelivery", "Queue stored-delivery hook");
  contains(value.adapter, 'outcome.outcome === "stored"', "stored outcome gate");
  contains(value.adapter, 'failure.phase === "recordDelivery"', "recordDelivery failure exclusion");
  contains(value.adapter, "notification-only", "non-awaiting Queue hook contract");
  if (value.adapter.includes("await options.afterStoredQueueDelivery")) fail("Queue hook is awaited");
  contains(value.runtime, "afterStoredQueueDelivery", "runtime Queue hook option");
  contains(value.worker, "scheduleMeetingRoomSafeLaneKick", "sample Queue kick");
  contains(value.worker, "beforeLiveProjectionPoll: async ({ env, serviceId, ctx })", "cron scheduler context");
  contains(value.worker, 'runMeetingRoomSafeLanePass(passEnv, passServiceId, "cron", coverage, request)', "cron shared scheduler pass");
  contains(value.worker, "ctx.waitUntil", "non-blocking waitUntil boundary");
  contains(value.worker, 'owner === undefined ? "kick" : "delivery"', "default delivery pass trigger");
  contains(value.worker, "runPass: (runRequest) => pass(env, serviceId, runRequest)", "per-request pass context");
  contains(value.worker, "request.runPass(request)", "coalesced request runner");
  contains(value.worker, "new GlobalCompletenessReconciler(pipelineD1(env), tagBinding(env))", "fresh completeness scan");
  contains(value.worker, "reconciler.reconcile(serviceId", "kick scanner evaluation");
  contains(value.worker, "runMeetingRoomScheduledMaintenance", "shared scheduled pass body");
  contains(value.worker, "catchUp: effectiveCatchUp", "effective kicked catch-up callback");
  contains(value.worker, "catchUpStartedAt", "catch-up start attribution");
  contains(value.worker, "catchUpOutcome", "catch-up outcome attribution");
  contains(value.worker, "catchUpResultJson", "catch-up result attribution");
  contains(value.worker, "scheduleMeetingRoomSafeLaneFollowUp", "durable fence-expiry scheduling");
  contains(value.worker, "setAlarm", "Durable Object alarm");
  contains(value.worker, "stopDeadlineAt", "stop deadline attribution");
  contains(value.worker, "stopReason", "stop reason attribution");
  contains(value.worker, "suid: message.suid", "exact delivery SUID attribution");
  contains(value.worker, "status: \"scheduled\"", "durable kick scheduling status");
  contains(value.worker, "status: \"completed\"", "durable kick completion status");
  contains(value.worker, "Promise.resolve().then", "deferred waitUntil kick start");
  contains(value.scheduler, "state.rerun", "single-flight coalescing");
  contains(value.scheduler, "state.pendingRequest", "latest coalesced owner");
  contains(value.scheduler, "onIdle", "single-flight lifecycle cleanup");
  for (const title of [
    "AC1: invokes the kick hook",
    "AC1: Queue kick hook is notification-only",
    "AC1: concurrent kicks",
    "AC1: cron and Queue kicks share one effective single-flight scheduler",
    "AC2: a kicked BLOCK/UNSETTLED pass",
    "AC3: ten paced commits converge through kicks",
    "AC4: cron-disabled Queue delivery reaches coverage, MV catch-up, and the public safe reader",
    "AC4: cron-disabled Queue kick records the SafeWindow stop",
    "AC4: recent Queue delivery is retried at fence expiry",
    "coalesces the earliest fence deadline",
  ]) contains(value.test, title, `direct test ${title}`);
  contains(value.migration, "delivery_suid", "delivery SUID observation column");
  contains(value.migration, "catch_up_result_json", "catch-up observation column");
  contains(value.fenceExpiryMigration, "stop_deadline_at", "stop deadline observation column");
  contains(value.fenceExpiryMigration, "trigger_kind", "trigger provenance observation column");
}

function runVitest(pattern, label) {
  const result = spawnSync(process.execPath, [
    resolve(root, "node_modules/vitest/vitest.mjs"),
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
  };
}

function requirePass(result) {
  if (result.exitCode === 0) return;
  fail(`${result.label} unexpectedly failed (exit ${result.exitCode})`);
}

function runMutation(mutation) {
  const absolutePath = resolve(root, mutation.file);
  const original = read(mutation.file);
  const baseline = runVitest(mutation.pattern, `${mutation.label} baseline`);
  requirePass(baseline);
  let mutant;
  try {
    writeFileSync(absolutePath, replaceOnce(original, mutation), "utf8");
    mutant = runVitest(mutation.pattern, `${mutation.label} mutant`);
  } finally {
    writeFileSync(absolutePath, original, "utf8");
  }
  if (read(mutation.file) !== original) fail(`${mutation.label} source was not restored`);
  if (mutant.exitCode === 0) fail(`${mutation.label} unexpectedly stayed green: ${mutation.reason}`);
  return {
    label: mutation.label,
    oracle: `${testFile} :: ${mutation.pattern}`,
    baselineExitCode: baseline.exitCode,
    mutantExitCode: mutant.exitCode,
    result: "red",
  };
}

function main() {
  const value = sourceSnapshot();
  assertContract(value);
  for (const mutation of mutations) replaceOnce(read(mutation.file), mutation);
  if (process.argv.includes("--self-test")) {
    process.stdout.write(`${JSON.stringify({ check: "g67-safe-lane", mutants: mutations.map(({ label }) => ({ label, result: "anchor-pass" })) })}\n`);
    return;
  }
  const baseline = runVitest(
    "AC1: invokes the kick hook|AC1: concurrent kicks|AC1: cron and Queue kicks share one effective single-flight scheduler|AC2: a kicked BLOCK/UNSETTLED pass|AC3: ten paced commits converge through kicks|AC4: cron-disabled Queue delivery reaches coverage, MV catch-up, and the public safe reader|AC4: cron-disabled Queue kick records the SafeWindow stop",
    "G67 direct baseline",
  );
  requirePass(baseline);
  const rows = mutations.map(runMutation);
  process.stdout.write(`${JSON.stringify({ check: "g67-safe-lane", baselineExitCode: baseline.exitCode, mutants: rows })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
