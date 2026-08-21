import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { AllocatorState } from "../packages/dcb-runtime/src/allocator/types";
import { type AlarmFaultPoint, type JournalRecord } from "../packages/dcb-runtime/src/journal/types";
import type { TagRecord } from "../packages/dcb-runtime/src/tag/types";
import { mapTerminalCommitOutcome, requeryFactsFromTagRecords } from "../packages/dcb-runtime/src/http/commitResponse";

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

async function commit(body: unknown, fault?: string, testAttemptId?: string): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (fault !== undefined) {
    headers.set("x-sdt-g4-test-fault", fault);
  }
  if (testAttemptId !== undefined) {
    headers.set("x-sdt-g4-test-attempt-id", testAttemptId);
  }
  return SELF.fetch("https://commit.test/api/sekiban/serialized/commit", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
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
        ? ((body as Record<string, unknown>).candidates as unknown[]).map((candidate) =>
          typeof candidate === "object" && candidate !== null && !Array.isArray(candidate) &&
          !Object.prototype.hasOwnProperty.call(candidate, "eventType")
            ? { ...(candidate as Record<string, unknown>), provenance: "pre-g27", legacyMigrationMarker: "pre-g27-append-v1" }
            : candidate,
        )
        : (body as Record<string, unknown>).candidates,
    }
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

async function allocatorState(): Promise<AllocatorState> {
  const response = await SELF.fetch("https://commit.test/allocator/state");
  expect(response.status).toBe(200);
  return responseJson<AllocatorState>(response);
}

async function journalState(attemptId: string): Promise<JournalRecord> {
  const response = await SELF.fetch(`https://commit.test/journals/${encodeURIComponent(attemptId)}/state`);
  expect(response.status).toBe(200);
  return responseJson<JournalRecord>(response);
}

async function journalPost(attemptId: string, path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://commit.test/journals/${encodeURIComponent(attemptId)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function journalTransition(
  attemptId: string,
  record: JournalRecord,
  nextState: JournalRecord["state"],
): Promise<JournalRecord> {
  const response = await journalPost(attemptId, "/transition", {
    expectedState: record.state,
    expectedVersion: record.version,
    expectedOwnerEpoch: record.ownerEpoch,
    nextState,
  });
  expect(response.status).toBe(200);
  return responseJson<JournalRecord>(response);
}

async function prepareSealingAttempt(
  prefix: string,
  alarmFault?: AlarmFaultPoint,
): Promise<{ attemptId: string; tags: string[]; record: JournalRecord }> {
  const attemptId = crypto.randomUUID();
  const tags = [newTag(`${prefix}-a`), newTag(`${prefix}-b`)];
  const admitted = await journalPost(attemptId, "/admit", {
    candidates: [{ eventId: `${attemptId}-event`, payload: "Y3Jhc2g=", tags }],
    consistencyTags: tags.map((tag) => ({ tag, lastSortableUniqueId: "" })),
    commitContext: { attemptId, serviceId: SERVICE_ID },
  });
  expect(admitted.status).toBe(201);
  let record = await responseJson<JournalRecord>(admitted);
  record = await journalTransition(attemptId, record, "RESERVED");
  for (const tag of tags) {
    const response = await SELF.fetch(
      `https://commit.test/tags/${encodeURIComponent(SERVICE_ID)}/${encodeURIComponent(tag)}/acquire`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attemptId,
          epoch: 0,
          eventTags: tags,
          consistencyTags: tags.map((entry) => ({ tag: entry, lastSortableUniqueId: "" })),
        }),
      },
    );
    expect(response.status).toBe(201);
  }
  record = await journalTransition(attemptId, record, "ALLOCATED");
  record = await journalTransition(attemptId, record, "WRITING");
  const sealing = await journalPost(attemptId, "/transition", {
    expectedState: record.state,
    expectedVersion: record.version,
    expectedOwnerEpoch: record.ownerEpoch,
    nextState: "SEALING",
    ...(alarmFault === undefined ? {} : { alarmFaults: [alarmFault] }),
  });
  expect(sealing.status).toBe(200);
  return { attemptId, tags, record: await responseJson<JournalRecord>(sealing) };
}

