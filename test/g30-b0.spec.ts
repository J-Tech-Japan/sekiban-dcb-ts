import { describe, expect, it, vi } from "vitest";

import {
  assertB0Evidence,
  assertEligiblePhaseWindow,
  assertIdleRequestReferences,
  assertObservationStream,
  assertTraceCohort,
  G30_WINDOW_RESET_LIMIT,
  observationLedgerForPhase,
} from "../scripts/g30-b0-contract.mjs";
import { assertConformancePropagationRetry, assertG30Config, assertPhaseRuntimeIsolation, assertRemoteMigrationPreflight, assertWitnessCaptureShellSafety, assertWitnessReplaySnapshotSafety } from "../scripts/g30-config-check.mjs";
import {
  acquireCohortTelemetry,
  buildBoundedTelemetryQuery,
  clientRequestIdByPlatformRayId,
  CLOUDFLARE_TELEMETRY_MAX_FILTER_NODES,
  cohortValuesFilter,
  exportDeadline,
  exportCohortTelemetry,
  normalizeTelemetryBundle,
  normalizeTelemetryExport,
  queryTelemetry,
  TELEMETRY_QUERY_VALUE_BATCH,
  TELEMETRY_RETRY_DELAY_MS,
  telemetryFilterNodeCount,
} from "../scripts/deploy/g30-trace-export.mjs";
import {
  assertDeploymentWitness,
  buildHeadReadFailureEvidence,
  establishB0Consistency,
  G30PhaseMeasurementFailure,
  G30HeadReadFailure,
  MAX_WINDOW_RESETS,
  measureB0Phase,
} from "../scripts/deploy/g30-b0-measure.mjs";
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

