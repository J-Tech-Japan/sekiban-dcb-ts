import { describe, expect, it } from "vitest";
import { compatibilityLaneIds, compatibilityOutcome, assertStoredIdentity, LEGACY_MIGRATION_MARKER } from "../samples/meeting-room/src/compatibility";
import compatibility from "../docs/SDT-G29-compatibility.json";
import { executeMeetingRoomCommand } from "../samples/meeting-room/src/transport";

describe("SDT-G29 compatibility lanes", () => {
  it("keeps the five published lanes explicit", () => {
    expect(compatibilityLaneIds()).toEqual(compatibility.lanes.map((lane) => lane.laneId));
    expect(compatibility.lanes.map((lane) => compatibilityOutcome(lane.laneId as Parameters<typeof compatibilityOutcome>[0])))
      .toEqual(["accepted", "typed-rejected", "accepted", "accepted", "accepted"]);
  });

  it("runs old-client V1 input through the new authored runtime without identity-less storage", async () => {
    let commitBody: Record<string, unknown> | undefined;
    const runtime = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (new URL(request.url).pathname.endsWith("/tag-state")) {
          return new Response(JSON.stringify({ payload: { status: "empty" }, version: 0, lastSortedUniqueId: "", tagGroup: "room", tagContent: "old-client", tagProjector: "RoomProjector" }), { status: 200 });
        }
        commitBody = await request.json<Record<string, unknown>>();
        return new Response(JSON.stringify({ writtenEvents: [], tagWriteResults: [] }), { status: 200 });
      },
    };
    const result = await executeMeetingRoomCommand("create-room", { roomId: "old-client", name: "Old" }, { RUNTIME: runtime });
    expect(result.kind).toBe("committed");
    const candidate = (commitBody?.eventCandidates as Array<Record<string, unknown>>)[0];
    expect(candidate).toMatchObject({ eventPayloadName: "RoomCreated", tags: ["room:old-client"] });
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(String(candidate.payload)), (character) => character.charCodeAt(0))));
    expect(decoded).not.toHaveProperty("eventType");
    assertStoredIdentity({ eventType: "RoomCreated:1", provenance: "g27" });
  });

  it("rejects identity-bearing input against an old runtime and accepts only marked legacy storage", () => {
    expect(compatibilityOutcome("new-client-old-runtime")).toBe("typed-rejected");
    expect(() => assertStoredIdentity({ eventType: "RoomCreated:1" })).toThrow("G29_STORAGE_IDENTITY_MISSING");
    expect(() => assertStoredIdentity({ provenance: "pre-g27", legacyMigrationMarker: "wrong" })).toThrow("G29_STORAGE_IDENTITY_MISSING");
    expect(() => assertStoredIdentity({ provenance: "pre-g27", legacyMigrationMarker: LEGACY_MIGRATION_MARKER })).not.toThrow();
  });
});
