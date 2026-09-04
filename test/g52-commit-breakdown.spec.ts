import { afterEach, describe, expect, it } from "vitest";

import { SAMPLE_COUNT, SNAPSHOT_PER_HOP_ROWS, captureG52CommitBreakdown } from "../scripts/deploy/g52-commit-breakdown.mjs";
import { validateG52Sample } from "../scripts/deploy/g52-commit-breakdown-check.mjs";

function committedResponse(requestNumber: number) {
  return new Response(JSON.stringify({
    kind: "committed",
    response: { writtenEvents: [{ sortableUniqueIdValue: String(requestNumber).padStart(30, "0") }] },
  }), {
    status: 200,
    headers: { "content-type": "application/json", "cf-ray": `${requestNumber.toString(16).padStart(16, "0")}-SJC` },
  });
}

function retainedSnapshotTelemetry(rootSource: "snapshot-log" | "native-span" = "snapshot-log") {
  // The retained root is Worker-local: DO-owned member/callback rows are
  // supplied by do.handler observations instead of being asserted here.
  const spans = SNAPSHOT_PER_HOP_ROWS.map((rowId, index) => ({ rowId, startMs: 0, endMs: index + 1 }));
  return {
    status: "available",
    queryWindow: { from: 1, to: 2 },
    ingestion: { status: "settled", expectedRequestCount: SAMPLE_COUNT, observedRequestCount: SAMPLE_COUNT, missingRequestIds: [], attempts: [] },
    observedTraceCount: SAMPLE_COUNT,
    schemaCompleteTraceCount: SAMPLE_COUNT,
    descriptiveLossCount: 0,
    rootSourceCounts: { [rootSource]: SAMPLE_COUNT },
    workerColoDistribution: { SJC: SAMPLE_COUNT },
    perHopDescriptiveMedians: SNAPSHOT_PER_HOP_ROWS.map((rowId, index) => ({ rowId, observedSpanCount: SAMPLE_COUNT, medianMs: index + 1 })),
    retainedTraceTelemetry: {
      traces: Array.from({ length: SAMPLE_COUNT }, (_unused, index) => ({ requestId: `${index}`, rootSource, snapshotLogTruncated: false, spans })),
      observations: [
        { event: "do.handler", actorClass: "ALLOCATOR", constructorToHandlerMs: 4, firstStorageReadMs: 2, subrequestWallMs: 7 },
        { event: "do.handler", actorClass: "ALLOCATOR", constructorToHandlerMs: 6, firstStorageReadMs: 4, subrequestWallMs: 9 },
        { event: "do.handler", actorClass: "TAG", constructorToHandlerMs: 1, firstStorageReadMs: 3, subrequestWallMs: null },
      ],
    },
  };
}

describe("SDT-G52 deployed snapshot-breakdown sampler", () => {
  const platformDateNow = Date.now;

  afterEach(() => {
    expect(Date.now, "G52 tests must not replace process-global Date.now").toBe(platformDateNow);
  });

  it("keeps one discarded warm-up, exactly fifty sequential app commits, and snapshot-root evidence", async () => {
    let clock = 10_000;
    let requests = 0;
    const now = () => {
      clock += 10;
      return clock;
    };
    const sample = await captureG52CommitBreakdown({
      baseUrl: "https://g52.guard.invalid",
      accountId: "g52-guard-account",
      observabilityToken: "g52-guard-observability-token",
      serviceId: "g52-guard-service",
      versionId: "g52-guard-version",
      sourceCommit: "a".repeat(40),
      runId: "g52-guard-run-0001",
      queryTemplate: {},
      now,
      fetchImpl: async (url: string) => {
        requests += 1;
        expect(new URL(url).pathname).toBe("/api/commands/create-room");
        return committedResponse(requests);
      },
      captureTelemetry: async ({ ledger }: { ledger: readonly unknown[] }) => {
        expect(ledger).toHaveLength(SAMPLE_COUNT);
        return retainedSnapshotTelemetry();
      },
    });
    expect(requests).toBe(SAMPLE_COUNT + 1);
    expect(sample).toMatchObject({ schema: "sdt-g52-commit-breakdown/v1", task: "SDT-G52" });
    expect(sample.protocol).toMatchObject({
      discardedWarmupRequests: 1,
      acceptedSampleRequests: SAMPLE_COUNT,
      retainedRootSource: "snapshot-log",
    });
    expect(sample.ledger.every((entry) => entry.roomId.startsWith("sdt-g52-"))).toBe(true);
    expect(sample.telemetry.snapshotRoots).toMatchObject({ rootSource: "snapshot-log", retainedTraceCount: SAMPLE_COUNT });
    expect(sample.telemetry.doObservationMedians).toEqual([
      { actorClass: "ALLOCATOR", observationCount: 2, constructorToHandlerMs: 4, firstStorageReadMs: 2, subrequestWallMs: 7 },
      { actorClass: "TAG", observationCount: 1, constructorToHandlerMs: 1, firstStorageReadMs: 3, subrequestWallMs: null },
    ]);
    expect(sample.telemetry.residualRanking[0]).toMatchObject({ rowId: "S15", medianMs: SNAPSHOT_PER_HOP_ROWS.length });
    expect(sample.telemetry.perHopDescriptiveMedians.map((row) => row.rowId)).toEqual(SNAPSHOT_PER_HOP_ROWS);
    expect(() => validateG52Sample(sample)).not.toThrow();
  });

  it("fails rather than treating a native or mixed root source as snapshot-log evidence", async () => {
    await expect(captureG52CommitBreakdown({
      baseUrl: "https://g52.guard.invalid",
      accountId: "g52-guard-account",
      observabilityToken: "g52-guard-observability-token",
      serviceId: "g52-guard-service",
      versionId: "g52-guard-version",
      sourceCommit: "b".repeat(40),
      runId: "g52-guard-run-0002",
      queryTemplate: {},
      fetchImpl: async () => committedResponse(1),
      captureTelemetry: async () => retainedSnapshotTelemetry("native-span"),
    })).rejects.toThrow(/non-snapshot root/);
  });
});
