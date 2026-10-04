import { afterEach, describe, expect, it } from "vitest";

import {
  COHORT_REQUEST_COUNT,
  createPacedResumeState,
  capturePacedCohort,
  PACED_SAMPLE_INTERVAL_MS,
  RESUME_THRESHOLD,
  resumeExactRayQuery,
  SAMPLE_COUNT,
  SNAPSHOT_PER_HOP_ROWS,
} from "../scripts/g52-resume-query.mjs";

function committedResponse(number: number) {
  return new Response(JSON.stringify({
    kind: "committed",
    response: { writtenEvents: [{ sortableUniqueIdValue: String(number).padStart(30, "0") }] },
  }), {
    status: 200,
    headers: { "content-type": "application/json", "cf-ray": `${number.toString(16).padStart(16, "0")}-SJC` },
  });
}

describe("SDT-G52 resume-only retained-log state", () => {
  const platformDateNow = Date.now;

  afterEach(() => {
    expect(Date.now, "G52 tests must not replace process-global Date.now").toBe(platformDateNow);
  });

  it("persists every paced acceptance before the next request and re-queries only its immutable ray ledger", async () => {
    let clock = 10_000;
    let requests = 0;
    const starts: number[] = [];
    const persistenceReceipts: number[] = [];
    const now = () => clock;
    const initial = createPacedResumeState({
      baseUrl: "https://g52-resume.invalid",
      accountId: "g52-resume-account",
      serviceId: "g52-resume-service",
      versionId: "g52-resume-version",
      sourceCommit: "a".repeat(40),
      runId: "g52-resume-run-0001",
      now,
    });
    const captured = await capturePacedCohort({
      state: initial,
      persist: async (state) => { persistenceReceipts.push(state.ledger.length); },
      fetchImpl: async () => {
        starts.push(clock);
        requests += 1;
        clock += 5;
        return committedResponse(requests);
      },
      sleepFor: async (milliseconds) => { clock += milliseconds; },
      now,
    });
    const capturedWindow = captured.cohortWindow as { from: number; to: number };

    expect(requests).toBe(COHORT_REQUEST_COUNT);
    expect(captured.ledger).toHaveLength(SAMPLE_COUNT);
    expect(captured.exactRaySet).toHaveLength(COHORT_REQUEST_COUNT);
    expect(persistenceReceipts).toContain(0);
    expect(persistenceReceipts).toContain(SAMPLE_COUNT);
    for (let index = 2; index < starts.length; index += 1) {
      expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(PACED_SAMPLE_INTERVAL_MS);
    }

    let queriedLedger: readonly unknown[] | undefined;
    let queriedWindow: { fromMs?: number; toMs?: number } = {};
    const resumed = await resumeExactRayQuery({
      state: captured,
      accountId: "g52-resume-account",
      token: "test-only-observability-token",
      template: {},
      now,
      queryCohort: async ({ ledger, fromMs, toMs }: { ledger: readonly unknown[]; fromMs?: number; toMs?: number }) => {
        queriedLedger = ledger;
        queriedWindow = { fromMs, toMs };
        return {
          events: [],
          resumeQuery: {
            shape: "persisted-cohort-window-standard-script-type-filters-client-side-exact-ray-intersection",
            window: { from: capturedWindow.from, to: capturedWindow.to },
          },
          cohortDoHandlerObservations: [{
            event: "do.handler",
            actorClass: "ALLOCATOR",
            requestId: captured.ledger[0]!.requestId,
            constructorToHandlerMs: 4,
            firstStorageReadMs: 2,
            subrequestWallMs: 7,
          }],
        };
      },
      normalizeBundle: () => ({ traces: [], observations: [] }),
    });
    expect(queriedLedger).toHaveLength(COHORT_REQUEST_COUNT);
    expect(queriedWindow).toEqual({ fromMs: capturedWindow.from, toMs: capturedWindow.to });
    expect(resumed.resume.queries).toHaveLength(1);
    expect(resumed.resume.queries[0]).toMatchObject({
      queryScope: "persisted-cohort-window-standard-script-type-filters-client-side-exact-ray-intersection",
      expectedSampleRequests: SAMPLE_COUNT,
      schemaCompleteSampleRoots: 0,
    });
    expect(resumed.resume.latest).toMatchObject({
      queryWindow: capturedWindow,
      doObservationSource: "sdt.observe/v1 do.handler from persisted cohort window with client-side exact-CF-Ray intersection",
      doObservationCohortRequestCount: 1,
      doObservationMedians: [{
        actorClass: "ALLOCATOR",
        observationCount: 1,
        constructorToHandlerMs: 4,
        firstStorageReadMs: 2,
        subrequestWallMs: 7,
      }],
    });
    expect(resumed.resume.lifecycle).toBe("awaiting-resume-query");
    expect(resumed.resume.threshold).toBe(RESUME_THRESHOLD);
  });

  it("accepts a Worker-only snapshot root while retaining the Worker-row completeness gate", async () => {
    let requests = 0;
    const now = () => 20_000 + requests;
    const initial = createPacedResumeState({
      baseUrl: "https://g52-resume.invalid",
      accountId: "g52-resume-account",
      serviceId: "g52-resume-service",
      versionId: "g52-resume-version",
      sourceCommit: "c".repeat(40),
      runId: "g52-resume-ownership-0001",
      now,
    });
    const captured = await capturePacedCohort({
      state: initial,
      persist: async () => {},
      fetchImpl: async () => committedResponse(++requests),
      sleepFor: async () => {},
      now,
    });
    const workerOnlyTrace = {
      requestId: captured.ledger[0]!.requestId,
      traceId: "g52-worker-only-snapshot",
      rootSource: "snapshot-log" as const,
      snapshotLogTruncated: false,
      schema: "sdt.commit/v1" as const,
      boundary: "success" as const,
      complete: true,
      runtimeVerified: true,
      exportedAtMs: 1,
      callerCoverageIntervals: [],
      providerSpanNames: [],
      spans: SNAPSHOT_PER_HOP_ROWS.map((rowId, index) => ({ rowId, startMs: index, endMs: index + 1 })),
    };
    const queryCohort = async () => ({
      events: [],
      resumeQuery: { shape: "fixture", window: captured.cohortWindow },
      cohortDoHandlerObservations: [],
    });
    const complete = await resumeExactRayQuery({
      state: captured,
      accountId: "g52-resume-account",
      token: "test-only-observability-token",
      template: {},
      now,
      queryCohort,
      normalizeBundle: () => ({ traces: [workerOnlyTrace], observations: [] }),
    });
    const completeLatest = complete.resume.latest as unknown as {
      schemaCompleteSampleRoots: number;
      perHopDescriptiveMedians: Array<{ rowId: string }>;
    };
    expect(completeLatest).toMatchObject({ schemaCompleteSampleRoots: 1 });
    expect(completeLatest.perHopDescriptiveMedians.map((row) => row.rowId)).toEqual(SNAPSHOT_PER_HOP_ROWS);
    expect(completeLatest.perHopDescriptiveMedians.map((row) => row.rowId)).not.toContain("S07");

    const missingWorker = await resumeExactRayQuery({
      state: captured,
      accountId: "g52-resume-account",
      token: "test-only-observability-token",
      template: {},
      queryCohort,
      normalizeBundle: () => ({
        traces: [{ ...workerOnlyTrace, spans: workerOnlyTrace.spans.filter((span) => span.rowId !== "S10") }],
        observations: [],
      }),
    });
    expect(missingWorker.resume.latest).toMatchObject({ schemaCompleteSampleRoots: 0 });
  });
});
