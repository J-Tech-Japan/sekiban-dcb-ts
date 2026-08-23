import { describe, expect, it } from "vitest";

import {
  assertB0Evidence,
  assertActivationIdleEvidence,
  assertEligiblePhaseWindow,
  assertOutlierClassification,
  assertTraceCohort,
  assertWarmupProof,
  G30_CADENCE_MS,
  G30_IDLE_SCHEDULE_MS,
  G30_SAMPLE_COUNT,
} from "../scripts/g30-b0-contract.mjs";
import { assertG30Config, assertPhaseRuntimeIsolation } from "../scripts/g30-config-check.mjs";
import { normalizeTelemetryExport } from "../scripts/deploy/g30-trace-export.mjs";
import { assertDeploymentWitness } from "../scripts/deploy/g30-b0-measure.mjs";
import { deploymentMessage } from "../scripts/deploy/g30-deployment-witness.mjs";
import manifest from "../contracts/commit-trace-manifest.json";
import meetingRoomWorker, { type MeetingRoomCloudflareEnv } from "../samples/meeting-room/src/worker.cloudflare-only";

type Phase = "A" | "B" | "A-prime";

const SERVICE = "g32-9043d626fe1149cb";
function deploymentConfig(sample: 0 | 1): Record<string, unknown> {
  return {
    name: "g30-fixture",
    main: "src/worker.cloudflare-only.ts",
    observability: { enabled: true, traces: { enabled: true, persist: true, head_sampling_rate: sample } },
    vars: { SDT_SERVICE_ID: SERVICE },
  };
}
const primaryOff = deploymentConfig(0);
const primaryOn = deploymentConfig(1);
const receiverOff = deploymentConfig(0);
const ROOT_ROWS = manifest.schemas["sdt.commit/v1"].boundaries
  .find((boundary) => boundary.name === "success")!.requiredRows;

function actorClass(emitter: string): string {
  if (emitter === "root-worker") return "ROOT";
  if (emitter === "allocator-do") return "ALLOCATOR";
  if (emitter === "journal-do") return "JOURNAL";
  if (emitter === "callee-do") return "TAG";
  return "ROOT";
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
    const requestIndex = Number(requestId.slice(requestId.lastIndexOf("-") + 1));
    attributes["activation.first"] = requestIndex === 2;
    attributes["script.version"] = "g30-test";
    attributes.colo = "test-colo";
  }
  return attributes;
}

function records(phase: Phase, responseLatencyMs: number): Array<Record<string, unknown>> {
  const start = 1_000_000;
  return Array.from({ length: G30_SAMPLE_COUNT }, (_, index) => ({
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
    scheduledStartMs: start + index * G30_CADENCE_MS,
    startedAtMs: start + index * G30_CADENCE_MS,
    completedAtMs: start + index * G30_CADENCE_MS + responseLatencyMs,
    responseLatencyMs,
  }));
}

function warmup() {
  return {
    attempts: 5,
    source: "fixture-trace-export",
    actors: {
      WORKER: [false, false, false, false, false],
      BOOTSTRAP: [false, false, false, false, false],
      ALLOCATOR: [false, false, false, false, false],
      TAG: [false, false, false, false, false],
    },
  };
}

function configuration(sample: 0 | 1, deployedVersion: string) {
  return {
    serviceId: SERVICE,
    placement: "off",
    deployedVersion,
    sourceCommit: "c".repeat(40),
    configDigest: "d".repeat(64),
    observability: { traces: { enabled: true, persist: true, head_sampling_rate: sample } },
  };
}

function activationIdleEvidence() {
  return {
    scheduleMs: [...G30_IDLE_SCHEDULE_MS],
    observations: G30_IDLE_SCHEDULE_MS.map((scheduledGapMs, index) => ({
      requestId: `B-${index}`,
      scheduledGapMs,
      actualGapMs: scheduledGapMs + index,
      activationFirst: index === 2,
      scriptVersion: "g30-test",
      colo: "test-colo",
      previousComplete: index !== 0,
      observedIdleGapLowerBoundMs: index === 0 ? null : scheduledGapMs,
      reactivationCause: "unknown",
      storageWrites: 0,
      usedForControl: false,
      exposedInPublicResponse: false,
    })),
  };
}

