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

interface NamespaceCalls {
  idFromName: number;
  get: number;
  fetch: number;
}

function namespace(fetch: (request: Request) => Promise<Response>, calls?: NamespaceCalls): DurableObjectNamespace {
  return {
    idFromName: () => {
      if (calls !== undefined) calls.idFromName += 1;
      return ({ toString: () => "g37-fixture" }) as DurableObjectId;
    },
    get: () => {
      if (calls !== undefined) calls.get += 1;
      return ({ fetch: async (request: Request) => {
        if (calls !== undefined) calls.fetch += 1;
        return fetch(request);
      } }) as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

function request(tags = ["room:g37-a5"]): Request {
  return new Request("https://commit.test/api/sekiban/serialized/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: 1,
      eventCandidates: [{
        payload: "e30=",
        eventPayloadName: "G37Candidate",
        tags,
      }],
      consistencyTags: tags.map((tag) => ({ tag, lastSortableUniqueId: EXPECTED_HEAD })),
    }),
  });
}

describe("SDT-G37 A5 reservation behavior after G41 Journal removal", () => {
  it("uses the tag reservation fan-out without resolving JOURNAL", async () => {
    const journalCalls: NamespaceCalls = { idFromName: 0, get: 0, fetch: 0 };
    const tagCalls: NamespaceCalls = { idFromName: 0, get: 0, fetch: 0 };
    const journal = namespace(async () => json({ code: "journal_must_not_run" }, 500), journalCalls);
    const tag = namespace(async (incoming) => {
      const path = new URL(incoming.url).pathname;
      if (path === "/acquire") {
        return json({ reservation: { token: "g37-reservation" } }, 201);
      }
      if (path === "/append") return json({ appended: true }, 201);
      if (path === "/state") return json({ version: 1, updatedAt: "2026-08-27T00:00:00.000Z" });
      if (path === "/head-facts") return json({ head: EXPECTED_HEAD, version: 1, updatedAt: "2026-08-27T00:00:00.000Z" });
      return json({ code: "unexpected_tag_path" }, 500);
    }, tagCalls);
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
    expect(journalCalls).toEqual({ idFromName: 0, get: 0, fetch: 0 });
    expect(tagCalls.idFromName).toBeGreaterThan(0);
    expect(tagCalls.get).toBeGreaterThan(0);
    expect(tagCalls.fetch).toBeGreaterThan(0);
  });

  it("tombstones reservations without allowing a cancellation result to replace the primary refusal", async () => {
    const first = "room:g37-a5:reserved";
    const refused = "room:g37-a5:refused";
    let acquireCount = 0;
    let allocatorCalls = 0;
    const cancelled: Array<Record<string, unknown>> = [];
    const journalCalls: NamespaceCalls = { idFromName: 0, get: 0, fetch: 0 };
    const journal = namespace(async () => json({ code: "journal_must_not_run" }, 500), journalCalls);
    const tag = namespace(async (incoming) => {
      const path = new URL(incoming.url).pathname;
      if (path === "/acquire") {
        acquireCount += 1;
        return new URL(incoming.url).searchParams.get("__tag") === first
          ? json({ reservation: { token: "g37-reservation" } }, 201)
          : json({ reason: "consistency_head_mismatch" }, 409);
      }
      if (path === "/cancel") {
        cancelled.push(await incoming.json<Record<string, unknown>>());
        return json({ code: "cancel_ack_lost" }, 503);
      }
      return json({ code: "unexpected_tag_path" }, 500);
    });
    const allocator = namespace(async () => {
      allocatorCalls += 1;
      return json({ code: "allocator_must_not_run" }, 500);
    });
    const bootstrap = namespace(async () => json({ leaseEpoch: 1 }));
    const worker = new CommitWorker({ ALLOCATOR: allocator, JOURNAL: journal, TAG: tag, BOOTSTRAP: bootstrap }, SERVICE_ID);

    const response = await worker.handle(request([first, refused]));
    const body = await response.json<{ code: string }>();

    expect(response.status).toBe(400);
    expect(body.code).toBe("consistency_conflict");
    expect(acquireCount).toBe(2);
    expect(allocatorCalls).toBe(0);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ epoch: 0, forceTombstone: true });
    expect(typeof cancelled[0]?.attemptId).toBe("string");
    expect(journalCalls).toEqual({ idFromName: 0, get: 0, fetch: 0 });
  });
});
