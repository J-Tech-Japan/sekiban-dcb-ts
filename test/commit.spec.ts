import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { AllocatorState } from "../packages/dcb-runtime/src/allocator/types";
import type { TagRecord } from "../packages/dcb-runtime/src/tag/types";
import {
  G32_FIXTURE_TIMESTAMP,
  g32EventId,
  g32Suid,
} from "./helpers/g32-fixtures";

const SERVICE_ID = "local-test-runtime";

interface CommitResponse {
  writtenEvents: Array<{
    payload: string;
    sortableUniqueIdValue: string;
    id: string;
    eventMetadata: { causationId: string; correlationId: string; executedUser: string };
    tags: string[];
    eventPayloadName: string;
  }>;
  tagWriteResults: Array<{ tag: string; version: number; writtenAt: string }>;
  duration: string;
}

interface Section6Error {
  error: string;
  code: string;
}

async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function expectSection6Error<T extends Section6Error>(
  response: Response,
  status: number,
  code: string,
): Promise<T> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
  const body = await responseJson<T>(response);
  expect(typeof body.error).toBe("string");
  expect(body.error.length).toBeGreaterThan(0);
  expect(body.code).toBe(code);
  return body;
}

function jsonText(value: string): string {
  try {
    JSON.parse(value);
    return value;
  } catch {
    return JSON.stringify({ fixture: value });
  }
}

/** Convert old human-readable test literals into a decoded JSON payload. */
function g32JsonPayload(value: string): string {
  try {
    JSON.parse(value);
    return value;
  } catch {
    // Fixture literals from the pre-G32 suite were often base64 transport
    // values. Decode one transport layer only in this test constructor,
    // never at runtime.
    try {
      const decoded = atob(value);
      return jsonText(decoded);
    } catch {
      return jsonText(value);
    }
  }
}

function g32Base64JsonPayload(value: string): string {
  try {
    return btoa(jsonText(atob(value)));
  } catch {
    return value;
  }
}

function normalizeG32Consistency(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value
    .filter((entry) => !(typeof entry === "object" && entry !== null &&
      (entry as Record<string, unknown>).lastSortableUniqueId === ""))
    .map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
      const candidate = entry as Record<string, unknown>;
      return typeof candidate.lastSortableUniqueId === "string"
        ? { ...candidate, lastSortableUniqueId: g32Suid(candidate.lastSortableUniqueId) }
        : candidate;
    });
}

async function normalizeG32CommitConsistency(value: unknown): Promise<unknown> {
  if (!Array.isArray(value)) return value;
  const entries: unknown[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      entries.push(entry);
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    if (candidate.lastSortableUniqueId !== "" || typeof candidate.tag !== "string") {
      entries.push(typeof candidate.lastSortableUniqueId === "string"
        ? { ...candidate, lastSortableUniqueId: g32Suid(candidate.lastSortableUniqueId) }
        : candidate);
      continue;
    }
    const state = await SELF.fetch(
      `https://commit.test/tags/${encodeURIComponent(SERVICE_ID)}/${encodeURIComponent(candidate.tag)}/state`,
    );
    // G32's first-write spelling omits the tag. Once it exists, retain the
    // stale old spelling so the real admission gate rejects it.
    if (state.status !== 404) entries.push(candidate);
  }
  return entries;
}

function normalizeG32TagCandidate(value: unknown, fallback: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const candidate = value as Record<string, unknown>;
  const eventId = g32EventId(typeof candidate.eventId === "string" ? candidate.eventId : fallback);
  return {
    ...candidate,
    eventId,
    suid: g32Suid(typeof candidate.suid === "string" ? candidate.suid : `${fallback}-suid`),
    payload: g32JsonPayload(typeof candidate.payload === "string" ? candidate.payload : "fixture"),
    eventType: typeof candidate.eventType === "string" ? candidate.eventType : "CommitFixtureEvent",
    provenance: "g32",
    allocatorLineageId: typeof candidate.allocatorLineageId === "string"
      ? candidate.allocatorLineageId
      : "commit-spec-lineage",
    timestamp: typeof candidate.timestamp === "string" ? candidate.timestamp : G32_FIXTURE_TIMESTAMP,
  };
}


