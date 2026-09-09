import { describe, expect, it } from "vitest";

import {
  handleSerializedCommit,
  validateCommitEnvelope,
  type CommitWorkerEnv,
} from "../packages/dcb-runtime/src/commit/CommitWorker";

interface NamespaceCalls {
  idFromName: number;
  get: number;
  fetch: number;
}

interface NamespaceCallSet {
  readonly allocator: NamespaceCalls;
  readonly bootstrap: NamespaceCalls;
  readonly tag: NamespaceCalls;
  readonly tagState: NamespaceCalls;
}

function calls(): NamespaceCalls {
  return { idFromName: 0, get: 0, fetch: 0 };
}

function namespace(counter: NamespaceCalls): DurableObjectNamespace {
  return {
    idFromName(name: string): DurableObjectId {
      counter.idFromName += 1;
      return name as unknown as DurableObjectId;
    },
    get(): DurableObjectStub {
      counter.get += 1;
      return {
        async fetch(): Promise<Response> {
          counter.fetch += 1;
          return Response.json({ error: "G54 rejected envelope must not call a Durable Object" }, { status: 500 });
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

function environment(): { readonly env: CommitWorkerEnv; readonly calls: NamespaceCallSet } {
  const allocator = calls();
  const bootstrap = calls();
  const tag = calls();
  const tagState = calls();
  return {
    env: {
      SDT_SERVICE_ID: "g54-envelope-boundary",
      ALLOCATOR: namespace(allocator),
      BOOTSTRAP: namespace(bootstrap),
      TAG: namespace(tag),
      // CommitWorker does not currently declare a TAG_STATE binding, but the
      // boundary proof carries one anyway so a future accidental lookup is
      // still visibly zero-call under this rejected-shape fixture.
      TAG_STATE: namespace(tagState),
    } as CommitWorkerEnv,
    calls: { allocator, bootstrap, tag, tagState },
  };
}

function commitRequest(body: unknown): Request {
  return new Request("https://commit.test/api/sekiban/serialized/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function validateError(value: unknown): Promise<{ readonly code?: string; readonly error?: string }> {
  const result = validateCommitEnvelope(value);
  if (!("error" in result)) throw new Error("Expected a typed V1 envelope rejection");
  return result.error.json() as Promise<{ readonly code?: string; readonly error?: string }>;
}

function expectNoDurableObjectCalls(observed: NamespaceCallSet): void {
  for (const counter of Object.values(observed)) {
    expect(counter).toEqual({ idFromName: 0, get: 0, fetch: 0 });
  }
}

describe("SDT-G54 serialized V1 envelope boundary", () => {
  it.each([
    {
      label: "the client model aliases",
      body: {
        version: 1,
        candidates: [{
          eventId: "11111111-1111-1111-1111-111111111111",
          eventPayloadName: "OrderPlaced",
          payload: { amount: 1 },
          tags: ["Order:42"],
        }],
        consistency: [],
      },
      members: ["eventCandidates", "consistencyTags", "candidates", "consistency"],
    },
    {
      label: "both required V1 arrays absent",
      body: { version: 1 },
      members: ["eventCandidates", "consistencyTags"],
    },
    {
      label: "client aliases alongside otherwise complete V1 members",
      body: { version: 1, eventCandidates: [], consistencyTags: [], candidates: [], consistency: [] },
      members: ["candidates", "consistency"],
    },
    {
      label: "a non-array eventCandidates member",
      body: { version: 1, eventCandidates: {}, consistencyTags: [] },
      members: ["eventCandidates"],
    },
    {
      label: "a non-array consistencyTags member",
      body: { version: 1, eventCandidates: [], consistencyTags: {} },
      members: ["consistencyTags"],
    },
  ])("rejects $label before every Durable Object call", async ({ body, members }) => {
    const fixture = environment();
    const response = await handleSerializedCommit(commitRequest(body), fixture.env);
    const responseBody = await response.json<{ readonly code?: string; readonly error?: string }>();

    expect(response.status).toBe(400);
    expect(responseBody.code).toBe("malformed_commit_envelope");
    for (const member of members) expect(responseBody.error).toContain(member);
    expectNoDurableObjectCalls(fixture.calls);
  });

  it("continues to accept explicit empty V1 arrays", async () => {
    const fixture = environment();
    const response = await handleSerializedCommit(commitRequest({ version: 1, eventCandidates: [], consistencyTags: [] }), fixture.env);

    expect(response.status).toBe(200);
    const responseBody = await response.json<{ writtenEvents: unknown[]; tagWriteResults: unknown[]; duration: string }>();
    const { duration, ...semanticResponseBody } = responseBody;
    expect(Object.keys(responseBody).sort()).toEqual(["duration", "tagWriteResults", "writtenEvents"]);
    expect(semanticResponseBody).toEqual({ writtenEvents: [], tagWriteResults: [] });
    expect(duration).toEqual(expect.any(String));
    expectNoDurableObjectCalls(fixture.calls);
    expect(validateCommitEnvelope({ version: 1, eventCandidates: [], consistencyTags: [] })).toHaveProperty("value");
  });

  it("accepts the explicit empty consistency lastSortableUniqueId sentinel", () => {
    const result = validateCommitEnvelope({
      version: 1,
      eventCandidates: [{ payload: "e30=", eventPayloadName: "OrderPlaced", tags: ["Order:42"] }],
      consistencyTags: [{ tag: "Order:42", lastSortableUniqueId: "" }],
    });

    expect(result).toHaveProperty("value");
  });

  it("rejects programmatic undefined V1 members instead of coalescing them", async () => {
    const candidates = await validateError({ version: 1, eventCandidates: undefined, consistencyTags: [] });
    const consistency = await validateError({ version: 1, eventCandidates: [], consistencyTags: undefined });

    expect(candidates).toMatchObject({ code: "malformed_commit_envelope", error: expect.stringContaining("eventCandidates") });
    expect(consistency).toMatchObject({ code: "malformed_commit_envelope", error: expect.stringContaining("consistencyTags") });
  });
});
