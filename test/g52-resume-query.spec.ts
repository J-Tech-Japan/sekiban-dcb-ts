import { describe, expect, it } from "vitest";

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
  it("persists every paced acceptance before the next request and re-queries only its immutable ray ledger", async () => {
    const originalNow = Date.now;
    let clock = 10_000;
    let requests = 0;
    const starts: number[] = [];
    const persistenceReceipts: number[] = [];
    Date.now = () => clock;
    try {
      const initial = createPacedResumeState({
        baseUrl: "https://g52-resume.invalid",
        accountId: "g52-resume-account",
        serviceId: "g52-resume-service",
        versionId: "g52-resume-version",
        sourceCommit: "a".repeat(40),
        runId: "g52-resume-run-0001",
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
      });

      expect(requests).toBe(COHORT_REQUEST_COUNT);
      expect(captured.ledger).toHaveLength(SAMPLE_COUNT);
      expect(captured.exactRaySet).toHaveLength(COHORT_REQUEST_COUNT);
      expect(persistenceReceipts).toContain(0);
      expect(persistenceReceipts).toContain(SAMPLE_COUNT);
      for (let index = 2; index < starts.length; index += 1) {
        expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(PACED_SAMPLE_INTERVAL_MS);
      }

      let queriedLedger: readonly unknown[] | undefined;
      const resumed = await resumeExactRayQuery({
        state: captured,
        accountId: "g52-resume-account",
        token: "test-only-observability-token",
        template: {},
        queryCohort: async ({ ledger }: { ledger: readonly unknown[] }) => {
          queriedLedger = ledger;
          return { events: [] };
        },
        normalizeBundle: () => ({ traces: [], observations: [] }),
      });
      expect(queriedLedger).toHaveLength(COHORT_REQUEST_COUNT);
      expect(resumed.resume.queries).toHaveLength(1);
      expect(resumed.resume.queries[0]).toMatchObject({
        queryScope: "exact-persisted-cf-rays",
        expectedSampleRequests: SAMPLE_COUNT,
        schemaCompleteSampleRoots: 0,
      });
      expect(resumed.resume.lifecycle).toBe("awaiting-resume-query");
      expect(resumed.resume.threshold).toBe(RESUME_THRESHOLD);
    } finally {
      Date.now = originalNow;
    }
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
});
