import { describe, expect, it, vi } from "vitest";

import {
  assertB0Evidence,
  assertIdleRequestReferences,
  assertObservationStream,
  assertTraceCohort,
  observationLedgerForPhase,
} from "../scripts/g30-b0-contract.mjs";
import { assertG30Config, assertPhaseRuntimeIsolation, assertWitnessCaptureShellSafety, assertWitnessReplaySnapshotSafety } from "../scripts/g30-config-check.mjs";
import {
  buildBoundedTelemetryQuery,
  normalizeTelemetryBundle,
  normalizeTelemetryExport,
  queryTelemetry,
} from "../scripts/deploy/g30-trace-export.mjs";
import { assertDeploymentWitness } from "../scripts/deploy/g30-b0-measure.mjs";
import { deploymentMessage } from "../scripts/deploy/g30-deployment-witness.mjs";
import manifest from "../contracts/commit-trace-manifest.json";
import meetingRoomWorker, { type MeetingRoomCloudflareEnv } from "../samples/meeting-room/src/worker.cloudflare-only";

type Phase = "A" | "B" | "A-prime";

const SERVICE = "g32-9043d626fe1149cb";
const ROOT_ROWS = manifest.schemas["sdt.commit/v1"].boundaries
  .find((boundary) => boundary.name === "success")!.requiredRows;
const IDLE_SCHEDULE_MS = [2_000, 15_000, 180_000];

function deploymentConfig(sample: 0 | 1): Record<string, unknown> {
  return {
    name: "g30-fixture",
    main: "src/worker.cloudflare-only.ts",
    observability: {
      enabled: true,
      logs: { enabled: true, persist: true, invocation_logs: true, head_sampling_rate: 1 },
      traces: { enabled: true, persist: true, head_sampling_rate: sample },
    },
    version_metadata: { binding: "WORKER_VERSION" },
    workers_dev: false,
    preview_urls: false,
    vars: { SDT_SERVICE_ID: SERVICE },
  };
}

function actorClass(emitter: string): string {
  if (emitter === "root-worker") return "ROOT";
  if (emitter === "allocator-do") return "ALLOCATOR";
  if (emitter === "journal-do") return "JOURNAL";
  if (emitter === "callee-do") return "TAG";
  return "ROOT";
}

function activationFirst(requestId: string): boolean {
  return requestId.endsWith("idle-2") || requestId.endsWith("-2") && !requestId.includes("warm");
}

function traceAttributes(rowId: string, requestId: string): Record<string, string | number | boolean> {
  const row = manifest.schemas["sdt.commit/v1"].rows.find((candidate) => candidate.rowId === rowId)!;
  const preAdmission = rowId === "S01";
  const attributes: Record<string, string | number | boolean> = {
    "schema.version": "sdt.commit/v1",
    "correlation.id": `corr-${requestId}`,
    "service.id": SERVICE,
    "actor.class": actorClass(row.emitter),
    operation: row.span,
    "span.kind": row.kind,
    outcome: "success",
  };
  if (!preAdmission) {
    attributes["attempt.id"] = `attempt-${requestId}`;
    attributes["actor.key_hash"] = "a".repeat(64);
  }
  if (/^S05([a-e])$/.test(rowId)) attributes["phase.ordinal"] = "abcde".indexOf(rowId.at(-1)!);
  if (manifest.attributeMatrix.attributes["member.index"].rowScope?.includes(rowId)) attributes["member.index"] = 0;
  if (manifest.attributeMatrix.attributes["tag.key_hash"].rowScope?.includes(rowId)) attributes["tag.key_hash"] = "b".repeat(64);
  if (rowId === "S00") {
    attributes["activation.first"] = activationFirst(requestId);
    attributes["script.version"] = "g30-test-version";
    attributes.colo = "test-colo";
  }
  return attributes;
}

function records(phase: Phase, responseLatencyMs: number): Array<Record<string, unknown>> {
  const start = 1_000_000;
  return Array.from({ length: 100 }, (_, index) => ({
    index,
    requestId: `${phase}-${index}`,
    status: 200,
    eligible: true,
    nonEmpty: true,
    replacement: false,
    serviceId: SERVICE,
    clientRegion: "fixture-region",
    tagSetDigest: "a".repeat(64),
    payloadDigest: "b".repeat(64),
    fixtureVersion: "sdt-g30-b0-v1",
    scheduledStartMs: start + index * 2_000,
    startedAtMs: start + index * 2_000,
    completedAtMs: start + index * 2_000 + responseLatencyMs,
    responseLatencyMs,
  }));
}

