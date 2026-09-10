import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Env as WorkerEnv } from "../packages/dcb-runtime/src/index";
import { G11_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/http/testServiceId";
import { scopeIdFor } from "../packages/dcb-runtime/src/scope/ScopeName";
import { TEST_TAG_STATE_PROJECTOR } from "../packages/dcb-runtime/src/projection/ProjectorRegistry";
import { PostgresEventStore } from "../packages/dcb-runtime/src/store/PostgresEventStore";
import { G32_FIXTURE_TIMESTAMP, g32EventId, g32Message, g32Suid } from "./helpers/g32-fixtures";

const SERVICE_ID = "local-test-runtime";

interface PartialWriteResponse {
  error: string;
  code: string;
  partial: { missingTags: string[]; writtenTags: string[] };
}

async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function payloadJson<T>(payload: string): T {
  const binary = atob(payload);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function tagFor(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}:content`;
}

async function read(path: "tag-latest-sortable" | "tag-state", body: unknown): Promise<Response> {
  return SELF.fetch(`https://read.test/api/sekiban/serialized/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function commit(body: unknown, fault: string, attemptId: string): Promise<Response> {
  return SELF.fetch("https://commit.test/api/sekiban/serialized/commit", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sdt-g4-test-fault": fault,
      "x-sdt-g4-test-attempt-id": attemptId,
    },
    body: JSON.stringify(body),
  });
}

async function tagPost(tag: string, path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://read.test/tags/${encodeURIComponent(SERVICE_ID)}/${encodeURIComponent(tag)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function tagCandidate(input: {
  readonly eventId: string;
  readonly suid: string;
  readonly payload: string;
  readonly eventTags: readonly string[];
  readonly eventType?: string;
}) {
  let payload: string;
  try {
    JSON.parse(input.payload);
    payload = input.payload;
  } catch {
    payload = JSON.stringify({ fixturePayload: input.payload });
  }
  return {
    eventId: g32EventId(input.eventId),
    suid: g32Suid(input.suid),
    payload,
    eventTags: [...input.eventTags],
    allocatorLineageId: "read-test-lineage",
    eventType: input.eventType ?? "ReadFixtureEvent",
    provenance: "g32" as const,
    timestamp: G32_FIXTURE_TIMESTAMP,
  };
}

async function tagState(tag: string): Promise<Record<string, unknown>> {
  const response = await SELF.fetch(
    `https://read.test/tags/${encodeURIComponent(SERVICE_ID)}/${encodeURIComponent(tag)}/state`,
  );
  expect(response.status).toBe(200);
  return responseJson<Record<string, unknown>>(response);
}

/** Creates a genuine identity conflict inside the named Tag DO for the 500 oracle. */
async function poisonTagIdentity(tag: string): Promise<void> {
  const poisonedTag = `poisoned-${crypto.randomUUID()}`;
  const url = new URL("https://read.test/append");
  url.searchParams.set("__tag", poisonedTag);
  url.searchParams.set("__serviceId", SERVICE_ID);
  const tagNamespace = (env as unknown as Pick<WorkerEnv, "TAG">).TAG;
  const tagObject = tagNamespace.get(scopeIdFor(tagNamespace, {
    serviceId: SERVICE_ID,
    doClass: "tag",
    identity: tag,
  }));
  const response = await tagObject.fetch(new Request(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      attemptId: "state-indeterminacy-fixture",
      epoch: 0,
      candidates: [tagCandidate({
        eventId: "state-indeterminacy-fixture",
        suid: "state-indeterminacy-fixture",
        payload: "{}",
        eventTags: [poisonedTag],
      })],
    }),
  }));
  expect(response.status).toBe(201);
}

async function expectInternalError(response: Response): Promise<void> {
  expect(response.status).toBe(500);
  expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
  expect(await responseJson<{ error: string; code: string }>(response)).toMatchObject({
    code: "internal_error",
  });
}

