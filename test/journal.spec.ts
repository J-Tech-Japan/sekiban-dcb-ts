import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { JournalRecord } from "../packages/dcb-runtime/src/journal/types";

const SERVICE_ID = "journal-cleanup-test";
const TIMESTAMP = "2026-08-31T00:00:00.000Z";

function journalStub(attemptId: string): DurableObjectStub {
  const namespace = (env as unknown as { readonly JOURNAL: DurableObjectNamespace }).JOURNAL;
  return namespace.get(namespace.idFromName(attemptId));
}

function legacyPartialRecord(attemptId: string): JournalRecord {
  return {
    schemaVersion: 1,
    candidates: [{
      eventId: "legacy-journal-event",
      payload: JSON.stringify({ fixture: "legacy-repair" }),
      eventType: "LegacyJournalFixture",
      timestamp: TIMESTAMP,
      tags: ["room:legacy-journal"],
    }],
    consistencyTags: [],
    allTags: ["room:legacy-journal"],
    commitContext: {
      attemptId,
      serviceId: SERVICE_ID,
      allocatorLineageId: "legacy-journal-lineage",
    },
    ownerEpoch: 0,
    state: "PARTIAL",
    version: 3,
    alarm: null,
    reconciliation: {
      allocatorVector: ["063891500000000000000000000000"],
      records: [],
      failureCause: "write-failure",
      missingTags: ["room:legacy-journal"],
    },
    reservationFailure: null,
    takeover: null,
    faultsRemaining: 0,
    alarmFaults: [],
    terminalResponse: null,
    repairObservations: [],
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

async function journalRequest(
  attemptId: string,
  path: string,
  method: "GET" | "POST" = "GET",
): Promise<Response> {
  return SELF.fetch(
    "https://journal.test/journals/" + encodeURIComponent(attemptId) + path,
    method === "GET"
      ? undefined
      : {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
  );
}

describe("JournalDurableObject retained diagnostics", () => {
  it("retains GET /state for an explicitly seeded legacy record and returns 404 for every removed route", async () => {
    const attemptId = crypto.randomUUID();
    const record = legacyPartialRecord(attemptId);
    await runInDurableObject(journalStub(attemptId), async (_instance, state) => {
      await state.storage.put("journal", record);
    });

    const state = await journalRequest(attemptId, "/state");
    expect(state.status).toBe(200);
    expect((await state.json()) as JournalRecord).toMatchObject({
      state: "PARTIAL",
      version: 3,
      commitContext: { attemptId, serviceId: SERVICE_ID },
      reconciliation: { missingTags: ["room:legacy-journal"] },
    });

    for (const [method, path] of [
      ["GET", "/result"],
      ["POST", "/admit"],
      ["POST", "/transition"],
      ["POST", "/reservation-failure"],
      ["POST", "/reconcile"],
      ["POST", "/takeover"],
      ["POST", "/fault"],
      ["POST", "/debug/alarm"],
    ] as const) {
      const response = await journalRequest(attemptId, path, method);
      expect(response.status, method + " " + path).toBe(404);
      expect((await response.json()) as { code: string }).toMatchObject({
        code: "journal_route_not_found",
      });
    }
  });
});
