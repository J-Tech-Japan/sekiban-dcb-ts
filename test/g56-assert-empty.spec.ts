import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  ClaimLedgerExecutor,
  type CommitEnvelope,
  type ReadonlyTagStateResponse,
  type SerializedDcbTransport,
} from "../packages/dcb-client/src/index";
import {
  event,
  projector,
  read,
  readExists,
  readSet,
  Session,
  tagFamily,
} from "../packages/dcb-domain/src/index";
import { handleSerializedCommit, validateCommitEnvelope, type CommitWorkerEnv } from "../packages/dcb-runtime/src/commit/CommitWorker";
import type { TagRecord } from "../packages/dcb-runtime/src/tag/types";
import { TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/service/ServiceIdentityProvider";
import { defineEvent } from "../packages/dcb-core/src/index";
import { z } from "zod";
import { G32_FIXTURE_TIMESTAMP, g32EventId, g32Suid } from "./helpers/g32-fixtures";

const order = tagFamily("g56-order");
const placed = event("G56AssertEmptyPlaced", z.object({ value: z.string() }), {
  tags: () => [order.of("state-empty")],
});
const orderProjector = projector({
  id: "g56-order-projector",
  tag: order,
  events: [placed],
  initialState: { status: "empty" },
  handlers: { G56AssertEmptyPlaced: (state) => state },
});

interface Section6Error {
  readonly code?: string;
  readonly error?: string;
}

interface CommitResponse {
  readonly writtenEvents: readonly [{ readonly sortableUniqueIdValue: string }];
  readonly tagWriteResults: readonly [{ readonly tag: string; readonly version: number }];
}

interface ReservationResponse {
  readonly reservation: { readonly token: string; readonly expectedHead: string };
  readonly version: number;
}

function requestBody(tag: string, value: number): Record<string, unknown> {
  return {
    version: 1,
    eventCandidates: [{
      payload: btoa(JSON.stringify({ value })),
      eventPayloadName: "G56AssertEmptyPlaced",
      tags: [tag],
    }],
    consistencyTags: [{ tag, lastSortableUniqueId: "" }],
  };
}

async function commit(body: unknown): Promise<Response> {
  return SELF.fetch("https://g56.test/api/sekiban/serialized/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function scope(tag = `tag-${crypto.randomUUID()}`): { readonly serviceId: string; readonly tag: string } {
  return { serviceId: `g56-${crypto.randomUUID()}`, tag };
}

async function post(value: { readonly serviceId: string; readonly tag: string }, path: string, body: unknown): Promise<Response> {
  return SELF.fetch(
    `https://g56.test/tags/${encodeURIComponent(value.serviceId)}/${encodeURIComponent(value.tag)}${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: value.serviceId },
      body: JSON.stringify(body),
    },
  );
}

async function state(value: { readonly serviceId: string; readonly tag: string }): Promise<TagRecord> {
  const response = await SELF.fetch(
    `https://g56.test/tags/${encodeURIComponent(value.serviceId)}/${encodeURIComponent(value.tag)}/state`,
    { headers: { [TEST_SERVICE_ID_HEADER]: value.serviceId } },
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<TagRecord>;
}

function directCandidate(value: { readonly serviceId: string; readonly tag: string }, suffix: string) {
  return {
    eventId: g32EventId(`g56-${suffix}`),
    suid: g32Suid(`g56-${suffix}`),
    payload: JSON.stringify({ value: suffix }),
    eventTags: [value.tag],
    allocatorLineageId: "g56-fixture-lineage",
    eventType: "G56AssertEmptyPlaced",
    provenance: "g32" as const,
    timestamp: G32_FIXTURE_TIMESTAMP,
  };
}

async function json<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

function transport(capture: { value?: CommitEnvelope }): SerializedDcbTransport {
  return {
    readTagState: async ({ tagStateId }): Promise<ReadonlyTagStateResponse> => {
      const [tagGroup, tagContent, tagProjector] = tagStateId.split(":");
      return {
        payload: { status: "empty" },
        version: 0,
        lastSortedUniqueId: "",
        tagGroup: tagGroup ?? "g56-order",
        tagContent: tagContent ?? "empty",
        tagProjector: tagProjector ?? "g56-order-projector",
      };
    },
    commit: async (envelope) => {
      capture.value = envelope;
      return { status: 200, body: { writtenEvents: [], tagWriteResults: [] } };
    },
  };
}

describe("SDT-G56 assert-empty contract", () => {
  it("AC1: accepts only the explicit empty string before admission and keeps typed invalid inputs", async () => {
    const tag = `g56-validator-${crypto.randomUUID()}`;
    const accepted = validateCommitEnvelope(requestBody(tag, 1));
    expect(accepted).toHaveProperty("value");

    const invalidInputs: readonly [unknown, string][] = [
      [null, "malformed_commit_envelope"],
      [17, "malformed_commit_envelope"],
      [{ ...requestBody(tag, 2), consistencyTags: [{ tag, lastSortableUniqueId: null }] }, "malformed_commit_envelope"],
      [{ ...requestBody(tag, 3), consistencyTags: [{ tag, lastSortableUniqueId: 4 }] }, "malformed_commit_envelope"],
      [{ ...requestBody(tag, 4), consistencyTags: [{ tag, lastSortableUniqueId: "not-a-suid" }] }, "invalid_sortable_unique_id"],
    ];
    for (const [body, code] of invalidInputs) {
      const result = validateCommitEnvelope(body);
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect((await result.error.json() as Section6Error).code).toBe(code);
      }
    }

    const calls = { count: 0 };
    const namespace = {
      idFromName: () => { calls.count += 1; return {} as DurableObjectId; },
      get: () => { calls.count += 1; return { fetch: async () => { calls.count += 1; return Response.json({}) as Response; } } as unknown as DurableObjectStub; },
    } as unknown as DurableObjectNamespace;
    const environment = { SDT_SERVICE_ID: "g56-validator", ALLOCATOR: namespace, BOOTSTRAP: namespace, TAG: namespace } as unknown as CommitWorkerEnv;
    const response = await handleSerializedCommit(new Request("https://g56.test/api/sekiban/serialized/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...requestBody(tag, 5), consistencyTags: [{ tag, lastSortableUniqueId: null }] }),
    }), environment);
    expect(response.status).toBe(400);
    expect((await json<Section6Error>(response)).code).toBe("malformed_commit_envelope");
    expect(calls.count).toBe(0);
  });

  it("AC2/AC3: reserves an empty tag without a synthetic event, writes version one, repeats as a typed conflict, and admits one race winner", async () => {
    const value = scope();
    const acquired = await post(value, "/acquire", {
      attemptId: "g56-empty-first",
      epoch: 1,
      eventTags: [value.tag],
      consistencyTags: [{ tag: value.tag, lastSortableUniqueId: "" }],
    });
    expect(acquired.status).toBe(201);
    const reservation = await json<ReservationResponse>(acquired);
    expect(reservation.reservation.expectedHead).toBe("");
    expect((await state(value)).events).toHaveLength(0);

    const appended = await post(value, "/append", {
      attemptId: "g56-empty-first",
      epoch: 1,
      reservationToken: reservation.reservation.token,
      candidates: [directCandidate(value, "empty-first")],
    });
    expect(appended.status).toBe(201);
    const afterAppend = await state(value);
    expect(afterAppend.events).toHaveLength(1);
    expect(afterAppend.version).toBe(1);
    expect(afterAppend.activeReservation).toBeNull();

    const committedEmptyAcquire = await post(value, "/acquire", {
      attemptId: "g56-empty-after-commit",
      epoch: 1,
      eventTags: [value.tag],
      consistencyTags: [{ tag: value.tag, lastSortableUniqueId: "" }],
    });
    expect(committedEmptyAcquire.status).toBe(409);
    expect(await json<{ readonly reason: string }>(committedEmptyAcquire)).toMatchObject({
      reason: "consistency_head_mismatch_assert_empty",
    });

    const commitTag = `g56-commit-${crypto.randomUUID()}`;
    const firstCommit = await commit(requestBody(commitTag, 2));
    expect(firstCommit.status).toBe(200);
    const firstCommitBody = await json<CommitResponse>(firstCommit);
    expect(firstCommitBody.tagWriteResults[0]?.version).toBe(1);
    const repeated = await commit(requestBody(commitTag, 3));
    expect(repeated.status).toBe(400);
    expect(await json<Section6Error>(repeated)).toMatchObject({ code: "consistency_conflict" });

    const raced = scope();
    const raceResponses = await Promise.all([1, 2].map((index) => post(raced, "/acquire", {
      attemptId: `g56-race-${index}`,
      epoch: 1,
      eventTags: [raced.tag],
      consistencyTags: [{ tag: raced.tag, lastSortableUniqueId: "" }],
    })));
    expect(raceResponses.map((response) => response.status).sort()).toEqual([201, 409]);
    const raceReasons = await Promise.all(raceResponses.map(async (response) => response.status === 409 ? (await json<{ readonly reason: string }>(response)).reason : undefined));
    expect(raceReasons.find((reason) => reason !== undefined)).toContain("assert_empty");

    const commitRaced = scope();
    const commitRaceResponses = await Promise.all([1, 2].map((index) => commit(requestBody(commitRaced.tag, index))));
    expect(commitRaceResponses.map((response) => response.status).sort()).toEqual([200, 400]);
    expect((await Promise.all(commitRaceResponses.map(async (response) => response.status === 400 ? json<Section6Error>(response) : undefined)))
      .find((body) => body !== undefined)).toMatchObject({ code: "consistency_conflict" });
  });

  it("AC4: emits empty claims only after an empty read and preserves the empty V1 member byte-for-byte", async () => {
    const stateTag = order.of("state-empty");
    const existsTag = order.of("exists-empty");
    const unreadTag = order.of("never-read");
    const stateSession = new Session({
      now: 0,
      readSet: readSet(read(orderProjector, stateTag)),
      snapshots: { read: (projector, tag) => ({ projectorId: projector.id, tag, head: null, state: { status: "empty" }, exists: false }) },
    });
    await stateSession.preload();
    expect(stateSession.readClaims).toMatchObject([{ tag: { id: stateTag.id }, head: "" }]);

    const existsSession = new Session({
      now: 0,
      readSet: readSet(readExists(existsTag)),
      snapshots: { read: (projector, tag) => ({ projectorId: projector.id, tag, head: null, state: { status: "empty" }, exists: false }), exists: () => false },
    });
    await existsSession.preload();
    expect(existsSession.readClaims).toMatchObject([{ tag: { id: existsTag.id }, head: "" }]);
    expect(existsSession.readClaims.some((claim) => claim.tag.id === unreadTag.id)).toBe(false);

    const capture: { value?: CommitEnvelope } = {};
    const executor = new ClaimLedgerExecutor({ transport: transport(capture) });
    const event = defineEvent("G56ClientEvent");
    const result = await executor.execute(async (context) => {
      await context.readTagState(`${stateTag.id}:${orderProjector.id}`);
      context.append(event, { value: 1 }, [stateTag]);
      return { kind: "committed" };
    });
    expect(result.kind).toBe("committed");
    expect(capture.value?.consistency).toEqual([{ tag: stateTag.id, lastSortableUniqueId: "" }]);
  });
});
