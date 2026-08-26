#!/usr/bin/env node
/**
 * G30's trace contract cannot be proven by source-string coverage alone.
 * Every entry below alters a real production implementation branch, rebuilds
 * it, and requires its one named oracle to fail while an independent oracle
 * still passes. The source is restored in every finally block.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");

const source = Object.freeze({
  trace: "packages/dcb-runtime/src/trace/CommitTrace.ts",
  verifier: "packages/dcb-runtime/src/trace/CommitTraceVerifier.ts",
  ratio: "packages/dcb-runtime/src/trace/AttributionRatio.ts",
  commit: "packages/dcb-runtime/src/commit/CommitWorker.ts",
  journal: "packages/dcb-runtime/src/journal/JournalDurableObject.ts",
  repair: "packages/dcb-runtime/src/repair/RepairWorker.ts",
  traceExport: "scripts/deploy/g30-trace-export.mjs",
  measure: "scripts/deploy/g30-b0-measure.mjs",
  b0: "scripts/g30-b0-contract.mjs",
  observation: "packages/dcb-runtime/src/trace/ObservationStream.ts",
});

/** Each mutation owns one exact G30 runtime oracle, plus one unrelated pass. */
export const G30_TRACE_MUTATIONS = Object.freeze([
  {
    id: "raw-tag-guard",
    file: source.trace,
    from: "    assertNoRawTagAttributes(attributes);\n    for (const [attribute, declaration] of Object.entries(manifest.attributeMatrix.attributes)) {",
    to: "    void attributes;\n    for (const [attribute, declaration] of Object.entries(manifest.attributeMatrix.attributes)) {",
    target: "rejects a raw tag attribute before it can become telemetry",
    unrelated: "observes activation and idle only in process memory",
  },
  {
    id: "accepted-face",
    file: source.trace,
    from: "      face: \"accepted\" as const,\n      attributes: Object.freeze(attributes),",
    to: "      face: \"pre-admission\" as const,\n      attributes: Object.freeze(attributes),",
    target: "moves only the real accepted root onto the accepted face",
    unrelated: "keeps the real validation-reject boundary pre-admission",
  },
  {
    id: "early-attempt-identity",
    file: source.trace,
    from: '      if (state === "forbidden" && present) {',
    to: '      if (false && state === "forbidden" && present) {',
    target: "forbids an attempt identity before admission and requires it after admission",
    unrelated: "rejects a raw tag attribute before it can become telemetry",
  },
  {
    id: "missing-after-admission-identity",
    file: source.trace,
    from: '      if (state === "required" && !present) {',
    to: '      if (false && state === "required" && !present) {',
    target: "forbids an attempt identity before admission and requires it after admission",
    unrelated: "rejects a raw tag attribute before it can become telemetry",
  },
  {
    id: "native-attribute-type-gate",
    file: source.trace,
    from: "  for (const attribute of Object.keys(attributes)) {\n    faceState(attribute, face);\n  }\n  assertAttributeTypes(attributes);\n}\n\nfunction nativeAttributesAreValid",
    to: "  for (const attribute of Object.keys(attributes)) {\n    faceState(attribute, face);\n  }\n  void attributes;\n}\n\nfunction nativeAttributesAreValid",
    target: "fails open without emitting a native span when callback attributes violate the manifest type",
    unrelated: "emits manifest-attributed native spans at allocator and callee callback boundaries",
  },
  {
    id: "detached-observation-inside-root",
    file: source.trace,
    from: "        void this.scheduleDetachedObservation();",
    to: "        await this.scheduleDetachedObservation();",
    target: "ends S00 before a detached waitUntil-style observation can complete",
    unrelated: "rejects a raw tag attribute before it can become telemetry",
  },
  {
    id: "idle-schedule",
    file: source.trace,
    from: "export const IDLE_EXPERIMENT_SCHEDULE_MS = Object.freeze([2_000, 15_000, 180_000] as const);",
    to: "export const IDLE_EXPERIMENT_SCHEDULE_MS = Object.freeze([2_000, 15_000, 179_000] as const);",
    target: "uses the literal 2s/15s/180s idle experiment schedule and keeps activation IDs independent",
    unrelated: "rejects a raw tag attribute before it can become telemetry",
  },
  {
    id: "activation-uses-module-scope-id",
    file: source.trace,
    from: "  readonly activationId = crypto.randomUUID();",
    // The production Worker identity is initialized at the first handler
    // boundary. Keep this mutant type-correct while still substituting that
    // identity for the DO-local activation ID once a request has begun.
    to: "  readonly activationId = workerIsolateInstanceId ?? \"worker-isolate-not-initialized\";",
    target: "uses the literal 2s/15s/180s idle experiment schedule and keeps activation IDs independent",
    unrelated: "rejects a raw tag attribute before it can become telemetry",
  },
  {
    id: "activation-flips-after-await",
    file: source.trace,
    from: "    this.first = false;",
    to: "    queueMicrotask(() => { this.first = false; });",
    target: "observes activation and idle only in process memory / external ledgers",
    unrelated: "rejects a raw tag attribute before it can become telemetry",
  },
  {
    id: "unknown-gap-defaulted-to-180s",
    file: source.trace,
    from: "  if (previous === undefined || !previous.complete || !Number.isFinite(previous.endMs) || !Number.isFinite(currentStartMs)) return null;",
    to: "  if (previous === undefined || !previous.complete || !Number.isFinite(previous.endMs) || !Number.isFinite(currentStartMs)) return 180_000;",
    target: "observes activation and idle only in process memory / external ledgers",
    unrelated: "rejects a raw tag attribute before it can become telemetry",
  },
  {
    id: "reactivation-cause-decided-by-time",
    file: source.trace,
    from: "  return \"unknown\";\n}\n\nexport interface NativeCommitSpanInput",
    to: "  if (evidence.elapsedMs !== undefined) return \"platform-evidenced\";\n  return \"unknown\";\n}\n\nexport interface NativeCommitSpanInput",
    target: "observes activation and idle only in process memory / external ledgers",
    unrelated: "rejects a raw tag attribute before it can become telemetry",
  },
  {
    id: "union-not-sum",
    file: source.ratio,
    from: "const coveredDurationMs = Math.min(rootDurationMs, unionDuration(intervals));",
    to: "const coveredDurationMs = Math.min(rootDurationMs, intervals.reduce((total, interval) => total + interval[1] - interval[0], 0));",
    target: "uses union rather than a sum when caller coverage overlaps only part of the root",
    unrelated: "observes activation and idle only in process memory",
  },
  {
    id: "callee-in-caller-coverage",
    file: source.ratio,
    from: 'const coverage = new Set(manifest.schemas["sdt.commit/v1"].callerCoverageIntervals);',
    to: 'const coverage = new Set([...manifest.schemas["sdt.commit/v1"].callerCoverageIntervals, "S16"]);',
    target: "excludes a provider/callee interval from caller attribution coverage",
    unrelated: "uses union rather than a sum when caller coverage overlaps only part of the root",
  },
  {
    id: "equal-boundary",
    file: source.verifier,
    from: "        child.startMs >= candidate.startMs && child.endMs <= candidate.endMs,",
    to: "        child.startMs > candidate.startMs && child.endMs < candidate.endMs,",
    target: "accepts equal parent/child timestamp boundaries",
    unrelated: "rejects parent containment, cross-root linkage, and caller/callee clock mixing independently",
  },
  {
    id: "zero-duration-is-missing",
    file: source.verifier,
    from: "    if (span.endMs === span.startMs && (span.zeroDurationPlatformLimited !== true || span.present !== true)) {",
    to: "    if (span.endMs === span.startMs) {",
    target: "retains a zero-duration platform-limited span as present",
    unrelated: "uses union rather than a sum when caller coverage overlaps only part of the root",
  },
  {
    id: "retry-is-duplicate",
    file: source.verifier,
    from: "      if (retryIndexes.length !== count || !sequential) {",
    to: "      if (true || retryIndexes.length !== count || !sequential) {",
    target: "keeps retried append work as a 0..n sequence rather than mislabelling it a duplicate",
    unrelated: "accepts equal parent/child timestamp boundaries",
  },
  {
    // Every traced Tag request receives the exact tag only through this
    // adapter. Removing it proves the actual CommitWorker S14 completion
    // read, rather than a synthetic snapshot, requires the hash.
    id: "s14-tag-hash",
    file: source.commit,
    from: "      : traceScope.span(rowId, { tag, ...traceOptions }, invoke);",
    to: "      : traceScope.span(rowId, { ...traceOptions }, invoke);",
    target: "emits S14 member identity from the real CommitWorker completion path",
    unrelated: "moves only the real accepted root onto the accepted face",
  },
  {
    id: "success-complete-transition-boundary",
    file: source.commit,
    from: '  COMPLETE: { rowId: "S05d", phaseOrdinal: 3 },',
    to: '  COMPLETE: { rowId: "S05c", phaseOrdinal: 3 },',
    target: "emits every caller-owned success row from the real CommitWorker path",
    unrelated: "emits the partial-handoff boundary and never claims the complete transition",
  },
  {
    id: "reservation-cancel-boundary",
    file: source.commit,
    from: '      : await traceScope.span("S18", {}, async (stage) => cancel(stage));',
    to: "      : await cancel();",
    target: "emits the reservation-failure boundary from the real cancel-barrier path",
    unrelated: "emits the partial-handoff boundary and never claims the complete transition",
  },
  {
    id: "reservation-cancel-member-boundary",
    file: source.commit,
    from: 'stageScope === undefined ? undefined : "S19"',
    to: "undefined",
    target: "emits the reservation-failure boundary from the real cancel-barrier path",
    unrelated: "emits the partial-handoff boundary and never claims the complete transition",
  },
  {
    id: "allocator-failure-boundary",
    file: source.commit,
    from: '      }, traceScope, "S08");',
    to: "      }, traceScope);",
    target: "emits the allocator-failure boundary and routes it through the same cancel barrier",
    unrelated: "emits the reservation-failure boundary from the real cancel-barrier path",
  },
  {
    id: "partial-handoff-boundary",
    file: source.commit,
    from: '    }, traceScope, "S20");',
    to: "    }, traceScope);",
    target: "emits the partial-handoff boundary and never claims the complete transition",
    unrelated: "emits the reservation-failure boundary from the real cancel-barrier path",
  },
  {
    id: "terminal-alarm-clear-boundary",
    file: source.journal,
    from: '            return tracedReconcile(trace, "R08", () => this.clearTerminalAlarm(trace), {\n              before: "terminal",\n              after: "terminal",\n            });',
    to: "            return this.clearTerminalAlarm(trace);",
    target: "emits terminal-at-entry R00/R08 from the real Journal alarm handler",
    unrelated: "adds the late full-write recovery fact only to the still-open R00 native span",
  },
  {
    id: "terminal-alarm-recovery-kind",
    file: source.journal,
    from: '            if (trace !== undefined) trace.recoveryKind = "terminal-at-entry";',
    to: '            if (trace !== undefined) trace.recoveryKind = "post-allocation-full-write";',
    target: "emits terminal-at-entry R00/R08 from the real Journal alarm handler",
    unrelated: "adds the late full-write recovery fact only to the still-open R00 native span",
  },
  {
    id: "repair-dry-run-boundary",
    file: source.repair,
    from: '        return trace.scope.fork().span("X03p", {',
    to: '        return trace.scope.fork().span("X03r", {',
    target: "emits the real dry-run repair boundary without taking a lease or writing a Tag",
    unrelated: "emits the real resume-skip repair boundary with zero Tag mutation calls",
  },
  {
    id: "repair-resume-skip-boundary",
    file: source.repair,
    from: '          await trace.scope.fork().span("X03r", {',
    to: '          await trace.scope.fork().span("X03p", {',
    target: "emits the real resume-skip repair boundary with zero Tag mutation calls",
    unrelated: "emits the real dry-run repair boundary without taking a lease or writing a Tag",
  },
  {
    id: "repair-lease-boundary",
    file: source.repair,
    from: '        : await trace.scope.fork().span("X02", {',
    to: '        : await trace.scope.fork().span("X03p", {',
    target: "emits the real mutating repair lease and item boundary without a G36 permit claim",
    unrelated: "emits the real dry-run repair boundary without taking a lease or writing a Tag",
  },
  {
    id: "exported-runtime-verifier",
    file: source.traceExport,
    from: "    if (complete) verifyRuntimeSuccessTrace(trace);",
    to: "    if (false) verifyRuntimeSuccessTrace(trace);",
    target: "runs the runtime schema verifier over exported rows rather than trusting success row presence",
    unrelated: "classifies a telemetry group without an S00 root as root-absent instead of matching by time",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "nested-source-custom-span-attributes",
    file: source.traceExport,
    from: "    ...flattenAttributes(event?.source),\n    ...flattenAttributes(event?.event?.source),",
    to: "    ...flattenAttributes(event?.event?.source),",
    target: "normalizes nested Cloudflare custom-span attributes from source",
    unrelated: "runs the runtime schema verifier over exported rows rather than trusting success row presence",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "observation-correlation-gate",
    file: source.traceExport,
    from: "    if (correlationId === undefined) {\n      fail(\"observation-correlation\", \"structured observation has no existing trace correlation\");\n    }",
    to: "    if (false) {\n      fail(\"observation-correlation\", \"structured observation has no existing trace correlation\");\n    }",
    target: "rejects a structured observation that lacks its existing trace correlation",
    unrelated: "rejects a worker observation without the client CF-Ray used by the ledger",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "observation-worker-request-id-gate",
    file: source.traceExport,
    from: "      if (typeof observedWorkerRequestId !== \"string\" || observedWorkerRequestId.length === 0) {\n        fail(\"observation-request-id\", `S00 trace ${group.traceId} worker observation lacks the client CF-Ray`);\n      }",
    to: "      if (false) {\n        fail(\"observation-request-id\", `S00 trace ${group.traceId} worker observation lacks the client CF-Ray`);\n      }",
    target: "rejects a worker observation without the client CF-Ray used by the ledger",
    unrelated: "rejects a structured observation that lacks its existing trace correlation",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "observation-platform-request-id-gate",
    file: source.traceExport,
    from: "  if (typeof platformRequestId !== \"string\" || platformRequestId.length === 0) {\n    fail(\"observation-platform-request-id\", \"structured observation has no provider request id\");\n  }",
    to: "  if (false) {\n    fail(\"observation-platform-request-id\", \"structured observation has no provider request id\");\n  }",
    target: "rejects a structured observation without its provider request id",
    unrelated: "rejects a structured observation that lacks its existing trace correlation",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "telemetry-query-saturation-gate",
    file: source.traceExport,
    from: "  if (events.length >= limit || (typeof reportedCount === \"number\" && reportedCount >= limit)) {\n    fail(\"query-saturated\", \"telemetry query reached its bounded result limit\");\n  }",
    to: "  if (false) {\n    fail(\"query-saturated\", \"telemetry query reached its bounded result limit\");\n  }",
    target: "rejects a saturated telemetry subquery instead of silently accepting a partial cohort",
    unrelated: "keeps cohort telemetry filters inside the primary/receiver worker scope",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "telemetry-trace-id-capacity-batch-gate",
    file: source.traceExport,
    from: "    batchSize: TELEMETRY_TRACE_ID_BATCH,",
    to: "    batchSize: 4,",
    target: "uses one exact traceId per full-trace telemetry query to stay beneath provider result capacity",
    unrelated: "discovers a rayless S00 root through exact worker-observation correlation",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "telemetry-query-node-budget-gate",
    file: source.traceExport,
    from: "  if (nodeCount > CLOUDFLARE_TELEMETRY_MAX_FILTER_NODES) {\n    fail(\"query-node-budget\", `telemetry query has ${nodeCount} filter nodes; provider maximum is ${CLOUDFLARE_TELEMETRY_MAX_FILTER_NODES}`);\n  }",
    to: "  if (false) {\n    fail(\"query-node-budget\", `telemetry query has ${nodeCount} filter nodes; provider maximum is ${CLOUDFLARE_TELEMETRY_MAX_FILTER_NODES}`);\n  }",
    target: "rejects a telemetry query that exceeds Cloudflare's 16-node filter budget",
    unrelated: "keeps cohort telemetry filters inside the primary/receiver worker scope",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "telemetry-cohort-in-membership-gate",
    file: source.traceExport,
    from: "    operation: \"in\",\n    type: \"string\",\n    value: nonEmptyTelemetryStrings(values, key).join(\",\"),",
    to: "    operation: \"eq\",\n    type: \"string\",\n    value: nonEmptyTelemetryStrings(values, key).join(\",\"),",
    target: "serializes multi-value cohort filters as provider IN membership",
    unrelated: "rejects a telemetry query that exceeds Cloudflare's 16-node filter budget",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "telemetry-initial-cohort-retry-gate",
    file: source.traceExport,
    from: "      if (!retry || !pendingTelemetryError(error) || now() >= deadlineMs) throw error;",
    to: "      if (true || !retry || !pendingTelemetryError(error) || now() >= deadlineMs) throw error;",
    target: "retries an initially incomplete cohort before the B export deadline",
    unrelated: "serializes multi-value cohort filters as provider IN membership",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "telemetry-incomplete-success-trace-retry-gate",
    file: source.traceExport,
    from: "delivery-budget|tail-coverage|trace-complete|trace-loss|",
    to: "delivery-budget|tail-coverage|trace-loss|",
    target: "retries an incomplete success trace before the B export deadline",
    unrelated: "retries an initially incomplete cohort before the B export deadline",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "telemetry-delivery-budget-retry-gate",
    file: source.traceExport,
    from: "delivery-budget|tail-coverage|trace-complete|trace-loss|",
    to: "tail-coverage|trace-complete|trace-loss|",
    target: "retries a sub-budget cohort before the B export deadline",
    unrelated: "retries an incomplete success trace before the B export deadline",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "b0-consistency-tag-fanout-gate",
    file: source.measure,
    from: "    consistencyTags: [{ tag: FIXTURE_TAG, lastSortableUniqueId: consistencyHead }],",
    to: "    consistencyTags: [],",
    target: "chains one fixed tag's observed head through every B0 commit",
    unrelated: "takes phase continuity from the durable fixed-tag head",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "b0-consistency-response-head-gate",
    file: source.measure,
    from: "  return Object.freeze({ event, head });",
    to: "  return Object.freeze({ event, head: \"063923208896355000000000000000\" });",
    target: "chains one fixed tag's observed head through every B0 commit",
    unrelated: "takes phase continuity from the durable fixed-tag head",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "b0-consistency-durable-authority-gate",
    file: source.measure,
    from: "  const existingHead = await readConsistencyHeadAfterConformancePropagation(baseUrl, token, attempts, delayMs);",
    to: "  const existingHead = undefined;",
    target: "takes phase continuity from the durable fixed-tag head",
    unrelated: "chains one fixed tag's observed head through every B0 commit",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "b0-consistency-empty-seed-gate",
    file: source.measure,
    from: "  if (result.body.exists === false) {\n    if (result.body.lastSortableUniqueId !== \"\") throw new Error(\"G30 B0 empty fixed tag read must carry the V1 empty head\");\n    return Object.freeze({ head: undefined, evidence: successfulHeadReadEvidence(result, undefined) });\n  }",
    to: "  if (result.body.exists === false) {\n    if (result.body.lastSortableUniqueId !== \"\") throw new Error(\"G30 B0 empty fixed tag read must carry the V1 empty head\");\n    return Object.freeze({ head: \"\", evidence: successfulHeadReadEvidence(result, undefined) });\n  }",
    target: "seeds the fixed tag only after a durable empty read",
    unrelated: "takes phase continuity from the durable fixed-tag head",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "b0-window-reset-no-resend-gate",
    file: source.measure,
    from: "      await resetEligibleWindow(attempt.trigger);",
    to: "      throw new Error(\"mutant skipped the AC7 window reset\");",
    target: "resets the retained window after a 504 without resending its attempt",
    unrelated: "chains one fixed tag's observed head through every B0 commit",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "b0-window-reset-reread-gate",
    file: source.measure,
    from: "      reread = await readConsistencyHeadRecordAfterConformancePropagation(baseUrl, token, readbackAttempts, readbackDelayMs);",
    to: "      reread = { head: expectedConsistencyHead, evidence: { kind: \"fixed-tag-head-reread\", endpoint: \"/conformance/v1/api/sekiban/serialized/tag-latest-sortable\", head: expectedConsistencyHead, statusRaw: { httpStatus: 200, cfRay: null, receivedAtMs: Date.now(), receivedAt: new Date().toISOString() } } };",
    target: "resets the retained window after a 504 without resending its attempt",
    unrelated: "chains one fixed tag's observed head through every B0 commit",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "b0-trace-sampling-settlement-gate",
    file: source.measure,
    from: "  let traceSamplingSettlement = await awaitBTraceSamplingSettlement({\n    phase,\n    deploymentWitness: configWitness,\n    now,\n    sleepFor,\n  });",
    to: "  let traceSamplingSettlement = undefined;",
    target: "retains B trace-sampling settlement before the canonical cohort",
    unrelated: "chains one fixed tag's observed head through every B0 commit",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "platform-ray-client-join-gate",
    file: source.traceExport,
    from: "      requestId = clientRequestIdsByRayId.get(platformRayId);",
    to: "      requestId = platformRayId;",
    target: "preserves the POP-suffixed client CF-Ray across the platform ray-id join",
    unrelated: "normalizes a structured observation without a platform trace id",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    // Rayless custom-span roots exist in live Workers telemetry. Reverting to
    // the former CF-Ray-only discovery path must leave this exact cohort
    // root-absent rather than allowing a time-nearest substitute.
    id: "correlation-root-discovery-gate",
    file: source.traceExport,
    from: '    key: "correlation.id",',
    to: '    key: "$metadata.rayId",',
    target: "discovers a rayless S00 root through exact worker-observation correlation",
    unrelated: "preserves the POP-suffixed client CF-Ray across the platform ray-id join",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "runtime-verification-gate",
    file: source.b0,
    from: " || trace?.runtimeVerified !== true)",
    to: " || false)",
    target: "classifies a non-runtime-verified root as schema-incomplete rather than silently passing it",
    unrelated: "keeps a dropped non-tail trace in the fixed denominator as UNKNOWN",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "b0-trace-sampling-settlement-evidence-gate",
    file: source.b0,
    from: "  const traceSamplingSettlement = assertBTraceSamplingSettlement(phases.B);",
    to: "  const traceSamplingSettlement = undefined;",
    target: "rejects B evidence opened before DO trace sampling settled",
    unrelated: "derives B0 activation, idle, and all outlier dispositions from raw telemetry only",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "evidence-reverification-gate",
    file: source.b0,
    from: "  // Re-run the runtime-shaped verifier here so post-export row/attribute\n  // edits cannot survive merely by retaining runtimeVerified: true.\n  try {\n    verifyExportedSuccessTrace(trace);",
    to: "  // Re-run the runtime-shaped verifier here so post-export row/attribute\n  // edits cannot survive merely by retaining runtimeVerified: true.\n  try {\n    void trace;",
    target: "re-verifies every retained trace instead of trusting a stale success flag",
    unrelated: "requires real warm activation observations for every reusable actor",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "idle-evidence-schedule-gate",
    file: source.b0,
    from: "  if (idle === undefined || !same(idle.scheduleMs, G30_IDLE_SCHEDULE_MS) || !Array.isArray(idle.windows)) {",
    to: "  if (idle === undefined || false || !Array.isArray(idle.windows)) {",
    target: "requires the literal B-only 2/15/180 schedule from raw ledgers",
    unrelated: "derives B0 activation, idle, and all outlier dispositions from raw telemetry only",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "activation-storage-isolation-gate",
    file: source.b0,
    from: "    if (observation.storageWrites !== 0 || observation.usedForControl !== false || observation.exposedInPublicResponse !== false) {",
    to: "    if (false) {",
    target: "rejects a non-isolated sdt.observe event",
    unrelated: "derives B0 activation, idle, and all outlier dispositions from raw telemetry only",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    // The observation must join by its explicit platform request id, not by
    // a trace-id lookup that can hide a forged/missing request identity.
    id: "observation-request-join-gate",
    file: source.b0,
    from: "    const reference = evidenceReference(observation.requestId, traceIndex, `observation[${index}]`);",
    to: "    const reference = evidenceReference(traceIndex.requestIdByTraceId.get(observation.traceId), traceIndex, `observation[${index}]`);",
    target: "rejects an unjoined sdt.observe event",
    unrelated: "derives B0 activation, idle, and all outlier dispositions from raw telemetry only",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "observation-overlap-script-version-gate",
    file: source.b0,
    from: "      if (provider.scriptVersion !== scriptVersion || rootString(reference, \"script.version\", `observation[${index}]`) !== scriptVersion) {",
    to: "      if (false) {",
    target: "rejects an sdt.observe field that disagrees with its joined S00 trace",
    unrelated: "derives B0 activation, idle, and all outlier dispositions from raw telemetry only",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "fault-barrier-presence-gate",
    file: source.b0,
    from: "    if (requiredForObservedOutlier) fail(\"fault-barrier\", \"queue/doorbell probe has no observed sdt.observe/v1 fault barrier for an observed outlier\");",
    to: "    if (false) fail(\"fault-barrier\", \"queue/doorbell probe has no observed sdt.observe/v1 fault barrier for an observed outlier\");",
    target: "rejects a queue/doorbell fault probe without observed barrier lifecycle",
    unrelated: "derives B0 activation, idle, and all outlier dispositions from raw telemetry only",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "fault-barrier-lifecycle-gate",
    file: source.b0,
    from: "    if (!same(ordered.map((entry) => entry.event.stage), [\"started\", \"ended\", \"drained\"])) {",
    to: "    if (false) {",
    target: "rejects a fault probe with an incomplete observed lifecycle",
    unrelated: "derives B0 activation, idle, and all outlier dispositions from raw telemetry only",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "idle-prior-request-gate",
    file: source.b0,
    from: "  const previousRequestId = nonEmptyString(window?.previousRequestId, `${label}.previous.requestId`);",
    to: "  const previousRequestId = String(window?.previousRequestId ?? \"\");",
    target: "rejects an idle observation without prior and next request references",
    unrelated: "derives B0 activation, idle, and all outlier dispositions from raw telemetry only",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    id: "outlier-hypothesis-collapse",
    file: source.b0,
    from: "    hypothesis: \"durable-object-wake\",",
    to: "    hypothesis: \"worker-isolate-first\",",
    target: "rejects a collapsed outlier hypothesis set",
    unrelated: "joins trace, ledger, and sdt.observe/v1 events by platform root identity",
    testFile: "test/g30-b0.spec.ts",
  },
  {
    // S14 is the success-response fan-out member. This exact call-site
    // mutation must not be hidden by the other fan-out rows.
    id: "s14-member-index",
    file: source.commit,
    from: "      const response = await this.tagRequest(tag, \"/state\", undefined, stageScope?.fork(), stageScope === undefined ? undefined : \"S14\", { memberIndex, attemptId });",
    to: "      const response = await this.tagRequest(tag, \"/state\", undefined, stageScope?.fork(), stageScope === undefined ? undefined : \"S14\", { attemptId });",
    target: "emits S14 member identity from the real CommitWorker completion path",
    unrelated: "moves only the real accepted root onto the accepted face",
  },
]);

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  return { label, status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function requirePass(result) {
  if (result.status === 0) return;
  throw new Error(`${result.label} unexpectedly failed:\n${result.output}`);
}

function requireRed(result, id) {
  if (result.status !== 0) return;
  throw new Error(`G30 ${id} mutant was vacuous: its named oracle remained green`);
}

function testNamed(name, testFile = "test/g30-trace.spec.ts") {
  return run(process.execPath, [
    vitest,
    "run",
    "--config", "vitest.config.ts",
    testFile,
    "--testNamePattern", name,
  ], `G30 trace oracle ${name}`);
}

function build() {
  return run("npm", ["run", "build:packages", "--silent"], "G30 trace production build");
}

function mutate(original, mutation) {
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== 1) throw new Error(`G30 ${mutation.id} expected one mutation anchor in ${mutation.file}, found ${occurrences}`);
  return original.replace(mutation.from, mutation.to);
}