function warmupRecords(): Array<Record<string, unknown>> {
  return Array.from({ length: 5 }, (_, index) => ({
    index,
    requestId: `B-warm-${index}`,
    status: 200,
    startedAtMs: 980_000 + index * 2_000,
    completedAtMs: 980_100 + index * 2_000,
    responseLatencyMs: 100,
  }));
}

function idleExperiment(canonical: Array<Record<string, unknown>>) {
  const requests: Array<Record<string, unknown>> = [];
  const windows: Array<Record<string, unknown>> = [];
  let previous = canonical.at(-1)!;
  for (const [index, scheduledGapMs] of IDLE_SCHEDULE_MS.entries()) {
    const startedAtMs = Number(previous.completedAtMs) + scheduledGapMs;
    const next = {
      requestId: `B-idle-${index}`,
      status: 200,
      startedAtMs,
      completedAtMs: startedAtMs + 108,
      responseLatencyMs: 108,
    };
    requests.push(next);
    windows.push({ scheduledGapMs, previousRequestId: previous.requestId, nextRequestId: next.requestId });
    previous = next;
  }
  return { scheduleMs: IDLE_SCHEDULE_MS, requests, windows };
}

function phaseConfiguration(sample: 0 | 1, deployedVersion: string) {
  return {
    serviceId: SERVICE,
    placement: "off",
    deployedVersion,
    sourceCommit: "c".repeat(40),
    configDigest: "d".repeat(64),
    observability: {
      logs: { enabled: true, persist: true, invocation_logs: true, head_sampling_rate: 1 },
      traces: { enabled: true, persist: true, head_sampling_rate: sample },
    },
  };
}

type RawEvent = {
  attributes?: Record<string, string | number | boolean>;
  source?: Record<string, unknown>;
  $metadata?: Record<string, unknown>;
};

function nestedSource(attributes: Record<string, string | number | boolean>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    const parts = key.split(".");
    let current = root;
    for (const part of parts.slice(0, -1)) {
      const existing = current[part];
      if (existing === undefined) current[part] = {};
      if (current[part] === null || typeof current[part] !== "object" || Array.isArray(current[part])) {
        throw new Error(`fixture cannot nest ${key}`);
      }
      current = current[part] as Record<string, unknown>;
    }
    current[parts.at(-1)!] = value;
  }
  return root;
}

function rawTelemetry(ledger: ReadonlyArray<Record<string, unknown>>) {
  const events: RawEvent[] = [];
  for (const record of ledger) {
    const requestId = String(record.requestId);
    const correlationId = `corr-${requestId}`;
    const startedAtMs = Number(record.startedAtMs);
    const completedAtMs = Number(record.completedAtMs);
    const metadata = {
      traceId: `trace-${requestId}`,
      requestId: `provider-${requestId}`,
      rayId: requestId,
      scriptVersion: { id: "g30-test-version" },
      colo: "test-colo",
      cpuTimeMs: 1,
      wallTimeMs: completedAtMs - startedAtMs,
    };
    for (const rowId of ROOT_ROWS) {
      events.push({
        attributes: traceAttributes(rowId, requestId),
        $metadata: { ...metadata, rayId: rowId === "S00" ? requestId : undefined, startMs: startedAtMs, endMs: completedAtMs },
      });
    }
    events.push({
      source: {
        schema: "sdt.observe/v1",
        event: "worker.invocation",
        emittedAtMs: completedAtMs - 3,
        requestId,
        correlationId,
        actorClass: "WORKER",
        isolateInstanceId: "fixture-isolate",
        activationFirst: activationFirst(requestId),
        scriptVersion: "g30-test-version",
        colo: "test-colo",
        storageWrites: 0,
        usedForControl: false,
        exposedInPublicResponse: false,
      },
      $metadata: metadata,
    });
    for (const actorClassValue of ["BOOTSTRAP", "ALLOCATOR", "TAG"]) {
      events.push({
        source: {
          schema: "sdt.observe/v1",
          event: "do.handler",
          emittedAtMs: completedAtMs - 2,
          correlationId,
          actorClass: actorClassValue,
          activationId: `${actorClassValue.toLowerCase()}-${requestId}`,
          activationFirst: false,
          constructorToHandlerMs: 1,
          firstStorageReadMs: 1,
          subrequestWallMs: actorClassValue === "ALLOCATOR" ? 1 : null,
          storageWrites: 0,
          usedForControl: false,
          exposedInPublicResponse: false,
        },
        $metadata: metadata,
      });
    }
  }
  const faultRequestId = "B-13";
  for (const [offset, stage] of ["started", "ended", "drained"].entries()) {
    events.push({
      source: {
        schema: "sdt.observe/v1",
        event: "fault.barrier",
        emittedAtMs: Number(ledger.find((record) => record.requestId === faultRequestId)?.completedAtMs) - 20 + offset * 5,
        correlationId: `corr-${faultRequestId}`,
        barrierId: "fixture-queue-doorbell",
        stage,
        boundedWindowMs: 20,
        storageWrites: 0,
        usedForControl: false,
        exposedInPublicResponse: false,
      },
      $metadata: { traceId: `trace-${faultRequestId}`, requestId: `provider-${faultRequestId}`, rayId: faultRequestId, scriptVersion: { id: "g30-test-version" }, colo: "test-colo", cpuTimeMs: 1, wallTimeMs: 108 },
    });
  }
  return { events };
}

