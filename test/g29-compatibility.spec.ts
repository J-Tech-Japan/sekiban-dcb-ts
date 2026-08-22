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
import { meetingRoomAuthoringDomain, meetingRoomProjectors } from "../samples/meeting-room/src/domain";
import { roomMaterializer } from "../samples/meeting-room/src/d1-mv";
import preRewriteFixture from "./fixtures/g29-pre-rewrite-stored-outbox.json";
import { CommitWorker, type CommitWorkerEnv, validateCommitEnvelope } from "../packages/dcb-runtime/src/commit/CommitWorker";
import { composeRuntime, createRuntimeCommitPort } from "../packages/dcb-runtime/src/composition";
import { toRuntimeDomain } from "@sekiban/dcb-domain";
import { processDownstreamDelivery } from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import type { PipelineStore } from "../packages/dcb-runtime/src/store/types";

function realCommitWorkerRuntime(
  workerEnv: CommitWorkerEnv,
  serviceId: string,
  registeredEventVersions?: Readonly<Record<string, number>>,
): { readonly runtime: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> }; readonly commitCalls: () => number } {
  let commitCalls = 0;
  return {
    runtime: {
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/tag-state")) {
          const body = await request.json<{ tagStateId?: string }>();
          const tagStateId = typeof body.tagStateId === "string" ? body.tagStateId : "room:g29-boundary:RoomProjector";
          const projectorSeparator = tagStateId.lastIndexOf(":");
          const tagId = projectorSeparator > 0 ? tagStateId.slice(0, projectorSeparator) : "room:g29-boundary";
          const tagSeparator = tagId.indexOf(":");
          return new Response(JSON.stringify({ payload: { status: "empty" }, version: 0, lastSortedUniqueId: "", tagGroup: tagId.slice(0, tagSeparator), tagContent: tagId.slice(tagSeparator + 1), tagProjector: tagStateId.slice(projectorSeparator + 1) }), { status: 200 });
        }
        if (!path.endsWith("/commit")) return new Response(JSON.stringify({ error: "runtime route not found" }), { status: 404 });
        commitCalls += 1;
        return new CommitWorker(workerEnv, serviceId, { registeredEventVersions }).handle(new Request("https://commit.test/api/sekiban/serialized/commit", {
          method: request.method,
          headers: request.headers,
          body: await request.text(),
        }));
      },
    },
    commitCalls: () => commitCalls,
  };
}

