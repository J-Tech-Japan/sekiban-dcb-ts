#!/usr/bin/env node
/** SDT-G58 source contract for bounded safe-lane and live-projection health. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function fail(message) {
  throw new Error(`SDT-G58 safe-lane guard failed: ${message}`);
}

function requireContains(value, expected, label) {
  if (!value.includes(expected)) fail(`${label} is missing ${JSON.stringify(expected)}`);
}

function snapshot() {
  return {
    worker: read("samples/meeting-room/src/worker.cloudflare-only.ts"),
    mv: read("samples/meeting-room/src/d1-mv.ts"),
    catchUp: read("packages/dcb-runtime/src/mv/MaterializedViewCatchUp.ts"),
    completeness: read("packages/dcb-runtime/src/completeness/GlobalCompletenessReconciler.ts"),
    cloudflare: read("packages/dcb-runtime/src/cloudflare.ts"),
    diagnosis: read("test/g58-safe-lane-diagnosis.spec.ts"),
    diagnosisGuard: read("scripts/g58-safe-lane-diagnosis-guard.mjs"),
    test: read("test/g58-safe-lane.spec.ts"),
    mutation: read("scripts/g58-safe-lane-mutation-runner.mjs"),
    lagGuard: read("scripts/g58-lag-hygiene-guard.mjs"),
    cohortEvidenceGuard: read("scripts/g58-cohort-evidence-guard.mjs"),
    purgePlan: read("scripts/deploy/g58-ac4-retired-lag-purge.sql"),
    e2e: read("scripts/deploy/g58-safe-lane-e2e.mjs"),
    readProof: read("scripts/deploy/g58-ac1-ac5-readproof.mjs"),
    migration: read("migrations/d1/g32/0003_g58_safe_lane_health.sql"),
    packageJson: read("package.json"),
    ci: read(".github/workflows/ci.yml"),
  };
}

export function assertG58SafeLaneContract(value) {
  requireContains(value.worker, '"/conformance/v1/read-health"', "authenticated read-health route");
  requireContains(value.worker, '"/conformance/v1/internal/projection/lag"', "authenticated projection-lag relay");
  requireContains(value.worker, "await input.catchUp(coverage.frontierSuid);", "BLOCK bounded catch-up");
  requireContains(value.worker, "await input.drainUnsafeKicks(coverage.frontierSuid);", "BLOCK bounded unsafe drain");
  requireContains(value.worker, "recordMeetingRoomSafeLaneCoverage", "scheduled coverage persistence");
  requireContains(value.mv, "export async function readMeetingRoomHealth", "read-only health reader");
  requireContains(value.mv, "serialized_dcb_safe_lane_health", "scheduled health authority");
  requireContains(value.mv, "safeWindowCeilingExceeded", "lag ceiling observation");
  requireContains(value.catchUp, "options.maximumSuid === null", "no-frontier source hold");
  requireContains(value.catchUp, "compareSuid(event.suid, options.maximumSuid) > 0", "frontier fence");
  requireContains(value.completeness, "settledFrontierAtSnapshot", "FULL frontier calculation");
  requireContains(value.completeness, "sdt-g58-settled-frontier/v1", "frontier cursor schema");
  requireContains(value.completeness, "COALESCE(excluded.cursor_json", "prior FULL frontier retention");
  requireContains(value.cloudflare, "await pollLiveProjections", "scheduled live-projection poll");
  requireContains(value.cloudflare, "beforeLiveProjectionPoll", "fresh reconciliation safe-lane hook");
  requireContains(value.cloudflare, "await options.beforeLiveProjectionPoll?.", "fresh reconciliation hook invocation");
  requireContains(value.worker, "await runtime.scheduled?.(controller, env, ctx);", "direct runtime scheduled handoff");
  const freshHookIndex = value.cloudflare.lastIndexOf("await options.beforeLiveProjectionPoll?.");
  const pollIndex = value.cloudflare.lastIndexOf("await pollLiveProjections");
  if (freshHookIndex < 0 || pollIndex < 0 || freshHookIndex > pollIndex) {
    fail("fresh safe-lane hook must run before the live-projection poll");
  }
  requireContains(value.diagnosis, "W97 GREEN: applies a freshly scanned FULL frontier in the same scheduled tick", "green same-tick fixture");
  requireContains(value.diagnosis, "last proven frontier", "BLOCK frontier fixture");
  requireContains(value.diagnosisGuard, "sdt-g58-w97-green-guard/v1", "green diagnosis runner");
  requireContains(value.migration, "serialized_dcb_safe_lane_health", "operational health migration");
  requireContains(value.test, "continues a BLOCK tick through only the retained FULL frontier", "red-capable BLOCK fixture");
  requireContains(value.test, "returns the bearer-only health surface", "health authentication fixture");
  requireContains(value.test, "decays a retired lag estimate", "lag floor fixture");
  requireContains(value.test, "decayedLagEstimateMs", "lag decay function fixture");
  requireContains(value.lagGuard, "sdt-g58-ac4-lag-hygiene/v1", "lag hygiene mutation guard");
  requireContains(value.lagGuard, "estimateMs - elapsed", "linear lag decay mutant");
  requireContains(value.cohortEvidenceGuard, "sdt-g58-cohort-evidence/v1", "accepted-cohort checkpoint guard");
  requireContains(value.cohortEvidenceGuard, "unsafe: null", "pre-unsafe accepted receipt placeholder");
  requireContains(value.cohortEvidenceGuard, "pre-unsafe checkpoint did not turn the contract red", "pre-unsafe mutation proof");
  requireContains(value.purgePlan, "service_id <> 'sekiban-dcb-meeting-room-cloudflare-only'", "C-0 retired-lag purge plan");
  requireContains(value.mutation, "g58-coverage-gate-production-mutant-red", "production BLOCK omission proof");
  requireContains(value.e2e, "safeWindowMs + 120000ms", "deployed e2e safe deadline");
  requireContains(value.e2e, "pacedReservationCommits", "paced cohort recorder");
  requireContains(value.readProof, "expectedTagHead", "tag-scoped AC5 head oracle");
  requireContains(value.readProof, "noProjectionPollQuery", "read-only AC5 proof boundary");
  requireContains(value.packageJson, '"test:g58"', "dedicated G58 package lane");
  requireContains(value.ci, "Run SDT-G58 safe-lane and live-projection reliability lane", "G58 CI invocation");
  requireContains(value.ci, "SDT_G58_FORCE_FAILURE", "G58 forced-red CI reachability");
}

function expectRed(value, mutate, label) {
  const candidate = { ...value };
  mutate(candidate);
  try {
    assertG58SafeLaneContract(candidate);
  } catch {
    return;
  }
  fail(`self-test mutation unexpectedly passed: ${label}`);
}

function main() {
  const value = snapshot();
  assertG58SafeLaneContract(value);
  if (process.argv.includes("--self-test")) {
    expectRed(value, (candidate) => {
      candidate.worker = candidate.worker.replaceAll("await input.catchUp(coverage.frontierSuid);", "await input.catchUp();");
    }, "BLOCK pass loses its retained frontier");
    expectRed(value, (candidate) => {
      candidate.catchUp = candidate.catchUp.replace("options.maximumSuid === null", "false");
    }, "no-frontier hold removed");
    expectRed(value, (candidate) => {
      candidate.cloudflare = candidate.cloudflare.replace("await pollLiveProjections", "await removedLiveProjectionPoll");
    }, "scheduled projection poll removed");
    process.stdout.write(`${JSON.stringify({ selfTest: "g58-safe-lane-mutations-red" })}\n`);
  }
  process.stdout.write(`${JSON.stringify({ guard: "g58-safe-lane", status: "pass" })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