function evidence() {
  const a = records("A", 100);
  const b = records("B", 108);
  // One measured 21.5s request creates an actual outlier target. Its four
  // dispositions must be derived from joined raw telemetry, never a claim.
  b[13]!.responseLatencyMs = 21_500;
  b[13]!.completedAtMs = Number(b[13]!.startedAtMs) + 21_500;
  const aprime = records("A-prime", 101);
  const phaseB = {
    ledger: b,
    rawAttempts: [],
    configuration: phaseConfiguration(1, "on"),
    warmup: { requested: 5, requests: warmupRecords() },
    idleExperiment: idleExperiment(b),
  };
  const fullLedger = observationLedgerForPhase(phaseB);
  const bundle = normalizeTelemetryBundle(rawTelemetry(fullLedger), Number(b.at(-1)!.completedAtMs) + 1);
  const retained = new Set(b.map((record) => record.requestId));
  return {
    task: "SDT-G30",
    baseline: "B0",
    purpose: "attribution-only-not-g37-denominator",
    phases: {
      A: { ledger: a, rawAttempts: [], configuration: phaseConfiguration(0, "off") },
      B: phaseB,
      "A-prime": { ledger: aprime, rawAttempts: [], configuration: phaseConfiguration(0, "off-prime") },
    },
    traces: bundle.traces.filter((trace) => retained.has(trace.requestId)),
    observationTraces: bundle.traces,
    observations: bundle.observations,
    traceExportCompletedAtMs: Number(b.at(-1)!.completedAtMs) + 1,
  };
}

