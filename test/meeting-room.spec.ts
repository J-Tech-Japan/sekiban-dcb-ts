import { describe, expect, it } from "vitest";
import { createRuntimeWorker } from "@sekiban/dcb-runtime";
import { createMeetingRoomWorker, type MeetingRoomEnv } from "../samples/meeting-room/src/worker";
import { createV1Transport } from "../samples/meeting-room/src/transport";
import { bookRoomWorkflow } from "../samples/meeting-room/src/workflow";
import {
  cancelReservationCommand,
  createRoomCommand,
  meetingRoomDomain,
  meetingRoomRuntimeConfig,
  releaseRoomCommand,
  reserveRoomCommand,
} from "../samples/meeting-room/src/domain";

describe("SDT-G14 meeting-room consumer", () => {
  it("defines the required domain surface and exercises claim-ledger command verbs", () => {
    expect(meetingRoomDomain.events.map((event) => event.name)).toEqual([
      "RoomCreated",
      "RoomReserved",
      "ReservationCancelled",
      "RoomReleased",
    ]);
    expect(meetingRoomDomain.commands).toHaveLength(4);
    expect(meetingRoomDomain.projectors).toHaveLength(2);
    expect(meetingRoomDomain.queries).toHaveLength(2);

    const created = createRoomCommand.execute({ roomId: "r-1", name: "Boardroom" });
    expect(created.kind).toBe("committed");
    expect(created.events).toHaveLength(1);
    expect(created.events[0]?.event.eventPayloadName).toBe("RoomCreated");
    expect(reserveRoomCommand.execute({ roomId: "missing", reservationId: "res-1" }).kind).toBe("rejected");
    expect(cancelReservationCommand.execute({ reservationId: "missing" }).kind).toBe("rejected");
    expect(releaseRoomCommand.execute({ roomId: "missing" }).kind).toBe("rejected");
    expect(releaseRoomCommand.execute(
      { roomId: "r-1" },
      { state: { "room:r-1": { status: "released" } } },
    ).kind).toBe("noop");
  });

  it("composes the public runtime registration API without exposing private registries", async () => {
    const runtime = createRuntimeWorker({ domain: meetingRoomDomain, config: meetingRoomRuntimeConfig });
    const handler = runtime.fetch as unknown as (request: Request, env: unknown, ctx: unknown) => Promise<Response>;
    const response = await handler(new Request("https://sample.test/api/sekiban/serialized/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queryType: "unknown", queryParamsJson: "{}" }),
    }), {}, {});
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
          headers: { "content-type": "application/json" },
        });
      },
    }, "g11-meeting-room-test-12345678");
    await transport.commit({
      candidates: [{ eventId: "event-1", eventPayloadName: "RoomCreated", payload: { eventType: "RoomCreated" }, tags: ["room:r-1"] }],
      consistency: [{ tag: "room:r-1", lastSortableUniqueId: "suid-1" }],
    });
    const body = await captured!.json<Record<string, unknown>>();
    expect(body).toMatchObject({ version: 1 });
    expect(body.consistencyTags).toEqual([{ tag: "room:r-1", lastSortableUniqueId: "suid-1" }]);
    expect(body.eventCandidates).toEqual([
      expect.objectContaining({ eventPayloadName: "RoomCreated", tags: ["room:r-1"], payload: expect.any(String) }),
    ]);
  });

  it("does not forward a client g11 namespace from the unauthenticated command API", async () => {
    const calls: Request[] = [];
    const runtimeFetcher = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = input instanceof Request ? input : new Request(input, init);
        calls.push(request);
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
          headers: { "content-type": "application/json" },
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
    expect(calls.length).toBe(2);
    expect(calls.every((request) => !request.headers.has("x-sdt-g11-service-id"))).toBe(true);
  });
});