function outlierDiscrimination(): Array<{
  hypothesis: string;
  disposition: string;
  classified: boolean;
  rawEvidence: Array<Record<string, unknown>>;
}> {
  return [
    {
      hypothesis: "worker-isolate-first",
      disposition: "excluded",
      classified: true,
      rawEvidence: [{
        requestId: "B-10",
        isolateInstanceId: "test-isolate",
        firstInvocation: true,
        rootVersion: "g30-test",
        colo: "test-colo",
        cpuTimeMs: 1,
        wallTimeMs: 100,
        warmComparison: "durable actors held warm",
      }],
    },
    {
      hypothesis: "durable-object-wake",
      disposition: "excluded",
      classified: true,
      rawEvidence: [{
        requestId: "B-11",
        actorClass: "TAG",
        idleGapMs: 15_000,
        constructorToHandlerMs: 3,
        firstStorageReadMs: 4,
        subrequestWallMs: 5,
        variedOneClass: true,
      }],
    },
    {
      hypothesis: "token-rotation",
      disposition: "excluded",
      classified: true,
      rawEvidence: [{
        requestId: "B-12",
        authBranch: "synchronous-string-comparison",
        deployedVersion: "g30-test",
        configDigest: "d".repeat(64),
        httpOutcome: 200,
      }],
    },
    {
      hypothesis: "queue-doorbell-backpressure",
      disposition: "excluded",
      classified: true,
      rawEvidence: [{
        requestId: "B-13",
        faultBarrier: true,
        appendResponse: 10,
        followingStateRead: 10,
        classification: "no-queue-difference",
      }],
    },
  ];
}

type RawTelemetryEvent = {
  attributes: Record<string, string | number | boolean>;
  $metadata: Record<string, string | number | undefined>;
};

function rawTelemetry(ledger: ReadonlyArray<Record<string, unknown>>) {
  const events: RawTelemetryEvent[] = [];
  for (const record of ledger) {
    const requestId = typeof record.requestId === "string" ? record.requestId : undefined;
    const startedAtMs = typeof record.startedAtMs === "number" ? record.startedAtMs : undefined;
    const completedAtMs = typeof record.completedAtMs === "number" ? record.completedAtMs : undefined;
    if (requestId === undefined || startedAtMs === undefined || completedAtMs === undefined) {
      throw new Error("fixture ledger record is missing its request timeline");
    }
    for (const rowId of ROOT_ROWS) {
      events.push({
        attributes: traceAttributes(rowId, requestId),
        $metadata: {
          traceId: `trace-${requestId}`,
          rayId: rowId === "S00" ? requestId : undefined,
          startMs: startedAtMs,
          endMs: completedAtMs,
        },
      });
    }
  }
  return { events };
}

function evidence() {
  const a = records("A", 100);
  const b = records("B", 108);
  const aprime = records("A-prime", 101);
  const traces = normalizeTelemetryExport(rawTelemetry(b), b.at(-1)!.completedAtMs as number + 1);
  return {
    task: "SDT-G30",
    baseline: "B0",
    purpose: "attribution-only-not-g37-denominator",
    phases: {
      A: { ledger: a, rawAttempts: [], configuration: configuration(0, "off"), warmup: warmup() },
      B: { ledger: b, rawAttempts: [], configuration: configuration(1, "on"), warmup: warmup() },
      "A-prime": { ledger: aprime, rawAttempts: [], configuration: configuration(0, "off-prime"), warmup: warmup() },
    },
    traces,
    traceExportCompletedAtMs: (b.at(-1)!.completedAtMs as number) + 1,
    activationIdle: activationIdleEvidence(),
    outlierDiscrimination: outlierDiscrimination(),
  };
}

