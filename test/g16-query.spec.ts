import { describe, expect, it } from "vitest";
import { createMeetingRoomWorker, type MeetingRoomEnv } from "../samples/meeting-room/src/worker";
import cloudflareWorker from "../samples/meeting-room/src/worker.cloudflare-only";
import type { MeetingRoomCloudflareEnv } from "../samples/meeting-room/src/worker.cloudflare-env";

interface CapturedCall {
  readonly request: Request;
  readonly body: Record<string, unknown>;
}

function runtimeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function workerFetch() {
  const worker = createMeetingRoomWorker();
  return worker.fetch as unknown as (request: Request, env: MeetingRoomEnv, ctx: ExecutionContext) => Promise<Response>;
}

const ROOM_STATE = { status: "created", version: 1, roomId: "room-1", name: "Boardroom" };
const ROOM_VERSION = 4;
const ROOM_HEAD = "063923995692002000000693137501";

function tagStateRuntime() {
  const calls: CapturedCall[] = [];
  const runtime = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = await request.clone().json<Record<string, unknown>>();
      calls.push({ request, body });
      return runtimeResponse({
        payload: ROOM_STATE,
        version: ROOM_VERSION,
        lastSortedUniqueId: ROOM_HEAD,
        lastSortableUniqueId: "wrong-head",
      });
    },
  };
  return { calls, runtime };
}

describe("SDT-G16 application query views", () => {
  it("maps reservations through list-query without forwarding client headers", async () => {
    const calls: CapturedCall[] = [];
    const runtime = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = input instanceof Request ? input : new Request(input, init);
        const body = await request.clone().json<Record<string, unknown>>();
        calls.push({ request, body });
        if (new URL(request.url).pathname.endsWith("/list-query")) {
          return runtimeResponse({
            itemsJson: JSON.stringify([{ reservationId: "reservation-1", roomId: "room-1", status: "reserved", version: 2 }]),
            totalCount: 1,
            totalPages: 1,
            currentPage: 1,
            pageSize: 20,
            continuation: "opaque-next-page-token",
          });
        }
        return runtimeResponse({ resultJson: JSON.stringify({ count: 1 }) });
      },
    };
    const fetch = workerFetch();
    const hostileHeaders = {
      "x-sdt-g11-service-id": "g11-attacker-supplied-value",
      "x-sdt-g9-test-service-id": "g9-attacker-supplied-value",
      authorization: "Bearer attacker-supplied-value",
    };

    const reservations = await fetch(new Request("https://sample.test/api/read/reservations?pageNumber=1&pageSize=20", {
      headers: hostileHeaders,
    }), { RUNTIME: runtime } as unknown as MeetingRoomEnv, {} as ExecutionContext);
    expect(reservations.status).toBe(200);
    expect(reservations.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await reservations.json()).toMatchObject({ totalCount: 1, pageSize: 20, continuation: "opaque-next-page-token" });

    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.request.url).pathname).toBe("/api/sekiban/serialized/list-query");
    expect(calls[0]!.body).toEqual({
      queryType: "GetReservationListQuery",
      queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 20, consistency: "unsafe" }),
    });
    for (const call of calls) {
      expect(call.request.headers.get("content-type")).toBe("application/json");
      expect(call.request.headers.get("accept")).toBe("application/json");
      expect(call.request.headers.has("x-sdt-g11-service-id")).toBe(false);
      expect(call.request.headers.has("x-sdt-g9-test-service-id")).toBe(false);
      expect(call.request.headers.has("authorization")).toBe(false);
    }
  });

  it("reads one room through the keyed tag-state route on the application worker", async () => {
    const { calls, runtime } = tagStateRuntime();
    const fetch = workerFetch();
    const room = await fetch(new Request("https://sample.test/api/read/room?roomId=room-1"), {
      RUNTIME: runtime,
    } as unknown as MeetingRoomEnv, {} as ExecutionContext);
    expect(room.status).toBe(200);
    expect(await room.json()).toEqual({
      projection: "room",
      roomId: "room-1",
      tagStateId: "room:room-1:RoomProjector",
      state: ROOM_STATE,
      version: ROOM_VERSION,
      lastSortedUniqueId: ROOM_HEAD,
    });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.request.url).pathname).toBe("/api/sekiban/serialized/tag-state");
    expect(calls[0]!.body).toEqual({ tagStateId: "room:room-1:RoomProjector" });

    const removed = await fetch(new Request("https://sample.test/api/read/room-query?roomId=room-1"), {
      RUNTIME: runtime,
    } as unknown as MeetingRoomEnv, {} as ExecutionContext);
    expect(removed.status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it("reads one room through the keyed tag-state route on the cloudflare worker", async () => {
    const { calls, runtime } = tagStateRuntime();
    const fetch = cloudflareWorker.fetch as unknown as (
      request: Request,
      env: MeetingRoomCloudflareEnv,
      ctx: ExecutionContext,
    ) => Promise<Response>;
    const env = {
      __G16_RUNTIME_FETCH__: (request: Request) => runtime.fetch(request),
    } as unknown as MeetingRoomCloudflareEnv;
    const room = await fetch(new Request("https://sample.test/api/read/room?roomId=room-1"), env, {} as ExecutionContext);
    expect(room.status).toBe(200);
    expect(await room.json()).toEqual({
      projection: "room",
      roomId: "room-1",
      tagStateId: "room:room-1:RoomProjector",
      state: ROOM_STATE,
      version: ROOM_VERSION,
      lastSortedUniqueId: ROOM_HEAD,
    });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.request.url).pathname).toBe("/api/sekiban/serialized/tag-state");
    expect(calls[0]!.body).toEqual({ tagStateId: "room:room-1:RoomProjector" });

    const removed = await fetch(
      new Request("https://sample.test/api/read/room-query?roomId=room-1"),
      env,
      {} as ExecutionContext,
    );
    expect(removed.status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it("distinguishes runtime projection errors and keeps raw V1 unavailable", async () => {
    const runtime = {
      fetch: async (): Promise<Response> => runtimeResponse({
        error: "The mapped query projection is unavailable",
        code: "projection_unavailable",
      }, 503),
    };
    const fetch = workerFetch();
    const response = await fetch(new Request("https://sample.test/api/read/reservations"), {
      RUNTIME: runtime,
    } as unknown as MeetingRoomEnv, {} as ExecutionContext);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "The mapped query projection is unavailable",
      code: "projection_unavailable",
    });

    const raw = await fetch(new Request("https://sample.test/api/sekiban/serialized/list-query", { method: "POST" }), {
      RUNTIME: runtime,
    } as unknown as MeetingRoomEnv, {} as ExecutionContext);
    expect(raw.status).toBe(404);
    expect(await raw.json()).toMatchObject({ code: "not_found" });
  });

  it("rejects malformed paging without invoking the runtime", async () => {
    let invoked = false;
    const runtime = { fetch: async (): Promise<Response> => {
      invoked = true;
      return runtimeResponse({});
    } };
    const fetch = workerFetch();
    const response = await fetch(new Request("https://sample.test/api/read/reservations?pageSize=0"), {
      RUNTIME: runtime,
    } as unknown as MeetingRoomEnv, {} as ExecutionContext);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "validation_error" });
    expect(invoked).toBe(false);
  });
});
