import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { MAX_ALARM_BACKOFF_MS } from "../packages/dcb-runtime/src/journal/JournalDurableObject";
import type {
  JournalCandidate,
  JournalRecord,
  JournalState,
  ReconciliationInput,
} from "../packages/dcb-runtime/src/journal/types";
import {
  G32_FIXTURE_TIMESTAMP,
  g32EventId,
  g32Suid,
} from "./helpers/g32-fixtures";

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
    eventId: g32EventId(`journal-event-${index + 1}`),
    payload: JSON.stringify({ value: `payload-${index + 1}` }),
    eventType: "JournalFixtureEvent",
    timestamp: G32_FIXTURE_TIMESTAMP,
    tags: [`tag-${index + 1}`],
  }));
}

function consistencyHead(tag: string): string {
  return g32Suid(`journal-head-${tag}`);
}

function allocatorVector(): string[] {
  return [g32Suid("journal-allocator")];
}

function reconciliationRecords(
  batch: readonly JournalCandidate[],
  present: readonly boolean[],
): ReconciliationInput["records"] {
  return batch.map((candidate, index) => ({
    eventId: candidate.eventId,
    payload: candidate.payload,
    present: present[index] ?? false,
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
      lastSortableUniqueId: consistencyHead(candidate.tags[0]),
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

async function triggerAlarm(attemptId: string): Promise<JournalRecord> {
  const response = await request(attemptId, "/debug/alarm", {});
  expect(response.status).toBe(200);
  return responseJson<JournalRecord>(response);
}

async function provideTakeoverEvidence(
  attemptId: string,
  record: JournalRecord,
  reconciliation: ReconciliationInput,
  sealedTags = record.allTags,
): Promise<JournalRecord> {
  const requestEvidence = (current: JournalRecord) => request(attemptId, "/takeover", {
    expectedState: current.state,
    expectedVersion: current.version,
    expectedOwnerEpoch: current.ownerEpoch,
    seals: sealedTags.map((tag) => ({ tag, sealed: true })),
    reconciliation,
  });
  // The alarm deliberately re-arms before it reconciles.  Under a full
  // Miniflare run, that re-arm can advance the Journal version between the
  // explicit alarm probe and the evidence request.  This decision-table test
  // is about the takeover outcome, not an intentionally stale CAS request,
  // so replay once from the durable record just as the worker does.
  let response = await requestEvidence(record);
  if (response.status === 409) response = await requestEvidence(await state(attemptId));
  expect(response.status).toBe(202);
  return (await responseJson<{ journal: JournalRecord }>(response)).journal;
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
      consistencyTags: [
        { tag: "not-an-event-tag", lastSortableUniqueId: consistencyHead("invalid") },
      ],
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
      consistencyTags: [{ tag: "tag-1", lastSortableUniqueId: consistencyHead("tag-1") }],
      faultInjection: "after-admission-commit",
    });
    expect(afterCrash.status).toBe(503);

    const admitted = await state(afterAttempt);
    expect(admitted).toMatchObject({
      state: "ADMITTED",
      version: 0,
      ownerEpoch: 0,
      consistencyTags: [{ tag: "tag-1", lastSortableUniqueId: consistencyHead("tag-1") }],
      allTags: ["tag-1", "tag-2"],
    });
    expect(admitted.alarm).not.toBeNull();

    const resumed = await request(afterAttempt, "/debug/alarm", {});
    expect(resumed.status).toBe(200);
    expect((await responseJson<JournalRecord>(resumed)).state).toBe("ABANDONED");
  });

  it("makes the competing worker/alarm winner and one-time terminalization observable", async () => {
    const attemptId = newAttempt();
    const interruptedAdmission = await request(attemptId, "/admit", {
      candidates: candidates(),
      consistencyTags: [],
      faultInjection: "after-admission-commit",
    });
    expect(interruptedAdmission.status).toBe(503);

    const allocatedResponse = await reconcile(attemptId, await state(attemptId), {
      allocatorVector: allocatorVector(),
      records: [],
      failureCause: "write-failure",
    });
    const allocated = await responseJson<JournalRecord>(allocatedResponse);
    expect(allocated.state).toBe("ALLOCATED");

    const absentSnapshot: ReconciliationInput = {
      allocatorVector: allocatorVector(),
      records: reconciliationRecords(candidates(), [false]),
      failureCause: "write-failure",
    };
    const sealingResponse = await reconcile(attemptId, allocated, absentSnapshot);
    const sealing = await responseJson<JournalRecord>(sealingResponse);
    expect(sealing).toMatchObject({ state: "SEALING", ownerEpoch: 0, takeover: null });

    const alarmOwner = await triggerAlarm(attemptId);
    expect(alarmOwner).toMatchObject({ state: "SEALING", ownerEpoch: 1 });
    const ready = await provideTakeoverEvidence(attemptId, alarmOwner, absentSnapshot);

    const [worker, alarm] = await Promise.all([
      transition(attemptId, ready, "COMPLETE"),
      request(attemptId, "/debug/alarm", {}),
    ]);
    expect(alarm.status).toBe(200);

    const terminal = await state(attemptId);
    if (worker.status === 200) {
      expect(terminal.state).toBe("COMPLETE");
    } else {
      expect(worker.status).toBe(409);
      expect(terminal.state).toBe("FAILED");
    }
    expect(terminal.alarm).toBeNull();

    const staleWrite = await transition(attemptId, ready, "COMPLETE");
    expect(staleWrite.status).toBe(409);
    expect((await triggerAlarm(attemptId)).state).toBe(terminal.state);

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
    const allocatedFromAdmission = await reconcile(admittedWithVector, await admit(admittedWithVector), {
      allocatorVector: allocatorVector(),
      records: [],
      failureCause: "write-failure",
    });
    expect((await responseJson<JournalRecord>(allocatedFromAdmission)).state).toBe("ALLOCATED");

    for (const failureCause of ["reservation-conflict", "allocator-failure"] as const) {
      const reservedWithoutVector = newAttempt();
      const admitted = await admit(reservedWithoutVector);
      const reservedStep = await transition(reservedWithoutVector, admitted, "RESERVED");
      const abandonedReservation = await reconcile(
        reservedWithoutVector,
        await responseJson<JournalRecord>(reservedStep),
        { records: [], failureCause },
      );
      expect((await responseJson<JournalRecord>(abandonedReservation)).state).toBe("ABANDONED");
    }

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
      { allocatorVector: allocatorVector(), records: [], failureCause: "write-failure" },
    );
    expect((await responseJson<JournalRecord>(allocated)).state).toBe("ALLOCATED");

    for (const phase of ["ALLOCATED", "WRITING", "SEALING"] as const) {
      for (const [label, present, expected] of [
        ["zero", [false, false], "FAILED"],
        ["partial", [true, false], "PARTIAL"],
        ["full", [true, true], "COMPLETE"],
      ] as const) {
        const attemptId = newAttempt();
        const batch = candidates(2);
        let phaseRecord = await advanceTo(attemptId, await admit(attemptId, batch), phase);
        phaseRecord = await state(attemptId);
        const reconciliation: ReconciliationInput = {
          allocatorVector: allocatorVector(),
          records: reconciliationRecords(batch, present),
          failureCause: "write-failure",
        };
        let outcome = await reconcile(attemptId, phaseRecord, reconciliation);
        if (outcome.status === 409) {
          phaseRecord = await state(attemptId);
          outcome = await reconcile(attemptId, phaseRecord, reconciliation);
        }
        expect(outcome.status).toBe(200);
        const firstResult = await responseJson<JournalRecord>(outcome);
        if (expected === "COMPLETE") {
          expect(firstResult.state, `${phase}/${label}`).toBe("COMPLETE");
          continue;
        }

        expect(firstResult.state, `${phase}/${label}`).toBe("SEALING");
        let alarmOwner = await state(attemptId);
        if (alarmOwner.takeover === null) {
          alarmOwner = await triggerAlarm(attemptId);
        }
        expect(alarmOwner).toMatchObject({ state: "SEALING", ownerEpoch: 1 });
        await provideTakeoverEvidence(attemptId, alarmOwner, reconciliation);
        expect((await triggerAlarm(attemptId)).state, `${phase}/${label}`).toBe(expected);
      }
    }

    for (const phase of ["ALLOCATED", "WRITING"] as const) {
      for (const absenceOutcome of ["REFUSED", "FAILED", "PARTIAL"] as const) {
        const attemptId = newAttempt();
        const phaseRecord = await advanceTo(attemptId, await admit(attemptId), phase);
        expect((await transition(attemptId, phaseRecord, absenceOutcome)).status).toBe(422);
      }
    }
  });

  it("requires alarm-owned epoch handoff, seals, and a full requery before absence outcomes", async () => {
    const attemptId = newAttempt();
    const batch = candidates(2);
    const admitted = await admit(attemptId, batch);
    const allocatedResponse = await reconcile(attemptId, admitted, {
      allocatorVector: allocatorVector(),
      records: [],
      failureCause: "write-failure",
    });
    const allocated = await responseJson<JournalRecord>(allocatedResponse);

    const partialSnapshot: ReconciliationInput = {
      allocatorVector: allocatorVector(),
      records: reconciliationRecords(batch, [true, false]),
      failureCause: "write-failure",
    };
    const sealingResponse = await reconcile(attemptId, allocated, partialSnapshot);
    const sealing = await responseJson<JournalRecord>(sealingResponse);
    expect(sealing).toMatchObject({ state: "SEALING", ownerEpoch: 0, takeover: null });

    const beforeAlarm = await request(attemptId, "/takeover", {
      expectedState: sealing.state,
      expectedVersion: sealing.version,
      expectedOwnerEpoch: sealing.ownerEpoch,
      seals: [{ tag: "tag-1", sealed: true }],
      reconciliation: {
        records: reconciliationRecords(batch, [true]),
        failureCause: "write-failure",
      },
    });
    expect(beforeAlarm.status).toBe(409);

    const alarmOwner = await triggerAlarm(attemptId);
    expect(alarmOwner).toMatchObject({ state: "SEALING", ownerEpoch: 1, terminalResponse: null });
    expect(alarmOwner.takeover?.sealedTags).toEqual([]);

    await provideTakeoverEvidence(
      attemptId,
      alarmOwner,
      {
        records: reconciliationRecords(batch, [true]),
        failureCause: "write-failure",
      },
      ["tag-1"],
    );

    const blocked = await triggerAlarm(attemptId);
    expect(blocked).toMatchObject({ state: "SEALING", ownerEpoch: 1, terminalResponse: null });
    expect(blocked.takeover?.sealedTags).toEqual(["tag-1"]);

    const ready = await provideTakeoverEvidence(attemptId, blocked, partialSnapshot, ["tag-2"]);
    expect(ready.ownerEpoch).toBe(1);
    expect(ready.takeover?.sealedTags).toEqual(["tag-1", "tag-2"]);
    const workerReconcile = await reconcile(attemptId, ready, partialSnapshot);
    expect((await responseJson<JournalRecord>(workerReconcile)).state).toBe("SEALING");
    expect((await triggerAlarm(attemptId)).state).toBe("PARTIAL");
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