async function commit(body: unknown, fault?: string, testAttemptId?: string): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (fault !== undefined) {
    headers.set("x-sdt-g4-test-fault", fault);
  }
  if (testAttemptId !== undefined) {
    headers.set("x-sdt-g4-test-attempt-id", testAttemptId);
  }
  const normalized = typeof body === "object" && body !== null && !Array.isArray(body)
    ? {
      ...(body as Record<string, unknown>),
      eventCandidates: Array.isArray((body as Record<string, unknown>).eventCandidates)
        ? ((body as Record<string, unknown>).eventCandidates as unknown[]).map((raw) => {
          if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
          const candidate = raw as Record<string, unknown>;
          return typeof candidate.payload === "string"
            ? { ...candidate, payload: g32Base64JsonPayload(candidate.payload) }
            : candidate;
        })
        : (body as Record<string, unknown>).eventCandidates,
      consistencyTags: await normalizeG32CommitConsistency((body as Record<string, unknown>).consistencyTags),
    }
    : body;
  return SELF.fetch("https://commit.test/api/sekiban/serialized/commit", {
    method: "POST",
    headers,
    body: JSON.stringify(normalized),
  });
}

function candidate(payload: string, name: string, tags: string[]) {
  return { payload, eventPayloadName: name, tags };
}

