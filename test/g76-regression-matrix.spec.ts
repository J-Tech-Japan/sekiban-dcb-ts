import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { CommitWorker } from "../packages/dcb-runtime/src/commit/CommitWorker";
import { scopeIdFor } from "../packages/dcb-runtime/src/scope/ScopeName";
import { TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/service/ServiceIdentityProvider";
import { g32EventId, g32Suid, G32_FIXTURE_TIMESTAMP } from "./helpers/g32-fixtures";

const OUTCOME_UNDETERMINED_ERROR =
  "Commit outcome is undetermined; reread tag heads and event/query state before retrying because blind retry may create duplicate events.";

type AppendMode = "committed" | "rollback" | "registration-unavailable" | "post-commit-reply-loss";
type FenceMode = "fresh-201" | "idempotent-200" | "rejected" | "reply-lost-after-persisted";

interface DurableEventFact {
  readonly eventId: string;
  readonly attemptId: string;
}

interface DurableFenceFact {
  readonly reason: string;
  readonly attemptId: string;
  readonly epoch: number;
}

interface ParticipantFacts {
  readonly events: DurableEventFact[];
  readonly fences: DurableFenceFact[];
}

interface MatrixPlan {
  readonly append: Readonly<Record<string, AppendMode>>;
  readonly fence?: Readonly<Record<string, FenceMode>>;
  readonly acquireFailure?: boolean;
}

interface FakeRun {
  readonly worker: CommitWorker;
  readonly participants: Map<string, ParticipantFacts>;
  readonly fenceReplies: Array<{ readonly tag: string; readonly status: number; readonly body: unknown }>;
}

interface NamespaceCalls {
  fetch: number;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function namespace(
  calls: NamespaceCalls,
  handler: (id: string, request: Request) => Promise<Response>,
): DurableObjectNamespace {
  return {
    idFromName(name: string): DurableObjectId {
      return name as unknown as DurableObjectId;
    },
    get(id: DurableObjectId): DurableObjectStub {
      return {
        async fetch(request: Request): Promise<Response> {
          calls.fetch += 1;
          return handler(String(id), request);
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

function participant(run: FakeRun, tag: string): ParticipantFacts {
  const existing = run.participants.get(tag);
  if (existing !== undefined) return existing;
  const created: ParticipantFacts = { events: [], fences: [] };
  run.participants.set(tag, created);
  return created;
}

function tagFromId(id: string): string {
  return id.split("/").at(-1)!;
}

function request(
  tags: readonly string[],
  options: { readonly fault?: string; readonly attemptId?: string; readonly reserve?: boolean } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.fault !== undefined) headers.set("x-sdt-g4-test-fault", options.fault);
  if (options.attemptId !== undefined) headers.set("x-sdt-g4-test-attempt-id", options.attemptId);
  return new Request("https://commit.test/api/sekiban/serialized/commit", {
    method: "POST",
    headers,
    body: JSON.stringify({
      version: 1,
      eventCandidates: [{
        payload: btoa(JSON.stringify({ fixture: "g76-regression-matrix" })),
        eventPayloadName: "G76RegressionMatrixEvent",
        tags,
      }],
      consistencyTags: options.reserve === true
        ? tags.map((tag) => ({ tag, lastSortableUniqueId: "" }))
        : [],
    }),
  });
}

function fakeRun(plan: MatrixPlan): FakeRun {
  const participants = new Map<string, ParticipantFacts>();
  const fenceReplies: Array<{ readonly tag: string; readonly status: number; readonly body: unknown }> = [];
  const tagCalls = { fetch: 0 };
  const allocatorCalls = { fetch: 0 };
  const bootstrapCalls = { fetch: 0 };
  const journalCalls = { fetch: 0 };

  const journal = namespace(journalCalls, async () => json({ code: "journal_must_not_run" }, 500));
  const bootstrap = namespace(bootstrapCalls, async () => json({ leaseEpoch: 1 }));
  const allocator = namespace(allocatorCalls, async (_id, incoming) => {
    const body = await incoming.json<{ candidates: Array<{ candidateIndex: number; eventId: string }> }>();
    return json({
      attemptId: "g76-fake-attempt",
      allocatorLineageId: "g76-fake-lineage",
      candidates: body.candidates.map((candidate) => ({
        ...candidate,
        suid: "000000000000000000000000000001",
      })),
    });
  });
  const tag = namespace(tagCalls, async (id, incoming) => {
    const tagName = tagFromId(id);
    const facts = participant(run, tagName);
    const path = new URL(incoming.url).pathname;

    if (path === "/acquire") {
      return plan.acquireFailure === true
        ? json({ reason: "provider_timeout" }, 503)
        : json({ reservation: { token: `token:${tagName}` } }, 201);
    }
    if (path === "/cancel") {
      // This matrix deliberately makes cancellation acknowledgement best
      // effort. It has no deletion capability and cannot erase event facts.
      return json({ code: "cancel_ack_lost" }, 503);
    }
    if (path === "/append") {
      const body = await incoming.json<{ candidates?: Array<{ eventId: string }> }>();
      const eventIds = (body.candidates ?? []).map((candidate) => candidate.eventId);
      const mode = plan.append[tagName] ?? "committed";
      if (mode === "committed" || mode === "post-commit-reply-loss") {
        for (const eventId of eventIds) {
          if (!facts.events.some((event) => event.eventId === eventId)) {
            facts.events.push({ eventId, attemptId: "g76-fake-attempt" });
          }
        }
      }
      if (mode === "committed") return json({ appended: true }, 201);
      if (mode === "post-commit-reply-loss") return json({ code: "append_ack_lost" }, 503);
      if (mode === "registration-unavailable") {
        return json({ code: "partition_registration_unavailable", retryable: true }, 503);
      }
      return json({ code: "tag_append_failure" }, 500);
    }
    if (path === "/fence/install") {
      const body = await incoming.json<DurableFenceFact>();
      const mode = plan.fence?.[tagName] ?? "fresh-201";
      if (mode !== "rejected" && !facts.fences.some((fence) =>
        fence.reason === body.reason && fence.attemptId === body.attemptId && fence.epoch === body.epoch
      )) {
        // The fixture writes the local durable fence before deciding whether
        // the acknowledgement is delivered. This makes reply loss distinct
        // from a rejected fence and keeps facts behind every public result.
        facts.fences.push({ reason: body.reason, attemptId: body.attemptId, epoch: body.epoch });
      }
      const status = mode === "idempotent-200" ? 200 : 201;
      const bodyValue = { status: "fence-installed" };
      const response = mode === "rejected"
        ? json({ code: "fence_rejected" }, 503)
        : mode === "reply-lost-after-persisted"
          ? json({ code: "fence_ack_lost" }, 503)
          : json(bodyValue, status);
      fenceReplies.push({ tag: tagName, status: response.status, body: bodyValue });
      return response;
    }
    if (path === "/head-facts") {
      return json({ head: "000000000000000000000000000001", version: facts.events.length, updatedAt: "2026-09-09T00:00:00.000Z" });
    }
    return json({ code: `unexpected_tag_path:${path}` }, 500);
  });

  const run: FakeRun = {
    worker: new CommitWorker({ ALLOCATOR: allocator, JOURNAL: journal, TAG: tag, BOOTSTRAP: bootstrap }, "g76-regression-matrix"),
    participants,
    fenceReplies,
  };
  return run;
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

async function partialResponse(
  run: FakeRun,
  tags: readonly string[],
  attemptId: string,
): Promise<Record<string, unknown>> {
  const response = await run.worker.handle(request(tags, { fault: "tag-append-last", attemptId }));
  expect(response.status).toBe(500);
  const body = await responseBody(response);
  expect(body.code).toBe("partial_write");
  expect(body.partial).toMatchObject({ retryable: false });
  return body;
}

describe("SDT-G76 definite partial-write regression matrix", () => {
  it("AC3 matrix: keeps public outcomes tied to durable participant facts", async () => {
    const written = "g76-matrix-written";
    const rollback = "g76-matrix-rollback";
    const fresh = "g76-matrix-fresh-201";
    const idempotent = "g76-matrix-idempotent-200";

    const rollbackRun = fakeRun({ append: { [written]: "committed", [rollback]: "rollback" } });
    const rollbackBody = await partialResponse(rollbackRun, [written, rollback], "g76-rollback");
    expect(rollbackBody.partial).toMatchObject({ writtenTags: [written], missingTags: [rollback], eventsDeleted: false });
    expect(rollbackRun.participants.get(written)?.events).toHaveLength(1);
    expect(rollbackRun.participants.get(rollback)?.events).toEqual([]);
    expect(rollbackRun.participants.get(rollback)?.fences).toHaveLength(1);

    const statusOnlyRun = fakeRun({
      append: { [written]: "committed", [fresh]: "rollback", [idempotent]: "rollback" },
      fence: { [fresh]: "fresh-201", [idempotent]: "idempotent-200" },
    });
    const statusOnlyBody = await partialResponse(statusOnlyRun, [written, fresh, idempotent], "g76-status-only");
    expect(statusOnlyBody.partial).toMatchObject({
      writtenTags: [written],
      missingTags: [fresh, idempotent],
      eventsDeleted: false,
    });
    expect(statusOnlyRun.fenceReplies.map((reply) => [reply.tag, reply.status, reply.body])).toEqual([
      [fresh, 201, { status: "fence-installed" }],
      [idempotent, 200, { status: "fence-installed" }],
    ]);
    expect(statusOnlyRun.participants.get(fresh)?.fences).toHaveLength(1);
    expect(statusOnlyRun.participants.get(idempotent)?.fences).toHaveLength(1);

    const rejectedTag = "g76-matrix-fence-rejected";
    const rejectedRun = fakeRun({ append: { [written]: "committed", [rejectedTag]: "rollback" }, fence: { [rejectedTag]: "rejected" } });
    const rejectedResponse = await rejectedRun.worker.handle(request([written, rejectedTag], { fault: "tag-append-last", attemptId: "g76-rejected" }));
    expect(rejectedResponse.status).toBe(504);
    expect(await responseBody(rejectedResponse)).toMatchObject({ code: "timeout", error: OUTCOME_UNDETERMINED_ERROR });
    expect(rejectedRun.participants.get(written)?.events).toHaveLength(1);
    expect(rejectedRun.participants.get(rejectedTag)?.events).toEqual([]);
    expect(rejectedRun.participants.get(rejectedTag)?.fences).toEqual([]);

    const lostTag = "g76-matrix-post-commit-reply-loss";
    const lostRun = fakeRun({
      append: { [written]: "committed", [lostTag]: "post-commit-reply-loss" },
      fence: { [lostTag]: "reply-lost-after-persisted" },
    });
    const lostResponse = await lostRun.worker.handle(request([written, lostTag], { fault: "tag-append-last", attemptId: "g76-post-commit-reply-loss" }));
    expect(lostResponse.status).toBe(504);
    expect(await responseBody(lostResponse)).toMatchObject({ code: "timeout", error: OUTCOME_UNDETERMINED_ERROR });
    expect(lostRun.participants.get(lostTag)?.events).toHaveLength(1);
    expect(lostRun.participants.get(lostTag)?.fences).toHaveLength(1);

    const registrationA = "g76-matrix-registration-a";
    const registrationB = "g76-matrix-registration-b";
    const registrationRun = fakeRun({
      append: { [registrationA]: "registration-unavailable", [registrationB]: "registration-unavailable" },
    });
    const registrationResponse = await registrationRun.worker.handle(request([registrationA, registrationB], { fault: "tag-append-last", attemptId: "g76-registration-only" }));
    expect(registrationResponse.status).toBe(503);
    expect(await responseBody(registrationResponse)).toMatchObject({
      code: "partition_registration_unavailable",
      retryable: true,
    });
    expect(registrationRun.participants.get(registrationA)?.events).toEqual([]);
    expect(registrationRun.participants.get(registrationB)?.events).toEqual([]);
    expect(registrationRun.participants.get(registrationA)?.fences).toHaveLength(1);
    expect(registrationRun.participants.get(registrationB)?.fences).toHaveLength(1);

    const mixedTag = "g76-matrix-registration-mixed";
    const mixedRun = fakeRun({
      append: { [written]: "committed", [mixedTag]: "registration-unavailable" },
    });
    const mixedBody = await partialResponse(mixedRun, [written, mixedTag], "g76-registration-mixed");
    expect(mixedBody.partial).toMatchObject({ writtenTags: [written], missingTags: [mixedTag], retryable: false });
    expect(mixedRun.participants.get(written)?.events).toHaveLength(1);
    expect(mixedRun.participants.get(mixedTag)?.events).toEqual([]);

    const allWrittenA = "g76-matrix-all-written-a";
    const allWrittenB = "g76-matrix-all-written-b";
    const allWrittenRun = fakeRun({ append: { [allWrittenA]: "committed", [allWrittenB]: "committed" } });
    const allWrittenResponse = await allWrittenRun.worker.handle(request(
      [allWrittenA, allWrittenB],
      { fault: "sealing-after-cas", attemptId: "g76-all-written-response-loss" },
    ));
    expect(allWrittenResponse.status).toBe(504);
    expect(await responseBody(allWrittenResponse)).toMatchObject({ code: "timeout", error: OUTCOME_UNDETERMINED_ERROR });
    expect(allWrittenRun.participants.get(allWrittenA)?.events).toHaveLength(1);
    expect(allWrittenRun.participants.get(allWrittenB)?.events).toHaveLength(1);
  });

  it("AC3 mutant target: a recognized partial write remains definite and non-retryable", async () => {
    const written = "g76-mutant-partial-written";
    const missing = "g76-mutant-partial-missing";
    const run = fakeRun({ append: { [written]: "committed", [missing]: "rollback" } });
    const body = await partialResponse(run, [written, missing], "g76-mutant-partial");
    expect(body.partial).toMatchObject({ writtenTags: [written], missingTags: [missing], retryable: false });
  });

  it("AC3 mutant target: an incomplete fence acknowledgement remains unknown", async () => {
    const written = "g76-mutant-incomplete-written";
    const missing = "g76-mutant-incomplete-missing";
    const run = fakeRun({ append: { [written]: "committed", [missing]: "rollback" }, fence: { [missing]: "rejected" } });
    const response = await run.worker.handle(request([written, missing], { fault: "tag-append-last", attemptId: "g76-mutant-incomplete" }));
    expect(response.status).toBe(504);
    expect(await responseBody(response)).toMatchObject({ code: "timeout", error: OUTCOME_UNDETERMINED_ERROR });
    expect(run.participants.get(written)?.events).toHaveLength(1);
    expect(run.participants.get(missing)?.fences).toEqual([]);
  });

  it("AC3 mutant target: partial.retryable remains false", async () => {
    const written = "g76-mutant-retryable-written";
    const missing = "g76-mutant-retryable-missing";
    const run = fakeRun({ append: { [written]: "committed", [missing]: "rollback" } });
    const body = await partialResponse(run, [written, missing], "g76-mutant-retryable");
    expect(body.partial).toMatchObject({ retryable: false });
  });

  it("AC3 mutant target: every pending participant fence is required", async () => {
    const written = "g76-mutant-all-written";
    const pendingA = "g76-mutant-all-pending-a";
    const pendingB = "g76-mutant-all-pending-b";
    const run = fakeRun({
      append: { [written]: "committed", [pendingA]: "rollback", [pendingB]: "rollback" },
      fence: { [pendingA]: "fresh-201", [pendingB]: "rejected" },
    });
    const response = await run.worker.handle(request([written, pendingA, pendingB], { fault: "tag-append-last", attemptId: "g76-mutant-all-pending" }));
    expect(response.status).toBe(504);
    expect(await responseBody(response)).toMatchObject({ code: "timeout", error: OUTCOME_UNDETERMINED_ERROR });
    expect(run.participants.get(written)?.events).toHaveLength(1);
    expect(run.participants.get(pendingA)?.fences).toHaveLength(1);
    expect(run.participants.get(pendingB)?.fences).toEqual([]);
  });

  it("AC3 keeps reservation timeout 504 distinct from the undetermined outcome", async () => {
    const tag = "g76-reservation-timeout";
    const run = fakeRun({ append: { [tag]: "committed" }, acquireFailure: true });
    const response = await run.worker.handle(request([tag], { fault: "reservation-delayed-success", reserve: true, attemptId: "g76-reservation-timeout" }));
    expect(response.status).toBe(504);
    const body = await responseBody(response);
    expect(body).toMatchObject({ code: "timeout", error: "serialized commit timed out" });
    expect(body.error).not.toBe(OUTCOME_UNDETERMINED_ERROR);
    expect(run.participants.get(tag)?.events ?? []).toEqual([]);
    expect(run.participants.get(tag)?.fences ?? []).toEqual([]);
  });

  it("AC3 real Tag owner persists fresh/idempotent fences and rejects stale or overlapping authority", async () => {
    const serviceId = `g76-real-tag-${crypto.randomUUID()}`;
    const tag = `g76-real-tag-${crypto.randomUUID()}`;
    const namespace = (env as unknown as { TAG?: DurableObjectNamespace }).TAG;
    if (namespace === undefined) throw new Error("G76 needs the real Tag Durable Object namespace");
    const stub = namespace.get(scopeIdFor(namespace, { serviceId, doClass: "tag", identity: tag }));
    const postFence = (reason: string, attemptId: string, epoch: number): Promise<Response> => stub.fetch(new Request(
      `https://tag.test/fence/install?__serviceId=${encodeURIComponent(serviceId)}&__tag=${encodeURIComponent(tag)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason, attemptId, epoch }),
      },
    ));

    const fresh = await postFence("segment_rotation", "g76-real-fresh", 2);
    expect(fresh.status).toBe(201);
    expect(await fresh.json()).toMatchObject({ status: "fence-installed" });
    const idempotent = await postFence("segment_rotation", "g76-real-fresh", 2);
    expect(idempotent.status).toBe(200);
    expect(await idempotent.json()).toMatchObject({ status: "fence-installed" });
    const stale = await postFence("segment_rotation", "g76-real-fresh", 1);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ reason: "stale_epoch" });
    const overlap = await postFence("partial_write", "g76-real-overlap", 2);
    expect(overlap.status).toBe(409);
    expect(await overlap.json()).toMatchObject({ reason: "fence_overlap_blocked" });

    const state = await stub.fetch(new Request(
      `https://tag.test/state?__serviceId=${encodeURIComponent(serviceId)}&__tag=${encodeURIComponent(tag)}`,
    ));
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({
      fences: [{ reason: "segment_rotation", attemptId: "g76-real-fresh", epoch: 2 }],
    });
  });

  it("AC3 real Tag transaction rolls back its event facts before a post-write reply is emitted", async () => {
    const serviceId = `g76-real-rollback-${crypto.randomUUID()}`;
    const tag = `g76-real-rollback-${crypto.randomUUID()}`;
    const stub = (env as unknown as { TAG: DurableObjectNamespace }).TAG.get(scopeIdFor(
      (env as unknown as { TAG: DurableObjectNamespace }).TAG,
      { serviceId, doClass: "tag", identity: tag },
    ));
    const response = await SELF.fetch(
      `https://tag.test/tags/${encodeURIComponent(serviceId)}/${encodeURIComponent(tag)}/append`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TEST_SERVICE_ID_HEADER]: serviceId,
        },
        body: JSON.stringify({
          attemptId: "g76-real-rollback",
          epoch: 0,
          faultInjection: "after-append-before-confirm",
          candidates: [{
            eventId: g32EventId("g76-real-rollback"),
            suid: g32Suid("g76-real-rollback"),
            payload: JSON.stringify({ fixture: "g76-real-rollback" }),
            eventTags: [tag],
            allocatorLineageId: "g76-real-lineage",
            eventType: "G76RollbackFixture",
            provenance: "g32",
            timestamp: G32_FIXTURE_TIMESTAMP,
          }],
        }),
      },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "simulated_append_crash" });
    const state = await stub.fetch(new Request(
      `https://tag.test/state?__serviceId=${encodeURIComponent(serviceId)}&__tag=${encodeURIComponent(tag)}`,
    ));
    expect(state.status).toBe(404);
    expect(await state.json()).toMatchObject({ code: "tag_not_found" });
  });
});
