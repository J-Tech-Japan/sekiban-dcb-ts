import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { MAX_ALARM_BACKOFF_MS } from "../src/journal/JournalDurableObject";
import type {
  JournalCandidate,
  JournalRecord,
  JournalState,
  ReconciliationInput,
} from "../src/journal/types";

async function request(attemptId: string, path: string, body?: unknown): Promise<Response> {
  const init =
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  return SELF.fetch(`https://journal.test/journals/${encodeURIComponent(attemptId)}${path}`, init);
}

async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function newAttempt(): string {
  return crypto.randomUUID();
}

function candidates(count = 1): JournalCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    eventId: `event-${index + 1}`,
    payload: `payload-${index + 1}`,
    tags: [`tag-${index + 1}`],
  }));
}

async function state(attemptId: string): Promise<JournalRecord> {
  const response = await request(attemptId, "/state");
  expect(response.status).toBe(200);
  return responseJson<JournalRecord>(response);
}

async function admit(attemptId: string, batch = candidates()): Promise<JournalRecord> {
  const response = await request(attemptId, "/admit", {
    candidates: batch,
    consistencyTags: batch.map((candidate) => ({
      tag: candidate.tags[0],
      lastSortableUniqueId: "",
    })),
  });
  expect(response.status).toBe(201);
  return responseJson<JournalRecord>(response);
}

async function transition(
  attemptId: string,
  record: JournalRecord,
  nextState: JournalState,
): Promise<Response> {
  return request(attemptId, "/transition", {
    expectedState: record.state,
    expectedVersion: record.version,
    expectedOwnerEpoch: record.ownerEpoch,
    nextState,
  });
}

async function reconcile(
  attemptId: string,
  record: JournalRecord,
  reconciliation: ReconciliationInput,
): Promise<Response> {
  return request(attemptId, "/reconcile", {
    expectedState: record.state,
    expectedVersion: record.version,
    expectedOwnerEpoch: record.ownerEpoch,
    reconciliation,
  });
}

async function advanceTo(
  attemptId: string,
  record: JournalRecord,
  stateToReach: "ALLOCATED" | "WRITING" | "SEALING",
): Promise<JournalRecord> {
  const path: JournalState[] = ["RESERVED", "ALLOCATED", "WRITING", "SEALING"];
  let current = record;
  for (const next of path) {
    const response = await transition(attemptId, current, next);
    expect(response.status).toBe(200);
    current = await responseJson<JournalRecord>(response);
    if (next === stateToReach) {
      return current;
    }
  }
  throw new Error(`could not reach ${stateToReach}`);
}

