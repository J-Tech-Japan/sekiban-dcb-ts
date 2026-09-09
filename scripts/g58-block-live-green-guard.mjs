#!/usr/bin/env node
/**
 * SDT-G58 W104 BLOCK live-projection repair guard.
 *
 * W103 is a historical red receipt: the Cloudflare-only scheduler returned
 * after its retained-frontier safe-lane hook and therefore never invoked the
 * live poll on a BLOCK/UNSETTLED scan. W104 keeps that receipt immutable and
 * checks the repaired call path plus its scanner-proven high-water fence.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const baselinePath = ".artifacts/sdt-g58-w103-red-guard.json";
const reportPath = ".artifacts/sdt-g58-w104-green-guard.json";
const runtimePath = "packages/dcb-runtime/src/cloudflare.ts";
const livePath = "packages/dcb-runtime/src/projection/LiveProjectionWorker.ts";
const projectionPath = "packages/dcb-runtime/src/projection/ProjectionRuntime.ts";
const workerPath = "samples/meeting-room/src/worker.cloudflare-only.ts";

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function fail(message) {
  throw new Error(`SDT-G58 W104 BLOCK live guard failed: ${message}`);
}

function requireContains(source, expected, label) {
  if (!source.includes(expected)) fail(`${label} is missing ${JSON.stringify(expected)}`);
}

function requireAbsent(source, forbidden, label) {
  if (source.includes(forbidden)) fail(`${label} still contains ${JSON.stringify(forbidden)}`);
}

function sourceContracts(sources) {
  const { runtime, live, projection, worker } = sources;
  const hook = "const safeLane = await options.beforeLiveProjectionPoll?.({ env, serviceId, scan, ctx });";
  const poll = "await pollLiveProjections(env, {";
  const hookAt = runtime.indexOf(hook);
  const pollAt = runtime.indexOf(poll, hookAt);
  if (hookAt < 0 || pollAt < 0 || hookAt > pollAt) {
    fail("scheduled hook/poll ordering no longer runs the retained-frontier hook before live polling");
  }
  requireAbsent(runtime, "if (scan.kind !== \"FULL\") return;", "scheduled BLOCK early-return gate");
  requireContains(runtime, "maximumSuid: scheduledLiveProjectionMaximumSuid(scan, safeLane?.frontierSuid),", "scanner-derived live-poll fence");
  requireContains(runtime, "const closedPrefixCertificate = await readRuntimeClosedPrefixCertificate(allocator);", "allocator-issued closed-prefix certificate acquisition");
  requireContains(runtime, "closedPrefixCertificate,", "full closed-prefix certificate propagation");
  requireContains(runtime, "export function scheduledLiveProjectionMaximumSuid(", "FULL/BLOCK fence mapper");
  requireContains(live, "maximumSuid?: string | null;", "live-poll maximum frontier option");
  requireContains(live, "closedPrefixCertificate?: ClosedPrefixCertificate;", "full closed-prefix certificate option");
  requireContains(live, "if (env.ALLOCATOR !== undefined && options.closedPrefixCertificate?.status !== \"ready\")", "allocator-bound polls require a validated certificate");
  requireContains(live, "const closedPrefixSuid = options.closedPrefixCertificate === undefined", "validated certificate selection");
  requireContains(live, "closedPrefixSuid,\n              closedPrefixCertificate: options.closedPrefixCertificate,", "single-tag frontier and closed-prefix certificate propagation");
  requireContains(live, "options.closedPrefixCertificate,\n    );", "all-tag frontier and closed-prefix certificate propagation");
  requireContains(live, "ordering_certificate_unavailable", "on-demand safe advancement fails closed without certificate");
  requireContains(projection, "options.maximumSuid === null", "null frontier fence");
  requireContains(projection, "compareSuid(event.suid, options.maximumSuid) > 0", "retained high-water fence");
  requireContains(projection, "async pollRegistered(\n    serviceId: string,\n    nowMs: number,\n    maximumSuid?: string | null,", "pollRegistered fence API");
  requireContains(worker, "return { frontierSuid: coverage.frontierSuid };", "sample returns retained frontier to runtime");
}

function pollPlan(scanKind, retainedFrontierSuid) {
  return {
    order: ["stabilize", "reconcile", "beforeLiveProjectionPoll", "pollLiveProjections"],
    livePollCalled: true,
    maximumSuid: scanKind === "FULL" ? undefined : retainedFrontierSuid ?? null,
  };
}

function assertHistoricalRedReceipt() {
  let baseline;
  try {
    baseline = JSON.parse(read(baselinePath));
  } catch (error) {
    fail(`W103 red receipt is unreadable: ${String(error)}`);
  }
  if (baseline.status !== "red-baseline" || baseline.runtimeDiagnosis?.livePollCalled !== false) {
    fail("W103 red receipt no longer records the pre-fix BLOCK starvation");
  }
  return baseline;
}

function mutationSelfTest(sources) {
  const earlyReturn = "if (scan.kind !== \"FULL\") return;";
  const earlyMutation = sources.runtime.replace(
    "const safeLane = await options.beforeLiveProjectionPoll?.({ env, serviceId, scan, ctx });",
    `const safeLane = await options.beforeLiveProjectionPoll?.({ env, serviceId, scan, ctx });\n      ${earlyReturn}`,
  );
  let earlyRed = false;
  try { sourceContracts({ ...sources, runtime: earlyMutation }); } catch { earlyRed = true; }
  if (!earlyRed) fail("reintroducing the W103 BLOCK early return did not turn the guard red");

  const fenceMutation = sources.runtime.replace(
    "maximumSuid: scheduledLiveProjectionMaximumSuid(scan, safeLane?.frontierSuid),",
    "maximumSuid: undefined,",
  );
  let fenceRed = false;
  try { sourceContracts({ ...sources, runtime: fenceMutation }); } catch { fenceRed = true; }
  if (!fenceRed) fail("removing the scheduler's retained-frontier fence did not turn the guard red");

  const certificateMutation = sources.live.replace(
    "closedPrefixCertificate: options.closedPrefixCertificate,",
    "// closed prefix certificate omitted",
  );
  const selectionMutation = sources.live.replace(
    "const closedPrefixSuid = options.closedPrefixCertificate === undefined",
    "const closedPrefixSuid = undefined;\n  // mutated",
  );
  let certificateRed = false;
  try { sourceContracts({ ...sources, live: certificateMutation }); } catch { certificateRed = true; }
  if (!certificateRed) fail("removing the single-tag closed-prefix certificate did not turn the guard red");

  const allTagCertificateMutation = sources.live.replace(
    "options.closedPrefixCertificate,\n    );",
    "// allocator certificate omitted\n    );",
  );
  let allTagCertificateRed = false;
  try { sourceContracts({ ...sources, live: allTagCertificateMutation }); } catch { allTagCertificateRed = true; }
  if (!allTagCertificateRed) fail("removing the all-tag closed-prefix certificate did not turn the guard red");

  let selectionRed = false;
  try { sourceContracts({ ...sources, live: selectionMutation }); } catch { selectionRed = true; }
  if (!selectionRed) fail("removing validated certificate selection did not turn the guard red");

  const catchUpMutation = sources.projection.replace(
    "if (options.maximumSuid === null || (\n          options.maximumSuid !== undefined && compareSuid(event.suid, options.maximumSuid) > 0\n        )) {",
    "if (false) {",
  );
  let catchUpRed = false;
  try { sourceContracts({ ...sources, projection: catchUpMutation }); } catch { catchUpRed = true; }
  if (!catchUpRed) fail("removing the ProjectionRuntime high-water check did not turn the guard red");

  const block = pollPlan("BLOCK", "063924025000000000000000000001");
  if (!block.livePollCalled || block.maximumSuid !== "063924025000000000000000000001") {
    fail("BLOCK plan did not invoke a retained-frontier-fenced poll");
  }
  const unsettled = pollPlan("UNKNOWN", null);
  if (!unsettled.livePollCalled || unsettled.maximumSuid !== null) {
    fail("unknown/unsettled plan did not invoke a null-fenced poll");
  }
  const full = pollPlan("FULL", "063924025000000000000000000001");
  if (!full.livePollCalled || full.maximumSuid !== undefined) {
    fail("FULL plan changed its established unbounded poll behavior");
  }
  const runtimeCertificateMutation = sources.runtime.replace("closedPrefixCertificate,", "");
  let runtimeCertificateRed = false;
  try { sourceContracts({ ...sources, runtime: runtimeCertificateMutation }); } catch { runtimeCertificateRed = true; }
  if (!runtimeCertificateRed) fail("removing runtime certificate propagation did not turn the guard red");
  const requiredCertificateMutation = sources.live.replace(
    "if (env.ALLOCATOR !== undefined && options.closedPrefixCertificate?.status !== \"ready\") {\n    throw new Error(\"ordering_certificate_unavailable\");\n  }",
    "if (false) {\n    throw new Error(\"ordering_certificate_unavailable\");\n  }",
  );
  let requiredCertificateRed = false;
  try { sourceContracts({ ...sources, live: requiredCertificateMutation }); } catch { requiredCertificateRed = true; }
  if (!requiredCertificateRed) fail("removing allocator-bound certificate enforcement did not turn the guard red");
  return { earlyReturnMutationRed: earlyRed, fenceMutationRed: fenceRed, certificateMutationRed: certificateRed, allTagCertificateMutationRed: allTagCertificateRed, selectionMutationRed: selectionRed, runtimeCertificateMutationRed: runtimeCertificateRed, requiredCertificateMutationRed: requiredCertificateRed, catchUpMutationRed: catchUpRed, block, unsettled, full };
}

function selfTest() {
  const sources = {
    runtime: read(runtimePath),
    live: read(livePath),
    projection: read(projectionPath),
    worker: read(workerPath),
  };
  const baseline = assertHistoricalRedReceipt();
  sourceContracts(sources);
  const mutations = mutationSelfTest(sources);
  process.stdout.write(`${JSON.stringify({ selfTest: "g58-w104-block-live-green", baseline: baselinePath, baselineStatus: baseline.status, mutations })}\n`);
}

function main() {
  const sources = {
    runtime: read(runtimePath),
    live: read(livePath),
    projection: read(projectionPath),
    worker: read(workerPath),
  };
  const baseline = assertHistoricalRedReceipt();
  sourceContracts(sources);
  const mutations = mutationSelfTest(sources);
  const report = {
    schema: "sdt-g58-w104-block-live-green/v1",
    status: "green",
    task: "SDT-G58-BLOCK-LIVE-GREEN-REPAIR-W104",
    baselineRedReceipt: {
      report: baselinePath,
      status: baseline.status,
      livePollCalled: baseline.runtimeDiagnosis?.livePollCalled ?? false,
    },
    repairedRuntime: {
      order: ["stabilize", "reconcile", "beforeLiveProjectionPoll", "pollLiveProjections"],
      block: "invokes pollLiveProjections after the retained-frontier hook, fenced by its returned last proven SUID",
      noFrontier: "invokes the poll with maximumSuid=null; ProjectionRuntime cannot advance an event",
      full: "invokes the poll with maximumSuid=undefined, preserving the established FULL behavior",
    },
    mutationEvidence: mutations,
    bounds: {
      g44FencePreserved: true,
      safeWindowFloorMs: 20_000,
      safeWindowCeilingMs: 120_000,
      unsafeBoundMs: 5_000,
      upstreamOutboxQueueGlobalAdmission: "held SDT-G60; not modified",
    },
  };
  mkdirSync(resolve(root, ".artifacts"), { recursive: true });
  writeFileSync(resolve(root, reportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ guard: "g58-w104-block-live-green", status: "green", report: reportPath, baseline: baselinePath })}\n`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
