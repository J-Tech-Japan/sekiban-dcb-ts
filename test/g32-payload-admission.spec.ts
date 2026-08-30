import { describe, expect, it } from "vitest";
import { CommitWorker, validateCommitEnvelope, type CommitWorkerEnv } from "../packages/dcb-runtime/src/commit/CommitWorker";

type Calls = { allocator: number; journal: number; tag: number };

function jsonBody(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesBody(bytes: readonly number[]): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function permissiveRegisteredShape(value: unknown): unknown {
  const root = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const nested = typeof root.nested === "object" && root.nested !== null && !Array.isArray(root.nested)
    ? root.nested as Record<string, unknown>
    : {};
  const attendees = Array.isArray(root.attendees) ? root.attendees : [];
  return {
    roomId: typeof root.roomId === "string" ? root.roomId : "",
    nested: { label: typeof nested.label === "string" ? nested.label : "" },
    attendees: attendees.map((entry) => {
      const person = typeof entry === "object" && entry !== null && !Array.isArray(entry)
        ? entry as Record<string, unknown>
        : {};
      return { name: typeof person.name === "string" ? person.name : "" };
    }),
  };
}

function workerFixture(): { readonly worker: CommitWorker; readonly calls: Calls } {
  const calls: Calls = { allocator: 0, journal: 0, tag: 0 };
  const namespace = (kind: keyof Calls): DurableObjectNamespace => ({
    idFromName: () => ({ toString: () => kind }) as DurableObjectId,
    get: () => {
      calls[kind] += 1;
      return { fetch: async () => new Response("unexpected durable call", { status: 500 }) } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace);
  const env: CommitWorkerEnv = {
    ALLOCATOR: namespace("allocator"),
    JOURNAL: namespace("journal"),
    TAG: namespace("tag"),
  };
  return {
    worker: new CommitWorker(env, "g32-payload-admission", { registeredEventParsers: { RoomReserved: permissiveRegisteredShape } }),
    calls,
  };
}

async function submit(payload: string): Promise<{ readonly response: Response; readonly calls: Calls }> {
  const { worker, calls } = workerFixture();
  const response = await worker.handle(new Request("https://commit.test/api/sekiban/serialized/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: 1,
      eventCandidates: [{ payload, eventPayloadName: "RoomReserved", tags: ["room:payload"] }],
      consistencyTags: [],
    }),
  }));
  return { response, calls };
}

async function expectAdmissionReject(payload: string, code: string): Promise<void> {
  const { response, calls } = await submit(payload);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code });
  // The CommitWorker is the public admission path. A rejection cannot create
  // an allocator vector, journal record, tag/outbox append, or store effect.
  expect(calls).toEqual({ allocator: 0, journal: 0, tag: 0 });
}

