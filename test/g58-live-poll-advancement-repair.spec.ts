import { describe, expect, it } from "vitest";
import { pollLiveProjections } from "../packages/dcb-runtime/src/projection/LiveProjectionWorker";
import { ProjectorRegistry, type ProjectionEvent, type TagStateProjector } from "../packages/dcb-runtime/src/projection/ProjectorRegistry";
import type { PipelineStore } from "../packages/dcb-runtime/src/store/types";

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
});
