import { describe, expect, it } from "vitest";

import { CommitWorker } from "../packages/dcb-runtime/src/commit/CommitWorker";

const SERVICE_ID = "g37-a5-fixture";
const EXPECTED_HEAD = "063891500000000000000000000000";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function namespace(fetch: (request: Request) => Promise<Response>): DurableObjectNamespace {
  return {
    idFromName: () => ({ toString: () => "g37-fixture" }) as DurableObjectId,
    get: () => ({ fetch }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace;
}

function request(): Request {
  return new Request("https://commit.test/api/sekiban/serialized/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: 1,
      eventCandidates: [{
        payload: "e30=",
        eventPayloadName: "G37Candidate",
        tags: ["room:g37-a5"],
      }],
      consistencyTags: [{ tag: "room:g37-a5", lastSortableUniqueId: EXPECTED_HEAD }],
    }),
  });
}

function responseForTransition(request: Request): Promise<Response> {
  return request.json<{ nextState: string; expectedVersion: number; expectedOwnerEpoch: number }>()
    .then((body) => json({
      state: body.nextState,
      version: body.expectedVersion + 1,
      ownerEpoch: body.expectedOwnerEpoch,
    }));
}

describe("SDT-G37 A5 reservation/admission concurrency", () => {
  it("starts the reservation fan-out while Journal admission is still in flight", async () => {
    let admissionPending = false;
    let acquireWhileAdmissionPending = false;
    const journal = namespace(async (incoming) => {
      const path = new URL(incoming.url).pathname;
      if (path === "/admit") {
        admissionPending = true;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        admissionPending = false;
        return json({ state: "ADMITTED", version: 0, ownerEpoch: 0 }, 201);
      }
      if (path === "/transition") return responseForTransition(incoming);
      return json({ code: "unexpected_journal_path" }, 500);
    });
    const tag = namespace(async (incoming) => {
      const path = new URL(incoming.url).pathname;
      if (path === "/acquire") {
        acquireWhileAdmissionPending ||= admissionPending;
        return json({ reservation: { token: "g37-reservation" } }, 201);
      }
      if (path === "/append") return json({ appended: true }, 201);
      if (path === "/state") return json({ version: 1, updatedAt: "2026-08-27T00:00:00.000Z" });
      return json({ code: "unexpected_tag_path" }, 500);
    });
    const allocator = namespace(async (incoming) => {
      if (new URL(incoming.url).pathname !== "/allocate") return json({ code: "unexpected_allocator_path" }, 500);
      const body = await incoming.json<{ candidates: Array<{ candidateIndex: number; eventId: string }> }>();
      return json({
        attemptId: "g37-a5-attempt",
        allocatorLineageId: "g37-a5-lineage",
        candidates: body.candidates.map((candidate) => ({ ...candidate, suid: EXPECTED_HEAD })),
      });
    });
    const bootstrap = namespace(async () => json({ leaseEpoch: 1 }));
    const worker = new CommitWorker({ ALLOCATOR: allocator, JOURNAL: journal, TAG: tag, BOOTSTRAP: bootstrap }, SERVICE_ID);

    const response = await worker.handle(request());

    expect(response.status).toBe(200);
    expect(acquireWhileAdmissionPending).toBe(true);
  });

  it("tombstones acquired reservations if the concurrently-issued Journal admission rejects", async () => {
    let acquireCount = 0;
    let allocatorCalls = 0;
    const cancelled: Array<Record<string, unknown>> = [];
    const journal = namespace(async (incoming) => {
      if (new URL(incoming.url).pathname === "/admit") return json({ code: "journal_unavailable" }, 503);
      return json({ code: "unexpected_journal_path" }, 500);
    });
    const tag = namespace(async (incoming) => {
      const path = new URL(incoming.url).pathname;
      if (path === "/acquire") {
        acquireCount += 1;
        return json({ reservation: { token: "g37-reservation" } }, 201);
      }
      if (path === "/cancel") {
        cancelled.push(await incoming.json<Record<string, unknown>>());
        return json({ status: "cancelled" });
      }
      return json({ code: "unexpected_tag_path" }, 500);
    });
    const allocator = namespace(async () => {
      allocatorCalls += 1;
      return json({ code: "allocator_must_not_run" }, 500);
    });
    const bootstrap = namespace(async () => json({ leaseEpoch: 1 }));
    const worker = new CommitWorker({ ALLOCATOR: allocator, JOURNAL: journal, TAG: tag, BOOTSTRAP: bootstrap }, SERVICE_ID);

    const response = await worker.handle(request());
    const body = await response.json<{ code: string }>();

    expect(response.status).toBe(500);
    expect(body.code).toBe("internal_error");
    expect(acquireCount).toBe(1);
    expect(allocatorCalls).toBe(0);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ epoch: 0, forceTombstone: true });
    expect(typeof cancelled[0]?.attemptId).toBe("string");
  });
});