async function captureActualCommitTagPayload(payload: string): Promise<{ readonly payload: string; readonly calls: Calls }> {
  const calls: Calls = { allocator: 0, journal: 0, tag: 0 };
  let captured: string | undefined;
  const namespace = (kind: keyof Calls): DurableObjectNamespace => ({
    idFromName: () => ({ toString: () => kind }) as DurableObjectId,
    get: () => ({
      fetch: async (request: Request) => {
        calls[kind] += 1;
        const path = new URL(request.url).pathname;
        if (kind === "allocator" && path === "/allocate") {
          const body = await request.json() as { readonly candidates?: readonly { readonly candidateIndex?: number; readonly eventId?: string }[] };
          return new Response(JSON.stringify({
            attemptId: "g32-payload-attempt",
            allocatorLineageId: "g32-payload-lineage",
            candidates: body.candidates?.map((candidate, index) => ({
              candidateIndex: candidate.candidateIndex ?? index,
              eventId: candidate.eventId,
              suid: `0638915000000000000000000000${String(index).padStart(2, "0")}`,
            })),
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (kind === "tag" && path === "/append") {
          const body = await request.json() as { readonly candidates?: readonly { readonly payload?: unknown }[] };
          captured = body.candidates?.[0]?.payload as string | undefined;
          // A partial outcome stops before any event can be reported as
          // committed. The following fence call is the real tag-owned
          // failure transition and must succeed for the worker to return its
          // typed partial outcome.
          return new Response(JSON.stringify({ code: "fixture_append_failure" }), { status: 500, headers: { "content-type": "application/json" } });
        }
        if (kind === "tag" && path === "/fence/install") {
          return new Response(JSON.stringify({ status: "fence-installed" }), { status: 201, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ code: "fixture_stop" }), { status: 500, headers: { "content-type": "application/json" } });
      },
    }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace);
  const worker = new CommitWorker({
    ALLOCATOR: namespace("allocator"),
    JOURNAL: namespace("journal"),
    TAG: namespace("tag"),
  }, "g32-payload-admission", { registeredEventParsers: { RoomReserved: permissiveRegisteredShape } });
  const response = await worker.handle(new Request("https://commit.test/api/sekiban/serialized/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: 1,
      eventCandidates: [{ payload, eventPayloadName: "RoomReserved", tags: ["room:payload"] }],
      consistencyTags: [],
    }),
  }));
  expect(response.status).toBe(500);
  if (captured === undefined) throw new Error("actual CommitWorker did not reach Tag append payload hand-off");
  return { payload: captured, calls };
}

describe("SDT-G32 commit payload admission", () => {
  it("rejects non-UTF-8 bytes through fatal decode before durable admission", async () => {
    await expectAdmissionReject(bytesBody([0x7b, 0x22, 0x72, 0x6f, 0x6f, 0x6d, 0x49, 0x64, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]), "invalid_payload_utf8");
  });

  it("rejects JSON syntax before durable admission", async () => {
    await expectAdmissionReject(bytesBody([0x7b, 0x22, 0x72, 0x6f, 0x6f, 0x6d, 0x49, 0x64, 0x22, 0x3a]), "invalid_payload_json");
  });

  it("rejects an array root through the registered exact-member gate", async () => {
    await expectAdmissionReject(jsonBody([]), "payload_case_mismatch");
  });

  it("rejects an unregistered nested member through the registered exact-member gate", async () => {
    await expectAdmissionReject(jsonBody({ roomId: "room-1", nested: { WrongLabel: "x" }, attendees: [] }), "payload_case_mismatch");
  });

  it("rejects a case-mismatched object inside an array through the exact-member gate", async () => {
    await expectAdmissionReject(jsonBody({ roomId: "room-1", nested: { label: "ok" }, attendees: [{ Name: "Ada" }] }), "payload_case_mismatch");
  });

  it("rejects an additional top-level property through the exact-member gate", async () => {
    await expectAdmissionReject(jsonBody({ roomId: "room-1", nested: { label: "ok" }, attendees: [], additional: true }), "payload_case_mismatch");
  });

  it("rejects a case-only duplicate key through the exact-member gate", async () => {
    await expectAdmissionReject(jsonBody({ roomId: "room-1", RoomId: "room-2", nested: { label: "ok" }, attendees: [] }), "payload_case_mismatch");
  });

  it("preserves admitted UTF-8 JSON bytes without parse-reserialize normalization through actual CommitWorker admission", async () => {
    const payload = "{\n  \"roomId\": \"room-1\", \"nested\": { \"label\": \"ok\" }, \"attendees\": [ { \"name\": \"Ada\" } ]\n}";
    const validated = validateCommitEnvelope({
      version: 1,
      eventCandidates: [{ payload: jsonBody(JSON.parse(payload)), eventPayloadName: "RoomReserved", tags: ["room:payload"] }],
      consistencyTags: [],
    }, { RoomReserved: permissiveRegisteredShape });
    // JSON.stringify above is intentionally different; construct the raw
    // base64 separately so the result proves the original spelling survives.
    const rawBytes = new TextEncoder().encode(payload);
    let rawBinary = "";
    for (const byte of rawBytes) rawBinary += String.fromCharCode(byte);
    const rawValidated = validateCommitEnvelope({
      version: 1,
      eventCandidates: [{ payload: btoa(rawBinary), eventPayloadName: "RoomReserved", tags: ["room:payload"] }],
      consistencyTags: [],
    }, { RoomReserved: permissiveRegisteredShape });
    expect("value" in validated).toBe(true);
    expect("value" in rawValidated && rawValidated.value.eventCandidates[0]?.payload).toBe(payload);
    const actual = await captureActualCommitTagPayload(btoa(rawBinary));
    expect(actual.payload).toBe(payload);
    // The tag append has the established two-attempt retry budget, followed
    // by one local partial-fence attempt per failed write; no Journal path is
    // involved in either stage.
    expect(actual.calls).toEqual({ allocator: 1, journal: 0, tag: 4 });
  });
});