describe("JournalDurableObject", () => {
  it("admits the complete attempt and alarm in one durable transaction", async () => {
    const invalidAttempt = newAttempt();
    const invalid = await request(invalidAttempt, "/admit", {
      candidates: candidates(),
      consistencyTags: [{ tag: "not-an-event-tag", lastSortableUniqueId: "" }],
    });
    expect(invalid.status).toBe(400);
    expect((await request(invalidAttempt, "/state")).status).toBe(404);

    const beforeAttempt = newAttempt();
    const beforeCrash = await request(beforeAttempt, "/admit", {
      candidates: candidates(),
      consistencyTags: [],
      faultInjection: "before-admission-commit",
    });
    expect(beforeCrash.status).toBe(503);
    expect((await request(beforeAttempt, "/state")).status).toBe(404);

    const afterAttempt = newAttempt();
    const afterCrash = await request(afterAttempt, "/admit", {
      candidates: candidates(2),
      consistencyTags: [{ tag: "tag-1", lastSortableUniqueId: "" }],
      faultInjection: "after-admission-commit",
    });
    expect(afterCrash.status).toBe(503);

    const admitted = await state(afterAttempt);
    expect(admitted).toMatchObject({
      state: "ADMITTED",
      version: 0,
      ownerEpoch: 0,
      consistencyTags: [{ tag: "tag-1", lastSortableUniqueId: "" }],
      allTags: ["tag-1", "tag-2"],
    });
    expect(admitted.alarm).not.toBeNull();

    const resumed = await request(afterAttempt, "/debug/alarm", {});
    expect(resumed.status).toBe(200);
    expect((await responseJson<JournalRecord>(resumed)).state).toBe("ABANDONED");
  });

  it("uses CAS to fix one terminal outcome under competing worker and alarm activity", async () => {
    const attemptId = newAttempt();
    const interruptedAdmission = await request(attemptId, "/admit", {
      candidates: candidates(),
      consistencyTags: [],
      faultInjection: "after-admission-commit",
    });
    expect(interruptedAdmission.status).toBe(503);
    const admitted = await state(attemptId);
    const reservedResponse = await transition(attemptId, admitted, "RESERVED");
    expect(reservedResponse.status).toBe(200);
    const reserved = await responseJson<JournalRecord>(reservedResponse);

    const [worker, alarm] = await Promise.all([
      transition(attemptId, reserved, "FAILED"),
      request(attemptId, "/debug/alarm", {}),
    ]);
    expect([200, 409]).toContain(worker.status);
    expect(alarm.status).toBe(200);

    const terminal = await state(attemptId);
    expect(terminal.state).toBe("FAILED");
    expect(terminal.alarm).toBeNull();

    const staleWrite = await transition(attemptId, reserved, "FAILED");
    expect(staleWrite.status).toBe(409);

    const result = await request(attemptId, "/result");
    expect(result.status).toBe(200);
    expect((await responseJson<{ outcome: string }>(result)).outcome).toBe(terminal.state);
  });

  it("exercises the reconciliation decision table", async () => {
    const withoutVector = newAttempt();
    const abandoned = await reconcile(withoutVector, await admit(withoutVector), {
      records: [],
      failureCause: "write-failure",
    });
    expect((await responseJson<JournalRecord>(abandoned)).state).toBe("ABANDONED");

    const admittedWithVector = newAttempt();
    const reserved = await reconcile(admittedWithVector, await admit(admittedWithVector), {
      allocatorVector: ["allocator-1"],
      records: [],
      failureCause: "write-failure",
    });
    expect((await responseJson<JournalRecord>(reserved)).state).toBe("RESERVED");

    const reservationRefusedAttempt = newAttempt();
    const reservationRefusedRecord = await admit(reservationRefusedAttempt);
    const reservationRefusedStep = await transition(reservationRefusedAttempt, reservationRefusedRecord, "RESERVED");
    const reservationRefused = await reconcile(
      reservationRefusedAttempt,
      await responseJson<JournalRecord>(reservationRefusedStep),
      { records: [], failureCause: "reservation-conflict" },
    );
    expect((await responseJson<JournalRecord>(reservationRefused)).state).toBe("REFUSED");

    const reservationFailedAttempt = newAttempt();
    const reservationFailedRecord = await admit(reservationFailedAttempt);
    const reservationFailedStep = await transition(reservationFailedAttempt, reservationFailedRecord, "RESERVED");
    const reservationFailed = await reconcile(
      reservationFailedAttempt,
      await responseJson<JournalRecord>(reservationFailedStep),
      { records: [], failureCause: "allocator-failure" },
    );
    expect((await responseJson<JournalRecord>(reservationFailed)).state).toBe("FAILED");

    const reservedWithVectorAttempt = newAttempt();
    const reservedWithVectorRecord = await admit(reservedWithVectorAttempt);
    const reservedWithVectorStep = await transition(
      reservedWithVectorAttempt,
      reservedWithVectorRecord,
      "RESERVED",
    );
    const allocated = await reconcile(
      reservedWithVectorAttempt,
      await responseJson<JournalRecord>(reservedWithVectorStep),
      { allocatorVector: ["allocator-1"], records: [], failureCause: "write-failure" },
    );
    expect((await responseJson<JournalRecord>(allocated)).state).toBe("ALLOCATED");

    for (const phase of ["ALLOCATED", "WRITING", "SEALING"] as const) {
      for (const [label, records, expected] of [
        [
          "zero",
          [
            { eventId: "event-1", payload: "payload-1", present: false },
            { eventId: "event-2", payload: "payload-2", present: false },
          ],
          "FAILED",
        ],
        [
          "partial",
          [
            { eventId: "event-1", payload: "payload-1", present: true },
            { eventId: "event-2", payload: "payload-2", present: false },
          ],
          "PARTIAL",
        ],
        [
          "full",
          [
            { eventId: "event-1", payload: "payload-1", present: true },
            { eventId: "event-2", payload: "payload-2", present: true },
          ],
          "COMPLETE",
        ],
      ] as const) {
        const attemptId = newAttempt();
        const phaseRecord = await advanceTo(attemptId, await admit(attemptId, candidates(2)), phase);
        const outcome = await reconcile(attemptId, phaseRecord, {
          allocatorVector: ["allocator-1"],
          records: records.map((record) => ({ ...record })),
          failureCause: "write-failure",
        });
        expect((await responseJson<JournalRecord>(outcome)).state, `${phase}/${label}`).toBe(expected);
      }
    }
  });

  it("increments the owner epoch before seals and blocks terminal failure until the absence barrier", async () => {
    const attemptId = newAttempt();
    const batch = candidates(2);
    const admitted = await admit(attemptId, batch);

    const incomplete = await request(attemptId, "/takeover", {
      expectedState: admitted.state,
      expectedVersion: admitted.version,
      expectedOwnerEpoch: admitted.ownerEpoch,
      seals: [{ tag: "tag-1", sealed: true }],
      reconciliation: {
        records: [{ eventId: "event-1", payload: "payload-1", present: true }],
        failureCause: "write-failure",
      },
    });
    expect(incomplete.status).toBe(202);
    const sealing = await state(attemptId);
    expect(sealing).toMatchObject({ state: "SEALING", ownerEpoch: 1, terminalResponse: null });
    expect(sealing.takeover?.sealedTags).toEqual(["tag-1"]);

    const blocked = await reconcile(attemptId, sealing, {
      records: [{ eventId: "event-1", payload: "payload-1", present: true }],
      failureCause: "write-failure",
    });
    expect((await responseJson<JournalRecord>(blocked)).state).toBe("SEALING");

    const waiting = await state(attemptId);
    const completeEvidence = await request(attemptId, "/takeover", {
      expectedState: waiting.state,
      expectedVersion: waiting.version,
      expectedOwnerEpoch: waiting.ownerEpoch,
      seals: [{ tag: "tag-2", sealed: true }],
      reconciliation: {
        records: [
          { eventId: "event-1", payload: "payload-1", present: true },
          { eventId: "event-2", payload: "payload-2", present: false },
        ],
        failureCause: "write-failure",
      },
    });
    expect(completeEvidence.status).toBe(202);

    const ready = await state(attemptId);
    expect(ready.ownerEpoch).toBe(1);
    expect(ready.takeover?.sealedTags).toEqual(["tag-1", "tag-2"]);
    const partial = await reconcile(attemptId, ready, ready.reconciliation!);
    expect((await responseJson<JournalRecord>(partial)).state).toBe("PARTIAL");
  });

  it("re-arms before reconciliation, tolerates more than six failures, and clears terminal alarms", async () => {
    const attemptId = newAttempt();
    const admitted = await admit(attemptId);
    const setFaults = await request(attemptId, "/fault", {
      expectedState: admitted.state,
      expectedVersion: admitted.version,
      expectedOwnerEpoch: admitted.ownerEpoch,
      faultsRemaining: 7,
    });
    expect(setFaults.status).toBe(200);

    for (let invocation = 0; invocation < 7; invocation += 1) {
      const response = await request(attemptId, "/debug/alarm", {});
      expect(response.status).toBe(200);
      const pending = await responseJson<JournalRecord>(response);
      expect(pending.state).toBe("ADMITTED");
      expect(pending.alarm).not.toBeNull();
      expect(pending.alarm!.delayMs).toBeLessThanOrEqual(MAX_ALARM_BACKOFF_MS);
    }

    const terminalAlarm = await request(attemptId, "/debug/alarm", {});
    const terminal = await responseJson<JournalRecord>(terminalAlarm);
    expect(terminal.state).toBe("ABANDONED");
    expect(terminal.alarm).toBeNull();

    const strayAlarm = await request(attemptId, "/debug/alarm", {});
    const strayResult = await responseJson<JournalRecord>(strayAlarm);
    expect(strayResult.state).toBe("ABANDONED");
    expect(strayResult.alarm).toBeNull();
  });
});