async function preparePartialFenceAttempt(
  prefix: string,
  options: { alarmFault?: AlarmFaultPoint; testFenceInstallFaultOnce?: boolean } = {},
): Promise<{ attemptId: string; writtenTag: string; missingTag: string; record: JournalRecord }> {
  const attemptId = crypto.randomUUID();
  const writtenTag = newTag(`${prefix}-written`);
  const missingTag = newTag(`${prefix}-missing`);
  const eventId = `${attemptId}-event`;
  const tags = [writtenTag, missingTag];
  const admitted = await journalPost(attemptId, "/admit", {
    candidates: [{ eventId, payload: "cGFydGlhbA==", tags }],
    consistencyTags: tags.map((tag) => ({ tag, lastSortableUniqueId: "" })),
    commitContext: {
      attemptId,
      serviceId: SERVICE_ID,
      ...(options.testFenceInstallFaultOnce === true ? { testFenceInstallFaultOnce: true } : {}),
    },
  });
  expect(admitted.status).toBe(201);
  let record = await responseJson<JournalRecord>(admitted);
  record = await journalTransition(attemptId, record, "RESERVED");

  const tokens = new Map<string, string>();
  for (const tag of tags) {
    const acquired = await tagPost(tag, "/acquire", {
      attemptId,
      epoch: 0,
      eventTags: tags,
      consistencyTags: tags.map((entry) => ({ tag: entry, lastSortableUniqueId: "" })),
    });
    expect(acquired.status).toBe(201);
    tokens.set(tag, (await responseJson<{ reservation: { token: string } }>(acquired)).reservation.token);
  }
  record = await journalTransition(attemptId, record, "ALLOCATED");
  record = await journalTransition(attemptId, record, "WRITING");
  const partialAppend = await tagPost(writtenTag, "/append", {
    attemptId,
    epoch: 0,
    reservationToken: tokens.get(writtenTag),
    candidates: [{
      eventId,
      suid: "suid-00000000000000000000000000000001",
      payload: "cGFydGlhbA==",
      eventTags: tags,
    }],
  });
  expect(partialAppend.status).toBe(201);
  const sealing = await journalPost(attemptId, "/transition", {
    expectedState: record.state,
    expectedVersion: record.version,
    expectedOwnerEpoch: record.ownerEpoch,
    nextState: "SEALING",
    ...(options.alarmFault === undefined ? {} : { alarmFaults: [options.alarmFault] }),
  });
  expect(sealing.status).toBe(200);
  return {
    attemptId,
    writtenTag,
    missingTag,
    record: await responseJson<JournalRecord>(sealing),
  };
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
      { payload: "cGF5bG9hZC0x", eventPayloadName: "First", tags: [observed, unobserved] },
      { payload: "cGF5bG9hZC0y", eventPayloadName: "Second", tags: [unobserved] },
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
    // The observed tag has the extra acquire mutation; the unobserved tag is
    // written only in the append phase and never appears in the fan-out.
    expect(observedState.version).toBe(unobservedState.version + 1);
    expect(observedState.confirmations).toHaveLength(1);
    expect(unobservedState.confirmations).toHaveLength(0);
    expect(unobservedState.activeReservation).toBeNull();

    const empty = await commit({ version: 1 });
    expect(empty.status).toBe(200);
    expect(await responseJson<CommitResponse>(empty)).toMatchObject({ writtenEvents: [], tagWriteResults: [] });
  });

  it("AC2: settles the whole reservation fan-out, tombstones every observed tag, then terminalizes", async () => {
    const delayedA = newTag("delayed-a");
    const delayedB = newTag("delayed-b");
    const delayed = await commit({
      version: 1,
      eventCandidates: [candidate("YQ==", "Delayed", [delayedA, delayedB])],
      consistencyTags: [
        { tag: delayedA, lastSortableUniqueId: "" },
        { tag: delayedB, lastSortableUniqueId: "" },
      ],
    }, "reservation-delayed-success");
    await expectSection6Error(delayed, 504, "timeout");
    const delayedAttempt = delayed.headers.get("x-sdt-g4-attempt-id");
    expect(delayedAttempt).not.toBeNull();
    const failed = await journalState(delayedAttempt!);
    expect(failed.state).toBe("FAILED");
    expect(failed.terminalResponse?.reason).toContain("delayed reservation success");
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
            consistencyTags: [{ tag, lastSortableUniqueId: "" }],
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
        { tag: conflictTag, lastSortableUniqueId: "" },
        { tag: releasedTag, lastSortableUniqueId: "" },
      ],
    });
    await expectSection6Error(conflict, 400, "consistency_conflict");
    expect(await allocatorState()).toEqual(allocatorBeforeConflict);
    const released = await tagState(releasedTag);
    expect(released.activeReservation).toBeNull();
    expect(released.tombstones).toHaveLength(1);
    expect(released.events).toHaveLength(0);
  });

  it("runs the portable suite's commit-only assert-empty, exact-match, conflict, retry, null, and concurrent-SUID scenarios", async () => {
    const exactTag = newTag("conformance-exact");
    const freshTag = newTag("conformance-fresh");
    const write = async (tag: string, expected: string | null | undefined): Promise<Response> => commit({
      version: 1,
      eventCandidates: [candidate("Y29uZm9ybWFuY2U=", "ConformanceEvent", [tag])],
      consistencyTags: expected === undefined ? [] : [{ tag, lastSortableUniqueId: expected }],
    });

    const first = await write(exactTag, "");
    expect(first.status).toBe(200);
    const firstHead = (await responseJson<CommitResponse>(first)).writtenEvents[0]!.sortableUniqueIdValue;
    const exact = await write(exactTag, firstHead);
    expect(exact.status).toBe(200);
    const exactHead = (await responseJson<CommitResponse>(exact)).writtenEvents[0]!.sortableUniqueIdValue;
    expect(exactHead > firstHead).toBe(true);
    expect((await write(exactTag, firstHead)).status).toBe(400);
    expect((await write(exactTag, "")).status).toBe(400);

    const multiConflict = await commit({
      version: 1,
      eventCandidates: [candidate("bXVsdGk=", "ConformanceEvent", [exactTag, freshTag])],
      consistencyTags: [
        { tag: exactTag, lastSortableUniqueId: "" },
        { tag: freshTag, lastSortableUniqueId: "" },
      ],
    });
    expect(multiConflict.status).toBe(400);
    expect((await tagState(freshTag)).events).toHaveLength(0);
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

  it("AC3/AC5/AC6: only SEALING hands off a post-allocation write fault and a fully fenced partial maps to §7", async () => {
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
    const terminal = await journalState(partialAttempt!);
    expect(terminal.state).toBe("PARTIAL");
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

    expect(terminal.takeover?.sealedTags).toEqual(expect.arrayContaining([firstTag, missingTag]));
    expect(terminal.takeover?.fencedTags).toEqual([missingTag]);
    const first = await tagState(firstTag);
    const missing = await tagState(missingTag);
    expect(first.events).toHaveLength(1);
    expect(missing.events).toHaveLength(0);
    expect(missing.fences).toContainEqual({
      attemptId: partialAttempt,
      epoch: terminal.ownerEpoch,
      reason: "partial_write",
    });

    // The pure mapper receives terminal Journal data plus independently read
    // durable tag records; it cannot turn partial existence into a timeout.
    const fromTags = requeryFactsFromTagRecords(terminal, [
      { tag: firstTag, events: first.events },
      { tag: missingTag, events: missing.events },
    ]);
    expect(fromTags.missingTags).toEqual([missingTag]);
    const mapping = mapTerminalCommitOutcome({ ...terminal, reconciliation: fromTags });
    expect(mapping).toMatchObject({ status: 500, body: { code: "partial_write" } });
    expect((mapping?.body as { partial: { retryable: boolean } }).partial.retryable).toBe(false);
  });

  it("G5: an ordinary commit to a fenced tag with zero durable records returns Section 6 internal_error", async () => {
    const fencedTag = newTag("ordinary-fenced");
    expect((await tagPost(fencedTag, "/fence/install", {
      reason: "partial_write",
      attemptId: "repair-owner",
      epoch: 1,
    })).status).toBe(201);

    const response = await commit({
      version: 1,
      eventCandidates: [candidate("ZmVuY2Vk", "Blocked", [fencedTag])],
      consistencyTags: [{ tag: fencedTag, lastSortableUniqueId: "" }],
    });
    await expectSection6Error(response, 500, "internal_error");
    expect((await tagState(fencedTag)).events).toEqual([]);
  });

  it("G5 boundary 6: HTTP returns the Section 7 partial report only after the durable PARTIAL(FENCED) outcome", async () => {
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
    const terminal = await journalState(attemptId);
    expect(terminal.state).toBe("PARTIAL");
    expect(terminal.takeover?.fencedTags).toEqual([missingTag]);
    expect((await tagState(missingTag)).fences).toContainEqual({
      reason: "partial_write",
      attemptId,
      epoch: terminal.ownerEpoch,
    });
  });

  it("AC4: each named alarm crash point is re-armed, idempotent, and converges to one immutable outcome", async () => {
    const points: AlarmFaultPoint[] = [
      "handler-entry",
      "after-rearm-before-seal",
      "after-partial-seal",
      "after-full-seal-before-requery",
      "before-outcome-cas",
    ];
    for (const point of points) {
      const prepared = await prepareSealingAttempt(`alarm-${point}`, point);
      const beforeCrash = prepared.record;
      const firstWake = await journalPost(prepared.attemptId, "/debug/alarm", {});
      expect(firstWake.status).toBe(200);
      const afterCrash = await responseJson<JournalRecord>(firstWake);
      expect(afterCrash.state).toBe("SEALING");
      expect(afterCrash.alarm).not.toBeNull();
      expect(afterCrash.alarmFaults).not.toContain(point);
      expect(afterCrash.version).toBeGreaterThan(beforeCrash.version);

      const secondWake = await journalPost(prepared.attemptId, "/debug/alarm", {});
      expect(secondWake.status).toBe(200);
      const terminal = await responseJson<JournalRecord>(secondWake);
      expect(terminal.state).toBe("FAILED");
      expect(terminal.alarm).toBeNull();
      for (const tag of prepared.tags) {
        const state = await tagState(tag);
        expect(state.activeReservation).toBeNull();
        expect(state.tombstones).toContainEqual({ attemptId: prepared.attemptId, epoch: terminal.ownerEpoch });
      }

      const replay = await journalPost(prepared.attemptId, "/debug/alarm", {});
      expect(replay.status).toBe(200);
      const replayed = await responseJson<JournalRecord>(replay);
      expect(replayed.state).toBe(terminal.state);
      expect(replayed.terminalResponse).toEqual(terminal.terminalResponse);
    }
  });

  it("F-G4-1: zero-durable recovery fails without installing partial-write fences", async () => {
    const prepared = await prepareSealingAttempt("zero-durable");

    const recovered = await journalPost(prepared.attemptId, "/debug/alarm", {});
    expect(recovered.status).toBe(200);
    const terminal = await responseJson<JournalRecord>(recovered);
    expect(terminal.state).toBe("FAILED");

    for (const tag of prepared.tags) {
      const state = await tagState(tag);
      expect(state.events).toHaveLength(0);
      expect(state.fences).toEqual([]);
      expect(state.activeReservation).toBeNull();
      expect(state.tombstones).toContainEqual({ attemptId: prepared.attemptId, epoch: terminal.ownerEpoch });
    }
  });

  it("AC6: partial evidence without every durable missing-tag fence remains SEALING and has no application mapping", async () => {
    const attemptId = crypto.randomUUID();
    const writtenTag = newTag("fence-written");
    const missingTag = newTag("fence-missing");
    const eventId = `${attemptId}-event`;
    const admitted = await journalPost(attemptId, "/admit", {
      candidates: [{ eventId, payload: "ZmVuY2U=", tags: [writtenTag, missingTag] }],
      consistencyTags: [],
    });
    expect(admitted.status).toBe(201);
    let record = await responseJson<JournalRecord>(admitted);
    record = await journalTransition(attemptId, record, "RESERVED");
    record = await journalTransition(attemptId, record, "ALLOCATED");
    record = await journalTransition(attemptId, record, "WRITING");
    const reconciliation = {
      allocatorVector: ["suid-00000000000000000000000000000001"],
      records: [{ eventId, payload: "ZmVuY2U=", present: true }],
      failureCause: "write-failure" as const,
      missingTags: [missingTag],
    };
    const sealingResponse = await journalPost(attemptId, "/reconcile", {
      expectedState: record.state,
      expectedVersion: record.version,
      expectedOwnerEpoch: record.ownerEpoch,
      reconciliation,
    });
    expect(sealingResponse.status).toBe(200);
    let owner = await responseJson<JournalRecord>(sealingResponse);
    if (owner.takeover === null) {
      const takeoverWake = await journalPost(attemptId, "/debug/alarm", {});
      expect(takeoverWake.status).toBe(200);
      owner = await responseJson<JournalRecord>(takeoverWake);
    }
    expect(owner.takeover).not.toBeNull();

    const noFenceEvidence = await journalPost(attemptId, "/takeover", {
      expectedState: owner.state,
      expectedVersion: owner.version,
      expectedOwnerEpoch: owner.ownerEpoch,
      seals: owner.allTags.map((tag) => ({ tag, sealed: true })),
      fences: [],
      reconciliation,
    });
    expect(noFenceEvidence.status).toBe(202);
    const noFence = (await responseJson<{ journal: JournalRecord }>(noFenceEvidence)).journal;
    expect(noFence.takeover?.fencedTags).toEqual([]);
    expect(mapTerminalCommitOutcome(noFence)).toBeUndefined();

    const blockedWake = await journalPost(attemptId, "/debug/alarm", {});
    expect(blockedWake.status).toBe(200);
    const blocked = await responseJson<JournalRecord>(blockedWake);
    expect(blocked.state).toBe("SEALING");
    expect(mapTerminalCommitOutcome(blocked)).toBeUndefined();

    const durableFence = await SELF.fetch(
      `https://commit.test/tags/${encodeURIComponent(SERVICE_ID)}/${encodeURIComponent(missingTag)}/fence/install`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attemptId, epoch: blocked.ownerEpoch, reason: "partial_write" }),
      },
    );
    expect(durableFence.status).toBe(201);
    const fencedState = await tagState(missingTag);
    expect(fencedState.fences).toContainEqual({ attemptId, epoch: blocked.ownerEpoch, reason: "partial_write" });

    const fencedEvidence = await journalPost(attemptId, "/takeover", {
      expectedState: blocked.state,
      expectedVersion: blocked.version,
      expectedOwnerEpoch: blocked.ownerEpoch,
      seals: [],
      fences: [{ tag: missingTag, fenced: true }],
      reconciliation,
    });
    expect(fencedEvidence.status).toBe(202);
    const terminalWake = await journalPost(attemptId, "/debug/alarm", {});
    expect(terminalWake.status).toBe(200);
    expect((await responseJson<JournalRecord>(terminalWake)).state).toBe("PARTIAL");
  });

  it("G5 boundary 1: a crash after one durable fence install stays SEALING, re-arms, and resumes to PARTIAL(FENCED)", async () => {
    const prepared = await preparePartialFenceAttempt("partial-fence", { testFenceInstallFaultOnce: true });

    const afterPartialFence = await journalPost(prepared.attemptId, "/debug/alarm", {});
    expect(afterPartialFence.status).toBe(200);
    const sealing = await responseJson<JournalRecord>(afterPartialFence);
    expect(sealing.state).toBe("SEALING");
    expect(sealing.terminalResponse).toBeNull();
    expect(sealing.alarm).not.toBeNull();
    expect(sealing.takeover?.fencedTags).toEqual([]);
    expect((await tagState(prepared.missingTag)).fences).toContainEqual({
      reason: "partial_write",
      attemptId: prepared.attemptId,
      epoch: sealing.ownerEpoch,
    });

    const resumed = await journalPost(prepared.attemptId, "/debug/alarm", {});
    expect(resumed.status).toBe(200);
    const terminal = await responseJson<JournalRecord>(resumed);
    expect(terminal.state).toBe("PARTIAL");
    expect(terminal.takeover?.fencedTags).toEqual([prepared.missingTag]);
  });

  it("G5 boundaries 2 and 3: fence-before-cancel and pre-CAS faults cannot publish a partial outcome", async () => {
    for (const alarmFault of ["after-fence-before-cancel", "before-outcome-cas"] as const) {
      const prepared = await preparePartialFenceAttempt(`ordered-${alarmFault}`, { alarmFault });
      const interrupted = await journalPost(prepared.attemptId, "/debug/alarm", {});
      expect(interrupted.status).toBe(200);
      const sealing = await responseJson<JournalRecord>(interrupted);
      expect(sealing.state).toBe("SEALING");
      expect(sealing.terminalResponse).toBeNull();
      expect(sealing.alarm).not.toBeNull();
      expect((await tagState(prepared.missingTag)).fences).toContainEqual({
        reason: "partial_write",
        attemptId: prepared.attemptId,
        epoch: sealing.ownerEpoch,
      });

      const resumed = await journalPost(prepared.attemptId, "/debug/alarm", {});
      expect(resumed.status).toBe(200);
      const terminal = await responseJson<JournalRecord>(resumed);
      expect(terminal.state).toBe("PARTIAL");
      expect(terminal.takeover?.fencedTags).toEqual([prepared.missingTag]);
    }
  });

  it("G5 rotation fixture: a segment fence blocks partial repair until it is exactly cleared", async () => {
    const prepared = await preparePartialFenceAttempt("rotation-overlap");
    const rotationFence = await tagPost(prepared.missingTag, "/fence/install", {
      reason: "segment_rotation",
      attemptId: "rotation-owner",
      epoch: 1,
    });
    expect(rotationFence.status).toBe(201);

    const blocked = await journalPost(prepared.attemptId, "/debug/alarm", {});
    expect(blocked.status).toBe(200);
    const sealing = await responseJson<JournalRecord>(blocked);
    expect(sealing.state).toBe("SEALING");
    expect(sealing.terminalResponse).toBeNull();
    expect(sealing.alarm).not.toBeNull();
    const blockedTag = await tagState(prepared.missingTag);
    expect(blockedTag.fences).toContainEqual({ reason: "segment_rotation", attemptId: "rotation-owner", epoch: 1 });
    expect(blockedTag.fences).not.toContainEqual({
      reason: "partial_write",
      attemptId: prepared.attemptId,
      epoch: sealing.ownerEpoch,
    });

    expect((await tagPost(prepared.missingTag, "/fence/clear", {
      reason: "segment_rotation",
      attemptId: "rotation-owner",
      epoch: 1,
    })).status).toBe(200);
    const resumed = await journalPost(prepared.attemptId, "/debug/alarm", {});
    expect(resumed.status).toBe(200);
    const terminal = await responseJson<JournalRecord>(resumed);
    expect(terminal.state).toBe("PARTIAL");
    expect(terminal.takeover?.fencedTags).toEqual([prepared.missingTag]);
  });

  it("AC5/AC6: a fence-not-durable attempt returns an undetermined timeout and its alarm keeps terminalizing", async () => {
    const writtenTag = newTag("timeout-written");
    const missingTag = newTag("timeout-missing");
    const attemptId = crypto.randomUUID();
    const response = await commit({
      version: 1,
      eventCandidates: [candidate("dGltZW91dA==", "Timeout", [writtenTag, missingTag])],
      consistencyTags: [],
    }, "fence-not-durable", attemptId);

    const timeout = await expectSection6Error(response, 504, "timeout");
    expect(timeout.error).toContain("outcome is undetermined");
    expect(timeout.error).toContain("reread tag heads and event/query state before retrying");
    expect(timeout.error).toContain("blind retry may create duplicate events");
    expect(timeout).not.toHaveProperty("partial");
    expect(timeout).not.toHaveProperty("writtenEvents");

    const sealing = await journalState(attemptId);
    expect(sealing.state).toBe("SEALING");
    expect(sealing.alarm).not.toBeNull();
    expect(sealing.commitContext?.testFenceNotDurable).toBe(true);
    expect(sealing.takeover?.fencedTags).toEqual([]);

    const terminalWake = await journalPost(attemptId, "/debug/alarm", { clearTestFenceNotDurable: true });
    expect(terminalWake.status).toBe(200);
    const terminal = await responseJson<JournalRecord>(terminalWake);
    expect(terminal.state).toBe("PARTIAL");
    expect(terminal.commitContext?.testFenceNotDurable).toBeUndefined();
    expect(terminal.takeover?.fencedTags).toEqual([missingTag]);
  });

  it("AC7: nonterminal faults return timeout JSON while recovery preserves allocator and Journal invariants", async () => {
    const allocationTag = newTag("allocator-journal");
    const allocatorBefore = await allocatorState();
    const allocationAttempt = crypto.randomUUID();
    const interrupted = await commit({
      version: 1,
      eventCandidates: [candidate("YWxsb2M=", "Allocated", [allocationTag])],
      consistencyTags: [{ tag: allocationTag, lastSortableUniqueId: "" }],
    }, "journal-cas-after-allocator", allocationAttempt);
    await expectSection6Error(interrupted, 504, "timeout");
    expect((await journalState(allocationAttempt)).state).toBe("RESERVED");
    const allocatedVectorResponse = await SELF.fetch(
      `https://commit.test/allocator/attempts/${encodeURIComponent(allocationAttempt)}`,
    );
    expect(allocatedVectorResponse.status).toBe(200);
    const vector = await responseJson<{ candidates: Array<{ eventId: string; suid: string }> }>(allocatedVectorResponse);
    expect(vector.candidates).toHaveLength(1);

    const afterAllocatorCommit = await allocatorState();
    expect(afterAllocatorCommit.allocatedWatermark).not.toBe(allocatorBefore.allocatedWatermark);
    expect((await journalPost(allocationAttempt, "/debug/alarm", {})).status).toBe(200);
    expect((await journalState(allocationAttempt)).state).toBe("ALLOCATED");
    expect((await journalPost(allocationAttempt, "/debug/alarm", {})).status).toBe(200);
    const recoveredAllocation = await journalState(allocationAttempt);
    expect(recoveredAllocation.state).toBe("FAILED");
    expect(await allocatorState()).toEqual(afterAllocatorCommit);
    const sealedTag = await tagState(allocationTag);
    expect(sealedTag.events).toHaveLength(0);
    expect(sealedTag.activeReservation).toBeNull();

    const conflictTag = newTag("tombstone-conflict");
    const lateTag = newTag("tombstone-late");
    expect((await commit({
      version: 1,
      eventCandidates: [candidate("c2VlZA==", "Seed", [conflictTag])],
      consistencyTags: [{ tag: conflictTag, lastSortableUniqueId: "" }],
    })).status).toBe(200);
    const tombstoneAttempt = crypto.randomUUID();
    const afterTombstone = await commit({
      version: 1,
      eventCandidates: [candidate("bGF0ZQ==", "Late", [conflictTag, lateTag])],
      consistencyTags: [
        { tag: conflictTag, lastSortableUniqueId: "" },
        { tag: lateTag, lastSortableUniqueId: "" },
      ],
    }, "tombstone-after-durable", tombstoneAttempt);
    await expectSection6Error(afterTombstone, 504, "timeout");
    const pending = await journalState(tombstoneAttempt);
    expect(pending.state).toBe("RESERVED");
    expect(pending.reservationFailure).toMatchObject({ outcome: "REFUSED" });
    const lateState = await tagState(lateTag);
    expect(lateState.activeReservation).toBeNull();
    expect(lateState.tombstones).toContainEqual({ attemptId: tombstoneAttempt, epoch: 0 });

    expect((await journalPost(tombstoneAttempt, "/debug/alarm", {})).status).toBe(200);
    const refused = await journalState(tombstoneAttempt);
    expect(refused.state).toBe("REFUSED");
    const staleTerminalWrite = await journalPost(tombstoneAttempt, "/transition", {
      expectedState: "RESERVED",
      expectedVersion: pending.version,
      expectedOwnerEpoch: pending.ownerEpoch,
      nextState: "FAILED",
    });
    expect(staleTerminalWrite.status).toBe(409);
    expect((await journalState(tombstoneAttempt)).terminalResponse).toEqual(refused.terminalResponse);

    const allocationFailureTag = newTag("allocator-failure");
    const allocationStateBeforeFailure = await allocatorState();
    const allocationFailure = await commit({
      version: 1,
      eventCandidates: [candidate("ZmFpbA==", "AllocatorFault", [allocationFailureTag])],
      consistencyTags: [{ tag: allocationFailureTag, lastSortableUniqueId: "" }],
    }, "allocator-commit");
    await expectSection6Error(allocationFailure, 500, "internal_error");
    expect(await allocatorState()).toEqual(allocationStateBeforeFailure);
    const failedAttempt = allocationFailure.headers.get("x-sdt-g4-attempt-id");
    expect((await journalState(failedAttempt!)).state).toBe("FAILED");
    const failedTag = await tagState(allocationFailureTag);
    expect(failedTag.events).toHaveLength(0);
    expect(failedTag.activeReservation).toBeNull();
  });

  it("returns Section 6 JSON when a completed commit cannot prepare its success response", async () => {
    const attemptId = crypto.randomUUID();
    const response = await commit({
      version: 1,
      eventCandidates: [candidate("c3RhdGU=", "ResponseRead", [newTag("response-read")])],
      consistencyTags: [],
    }, "tag-state-unavailable", attemptId);

    await expectSection6Error(response, 500, "internal_error");
    expect((await journalState(attemptId)).state).toBe("COMPLETE");
  });
});
