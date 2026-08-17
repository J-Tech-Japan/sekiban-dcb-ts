import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { TEST_TAG_STATE_PROJECTOR } from "../src/read/SerializedReadWorker";

const SERVICE_ID = "serialized-dcb-v1";

async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
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

async function tagPost(tag: string, path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://read.test/tags/${encodeURIComponent(SERVICE_ID)}/${encodeURIComponent(tag)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function expectInternalError(response: Response): Promise<void> {
  expect(response.status).toBe(500);
  expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
  expect(await responseJson<{ error: string; code: string }>(response)).toMatchObject({
    code: "internal_error",
  });
}

describe("Serialized V1 minimal reads", () => {
  it("returns the existing latest-sortable and tag-state wire shapes for determinate fenced tags", async () => {
    const tag = tagFor("orders");
    const [tagGroup, tagContent] = tag.split(":");
    const suid = "suid-00000000000000000000000000000001";
    expect((await tagPost(tag, "/append", {
      attemptId: "read-seed",
      epoch: 0,
      candidates: [{ eventId: "read-event", suid, payload: "cGF5bG9hZA==", eventTags: [tag] }],
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

  it("returns 500 internal_error rather than extending the read wire when a fence leaves durable state indeterminate", async () => {
    const tag = tagFor("indeterminate");
    const [tagGroup, tagContent] = tag.split(":");
    expect((await tagPost(tag, "/fence/install", {
      reason: "partial_write",
      attemptId: "partial-owner",
      epoch: 1,
    })).status).toBe(201);

    await expectInternalError(await read("tag-latest-sortable", { tag }));
    await expectInternalError(await read("tag-state", {
      tagStateId: `${tagGroup}:${tagContent}:${TEST_TAG_STATE_PROJECTOR}`,
    }));
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
    expect(malformed.status).toBe(400);
    expect(await responseJson<{ code: string }>(malformed)).toMatchObject({ code: "validation_error" });
  });
});