describe("SDT-G30 B0 trace/evidence gates", () => {
  it("allows only head sampling to vary across the deployment configs", () => {
    expect(assertG30Config(primaryOff, primaryOn, receiverOff)).toMatchObject({
      primarySampling: [0, 1],
      receiverSampling: 0,
      placement: "off",
    });
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
    expect(() => assertDeploymentWitness({ ...witness, configDigest: "e".repeat(64) }, "B", sourceCommit, configDigest)).toThrow(/external deployment witness/);
  });

  it("requires exactly one hundred consecutive, non-replacement eligible requests", () => {
    const window = records("A", 100);
    expect(assertEligiblePhaseWindow("A", window)).toMatchObject({ phase: "A" });
    const replacement = structuredClone(window);
    replacement[99]!.replacement = true;
    expect(() => assertEligiblePhaseWindow("A", replacement)).toThrow(/window-eligibility/);
  });

  it("joins the independent client ledger only to S00's exact ray id and rejects a dropped trace", () => {
    const ledger = records("B", 100);
    const traces = normalizeTelemetryExport(rawTelemetry(ledger), 1_300_000);
    expect(assertTraceCohort(ledger, traces, 1_300_000)).toMatchObject({ requestCount: 100 });
    expect(() => assertTraceCohort(ledger, traces.slice(1), 1_300_000)).toThrow(/trace-count/);
  });

  it("rejects a telemetry group without an S00 ray/request anchor instead of matching by time", () => {
    const raw = rawTelemetry(records("B", 100));
    const firstRoot = raw.events.find((event) => event.attributes.operation === "sdt.commit");
    if (firstRoot === undefined) throw new Error("fixture lacks S00");
    delete firstRoot.$metadata.rayId;
    expect(() => normalizeTelemetryExport(raw, 1_300_000)).toThrow(/request-id/);
  });

  it("runs the runtime schema verifier over exported rows rather than trusting success row presence", () => {
    const raw = rawTelemetry(records("B", 100));
    const transition = raw.events.find((event) => event.attributes.operation === "journal.transition");
    if (transition === undefined) throw new Error("fixture lacks transition row");
    transition.attributes["span.kind"] = "nested";
    expect(() => normalizeTelemetryExport(raw, 1_300_000)).toThrow(/span-kind/);
  });

  it("requires the exported runtime-verification result for every retained trace", () => {
    const ledger = records("B", 100);
    const traces = normalizeTelemetryExport(rawTelemetry(ledger), 1_300_000);
    traces[0]!.runtimeVerified = false;
    expect(() => assertTraceCohort(ledger, traces, 1_300_000)).toThrow(/trace-complete/);
  });

  it("re-verifies every retained trace instead of trusting a stale success flag", () => {
    const ledger = records("B", 100);
    const traces = normalizeTelemetryExport(rawTelemetry(ledger), 1_300_000);
    const transition = traces[0]!.spans.find((span) => span.rowId === "S05a");
    if (transition === undefined) throw new Error("fixture lacks S05a");
    (transition as unknown as { attributes: Record<string, string | number | boolean> }).attributes["span.kind"] = "nested";
    expect(traces[0]!.runtimeVerified).toBe(true);
    expect(() => assertTraceCohort(ledger, traces, 1_300_000)).toThrow(/trace-runtime/);
  });

  it("requires real warm activation observations for every reusable actor", () => {
    expect(assertWarmupProof("B", warmup())).toMatchObject({ attempts: 5 });
    const cold = warmup();
    cold.actors.TAG[4] = true;
    expect(() => assertWarmupProof("B", cold)).toThrow(/TAG/);
  });

  it("requires all four independently evidenced outlier hypotheses and the exact idle schedule", () => {
    const ledger = records("B", 108);
    const traces = normalizeTelemetryExport(rawTelemetry(ledger), 1_300_000);
    expect(assertOutlierClassification(outlierDiscrimination(), ledger, traces)).toEqual({ classifiedOutliers: 4, unclassifiedOutliers: 0 });
    const collapsed = outlierDiscrimination();
    collapsed[1]!.hypothesis = "worker-isolate-first";
    expect(() => assertOutlierClassification(collapsed, ledger, traces)).toThrow(/outlier/);
    const evidenceFree = outlierDiscrimination();
    delete evidenceFree[0]!.rawEvidence[0]!.warmComparison;
    expect(() => assertOutlierClassification(evidenceFree, ledger, traces)).toThrow(/warmComparison/);

    expect(assertActivationIdleEvidence(activationIdleEvidence(), ledger, traces)).toMatchObject({ scheduleMs: [2_000, 15_000, 180_000] });
    const wrongSchedule = activationIdleEvidence();
    (wrongSchedule.scheduleMs as number[])[2] = 179_000;
    expect(() => assertActivationIdleEvidence(wrongSchedule, ledger, traces)).toThrow(/idle experiment/);
    const storageWrite = activationIdleEvidence();
    storageWrite.observations[0]!.storageWrites = 1;
    expect(() => assertActivationIdleEvidence(storageWrite, ledger, traces)).toThrow(/observation-only/);
  });

  it("rejects an activation observation that cites no B ledger/exported-trace request", () => {
    const document = evidence();
    document.activationIdle.observations[0]!.requestId = "B-not-exported";
    expect(() => assertB0Evidence(document)).toThrow(/activation\[0\]-trace-join/);
  });

  it("rejects an activation.first value that differs from its joined S00 root", () => {
    const document = evidence();
    document.activationIdle.observations[0]!.activationFirst = true;
    expect(() => assertB0Evidence(document)).toThrow(/activation-trace-activation-first/);
  });

  it("rejects an activation scriptVersion that differs from its joined S00 root", () => {
    const document = evidence();
    document.activationIdle.observations[0]!.scriptVersion = "different-script";
    expect(() => assertB0Evidence(document)).toThrow(/activation-trace-script-version/);
  });

  it("rejects an activation colo that differs from its joined S00 root", () => {
    const document = evidence();
    document.activationIdle.observations[0]!.colo = "different-colo";
    expect(() => assertB0Evidence(document)).toThrow(/activation-trace-colo/);
  });

  it("rejects an operator-declared token refresh result instead of calculating it from exported traces", () => {
    const document = evidence();
    document.outlierDiscrimination[2]!.rawEvidence[0]!.refreshSpanPresent = true;
    expect(() => assertB0Evidence(document)).toThrow(/token-rotation-declaration/);
  });

  it("calculates token rotation from a non-schema provider refresh span on the joined B trace", () => {
    const document = evidence();
    const bLedger = document.phases.B.ledger as Array<Record<string, unknown>>;
    const raw = rawTelemetry(bLedger);
    raw.events.push({
      attributes: { operation: "auth.refresh" },
      $metadata: { traceId: "trace-B-12", startMs: 1_024_000, endMs: 1_024_001 },
    });
    document.traces = normalizeTelemetryExport(raw, document.traceExportCompletedAtMs);
    expect(document.traces.find((trace) => trace.requestId === "B-12")!.providerSpanNames).toContain("auth.refresh");
    expect(() => assertB0Evidence(document)).toThrow(/exported refresh span must be attributed/);
    document.outlierDiscrimination[2]!.disposition = "attributed";
    expect(assertB0Evidence(document)).toMatchObject({ outliers: { classifiedOutliers: 4 } });
  });

  it("does not mistake a same-trace telemetry log for a provider refresh span", () => {
    const document = evidence();
    const bLedger = document.phases.B.ledger as Array<Record<string, unknown>>;
    const raw = rawTelemetry(bLedger);
    raw.events.push({
      attributes: { operation: "auth.refresh" },
      $metadata: { traceId: "trace-B-12" },
    });
    document.traces = normalizeTelemetryExport(raw, document.traceExportCompletedAtMs);
    expect(document.traces.find((trace) => trace.requestId === "B-12")!.providerSpanNames).not.toContain("auth.refresh");
    expect(assertB0Evidence(document)).toMatchObject({ outliers: { classifiedOutliers: 4 } });
  });

  it("calculates the queue/doorbell exclusion bound from the joined ledger and S00 duration", () => {
    const document = evidence();
    document.outlierDiscrimination[3]!.rawEvidence[0]!.appendResponse = 109;
    expect(() => assertB0Evidence(document)).toThrow(/queue-bound/);
  });

  it("rejects an outlier hypothesis whose raw evidence has no trace-bound request", () => {
    const document = evidence();
    document.outlierDiscrimination[0]!.rawEvidence = [];
    expect(() => assertB0Evidence(document)).toThrow(/outlier-evidence/);
  });

  it("rejects raw outlier evidence that cites a request absent from the B trace cohort", () => {
    const document = evidence();
    document.outlierDiscrimination[0]!.rawEvidence[0]!.requestId = "B-not-exported";
    expect(() => assertB0Evidence(document)).toThrow(/worker-isolate-first\[0\]-trace-join/);
  });

  it("keeps B0 attribution-only and fails every accepted trace above the union budget", () => {
    const document = evidence();
    expect(assertB0Evidence(document)).toMatchObject({ traces: { requestCount: 100 } });
    const unattributed = structuredClone(document);
    for (const span of unattributed.traces[0]!.spans) {
      if (span.rowId !== "S00") span.endMs = span.startMs + 1;
    }
    expect(() => assertB0Evidence(unattributed)).toThrow(/unattributed/);
  });
});
