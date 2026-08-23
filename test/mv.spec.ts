import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { processDownstreamDelivery } from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import type { DownstreamOutboxMessage, PipelineClock } from "../packages/dcb-runtime/src/downstream/types";
import {
  MaterializedViewOperationError,
  MaterializedViewRuntime,
  type MaterializedViewDefinition,
  materializedViewId,
} from "../packages/dcb-runtime/src/mv";
import { PUBLISHED_SAFE_WINDOW_MS } from "../packages/dcb-runtime/src/projection/ProjectionRuntime";
import type { Env as WorkerEnv } from "../packages/dcb-runtime/src/index";
import { PostgresEventStore } from "../packages/dcb-runtime/src/store/PostgresEventStore";
import type { ProjectionStore } from "../packages/dcb-runtime/src/store/types";
import { g32Message, g32SuidAt } from "./helpers/g32-fixtures";

const PAYLOAD = JSON.stringify({ fixture: "mv" });

interface EventListState {
  eventIds: string[];
  suids: string[];
}

const EVENT_LIST_VIEW: MaterializedViewDefinition<EventListState> = {
  id: "test-event-list-v1",
  initialState: () => ({ eventIds: [], suids: [] }),
  apply: (state, event) => ({
    eventIds: [...state.eventIds, event.eventId],
    suids: [...state.suids, event.suid],
  }),
  serializeState: (state) => JSON.stringify(state),
  deserializeState: (stateJson) => {
    const parsed: unknown = JSON.parse(stateJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("invalid event-list materialized-view state");
    }
    const record = parsed as Record<string, unknown>;
    const eventIds = record.eventIds;
    const suids = record.suids;
    if (
      !Array.isArray(eventIds) || !eventIds.every((value): value is string => typeof value === "string")
      || !Array.isArray(suids) || !suids.every((value): value is string => typeof value === "string")
    ) {
      throw new Error("invalid event-list materialized-view state");
    }
    return {
      eventIds: [...eventIds],
      suids: [...suids],
    };
  },
  version: (state) => state.eventIds.length,
};

function unique(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function mutableClock(nowMs: number): { clock: PipelineClock; set(now: number): void } {
  let now = nowMs;
  return { clock: { now: () => now }, set: (next) => { now = next; } };
}

function sourceSuid(seed: string): string {
  const ordinal = Number(/(\d+)$/.exec(seed)?.[1] ?? "0");
  return g32SuidAt(1_000 + ordinal, seed);
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
    allocatorLineageId: "test-mv-lineage",
    tag,
    attemptId: `${eventId}-attempt`,
    eventId,
    suid: sourceSuid(suid),
    payload: PAYLOAD,
    eventTags: [tag],
    eventType: "MvFixtureEvent",
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

async function injectDelivery(
  store: PostgresEventStore,
  entry: DownstreamOutboxMessage,
  clock: PipelineClock,
): Promise<void> {
  await processDownstreamDelivery(entry, { POSTGRES_URL: (env as unknown as WorkerEnv).POSTGRES_URL }, { store, clock });
}

function failingAdvanceStore(store: PostgresEventStore): ProjectionStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === "advanceProjectionCheckpoint") {
        return async () => false;
      }
      return Reflect.get(target, property, receiver);
    },
  }) as ProjectionStore;
}

