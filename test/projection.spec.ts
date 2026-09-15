import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { processDownstreamDelivery } from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import type { DownstreamOutboxMessage, PipelineClock } from "../packages/dcb-runtime/src/downstream/types";
import { composeRuntime } from "../packages/dcb-runtime/src/composition";
import { pollLiveProjections } from "../packages/dcb-runtime/src/projection/LiveProjectionWorker";
import { ProjectorRegistry, tagStateIdentityFrom, TEST_TAG_STATE_PROJECTOR } from "../packages/dcb-runtime/src/projection/ProjectorRegistry";
import {
  PUBLISHED_SAFE_WINDOW_MS,
  ProjectionCheckpointCorruption,
  ProjectionRuntime,
  projectionIdFor,
  safeWindowMs,
} from "../packages/dcb-runtime/src/projection/ProjectionRuntime";
import type { PipelineStore, ProjectionCheckpoint } from "../packages/dcb-runtime/src/store/types";
import { meetingRoomDomain, meetingRoomRuntimeConfig } from "../samples/meeting-room/src/domain";
import type { Env as WorkerEnv } from "../packages/dcb-runtime/src/index";
import { PostgresEventStore } from "../packages/dcb-runtime/src/store/PostgresEventStore";
import { g32Message, g32Suid, g32SuidAt } from "./helpers/g32-fixtures";

// This file exercises the PostgreSQL allocator binding. Keep its service
// namespace private so another file's fixed fixture cannot bind a different
// allocator lineage before the G8 delivery is recorded.
const SERVICE_ID = "projection-test-runtime";

