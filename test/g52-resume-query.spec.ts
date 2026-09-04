import { afterEach, describe, expect, it } from "vitest";

import {
  COHORT_REQUEST_COUNT,
  createPacedResumeState,
  createPacedFallbackSchedule,
  createW68RecoveryState,
  capturePacedCohort,
  PACED_SAMPLE_INTERVAL_MS,
  recoverW68SnapshotWindow,
  RESUME_THRESHOLD,
  resumeExactRayQuery,
  SAMPLE_COUNT,
  SNAPSHOT_PER_HOP_ROWS,
  W68_FIXED_WINDOW,
} from "../scripts/deploy/g52-resume-query.mjs";

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

  it("records the W68 fixed-window recovery honestly when the full client ray ledger is unavailable", async () => {
    const initial = createW68RecoveryState(() => W68_FIXED_WINDOW.to + 1);
    const recovered = await recoverW68SnapshotWindow({
      state: initial,
      accountId: "g52-resume-account",
      token: "test-only-observability-token",
      template: {},
      queryFixedWindow: async ({ fromMs, toMs }: { fromMs: number; toMs: number }) => {
        expect({ fromMs, toMs }).toEqual({ fromMs: W68_FIXED_WINDOW.from, toMs: W68_FIXED_WINDOW.to });
        return {
          window: { from: fromMs, to: toMs },
          receipts: [
            { requestId: "0000000000000001-SJC", platformRayId: "0000000000000001", correlationId: "one", rootId: "one", rootStartedAtMs: 1, rootEndedAtMs: 2, logTruncated: false },
            { requestId: "0000000000000002-SJC", platformRayId: "0000000000000002", correlationId: "two", rootId: "two", rootStartedAtMs: 3, rootEndedAtMs: 4, logTruncated: false },
          ],
        };
      },
    });
    expect(recovered.ledgerAvailability).toMatch(/unrecoverable-full-ray-set/);
    expect(recovered.resumed.exactRaySet).toEqual(["0000000000000001-SJC", "0000000000000002-SJC"]);
    expect(recovered.resumed.retentionRatio).toEqual({
      invocationRoots: { retained: 2, sent: COHORT_REQUEST_COUNT },
      snapshotRoots: { retained: 2, sent: COHORT_REQUEST_COUNT },
    });
    const waiting = createPacedFallbackSchedule({
      w68Recovery: recovered,
      pacedStatePath: ".artifacts/g52-paced.json",
      now: () => W68_FIXED_WINDOW.cohortStartedAtMs + (2 * 60 * 60 * 1_000) - 1,
    });
    expect(waiting.pacedFallback.decision).toBe("wait-until-two-hour-gate");
    const ready = createPacedFallbackSchedule({
      w68Recovery: recovered,
      pacedStatePath: ".artifacts/g52-paced.json",
      now: () => W68_FIXED_WINDOW.cohortStartedAtMs + (2 * 60 * 60 * 1_000),
    });
    expect(ready.pacedFallback.decision).toBe("start-paced-now");
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