describe("SDT-G10 materialized views", () => {
  it("builds and follows the global SUID source through SafeWindow under out-of-order delivery", async () => {
    const serviceId = unique("mv-safe-window-service");
    const higherTag = `orders:${unique("mv-safe-window-higher")}`;
    const lowerTag = `inventory:${unique("mv-safe-window-lower")}`;
    const clock = mutableClock(1_000);
    const higher = message(serviceId, unique("higher"), "suid-00000000000000000000000000000002", higherTag, 900);
    const lower = message(serviceId, unique("lower"), "suid-00000000000000000000000000000001", lowerTag, 950);

    await withPostgresStore(async (store) => {
      await injectDelivery(store, higher, clock.clock);
      clock.set(1_050);
      await injectDelivery(store, lower, clock.clock);

      const runtime = new MaterializedViewRuntime(store);
      const beforeWindow = await runtime.build(serviceId, EVENT_LIST_VIEW, 20_999);
      expect(beforeWindow.dynamicLagBoundMs).toBe(100);
      expect(beforeWindow.safeWindowMs).toBe(PUBLISHED_SAFE_WINDOW_MS);
      expect(beforeWindow.advancedSourceEvents).toBe(0);
      expect(beforeWindow.state).toEqual({ eventIds: [], suids: [] });

      const converged = await runtime.follow(serviceId, EVENT_LIST_VIEW, 21_050);
      expect(converged.advancedSourceEvents).toBe(2);
      expect(converged.appliedEvents).toBe(2);
      expect(converged.checkpoint).toMatchObject({ lastSuid: higher.suid, version: 2 });
      expect(converged.state).toEqual({
        eventIds: [lower.eventId, higher.eventId],
        suids: [lower.suid, higher.suid],
      });

      const repeat = await runtime.follow(serviceId, EVENT_LIST_VIEW, 21_050);
      expect(repeat).toMatchObject({ advancedSourceEvents: 0, appliedEvents: 0 });
      expect(repeat.state).toEqual(converged.state);
    });
  });

  it("persists state and checkpoint together across a restart crash boundary without gaps or double-apply", async () => {
    const serviceId = unique("mv-restart-service");
    const tag = `orders:${unique("mv-restart")}`;
    const clock = mutableClock(1_000);
    const events = [
      message(serviceId, unique("one"), "suid-00000000000000000000000000000001", tag, 900),
      message(serviceId, unique("two"), "suid-00000000000000000000000000000002", tag, 900),
      message(serviceId, unique("three"), "suid-00000000000000000000000000000003", tag, 900),
    ];

    await withPostgresStore(async (store) => {
      for (const event of events) {
        await injectDelivery(store, event, clock.clock);
      }
      const runtime = new MaterializedViewRuntime(store);
      await expect(runtime.build(serviceId, EVENT_LIST_VIEW, 21_100, {
        afterCheckpoint: (event) => {
          if (event.suid === events[0]!.suid) {
            throw new Error("injected crash after materialized-view checkpoint");
          }
        },
      })).rejects.toThrow("injected crash after materialized-view checkpoint");

      const viewId = materializedViewId(EVENT_LIST_VIEW.id);
      expect(await store.readProjectionCheckpoint(serviceId, viewId)).toMatchObject({
        lastSuid: events[0]!.suid,
        version: 1,
      });

      const restartedStore = postgresStore();
      await restartedStore.initialize();
      const restarted = new MaterializedViewRuntime(restartedStore);
      const resumed = await restarted.follow(serviceId, EVENT_LIST_VIEW, 21_100);
      expect(resumed).toMatchObject({ advancedSourceEvents: 2, appliedEvents: 2 });
      expect(resumed.state).toEqual({
        eventIds: events.map((event) => event.eventId),
        suids: events.map((event) => event.suid),
      });
      expect((await restarted.follow(serviceId, EVENT_LIST_VIEW, 21_100))).toMatchObject({
        advancedSourceEvents: 0,
        appliedEvents: 0,
      });

      // C# Event.ServiceId is varchar(64); keep the generated test service
      // inside that durable record boundary too.
      const beforeFaultServiceId = unique("mv-before");
      const beforeFaultEvent = message(
        beforeFaultServiceId,
        unique("before-checkpoint"),
        "suid-00000000000000000000000000000001",
        `orders:${unique("mv-before-checkpoint")}`,
        900,
      );
      await injectDelivery(restartedStore, beforeFaultEvent, clock.clock);
      await expect(restarted.build(beforeFaultServiceId, EVENT_LIST_VIEW, 21_100, {
        beforeCheckpoint: () => { throw new Error("injected crash before materialized-view checkpoint"); },
      })).rejects.toThrow("injected crash before materialized-view checkpoint");
      expect(await restartedStore.readProjectionCheckpoint(beforeFaultServiceId, materializedViewId(EVENT_LIST_VIEW.id)))
        .toMatchObject({ lastSuid: "", version: 0 });
      const recoveredBeforeCheckpoint = await restarted.follow(beforeFaultServiceId, EVENT_LIST_VIEW, 21_100);
      expect(recoveredBeforeCheckpoint).toMatchObject({ advancedSourceEvents: 1, appliedEvents: 1 });
      expect(recoveredBeforeCheckpoint.state).toEqual({
        eventIds: [beforeFaultEvent.eventId],
        suids: [beforeFaultEvent.suid],
      });
    });
  });

  it("rebuilds deterministically over the same SUID range, then resets and promotes the durable candidate", async () => {
    const serviceId = unique("mv-determinism-service");
    const tag = `orders:${unique("mv-determinism")}`;
    const clock = mutableClock(1_000);
    const events = [
      message(serviceId, unique("gamma"), "suid-00000000000000000000000000000001", tag, 900),
      message(serviceId, unique("alpha"), "suid-00000000000000000000000000000002", tag, 900),
      message(serviceId, unique("beta"), "suid-00000000000000000000000000000003", tag, 900),
    ];

    await withPostgresStore(async (store) => {
      for (const event of events) {
        await injectDelivery(store, event, clock.clock);
      }
      const runtime = new MaterializedViewRuntime(store);
      const followed = await runtime.build(serviceId, EVENT_LIST_VIEW, 21_100);
      const rebuilt = await runtime.rebuild(serviceId, EVENT_LIST_VIEW, "deterministic", 21_100);
      expect(rebuilt.result.state).toEqual(followed.state);
      expect(rebuilt.result.checkpoint).toMatchObject({
        lastSuid: followed.checkpoint.lastSuid,
        stateJson: followed.checkpoint.stateJson,
        version: followed.checkpoint.version,
      });

      const reset = await runtime.reset(serviceId, EVENT_LIST_VIEW, 21_101);
      expect(reset).toMatchObject({
        checkpoint: { lastSuid: "", version: 0 },
        state: { eventIds: [], suids: [] },
      });
      const promoted = await runtime.promote(serviceId, EVENT_LIST_VIEW, "deterministic", 21_102);
      expect(promoted.state).toEqual(followed.state);
      expect(promoted.checkpoint).toMatchObject({ lastSuid: followed.checkpoint.lastSuid, version: 3 });
    });
  });

  it("rejects a second reset as a typed no-op and leaves durable state unchanged", async () => {
    const serviceId = unique("mv-reset-noop-service");
    const clock = mutableClock(1_000);
    const event = message(
      serviceId,
      unique("mv-reset-noop-event"),
      "suid-00000000000000000000000000000001",
      `orders:${unique("mv-reset-noop")}`,
      900,
    );

    await withPostgresStore(async (store) => {
      await injectDelivery(store, event, clock.clock);
      const runtime = new MaterializedViewRuntime(store);
      await runtime.build(serviceId, EVENT_LIST_VIEW, 21_100);
      await runtime.reset(serviceId, EVENT_LIST_VIEW, 21_101);

      const viewId = materializedViewId(EVENT_LIST_VIEW.id);
      const beforeRejectedReset = await store.readProjectionCheckpoint(serviceId, viewId);
      const stateBeforeRejectedReset = await runtime.read(serviceId, EVENT_LIST_VIEW);
      expect(beforeRejectedReset).toMatchObject({ lastSuid: "", version: 0 });
      expect(stateBeforeRejectedReset?.state).toEqual({ eventIds: [], suids: [] });

      await expect(runtime.reset(serviceId, EVENT_LIST_VIEW, 21_102)).rejects.toMatchObject({
        name: MaterializedViewOperationError.name,
        operation: "reset",
        code: "MV_RESET_NOTHING_TO_RESET",
      });
      expect(await store.readProjectionCheckpoint(serviceId, viewId)).toEqual(beforeRejectedReset);
      expect(await runtime.read(serviceId, EVENT_LIST_VIEW)).toEqual(stateBeforeRejectedReset);
    });
  });

  it("rejects a second promote as a typed no-op and leaves the promoted checkpoint unchanged", async () => {
    const serviceId = unique("mv-promote-noop-service");
    const tag = `orders:${unique("mv-promote-noop")}`;
    const clock = mutableClock(1_000);
    const first = message(serviceId, unique("mv-promote-first"), "suid-00000000000000000000000000000001", tag, 900);
    const second = message(serviceId, unique("mv-promote-second"), "suid-00000000000000000000000000000002", tag, 900);

    await withPostgresStore(async (store) => {
      await injectDelivery(store, first, clock.clock);
      const runtime = new MaterializedViewRuntime(store);
      await runtime.build(serviceId, EVENT_LIST_VIEW, 21_100);

      clock.set(1_001);
      await injectDelivery(store, second, clock.clock);
      await runtime.rebuild(serviceId, EVENT_LIST_VIEW, "promote-noop", 21_101);
      await runtime.promote(serviceId, EVENT_LIST_VIEW, "promote-noop", 21_102);

      const viewId = materializedViewId(EVENT_LIST_VIEW.id);
      const beforeRejectedPromote = await store.readProjectionCheckpoint(serviceId, viewId);
      const stateBeforeRejectedPromote = await runtime.read(serviceId, EVENT_LIST_VIEW);
      expect(beforeRejectedPromote).toMatchObject({ lastSuid: second.suid, version: 2 });
      expect(stateBeforeRejectedPromote?.state).toEqual({
        eventIds: [first.eventId, second.eventId],
        suids: [first.suid, second.suid],
      });

      await expect(runtime.promote(serviceId, EVENT_LIST_VIEW, "promote-noop", 21_103)).rejects.toMatchObject({
        name: MaterializedViewOperationError.name,
        operation: "promote",
        code: "MV_PROMOTE_NOTHING_TO_PROMOTE",
      });
      expect(await store.readProjectionCheckpoint(serviceId, viewId)).toEqual(beforeRejectedPromote);
      expect(await runtime.read(serviceId, EVENT_LIST_VIEW)).toEqual(stateBeforeRejectedPromote);
    });
  });

  it("fails closed with typed errors rather than acknowledging unavailable build, rebuild, reset, or promote operations", async () => {
    const serviceId = unique("mv-fail-closed-service");
    await withPostgresStore(async (store) => {
      const refusingRuntime = new MaterializedViewRuntime(failingAdvanceStore(store));
      await expect(refusingRuntime.build(serviceId, EVENT_LIST_VIEW, 21_100)).rejects.toMatchObject({
        name: MaterializedViewOperationError.name,
        operation: "build",
        code: "MV_BUILD_CONFLICT",
      });
      expect(await store.readProjectionCheckpoint(serviceId, materializedViewId(EVENT_LIST_VIEW.id))).toBeUndefined();

      const durableRuntime = new MaterializedViewRuntime(store);
      await expect(durableRuntime.reset(serviceId, EVENT_LIST_VIEW, 21_100)).rejects.toMatchObject({
        name: MaterializedViewOperationError.name,
        operation: "reset",
        code: "MV_RESET_MISSING",
      });
      await expect(durableRuntime.promote(serviceId, EVENT_LIST_VIEW, "missing", 21_100)).rejects.toMatchObject({
        name: MaterializedViewOperationError.name,
        operation: "promote",
        code: "MV_PROMOTE_CANDIDATE_MISSING",
      });

      await durableRuntime.rebuild(serviceId, EVENT_LIST_VIEW, "once", 21_100);
      await expect(durableRuntime.rebuild(serviceId, EVENT_LIST_VIEW, "once", 21_100)).rejects.toMatchObject({
        name: MaterializedViewOperationError.name,
        operation: "rebuild",
        code: "MV_REBUILD_CANDIDATE_EXISTS",
      });
    });
  });
});