function execute(mutation) {
  const path = resolve(root, mutation.file);
  const original = readFileSync(path, "utf8");
  try {
    requirePass(testNamed(mutation.target, mutation.testFile));
    writeFileSync(path, mutate(original, mutation), "utf8");
    requirePass(build());
    requireRed(testNamed(mutation.target, mutation.testFile), mutation.id);
    requirePass(testNamed(mutation.unrelated, mutation.testFile));
  } finally {
    writeFileSync(path, original, "utf8");
    requirePass(build());
  }
  return { id: mutation.id, target: mutation.target, unrelated: mutation.unrelated, result: "red-with-unrelated-green" };
}

function verifyMatrix() {
  const ids = G30_TRACE_MUTATIONS.map((mutation) => mutation.id);
  if (new Set(ids).size !== ids.length) throw new Error("G30 trace mutation IDs must be unique");
  for (const mutation of G30_TRACE_MUTATIONS) {
    if (mutation.target === mutation.unrelated) throw new Error(`G30 ${mutation.id} lacks an independent oracle`);
    const testFile = mutation.testFile ?? "test/g30-trace.spec.ts";
    const testSource = readFileSync(resolve(root, testFile), "utf8");
    if (!testSource.includes(mutation.target) || !testSource.includes(mutation.unrelated)) {
      throw new Error(`G30 ${mutation.id} names an oracle absent from ${testFile}`);
    }
  }
}

function main() {
  verifyMatrix();
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify({ mutations: G30_TRACE_MUTATIONS.map((mutation) => mutation.id), result: "matrix-valid" }, null, 2));
    return;
  }
  requirePass(build());
  const results = G30_TRACE_MUTATIONS.map(execute);
  console.log(JSON.stringify({ mutations: results, result: "all-production-mutants-red" }, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
