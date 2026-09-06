#!/usr/bin/env node
/** SDT-G67 local safe-lane kick and frontier guard. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const workerFile = "samples/meeting-room/src/worker.cloudflare-only.ts";
const adapterFile = "packages/dcb-runtime/src/downstream/DownstreamAdapter.ts";
const runtimeFile = "packages/dcb-runtime/src/cloudflare.ts";
const schedulerFile = "samples/meeting-room/src/safe-lane-kick.ts";
const testFile = "test/g67-safe-lane.spec.ts";
const observationMigrationFile = "migrations/d1/g32/0013_g67_safe_lane_catch_up_observations.sql";
const fenceExpiryMigrationFile = "migrations/d1/g32/0014_g67_safe_lane_fence_expiry.sql";
const redReceipt = "test/fixtures/g67-red-before-green.json";
const greenReceipt = "test/fixtures/g67-green.json";
const mutantReceipt = "test/fixtures/g67-mutants-red.json";

const mutations = Object.freeze([
  {
    name: "omit-event-driven-kick",
    file: workerFile,
    from: "return scheduler!(request);",
    to: "return Promise.resolve();",
    pattern: "AC3: ten paced commits converge through kicks",
    reason: "local cron-disabled proof must fail when the kick is omitted",
  },
  {
    name: "cron-bypasses-single-flight-scheduler",
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
    reason: "cron must enter the same single-flight/coalescing scheduler as Queue and fence-expiry triggers",
  },
  {
    name: "reuse-first-coalesced-owner",
    file: schedulerFile,
    from: "        const runRequest = state.pendingRequest;",
    to: "        const runRequest = request;",
    pattern: "AC1: concurrent kicks",
    reason: "a coalesced Queue delivery must own the effective follow-up pass",
  },
  {
    name: "advance-under-block-frontier",
    file: workerFile,
    from: "    // The caller has just completed this tick's scanner. A FULL/SETTLED\n    // frontier is therefore immediately eligible; a BLOCK frontier is the\n    // last proven cursor retained by the reconciler and remains fenced.\n    await input.catchUp(coverage.frontierSuid);",
    to: "    // The caller has just completed this tick's scanner. A FULL/SETTLED\n    // frontier is therefore immediately eligible; a BLOCK frontier is the\n    // last proven cursor retained by the reconciler and remains fenced.\n    await input.catchUp();",
    pattern: "AC2: a kicked BLOCK/UNSETTLED pass uses only the retained proven frontier",
    reason: "BLOCK/UNSETTLED must remain fenced to the retained proven frontier",
  },
  {
    name: "await-queue-kick-hook",
    file: adapterFile,
    from: "            options.afterStoredQueueDelivery?.({ message: queued.body, result: outcome });",
    to: "            await options.afterStoredQueueDelivery?.({ message: queued.body, result: outcome });",
    pattern: "AC1: Queue kick hook is notification-only",
    reason: "Queue acknowledgement and the public commit path must not await safe-lane work",
  },
  {
    name: "omit-effective-queue-safe-catch-up",
    file: workerFile,
    from: "    // The caller has just completed this tick's scanner. A FULL/SETTLED\n    // frontier is therefore immediately eligible; a BLOCK frontier is the\n    // last proven cursor retained by the reconciler and remains fenced.\n    await input.catchUp(coverage.frontierSuid);\n    await input.drainUnsafeKicks(coverage.frontierSuid);",
    to: "    // The caller has just completed this tick's scanner. A FULL/SETTLED\n    // frontier is therefore immediately eligible; a BLOCK frontier is the\n    // last proven cursor retained by the reconciler and remains fenced.\n    await input.drainUnsafeKicks(coverage.frontierSuid);\n    await input.drainUnsafeKicks(coverage.frontierSuid);",
    pattern: "AC4: cron-disabled Queue delivery reaches coverage, MV catch-up, and the public safe reader",
    reason: "Queue delivery must invoke the effective SafeWindow-fenced MV catch-up before the cron backstop",
  },
  {
    name: "omit-fence-expiry-trigger",
    file: workerFile,
    from: "        await scheduleMeetingRoomSafeLaneFollowUp(env, serviceId, followUp);",
    to: "        await Promise.resolve();",
    pattern: "AC4: recent Queue delivery is retried at fence expiry",
    reason: "a recent delivery must schedule the bounded fence-expiry trigger",
  },
]);

function fail(message) {
  throw new Error(`SDT-G67 safe-lane guard failed: ${message}`);
}

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function requireContains(value, expected, label) {
  if (!value.includes(expected)) fail(`${label} is missing ${JSON.stringify(expected)}`);
}

function mutate(source, mutation) {
  const count = source.split(mutation.from).length - 1;
  if (count !== 1) fail(`${mutation.name} anchor expected once, found ${count}`);
  return source.replace(mutation.from, mutation.to);
}

function runVitest(pattern, label) {
  const args = [
    resolve(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config", "vitest.config.ts",
    "--no-cache",
    "--maxWorkers=1",
    testFile,
    "--testNamePattern", pattern,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  return {
    label,
    command: [process.execPath, ...args].join(" "),
    exitCode: result.status ?? 1,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function writeReceipt(path, value) {
  const target = resolve(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
  requireContains(value.adapter, "afterStoredQueueDelivery", "Queue stored-delivery hook");
  requireContains(value.adapter, 'outcome.outcome === "stored"', "stored outcome gate");
  requireContains(value.adapter, 'failure.phase === "recordDelivery"', "recordDelivery failure exclusion");
  requireContains(value.adapter, "notification-only", "non-awaiting Queue hook contract");
  if (value.adapter.includes("await options.afterStoredQueueDelivery")) fail("Queue hook is awaited");
  requireContains(value.runtime, "afterStoredQueueDelivery", "runtime Queue hook option");
  requireContains(value.worker, "scheduleMeetingRoomSafeLaneKick", "sample Queue kick");
  requireContains(value.worker, "beforeLiveProjectionPoll: async ({ env, serviceId, ctx })", "cron scheduler context");
  requireContains(value.worker, 'runMeetingRoomSafeLanePass(passEnv, passServiceId, "cron", coverage, request)', "cron shared scheduler pass");
  requireContains(value.worker, "ctx.waitUntil", "non-blocking waitUntil boundary");
  requireContains(value.worker, 'owner === undefined ? "kick" : "delivery"', "default delivery pass trigger");
  requireContains(value.worker, "new GlobalCompletenessReconciler(env.D1, env.TAG)", "fresh G44 reconciler");
  requireContains(value.worker, "reconciler.reconcile(serviceId", "kick scanner evaluation");
  requireContains(value.worker, "runMeetingRoomScheduledMaintenance", "shared cron/kick pass body");
  requireContains(value.worker, "catchUp: effectiveCatchUp", "effective kicked catch-up callback");
  requireContains(value.worker, "catchUpStartedAt", "catch-up start attribution");
  requireContains(value.worker, "catchUpOutcome", "catch-up outcome attribution");
  requireContains(value.worker, "catchUpResultJson", "catch-up result attribution");
  requireContains(value.worker, "scheduleMeetingRoomSafeLaneFollowUp", "durable fence-expiry scheduling");
  requireContains(value.worker, "setAlarm", "Durable Object alarm");
  requireContains(value.worker, "stopDeadlineAt", "stop deadline attribution");
  requireContains(value.worker, "stopReason", "stop reason attribution");
  requireContains(value.worker, "suid: message.suid", "exact Queue delivery SUID attribution");
  requireContains(value.worker, "status: \"scheduled\"", "durable kick scheduling receipt");
  requireContains(value.worker, "status: \"completed\"", "durable kick completion receipt");
  requireContains(value.worker, "Promise.resolve().then", "deferred waitUntil kick start");
  requireContains(value.scheduler, "state.rerun", "single-flight coalescing");
  requireContains(value.scheduler, "state.pendingRequest", "latest coalesced owner");
  requireContains(value.scheduler, "onIdle", "single-flight lifecycle cleanup");
  requireContains(value.test, "AC1: invokes the kick hook", "Queue hook oracle");
  requireContains(value.test, "AC1: Queue kick hook is notification-only", "non-awaiting Queue hook oracle");
  requireContains(value.test, "AC1: concurrent kicks", "concurrent single-flight oracle");
  requireContains(value.test, "AC1: cron and Queue kicks share one effective single-flight scheduler", "cron shared scheduler oracle");
  requireContains(value.test, "AC2: a kicked BLOCK/UNSETTLED pass", "frontier fence oracle");
  requireContains(value.test, "AC3: ten paced commits converge through kicks", "cron-disabled local proof");
  requireContains(value.test, "AC4: cron-disabled Queue delivery reaches coverage, MV catch-up, and the public safe reader", "end-to-end safe handoff oracle");
  requireContains(value.test, "AC4: cron-disabled Queue kick records the SafeWindow stop", "SafeWindow delay oracle");
  requireContains(value.test, "AC4: recent Queue delivery is retried at fence expiry", "fence-expiry oracle");
  requireContains(value.test, "coalesces the earliest fence deadline", "alarm coalescing oracle");
  requireContains(value.migration, "delivery_suid", "exact delivery SUID observation column");
  requireContains(value.migration, "catch_up_result_json", "catch-up result observation column");
  requireContains(value.fenceExpiryMigration, "stop_deadline_at", "stop deadline observation column");
  requireContains(value.fenceExpiryMigration, "trigger_kind", "trigger provenance observation column");
}

function requirePass(result) {
  if (result.exitCode !== 0) fail(`${result.label} unexpectedly failed:\n${result.stdout}${result.stderr}`);
}

function requireRed(result, mutation) {
  if (result.exitCode === 0) fail(`${mutation.name} unexpectedly stayed green: ${mutation.reason}`);
}

function runMutation(mutation) {
  const path = resolve(root, mutation.file);
  const original = readFileSync(path, "utf8");
  try {
    writeFileSync(path, mutate(original, mutation), "utf8");
    const result = runVitest(mutation.pattern, `${mutation.name} mutant`);
    requireRed(result, mutation);
    return { ...mutation, ...result, status: "red" };
  } finally {
    writeFileSync(path, original, "utf8");
  }
}

function preFix() {
  const rows = mutations.map(runMutation);
  writeReceipt(redReceipt, {
    schema: "sdt-g67-red-before-green/v1",
    status: "red-before-green",
    expectedFailure: true,
    rows,
  });
  process.stdout.write(`${JSON.stringify({ result: "g67-red-before-green", redReceipt, rows })}\n`);
}

function green() {
  if (!existsSync(resolve(root, redReceipt))) fail(`missing preserved red receipt ${redReceipt}`);
  const prior = JSON.parse(read(redReceipt));
  if (prior.status !== "red-before-green" || prior.expectedFailure !== true) fail(`invalid red receipt ${redReceipt}`);
  const value = sourceSnapshot();
  assertContract(value);
  const greenResult = runVitest("AC1: invokes the kick hook|AC1: concurrent kicks|AC1: cron and Queue kicks share one effective single-flight scheduler|AC2: a kicked BLOCK/UNSETTLED pass|AC3: ten paced commits converge through kicks|AC4: cron-disabled Queue delivery reaches coverage, MV catch-up, and the public safe reader|AC4: cron-disabled Queue kick records the SafeWindow stop", "G67 local green oracles");
  requirePass(greenResult);
  const rows = mutations.map(runMutation);
  writeReceipt(greenReceipt, {
    schema: "sdt-g67-green/v1",
    status: "green",
    command: greenResult.command,
    exitCode: greenResult.exitCode,
    stdout: greenResult.stdout,
    stderr: greenResult.stderr,
    preservedRedReceipt: redReceipt,
    mutantReceipt,
  });
  writeReceipt(mutantReceipt, {
    schema: "sdt-g67-mutants-red/v1",
    status: "all-required-mutants-red",
    rows,
  });
  process.stdout.write(`${JSON.stringify({ result: "g67-green-and-mutants-red", greenReceipt, mutantReceipt, rows })}\n`);
}

function selfTest() {
  assertContract(sourceSnapshot());
  for (const mutation of mutations) mutate(read(mutation.file), mutation);
  process.stdout.write(`${JSON.stringify({ selfTest: "g67-anchors-unique", mutations: mutations.map(({ name }) => name) })}\n`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  if (process.argv.includes("--pre-fix")) return preFix();
  return green();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