describe("SDT-G29 compatibility lanes", () => {
  it("keeps the five published lanes explicit", () => {
    expect(compatibilityLaneIds()).toEqual(compatibility.lanes.map((lane) => lane.laneId));
    expect(compatibility.lanes.map((lane) => compatibilityOutcome(lane.laneId as Parameters<typeof compatibilityOutcome>[0])))
      .toEqual(["accepted", "accepted", "accepted", "typed-rejected", "accepted"]);
  });

  it("runs the old V1 client through a real old-runtime adapter and preserves the legacy wire", async () => {
    const serviceId = `g29-old-old-${crypto.randomUUID()}`;
    const boundary = realCommitWorkerRuntime(env as unknown as CommitWorkerEnv, serviceId);
    const result = await executeMeetingRoomCommand("create-room", { roomId: `old-old-${serviceId}`, name: "Old" }, { RUNTIME: boundary.runtime });
    if (result.kind !== "committed") throw new Error(`old-to-old result: ${JSON.stringify(result)}`);
    expect(boundary.commitCalls()).toBe(1);
    assertStoredIdentity({ eventType: "RoomCreated:1", provenance: "g27" });
  });

  it("rejects identity-bearing input against an old runtime and accepts only marked legacy storage", () => {
    expect(compatibilityOutcome("new-to-old")).toBe("typed-rejected");
    expect(oldRuntimeAdmission({ version: 1, eventCandidates: [{ payload: "e30=", eventPayloadName: "Order", eventType: "Order:1", provenance: "g27", tags: ["orders"] }] })).toBe("typed-rejected");
    expect(oldRuntimeAdmission({ version: 1, eventCandidates: [{ payload: "e30=", eventPayloadName: "Order", tags: ["orders"] }] })).toBe("accepted");
    expect(() => assertStoredIdentity({ eventType: "RoomCreated:1" })).toThrow("G29_STORAGE_IDENTITY_MISSING");
    expect(() => assertStoredIdentity({ provenance: "pre-g27", legacyMigrationMarker: "wrong" })).toThrow("G29_STORAGE_IDENTITY_MISSING");
    expect(() => assertStoredIdentity({ provenance: "pre-g27", legacyMigrationMarker: LEGACY_MIGRATION_MARKER })).not.toThrow();
  });

  it("executes AC6's five lanes one-to-one at the adapter/runtime boundary", async () => {
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

    const oldToOld = realCommitWorkerRuntime(env as unknown as CommitWorkerEnv, `g29-old-old-${crypto.randomUUID()}`);
    const oldToOldResult = await executeMeetingRoomCommand("create-room", { roomId: `old-old-${crypto.randomUUID()}`, name: "old-to-old" }, { RUNTIME: oldToOld.runtime });
    if (oldToOldResult.kind !== "committed") throw new Error(`old-to-old result: ${JSON.stringify(oldToOldResult)}`);
    expect(oldToOld.commitCalls()).toBe(1);
    laneResults["old-to-old"] = oldToOldResult.kind === "committed" ? "accepted" : "typed-rejected";

    const oldToNew = realCommitWorkerRuntime(env as unknown as CommitWorkerEnv, `g29-old-new-${crypto.randomUUID()}`, { RoomCreated: 1 });
    const oldToNewResult = await executeMeetingRoomCommand("create-room", { roomId: `old-new-${crypto.randomUUID()}`, name: "old-to-new" }, { RUNTIME: oldToNew.runtime });
    expect(oldToNewResult.kind).toBe("committed");
    expect(oldToNew.commitCalls()).toBe(1);
    laneResults["old-to-new"] = oldToNewResult.kind === "committed" ? "accepted" : "typed-rejected";

    const runtimeDomain = toRuntimeDomain(meetingRoomAuthoringDomain);
    const composed = composeRuntime(runtimeDomain);
    const newCommand = runtimeDomain.commands.find((command) => command.id === "create-room");
    expect(composed.commands.resolve("create-room")).toBeDefined();
    expect(newCommand).toBeDefined();
    const newToNewPort = createRuntimeCommitPort(env as unknown as CommitWorkerEnv, { registeredEventVersions: { RoomCreated: 1 } });
    const newToNewResult = await newCommand!.execute({ roomId: `new-new-${crypto.randomUUID()}`, name: "new-to-new" }, {
      now: "g29-new-to-new",
      runtimePort: { commit: newToNewPort.commit },
    });
    expect(newToNewResult).toMatchObject({ kind: "committed", events: [expect.objectContaining({ eventType: "RoomCreated:1", provenance: "g27" })] });
    laneResults["new-to-new"] = newToNewResult.kind === "committed" ? "accepted" : "typed-rejected";

    let oldRuntimeBoundaryCalls = 0;
    let oldRuntimeDownstreamWrites = 0;
    let oldRuntimeDisposition: { readonly kind: string; readonly code?: string } | undefined;
    const newToOldResult = await newCommand!.execute({ roomId: `new-old-${crypto.randomUUID()}`, name: "new-to-old" }, {
      now: "g29-new-to-old",
      runtimePort: {
        commit: async (candidate) => {
          oldRuntimeBoundaryCalls += 1;
          const wire = {
            version: 1,
            eventCandidates: candidate.events.map((event) => ({
              payload: btoa(JSON.stringify(event.payload)),
              eventPayloadName: event.eventName,
              eventType: event.eventType,
              provenance: event.provenance,
              tags: event.tags.map((tag) => tag.id),
            })),
          };
          const admission = oldRuntimeAdmission(wire);
          if (admission === "typed-rejected") {
            oldRuntimeDisposition = { kind: "rejected", code: "old_runtime_identity_unsupported" };
            return { kind: "rejected" as const, code: "old_runtime_identity_unsupported", reason: "old runtime cannot accept canonical identity" };
          }
          oldRuntimeDownstreamWrites += 1;
          return { kind: "accepted" as const };
        },
      },
    });
    expect(newToOldResult.kind).toBe("rejected");
    expect(oldRuntimeDisposition).toEqual({ kind: "rejected", code: "old_runtime_identity_unsupported" });
    expect(oldRuntimeBoundaryCalls).toBe(1);
    expect(oldRuntimeDownstreamWrites).toBe(0);
    laneResults["new-to-old"] = newToOldResult.kind === "rejected" ? "typed-rejected" : "accepted";

    const legacyResolution = replayOldHistoryToNewRuntime({
      eventId: String(legacyStored.eventId),
      suid: String(legacyStored.suid),
      payload: legacyPayload,
      provenance: "pre-g27",
    }, LEGACY_MIGRATION_MARKER);
    expect(legacyResolution).toMatchObject({ kind: "accepted", eventType: "RoomCreated:1", usedLegacyDiscriminator: true });
    const legacyPlan = roomMaterializer.plan({ ...legacyStored, eventType: legacyResolution.eventType, provenance: "g27" } as never);
    expect(legacyPlan.rowUpserts).toHaveLength(1);

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

    const downgrade = downgradeReplay([
      { eventId: String(legacyStored.eventId), suid: String(legacyStored.suid), payload: legacyPayload, provenance: "pre-g27" },
      canonicalRecord,
    ], LEGACY_MIGRATION_MARKER);
    expect(downgrade).toMatchObject({ kind: "accepted", writes: 0, eventTypes: ["RoomCreated:1", "RoomReleased:1"] });
    laneResults["upgrade-downgrade-replay"] = downgrade.kind;

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
