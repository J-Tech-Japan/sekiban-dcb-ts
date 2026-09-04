import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ClientError,
  createHttpTransport,
  createInProcessTransport,
  createSekibanCloudTransport,
  createSekibanExecutor,
  type CommitEnvelope,
  type ReadonlyTagStateResponse,
  type SerializedDcbTransport,
} from "../packages/dcb-client/src/index";
import {
  command,
  done,
  event,
  readExists,
  tagFamily,
  type PortableSnapshot,
  type Tag,
} from "@sekiban/dcb-domain";
import {
  createRoomCommand,
  meetingRoomProjectors,
  releaseRoomCommand,
  reserveRoomCommand,
  reservationTag,
  roomTag,
} from "../samples/meeting-room/src/domain";

const roomProjector = meetingRoomProjectors.roomProjector;
const reservationProjector = meetingRoomProjectors.reservationProjector;

function encoded(value: unknown): string {
  return btoa(JSON.stringify(value));
}

function emptyState(
  projector: { readonly id: string; readonly version: number; readonly initialState: unknown | (() => unknown) },
  tag: { readonly group: string; readonly value: string },
): ReadonlyTagStateResponse {
  const state = typeof projector.initialState === "function" ? projector.initialState() : projector.initialState;
  return {
    payload: encoded(state),
    version: 0,
    lastSortedUniqueId: "",
    tagGroup: tag.group,
    tagContent: tag.value,
    tagProjector: projector.id,
    tagPayloadName: `${projector.id}State`,
    projectorVersion: String(projector.version),
  };
}

function fixtureTransport(overrides: Partial<SerializedDcbTransport> = {}): SerializedDcbTransport {
  return {
    readTagState: async ({ tagStateId }) => {
      const [group, content, projectorId] = tagStateId.split(":");
      const projector = projectorId === reservationProjector.id ? reservationProjector : roomProjector;
      const tag = group === "reservation" ? reservationTag(content ?? "reservation") : roomTag(content ?? "room");
      return emptyState(projector, tag as ReturnType<typeof roomTag>);
    },
    readTagLatestSortable: async () => ({ exists: false, lastSortableUniqueId: "" }),
    commit: async () => ({ status: 200, body: { writtenEvents: [], tagWriteResults: [] } }),
    query: async () => ({ status: 200, body: { resultJson: "{}" } }),
    listQuery: async () => ({ status: 200, body: { itemsJson: "[]", totalCount: 0, totalPages: 0, currentPage: 1, pageSize: 20 } }),
    ...overrides,
  };
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function runtimeFixture(captures: Array<{ readonly path: string; readonly body: unknown; readonly headers: Headers }>) {
  let committed = false;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = request.method === "POST" ? await request.clone().json().catch(() => undefined) : undefined;
    captures.push({ path: new URL(request.url).pathname, body, headers: request.headers });
    const path = new URL(request.url).pathname;
    if (path.endsWith("/tag-state")) {
      const tagStateId = String((body as { readonly tagStateId?: string } | undefined)?.tagStateId ?? "room:fixture:RoomProjector");
      const [group, content, projectorId] = tagStateId.split(":");
      const projector = projectorId === reservationProjector.id ? reservationProjector : roomProjector;
      const tag = group === "reservation" ? reservationTag(content ?? "fixture") : roomTag(content ?? "fixture");
      const state = projector === roomProjector && content === "room-1" && committed
        ? { status: "created", version: 1, roomId: "room-1", name: "Room" }
        : typeof projector.initialState === "function" ? projector.initialState() : projector.initialState;
      return response(200, {
        payload: encoded(state),
        version: state.status === "empty" ? 0 : 1,
        lastSortedUniqueId: state.status === "empty" ? "" : "suid-room-1",
        tagGroup: tag.group,
        tagContent: tag.value,
        tagProjector: projector.id,
        tagPayloadName: `${projector.id}State`,
        projectorVersion: String(projector.version),
      });
    }
    if (path.endsWith("/tag-latest-sortable")) return response(200, { exists: false, lastSortableUniqueId: "" });
    if (path.endsWith("/commit")) {
      committed = true;
      return response(200, {
        writtenEvents: [{ sortableUniqueIdValue: "suid-committed" }],
        tagWriteResults: [],
        head: "suid-committed",
        heads: [{ tag: "room:room-1", head: "suid-committed" }],
      });
    }
    if (path.endsWith("/query")) return response(200, { resultJson: "{}" });
    if (path.endsWith("/list-query")) return response(200, { itemsJson: "[]", totalCount: 0, totalPages: 0, currentPage: 1, pageSize: 20 });
    return response(404, { code: "not_found", error: "fixture route not found" });
  };
}

function snapshot(
  projector: { readonly id: string },
  tag: Tag,
  state: unknown,
  head: string | null,
  exists: boolean,
): PortableSnapshot {
  return Object.freeze({ projectorId: projector.id, tag, state, head, exists }) as PortableSnapshot;
}

