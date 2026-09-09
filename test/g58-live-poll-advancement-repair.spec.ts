import { describe, expect, it } from "vitest";
import { scheduledLiveProjectionMaximumSuid } from "../packages/dcb-runtime/src/cloudflare";
import { pollLiveProjections } from "../packages/dcb-runtime/src/projection/LiveProjectionWorker";
import { ProjectorRegistry, type ProjectionEvent, type TagStateProjector } from "../packages/dcb-runtime/src/projection/ProjectorRegistry";
import type {
  PipelineStore,
  ProjectionCheckpoint,
  ProjectionCheckpointAdvance,
  StoredEvent,
} from "../packages/dcb-runtime/src/store/types";
import { g32Message, g32StoredEvent, g32Suid } from "./helpers/g32-fixtures";

function projector(id: string): TagStateProjector {
  return {
    id,
    tagPayloadName: `${id}State`,
    projectorVersion: "1",
    initialState: () => 0,
    apply: (state: unknown, event: ProjectionEvent) => {
      void event;
      return state;
    },
    serializeState: (state: unknown) => JSON.stringify(state),
    deserializeState: (value: string) => JSON.parse(value) as unknown,
    payload: (state: unknown) => JSON.stringify(state),
    version: () => 0,
  };
}

const registry = new ProjectorRegistry([projector("RoomProjector"), projector("ReservationProjector")]);

function delayedStore(onRead: (active: number) => void): PipelineStore {
  let active = 0;
  return {
    initialize: async () => undefined,
    readAllEvents: async () => {
      active += 1;
      onRead(active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return [];
    },
    currentLagBound: async () => 0,
    listProjectionTags: async () => ["room:one", "room:two", "reservation:one", "reservation:two"],
    readProjectionCheckpoint: async () => undefined,
    advanceProjectionCheckpoint: async () => true,
    projectionLag: async () => ({ serviceId: "g58", projectionId: "fixture", tag: "room:one", checkpointSuid: "", headSuid: "", behindEvents: 0 }),
    appendDeliveryIncident: async () => undefined,
  } as unknown as PipelineStore;
}

describe("SDT-G58 W112 live-poll advancement", () => {
  it("services independent tag/projector identities concurrently so both projectors finish a large poll", async () => {
    let maximumConcurrentReads = 0;
    const results = await pollLiveProjections({}, {
      store: delayedStore((active) => { maximumConcurrentReads = Math.max(maximumConcurrentReads, active); }),
      serviceId: "g58-live-poll-advancement",
      registry,
      clock: { now: () => 12_345 },
    });
    expect(results).toHaveLength(8);
    expect(new Set(results.map((result) => result.projectorId))).toEqual(new Set(["RoomProjector", "ReservationProjector"]));
    expect(maximumConcurrentReads).toBeGreaterThan(1);
  });

  it("G61 AC3 regression: a non-FULL reconcile advances registered projectors through its proven frontier", async () => {
    const serviceId = "g61-retained-frontier";
    const tag = "room:g61-retained-frontier";
    const proven = g32StoredEvent(g32Message({
      serviceId,
      tag,
      eventId: "g61-proven-frontier",
      suid: g32Suid(1),
      eventTags: [tag],
    }), 0);
    const pending = g32StoredEvent(g32Message({
      serviceId,
      tag,
      eventId: "g61-pending-after-frontier",
      suid: g32Suid(2),
      eventTags: [tag],
    }), 0);
    const checkpoints = new Map<string, ProjectionCheckpoint>();
    const sourceEvents: readonly StoredEvent[] = [proven, pending];
    const store = {
      initialize: async () => undefined,
      readAllEvents: async (_serviceId: string, since: string) => sourceEvents.filter((event) => event.suid > since),
      currentLagBound: async () => 0,
      listProjectionTags: async () => [tag],
      readProjectionCheckpoint: async (_serviceId: string, projectionId: string) => checkpoints.get(projectionId),
      advanceProjectionCheckpoint: async (input: ProjectionCheckpointAdvance) => {
        const prior = checkpoints.get(input.projectionId);
        if ((prior?.lastSuid ?? null) !== input.expectedLastSuid) return false;
        checkpoints.set(input.projectionId, {
          serviceId: input.serviceId,
          projectionId: input.projectionId,
          lastSuid: input.lastSuid,
          stateJson: input.stateJson,
          version: input.version,
          updatedAt: input.updatedAt,
        });
        return true;
      },
      projectionLag: async (_serviceId: string, projectionId: string, projectionTag: string) => ({
        serviceId,
        projectionId,
        tag: projectionTag,
        checkpointSuid: checkpoints.get(projectionId)?.lastSuid ?? "",
        headSuid: pending.suid,
        behindEvents: 0,
      }),
      appendDeliveryIncident: async () => undefined,
    } as unknown as PipelineStore;
    const maximumSuid = scheduledLiveProjectionMaximumSuid({ kind: "BLOCK" }, proven.suid);
    const closedPrefixCertificate = {
      certificateVersion: 1 as const,
      authority: "allocator-transaction" as const,
      status: "ready" as const,
      serviceId,
      allocatorLineageId: "g61-retained-frontier-lineage",
      closedPrefixSuid: proven.suid,
      unresolvedCount: 0,
      generatedAt: 100_000,
      migrationProofId: null,
    };

    expect(maximumSuid).toBe(proven.suid);
    const results = await pollLiveProjections({}, {
      store,
      serviceId,
      registry,
      clock: { now: () => 100_000 },
      maximumSuid,
      closedPrefixSuid: proven.suid,
      closedPrefixCertificate,
    });

    expect(results).toHaveLength(2);
    expect(new Set(results.map((result) => result.projectorId))).toEqual(new Set([
      "RoomProjector",
      "ReservationProjector",
    ]));
    expect(results.every((result) => result.advancedSourceEvents === 1 && result.appliedEvents === 1)).toBe(true);
    expect([...checkpoints.values()]).toHaveLength(2);
    expect([...checkpoints.values()].every((checkpoint) => checkpoint.lastSuid === proven.suid)).toBe(true);
    expect([...checkpoints.values()].some((checkpoint) => checkpoint.lastSuid === pending.suid)).toBe(false);
  });
});
