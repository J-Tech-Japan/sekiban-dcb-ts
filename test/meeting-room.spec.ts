import { describe, expect, it } from "vitest";
import { createSekibanExecutor } from "@sekiban/dcb-client";
import { createRuntimeWorker } from "@sekiban/dcb-runtime";
import { createMeetingRoomWorker, type MeetingRoomEnv } from "../samples/meeting-room/src/worker";
import { createV1Transport } from "../samples/meeting-room/src/transport";
import { bookRoomWorkflow } from "../samples/meeting-room/src/workflow";
import {
  countActiveReservationsByRoomQuery,
  listActiveReservationsByRoomQuery,
  meetingRoomAuthoringDomain,
  meetingRoomDomain,
  meetingRoomRuntimeConfig,
} from "../samples/meeting-room/src/domain";

describe("SDT-G14 meeting-room consumer", () => {
  it("defines the authored domain surface and exercises the bridged command verbs", async () => {
    expect(meetingRoomDomain.events.map((event) => event.name)).toEqual([
      "RoomCreated",
      "RoomReserved",
      "ReservationCancelled",
      "RoomReleased",
    ]);
    expect(meetingRoomAuthoringDomain.commands).toHaveLength(4);
    expect(meetingRoomDomain.projectors).toHaveLength(2);
    expect(meetingRoomRuntimeConfig.queries.map((query) => query.queryType)).toEqual([
      "ListActiveReservationsByRoomQuery",
      "CountActiveReservationsByRoomQuery",
      "GetReservationListQuery",
    ]);
    expect(meetingRoomRuntimeConfig.queries.filter((query) => "execution" in query).map((query) => query.queryType)).toEqual([
      "ListActiveReservationsByRoomQuery",
      "CountActiveReservationsByRoomQuery",
    ]);
    expect(meetingRoomRuntimeConfig.queries.filter((query) => !("execution" in query)).map((query) => query.queryType)).toEqual([
      "GetReservationListQuery",
    ]);

    const command = (id: string) => {
      const selected = meetingRoomDomain.commands.find((candidate) => candidate.id === id);
      if (selected === undefined) throw new Error(`missing command ${id}`);
      return selected;
    };
    const created = await command("create-room").execute({ roomId: "r-1", name: "Boardroom" });
    expect(created.kind).toBe("committed");
    expect(created.events).toHaveLength(1);
    expect(created.events[0]?.eventName).toBe("RoomCreated");
    expect((await command("reserve-room").execute({ roomId: "missing", reservationId: "res-1" })).kind).toBe("rejected");
    expect((await command("cancel-reservation").execute({ reservationId: "missing" })).kind).toBe("rejected");
    expect((await command("release-room").execute({ roomId: "missing" })).kind).toBe("rejected");
    expect((await command("release-room").execute(
      { roomId: "r-1" },
      { state: { "room:r-1": { status: "released", version: 1, roomId: "r-1", name: "Boardroom" } }, now: 1 },
    )).kind).toBe("noop");
  });

  it("composes the public runtime registration API without exposing private registries", async () => {
    const runtime = createRuntimeWorker({ domain: meetingRoomDomain, config: meetingRoomRuntimeConfig });
    const handler = runtime.fetch as unknown as (request: Request, env: unknown, ctx: unknown) => Promise<Response>;
    const response = await handler(new Request("https://sample.test/api/sekiban/serialized/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queryType: "unknown", queryParamsJson: "{}" }),
    }), { SDT_SERVICE_ID: "g24-runtime-fixture" }, {});
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "validation_error" });
  });

  it("keeps the two workflow commits non-atomic when the second step conflicts", async () => {
    const calls: string[] = [];
    const result = await bookRoomWorkflow(async (commandId) => {
      calls.push(commandId);
      return calls.length === 1
        ? { kind: "committed", attempts: 1, response: { roomId: "r-1" } }
        : { kind: "conflict", attempts: 1, status: 409, code: "consistency_conflict" };
    }, { roomId: "r-1", reservationId: "res-1" });
    expect(calls).toEqual(["create-room", "reserve-room"]);
    expect(result.create.kind).toBe("committed");
    expect(result.reserve?.kind).toBe("conflict");
  });

  it("maps the internal claim envelope to the real V1 commit spelling", async () => {
    let captured: Request | undefined;
    const transport = createV1Transport({
      fetch: async (input, init) => {
        captured = new Request(input, init);
        return new Response(JSON.stringify({ writtenEvents: [], tagWriteResults: [] }), {
          status: 200,
          headers: { "content-type": "application/json", "x-sdt-global-admission": "admitted" },
        });
      },
    }, "g11-meeting-room-test-12345678");
    const result = await transport.commit({
      candidates: [{ eventId: "event-1", eventPayloadName: "RoomCreated", payload: { eventType: "RoomCreated" }, tags: ["room:r-1"] }],
      consistency: [{ tag: "room:r-1", lastSortableUniqueId: "suid-1" }],
    });
    expect(result).toMatchObject({
      status: 200,
      headers: { "x-sdt-global-admission": "admitted" },
      body: { writtenEvents: [], tagWriteResults: [] },
    });
    const body = await captured!.json<Record<string, unknown>>();
    expect(body).toMatchObject({ version: 1 });
    expect(body.consistencyTags).toEqual([{ tag: "room:r-1", lastSortableUniqueId: "suid-1" }]);
    expect(body.eventCandidates).toEqual([
      expect.objectContaining({ eventPayloadName: "RoomCreated", tags: ["room:r-1"], payload: expect.any(String) }),
    ]);
  });

  it("forwards each admission outcome as a header without adding a V1 body member", async () => {
    for (const status of ["admitted", "not-admitted", "unknown"] as const) {
      const transport = createV1Transport({
        fetch: async () => new Response(JSON.stringify({ writtenEvents: [], tagWriteResults: [] }), {
          status: 200,
          headers: { "content-type": "application/json", "x-sdt-global-admission": status },
        }),
      });
      const result = await transport.commit({
        candidates: [{ eventId: `event-${status}`, eventPayloadName: "RoomCreated", payload: { eventType: "RoomCreated" }, tags: ["room:r-1"] }],
        consistency: [],
      });
      expect(result).toMatchObject({
        headers: { "x-sdt-global-admission": status },
        body: { writtenEvents: [], tagWriteResults: [] },
      });
      expect(result).not.toHaveProperty("globalAdmission");
    }
  });

  it("does not forward a client g11 namespace from the unauthenticated command API", async () => {
    const calls: Request[] = [];
    const runtimeFetcher = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = input instanceof Request ? input : new Request(input, init);
        calls.push(request);
        if (new URL(request.url).pathname.endsWith("/tag-latest-sortable")) {
          return new Response(JSON.stringify({ exists: false, lastSortableUniqueId: "" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (new URL(request.url).pathname.endsWith("/tag-state")) {
          return new Response(JSON.stringify({
            payload: { status: "empty" },
            version: 0,
            lastSortedUniqueId: "",
            tagGroup: "room",
            tagContent: "r-unauthenticated",
            tagProjector: "RoomProjector",
            tagPayloadName: "RoomState",
            projectorVersion: "1",
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ writtenEvents: [], tagWriteResults: [] }), {
          status: 200,
          headers: { "content-type": "application/json", "x-sdt-global-admission": "admitted" },
        });
      },
    };
    const worker = createMeetingRoomWorker();
    const fetch = worker.fetch as unknown as (request: Request, env: MeetingRoomEnv, ctx: ExecutionContext) => Promise<Response>;
    const response = await fetch(new Request("https://sample.test/api/commands/create-room", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sdt-g11-service-id": "g11-attacker-namespace",
      },
      body: JSON.stringify({ roomId: "r-unauthenticated", name: "Room" }),
    }), { RUNTIME: runtimeFetcher } as unknown as MeetingRoomEnv, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-sdt-global-admission")).toBe("admitted");
    expect(await response.clone().json()).not.toHaveProperty("globalAdmission");
    expect(calls.length).toBe(2);
    expect(calls.every((request) => !request.headers.has("x-sdt-g11-service-id"))).toBe(true);
  });

  it("keeps an application rejection distinct from a committed command", async () => {
    const payload = { version: 1, status: "created", roomId: "r-existing", name: "Existing" };
    const runtimeFetcher = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (new URL(request.url).pathname.endsWith("/tag-latest-sortable")) {
          return new Response(JSON.stringify({ exists: true, lastSortableUniqueId: "suid-1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (new URL(request.url).pathname.endsWith("/tag-state")) {
          return new Response(JSON.stringify({
            payload,
            version: 1,
            lastSortedUniqueId: "suid-1",
            tagGroup: "room",
            tagContent: "r-existing",
            tagProjector: "RoomProjector",
            tagPayloadName: "RoomState",
            projectorVersion: "1",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error("commit should not be called for an existing room");
      },
    };
    const worker = createMeetingRoomWorker();
    const fetch = worker.fetch as unknown as (request: Request, env: MeetingRoomEnv, ctx: ExecutionContext) => Promise<Response>;
    const response = await fetch(new Request("https://sample.test/api/commands/create-room", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "r-existing", name: "Duplicate" }),
    }), { RUNTIME: runtimeFetcher } as unknown as MeetingRoomEnv, {} as ExecutionContext);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ kind: "rejected", code: "room_exists" });
  });

  it("preserves the public invalid-command response for malformed executor input", async () => {
    const worker = createMeetingRoomWorker();
    const fetch = worker.fetch as unknown as (request: Request, env: MeetingRoomEnv, ctx: ExecutionContext) => Promise<Response>;
    const response = await fetch(new Request("https://sample.test/api/commands/create-room", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "invalid" }),
    }), { RUNTIME: { fetch: async () => { throw new Error("runtime must not be called"); } } } as unknown as MeetingRoomEnv, {} as ExecutionContext);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ kind: "invalid", code: "invalid_command_input" });
  });

  it("fails closed on the conformance gate before runtime or body parsing", async () => {
    const rows = [
      { label: "absent", token: undefined, header: "Bearer conformance-secret", status: 404, code: "not_found", calls: 0 },
      { label: "empty", token: "", header: "Bearer ", status: 404, code: "not_found", calls: 0 },
      { label: "whitespace", token: " \n\t ", header: "Bearer  \n\t ", status: 404, code: "not_found", calls: 0 },
      { label: "missing header", token: "conformance-secret", header: undefined, status: 403, code: "unauthorized", calls: 0 },
      { label: "wrong credential", token: "conformance-secret", header: "Bearer wrong", status: 403, code: "unauthorized", calls: 0 },
      { label: "exact whitespace rejected", token: "  conformance-secret  ", header: "Bearer conformance-secret", status: 403, code: "unauthorized", calls: 0 },
      { label: "correct credential", token: "conformance-secret", header: "Bearer conformance-secret", status: 200, code: undefined, calls: 1 },
    ] as const;
    for (const row of rows) {
      let runtimeCalls = 0;
      let jsonReads = 0;
      const worker = createMeetingRoomWorker({
        runtime: { fetch: async () => { runtimeCalls += 1; return new Response("ok", { status: 200 }); } },
      });
      const fetch = worker.fetch as (request: Request, env: MeetingRoomEnv, ctx: ExecutionContext) => Promise<Response>;
      const request = new Request("https://sample.test/conformance/v1/api/sekiban/serialized/query", {
        method: "POST",
        headers: row.header === undefined ? undefined : { authorization: row.header },
        body: "{",
      });
      const watched = new Proxy(request, {
        get(target, property) {
          if (property === "json") {
            return async () => {
              jsonReads += 1;
              return target.json();
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const response = await fetch(watched, { CONFORMANCE_TOKEN: row.token } as unknown as MeetingRoomEnv, {} as ExecutionContext);
      expect(response.status, row.label).toBe(row.status);
      if (row.code !== undefined) {
        const text = await response.text();
        expect(JSON.parse(text), row.label).toMatchObject({ code: row.code });
        expect(text, row.label).not.toContain("conformance-secret");
      }
      expect(runtimeCalls, row.label).toBe(row.calls);
      expect(jsonReads, row.label).toBe(0);
    }
  });
});

describe("meeting-room typed queries", () => {
  it("decodes checkpoint rows, including an omitted roomId, through the serialized worker", async () => {
    const wait = "063923995692002000000693137505";
    const rows = [
      ["res-b", "063923995692002000000693137502", { reservationId: "res-b", roomId: "room-1", status: "reserved", version: 1 }],
      ["res-a", "063923995692002000000693137501", { reservationId: "res-a", roomId: "room-1", status: "reserved", version: 1 }],
      ["res-c", "063923995692002000000693137503", { reservationId: "res-c", roomId: "room-2", status: "reserved", version: 1 }],
      ["res-d", "063923995692002000000693137504", { reservationId: "res-d", status: "reserved", version: 1 }],
      ["res-e", wait, { reservationId: "res-e", roomId: "room-1", status: "cancelled", version: 2 }],
    ].map(([key, lastSuid, value]) => ({
      projectionId: `tag-state:reservation:${key}:ReservationProjector`,
      lastSuid: String(lastSuid),
      stateJson: JSON.stringify(value),
    }));
    const store = {
      async initialize() {},
      async currentLagBound() { return 0; },
      async readAllEvents() {
        return [{ suid: wait, eventTags: ["reservation:res-e"] }];
      },
      async listProjectionTags() {
        return rows.map((row) => `reservation:${row.projectionId.split(":")[2]}`);
      },
      async readProjectionCheckpoint(_serviceId: string, projectionId: string) {
        const found = rows.find((row) => row.projectionId === projectionId);
        return found === undefined ? undefined : { serviceId: _serviceId, ...found, version: 1, updatedAt: 1 };
      },
      async scanProjectionCheckpointCandidates(input: { projectionIdPrefix: string; projectionIdSuffix: string; limit: number }) {
        return rows
          .filter((row) => row.projectionId.startsWith(input.projectionIdPrefix) && row.projectionId.endsWith(input.projectionIdSuffix))
          .slice(0, input.limit);
      },
    };
    const runtime = createRuntimeWorker({
      domain: meetingRoomDomain,
      config: meetingRoomRuntimeConfig,
      storeProvider: { name: "memory", create: () => store as never },
      queryBacking: "memory",
    });
    const captured: Array<{ readonly body: Record<string, unknown>; readonly signal: AbortSignal | undefined }> = [];
    const signal = new AbortController().signal;
    const transport = createV1Transport({
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        captured.push({ body: await request.clone().json() as Record<string, unknown>, signal: init?.signal ?? undefined });
        const fetchWorker = runtime.fetch as (input: Request, workerEnv: unknown, ctx: ExecutionContext) => Promise<Response>;
        return fetchWorker(request, { SDT_SERVICE_ID: "meeting-room-typed-query" }, { waitUntil() {} } as unknown as ExecutionContext);
      },
    }, "meeting-room-typed-query");
    const executor = createSekibanExecutor(transport, { serviceId: "meeting-room-typed-query" });
    const page = await executor.listQuery(
      listActiveReservationsByRoomQuery.contract,
      {},
      { pageNumber: 1, pageSize: 10, descending: false, consistency: "unsafe", waitForSortableUniqueId: wait, signal },
    );
    expect(page.items.map((item) => item.reservationId)).toEqual(["res-a", "res-b", "res-c", "res-d"]);
    expect(page.items[3]).toEqual({ reservationId: "res-d", status: "reserved", version: 1 });
    expect(page.items[3]).not.toHaveProperty("roomId");
    expect(page).toMatchObject({ totalCount: 4, currentPage: 1, pageSize: 10, readHead: wait });
    const descending = await executor.listQuery(
      listActiveReservationsByRoomQuery.contract,
      { roomId: "room-1" },
      { pageNumber: 1, pageSize: 1, descending: true, consistency: "unsafe" },
    );
    expect(descending.items).toEqual([{ reservationId: "res-b", roomId: "room-1", status: "reserved", version: 1 }]);
    expect(descending.totalCount).toBe(2);
    const count = await executor.query(countActiveReservationsByRoomQuery.contract, { roomId: "room-1" });
    expect(count).toEqual({ count: 2 });
    const listCall = captured[0]!;
    expect(listCall.signal).toBe(signal);
    expect(listCall.body.waitForSortableUniqueId).toBe(wait);
    expect(listCall.body).not.toHaveProperty("signal");
    expect(listCall.body).not.toHaveProperty("version");
    expect(JSON.parse(String(listCall.body.queryParamsJson))).toEqual({
      PageNumber: 1,
      PageSize: 10,
      NewestFirst: false,
      consistency: "unsafe",
    });
    expect(JSON.stringify(listCall.body)).not.toContain("handleFilter");
    expect(JSON.stringify(captured.at(-1))).not.toContain("handleQuery");
    const legacy = await executor.listQuery({
      queryType: "GetReservationListQuery",
      queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 20 }),
    });
    expect(typeof legacy.itemsJson).toBe("string");
    await expect(executor.listQuery({
      queryType: "GetReservationListQuery",
      queryParamsJson: JSON.stringify({ roomId: "room-1", PageNumber: 1, PageSize: 20 }),
    })).rejects.toMatchObject({
      code: "query_params_unsupported",
      message: "The selected query does not support these parameters.",
    });
  });
});
