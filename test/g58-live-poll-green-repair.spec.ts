import { describe, expect, it } from "vitest";
import {
  pollLiveProjections,
  type LiveProjectionPollObservation,
} from "../packages/dcb-runtime/src/projection/LiveProjectionWorker";
import {
  ProjectorRegistry,
  type ProjectionEvent,
  type TagStateProjector,
} from "../packages/dcb-runtime/src/projection/ProjectorRegistry";
import type { PipelineStore } from "../packages/dcb-runtime/src/store/types";

const SERVICE_ID = "g58-live-poll-green";

function projector(id: string): TagStateProjector {
  return {
    id,
    tagPayloadName: `${id}State`,
    projectorVersion: "1",
    initialState: () => ({ count: 0 }),
    apply: (state: unknown, event: ProjectionEvent) => {
      void event;
      return state;
    },
    serializeState: (state: unknown) => JSON.stringify(state),
    deserializeState: (value: string) => JSON.parse(value) as unknown,
    payload: (state: unknown) => JSON.stringify(state),
    version: (state: unknown) => (typeof state === "object" && state !== null && "count" in state
      ? Number((state as { count: unknown }).count)
      : 0),
  };
}

const registry = new ProjectorRegistry([
  projector("RoomProjector"),
  projector("ReservationProjector"),
]);

function store(initialize: () => Promise<void> = async () => undefined): PipelineStore {
  return {
    initialize,
    readAllEvents: async () => [],
    currentLagBound: async () => 0,
    listProjectionTags: async () => ["room:g58-live-poll-green"],
    readProjectionCheckpoint: async () => undefined,
    advanceProjectionCheckpoint: async () => true,
    projectionLag: async () => ({
      serviceId: SERVICE_ID,
      projectionId: "fixture",
      tag: "room:g58-live-poll-green",
      checkpointSuid: "",
      headSuid: "",
      behindEvents: 0,
    }),
    appendDeliveryIncident: async () => undefined,
  } as unknown as PipelineStore;
}

function observer(log: LiveProjectionPollObservation[]) {
  return {
    onAttempt: (input: { projectorIds: readonly string[]; attemptedAt: number }) => {
      expect(input.projectorIds).toEqual(["RoomProjector", "ReservationProjector"]);
      expect(input.attemptedAt).toBe(12_345);
    },
    onOutcome: (input: LiveProjectionPollObservation & { env: unknown }) => {
      log.push(input);
    },
  };
}

describe("SDT-G58 W111 scheduled live-poll lifecycle", () => {
  it("records an attempted no-work outcome for both registered projectors", async () => {
    const outcomes: LiveProjectionPollObservation[] = [];
    await pollLiveProjections({}, {
      store: store(),
      serviceId: SERVICE_ID,
      registry,
      clock: { now: () => 12_345 },
      observer: observer(outcomes),
    });
    expect(outcomes.map(({ projectorId, attemptedAt, outcome, reason }) => ({ projectorId, attemptedAt, outcome, reason }))).toEqual([
      { projectorId: "RoomProjector", attemptedAt: 12_345, outcome: "invoked-but-no-work", reason: null },
      { projectorId: "ReservationProjector", attemptedAt: 12_345, outcome: "invoked-but-no-work", reason: null },
    ]);
  });

  it("keeps a non-FULL retained-frontier fence explicit instead of claiming advancement", async () => {
    const outcomes: LiveProjectionPollObservation[] = [];
    await pollLiveProjections({}, {
      store: store(),
      serviceId: SERVICE_ID,
      registry,
      clock: { now: () => 12_345 },
      maximumSuid: null,
      observer: observer(outcomes),
    });
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every(({ outcome, reason }) => outcome === "explicitly-gated" && reason === "retained_frontier_unproven")).toBe(true);
  });

  it("records both projector failures when bootstrap admission rejects the poll", async () => {
    const outcomes: LiveProjectionPollObservation[] = [];
    const bootstrap = {
      idFromName: () => ({ fetch: async () => new Response("rejected", { status: 503 }) }),
      get: () => ({ fetch: async () => new Response("rejected", { status: 503 }) }),
    } as unknown;
    await expect(pollLiveProjections({ BOOTSTRAP: bootstrap as never }, {
      store: store(),
      serviceId: SERVICE_ID,
      registry,
      clock: { now: () => 12_345 },
      observer: observer(outcomes),
    })).rejects.toThrow("bootstrap_route_rejected:projection-rebuild");
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every(({ outcome, reason }) => outcome === "invoked-and-threw" && reason === "bootstrap_route_rejected:projection-rebuild")).toBe(true);
  });

  it("records initialization failure for both projectors without hiding the failure", async () => {
    const outcomes: LiveProjectionPollObservation[] = [];
    await expect(pollLiveProjections({}, {
      store: store(async () => { throw new Error("store_initialize_failed"); }),
      serviceId: SERVICE_ID,
      registry,
      clock: { now: () => 12_345 },
      observer: observer(outcomes),
    })).rejects.toThrow("store_initialize_failed");
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every(({ outcome, reason }) => outcome === "invoked-and-threw" && reason === "store_initialize_failed")).toBe(true);
  });
});
