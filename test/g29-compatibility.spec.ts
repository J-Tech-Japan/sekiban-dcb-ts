import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { compatibilityLaneIds, compatibilityOutcome, assertStoredIdentity, LEGACY_MIGRATION_MARKER, oldRuntimeAdmission } from "../samples/meeting-room/src/compatibility";
import compatibility from "../docs/SDT-G29-compatibility.json";
import { executeMeetingRoomCommand } from "../samples/meeting-room/src/transport";
import { CommitWorker, type CommitWorkerEnv, validateCommitEnvelope } from "../packages/dcb-runtime/src/commit/CommitWorker";
import { processDownstreamDelivery } from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import type { PipelineStore } from "../packages/dcb-runtime/src/store/types";

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
    expect(oldRuntimeAdmission({ version: 1, eventCandidates: [{ payload: "e30=", eventPayloadName: "Order", eventType: "Order:1", provenance: "g27", tags: ["orders"] }] })).toBe("typed-rejected");
    expect(oldRuntimeAdmission({ version: 1, eventCandidates: [{ payload: "e30=", eventPayloadName: "Order", tags: ["orders"] }] })).toBe("accepted");
    expect(() => assertStoredIdentity({ eventType: "RoomCreated:1" })).toThrow("G29_STORAGE_IDENTITY_MISSING");
    expect(() => assertStoredIdentity({ provenance: "pre-g27", legacyMigrationMarker: "wrong" })).toThrow("G29_STORAGE_IDENTITY_MISSING");
    expect(() => assertStoredIdentity({ provenance: "pre-g27", legacyMigrationMarker: LEGACY_MIGRATION_MARKER })).not.toThrow();
  });

  it("inspects the real CommitWorker admission/storage path and fails closed before downstream dispatch", async () => {
    const serviceId = "local-test-runtime";
    const tag = `room:g29-compat-${crypto.randomUUID()}`;
    const workerEnv = env as unknown as CommitWorkerEnv;
    const response = await new CommitWorker(workerEnv, serviceId, { registeredEventVersions: { G29Observed: 2 } }).handle(new Request("https://commit.test/api/sekiban/serialized/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, eventCandidates: [{ payload: btoa(JSON.stringify({ roomId: "g29-compat" })), eventPayloadName: "G29Observed", tags: [tag] }], consistencyTags: [] }),
    }));
    if (response.status !== 200) throw new Error(`real CommitWorker response ${response.status}: ${await response.text()}`);
    const written = await response.json<{ writtenEvents: Array<{ id: string; eventPayloadName: string; sortableUniqueIdValue: string }> }>();
    expect(written.writtenEvents[0]).toMatchObject({ eventPayloadName: "G29Observed" });

    const tagNamespace = (env as unknown as { readonly TAG: DurableObjectNamespace }).TAG;
    const tagStub = tagNamespace.get(tagNamespace.idFromName(`${serviceId}|${tag}`));
    const stateResponse = await tagStub.fetch(new Request(`https://compat.test/state?__tag=${encodeURIComponent(tag)}`));
    expect(stateResponse.status).toBe(200);
    const state = await stateResponse.json<{ events: Array<{ eventId: string; eventType?: string; provenance?: string }> }>();
    expect(state.events).toContainEqual(expect.objectContaining({ eventId: written.writtenEvents[0]?.id, eventType: "G29Observed:2", provenance: "g27" }));
    expect(validateCommitEnvelope({ version: 1, eventCandidates: [{ payload: "e30=", eventPayloadName: "G29Observed", eventPayloadVersion: 2, tags: [tag] }], consistencyTags: [] })).toHaveProperty("error");

    let downstreamCalls = 0;
    const store = { recordDelivery: async () => { downstreamCalls += 1; throw new Error("must not dispatch"); } } as unknown as PipelineStore;
    await expect(processDownstreamDelivery({ version: 1, serviceId, allocatorLineageId: "lineage", tag, attemptId: "attempt", eventId: "event", suid: "suid", payload: "e30=", eventTags: [tag], enqueuedAt: 0 } as never, {}, { store })).rejects.toThrow("missing canonical event identity");
    expect(downstreamCalls).toBe(0);
  });
});