describe("Serialized V1 reads", () => {
  it("returns the existing latest-sortable and tag-state wire shapes for determinate fenced tags", async () => {
    const tag = tagFor("orders");
    const [tagGroup, tagContent] = tag.split(":");
    const suid = g32Suid("read-seed");
    expect((await tagPost(tag, "/append", {
      attemptId: "read-seed",
      epoch: 0,
      candidates: [tagCandidate({ eventId: "read-event", suid, payload: JSON.stringify({ value: "read" }), eventTags: [tag] })],
    })).status).toBe(201);
    expect((await tagPost(tag, "/fence/install", {
      reason: "segment_rotation",
      attemptId: "partial-owner",
      epoch: 1,
    })).status).toBe(201);

    const latest = await read("tag-latest-sortable", { tag });
    expect(latest.status).toBe(200);
    expect(latest.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await responseJson<Record<string, unknown>>(latest)).toEqual({
      exists: true,
      lastSortableUniqueId: suid,
    });

    const state = await read("tag-state", {
      tagStateId: `${tagGroup}:${tagContent}:${TEST_TAG_STATE_PROJECTOR}`,
    });
    expect(state.status).toBe(200);
    expect(state.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const body = await responseJson<Record<string, unknown>>(state);
    expect(Object.keys(body).sort()).toEqual([
      "lastSortedUniqueId",
      "payload",
      "projectorVersion",
      "tagContent",
      "tagGroup",
      "tagPayloadName",
      "tagProjector",
      "version",
    ]);
    expect(body).toMatchObject({
      version: 1,
      lastSortedUniqueId: suid,
      tagGroup,
      tagContent,
      tagProjector: TEST_TAG_STATE_PROJECTOR,
      tagPayloadName: "SerializedDcbTestTagState",
      projectorVersion: "1",
    });
    expect(typeof body.payload).toBe("string");
    expect(body).not.toHaveProperty("fences");
    expect(body).not.toHaveProperty("code");
  });

  it("catches up the complete durable tag history into the exact V1 tag-state wire", async () => {
    const tag = tagFor("full-history");
    const [tagGroup, tagContent] = tag.split(":");
    const first = tagCandidate({ eventId: "full-history-first", suid: "full-history-1", payload: JSON.stringify({ value: "first" }), eventTags: [tag] });
    const second = tagCandidate({ eventId: "full-history-second", suid: "full-history-2", payload: JSON.stringify({ value: "second" }), eventTags: [tag] });
    for (const [attemptId, candidate] of [["full-history-first-attempt", first], ["full-history-second-attempt", second]] as const) {
      expect((await tagPost(tag, "/append", {
        attemptId,
        epoch: 0,
        candidates: [candidate],
      })).status).toBe(201);
    }

    const response = await read("tag-state", {
      tagStateId: `${tagGroup}:${tagContent}:${TEST_TAG_STATE_PROJECTOR}`,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const body = await responseJson<Record<string, unknown>>(response);
    expect(Object.keys(body).sort()).toEqual([
      "lastSortedUniqueId",
      "payload",
      "projectorVersion",
      "tagContent",
      "tagGroup",
      "tagPayloadName",
      "tagProjector",
      "version",
    ]);
    expect(body).toMatchObject({
      version: 2,
      lastSortedUniqueId: second.suid,
      tagGroup,
      tagContent,
      tagProjector: TEST_TAG_STATE_PROJECTOR,
      tagPayloadName: "SerializedDcbTestTagState",
      projectorVersion: "1",
    });
    expect(payloadJson<Array<{ eventId: string; payload: string; suid: string }>>(body.payload as string)).toEqual([
      { eventId: first.eventId, suid: first.suid, payload: first.payload },
      { eventId: second.eventId, suid: second.suid, payload: second.payload },
    ]);
  });

  it("accepts the test tag-state identity from the deploy-time registry", async () => {
    const tagContent = crypto.randomUUID();
    const tag = `test:${tagContent}`;
    const suid = g32Suid("test-conformance");
    expect((await tagPost(tag, "/append", {
      attemptId: "test-conformance-attempt",
      epoch: 0,
      candidates: [tagCandidate({ eventId: "test-conformance-event", suid, payload: "{}", eventTags: [tag] })],
    })).status).toBe(201);

    const response = await read("tag-state", {
      tagStateId: `${tag}:${TEST_TAG_STATE_PROJECTOR}`,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const body = await responseJson<Record<string, unknown>>(response);
    expect(body).toMatchObject({
      version: 1,
      lastSortedUniqueId: suid,
      tagGroup: "test",
      tagContent,
      tagProjector: TEST_TAG_STATE_PROJECTOR,
      tagPayloadName: "SerializedDcbTestTagState",
      projectorVersion: "1",
    });
    expect(() => atob(body.payload as string)).not.toThrow();
  });

  it("makes the exact Section 7 missing tag immediately readable after a real PARTIAL(FENCED)", async () => {
    const writtenTag = tagFor("partial-written");
    const requestedMissingTag = tagFor("partial-missing");
    const [tagGroup, tagContent] = requestedMissingTag.split(":");
    const attemptId = crypto.randomUUID();
    const partial = await commit({
      version: 1,
      eventCandidates: [{
        payload: btoa(JSON.stringify({ value: "partial" })),
        eventPayloadName: "ReadPartial",
        tags: [writtenTag, requestedMissingTag],
      }],
      consistencyTags: [],
    }, "tag-append-last", attemptId);
    expect(partial.status).toBe(500);
    expect(partial.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const report = await responseJson<PartialWriteResponse>(partial);
    expect(report.code).toBe("partial_write");
    expect(report.partial.missingTags).toEqual([requestedMissingTag]);

    const durableMissing = await tagState(requestedMissingTag);
    expect(durableMissing.events).toEqual([]);
    expect(durableMissing.fences).toContainEqual({
      reason: "partial_write",
      attemptId,
      // G41 has no Journal owner epoch: the tag's local prepare/commit epoch
      // is the authority for the durable partial frontier.
      epoch: 0,
    });

    const latest = await read("tag-latest-sortable", { tag: report.partial.missingTags[0] });
    expect(latest.status).toBe(200);
    expect(latest.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await responseJson<Record<string, unknown>>(latest)).toEqual({
      // A durable partial-write Tag record exists even before it has an event
      // head. G71 intentionally separates that authority fact from head
      // emptiness.
      exists: true,
      lastSortableUniqueId: "",
    });

    const state = await read("tag-state", {
      tagStateId: `${tagGroup}:${tagContent}:${TEST_TAG_STATE_PROJECTOR}`,
    });
    expect(state.status).toBe(200);
    expect(state.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const body = await responseJson<Record<string, unknown>>(state);
    expect(Object.keys(body).sort()).toEqual([
      "lastSortedUniqueId",
      "payload",
      "projectorVersion",
      "tagContent",
      "tagGroup",
      "tagPayloadName",
      "tagProjector",
      "version",
    ]);
    expect(body).toMatchObject({
      payload: "W10=",
      version: 0,
      lastSortedUniqueId: "",
      tagGroup,
      tagContent,
      tagProjector: TEST_TAG_STATE_PROJECTOR,
    });
    expect(body).not.toHaveProperty("code");
  });

  it("keeps latest-sortable's internal fold but maps G45 Tag identity conflicts on tag-state to typed source failure", async () => {
    const tag = tagFor("indeterminate");
    const [tagGroup, tagContent] = tag.split(":");
    await poisonTagIdentity(tag);

    await expectInternalError(await read("tag-latest-sortable", { tag }));
    const tagStateFailure = await read("tag-state", {
      tagStateId: `${tagGroup}:${tagContent}:${TEST_TAG_STATE_PROJECTOR}`,
    });
    expect(tagStateFailure.status).toBe(409);
    expect(await responseJson<{ error: string; code: string }>(tagStateFailure)).toMatchObject({
      code: "tag_state_source_frontier_failure",
    });
  });

  it("fails closed with Section 6 JSON when a current lag estimate exceeds 120 seconds", async () => {
    const serviceId = `g11-ceiling-${crypto.randomUUID().replaceAll("-", "")}`;
    const tag = tagFor("ceiling");
    const now = Date.now();
    const url = (env as unknown as WorkerEnv).POSTGRES_URL;
    if (url === undefined) {
      throw new Error("POSTGRES_URL binding is required for the SafeWindow ceiling oracle");
    }
    const store = new PostgresEventStore(url);
    await store.initialize();
    await store.recordDelivery(g32Message({
      serviceId,
      allocatorLineageId: "test-read-lineage",
      tag,
      attemptId: crypto.randomUUID(),
      eventId: crypto.randomUUID(),
      suid: "read-ceiling",
      payload: "{}",
      eventTags: [tag],
      eventType: "ReadCeilingEvent",
      enqueuedAt: now - 121_000,
    }), now);
    expect(await store.currentLagBound(serviceId, now)).toBeGreaterThan(120_000);

    const response = await SELF.fetch("https://read.test/api/sekiban/serialized/tag-latest-sortable", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [G11_SERVICE_ID_HEADER]: serviceId,
      },
      body: JSON.stringify({ tag }),
    });
    await expectInternalError(response);
  });

  it("keeps valid empty reads determinate and rejects malformed fixture requests without query semantics", async () => {
    const tag = tagFor("empty");
    const [tagGroup, tagContent] = tag.split(":");
    expect(await responseJson<Record<string, unknown>>(await read("tag-latest-sortable", { tag }))).toEqual({
      exists: false,
      lastSortableUniqueId: "",
    });
    const emptyState = await read("tag-state", {
      tagStateId: `${tagGroup}:${tagContent}:${TEST_TAG_STATE_PROJECTOR}`,
    });
    expect(emptyState.status).toBe(200);
    expect(await responseJson<Record<string, unknown>>(emptyState)).toMatchObject({
      payload: "W10=",
      version: 0,
      lastSortedUniqueId: "",
    });

    const malformed = await read("tag-state", { tagStateId: `${tagGroup}:${tagContent}:unknown-projector` });
    expect(malformed.status).toBe(404);
    expect(malformed.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await responseJson<{ error: string; code: string }>(malformed)).toMatchObject({
      error: expect.any(String),
      code: "tag_state_unknown_projector",
    });
  });
});
