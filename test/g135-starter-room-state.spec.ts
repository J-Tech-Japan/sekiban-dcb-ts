import { describe, expect, it } from "vitest";
import {
  applicationFetch,
  type StarterEnvironment,
  type StarterRuntime,
} from "../packages/create-dcb/template/src/booking-routes";

const ROOM_STATE = { status: "created", version: 1, roomId: "room-7", name: "Boardroom" };
const ROOM_VERSION = 3;
const ROOM_HEAD = "063923995692002000000693137501";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

describe("generated starter room state", () => {
  it("returns the exact keyed room state and read head, and does not dispatch the removed route", async () => {
    const calls: Array<{ readonly url: string; readonly body: Record<string, unknown> }> = [];
    const runtime: StarterRuntime = {
      fetch: async (request) => {
        const body = await request.clone().json<Record<string, unknown>>();
        calls.push({ url: request.url, body });
        return jsonResponse({
          payload: ROOM_STATE,
          version: ROOM_VERSION,
          lastSortedUniqueId: ROOM_HEAD,
          lastSortableUniqueId: "wrong-head",
        });
      },
    };
    const env = { SDT_SERVICE_ID: "starter-room-test" } as StarterEnvironment;
    const ctx = {} as ExecutionContext;

    const room = await applicationFetch(
      new Request("https://starter.test/api/read/room?roomId=room-7"),
      env,
      ctx,
      runtime,
    );
    expect(room.status).toBe(200);
    expect(await room.json()).toEqual({
      projection: "room",
      roomId: "room-7",
      tagStateId: "room:room-7:RoomProjector",
      state: ROOM_STATE,
      version: ROOM_VERSION,
      lastSortedUniqueId: ROOM_HEAD,
    });
    expect(calls).toEqual([{
      url: "https://runtime.internal/api/sekiban/serialized/tag-state",
      body: { tagStateId: "room:room-7:RoomProjector" },
    }]);

    const removed = await applicationFetch(
      new Request("https://starter.test/api/read/room-query?roomId=room-7"),
      env,
      ctx,
      runtime,
    );
    expect(removed.status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it("rejects a tag-state body that only carries lastSortableUniqueId", async () => {
    let calls = 0;
    const runtime: StarterRuntime = {
      fetch: async () => {
        calls += 1;
        return jsonResponse({
          payload: ROOM_STATE,
          version: ROOM_VERSION,
          lastSortableUniqueId: "wrong-head",
        });
      },
    };
    const response = await applicationFetch(
      new Request("https://starter.test/api/read/room?roomId=room-7"),
      { SDT_SERVICE_ID: "starter-room-test" } as StarterEnvironment,
      {} as ExecutionContext,
      runtime,
    );
    expect(calls).toBe(1);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Projection read omitted lastSortedUniqueId",
      code: "transport",
    });
  });

  it("keeps reservation reads on list-query", async () => {
    const calls: Array<{ readonly url: string; readonly body: Record<string, unknown> }> = [];
    const runtime: StarterRuntime = {
      fetch: async (request) => {
        const body = await request.clone().json<Record<string, unknown>>();
        calls.push({ url: request.url, body });
        return jsonResponse({
          itemsJson: "[]",
          totalCount: 0,
          totalPages: 0,
          currentPage: 2,
          pageSize: 5,
        });
      },
    };
    const response = await applicationFetch(
      new Request("https://starter.test/api/read/reservations?pageNumber=2&pageSize=5&newestFirst=true"),
      { SDT_SERVICE_ID: "starter-room-test" } as StarterEnvironment,
      {} as ExecutionContext,
      runtime,
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe("/api/sekiban/serialized/list-query");
    expect(calls[0]!.body.queryType).toBe("GetReservationListQuery");
    expect(JSON.parse(String(calls[0]!.body.queryParamsJson))).toEqual({
      PageNumber: 2,
      PageSize: 5,
      NewestFirst: true,
      consistency: "unsafe",
    });
  });
});
