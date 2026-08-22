import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  compatibilityLaneIds,
  compatibilityOutcome,
  assertStoredIdentity,
  LEGACY_MIGRATION_MARKER,
  oldRuntimeAdmission,
  replayOldHistoryToNewRuntime,
  replayNewHistoryToOldRuntime,
  downgradeReplay,
} from "../samples/meeting-room/src/compatibility";
import compatibility from "../docs/SDT-G29-compatibility.json";
import { executeMeetingRoomCommand } from "../samples/meeting-room/src/transport";
import { meetingRoomProjectors } from "../samples/meeting-room/src/domain";
import { roomMaterializer } from "../samples/meeting-room/src/d1-mv";
import preRewriteFixture from "./fixtures/g29-pre-rewrite-stored-outbox.json";
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

  it("executes each of the five published lanes against its real compatibility fixture", async () => {
    const decode = (encoded: string): Record<string, unknown> => {
      const binary = atob(encoded);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    };
    const stored = preRewriteFixture.storedBytes.map(decode);
    const legacyStored = stored[0]!;
    const canonicalStored = stored[1]!;
    const legacyPayload = decode(String(legacyStored.payload));
    const canonicalPayload = decode(String(canonicalStored.payload));
    const laneResults: Record<string, string> = {};

    let oldClientCommit: Record<string, unknown> | undefined;
    const oldClientRuntime = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (new URL(request.url).pathname.endsWith("/tag-state")) {
          return new Response(JSON.stringify({ payload: { status: "empty" }, version: 0, lastSortedUniqueId: "", tagGroup: "room", tagContent: "g29-lanes", tagProjector: "RoomProjector" }), { status: 200 });
        }
        oldClientCommit = await request.json<Record<string, unknown>>();
        return new Response(JSON.stringify({ writtenEvents: [], tagWriteResults: [] }), { status: 200 });
      },
    };
    const oldClient = await executeMeetingRoomCommand("create-room", { roomId: "g29-lanes", name: "Old client" }, { RUNTIME: oldClientRuntime });
    expect(oldClient.kind).toBe("committed");
    expect(oldClientCommit?.eventCandidates).toBeInstanceOf(Array);
    laneResults["old-client-new-runtime"] = "accepted";

    const newClient = oldRuntimeAdmission({
      version: 1,
      eventCandidates: [{ payload: "e30=", eventPayloadName: "RoomCreated", eventType: "RoomCreated:1", provenance: "g27", tags: ["room:g29-lanes"] }],
    });
    expect(newClient).toBe("typed-rejected");
    laneResults["new-client-old-runtime"] = newClient;

    const legacyResolution = replayOldHistoryToNewRuntime({
      eventId: String(legacyStored.eventId),
      suid: String(legacyStored.suid),
      payload: legacyPayload,
      provenance: "pre-g27",
    }, LEGACY_MIGRATION_MARKER);
    expect(legacyResolution).toMatchObject({ kind: "accepted", eventType: "RoomCreated:1", usedLegacyDiscriminator: true });
    const legacyPlan = roomMaterializer.plan({
      ...legacyStored,
      eventType: legacyResolution.eventType,
      provenance: "g27",
    } as never);
    expect(legacyPlan.rowUpserts).toHaveLength(1);
    laneResults["old-history-new-replay"] = legacyResolution.kind;

    const canonicalRecord = {
      eventId: String(canonicalStored.eventId),
      suid: String(canonicalStored.suid),
      payload: canonicalPayload,
      eventType: String(canonicalStored.eventType),
      provenance: "g27" as const,
    };
    const oldReplay = replayNewHistoryToOldRuntime(canonicalRecord);
    expect(oldReplay).toEqual({ kind: "accepted", eventName: "RoomReleased", legacyDiscriminator: "RoomReleased" });
    const oldReplayRow = {
      ...canonicalStored,
      eventType: undefined,
      provenance: undefined,
      payload: btoa(JSON.stringify({ ...canonicalPayload, eventType: oldReplay.legacyDiscriminator })),
    };
    expect(roomMaterializer.plan(oldReplayRow as never).rowUpserts).toHaveLength(1);
    laneResults["new-history-old-replay"] = oldReplay.kind;

    const downgrade = downgradeReplay([
      { eventId: String(legacyStored.eventId), suid: String(legacyStored.suid), payload: legacyPayload, provenance: "pre-g27" },
      canonicalRecord,
    ], LEGACY_MIGRATION_MARKER);
    expect(downgrade).toMatchObject({ kind: "accepted", writes: 0, eventTypes: ["RoomCreated:1", "RoomReleased:1"] });
    laneResults["downgrade-replay"] = downgrade.kind;

    expect(compatibility.lanes.map((lane) => lane.laneId)).toEqual(compatibilityLaneIds());
    expect(compatibility.lanes.map((lane) => lane.outcome)).toEqual(
      compatibilityLaneIds().map((lane) => laneResults[lane]),
    );
    expect(meetingRoomProjectors.roomProjector.eventTypes).toContain("RoomCreated:1");
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

    const residualStore = { recordDelivery: async () => { downstreamCalls += 1; throw new Error("fallback must not dispatch"); } } as unknown as PipelineStore;
    await expect(processDownstreamDelivery({
      version: 1,
      serviceId,
      allocatorLineageId: "lineage",
      tag,
      attemptId: "residual-attempt",
      eventId: "residual-event",
      suid: "residual-suid",
      payload: btoa(JSON.stringify({ eventType: "RoomReserved", roomId: "room", reservationId: "reservation", userId: "user" })),
      eventTags: [tag],
      enqueuedAt: 0,
      provenance: "g27",
    } as never, {}, { store: residualStore })).rejects.toThrow("invalid outbox message");
    expect(downstreamCalls).toBe(0);
  });
});