function sortableHead(index: number): string {
  return `063923208896355${String(index).padStart(15, "0")}`;
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

function rawTelemetry(ledger: ReadonlyArray<Record<string, unknown>>, includeFault = true) {
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
  if (includeFault) {
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

function setDistinctClientLatencies(ledger: Array<Record<string, unknown>>) {
  for (const [index, record] of ledger.entries()) {
    const responseLatencyMs = index + 1;
    record.responseLatencyMs = responseLatencyMs;
    record.completedAtMs = Number(record.startedAtMs) + responseLatencyMs;
  }
}

function withoutTrace(document: ReturnType<typeof evidence>, requestIds: readonly string[]) {
  const removed = new Set(requestIds);
  document.traces = document.traces.filter((trace) => !removed.has(trace.requestId));
  document.observationTraces = document.observationTraces.filter((trace) => !removed.has(trace.requestId));
  document.observations = document.observations.filter((observation) => !removed.has(observation.requestId));
  return document;
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

  it("takes phase continuity from the durable fixed-tag head", async () => {
    const observedHead = sortableHead(37);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      expect(String(input)).toContain("/conformance/v1/api/sekiban/serialized/tag-latest-sortable");
      return new Response(JSON.stringify({ exists: true, lastSortableUniqueId: observedHead }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      await expect(establishB0Consistency({ baseUrl: "https://g30.test", token: "fixture-token" })).resolves.toEqual({
        head: observedHead,
        source: "existing-fixed-tag-head",
        seeded: false,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("retries only a transient post-deploy 403 before reading the durable fixed-tag head", async () => {
    const observedHead = sortableHead(38);
    let calls = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "Conformance authentication required", code: "unauthorized" }), {
          status: 403,
          headers: { "content-type": "application/json", "cf-ray": "propagation-403-SJC" },
        });
      }
      return new Response(JSON.stringify({ exists: true, lastSortableUniqueId: observedHead }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      await expect(establishB0Consistency({
        baseUrl: "https://g30.test",
        token: "fixture-token",
        conformanceRetryAttempts: 2,
        conformanceRetryDelayMs: 0,
      })).resolves.toEqual({ head: observedHead, source: "existing-fixed-tag-head", seeded: false });
      expect(calls).toBe(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("seeds the fixed tag only after a durable empty read", async () => {
    const seededHead = sortableHead(1);
    const requestPaths: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requestPaths.push(String(input));
      if (requestPaths.length === 1) {
        return new Response(JSON.stringify({ exists: false, lastSortableUniqueId: "" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      bodies.push(JSON.parse(String((init as RequestInit | undefined)?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        writtenEvents: [{ id: "seed-event", sortableUniqueIdValue: seededHead }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      await expect(establishB0Consistency({ baseUrl: "https://g30.test", token: "fixture-token" })).resolves.toEqual({
        head: seededHead,
        source: "one-time-fixed-tag-seed",
        seeded: true,
        seedEventId: "seed-event",
      });
      expect(requestPaths).toHaveLength(2);
      expect(requestPaths[0]).toContain("/conformance/v1/api/sekiban/serialized/tag-latest-sortable");
      expect(requestPaths[1]).toContain("/conformance/v1/api/sekiban/serialized/commit");
      expect(bodies).toEqual([{
        version: 1,
        eventCandidates: expect.any(Array),
        consistencyTags: [],
      }]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("retains the full authenticated fixed-tag error body, cf-ray, and response time before failing closed", async () => {
    const body = {
      error: "Read could not determine the durable tag state",
      code: "internal_error",
      detail: {
        errorClass: "ReadFailure",
        message: "Read-side SafeWindow ceiling exceeded; durable state is indeterminate",
        failingSubCall: "ensureWindowDeterminate",
        serviceIdUsed: SERVICE,
        dynamicLagBoundMs: 70_797_953,
        rowFound: true,
        rawEstimateMs: 70_797_953,
        rawObservedAt: 1_787_672_393_000,
        nowMs: 1_787_686_565_000,
      },
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), {
      status: 500,
      headers: { "content-type": "application/json", "cf-ray": "head-read-ray-SJC" },
    }));
    try {
      let failure: unknown;
      try {
        await establishB0Consistency({ baseUrl: "https://g30.test", token: "fixture-token" });
      } catch (caught) {
        failure = caught;
      }
      expect(failure).toBeInstanceOf(G30HeadReadFailure);
      const evidence = buildHeadReadFailureEvidence({
        phase: "A",
        sourceCommit: "a".repeat(40),
        configDigest: "b".repeat(64),
      }, failure as G30HeadReadFailure);
      expect(evidence).toMatchObject({
        phase: "A",
        sourceCommit: "a".repeat(40),
        configDigest: "b".repeat(64),
        response: {
          status: 500,
          cfRay: "head-read-ray-SJC",
          body,
          rawBody: JSON.stringify(body),
          receivedAt: expect.any(String),
          receivedAtMs: expect.any(Number),
        },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("requires the fixed 15x1s conformance propagation retry for every phase", () => {
    const runbook = [
      "readonly CONFORMANCE_RETRY_ATTEMPTS=15",
      "readonly CONFORMANCE_RETRY_DELAY_MS=1000",
      'node g30-b0-measure.mjs --phase A --conformance-retry-attempts "${CONFORMANCE_RETRY_ATTEMPTS}" --conformance-retry-delay-ms "${CONFORMANCE_RETRY_DELAY_MS}"',
      'node g30-b0-measure.mjs --phase B --conformance-retry-attempts "${CONFORMANCE_RETRY_ATTEMPTS}" --conformance-retry-delay-ms "${CONFORMANCE_RETRY_DELAY_MS}"',
      'node g30-b0-measure.mjs --phase A-prime --conformance-retry-attempts "${CONFORMANCE_RETRY_ATTEMPTS}" --conformance-retry-delay-ms "${CONFORMANCE_RETRY_DELAY_MS}"',
    ].join("\n");
    expect(assertConformancePropagationRetry(runbook)).toEqual({
      conformancePropagationRetry: { attempts: 15, delayMs: 1_000, retryStatus: 403, nonAuthFailures: "fail-closed" },
    });
    expect(() => assertConformancePropagationRetry(runbook.replace("readonly CONFORMANCE_RETRY_ATTEMPTS=15", "readonly CONFORMANCE_RETRY_ATTEMPTS=1"))).toThrow(/15x1s/);
  });

  it("requires raw durable reread evidence for every retained B0 window reset", () => {
    const retained = records("A", 100);
    const rawAttempts = [
      {
        kind: "discarded-window-entry",
        resetNumber: 1,
        priorWindowOrdinal: 0,
        record: structuredClone(retained[0]),
      },
      {
        kind: "window-reset-trigger",
        resetNumber: 1,
        priorWindowCount: 1,
        sameAttemptResent: false,
        trigger: "http-non-200",
        expectedConsistencyHead: sortableHead(6),
        response: {
          status: 504,
          cfRay: "timeout-504-SJC",
          startedAtMs: 1_000,
          receivedAtMs: 22_500,
          receivedAt: "2026-08-26T00:00:22.500Z",
          body: { error: "Commit outcome is undetermined", code: "timeout" },
          rawBody: '{"error":"Commit outcome is undetermined","code":"timeout"}',
        },
        readback: {
          kind: "fixed-tag-head-reread",
          endpoint: "/conformance/v1/api/sekiban/serialized/tag-latest-sortable",
          head: sortableHead(7),
          classification: "advanced",
          statusRaw: {
            httpStatus: 200,
            cfRay: "reread-504-SJC",
            receivedAtMs: 22_600,
            receivedAt: "2026-08-26T00:00:22.600Z",
          },
        },
      },
    ];
    expect(assertEligiblePhaseWindow("A", retained, rawAttempts, 1)).toMatchObject({ phase: "A" });
    expect(() => assertEligiblePhaseWindow("A", retained, rawAttempts.map((entry) => entry.kind === "window-reset-trigger" ? { ...entry, sameAttemptResent: true } : entry), 1)).toThrow(/window-reset-retry/);
    expect(() => assertEligiblePhaseWindow("A", retained, rawAttempts.map((entry) => entry.kind === "window-reset-trigger" ? { ...entry, readback: undefined } : entry), 1)).toThrow(/window-reset-reread/);
    expect(() => assertEligiblePhaseWindow("A", retained, rawAttempts, G30_WINDOW_RESET_LIMIT + 1)).toThrow(/window-reset-limit/);
  });

  it("chains one fixed tag's observed head through every B0 commit", async () => {
    const sourceCommit = "a".repeat(40);
    const configDigest = "b".repeat(64);
    const witness = {
      task: "SDT-G30",
      phase: "B",
      sourceCommit,
      configDigest,
      placement: "off",
      serviceId: SERVICE,
      worker: "sekiban-dcb-meeting-room-cloudflare-only",
      deployedVersion: {
        id: "fixture-version",
        number: 1,
        createdOn: "2026-08-24T00:00:00.000Z",
        message: deploymentMessage("B", sourceCommit, configDigest, SERVICE),
      },
    };
    const bodies: Array<{ consistencyTags?: Array<{ tag?: string; lastSortableUniqueId?: string }> }> = [];
    let writes = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      bodies.push(JSON.parse(String((init as RequestInit | undefined)?.body)) as { consistencyTags?: Array<{ tag?: string; lastSortableUniqueId?: string }> });
      writes += 1;
      return new Response(JSON.stringify({
        writtenEvents: [{ id: `event-${writes}`, sortableUniqueIdValue: sortableHead(writes) }],
      }), {
        status: 200,
        headers: { "content-type": "application/json", "cf-ray": `a${writes.toString(16).padStart(15, "0")}-LAX` },
      });
    });
    try {
      const phase = await measureB0Phase({
        baseUrl: "https://g30.test",
        token: "fixture-token",
        phase: "B",
        sourceCommit,
        configDigest,
        deploymentWitness: witness,
        consistencyHead: sortableHead(0),
        sleepFor: async () => undefined,
      });
      expect(bodies).toHaveLength(108);
      expect(bodies.map((body) => body.consistencyTags)).toEqual(Array.from({ length: 108 }, (_, index) => ([{
        tag: "room:g30-baseline",
        lastSortableUniqueId: sortableHead(index),
      }])));
      const measured = phase as {
        consistency: { initialHead: string; finalHead: string };
        ledger: Array<{ consistencyHead: string }>;
      };
      expect(measured.consistency).toMatchObject({ initialHead: sortableHead(0), finalHead: sortableHead(108) });
      expect(measured.ledger.every((entry, index) => entry.consistencyHead === sortableHead(index + 5))).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("resets the retained window after a 504 without resending its attempt", async () => {
    const sourceCommit = "a".repeat(40);
    const configDigest = "b".repeat(64);
    const witness = {
      task: "SDT-G30",
      phase: "A",
      sourceCommit,
      configDigest,
      placement: "off",
      serviceId: SERVICE,
      worker: "sekiban-dcb-meeting-room-cloudflare-only",
      deployedVersion: {
        id: "fixture-version",
        number: 1,
        createdOn: "2026-08-24T00:00:00.000Z",
        message: deploymentMessage("A", sourceCommit, configDigest, SERVICE),
      },
    };
    const consistencyHeads: string[] = [];
    let commits = 0;
    let rereads = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/tag-latest-sortable")) {
        rereads += 1;
        return new Response(JSON.stringify({ exists: true, lastSortableUniqueId: sortableHead(7) }), {
          status: 200,
          headers: { "content-type": "application/json", "cf-ray": "reread-504-SJC" },
        });
      }
      const body = JSON.parse(String((init as RequestInit | undefined)?.body)) as {
        consistencyTags?: Array<{ lastSortableUniqueId?: string }>;
      };
      consistencyHeads.push(String(body.consistencyTags?.[0]?.lastSortableUniqueId));
      commits += 1;
      if (commits === 7) {
        return new Response(JSON.stringify({ error: "Commit outcome is undetermined", code: "timeout" }), {
          status: 504,
          headers: { "content-type": "application/json", "cf-ray": "timeout-504-SJC" },
        });
      }
      return new Response(JSON.stringify({
        writtenEvents: [{ id: `event-${commits}`, sortableUniqueIdValue: sortableHead(commits) }],
      }), {
        status: 200,
        headers: { "content-type": "application/json", "cf-ray": `commit-${commits}-SJC` },
      });
    });
    try {
      const phase = await measureB0Phase({
        baseUrl: "https://g30.test",
        token: "fixture-token",
        phase: "A",
        sourceCommit,
        configDigest,
        deploymentWitness: witness,
        consistencyHead: sortableHead(0),
        conformanceRetryAttempts: 1,
        conformanceRetryDelayMs: 0,
        sleepFor: async () => undefined,
      }) as {
        ledger: Array<{ index: number; consistencyHead: string }>;
        rawAttempts: Array<Record<string, unknown>>;
        windowResets: number;
        consistency: { initialHead: string; finalHead: string };
      };
      expect(commits).toBe(107); // five warmups + one discarded + one 504 + 100 retained
      expect(rereads).toBe(1);
      expect(consistencyHeads.filter((head) => head === sortableHead(6))).toHaveLength(1);
      expect(consistencyHeads[7]).toBe(sortableHead(7));
      expect(phase.windowResets).toBe(1);
      expect(phase.ledger).toHaveLength(100);
      expect(phase.ledger.map((entry) => entry.index)).toEqual(Array.from({ length: 100 }, (_, index) => index));
      expect(phase.ledger[0]?.consistencyHead).toBe(sortableHead(7));
      expect(phase.consistency).toMatchObject({ initialHead: sortableHead(0), finalHead: sortableHead(107) });
      expect(phase.rawAttempts).toMatchObject([
        {
          kind: "discarded-window-entry",
          resetNumber: 1,
          priorWindowOrdinal: 0,
          record: { consistencyHead: sortableHead(5) },
        },
        {
          kind: "window-reset-trigger",
          resetNumber: 1,
          priorWindowCount: 1,
          sameAttemptResent: false,
          trigger: "http-non-200",
          expectedConsistencyHead: sortableHead(6),
          response: {
            status: 504,
            cfRay: "timeout-504-SJC",
            body: { code: "timeout" },
            rawBody: expect.stringContaining("timeout"),
          },
          readback: {
            kind: "fixed-tag-head-reread",
            head: sortableHead(7),
            classification: "advanced",
            statusRaw: { httpStatus: 200, cfRay: "reread-504-SJC" },
          },
        },
      ]);
      expect(JSON.stringify(phase.rawAttempts)).not.toContain("room:g30-baseline");
      expect(JSON.stringify(phase.rawAttempts)).not.toContain("fixture-token");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("stops with reset distribution evidence after more than five indeterminate attempts", async () => {
    const sourceCommit = "a".repeat(40);
    const configDigest = "b".repeat(64);
    const witness = {
      task: "SDT-G30",
      phase: "A",
      sourceCommit,
      configDigest,
      placement: "off",
      serviceId: SERVICE,
      worker: "sekiban-dcb-meeting-room-cloudflare-only",
      deployedVersion: {
        id: "fixture-version",
        number: 1,
        createdOn: "2026-08-24T00:00:00.000Z",
        message: deploymentMessage("A", sourceCommit, configDigest, SERVICE),
      },
    };
    let commits = 0;
    let rereads = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/tag-latest-sortable")) {
        rereads += 1;
        return new Response(JSON.stringify({ exists: true, lastSortableUniqueId: sortableHead(5) }), {
          status: 200,
          headers: { "content-type": "application/json", "cf-ray": `reread-${rereads}-SJC` },
        });
      }
      commits += 1;
      if (commits <= 5) {
        return new Response(JSON.stringify({
          writtenEvents: [{ id: `warm-${commits}`, sortableUniqueIdValue: sortableHead(commits) }],
        }), {
          status: 200,
          headers: { "content-type": "application/json", "cf-ray": `warm-${commits}-SJC` },
        });
      }
      return new Response(JSON.stringify({ error: "Commit outcome is undetermined", code: "timeout" }), {
        status: 504,
        headers: { "content-type": "application/json", "cf-ray": `timeout-${commits}-SJC` },
      });
    });
    try {
      let failure: unknown;
      try {
        await measureB0Phase({
          baseUrl: "https://g30.test",
          token: "fixture-token",
          phase: "A",
          sourceCommit,
          configDigest,
          deploymentWitness: witness,
          consistencyHead: sortableHead(0),
          conformanceRetryAttempts: 1,
          conformanceRetryDelayMs: 0,
          sleepFor: async () => undefined,
        });
      } catch (caught) {
        failure = caught;
      }
      expect(failure).toBeInstanceOf(G30PhaseMeasurementFailure);
      const record = (failure as G30PhaseMeasurementFailure).record as {
        reason: string;
        resetCount: number;
        resetLimit: number;
        rawAttempts: Array<Record<string, unknown>>;
      };
      expect(record.reason).toBe("window-reset-limit-exceeded");
      expect(record.resetCount).toBe(MAX_WINDOW_RESETS + 1);
      expect(record.resetLimit).toBe(MAX_WINDOW_RESETS);
      expect(record.rawAttempts.filter((entry) => entry.kind === "window-reset-trigger")).toHaveLength(MAX_WINDOW_RESETS + 1);
      expect(record.rawAttempts.every((entry) => entry.sameAttemptResent !== true)).toBe(true);
      expect(commits).toBe(5 + MAX_WINDOW_RESETS + 1);
      expect(rereads).toBe(MAX_WINDOW_RESETS + 1);
    } finally {
      fetchSpy.mockRestore();
    }
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

  it("rejects a telemetry query that exceeds Cloudflare's 16-node filter budget", () => {
    const template = {
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
    };
    const workerFilters = [
      { key: "schema", operation: "eq", type: "string", value: "sdt.observe/v1" },
      { key: "event", operation: "eq", type: "string", value: "worker.invocation" },
    ];
    const values = (count: number) => ({
      kind: "group",
      filterCombination: "or",
      filters: Array.from({ length: count }, (_, index) => ({
        key: "requestId", operation: "eq", type: "string", value: `request-${index}`,
      })),
    });
    const atBudget = buildBoundedTelemetryQuery(template, [...workerFilters, values(10)]);
    expect(TELEMETRY_QUERY_VALUE_BATCH).toBe(10);
    expect(telemetryFilterNodeCount((atBudget.parameters as { filters: Record<string, unknown>[] }).filters)).toBe(CLOUDFLARE_TELEMETRY_MAX_FILTER_NODES);
    expect(() => buildBoundedTelemetryQuery(template, [...workerFilters, values(11)])).toThrow(/query-node-budget/);
  });

  it("serializes multi-value cohort filters as provider IN membership", () => {
    const filter = cohortValuesFilter("$metadata.rayId", ["a305f10b2c5478da", "a305fb3efb57939b"]);
    expect(filter).toEqual({
      key: "$metadata.rayId",
      operation: "in",
      type: "string",
      value: "a305f10b2c5478da,a305fb3efb57939b",
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

  it("retries an initially incomplete cohort before the B export deadline", async () => {
    const document = evidence();
    const observationLedger = observationLedgerForPhase(document.phases.B);
    const retainedRequestIds = new Set(document.phases.B.ledger.map((record) => record.requestId));
    const sleeps: number[] = [];
    let attempts = 0;
    let now = Number(document.phases.B.ledger.at(-1)!.completedAtMs) + 1;
    const acquisition = await acquireCohortTelemetry({
      deadlineMs: exportDeadline(document.phases.B.ledger),
      fetchCohort: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("g30-trace-export:cohort-worker:initial Workers Logs batch has not arrived");
        }
        return rawTelemetry(observationLedger);
      },
      validate: (raw) => {
        const bundle = normalizeTelemetryBundle(raw, now);
        const traces = bundle.traces.filter((trace) => retainedRequestIds.has(trace.requestId));
        const proof = assertTraceCohort(document.phases.B.ledger, traces, now);
        assertObservationStream(observationLedger, bundle.traces, bundle.observations);
        return proof;
      },
      now: () => now,
      sleepFor: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([TELEMETRY_RETRY_DELAY_MS]);
    expect(acquisition.value).toMatchObject({ requestCount: 100 });
  });

  it("retries an incomplete success trace before the B export deadline", async () => {
    const document = evidence();
    const observationLedger = observationLedgerForPhase(document.phases.B);
    const retainedRequestIds = new Set(document.phases.B.ledger.map((record) => record.requestId));
    const sleeps: number[] = [];
    let fetches = 0;
    let validations = 0;
    let now = Number(document.phases.B.ledger.at(-1)!.completedAtMs) + 1;
    const acquisition = await acquireCohortTelemetry({
      deadlineMs: exportDeadline(document.phases.B.ledger),
      fetchCohort: async () => {
        fetches += 1;
        return rawTelemetry(observationLedger);
      },
      validate: (raw) => {
        validations += 1;
        if (validations === 1) {
          throw new Error("g30-b0:trace-complete:initial custom-span cohort has not arrived");
        }
        const bundle = normalizeTelemetryBundle(raw, now);
        const traces = bundle.traces.filter((trace) => retainedRequestIds.has(trace.requestId));
        return assertTraceCohort(document.phases.B.ledger, traces, now);
      },
      now: () => now,
      sleepFor: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });
    expect(fetches).toBe(2);
    expect(validations).toBe(2);
    expect(sleeps).toEqual([TELEMETRY_RETRY_DELAY_MS]);
    expect(acquisition.value).toMatchObject({ requestCount: 100 });
  });

  it("retries a sub-budget cohort before the B export deadline", async () => {
    const document = evidence();
    const observationLedger = observationLedgerForPhase(document.phases.B);
    const retainedRequestIds = new Set(document.phases.B.ledger.map((record) => record.requestId));
    const sleeps: number[] = [];
    let validations = 0;
    let now = Number(document.phases.B.ledger.at(-1)!.completedAtMs) + 1;
    const acquisition = await acquireCohortTelemetry({
      deadlineMs: exportDeadline(document.phases.B.ledger),
      fetchCohort: async () => rawTelemetry(observationLedger),
      validate: (raw) => {
        validations += 1;
        if (validations === 1) throw new Error("g30-b0:delivery-budget:B schemaCompleteCount=94 is below frozen 95/100");
        const bundle = normalizeTelemetryBundle(raw, now);
        const traces = bundle.traces.filter((trace) => retainedRequestIds.has(trace.requestId));
        return assertTraceCohort(document.phases.B.ledger, traces, now);
      },
      now: () => now,
      sleepFor: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });
    expect(validations).toBe(2);
    expect(sleeps).toEqual([TELEMETRY_RETRY_DELAY_MS]);
    expect(acquisition.value).toMatchObject({ schemaCompleteCount: 100 });
  });

  it("rejects an unsealed D1 database identity before migration listing", () => {
    const config = {
      d1_databases: [
        { binding: "D1", database_id: "eccf6048-7fc8-4412-a157-9fa180353f6d", database_name: "sekiban-dcb-meeting-room-g32-9043d626fe1149cb-pipeline", migrations_dir: "../../migrations/d1/g32" },
        { binding: "D1_MV", database_id: "c733dfb2-013a-4a5d-a72c-47931a63bac4", database_name: "sekiban-dcb-meeting-room-g32-9043d626fe1149cb-mv", migrations_dir: "../../migrations/mv" },
      ],
    };
    const runbook = [
      'readonly PRIMARY_CONFIG_PATH="${REPO_ROOT}/samples/meeting-room/wrangler.g30-primary-off.jsonc"',
      "assert_no_remote_migrations() {",
      "  assert_sealed_d1_config",
      '  for binding in "${PRIMARY_D1_BINDINGS[@]}"; do',
      '    output="$(wrangler d1 migrations list "${binding}" --config "${PRIMARY_CONFIG_PATH}" --remote)"',
      "  done",
      "}",
    ].join("\n");
    config.d1_databases[0].database_id = "unsealed-database-id";
    expect(() => assertRemoteMigrationPreflight(config, runbook)).toThrow("database identity is not sealed");
  });

  it("rejects a direct durable database-name migration lookup", () => {
    const config = {
      d1_databases: [
        { binding: "D1", database_id: "eccf6048-7fc8-4412-a157-9fa180353f6d", database_name: "sekiban-dcb-meeting-room-g32-9043d626fe1149cb-pipeline", migrations_dir: "../../migrations/d1/g32" },
        { binding: "D1_MV", database_id: "c733dfb2-013a-4a5d-a72c-47931a63bac4", database_name: "sekiban-dcb-meeting-room-g32-9043d626fe1149cb-mv", migrations_dir: "../../migrations/mv" },
      ],
    };
    const runbook = [
      'readonly PRIMARY_CONFIG_PATH="${REPO_ROOT}/samples/meeting-room/wrangler.g30-primary-off.jsonc"',
      "assert_no_remote_migrations() {",
      "  assert_sealed_d1_config",
      '  for binding in "${PRIMARY_D1_BINDINGS[@]}"; do',
      '    output="$(wrangler d1 migrations list "${database}" --config "${PRIMARY_CONFIG_PATH}" --remote)"',
      "  done",
      "}",
    ].join("\n");
    expect(() => assertRemoteMigrationPreflight(config, runbook)).toThrow("must use a binding");
  });

  it("rejects a cwd-relative config before remote migration listing", () => {
    const config = {
      d1_databases: [
        { binding: "D1", database_id: "eccf6048-7fc8-4412-a157-9fa180353f6d", database_name: "sekiban-dcb-meeting-room-g32-9043d626fe1149cb-pipeline", migrations_dir: "../../migrations/d1/g32" },
        { binding: "D1_MV", database_id: "c733dfb2-013a-4a5d-a72c-47931a63bac4", database_name: "sekiban-dcb-meeting-room-g32-9043d626fe1149cb-mv", migrations_dir: "../../migrations/mv" },
      ],
    };
    const runbook = [
      'readonly PRIMARY_CONFIG_PATH="${REPO_ROOT}/samples/meeting-room/wrangler.g30-primary-off.jsonc"',
      "assert_no_remote_migrations() {",
      "  assert_sealed_d1_config",
      '  for binding in "${PRIMARY_D1_BINDINGS[@]}"; do',
      '    output="$(wrangler d1 migrations list "${binding}" --cwd samples/meeting-room --config "wrangler.g30-primary-off.jsonc" --remote)"',
      "  done",
      "}",
    ].join("\n");
    expect(() => assertRemoteMigrationPreflight(config, runbook)).toThrow("ID-verified absolute config path");
  });

  it("classifies a telemetry group without an S00 root as root-absent instead of matching by time", () => {
    const raw = rawTelemetry(observationLedgerForPhase(evidence().phases.B));
    raw.events = raw.events.filter((entry) => !(
      entry.$metadata?.traceId === "trace-B-99" && entry.attributes?.operation === "sdt.commit"
    ));
    const document = evidence();
    const retained = new Set(document.phases.B.ledger.map((record) => String(record.requestId)));
    const traces = normalizeTelemetryExport(raw).filter((trace) => retained.has(trace.requestId));
    const proof = assertTraceCohort(document.phases.B.ledger, traces, document.traceExportCompletedAtMs);
    expect(proof.missing).toMatchObject([{ requestId: "B-99", stage: "root-absent" }]);
  });

  it("classifies a non-runtime-verified root as schema-incomplete rather than silently passing it", () => {
    const document = structuredClone(evidence());
    const trace = document.traces.find((entry) => entry.requestId === "B-99");
    if (trace === undefined) throw new Error("fixture lacks B-99 trace");
    trace.runtimeVerified = false;
    const proof = assertTraceCohort(
      document.phases.B.ledger,
      document.traces,
      document.traceExportCompletedAtMs,
    );
    expect(proof.missing).toMatchObject([{ requestId: "B-99", stage: "schema-incomplete" }]);
  });

  it("keeps a dropped non-tail trace in the fixed denominator as UNKNOWN", () => {
    const document = evidence();
    document.traces = document.traces.filter((trace) => trace.requestId !== "B-99");
    const proof = assertTraceCohort(document.phases.B.ledger, document.traces, document.traceExportCompletedAtMs);
    expect(proof).toMatchObject({ clientCount: 100, schemaCompleteCount: 99, missingCount: 1 });
    expect(proof.missing).toMatchObject([{ requestId: "B-99", clientLatency: 108, stage: "root-absent" }]);
  });

  it("enforces the 95-of-100 delivery boundary per phase without shrinking the client denominator", () => {
    const document = evidence();
    setDistinctClientLatencies(document.phases.B.ledger);
    const pass = withoutTrace(structuredClone(document), ["B-0", "B-1", "B-2", "B-3", "B-4"]);
    const passProof = assertTraceCohort(pass.phases.B.ledger, pass.traces, pass.traceExportCompletedAtMs);
    expect(passProof).toMatchObject({ clientCount: 100, schemaCompleteCount: 95, missingCount: 5 });
    expect(passProof.latency).toMatchObject({ universe: "full-100-client-ledger", p50: 50, p95: 95, p99: 99 });

    const fail = withoutTrace(structuredClone(document), ["B-0", "B-1", "B-2", "B-3", "B-4", "B-5"]);
    expect(() => assertTraceCohort(fail.phases.B.ledger, fail.traces, fail.traceExportCompletedAtMs)).toThrow(/delivery-budget/);
  });

  it("uses the exact rank-1..5 client-latency tail set, including a deterministic rank-5/6 tie", () => {
    const document = evidence();
    for (const record of document.phases.B.ledger) {
      record.responseLatencyMs = 1;
      record.completedAtMs = Number(record.startedAtMs) + 1;
    }
    // Deliberately invert the immutable ledger encounter order for the tied
    // identities. The rank rule is requestId ascending, never stable-input
    // ordering, so B-94 must precede B-95 despite appearing later here.
    [document.phases.B.ledger[94]!.requestId, document.phases.B.ledger[95]!.requestId] = [
      document.phases.B.ledger[95]!.requestId,
      document.phases.B.ledger[94]!.requestId,
    ];
    const latency = new Map([["B-99", 1_000], ["B-98", 999], ["B-97", 998], ["B-96", 997], ["B-94", 996], ["B-95", 996]]);
    for (const record of document.phases.B.ledger) {
      const value = latency.get(String(record.requestId));
      if (value === undefined) continue;
      record.responseLatencyMs = value;
      record.completedAtMs = Number(record.startedAtMs) + value;
    }
    const proof = assertTraceCohort(document.phases.B.ledger, document.traces, document.traceExportCompletedAtMs);
    expect(proof.tailCoverage.requestIds).toEqual(["B-99", "B-98", "B-97", "B-96", "B-94"]);
    const rankSixMissing = withoutTrace(structuredClone(document), ["B-95"]);
    expect(assertTraceCohort(rankSixMissing.phases.B.ledger, rankSixMissing.traces, rankSixMissing.traceExportCompletedAtMs).tailCoverage.requestIds)
      .toEqual(["B-99", "B-98", "B-97", "B-96", "B-94"]);
    const rankFiveMissing = withoutTrace(structuredClone(document), ["B-94"]);
    expect(() => assertTraceCohort(rankFiveMissing.phases.B.ledger, rankFiveMissing.traces, rankFiveMissing.traceExportCompletedAtMs)).toThrow(/tail-coverage/);
  });

  it("records a per-missing sensitivity source and keeps per-hop aggregates conditional", () => {
    const document = structuredClone(evidence());
    setDistinctClientLatencies(document.phases.B.ledger);
    const incomplete = document.traces.find((trace) => trace.requestId === "B-1");
    if (incomplete === undefined) throw new Error("fixture lacks B-1 trace");
    incomplete.complete = false;
    incomplete.runtimeVerified = false;
    document.traces = document.traces.filter((trace) => trace.requestId !== "B-0");
    const proof = assertTraceCohort(document.phases.B.ledger, document.traces, document.traceExportCompletedAtMs);
    expect(proof.missing).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: "B-0", stage: "root-absent", sensitivityEnvelope: expect.objectContaining({ upperBoundSource: "client-latency", upperBoundMs: 1 }) }),
      expect.objectContaining({ requestId: "B-1", stage: "schema-incomplete", sensitivityEnvelope: expect.objectContaining({ upperBoundSource: "observed-root-duration" }) }),
    ]));
    expect(proof.perHop).toMatchObject({ wholeCohortConclusion: false, joinedRequestCount: 98, missingRequestCount: 2 });
    expect(proof.unattributed).toHaveLength(98);
  });

  it("applies the delivery ceiling to the B phase independently rather than aggregating another phase", () => {
    const document = evidence();
    setDistinctClientLatencies(document.phases.A.ledger);
    const aTraces = normalizeTelemetryBundle(rawTelemetry(document.phases.A.ledger, false), document.traceExportCompletedAtMs).traces;
    const incompleteA = aTraces.filter((trace) => !["A-0", "A-1", "A-2", "A-3", "A-4", "A-5"].includes(trace.requestId));
    expect(() => assertTraceCohort(document.phases.A.ledger, incompleteA, document.traceExportCompletedAtMs, "A")).toThrow(/delivery-budget/);
    expect(assertTraceCohort(document.phases.B.ledger, document.traces, document.traceExportCompletedAtMs)).toMatchObject({ schemaCompleteCount: 100 });
  });

  it("allows only the explicitly enumerated AC5 UNKNOWN set through the joined observation stream", () => {
    const document = structuredClone(evidence());
    setDistinctClientLatencies(document.phases.B.ledger);
    withoutTrace(document, ["B-0", "B-1", "B-2", "B-3", "B-4"]);
    document.observations = document.observations.filter((entry) => entry.event !== "fault.barrier");
    const result = assertB0Evidence(document) as { traces: { clientCount: number; schemaCompleteCount: number; missing: Array<{ requestId: string; stage: string }> } };
    expect(result.traces).toMatchObject({ clientCount: 100, schemaCompleteCount: 95 });
    expect(result.traces.missing.map((entry) => entry.requestId)).toEqual(["B-4", "B-3", "B-2", "B-1", "B-0"]);

    const unjoined = structuredClone(document);
    unjoined.observations = [...unjoined.observations, structuredClone(evidence().observations.find((entry) => entry.requestId === "B-0")!)];
    expect(() => assertB0Evidence(unjoined)).toThrow(/observation\[.*\]-trace-join/);
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

  it("preserves the POP-suffixed client CF-Ray across the platform ray-id join", () => {
    const clientRequestId = "a304f4ff2b982517-SJC";
    const platformRayId = "a304f4ff2b982517";
    const ledger = [{ requestId: clientRequestId, startedAtMs: 1_000, completedAtMs: 1_100 }];
    const raw = rawTelemetry(ledger, false);
    const worker = raw.events.find((entry) => entry.source?.event === "worker.invocation");
    if (worker?.source === undefined || worker.$metadata === undefined) throw new Error("fixture lacks worker observation");
    worker.source.requestId = platformRayId;
    worker.$metadata.rayId = platformRayId;
    const mapping = clientRequestIdByPlatformRayId(ledger);
    expect(mapping.get(platformRayId)).toBe(clientRequestId);
    expect(normalizeTelemetryBundle(raw, 1_101, mapping).traces).toMatchObject([{ requestId: clientRequestId }]);
  });

  it("discovers a rayless S00 root through exact worker-observation correlation", async () => {
    const clientRequestId = "a304f4ff2b982517-SJC";
    const platformRayId = "a304f4ff2b982517";
    const correlationId = `corr-${clientRequestId}`;
    const ledger = [{ index: 0, requestId: clientRequestId, startedAtMs: 1_000, completedAtMs: 1_100, responseLatencyMs: 100 }];
    const raw = rawTelemetry(ledger, false);
    const worker = raw.events.find((entry) => entry.source?.event === "worker.invocation");
    const root = raw.events.find((entry) => entry.attributes?.operation === "sdt.commit");
    if (worker?.source === undefined || worker.$metadata === undefined || root?.$metadata === undefined) {
      throw new Error("fixture lacks worker or S00 root");
    }
    worker.source.requestId = platformRayId;
    worker.$metadata.rayId = platformRayId;
    delete root.$metadata.rayId;

    const workerEvents = raw.events.filter((entry) => entry.source?.event === "worker.invocation");
    const correlationRootEvents = [root];
    const traceEvents = raw.events.filter((entry) => entry.attributes !== undefined);
    const observationEvents = raw.events.filter((entry) => entry.source?.schema === "sdt.observe/v1");
    const requests: Array<Record<string, unknown>> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { parameters?: { filters?: Array<Record<string, unknown>> } };
      requests.push(body as Record<string, unknown>);
      const filters = body.parameters?.filters ?? [];
      const has = (key: string, value?: string) => filters.some((filter) => filter.key === key && (value === undefined || filter.value === value));
      const events = has("$metadata.traceId")
        ? traceEvents
        : has("correlation.id")
          ? correlationRootEvents
          : has("correlationId")
            ? observationEvents
            : has("$metadata.rayId", platformRayId)
              ? workerEvents
              : [];
      return new Response(JSON.stringify({ success: true, result: { events: { count: events.length, events } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const exported = await exportCohortTelemetry({
        accountId: "account",
        token: "redacted",
        template: {
          view: "events",
          limit: 2_000,
          parameters: {
            filterCombination: "or",
            filters: [
              { key: "$workers.scriptName", operation: "eq", type: "string", value: "primary" },
              { key: "$workers.scriptName", operation: "eq", type: "string", value: "receiver" },
            ],
          },
        },
        ledger,
      });
      const normalized = normalizeTelemetryBundle(exported, 1_101, clientRequestIdByPlatformRayId(ledger));
      expect(normalized.traces).toMatchObject([{ requestId: clientRequestId, complete: true, runtimeVerified: true }]);
      expect(requests.some((body) => {
        const filters = (body.parameters as { filters?: Array<Record<string, unknown>> }).filters ?? [];
        return filters.some((filter) => filter.key === "correlation.id" && filter.operation === "in" && filter.value === correlationId)
          && filters.some((filter) => filter.key === "$metadata.spanName" && filter.value === "sdt.commit");
      })).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects a structured observation that lacks its existing trace correlation", () => {
    const raw = rawTelemetry(observationLedgerForPhase(evidence().phases.B));
    const observation = raw.events.find((entry) => entry.source?.event === "worker.invocation");
    if (observation?.source === undefined) throw new Error("fixture lacks worker event");
    delete observation.source.correlationId;
    expect(() => normalizeTelemetryExport(raw)).toThrow(/observation-correlation/);
  });

  it("classifies a root with a missing worker observation as schema-incomplete", () => {
    const requestId = "a304f4ff2b982517-SJC";
    const raw = rawTelemetry([{ index: 0, requestId, startedAtMs: 1_000, completedAtMs: 1_100, responseLatencyMs: 100 }], false);
    raw.events = raw.events.filter((entry) => entry.source?.event !== "worker.invocation");
    const normalized = normalizeTelemetryBundle(raw, 1_101, clientRequestIdByPlatformRayId([{ requestId, startedAtMs: 1_000, completedAtMs: 1_100 }]));
    expect(normalized.traces).toMatchObject([{ requestId, complete: false, runtimeVerified: false }]);
  });

  it("rejects a worker observation without the client CF-Ray used by the ledger", () => {
    const requestId = "a304f4ff2b982517-SJC";
    const ledger = [{ index: 0, requestId, startedAtMs: 1_000, completedAtMs: 1_100, responseLatencyMs: 100 }];
    const raw = rawTelemetry(ledger, false);
    const observation = raw.events.find((entry) => entry.source?.event === "worker.invocation");
    if (observation?.source === undefined) throw new Error("fixture lacks worker event");
    delete observation.source.requestId;
    expect(() => normalizeTelemetryBundle(raw, 1_101, clientRequestIdByPlatformRayId(ledger))).toThrow(/observation-request-id/);
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
