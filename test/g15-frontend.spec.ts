import { describe, expect, it } from "vitest";
import { createMeetingRoomWorker, type MeetingRoomEnv } from "../samples/meeting-room/src/worker";
import { MAX_PUBLISHED_SAFE_WINDOW_MS } from "../packages/dcb-runtime/src/safeWindow";

const uiModel = await import("../samples/meeting-room/public/ui-model.js");

function encoded(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("SDT-G15 browser contract", () => {
  it("uses V1 ordinal comparison, not timestamps or a retry count, for visibility", () => {
    const bound = uiModel.UI_SAFE_WINDOW_BOUND_MS;
    // Keep the served browser model tied to the single published runtime
    // ceiling.  The absolute value is intentional: changing the protocol
    // ruling requires changing this oracle, rather than silently drifting
    // every copy of the bound together.
    expect(MAX_PUBLISHED_SAFE_WINDOW_MS).toBe(120_000);
    expect(bound).toBe(MAX_PUBLISHED_SAFE_WINDOW_MS);
    expect(uiModel.visibilityState({
      commitSortableUniqueId: "suid-02",
      lastSortedUniqueId: "suid-01",
      startedAt: 0,
      now: bound - 1,
    })).toBe("pending");
    expect(uiModel.visibilityState({
      commitSortableUniqueId: "suid-02",
      lastSortedUniqueId: "suid-01",
      startedAt: 0,
      now: bound,
    })).toBe("timeout");
    expect(uiModel.visibilityState({
      commitSortableUniqueId: "suid-02",
      lastSortedUniqueId: "suid-02",
      startedAt: 0,
      now: bound,
    })).toBe("visible");
    expect(uiModel.visibilityState({
      commitSortableUniqueId: "suid-02",
      lastSortedUniqueId: "suid-10",
      startedAt: 0,
      now: bound + 1,
    })).toBe("timeout");
    expect(uiModel.compareV1Ordinal("suid-10", "suid-2")).toBeLessThan(0);
  });

  it("keeps command outcome variants distinct for the UI", () => {
    expect(uiModel.commandOutcome(409, { kind: "conflict", code: "consistency_conflict" })).toBe("conflict");
    expect(uiModel.commandOutcome(400, { kind: "rejected", code: "room_missing" })).toBe("rejected");
    expect(uiModel.commandOutcome(500, { kind: "partial", code: "partial_write" })).toBe("partial");
  });

  it("exposes a read-only app-layer projection wrapper and leaves raw V1 unreachable", async () => {
    const calls: Request[] = [];
    const runtimeFetcher = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = input instanceof Request ? input : new Request(input, init);
        calls.push(request);
        return new Response(JSON.stringify({
          payload: encoded({ version: 1, status: "created", roomId: "room-1", name: "Boardroom" }),
          version: 1,
          lastSortedUniqueId: "suid-02",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    };
    const worker = createMeetingRoomWorker();
    const fetch = worker.fetch as unknown as (request: Request, env: MeetingRoomEnv, ctx: ExecutionContext) => Promise<Response>;
    const read = await fetch(new Request("https://sample.test/api/read/room?roomId=room-1", {
      headers: {
        // These are attacker-controlled headers.  The app-layer wrapper must
        // not forward either the G11 namespace selector or conformance auth
        // into the internal runtime request.
        "x-sdt-g11-service-id": "g11-attacker-supplied-value",
        "x-sdt-g9-test-service-id": "g9-attacker-supplied-value",
        authorization: "Bearer attacker-supplied-value",
      },
    }), {
      RUNTIME: runtimeFetcher,
    } as unknown as MeetingRoomEnv, {} as ExecutionContext);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      projection: "room",
      roomId: "room-1",
      lastSortedUniqueId: "suid-02",
      state: { status: "created", roomId: "room-1" },
    });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe("/api/sekiban/serialized/tag-state");
    expect(calls[0]!.headers.has("x-sdt-g11-service-id")).toBe(false);
    expect(calls[0]!.headers.has("x-sdt-g9-test-service-id")).toBe(false);
    expect(calls[0]!.headers.has("authorization")).toBe(false);

    const raw = await fetch(new Request("https://sample.test/api/sekiban/serialized/tag-state", {
      method: "POST",
      headers: { "x-sdt-g11-service-id": "g11-attacker-supplied-value" },
    }), {
      RUNTIME: runtimeFetcher,
    } as unknown as MeetingRoomEnv, {} as ExecutionContext);
    expect(raw.status).toBe(404);
  });
});