describe("SDT-G57 executor facade deploy-free contract", () => {
  it("AC1: emits byte-identical V1 commit envelopes through in-process and HTTP transports", async () => {
    const inProcessCalls: Array<{ readonly path: string; readonly body: unknown; readonly headers: Headers }> = [];
    const httpCalls: Array<{ readonly path: string; readonly body: unknown; readonly headers: Headers }> = [];
    const inProcess = createSekibanExecutor(createInProcessTransport({ fetch: runtimeFixture(inProcessCalls) }, { serviceId: "g57-local" }));
    const http = createSekibanExecutor(createHttpTransport({
      baseUrl: "https://local-runtime.test",
      headers: { "x-test-transport": "http" },
      fetch: runtimeFixture(httpCalls),
    }));

    const first = await inProcess.execute(createRoomCommand, { roomId: "room-1", name: "Room" });
    const second = await http.execute(createRoomCommand, { roomId: "room-1", name: "Room" });
    expect(first.kind).toBe("committed");
    expect(second.kind).toBe("committed");
    const firstCommit = inProcessCalls.find((call) => call.path.endsWith("/commit"));
    const secondCommit = httpCalls.find((call) => call.path.endsWith("/commit"));
    expect(firstCommit?.body).toEqual(secondCommit?.body);
    expect(firstCommit?.body).toMatchObject({
      version: 1,
      consistencyTags: [{ tag: "room:room-1", lastSortableUniqueId: "" }],
    });
    expect((firstCommit?.body as { readonly eventCandidates: readonly [{ readonly payload: string }] }).eventCandidates[0]?.payload).toMatch(/^[A-Za-z0-9+/]+=*$/);

    const reserveInProcess = await inProcess.execute(reserveRoomCommand, { roomId: "room-1", reservationId: "reservation-1", userId: "u" });
    const reserveHttp = await http.execute(reserveRoomCommand, { roomId: "room-1", reservationId: "reservation-1", userId: "u" });
    expect(reserveInProcess.kind).toBe("committed");
    expect(reserveHttp.kind).toBe("committed");
    const reservePayloads = [...inProcessCalls, ...httpCalls]
      .filter((call) => call.path.endsWith("/commit"))
      .map((call) => JSON.stringify(call.body));
    expect(reservePayloads[1]).toBe(reservePayloads[3]);
    expect(JSON.parse(reservePayloads[1]).consistencyTags).toEqual([
      { tag: "room:room-1", lastSortableUniqueId: "suid-room-1" },
      { tag: "reservation:reservation-1", lastSortableUniqueId: "" },
    ]);
  });

  it("AC2: snapshot-only makes zero reads, fails closed on an uncovered claim, and chains returned heads", async () => {
    const counts = { reads: 0, commits: 0 };
    const transport = fixtureTransport({
      readTagState: async () => {
        counts.reads += 1;
        return emptyState(roomProjector, roomTag("room-1"));
      },
      commit: async () => {
        counts.commits += 1;
        return { status: 200, body: { head: "suid-chain", heads: [{ tag: "room:room-1", head: "suid-chain" }] } };
      },
    });
    const executor = createSekibanExecutor(transport, { clock: () => 123 });
    const empty = snapshot(roomProjector, roomTag("room-1"), { status: "empty", version: 0, roomId: null, name: "" }, null, false);
    const committed = await executor.execute(createRoomCommand, { roomId: "room-1", name: "Room" }, { snapshots: [empty], readMode: "snapshot-only" });
    expect(committed).toMatchObject({ kind: "committed", head: "suid-chain", heads: [{ tag: { id: "room:room-1" }, head: "suid-chain" }] });
    expect(counts.reads).toBe(0);
    expect(counts.commits).toBe(1);

    const uncovered = await executor.execute(reserveRoomCommand, { roomId: "room-1", reservationId: "reservation-1", userId: "u" }, {
      snapshots: [snapshot(roomProjector, roomTag("room-1"), { status: "created", version: 1, roomId: "room-1", name: "Room" }, "suid-chain", true)],
      readMode: "snapshot-only",
    });
    expect(uncovered).toMatchObject({ kind: "invalid", code: "executor.snapshot_missing" });
    expect(counts.reads).toBe(0);
    expect(counts.commits).toBe(1);

    const chainCounts = { reads: 0, commits: 0 };
    const chainExecutor = createSekibanExecutor(fixtureTransport({
      readTagState: async () => {
        chainCounts.reads += 1;
        return emptyState(roomProjector, roomTag("room-1"));
      },
      commit: async () => {
        chainCounts.commits += 1;
        return { status: 200, body: { head: "suid-next", heads: [{ tag: "room:room-1", head: "suid-next" }] } };
      },
    }));
    const first = await chainExecutor.execute(createRoomCommand, { roomId: "room-1", name: "Room" });
    const head = (first as unknown as { readonly heads: readonly [{ readonly tag: { readonly id: string }; readonly head: string }] }).heads[0].head;
    const second = await chainExecutor.execute(releaseRoomCommand, { roomId: "room-1" }, {
      snapshots: [snapshot(roomProjector, roomTag("room-1"), { status: "created", version: 1, roomId: "room-1", name: "Room" }, head, true)],
      readMode: "snapshot-only",
    });
    expect(second.kind).toBe("committed");
    expect(chainCounts.reads).toBe(1);
    expect(chainCounts.commits).toBe(2);
  });

  it("AC3: maps state, assert-empty, and unclaimed tags without inventing claims", async () => {
    const family = tagFamily("g57");
    const tag = family.of("empty");
    const placed = event("G57Placed", z.object({ value: z.string() }), { tags: () => [tag] });
    const existsCommand = command({
      id: "g57-exists",
      input: z.object({ value: z.string() }),
      reads: () => readExists(tag),
      handle: async (input, context) => {
        await context.exists(tag);
        context.append(placed, placed.make({ value: input.value }));
        return done({ value: input.value });
      },
    });
    let captured: CommitEnvelope | undefined;
    const capturedEnvelope = (): CommitEnvelope => {
      if (captured === undefined) throw new Error("commit envelope was not captured");
      return captured;
    };
    const executor = createSekibanExecutor(fixtureTransport({
      readTagState: async () => emptyState(roomProjector, roomTag("fallback")),
      readTagLatestSortable: async () => ({ exists: false, lastSortableUniqueId: "" }),
      commit: async (envelope) => {
        captured = envelope;
        return { status: 200, body: { writtenEvents: [] } };
      },
    }));
    const result = await executor.execute(existsCommand, { value: "x" });
    expect(result.kind).toBe("committed");
    expect(capturedEnvelope().consistency).toEqual([{ tag: "g57:empty", lastSortableUniqueId: "" }]);
    expect(capturedEnvelope().candidates[0]?.tags).toEqual(["g57:empty"]);
    expect(capturedEnvelope().consistency).toHaveLength(1);

    captured = undefined;
    const existingExecutor = createSekibanExecutor(fixtureTransport({
      readTagLatestSortable: async () => ({ exists: true, lastSortableUniqueId: "suid-existing" }),
      commit: async (envelope) => {
        captured = envelope;
        return { status: 200, body: { writtenEvents: [] } };
      },
    }));
    await existingExecutor.execute(existsCommand, { value: "existing" });
    expect(capturedEnvelope().consistency).toEqual([{ tag: "g57:empty", lastSortableUniqueId: "suid-existing" }]);

    const unclaimedTag = family.of("unclaimed");
    const unclaimedEvent = event("G57Unclaimed", z.object({ value: z.string() }), { tags: () => [unclaimedTag] });
    const unclaimedCommand = command({
      id: "g57-unclaimed",
      input: z.object({ value: z.string() }),
      reads: () => readExists(tag),
      handle: async (input, context) => {
        await context.exists(tag);
        context.append(unclaimedEvent, unclaimedEvent.make({ value: input.value }));
        return done({ value: input.value });
      },
    });
    captured = undefined;
    await executor.execute(unclaimedCommand, { value: "unclaimed" });
    expect(capturedEnvelope().candidates[0]?.tags).toEqual(["g57:unclaimed"]);
    expect(capturedEnvelope().consistency).toEqual([]);
  });

  it("AC2: exposes typed conflict details without retrying when retries are disabled", async () => {
    const executor = createSekibanExecutor(fixtureTransport({
      commit: async () => ({
        status: 409,
        body: {
          code: "consistency_conflict",
          conflicts: [{ tag: "room:room-1", expectedHead: "", actualHead: "suid-existing" }],
        },
      }),
    }));
    const result = await executor.execute(createRoomCommand, { roomId: "room-1", name: "Room" }, { maxConflictRetries: 0 });
    expect(result).toMatchObject({
      kind: "conflict",
      conflicts: [{ tag: { id: "room:room-1" }, expectedHead: "", actualHead: "suid-existing" }],
    });
  });

  it("AC4: maps cloud credentials to typed rejection without leaking the secret and rejects scope mismatch", async () => {
    const secret = "fixture-secret-that-must-not-escape";
    let calls = 0;
    const cloud = createSekibanCloudTransport({
      BaseUrl: "https://cloud.test",
      ServiceId: "service-a",
      CredentialId: "credential-a",
      CredentialSecret: secret,
      fetch: async () => {
        calls += 1;
        return response(403, { code: "unauthorized", error: "credential rejected" });
      },
    });
    await expect(cloud.query({ queryType: "q", queryParamsJson: "{}" })).rejects.toMatchObject({ code: "credential.rejected", status: 403 });
    await expect(cloud.query({ queryType: "q", queryParamsJson: "{}" })).rejects.not.toThrow(secret);
    expect(calls).toBe(2);

    const mismatch = createSekibanExecutor(fixtureTransport({ serviceId: "service-a" }), { serviceId: "service-b" });
    const result = await mismatch.execute(createRoomCommand, { roomId: "room-1", name: "Room" });
    expect(result).toMatchObject({ kind: "invalid", code: "scope.mismatch" });
    expect(result).not.toHaveProperty("error", expect.stringContaining(secret));
    expect(new ClientError("scope.mismatch", "scope mismatch")).toBeInstanceOf(Error);
  });
});
