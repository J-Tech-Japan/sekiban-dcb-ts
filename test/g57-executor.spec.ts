import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ClientError,
  createHttpTransport,
  createInProcessTransport,
  createSekibanExecutor,
  type CommitEnvelope,
  type ReadonlyTagStateResponse,
  type SerializedDcbTransport,
} from "../packages/dcb-client/src/index";
import {
  command,
  done,
  event,
  read,
  readExists,
  readSet,
  reject,
  tagFamily,
  type PortableSnapshot,
  type SnapshotReader,
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
    // The authority is a durable Tag-record fact. This fixture models a
    // pre-existing tag so read-through tests still exercise tag-state; cases
    // that need absence override the authority explicitly below.
    readTagLatestSortable: async () => ({ exists: true, lastSortableUniqueId: "" }),
    commit: async () => ({ status: 200, body: { writtenEvents: [], tagWriteResults: [] } }),
    query: async () => ({ status: 200, body: { resultJson: "{}" } }),
    listQuery: async () => ({ status: 200, body: { itemsJson: "[]", totalCount: 0, totalPages: 0, currentPage: 1, pageSize: 20 } }),
    ...overrides,
  };
}

function response(status: number, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers,
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
    if (path.endsWith("/tag-latest-sortable")) {
      const tag = String((body as { readonly tag?: string } | undefined)?.tag ?? "");
      const roomExists = committed && tag === "room:room-1";
      return response(200, { exists: roomExists, lastSortableUniqueId: roomExists ? "suid-room-1" : "" });
    }
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

    const firstTag = roomTag("head-a");
    const secondTag = roomTag("head-b");
    const twoTagEvent = event("G57TwoTag", z.object({ roomId: z.string(), value: z.string() }), {
      tags: (input) => [roomTag(input.roomId)],
    });
    const twoTagCommand = command({
      id: "g57-two-tag",
      input: z.object({ value: z.string() }),
      reads: () => readSet(read(roomProjector, firstTag), read(roomProjector, secondTag)),
      handle: async (input, context) => {
        await context.state(roomProjector, firstTag);
        await context.state(roomProjector, secondTag);
        context.append(twoTagEvent, twoTagEvent.make({ roomId: firstTag.value, value: input.value }));
        context.append(twoTagEvent, twoTagEvent.make({ roomId: secondTag.value, value: input.value }));
        return done({ value: input.value });
      },
    });
    const twoTagExecutor = createSekibanExecutor(fixtureTransport({
      readTagState: async ({ tagStateId }) => {
        const [group, value] = tagStateId.split(":");
        return emptyState(roomProjector, { group: group ?? "room", value: value ?? "unknown" });
      },
      commit: async () => ({
        status: 200,
        body: {
          head: "0002",
          heads: [
            { tag: firstTag.id, head: "0002" },
            { tag: secondTag.id, head: "0002" },
          ],
          writtenEvents: [
            { sortableUniqueIdValue: "0001" },
            { sortableUniqueIdValue: "0002" },
          ],
        },
      }),
    }));
    const twoTagResult = await twoTagExecutor.execute(twoTagCommand, { value: "per-tag" });
    expect(twoTagResult).toMatchObject({ kind: "committed" });
    expect((twoTagResult as Extract<typeof twoTagResult, { kind: "committed" }>).heads.map((entry) => [entry.tag.id, entry.head]))
      .toEqual([[firstTag.id, "0001"], [secondTag.id, "0002"]]);
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

    const readerCounts = { exists: 0, head: 0, transportExists: 0 };
    let readerCaptured: CommitEnvelope | undefined;
    const readerExecutor = createSekibanExecutor(fixtureTransport({
      readTagLatestSortable: async () => {
        readerCounts.transportExists += 1;
        throw new Error("snapshot-only existence bypassed supplied reader");
      },
      commit: async (envelope) => {
        readerCaptured = envelope;
        return { status: 200, body: { writtenEvents: [] } };
      },
    }));
    const suppliedReader: SnapshotReader = {
      read: async (projector, target) => snapshot(projector, target, typeof projector.initialState === "function" ? projector.initialState() : projector.initialState, null, false),
      exists: () => {
        readerCounts.exists += 1;
        return true;
      },
      head: () => {
        readerCounts.head += 1;
        return "suid-snapshot-reader";
      },
    };
    const suppliedReaderResult = await readerExecutor.execute(existsCommand, { value: "reader" }, {
      snapshots: suppliedReader,
      readMode: "snapshot-only",
    });
    expect(suppliedReaderResult).toMatchObject({ kind: "committed" });
    expect(readerCaptured?.consistency).toEqual([{ tag: "g57:empty", lastSortableUniqueId: "suid-snapshot-reader" }]);
    expect(readerCounts).toEqual({ exists: 2, head: 2, transportExists: 0 });
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

  it("AC2: preserves service-scope mismatch as a typed command result", async () => {
    const mismatch = createSekibanExecutor(fixtureTransport({ serviceId: "service-a" }), { serviceId: "service-b" });
    const result = await mismatch.execute(createRoomCommand, { roomId: "room-1", name: "Room" });
    expect(result).toMatchObject({ kind: "invalid", code: "scope.mismatch" });
    expect(new ClientError("scope.mismatch", "scope mismatch")).toBeInstanceOf(Error);
  });

  it("SDT-G88 AC4: refuses an invalid maxConflictRetries as invalid_execute_options without a commit", async () => {
    let commits = 0;
    const executor = createSekibanExecutor(fixtureTransport({
      commit: async () => {
        commits += 1;
        return { status: 409, body: { code: "consistency_conflict", conflicts: [] } };
      },
    }));
    for (const maxConflictRetries of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5]) {
      const result = await executor.execute(createRoomCommand, { roomId: "room-1", name: "Room" }, { maxConflictRetries });
      expect(result, String(maxConflictRetries)).toMatchObject({ kind: "invalid", attempts: 0, code: "invalid_execute_options" });
    }
    expect(commits).toBe(0);
  });

  it("SDT-G88 AC4: keeps an exhausted conflict typed for maxConflictRetries 1 and 2", async () => {
    for (const [maxConflictRetries, attempts] of [[1, 2], [2, 3]] as const) {
      let commits = 0;
      const executor = createSekibanExecutor(fixtureTransport({
        commit: async () => {
          commits += 1;
          return {
            status: 409,
            body: {
              code: "consistency_conflict",
              conflicts: [{ tag: "room:room-1", expectedHead: "", actualHead: `suid-existing-${commits}` }],
            },
          };
        },
      }));
      const result = await executor.execute(createRoomCommand, { roomId: "room-1", name: "Room" }, { maxConflictRetries });
      expect(result, String(maxConflictRetries)).toMatchObject({
        kind: "conflict",
        attempts,
        status: 409,
        code: "consistency_conflict",
        conflicts: [{ tag: { id: "room:room-1" }, expectedHead: "", actualHead: `suid-existing-${attempts}` }],
      });
      expect(commits).toBe(attempts);
    }
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

const emptyRoomSnapshot = (): PortableSnapshot =>
  snapshot(roomProjector, roomTag("room-1"), { status: "empty", version: 0, roomId: null, name: "" }, null, false);

describe("SDT-G86 executor facade budget, cancellation, scope and results", () => {
  it("AC4: refuses an invalid totalBudgetMs as invalid_execute_options before any adapter call", async () => {
    const counts = { reads: 0, commits: 0 };
    const executor = createSekibanExecutor(fixtureTransport({
      readTagLatestSortable: async () => {
        counts.reads += 1;
        return { exists: true, lastSortableUniqueId: "" };
      },
      readTagState: async () => {
        counts.reads += 1;
        return emptyState(roomProjector, roomTag("room-1"));
      },
      commit: async () => {
        counts.commits += 1;
        await delay(20);
        return { status: 200, body: { writtenEvents: [] } };
      },
    }));
    for (const readMode of ["snapshot-only", "read-through"] as const) {
      for (const totalBudgetMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 2 ** 31]) {
        const result = await executor.execute(createRoomCommand, { roomId: "room-1", name: "Room" }, {
          totalBudgetMs,
          readMode,
          ...(readMode === "snapshot-only" ? { snapshots: [emptyRoomSnapshot()] } : {}),
        });
        expect({ result, counts }, `${readMode} totalBudgetMs=${String(totalBudgetMs)}`).toMatchObject({
          result: { kind: "invalid", attempts: 0, code: "invalid_execute_options" },
          counts: { reads: 0, commits: 0 },
        });
      }
    }
    for (const totalBudgetMs of [1000, 2147483647]) {
      const result = await executor.execute(createRoomCommand, { roomId: "room-1", name: "Room" }, {
        totalBudgetMs,
        snapshots: [emptyRoomSnapshot()],
        readMode: "snapshot-only",
      });
      expect(result, `totalBudgetMs=${totalBudgetMs}`).toMatchObject({ kind: "committed" });
    }
    expect(counts).toEqual({ reads: 0, commits: 2 });
  });

  it("AC4: bounds the whole execute, supplied reader calls included, and never retries an expired commit", async () => {
    const zeroCounts = { reads: 0, commits: 0 };
    const zero = await createSekibanExecutor(fixtureTransport({
      readTagLatestSortable: async () => {
        zeroCounts.reads += 1;
        return { exists: true, lastSortableUniqueId: "" };
      },
      commit: async () => {
        zeroCounts.commits += 1;
        return { status: 200, body: {} };
      },
    })).execute(createRoomCommand, { roomId: "room-1", name: "Room" }, { totalBudgetMs: 0 });
    expect({ zero, zeroCounts }).toMatchObject({ zero: { kind: "timeout", code: "timeout" }, zeroCounts: { reads: 0, commits: 0 } });

    const readCounts = { authority: 0, state: 0, commits: 0 };
    const duringRead = await createSekibanExecutor(fixtureTransport({
      readTagLatestSortable: async () => {
        readCounts.authority += 1;
        await delay(80);
        return { exists: true, lastSortableUniqueId: "" };
      },
      readTagState: async () => {
        readCounts.state += 1;
        return emptyState(roomProjector, roomTag("room-1"));
      },
      commit: async () => {
        readCounts.commits += 1;
        return { status: 200, body: {} };
      },
    })).execute(createRoomCommand, { roomId: "room-1", name: "Room" }, { totalBudgetMs: 20 });
    await delay(70);
    expect({ duringRead, readCounts }).toMatchObject({
      duringRead: { kind: "timeout", code: "timeout" },
      readCounts: { authority: 1, state: 0, commits: 0 },
    });

    const readerCounts = { reads: 0, commits: 0 };
    const suppliedReader: SnapshotReader = {
      read: async () => {
        readerCounts.reads += 1;
        await delay(80);
        return emptyRoomSnapshot();
      },
    };
    const duringReader = await createSekibanExecutor(fixtureTransport({
      commit: async () => {
        readerCounts.commits += 1;
        return { status: 200, body: {} };
      },
    })).execute(createRoomCommand, { roomId: "room-1", name: "Room" }, {
      totalBudgetMs: 20,
      snapshots: suppliedReader,
      readMode: "snapshot-only",
    });
    await delay(70);
    expect({ duringReader, readerCounts }).toMatchObject({
      duringReader: { kind: "timeout", code: "timeout" },
      readerCounts: { reads: 1, commits: 0 },
    });

    let pendingCommits = 0;
    const duringCommit = await createSekibanExecutor(fixtureTransport({
      commit: async () => {
        pendingCommits += 1;
        await delay(80);
        return { status: 409, body: { code: "consistency_conflict", conflicts: [] } };
      },
    })).execute(createRoomCommand, { roomId: "room-1", name: "Room" }, {
      totalBudgetMs: 20,
      maxConflictRetries: 3,
      snapshots: [emptyRoomSnapshot()],
      readMode: "read-through",
    });
    await delay(70);
    expect({ duringCommit, pendingCommits }).toMatchObject({
      duringCommit: { kind: "timeout", code: "timeout" },
      pendingCommits: 1,
    });

    const unbounded = await createSekibanExecutor(fixtureTransport({
      commit: async () => {
        await delay(30);
        return { status: 200, body: { writtenEvents: [] } };
      },
    })).execute(createRoomCommand, { roomId: "room-1", name: "Room" });
    expect(unbounded).toMatchObject({ kind: "committed" });
  });

  it("AC5: forwards the caller signal to every adapter call and checks it before each call", async () => {
    const beforeCounts = { reads: 0, commits: 0 };
    const before = new AbortController();
    before.abort();
    const abortedBefore = await createSekibanExecutor(fixtureTransport({
      readTagLatestSortable: async () => {
        beforeCounts.reads += 1;
        return { exists: true, lastSortableUniqueId: "" };
      },
      commit: async () => {
        beforeCounts.commits += 1;
        return { status: 200, body: {} };
      },
    })).execute(createRoomCommand, { roomId: "room-1", name: "Room" }, { signal: before.signal });
    expect({ abortedBefore, beforeCounts }).toMatchObject({
      abortedBefore: { kind: "timeout", code: "aborted" },
      beforeCounts: { reads: 0, commits: 0 },
    });

    for (const pendingRead of ["authority", "tag-state"] as const) {
      const controller = new AbortController();
      const started = deferred();
      const received: { authority?: AbortSignal; state?: AbortSignal } = {};
      const counts = { authority: 0, state: 0, commits: 0 };
      const pending = createSekibanExecutor(fixtureTransport({
        readTagLatestSortable: async (_request, signal) => {
          counts.authority += 1;
          received.authority = signal;
          if (pendingRead === "authority") {
            started.resolve();
            await delay(50);
          }
          return { exists: true, lastSortableUniqueId: "" };
        },
        readTagState: async (_request, signal) => {
          counts.state += 1;
          received.state = signal;
          if (pendingRead === "tag-state") {
            started.resolve();
            await delay(50);
          }
          return emptyState(roomProjector, roomTag("room-1"));
        },
        commit: async () => {
          counts.commits += 1;
          return { status: 200, body: {} };
        },
      })).execute(createRoomCommand, { roomId: "room-1", name: "Room" }, { signal: controller.signal });
      await started.promise;
      controller.abort();
      const result = await pending;
      await delay(60);
      expect(result, pendingRead).toMatchObject({ kind: "timeout", code: "aborted" });
      expect(received.authority, `${pendingRead} authority signal`).toBe(controller.signal);
      if (pendingRead === "tag-state") expect(received.state, "tag-state signal").toBe(controller.signal);
      expect(counts, pendingRead).toEqual(pendingRead === "authority"
        ? { authority: 1, state: 0, commits: 0 }
        : { authority: 1, state: 1, commits: 0 });
    }

    const commitController = new AbortController();
    const commitStarted = deferred();
    let commitSignal: AbortSignal | undefined;
    let commits = 0;
    const pendingCommit = createSekibanExecutor(fixtureTransport({
      commit: async (_envelope, signal) => {
        commits += 1;
        commitSignal = signal;
        commitStarted.resolve();
        await delay(50);
        return { status: 409, body: { code: "consistency_conflict", conflicts: [] } };
      },
    })).execute(createRoomCommand, { roomId: "room-1", name: "Room" }, {
      signal: commitController.signal,
      maxConflictRetries: 3,
    });
    await commitStarted.promise;
    commitController.abort();
    const abortedCommit = await pendingCommit;
    await delay(60);
    expect({ abortedCommit, commits }).toMatchObject({ abortedCommit: { kind: "timeout", code: "aborted" }, commits: 1 });
    expect(commitSignal).toBe(commitController.signal);
  });

  it("AC6: refuses a service-scope mismatch on every read method before calling the adapter", async () => {
    const calls: string[] = [];
    const recording = (serviceId: string | undefined): SerializedDcbTransport => fixtureTransport({
      serviceId,
      readTagLatestSortable: async () => {
        calls.push("authority");
        return { exists: true, lastSortableUniqueId: "" };
      },
      readTagState: async () => {
        calls.push("tag-state");
        return emptyState(roomProjector, roomTag("room-1"));
      },
      query: async () => {
        calls.push("query");
        return { status: 200, body: { resultJson: "{}" } };
      },
      listQuery: async () => {
        calls.push("list-query");
        return { status: 200, body: { itemsJson: "[]", totalCount: 0, totalPages: 0, currentPage: 1, pageSize: 20 } };
      },
    });
    const listRequest = { queryType: "G86List", queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 20 }) };
    const queryRequest = { queryType: "G86Query", queryParamsJson: "{}" };
    const mismatch = createSekibanExecutor(recording("service-a"), { serviceId: "service-b" });
    const refusals = [
      await mismatch.readState(roomProjector, roomTag("room-1")).catch((error: unknown) => error),
      await mismatch.exists(roomTag("room-1")).catch((error: unknown) => error),
      await mismatch.query(queryRequest).catch((error: unknown) => error),
      await mismatch.listQuery(listRequest, { consistency: "safe" }).catch((error: unknown) => error),
    ];
    for (const refusal of refusals) {
      expect(refusal).toBeInstanceOf(ClientError);
      expect(refusal).toMatchObject({ code: "scope.mismatch" });
    }
    await expect(mismatch.execute(createRoomCommand, { roomId: "room-1", name: "Room" })).resolves.toMatchObject({ kind: "invalid", code: "scope.mismatch" });
    expect(calls).toEqual([]);

    for (const [executorServiceId, transportServiceId] of [["service-a", "service-a"], [undefined, "service-a"], ["service-a", undefined], [undefined, undefined]] as const) {
      calls.length = 0;
      const executor = createSekibanExecutor(recording(transportServiceId), executorServiceId === undefined ? {} : { serviceId: executorServiceId });
      const label = `${executorServiceId ?? "none"}/${transportServiceId ?? "none"}`;
      await expect(executor.readState(roomProjector, roomTag("room-1")), label).resolves.toMatchObject({ exists: true });
      await expect(executor.exists(roomTag("room-1")), label).resolves.toMatchObject({ exists: true });
      await expect(executor.query(queryRequest), label).resolves.toEqual({ resultJson: "{}" });
      await expect(executor.listQuery(listRequest), label).resolves.toMatchObject({ itemsJson: "[]" });
      expect(calls, label).toEqual(["authority", "tag-state", "authority", "query", "list-query"]);
    }
  });

  it("AC7: keeps the done value, rejectKind and details a handler returns without changing the code rule", async () => {
    const family = tagFamily("g86");
    const resultTag = family.of("result");
    const recorded = event("G86Recorded", z.object({ value: z.string() }), { tags: () => [resultTag] });
    const valued = command({
      id: "g86-valued",
      input: z.object({ value: z.string() }),
      reads: () => readSet(),
      handle: (input, context) => {
        context.append(recorded, recorded.make({ value: input.value }));
        return done({ echoed: input.value, count: 2 });
      },
    });
    const valueless = command({
      id: "g86-valueless",
      input: z.object({ value: z.string() }),
      reads: () => readSet(),
      handle: (input, context) => {
        context.append(recorded, recorded.make({ value: input.value }));
        return done();
      },
    });
    const executor = createSekibanExecutor(fixtureTransport());
    await expect(executor.execute(valued, { value: "kept" })).resolves.toMatchObject({ kind: "committed", value: { echoed: "kept", count: 2 } });
    const withoutValue = await executor.execute(valueless, { value: "none" });
    expect(withoutValue.kind).toBe("committed");
    expect(withoutValue).not.toHaveProperty("value");

    const rejecting = (decision: ReturnType<typeof reject>) => command({
      id: "g86-rejecting",
      input: z.object({}),
      reads: () => readSet(),
      handle: () => decision,
    });
    await expect(executor.execute(rejecting(reject("conflict", "already there")), {})).resolves.toEqual({
      kind: "rejected",
      attempts: 1,
      error: "already there",
      code: "consistency_conflict",
      rejectKind: "conflict",
    });
    await expect(executor.execute(rejecting(reject("conflict", "reservation already exists", "reservation_exists")), {})).resolves.toEqual({
      kind: "rejected",
      attempts: 1,
      error: "reservation already exists",
      code: "reservation_exists",
      rejectKind: "conflict",
      details: "reservation_exists",
    });
    const details = { field: "value", hints: ["g86"] };
    await expect(executor.execute(rejecting(reject("validation", "value is invalid", details)), {})).resolves.toEqual({
      kind: "rejected",
      attempts: 1,
      error: "value is invalid",
      code: "validation_error",
      rejectKind: "validation",
      details,
    });

    const commitRejected = await createSekibanExecutor(fixtureTransport({
      commit: async () => ({ status: 400, body: { code: "command_rejected", error: "refused" } }),
    })).execute(valued, { value: "refused" });
    expect(commitRejected).toMatchObject({ kind: "rejected", code: "command_rejected", status: 400 });
    expect(commitRejected).not.toHaveProperty("rejectKind");
    expect(commitRejected).not.toHaveProperty("details");
  });

  it("AC9: validates maxConflictRetries in every read mode and treats an unrecognised commit reply as unknown", async () => {
    const counts = { reads: 0, commits: 0 };
    const executor = createSekibanExecutor(fixtureTransport({
      readTagLatestSortable: async () => {
        counts.reads += 1;
        return { exists: true, lastSortableUniqueId: "" };
      },
      commit: async () => {
        counts.commits += 1;
        return { status: 200, body: {} };
      },
    }));
    for (const readMode of ["snapshot-only", "read-through"] as const) {
      for (const maxConflictRetries of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5]) {
        const result = await executor.execute(createRoomCommand, { roomId: "room-1", name: "Room" }, {
          maxConflictRetries,
          readMode,
          ...(readMode === "snapshot-only" ? { snapshots: [emptyRoomSnapshot()] } : {}),
        });
        expect({ result, counts }, `${readMode} maxConflictRetries=${String(maxConflictRetries)}`).toMatchObject({
          result: { kind: "invalid", attempts: 0, code: "invalid_execute_options" },
          counts: { reads: 0, commits: 0 },
        });
      }
    }

    for (const reply of [undefined, null, "committed", { writtenEvents: [] }, { ok: true }]) {
      let commits = 0;
      const result = await createSekibanExecutor(fixtureTransport({
        commit: async () => {
          commits += 1;
          return reply;
        },
      })).execute(createRoomCommand, { roomId: "room-1", name: "Room" }, { snapshots: [emptyRoomSnapshot()], readMode: "snapshot-only" });
      expect({ result, commits }, JSON.stringify(reply) ?? "undefined").toMatchObject({
        result: { kind: "timeout", code: "unknown_outcome" },
        commits: 1,
      });
    }
  });

  it("AC9: validates supplied snapshot state and decoded tag-state against the projector state schema", async () => {
    let commits = 0;
    const invalidState = { status: "created", version: -1, roomId: 7, name: "Room" };
    const validState = { status: "created", version: 1, roomId: "room-1", name: "Room" };
    const executor = createSekibanExecutor(fixtureTransport({
      commit: async () => {
        commits += 1;
        return { status: 200, body: {} };
      },
    }));
    const fromArray = await executor.execute(releaseRoomCommand, { roomId: "room-1" }, {
      snapshots: [snapshot(roomProjector, roomTag("room-1"), invalidState, "suid-g86", true)],
      readMode: "snapshot-only",
    });
    expect(fromArray).toMatchObject({ kind: "invalid", code: "domain_authoring_error", error: "SNAPSHOT_STATE_INVALID" });
    const invalidReader: SnapshotReader = { read: (projector, tag) => snapshot(projector, tag, invalidState, "suid-g86", true) };
    for (const readMode of ["snapshot-only", "read-through"] as const) {
      const fromReader = await executor.execute(releaseRoomCommand, { roomId: "room-1" }, { snapshots: invalidReader, readMode });
      expect(fromReader, readMode).toMatchObject({ kind: "invalid", code: "domain_authoring_error", error: "SNAPSHOT_STATE_INVALID" });
    }
    expect(commits).toBe(0);
    const validArray = await executor.execute(releaseRoomCommand, { roomId: "room-1" }, {
      snapshots: [snapshot(roomProjector, roomTag("room-1"), validState, "suid-g86", true)],
      readMode: "snapshot-only",
    });
    expect(validArray).toMatchObject({ kind: "committed" });
    expect(commits).toBe(1);

    const payloadExecutor = (state: unknown) => createSekibanExecutor(fixtureTransport({
      readTagLatestSortable: async () => ({ exists: true, lastSortableUniqueId: "suid-g86" }),
      readTagState: async () => ({ ...emptyState(roomProjector, roomTag("room-1")), payload: encoded(state), version: 1, lastSortedUniqueId: "suid-g86" }),
      commit: async () => {
        commits += 1;
        return { status: 200, body: {} };
      },
    }));
    const invalidPayload = payloadExecutor(invalidState);
    const readError = await invalidPayload.readState(roomProjector, roomTag("room-1")).catch((error: unknown) => error);
    expect(readError).toBeInstanceOf(ClientError);
    expect(readError).toMatchObject({ code: "invalid_read_snapshot" });
    await expect(invalidPayload.execute(releaseRoomCommand, { roomId: "room-1" })).resolves.toMatchObject({ kind: "transport", code: "invalid_read_snapshot" });
    expect(commits).toBe(1);
    await expect(payloadExecutor(validState).readState(roomProjector, roomTag("room-1"))).resolves.toMatchObject({ exists: true, head: "suid-g86", state: validState });
  });
});
