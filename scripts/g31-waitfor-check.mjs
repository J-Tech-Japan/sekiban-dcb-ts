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
  required(queryWorker, "export const D1_WAIT_MAX_ITERATIONS = 126", "deadline-preserving iteration cap");
  required(queryWorker, "export const D1_WAIT_MAX_POINT_READS = 254", "point-read budget");
  required(waitCore, "readWaitForTarget", "unique source target lookup");
  required(waitCore, "readWaitForState", "generation-bound MV state lookup");
  required(waitCore, "target.kind === \"unavailable\"", "incident-before-success gate");
  required(waitLoop, "const deadline = requestStartedAt + safeWindowMs(dynamicLagBoundMs)", "absolute request deadline");
  required(waitLoop, "const confirmed = await probe()", "success recheck");
  required(waitLoop, "safeWindowCeilingExceeded(dynamicLagBoundMs)", "safe-window timeout gate");
  required(queryWorker, "Math.min(iteration, 6)", "1000ms backoff cap");
  required(waitLoop, "sleepToD1WaitDeadline", "read-cap deadline preservation");
  required(waitLoop, "if (now() > deadline) return \"timeout\"", "no post-deadline probe");
  const ceilingGate = waitLoop.indexOf("if (safeWindowCeilingExceeded(dynamicLagBoundMs)) return \"timeout\"");
  const successGate = waitLoop.indexOf("if (d1WaitSucceeded(facts))");
  if (ceilingGate < 0 || successGate < 0 || ceilingGate > successGate) {
    throw new Error("SDT-G31 ceiling must fail closed after incident gating and before success");
  }
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

  const waitFixture = text("test/g31-waitfor.spec.ts");
  required(waitFixture, "records an active-generation wait receipt for stored no-change", "no-change receipt fixture");
  required(waitFixture, "records an active-generation wait receipt for stored patch-not-found", "patch-not-found receipt fixture");
  required(waitFixture, "records an active-generation wait receipt for stored delete-without-row", "delete-without-row receipt fixture");
  required(waitFixture, "fails a non-stored SUID collision", "SUID collision fixture");
  required(waitFixture, "fails a non-stored lineage mismatch", "lineage mismatch fixture");
  required(waitFixture, "rechecks a real D1 rebuild-required", "mid-wait rebuild fixture");
  required(waitFixture, "rechecks a real D1 target poison", "mid-wait poison fixture");
  required(waitFixture, "actual D1 statement and rows-read budgets", "actual D1 SQL budget fixture");
  required(waitFixture, "keeps 503 projection_unavailable status, code, and exact keys", "503 wire fixture");
  console.log(JSON.stringify({
    task: "SDT-G31",
    wait: "indexed source + generation-bound MV point reads",
    budget: { maxIterationSlots: 126, maxPointReads: 254 },
    sample: "one newest-first server wait list refresh",
  }, null, 2));
}

main();