describe("SDT-G30 B0 trace/evidence gates", () => {
  it("allows only head sampling to vary across the deployment configs", () => {
    expect(assertG30Config(deploymentConfig(0), deploymentConfig(1), deploymentConfig(0))).toMatchObject({
      primarySampling: [0, 1],
      receiverSampling: 0,
      placement: "off",
      receiverPublicSurface: { workersDev: false, previewUrls: false },
    });
  });

  it("carries G38 Phase M public-surface settings through the G30 receiver deployment", () => {
    const receiver = deploymentConfig(0);
    expect(() => assertG30Config(deploymentConfig(0), deploymentConfig(1), { ...receiver, workers_dev: true })).toThrow(/G38 Phase M/);
    expect(() => assertG30Config(deploymentConfig(0), deploymentConfig(1), { ...receiver, preview_urls: true })).toThrow(/G38 Phase M/);
  });

  it("captures deployment witness paths with ordered shell locals under set -u", () => {
    const runbook = [
      "capture_primary_witness() {",
      '  local phase="$1"',
      '  local output="$2"',
      '  local prior="${output}.prior.versions.json"',
      '  local versions="${output}.versions.json"',
      '  printf "%s" "${versions}"',
      "}",
    ].join("\n");
    expect(assertWitnessCaptureShellSafety(runbook)).toEqual({ witnessCaptureLocals: "ordered" });
    expect(() => assertWitnessCaptureShellSafety(runbook.replace(
      '  local phase="$1"\n  local output="$2"\n  local prior="${output}.prior.versions.json"\n  local versions="${output}.versions.json"',
      '  local phase="$1" output="$2" prior="${output}.prior.versions.json" versions="${output}.versions.json"',
    ))).toThrow(/separate ordered locals/);
  });

  it("snapshots primary versions so a repeated phase selects only its new deployment", () => {
    const runbook = [
      "capture_primary_witness() {",
      '  local phase="$1"',
      '  local output="$2"',
      '  local prior="${output}.prior.versions.json"',
      '  local versions="${output}.versions.json"',
      '  node witness --versions "${versions}" --prior-versions "${prior}"',
      "}",
      "capture_primary_predeploy_versions() {",
      '  local output="$1"',
      '  local prior="${output}.prior.versions.json"',
      '  versions list --name "${PRIMARY_WORKER_NAME}" --json > "${prior}"',
      "}",
      'capture_primary_predeploy_versions "${A_WITNESS_FILE}"',
      'deploy_phase A "${PRIMARY_OFF_CONFIG}"',
      'capture_primary_witness A "${A_WITNESS_FILE}"',
      'capture_primary_predeploy_versions "${B_WITNESS_FILE}"',
      'deploy_phase B "${PRIMARY_ON_CONFIG}"',
      'capture_primary_witness B "${B_WITNESS_FILE}"',
      'capture_primary_predeploy_versions "${APRIME_WITNESS_FILE}"',
      'deploy_phase A-prime "${PRIMARY_OFF_CONFIG}"',
      'capture_primary_witness A-prime "${APRIME_WITNESS_FILE}"',
    ].join("\n");
    expect(assertWitnessReplaySnapshotSafety(runbook)).toEqual({ witnessReplaySnapshot: "pre-deploy" });
    expect(() => assertWitnessReplaySnapshotSafety(runbook.replace('--prior-versions "${prior}"', ""))).toThrow(/pre-deploy snapshot/);
  });

  it("keeps A/B/A-prime phase labels out of deployed runtime configuration", () => {
    expect(assertPhaseRuntimeIsolation("export const witness = true;", "deploy --config primary-on")).toEqual({
      phaseAuthority: "external-evidence-ledger",
      runtimePhaseConfig: false,
    });
    expect(() => assertPhaseRuntimeIsolation("const x = G30_TRACE_PHASE;", "deploy --config primary-on")).toThrow(/runtime diagnostic protocol surface/);
  });

  it("does not add a G30 diagnostic route or runtime variable to the authenticated Worker protocol", async () => {
    const fetch = meetingRoomWorker.fetch;
    if (fetch === undefined) throw new Error("meeting-room Worker lacks fetch");
    const response = await fetch(
      new Request("https://g30.test/conformance/v1/g30-config", { headers: { authorization: "Bearer fixture-token" } }) as never,
      { CONFORMANCE_TOKEN: "fixture-token", SDT_SERVICE_ID: SERVICE } as never as MeetingRoomCloudflareEnv,
      { waitUntil: () => undefined } as never,
    );
    expect(response.status).toBe(404);
  });

  it("binds a measurement phase to one external Cloudflare Worker Version rather than a Worker route", () => {
    const sourceCommit = "c".repeat(40);
    const configDigest = "d".repeat(64);
    const witness = {
      task: "SDT-G30",
      phase: "B",
      sourceCommit,
      configDigest,
      placement: "off",
      serviceId: SERVICE,
      worker: "sekiban-dcb-meeting-room-cloudflare-only",
      deployedVersion: {
        id: "00000000-0000-4000-8000-000000000001",
        number: 1,
        createdOn: "2026-08-23T00:00:00.000Z",
        message: deploymentMessage("B", sourceCommit, configDigest, SERVICE),
      },
    };
    expect(assertDeploymentWitness(witness, "B", sourceCommit, configDigest)).toBe(witness);
  });

  it("joins trace, ledger, and sdt.observe/v1 events by platform root identity", () => {
    const document = evidence();
    expect(assertTraceCohort(document.phases.B.ledger, document.traces, document.traceExportCompletedAtMs)).toMatchObject({ requestCount: 100 });
    const observationLedger = observationLedgerForPhase(document.phases.B);
    expect(assertObservationStream(observationLedger, document.observationTraces, document.observations).observationsByRequestId.size).toBe(observationLedger.length);
  });

  it("runs the runtime schema verifier over exported rows rather than trusting success row presence", () => {
    const raw = rawTelemetry(observationLedgerForPhase(evidence().phases.B));
    const root = raw.events.find((entry) => entry.attributes?.operation === "sdt.commit");
    if (root?.attributes === undefined) throw new Error("fixture lacks an S00 raw span");
    // Keep every success row present while corrupting only its runtime shape.
    // normalizeTelemetryBundle must invoke the real verifier before accepting
    // a complete-looking trace.
    root.attributes["span.kind"] = "direct";
    expect(() => normalizeTelemetryExport(raw)).toThrow(/span-kind/);
  });

  it("normalizes nested Cloudflare custom-span attributes from source", () => {
    const raw = rawTelemetry(observationLedgerForPhase(evidence().phases.B));
    for (const event of raw.events) {
      if (event.attributes === undefined) continue;
      event.source = nestedSource(event.attributes);
      delete event.attributes;
    }
    expect(normalizeTelemetryBundle(raw).traces).toHaveLength(observationLedgerForPhase(evidence().phases.B).length);
  });

  it("keeps cohort telemetry filters inside the primary/receiver worker scope", () => {
    const query = buildBoundedTelemetryQuery({
      view: "events",
      limit: 2000,
      dry: true,
      parameters: {
        filterCombination: "or",
        filters: [
          { key: "$workers.scriptName", operation: "eq", type: "string", value: "primary" },
          { key: "$workers.scriptName", operation: "eq", type: "string", value: "receiver" },
        ],
      },
    }, [{ key: "schema", operation: "eq", type: "string", value: "sdt.observe/v1" }]);
    expect(query.parameters).toMatchObject({
      filterCombination: "and",
      filters: [
        { kind: "group", filterCombination: "or" },
        { key: "schema", value: "sdt.observe/v1" },
      ],
    });
  });

  it("rejects a saturated telemetry subquery instead of silently accepting a partial cohort", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      success: true,
      result: { events: { count: 2, events: [{ $metadata: { id: "one" } }, { $metadata: { id: "two" } }] },
    }}), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      await expect(queryTelemetry({ accountId: "account", token: "redacted", payload: { limit: 2 } })).rejects.toThrow(/query-saturated/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects a telemetry group without an S00 correlation anchor instead of matching by time", () => {
    const raw = rawTelemetry(observationLedgerForPhase(evidence().phases.B));
    raw.events = raw.events.filter((entry) => !(
      entry.$metadata?.traceId === "trace-B-0" && entry.attributes?.operation === "sdt.commit"
    ));
    expect(() => normalizeTelemetryExport(raw)).toThrow(/observation-root/);
  });

  it("requires the exported runtime-verification result for every retained trace", () => {
    const document = structuredClone(evidence());
    document.traces[0]!.runtimeVerified = false;
    // Test the cohort gate directly: evidenceTraceIndex independently rejects
    // the same flag later, so a full-evidence assertion would hide a removal
    // of this earlier guard.
    expect(() => assertTraceCohort(
      document.phases.B.ledger,
      document.traces,
      document.traceExportCompletedAtMs,
    )).toThrow(/trace-complete/);
  });

  it("joins the independent client ledger only to its exact worker-observed CF-Ray and rejects a dropped trace", () => {
    const document = evidence();
    document.traces.pop();
    expect(() => assertTraceCohort(document.phases.B.ledger, document.traces, document.traceExportCompletedAtMs)).toThrow(/trace-count/);
  });

  it("re-verifies every retained trace instead of trusting a stale success flag", () => {
    const document = structuredClone(evidence());
    const root = document.traces[0]!.spans.find((span) => span.rowId === "S00");
    if (root === undefined) throw new Error("fixture lacks S00");
    (root.attributes as Record<string, unknown>)["span.kind"] = "direct";
    // Keep runtimeVerified=true: only assertTraceCohort's fresh verifier can
    // reject this post-export row edit.
    expect(() => assertTraceCohort(
      document.phases.B.ledger,
      document.traces,
      document.traceExportCompletedAtMs,
    )).toThrow(/trace-runtime/);
  });

  it("derives B0 activation, idle, and all outlier dispositions from raw telemetry only", () => {
    const result = assertB0Evidence(evidence());
    expect(result).toMatchObject({
      warmup: { B: { attempts: 5 } },
      activationIdle: { scheduleMs: [2_000, 15_000, 180_000], observations: 3 },
      outliers: { classifiedOutliers: 4, unclassifiedOutliers: 0, targetCount: 1 },
    });
  });

  it("requires real warm activation observations for every reusable actor", () => {
    const document = structuredClone(evidence());
    const requestId = document.phases.B.warmup.requests[0]!.requestId;
    const tag = document.observations.find((entry) => entry.requestId === requestId && entry.event === "do.handler" && entry.actorClass === "TAG");
    if (tag === undefined) throw new Error("fixture lacks warm TAG observation");
    tag.activationFirst = true;
    expect(() => assertB0Evidence(document)).toThrow(/warmup-activation/);
  });

  it("rejects an unjoined sdt.observe event", () => {
    const document = structuredClone(evidence());
    document.observations[0]!.requestId = "missing-request";
    expect(() => assertB0Evidence(document)).toThrow(/observation\[0\]-trace-join/);
  });

  it("rejects an sdt.observe field that disagrees with its joined S00 trace", () => {
    const document = structuredClone(evidence());
    const worker = document.observations.find((entry) => entry.event === "worker.invocation");
    if (worker === undefined) throw new Error("fixture lacks worker observation");
    worker.scriptVersion = "wrong-version";
    expect(() => assertB0Evidence(document)).toThrow(/observation-overlap-script-version/);
  });

  it("rejects provider-owned observation metadata that disagrees with its joined S00 trace", () => {
    const document = structuredClone(evidence());
    const observation = document.observations.find((entry) => entry.event === "do.handler");
    if (observation === undefined) throw new Error("fixture lacks a DO observation");
    observation.provider.colo = "wrong-colo";
    expect(() => assertB0Evidence(document)).toThrow(/observation-provider-colo/);
  });

  it("rejects a queue/doorbell fault probe without observed barrier lifecycle", () => {
    const document = evidence();
    document.observations = document.observations.filter((entry) => entry.event !== "fault.barrier");
    expect(() => assertB0Evidence(document)).toThrow(/fault-barrier/);
  });

  it("does not invent a queue/doorbell probe when the measured B window has no 21.5s target", () => {
    const document = structuredClone(evidence());
    const target = document.phases.B.ledger[13]!;
    target.responseLatencyMs = 108;
    target.completedAtMs = Number(target.startedAtMs) + 108;
    document.observations = document.observations.filter((entry) => entry.event !== "fault.barrier");
    const result = assertB0Evidence(document) as { outliers: { targetCount: number; observations: Array<{ hypothesis: string; rawEvidence: unknown[] }> } };
    expect(result.outliers.targetCount).toBe(0);
    expect(result.outliers.observations.find((entry) => entry.hypothesis === "queue-doorbell-backpressure")?.rawEvidence).toEqual([]);
  });

  it("rejects a fault probe with an incomplete observed lifecycle", () => {
    const document = structuredClone(evidence());
    const ended = document.observations.find((entry) => entry.event === "fault.barrier" && entry.stage === "ended");
    if (ended === undefined) throw new Error("fixture lacks a barrier end");
    ended.stage = "started";
    expect(() => assertB0Evidence(document)).toThrow(/fault-barrier/);
  });

  it("rejects an idle observation without prior and next request references", () => {
    expect(() => assertIdleRequestReferences({ nextRequestId: "B-idle-0" }, "idle[0]")).toThrow(/idle\[0\]\.previous\.requestId/);
  });

  it("rejects an idle observation that aliases its prior and next request", () => {
    expect(() => assertIdleRequestReferences({ previousRequestId: "B-idle-0", nextRequestId: "B-idle-0" }, "idle[0]")).toThrow(/idle-reference/);
  });

  it("propagates missing idle references through the joined B0 evidence path", () => {
    const document = evidence();
    delete document.phases.B.idleExperiment.windows[0]!.previousRequestId;
    expect(() => assertB0Evidence(document)).toThrow(/idle\[0\]\.previous\.requestId/);
  });

  it("requires the literal B-only 2/15/180 schedule from raw ledgers", () => {
    const document = evidence();
    document.phases.B.idleExperiment.scheduleMs = [2_000, 15_000, 181_000];
    expect(() => assertB0Evidence(document)).toThrow(/idle-schedule/);
  });

  it("rejects a non-isolated sdt.observe event", () => {
    const document = structuredClone(evidence());
    document.observations[0]!.storageWrites = 1;
    expect(() => assertB0Evidence(document)).toThrow(/observation-isolation/);
  });

  it("rejects a collapsed outlier hypothesis set", () => {
    const document = evidence();
    // This fixture proves all four computed dispositions remain independently
    // named; it does not introduce a human-authored outlier declaration.
    const observations = (assertB0Evidence(document) as { outliers: { observations: Array<{ hypothesis: string }> } }).outliers.observations;
    expect(observations.map((entry: { hypothesis: string }) => entry.hypothesis).sort()).toEqual([
      "durable-object-wake",
      "queue-doorbell-backpressure",
      "token-rotation",
      "worker-isolate-first",
    ]);
  });

  it("rejects a human-authored activation or outlier declaration", () => {
    const document = evidence();
    (document as Record<string, unknown>).activationIdle = { observations: [] };
    expect(() => assertB0Evidence(document)).toThrow(/observation-declaration/);
  });

  it("normalizes a structured observation without a platform trace id", () => {
    const raw = rawTelemetry(observationLedgerForPhase(evidence().phases.B));
    const observation = raw.events.find((entry) => entry.source?.event === "worker.invocation");
    if (observation === undefined) throw new Error("fixture lacks worker event");
    delete observation.$metadata!.traceId;
    expect(normalizeTelemetryBundle(raw).observations.find((entry) => entry.event === "worker.invocation")).toMatchObject({
      schema: "sdt.observe/v1",
      requestId: "B-0",
      correlationId: "corr-B-0",
    });
  });

  it("rejects a structured observation that lacks its existing trace correlation", () => {
    const raw = rawTelemetry(observationLedgerForPhase(evidence().phases.B));
    const observation = raw.events.find((entry) => entry.source?.event === "worker.invocation");
    if (observation?.source === undefined) throw new Error("fixture lacks worker event");
    delete observation.source.correlationId;
    expect(() => normalizeTelemetryExport(raw)).toThrow(/observation-correlation/);
  });

  it("rejects a worker observation without the client CF-Ray used by the ledger", () => {
    const raw = rawTelemetry(observationLedgerForPhase(evidence().phases.B));
    const observation = raw.events.find((entry) => entry.source?.event === "worker.invocation");
    if (observation?.source === undefined) throw new Error("fixture lacks worker event");
    delete observation.source.requestId;
    expect(() => normalizeTelemetryExport(raw)).toThrow(/observation-request-id/);
  });

  it("rejects a structured observation without its provider request id", () => {
    const raw = rawTelemetry(observationLedgerForPhase(evidence().phases.B));
    const observation = raw.events.find((entry) => entry.source?.event === "do.handler");
    if (observation?.$metadata === undefined) throw new Error("fixture lacks DO event metadata");
    delete observation.$metadata.requestId;
    expect(() => normalizeTelemetryExport(raw)).toThrow(/observation-platform-request-id/);
  });

  it("normalizes a Workers Logs structured message from provider metadata", () => {
    const raw = rawTelemetry(observationLedgerForPhase(evidence().phases.B));
    const observation = raw.events.find((entry) => entry.source?.event === "worker.invocation");
    if (observation === undefined) throw new Error("fixture lacks worker event");
    observation.$metadata!.message = JSON.stringify(observation.source);
    delete observation.source;
    const normalized = normalizeTelemetryBundle(raw);
    expect(normalized.observations.find((entry) => entry.event === "worker.invocation")).toMatchObject({
      schema: "sdt.observe/v1",
      scriptVersion: "g30-test-version",
      colo: "test-colo",
    });
  });
});