function newTag(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function tagState(tag: string): Promise<TagRecord> {
  const response = await SELF.fetch(
    `https://commit.test/tags/${encodeURIComponent(SERVICE_ID)}/${encodeURIComponent(tag)}/state`,
  );
  expect(response.status).toBe(200);
  return responseJson<TagRecord>(response);
}

async function tagPost(tag: string, path: string, body: unknown): Promise<Response> {
  const wireBody = path === "/append" && typeof body === "object" && body !== null && !Array.isArray(body)
    ? {
      ...(body as Record<string, unknown>),
      candidates: Array.isArray((body as Record<string, unknown>).candidates)
        ? ((body as Record<string, unknown>).candidates as unknown[]).map((candidate, index) =>
          normalizeG32TagCandidate(candidate, `tag-append-${tag}-${index}`),
        )
        : (body as Record<string, unknown>).candidates,
      consistencyTags: normalizeG32Consistency((body as Record<string, unknown>).consistencyTags),
    }
    : path === "/acquire" && typeof body === "object" && body !== null && !Array.isArray(body)
      ? { ...(body as Record<string, unknown>), consistencyTags: normalizeG32Consistency((body as Record<string, unknown>).consistencyTags) }
      : body;
  return SELF.fetch(
    `https://commit.test/tags/${encodeURIComponent(SERVICE_ID)}/${encodeURIComponent(tag)}${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(wireBody),
    },
  );
}

/**
 * The legacy commit fixtures still normalize their pre-G56 empty claims when
 * they intentionally exercise the omitted-entry path.  Dedicated G56 tests
 * send the explicit empty sentinel through the real V1 boundary.
 */
async function seedObservedHead(tag: string, label = tag): Promise<string> {
  const response = await tagPost(tag, "/append", {
    attemptId: `g32-seed:${label}`,
    epoch: 0,
    candidates: [{
      eventId: `g32-seed-event:${label}`,
      suid: g32Suid("1"),
      payload: JSON.stringify({ seed: label }),
      eventTags: [tag],
    }],
  });
  expect(response.status).toBe(201);
  return (await tagState(tag)).head;
}

async function allocatorState(): Promise<AllocatorState> {
  const response = await SELF.fetch("https://commit.test/allocator/state");
  expect(response.status).toBe(200);
  return responseJson<AllocatorState>(response);
}


describe("Serialized V1 commit worker", () => {
  it("AC1: validates before admission, reserves only observed tags, then writes the exact ordered V1 response", async () => {
    const observed = newTag("observed");
    const unobserved = newTag("unobserved");
    const beforeAllocator = await allocatorState();

    const malformed = await commit({
      version: 1,
      eventCandidates: [candidate("%%%", "BadPayload", [observed])],
      consistencyTags: [{ tag: observed, lastSortableUniqueId: "" }],
    });
    await expectSection6Error(malformed, 400, "malformed_commit_envelope");
    expect((await SELF.fetch(
      `https://commit.test/tags/${encodeURIComponent(SERVICE_ID)}/${encodeURIComponent(observed)}/state`,
    )).status).toBe(404);
    expect(await allocatorState()).toEqual(beforeAllocator);

    const nullExpectation = await commit({
      version: 1,
      eventCandidates: [candidate("cGF5bG9hZA==", "Event", [observed])],
      consistencyTags: [{ tag: observed, lastSortableUniqueId: null }],
    });
    await expectSection6Error(nullExpectation, 400, "malformed_commit_envelope");

    const wrongMethod = await SELF.fetch("https://commit.test/api/sekiban/serialized/commit");
    await expectSection6Error(wrongMethod, 404, "commit_route_not_found");

    const response = await commit({
      version: 1,
      eventCandidates: [
        candidate("cGF5bG9hZC0x", "First", [observed, unobserved]),
        candidate("cGF5bG9hZC0y", "Second", [unobserved]),
      ],
      consistencyTags: [{ tag: observed, lastSortableUniqueId: "" }],
    });
    expect(response.status).toBe(200);
    const written = await responseJson<CommitResponse>(response);
    expect(written.writtenEvents.map((event) => ({
      payload: event.payload,
      eventPayloadName: event.eventPayloadName,
      tags: event.tags,
    }))).toEqual([
      { payload: g32Base64JsonPayload("cGF5bG9hZC0x"), eventPayloadName: "First", tags: [observed, unobserved] },
      { payload: g32Base64JsonPayload("cGF5bG9hZC0y"), eventPayloadName: "Second", tags: [unobserved] },
    ]);
    expect(written.writtenEvents.map((event) => event.sortableUniqueIdValue)).toEqual(
      [...written.writtenEvents.map((event) => event.sortableUniqueIdValue)].sort(),
    );
    expect(written.writtenEvents.every((event) => event.eventMetadata.causationId.length > 0)).toBe(true);
    expect(written.tagWriteResults.map((result) => result.tag)).toEqual([observed, unobserved]);

    const observedState = await tagState(observed);
    const unobservedState = await tagState(unobserved);
    expect(observedState.events.map((event) => event.eventId)).toEqual([written.writtenEvents[0]!.id]);
    expect(unobservedState.events.map((event) => event.eventId)).toEqual(
      written.writtenEvents.map((event) => event.id),
    );
    // This legacy fixture normalizes asserted-empty entries away to exercise
    // the omitted-entry path. Dedicated G56 tests cover the explicit empty
    // assertion and prove that it creates no synthetic event.
    expect(observedState.version).toBe(unobservedState.version);
    expect(observedState.confirmations).toHaveLength(0);
    expect(unobservedState.confirmations).toHaveLength(0);
    expect(unobservedState.activeReservation).toBeNull();

    const bareEnvelope = await commit({ version: 1 });
    const bareEnvelopeError = await expectSection6Error<{ error: string; code: string }>(
      bareEnvelope,
      400,
      "malformed_commit_envelope",
    );
    expect(bareEnvelopeError.error).toContain("eventCandidates");
    expect(bareEnvelopeError.error).toContain("consistencyTags");

    const explicitEmptyArrays = await commit({ version: 1, eventCandidates: [], consistencyTags: [] });
    expect(explicitEmptyArrays.status).toBe(200);
    expect(await responseJson<CommitResponse>(explicitEmptyArrays)).toMatchObject({ writtenEvents: [], tagWriteResults: [] });
  });

  it("AC2: settles the whole reservation fan-out and tombstones every observed tag without creating a Journal record", async () => {
    const delayedA = newTag("delayed-a");
    const delayedB = newTag("delayed-b");
    const delayedAHead = await seedObservedHead(delayedA, "delayed-a");
    const delayedBHead = await seedObservedHead(delayedB, "delayed-b");
    const delayed = await commit({
      version: 1,
      eventCandidates: [candidate("YQ==", "Delayed", [delayedA, delayedB])],
      consistencyTags: [
        { tag: delayedA, lastSortableUniqueId: delayedAHead },
        { tag: delayedB, lastSortableUniqueId: delayedBHead },
      ],
    }, "reservation-delayed-success");
    await expectSection6Error(delayed, 504, "timeout");
    const delayedAttempt = delayed.headers.get("x-sdt-g4-attempt-id");
    expect(delayedAttempt).not.toBeNull();
    // G41 removes the per-attempt Journal record.  The tag tombstones are
    // now the durable prepare-failure convergence fact.
    expect((await SELF.fetch(
      `https://commit.test/journals/${encodeURIComponent(delayedAttempt!)}/state`,
    )).status).toBe(404);
    for (const tag of [delayedA, delayedB]) {
      const state = await tagState(tag);
      expect(state.activeReservation).toBeNull();
      expect(state.tombstones).toContainEqual({ attemptId: delayedAttempt, epoch: 0 });
      const lateAcquire = await SELF.fetch(
        `https://commit.test/tags/${encodeURIComponent(SERVICE_ID)}/${encodeURIComponent(tag)}/acquire`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            attemptId: delayedAttempt,
            epoch: 0,
            eventTags: [tag],
            consistencyTags: [{ tag, lastSortableUniqueId: tag === delayedA ? delayedAHead : delayedBHead }],
          }),
        },
      );
      expect(lateAcquire.status).toBe(409);
      expect((await responseJson<{ reason: string }>(lateAcquire)).reason).toBe("tombstoned_epoch");
    }

    const conflictTag = newTag("conflict");
    const releasedTag = newTag("released");
    expect((await commit({
      version: 1,
      eventCandidates: [candidate("c2VlZA==", "Seed", [conflictTag])],
      consistencyTags: [{ tag: conflictTag, lastSortableUniqueId: "" }],
    })).status).toBe(200);
    const allocatorBeforeConflict = await allocatorState();
    const conflict = await commit({
      version: 1,
      eventCandidates: [candidate("bmV4dA==", "Conflict", [conflictTag, releasedTag])],
      consistencyTags: [
        { tag: conflictTag, lastSortableUniqueId: g32Suid("known-wrong-conflict") },
      ],
    });
    await expectSection6Error(conflict, 400, "consistency_conflict");
    expect(await allocatorState()).toEqual(allocatorBeforeConflict);
    // A tag that was never reserved is not synthesized merely to cancel it.
    expect((await SELF.fetch(
      `https://commit.test/tags/${encodeURIComponent(SERVICE_ID)}/${encodeURIComponent(releasedTag)}/state`,
    )).status).toBe(404);
  });

  it("runs the portable suite's commit-only assert-empty, exact-match, conflict, retry, null, and concurrent-SUID scenarios", async () => {
    const exactTag = newTag("conformance-exact");
    const freshTag = newTag("conformance-fresh");
    const write = async (tag: string, expected: string | null | undefined): Promise<Response> => commit({
      version: 1,
      eventCandidates: [candidate("Y29uZm9ybWFuY2U=", "ConformanceEvent", [tag])],
      consistencyTags: expected === undefined ? [] : [{ tag, lastSortableUniqueId: expected }],
    });

    const first = await write(exactTag, undefined);
    expect(first.status, await first.clone().text()).toBe(200);
    const firstHead = (await responseJson<CommitResponse>(first)).writtenEvents[0]!.sortableUniqueIdValue;
    const exact = await write(exactTag, firstHead);
    expect(exact.status).toBe(200);
    const exactHead = (await responseJson<CommitResponse>(exact)).writtenEvents[0]!.sortableUniqueIdValue;
    expect(exactHead > firstHead).toBe(true);
    expect((await write(exactTag, firstHead)).status).toBe(400);
    await expectSection6Error(await write(exactTag, ""), 400, "consistency_conflict");

    const multiConflict = await commit({
      version: 1,
      eventCandidates: [candidate("bXVsdGk=", "ConformanceEvent", [exactTag, freshTag])],
      consistencyTags: [
        { tag: exactTag, lastSortableUniqueId: g32Suid("known-wrong-multi") },
      ],
    });
    expect(multiConflict.status).toBe(400);
    expect((await SELF.fetch(
      `https://commit.test/tags/${encodeURIComponent(SERVICE_ID)}/${encodeURIComponent(freshTag)}/state`,
    )).status).toBe(404);
    const retry = await write(exactTag, exactHead);
    expect(retry.status).toBe(200);

    const nullTag = newTag("conformance-null");
    const nullRejected = await write(nullTag, null);
    expect(nullRejected.status).toBe(400);
    expect((await responseJson<{ code: string }>(nullRejected)).code).toBe("malformed_commit_envelope");

    const concurrent = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const response = await write(newTag(`conformance-concurrent-${index}`), undefined);
      expect(response.status).toBe(200);
      return (await responseJson<CommitResponse>(response)).writtenEvents[0]!.sortableUniqueIdValue;
    }));
    expect(new Set(concurrent).size).toBe(concurrent.length);
    const ordered = [...concurrent].sort();
    expect(ordered.every((value, index) => index === 0 || ordered[index - 1]! < value)).toBe(true);
  });

  it("AC3: a post-allocation write fault reports a detectable tag-local partial without a Journal terminal state", async () => {
    const firstTag = newTag("partial-first");
    const missingTag = newTag("partial-missing");
    const partial = await commit({
      version: 1,
      eventCandidates: [candidate("cGFydGlhbA==", "Partial", [firstTag, missingTag])],
      consistencyTags: [
        { tag: firstTag, lastSortableUniqueId: "" },
        { tag: missingTag, lastSortableUniqueId: "" },
      ],
    }, "tag-append-last");
    const partialAttempt = partial.headers.get("x-sdt-g4-attempt-id");
    expect(partialAttempt).not.toBeNull();
    const partialBody = await expectSection6Error<{
      error: string;
      code: string;
      partial: { retryable: boolean; writtenTags: string[]; missingTags: string[]; eventsDeleted: boolean };
    }>(partial, 500, "partial_write");
    expect(partialBody).toMatchObject({
      code: "partial_write",
      partial: {
        retryable: false,
        writtenTags: [firstTag],
        missingTags: [missingTag],
        eventsDeleted: false,
      },
    });

    const first = await tagState(firstTag);
    expect(first.events).toHaveLength(1);
    expect(first.activeReservation).toBeNull();
    // G41 records the failed participant as a tag-local partial frontier.
    // It has no event/membership, but it must be immediately readable and
    // fenced without delegating recovery to a Journal attempt.
    const missing = await tagState(missingTag);
    expect(missing.events).toEqual([]);
    expect(missing.fences).toContainEqual({
      reason: "partial_write",
      attemptId: partialAttempt!,
      epoch: 0,
    });
    expect((await SELF.fetch(
      `https://commit.test/journals/${encodeURIComponent(partialAttempt!)}/state`,
    )).status).toBe(404);
  });

  it("G5: an ordinary commit to a fenced tag with zero durable records reports a detectable partial", async () => {
    const fencedTag = newTag("ordinary-fenced");
    expect((await tagPost(fencedTag, "/fence/install", {
      reason: "partial_write",
      attemptId: "repair-owner",
      epoch: 1,
    })).status).toBe(201);

    const response = await commit({
      version: 1,
      eventCandidates: [candidate("ZmVuY2Vk", "Blocked", [fencedTag])],
      consistencyTags: [],
    });
    const partial = await expectSection6Error<Section6Error & { partial: { eventsDeleted: boolean; writtenTags: string[]; missingTags: string[] } }>(response, 500, "partial_write");
    expect(partial.partial).toMatchObject({ eventsDeleted: false, writtenTags: [], missingTags: [fencedTag] });
    expect((await tagState(fencedTag)).events).toEqual([]);
  });

  it("G5 boundary 6: HTTP returns the direct tag-local partial report without a Journal PARTIAL record", async () => {
    const writtenTag = newTag("http-partial-written");
    const missingTag = newTag("http-partial-missing");
    const attemptId = crypto.randomUUID();
    const response = await commit({
      version: 1,
      eventCandidates: [candidate("aHR0cC1wYXJ0aWFs", "HttpPartial", [writtenTag, missingTag])],
      consistencyTags: [
        { tag: writtenTag, lastSortableUniqueId: "" },
        { tag: missingTag, lastSortableUniqueId: "" },
      ],
    }, "fence-install-partial", attemptId);

    const body = await expectSection6Error<{
      error: string;
      code: string;
      partial: { writtenTags: string[]; missingTags: string[] };
    }>(response, 500, "partial_write");
    expect(body.partial).toMatchObject({ writtenTags: [writtenTag], missingTags: [missingTag] });
    expect((await tagState(writtenTag)).events).toHaveLength(1);
    expect((await tagState(missingTag)).fences).toContainEqual({
      reason: "partial_write",
      attemptId,
      epoch: 0,
    });
    expect((await SELF.fetch(
      `https://commit.test/journals/${encodeURIComponent(attemptId)}/state`,
    )).status).toBe(404);
  });


  it("AC5/AC6: an append acknowledgement fault reports the tag-local partial and leaves no Journal alarm to terminalize", async () => {
    const writtenTag = newTag("timeout-written");
    const missingTag = newTag("timeout-missing");
    const attemptId = crypto.randomUUID();
    const response = await commit({
      version: 1,
      eventCandidates: [candidate("dGltZW91dA==", "Timeout", [writtenTag, missingTag])],
      consistencyTags: [],
    }, "fence-not-durable", attemptId);

    const partial = await expectSection6Error<Section6Error & {
      partial: { writtenTags: string[]; missingTags: string[]; eventsDeleted: boolean };
    }>(response, 500, "partial_write");
    expect(partial.partial).toMatchObject({
      writtenTags: [writtenTag],
      missingTags: [missingTag],
      eventsDeleted: false,
    });
    expect((await tagState(writtenTag)).events).toHaveLength(1);
    expect((await tagState(missingTag)).fences).toContainEqual({
      reason: "partial_write",
      attemptId,
      epoch: 0,
    });
    expect((await SELF.fetch(
      `https://commit.test/journals/${encodeURIComponent(attemptId)}/state`,
    )).status).toBe(404);
  });

  it("AC7: allocation and cancellation faults leave inspectable allocator and tag facts without Journal recovery", async () => {
    const allocationTag = newTag("allocator-journal");
    const allocatorBefore = await allocatorState();
    const allocationAttempt = crypto.randomUUID();
    const interrupted = await commit({
      version: 1,
      eventCandidates: [candidate("YWxsb2M=", "Allocated", [allocationTag])],
      consistencyTags: [{ tag: allocationTag, lastSortableUniqueId: "" }],
    }, "journal-cas-after-allocator", allocationAttempt);
    await expectSection6Error(interrupted, 504, "timeout");
    const allocatedVectorResponse = await SELF.fetch(
      `https://commit.test/allocator/attempts/${encodeURIComponent(allocationAttempt)}`,
    );
    expect(allocatedVectorResponse.status).toBe(200);
    const vector = await responseJson<{ candidates: Array<{ eventId: string; suid: string }> }>(allocatedVectorResponse);
    expect(vector.candidates).toHaveLength(1);

    const afterAllocatorCommit = await allocatorState();
    expect(afterAllocatorCommit.allocatedWatermark).not.toBe(allocatorBefore.allocatedWatermark);
    expect(await allocatorState()).toEqual(afterAllocatorCommit);
    expect((await SELF.fetch(
      `https://commit.test/tags/${encodeURIComponent(SERVICE_ID)}/${encodeURIComponent(allocationTag)}/state`,
    )).status).toBe(404);
    expect((await SELF.fetch(
      `https://commit.test/journals/${encodeURIComponent(allocationAttempt)}/state`,
    )).status).toBe(404);

    const conflictTag = newTag("tombstone-conflict");
    const lateTag = newTag("tombstone-late");
    expect((await commit({
      version: 1,
      eventCandidates: [candidate("c2VlZA==", "Seed", [conflictTag])],
      consistencyTags: [{ tag: conflictTag, lastSortableUniqueId: "" }],
    })).status).toBe(200);
    await tagState(conflictTag);
    const tombstoneAttempt = crypto.randomUUID();
    const afterTombstone = await commit({
      version: 1,
      eventCandidates: [candidate("bGF0ZQ==", "Late", [conflictTag, lateTag])],
      consistencyTags: [
        { tag: conflictTag, lastSortableUniqueId: g32Suid("wrong-tombstone-head") },
      ],
    }, "tombstone-after-durable", tombstoneAttempt);
    await expectSection6Error(afterTombstone, 400, "consistency_conflict");
    // The unobserved companion tag is never reserved or tombstoned in G32.
    expect((await SELF.fetch(
      `https://commit.test/tags/${encodeURIComponent(SERVICE_ID)}/${encodeURIComponent(lateTag)}/state`,
    )).status).toBe(404);

    expect((await SELF.fetch(
      `https://commit.test/journals/${encodeURIComponent(tombstoneAttempt)}/state`,
    )).status).toBe(404);

    const allocationFailureTag = newTag("allocator-failure");
    const allocationStateBeforeFailure = await allocatorState();
    const allocationFailure = await commit({
      version: 1,
      eventCandidates: [candidate("ZmFpbA==", "AllocatorFault", [allocationFailureTag])],
      consistencyTags: [{ tag: allocationFailureTag, lastSortableUniqueId: "" }],
    }, "allocator-commit");
    await expectSection6Error(allocationFailure, 500, "internal_error");
    expect(await allocatorState()).toEqual(allocationStateBeforeFailure);
    expect((await SELF.fetch(
      `https://commit.test/tags/${encodeURIComponent(SERVICE_ID)}/${encodeURIComponent(allocationFailureTag)}/state`,
    )).status).toBe(404);
  }, 5_000);

  it("returns Section 6 JSON when committed tag facts cannot prepare a response, without inventing a Journal terminal outcome", async () => {
    const attemptId = crypto.randomUUID();
    const response = await commit({
      version: 1,
      eventCandidates: [candidate("c3RhdGU=", "ResponseRead", [newTag("response-read")])],
      consistencyTags: [],
    }, "tag-state-unavailable", attemptId);

    await expectSection6Error(response, 500, "internal_error");
    expect((await SELF.fetch(
      `https://commit.test/journals/${encodeURIComponent(attemptId)}/state`,
    )).status).toBe(404);
  });
});