function unique(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function mutableClock(nowMs: number): { clock: PipelineClock; set(now: number): void } {
  let now = nowMs;
  return { clock: { now: () => now }, set: (next) => { now = next; } };
}

function message(
  serviceId: string,
  eventId: string,
  suid: string,
  tag: string,
  enqueuedAt: number,
): DownstreamOutboxMessage {
  return g32Message({
    serviceId,
    allocatorLineageId: "test-projection-lineage",
    tag,
    attemptId: `${eventId}-attempt`,
    eventId,
    // These SafeWindow fixtures need a physical tick segment near the
    // injected clock, not the epoch-adjacent generic fixture default.
    suid: g32SuidAt(Math.max(999, enqueuedAt), suid),
    eventTags: [tag],
    enqueuedAt,
  });
}

function postgresStore(): PostgresEventStore {
  const url = (env as unknown as WorkerEnv).POSTGRES_URL;
  if (url === undefined) {
    throw new Error("POSTGRES_URL binding is required; run docker compose up --wait postgres");
  }
  return new PostgresEventStore(url);
}

async function withPostgresStore<T>(operation: (store: PostgresEventStore) => Promise<T>): Promise<T> {
  const store = postgresStore();
  await store.initialize();
  return operation(store);
}

function identityFor(tag: string) {
  const parsed = tagStateIdentityFrom(`${tag}:${TEST_TAG_STATE_PROJECTOR}`);
  if (parsed.value === undefined) {
    throw new Error(parsed.error);
  }
  return parsed.value;
}

function stateEvents(checkpoint: ProjectionCheckpoint): Array<{ eventId: string; suid: string }> {
  return JSON.parse(checkpoint.stateJson) as Array<{ eventId: string; suid: string }>;
}

async function injectDelivery(
  store: PostgresEventStore,
  entry: DownstreamOutboxMessage,
  clock: PipelineClock,
): Promise<void> {
  await processDownstreamDelivery(entry, { POSTGRES_URL: (env as unknown as WorkerEnv).POSTGRES_URL }, { store, clock });
}

describe("SDT-G8 live projection", () => {
  it("rejects a stale durable checkpoint CAS without overwriting projection state", async () => {
    const serviceId = unique("checkpoint-cas-service");
    const projectionId = unique("checkpoint-cas-projection");
    const first = {
      serviceId,
      projectionId,
      expectedLastSuid: null,
      lastSuid: g32Suid("1"),
      stateJson: JSON.stringify({ applied: ["first"] }),
      version: 1,
      updatedAt: 1_000,
    };
    const stale = {
      ...first,
      lastSuid: g32Suid("2"),
      stateJson: JSON.stringify({ applied: ["first", "stale"] }),
      version: 2,
      updatedAt: 2_000,
    };

    await withPostgresStore(async (store) => {
      expect(await store.advanceProjectionCheckpoint(first)).toBe(true);
      const beforeStaleAdvance = await store.readProjectionCheckpoint(serviceId, projectionId);
      expect(beforeStaleAdvance).toMatchObject({
        lastSuid: first.lastSuid,
        stateJson: first.stateJson,
      });

      // This writer observed no checkpoint before the first writer committed,
      // so its null expected position is now stale.
      expect(await store.advanceProjectionCheckpoint(stale)).toBe(false);
      const afterStaleAdvance = await store.readProjectionCheckpoint(serviceId, projectionId);
      expect(afterStaleAdvance).toMatchObject({
        lastSuid: beforeStaleAdvance!.lastSuid,
        stateJson: beforeStaleAdvance!.stateJson,
      });
    });
  });

  it("holds out-of-order adapter deliveries behind SafeWindow, then applies each SUID once", async () => {
    const serviceId = unique("safe-window-service");
    const tag = `orders:${unique("safe-window")}`;
    const identity = identityFor(tag);
    const clock = mutableClock(1_000);
    const higher = message(serviceId, unique("higher"), "suid-00000000000000000000000000000002", tag, 900);
    const lower = message(serviceId, unique("lower"), "suid-00000000000000000000000000000001", tag, 950);

    await withPostgresStore(async (store) => {
      await injectDelivery(store, higher, clock.clock);
      clock.set(1_050);
      await injectDelivery(store, lower, clock.clock);
      const eventsBeforeProjection = await store.readAllEvents(serviceId, "");

      const runtime = new ProjectionRuntime(store);
      clock.set(20_999);
      const beforeWindow = await runtime.catchUp(serviceId, identity, clock.clock.now());
      expect(beforeWindow.dynamicLagBoundMs).toBe(100);
      expect(beforeWindow.safeWindowMs).toBe(PUBLISHED_SAFE_WINDOW_MS);
      expect(beforeWindow.checkpoint).toBeUndefined();
      expect(beforeWindow.appliedEvents).toBe(0);

      clock.set(21_050);
      const caughtUp = (await runtime.pollRegistered(serviceId, clock.clock.now()))[0]!;
      expect(caughtUp.advancedSourceEvents).toBe(2);
      expect(caughtUp.appliedEvents).toBe(2);
      const projectionId = projectionIdFor(identity);
      const checkpoint = await store.readProjectionCheckpoint(serviceId, projectionId);
      expect(checkpoint).toMatchObject({
        lastSuid: higher.suid,
        version: 2,
      });
      expect(stateEvents(checkpoint!).map(({ eventId, suid }) => ({ eventId, suid }))).toEqual([
        { eventId: lower.eventId, suid: lower.suid },
        { eventId: higher.eventId, suid: higher.suid },
      ]);

      const repeatedPoll = await runtime.catchUp(serviceId, identity, clock.clock.now());
      expect(repeatedPoll.advancedSourceEvents).toBe(0);
      expect(repeatedPoll.appliedEvents).toBe(0);
      expect(stateEvents((await store.readProjectionCheckpoint(serviceId, projectionId))!)).toHaveLength(2);
      expect(await store.readAllEvents(serviceId, "")).toEqual(eventsBeforeProjection);
    });
  });

  it("extends SafeWindow from the delivered lag metric", async () => {
    const serviceId = unique("dynamic-window-service");
    const tag = `orders:${unique("dynamic-window")}`;
    const identity = identityFor(tag);
    const clock = mutableClock(1_000);
    const delayed = message(serviceId, unique("delayed"), "suid-00000000000000000000000000000001", tag, -24_000);

    await withPostgresStore(async (store) => {
      await injectDelivery(store, delayed, clock.clock);
      const runtime = new ProjectionRuntime(store);

      clock.set(25_999);
      const beforeDynamicWindow = await runtime.catchUp(serviceId, identity, clock.clock.now());
      expect(beforeDynamicWindow.dynamicLagBoundMs).toBe(25_000);
      expect(beforeDynamicWindow.safeWindowMs).toBe(25_000);
      expect(beforeDynamicWindow.checkpoint).toBeUndefined();

      clock.set(26_000);
      const afterDynamicWindow = await runtime.catchUp(serviceId, identity, clock.clock.now());
      expect(afterDynamicWindow.appliedEvents).toBe(1);
      expect(afterDynamicWindow.checkpoint).toMatchObject({ lastSuid: delayed.suid, version: 1 });
    });
  });

  it("decays the current lag estimate and excludes a lower-SUID recovery backlog sample", async () => {
    const serviceId = unique("lag-estimator-service");
    const tag = `orders:${unique("lag-estimator")}`;
    const observedAt = Date.now();
    const first = message(
      serviceId,
      unique("lag-estimator-head"),
      "suid-00000000000000000000000000000002",
      tag,
      observedAt - 60_000,
    );
    const recoveryBacklog = message(
      serviceId,
      unique("lag-estimator-backlog"),
      "suid-00000000000000000000000000000001",
      tag,
      observedAt - 119_000,
    );

    await withPostgresStore(async (store) => {
      await store.recordDelivery(first, observedAt);
      expect(await store.currentLagBound(serviceId, observedAt)).toBe(60_000);
      const decayed = await store.currentLagBound(serviceId, observedAt + 50_000);
      expect(decayed).toBe(10_000);
      expect(safeWindowMs(decayed)).toBe(PUBLISHED_SAFE_WINDOW_MS);

      await store.recordDelivery(recoveryBacklog, observedAt + 50_001);
      // The old SUID arrived during recovery, so its 119s lag is observable
      // in arrivals but cannot inflate the reordering estimate.
      expect(await store.currentLagBound(serviceId, observedAt + 50_001)).toBe(9_999);
    });
  });

  it("polls independent tag projections from the deploy-time registry", async () => {
    const serviceId = unique("multi-projection-service");
    const firstTag = `orders:${unique("first-projection")}`;
    const secondTag = `orders:${unique("second-projection")}`;
    const firstIdentity = identityFor(firstTag);
    const secondIdentity = identityFor(secondTag);
    const clock = mutableClock(1_000);
    const firstEvent = message(serviceId, unique("first-projection-event"), "suid-00000000000000000000000000000001", firstTag, 900);
    const secondEvent = message(serviceId, unique("second-projection-event"), "suid-00000000000000000000000000000002", secondTag, 900);

    await withPostgresStore(async (store) => {
      await injectDelivery(store, firstEvent, clock.clock);
      await injectDelivery(store, secondEvent, clock.clock);
      clock.set(21_000);
      const runtime = new ProjectionRuntime(store);
      const results = await runtime.pollRegistered(serviceId, clock.clock.now());
      expect(results).toHaveLength(2);
      expect(stateEvents((await store.readProjectionCheckpoint(serviceId, projectionIdFor(firstIdentity)))!)
        .map((entry) => entry.eventId)).toEqual([firstEvent.eventId]);
      expect(stateEvents((await store.readProjectionCheckpoint(serviceId, projectionIdFor(secondIdentity)))!)
        .map((entry) => entry.eventId)).toEqual([secondEvent.eventId]);
    });
  });

  it("persists state and SUID checkpoint together across before/after-checkpoint crash faults", async () => {
    const serviceId = unique("checkpoint-service");
    const tag = `orders:${unique("checkpoint")}`;
    const identity = identityFor(tag);
    const projectionId = projectionIdFor(identity);
    const clock = mutableClock(1_000);
    const events = [
      message(serviceId, unique("checkpoint-one"), "suid-00000000000000000000000000000001", tag, 900),
      message(serviceId, unique("checkpoint-two"), "suid-00000000000000000000000000000002", tag, 900),
      message(serviceId, unique("checkpoint-three"), "suid-00000000000000000000000000000003", tag, 900),
    ];

    await withPostgresStore(async (store) => {
      for (const entry of events) {
        await injectDelivery(store, entry, clock.clock);
      }
      clock.set(21_000);
      const runtime = new ProjectionRuntime(store);
      await expect(runtime.catchUp(serviceId, identity, clock.clock.now(), {
        afterCheckpoint: (event) => {
          if (event.suid === events[0]!.suid) {
            throw new Error("injected crash after durable checkpoint");
          }
        },
      })).rejects.toThrow("injected crash after durable checkpoint");
      expect(await store.readProjectionCheckpoint(serviceId, projectionId)).toMatchObject({
        lastSuid: events[0]!.suid,
        version: 1,
      });

      const restartedStore = postgresStore();
      await restartedStore.initialize();
      const restartedRuntime = new ProjectionRuntime(restartedStore);
      const resumed = await restartedRuntime.catchUp(serviceId, identity, clock.clock.now());
      expect(resumed.appliedEvents).toBe(2);
      const recovered = await restartedStore.readProjectionCheckpoint(serviceId, projectionId);
      expect(recovered).toMatchObject({ lastSuid: events[2]!.suid, version: 3 });
      expect(stateEvents(recovered!).map((entry) => entry.eventId)).toEqual(events.map((entry) => entry.eventId));
      expect((await restartedRuntime.catchUp(serviceId, identity, clock.clock.now())).appliedEvents).toBe(0);

      const beforeFaultServiceId = unique("before-checkpoint-service");
      const beforeFaultTag = `orders:${unique("before-checkpoint")}`;
      const beforeFaultIdentity = identityFor(beforeFaultTag);
      const beforeFaultProjectionId = projectionIdFor(beforeFaultIdentity);
      const beforeFaultClock = mutableClock(1_000);
      const beforeFaultEvent = message(
        beforeFaultServiceId,
        unique("before-checkpoint-event"),
        "suid-00000000000000000000000000000001",
        beforeFaultTag,
        900,
      );
      await injectDelivery(restartedStore, beforeFaultEvent, beforeFaultClock.clock);
      beforeFaultClock.set(21_000);
      await expect(restartedRuntime.catchUp(beforeFaultServiceId, beforeFaultIdentity, beforeFaultClock.clock.now(), {
        beforeCheckpoint: () => { throw new Error("injected crash before durable checkpoint"); },
      })).rejects.toThrow("injected crash before durable checkpoint");
      expect(await restartedStore.readProjectionCheckpoint(beforeFaultServiceId, beforeFaultProjectionId)).toBeUndefined();
      const recoveredBeforeCheckpoint = await restartedRuntime.catchUp(
        beforeFaultServiceId,
        beforeFaultIdentity,
        beforeFaultClock.clock.now(),
      );
      expect(recoveredBeforeCheckpoint).toMatchObject({ appliedEvents: 1 });
      expect(stateEvents((await restartedStore.readProjectionCheckpoint(beforeFaultServiceId, beforeFaultProjectionId))!)
        .map(({ eventId, suid }) => ({ eventId, suid }))).toEqual([
        { eventId: beforeFaultEvent.eventId, suid: beforeFaultEvent.suid },
      ]);
    });
  });

  it("exposes behind-head projection lag without advancing a projection", async () => {
    const serviceId = SERVICE_ID;
    const tag = `orders:${unique("projection-lag")}`;
    const identity = identityFor(tag);
    const event = message(
      serviceId,
      unique("projection-lag-event"),
      `suid-lag-${crypto.randomUUID()}`,
      tag,
      Date.now() - 100,
    );
    await withPostgresStore(async (store) => {
      await injectDelivery(store, event, { now: () => Date.now() });
    });

    const response = await SELF.fetch(
      `https://projection.test/internal/projection/lag?tagStateId=${encodeURIComponent(`${tag}:${TEST_TAG_STATE_PROJECTOR}`)}&serviceId=${encodeURIComponent(serviceId)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.json()).toMatchObject({
      tagStateId: `${tag}:${TEST_TAG_STATE_PROJECTOR}`,
      checkpointSuid: "",
      headSuid: event.suid,
      behindEvents: 1,
      safeWindowMs: expect.any(Number),
    });
    const observer = postgresStore();
    await observer.initialize();
    expect(await observer.readProjectionCheckpoint(SERVICE_ID, projectionIdFor(identity))).toBeUndefined();
  });

  it("SDT-G89 AC9(b): maps zod-invalid checkpoint state to ProjectionCheckpointCorruption", async () => {
    const composed = composeRuntime(meetingRoomDomain, meetingRoomRuntimeConfig);
    const reservationProjector = composed.projectors.resolve("ReservationProjector");
    if (reservationProjector === undefined) throw new Error("ReservationProjector missing from composed runtime");
    const registry = new ProjectorRegistry([reservationProjector]);
    const tag = "reservation:g89-checkpoint";
    const identity = tagStateIdentityFrom(`${tag}:ReservationProjector`, registry).value!;
    const checkpoint: ProjectionCheckpoint = {
      serviceId: "g89-checkpoint-service",
      projectionId: projectionIdFor(identity),
      lastSuid: "g89-suid",
      stateJson: JSON.stringify({ status: "reserved" }),
      version: 1,
      updatedAt: 0,
    };
    const store = {
      initialize: async (): Promise<void> => undefined,
      readAllEvents: async (): Promise<[]> => [],
      currentLagBound: async (): Promise<number> => 0,
      listProjectionTags: async (): Promise<string[]> => [tag],
      readProjectionCheckpoint: async (): Promise<ProjectionCheckpoint> => checkpoint,
      advanceProjectionCheckpoint: async (): Promise<boolean> => true,
      projectionLag: async () => ({
        serviceId: checkpoint.serviceId,
        projectionId: checkpoint.projectionId,
        tag,
        checkpointSuid: checkpoint.lastSuid,
        headSuid: checkpoint.lastSuid,
        behindEvents: 0,
      }),
      appendDeliveryIncident: async (): Promise<void> => undefined,
    } as unknown as PipelineStore;
    const runtime = new ProjectionRuntime(store, registry);
    await expect(runtime.catchUp(checkpoint.serviceId, identity, 0)).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof ProjectionCheckpointCorruption)) return false;
      expect(error.cause).toBeDefined();
      return true;
    });
  });

  it("runs the scheduled polling entry point through every registered projection", async () => {
    const serviceId = unique("scheduled-poll-service");
    const tag = `orders:${unique("scheduled-poll")}`;
    const identity = identityFor(tag);
    const clock = mutableClock(Date.now());
    const event = message(
      serviceId,
      unique("scheduled-poll-event"),
      `suid-scheduled-${crypto.randomUUID()}`,
      tag,
      clock.clock.now() - 100,
    );

    await withPostgresStore(async (store) => {
      await injectDelivery(store, event, clock.clock);
      clock.set(clock.clock.now() + 1_000_000);
      const results = await pollLiveProjections(
        { POSTGRES_URL: (env as unknown as WorkerEnv).POSTGRES_URL },
        { store, clock: clock.clock, serviceId },
      );
      const target = results.find((result) => result.checkpoint?.projectionId === projectionIdFor(identity));
      expect(target).toMatchObject({ appliedEvents: 1 });
      // A checkpoint covers the service-wide SUID source, so an older test
      // delivery for another tag may advance its SUID beyond this event. The
      // registered reducer state is the tag-specific oracle.
      const checkpoint = await store.readProjectionCheckpoint(serviceId, projectionIdFor(identity));
      expect(checkpoint).toMatchObject({ version: 1 });
      expect(stateEvents(checkpoint!).map(({ eventId, suid }) => ({ eventId, suid }))).toEqual([
        { eventId: event.eventId, suid: event.suid },
      ]);
    });
  });
});
