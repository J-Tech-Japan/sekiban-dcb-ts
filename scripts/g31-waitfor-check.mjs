#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();

function text(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function required(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`SDT-G31 required ${label} is missing`);
}

function scoped(source, start, end, label) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`SDT-G31 ${label} source boundary is missing`);
  return source.slice(from, to);
}

function main() {
  const queryWorker = text("packages/dcb-runtime/src/http/SerializedQueryWorker.ts");
  const waitCore = scoped(queryWorker, "async function readD1WaitFacts", "function endpointFromPath", "d1-mv wait core");
  const waitLoop = scoped(queryWorker, "async function waitForD1Projection", "async function waitForProjection", "d1-mv wait loop");
  required(queryWorker, "export const D1_WAIT_MAX_ITERATIONS = 125", "iteration cap");
  required(queryWorker, "export const D1_WAIT_MAX_POINT_READS = 252", "point-read budget");
  required(waitCore, "readWaitForTarget", "unique source target lookup");
  required(waitCore, "readWaitForState", "generation-bound MV state lookup");
  required(waitCore, "target.kind === \"unavailable\"", "incident-before-success gate");
  required(waitLoop, "const deadline = requestStartedAt + safeWindowMs(dynamicLagBoundMs)", "absolute request deadline");
  required(waitLoop, "const confirmed = await probe()", "success recheck");
  required(waitLoop, "safeWindowCeilingExceeded(dynamicLagBoundMs)", "safe-window timeout gate");
  if (waitCore.includes("readAllEvents") || waitLoop.includes("readAllEvents")) {
    throw new Error("SDT-G31 d1-mv waitFor must not revive a source history scan");
  }

  const sourceStore = text("packages/dcb-runtime/src/store/D1EventStore.ts");
  const sourceLookup = scoped(sourceStore, "async readWaitForTarget", "async currentLagBound", "source wait target lookup");
  required(sourceLookup, "LIMIT 2", "source collision cardinality bound");
  required(sourceLookup, "serialized_dcb_wait_target_incidents", "target incident alias table");
  if (sourceLookup.includes("readAllEvents")) throw new Error("SDT-G31 source target lookup must remain indexed");

  const mvStore = text("packages/dcb-runtime/src/mv/MaterializedViewStore.ts");
  const mvLookup = scoped(mvStore, "async readWaitForState", "async recordUnsafeFailureFinding", "MV wait state lookup");
  required(mvLookup, "mv_wait_receipts", "generation-definition receipt lookup");
  required(mvLookup, "mv_checkpoint_ahead_findings", "checkpoint finding lookup");
  required(mvLookup, "mv_unsafe_arrivals", "rebuild lookup");
  required(mvLookup, "mv_wait_target_poison", "generation-bound poison lookup");

  const pipelineMigration = text("migrations/d1/0003_g31_wait_target_incidents.sql");
  required(pipelineMigration, "serialized_dcb_wait_target_incidents_lookup_idx", "pipeline target index");
  const mvMigration = text("migrations/mv/0005_g31_wait_receipts.sql");
  required(mvMigration, "mv_wait_receipts_active_target_idx", "MV receipt target index");
  const poisonMigration = text("migrations/mv/0006_g31_wait_target_poison.sql");
  required(poisonMigration, "mv_wait_target_poison_active_target_idx", "MV poison target index");

  const application = text("samples/meeting-room/public/app.js");
  const refresh = scoped(application, "async function refreshReservationsAfterCommit", "async function loadReservations", "post-commit list refresh");
  required(refresh, "fetchReservationPage(1, { waitForSortableUniqueId: commitSuid })", "one server wait list request");
  required(refresh, "Use Refresh to read the latest list.", "504 manual refresh guidance");
  if (refresh.includes("setTimeout") || refresh.includes("observeProjection")) {
    throw new Error("SDT-G31 post-commit list refresh must not add browser polling");
  }

  const worker = text("samples/meeting-room/src/worker.cloudflare-only.ts");
  required(worker, "/conformance/v1/g31-config", "authenticated topology witness");
  required(worker, "/conformance/v1/g31-wait-state", "authenticated GC-state witness");
  required(worker, "waitForSortableUniqueId", "application-to-runtime wait propagation");
  console.log(JSON.stringify({
    task: "SDT-G31",
    wait: "indexed source + generation-bound MV point reads",
    budget: { maxIterations: 125, maxPointReads: 252 },
    sample: "one newest-first server wait list refresh",
  }, null, 2));
}

main();
