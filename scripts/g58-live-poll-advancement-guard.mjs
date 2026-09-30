#!/usr/bin/env node
/**
 * SDT-G58 W112 live-projector advancement guard.
 *
 * W112's immutable deployed receipt is a red witness for a second AC5 seam:
 * scheduled polling was observable for both projectors, but the serial
 * tag/projector walk remained in progress across every cron observation and
 * neither live head advanced.  The repaired runtime uses a bounded pool for
 * independent identities.  This guard keeps the receipt intact, checks the
 * pool/fence contracts, and proves that removing the pool is red-capable.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const receiptPath = ".artifacts/sdt-g58-w112-paced-cohort.json";
const reportPath = ".artifacts/ci-local/g58-live-poll-advancement.json";
const projectionPath = "packages/dcb-runtime/src/projection/ProjectionRuntime.ts";
const testPath = "test/g58-live-poll-advancement-repair.spec.ts";

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function fail(message) {
  throw new Error(`SDT-G58 W112 live-poll advancement guard failed: ${message}`);
}

function contains(source, expected, label) {
  if (!source.includes(expected)) fail(`${label} is missing ${JSON.stringify(expected)}`);
}

function receiptFacts() {
  let receipt;
  try {
    receipt = JSON.parse(read(receiptPath));
  } catch (error) {
    fail(`immutable W112 receipt is unreadable: ${String(error)}`);
  }
  if (receipt.schema !== "sdt-g58-safe-lane-e2e/v1") fail("W112 receipt schema changed");
  if (receipt.status !== "failed") fail(`W112 red receipt status changed: ${String(receipt.status)}`);
  if (receipt.runId !== "6ad7bb99-ff63-4e8a-aa44-42487c652890") fail("W112 run identity changed");
  if (!Array.isArray(receipt.reservations) || receipt.reservations.length !== 10) {
    fail(`W112 must retain ten paced reservations, found ${receipt.reservations?.length ?? "none"}`);
  }
  if (!Array.isArray(receipt.healthSnapshots) || receipt.healthSnapshots.length !== 19) {
    fail(`W112 must retain all 19 health snapshots, found ${receipt.healthSnapshots?.length ?? "none"}`);
  }
  if (typeof receipt.failure !== "string" || !receipt.failure.includes("safe lane or live projections did not reach")) {
    fail("W112 failure no longer records the live-head bounded stop");
  }
  const groups = receipt.scheduledPollLifecycle;
  if (!Array.isArray(groups) || groups.length !== 3) fail("W112 must retain three distinct scheduled coverage groups");
  for (const group of groups) {
    if (!Number.isSafeInteger(group.observedAt)) fail("scheduled group omitted observedAt");
    if (!Array.isArray(group.projectors) || group.projectors.length !== 2) {
      fail(`scheduled group ${String(group.observedAt)} omitted one of the two projectors`);
    }
    for (const projectorId of ["RoomProjector", "ReservationProjector"]) {
      const projector = group.projectors.find((candidate) => candidate.projectorId === projectorId);
      if (projector === undefined) fail(`scheduled group omitted ${projectorId}`);
      if (projector.outcome !== "invoked-but-no-work" || projector.reason !== "poll_in_progress") {
        fail(`${projectorId} W112 red outcome changed: ${JSON.stringify(projector)}`);
      }
      if (!Number.isSafeInteger(projector.attemptedAt)) fail(`${projectorId} omitted its attempted timestamp`);
    }
  }
  for (const reservation of receipt.reservations) {
    if (typeof reservation.suid !== "string" || typeof reservation.commit?.receivedAtMs !== "number") {
      fail(`reservation ${String(reservation.ordinal)} lost its durable command receipt`);
    }
    if (reservation.unsafe?.disposition !== "miss") {
      fail(`reservation ${String(reservation.ordinal)} no longer records the delegated unsafe miss`);
    }
  }
  return {
    runId: receipt.runId,
    reservations: receipt.reservations.length,
    healthSnapshots: receipt.healthSnapshots.length,
    scheduledGroups: groups.map((group) => ({
      observedAt: group.observedAt,
      coverage: group.coverage,
      projectors: group.projectors,
    })),
    failure: receipt.failure,
  };
}

function sourceContracts(projection, test) {
  contains(projection, "export const MAX_LIVE_PROJECTION_CONCURRENCY = 8;", "bounded live-poll pool size");
  contains(projection, "const jobs: Array<{ readonly tag: string; readonly projector: string }> = [];", "independent poll jobs");
  contains(projection, "const worker = async (): Promise<void> => {", "bounded poll worker");
  contains(projection, "const workerCount = Math.min(MAX_LIVE_PROJECTION_CONCURRENCY, jobs.length);", "bounded worker count");
  contains(projection, "await Promise.all(Array.from({ length: workerCount }, () => worker()));", "concurrent bounded execution");
  contains(projection, "results[index] = await this.catchUp", "stable result placement");
  contains(projection, "options.maximumSuid === null", "retained-frontier null fence");
  contains(projection, "compareSuid(event.suid, options.maximumSuid) > 0", "retained-frontier high-water fence");
  contains(projection, "Stop at the first unsafe source event", "first-unsafe barrier");
  contains(test, "RoomProjector", "RoomProjector fixture");
  contains(test, "ReservationProjector", "ReservationProjector fixture");
  contains(test, 'new ProjectorRegistry([projector("RoomProjector"), projector("ReservationProjector")])', "both-projector registry fixture");
  contains(test, "maximumConcurrentReads", "concurrency witness");
  contains(test, "toBeGreaterThan(1)", "parallelism assertion");
}

function mutationSelfTest(projection, test) {
  let poolRed = false;
  try {
    sourceContracts(
      projection.replace(
        "await Promise.all(Array.from({ length: workerCount }, () => worker()));",
        "await worker();",
      ),
      test,
    );
  } catch {
    poolRed = true;
  }
  if (!poolRed) fail("serial poll mutation did not turn the advancement guard red");

  let widthRed = false;
  try {
    sourceContracts(projection.replace("MAX_LIVE_PROJECTION_CONCURRENCY = 8", "MAX_LIVE_PROJECTION_CONCURRENCY = 1"), test);
  } catch {
    widthRed = true;
  }
  if (!widthRed) fail("unbounded/serial pool width mutation did not turn the guard red");

  let projectorRed = false;
  try {
    sourceContracts(projection, test.replace('new ProjectorRegistry([projector("RoomProjector"), projector("ReservationProjector")])', 'new ProjectorRegistry([projector("RoomProjector")])'));
  } catch {
    projectorRed = true;
  }
  if (!projectorRed) fail("single-projector fixture mutation did not turn the guard red");
  return { serialPoolRemovalRed: poolRed, poolWidthMutationRed: widthRed, projectorCoverageRemovalRed: projectorRed };
}

function runFocusedTest() {
  const result = spawnSync("npm", ["exec", "vitest", "run", "--config", "vitest.config.ts", testPath], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  if (result.status !== 0) {
    fail(`focused advancement test failed with exit ${String(result.status)}: ${(result.stderr || result.stdout || "").slice(-4000)}`);
  }
  return {
    command: `npm exec vitest run --config vitest.config.ts ${testPath}`,
    exitCode: result.status,
    stdoutBytes: Buffer.byteLength(result.stdout ?? ""),
    stderrBytes: Buffer.byteLength(result.stderr ?? ""),
  };
}

function selfTest() {
  const projection = read(projectionPath);
  const test = read(testPath);
  sourceContracts(projection, test);
  const mutations = mutationSelfTest(projection, test);
  process.stdout.write(`${JSON.stringify({ selfTest: "g58-w112-live-poll-advancement-red-capable", mutations })}\n`);
}

function main() {
  const receipt = receiptFacts();
  const projection = read(projectionPath);
  const test = read(testPath);
  sourceContracts(projection, test);
  const mutations = mutationSelfTest(projection, test);
  const focused = runFocusedTest();
  const report = {
    schema: "sdt-g58-w112-live-poll-advancement/v1",
    status: "green",
    task: "SDT-G58-LIVE-POLL-DEPLOYED-AC5-W112",
    immutableRedReceipt: { path: receiptPath, ...receipt },
    diagnosis: "serial all-tag/projector catch-up remained in progress across cron ticks; independent identities now use a bounded worker pool",
    repair: {
      maxConcurrency: 8,
      semantics: "per-identity catchUp, CAS, first-unsafe barrier, maximumSuid fence, and result ordering are unchanged",
    },
    mutationRed: mutations,
    focusedTest: focused,
    bounds: { unsafeBoundMs: 5000, safeWindowFloorMs: 20000, safeWindowCeilingMs: 120000, noTokenContents: true },
  };
  mkdirSync(resolve(root, ".artifacts/ci-local"), { recursive: true });
  writeFileSync(resolve(root, reportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ guard: "g58-w112-live-poll-advancement", status: "green", report: reportPath })}\n`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
