import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

// Vite's raw asset loader keeps this fixture tied to the committed, versioned
// migration. The test harness does not apply the second D1 binding's Wrangler
// migration automatically; production still uses `wrangler d1 migrations
// apply`, never runtime DDL.
// @ts-expect-error Vite raw asset import
import migration from "../migrations/mv/0001_materialized_views.sql?raw";

import { defineRowMaterializer, type MaterializedViewRowMaterializer } from "@sekiban/dcb-core";
import {
  D1MaterializedViewStore,
  MaterializedViewCasError,
  MaterializedViewPromotionCasError,
  MaterializedViewStoreError,
} from "../packages/dcb-runtime/src/d1-mv";
import { MaterializedViewCatchUpRuntime } from "../packages/dcb-runtime/src/mv/MaterializedViewCatchUp";
import { readRowsFromBacking, selectQueryBacking } from "../packages/dcb-runtime/src/query/ProjectionQueryStore";
import type { ProjectionStore, StoredEvent } from "../packages/dcb-runtime/src/store/types";

interface Event {
  suid: string;
  eventId: string;
  count: number;
}

const MATERIALIZER: MaterializedViewRowMaterializer<Event> = defineRowMaterializer({
  id: "g19-d1-events-v1",
  version: 1,
  indexDescriptors: [
    { id: "event-id", valueType: "text", value: (_row, event) => event.eventId },
    { id: "count", valueType: "integer", value: (row) => (row as { count: number }).count },
  ],
  materialize: (event) => ({
    rowUpserts: [{ rowKey: event.eventId, value: { eventId: event.eventId, count: event.count } }],
  }),
});

function database(): D1Database {
  const binding = (env as unknown as { D1_MV?: D1Database }).D1_MV;
  if (binding === undefined) throw new Error("D1_MV binding is required; the two-binding Miniflare lane must not silently skip");
  return binding;
}

function store(): D1MaterializedViewStore {
  return new D1MaterializedViewStore(database());
}

function event(suid: string, eventId: string, count: number): Event {
  return { suid, eventId, count };
}

function storedEvent(suid: string, eventId: string, lastArrivedAt: number): StoredEvent {
  return {
    serviceId: "g19-source",
    eventId,
    suid,
    payload: btoa(JSON.stringify({ eventId })),
    eventTags: ["g19:events"],
    firstArrivedAt: lastArrivedAt,
    lastArrivedAt,
    maxDeliveryLagMs: 0,
    arrivals: [],
  };
}

function sourceFor(events: readonly StoredEvent[], lagBoundMs: number, incidents: unknown[]): ProjectionStore {
  return {
    readAllEvents: async (_serviceId, since) => events.filter((candidate) => candidate.suid > since),
    currentLagBound: async () => lagBoundMs,
    listProjectionTags: async () => [],
    readProjectionCheckpoint: async () => undefined,
    advanceProjectionCheckpoint: async () => false,
    projectionLag: async () => ({ serviceId: "g19-source", projectionId: "g19", tag: "g19:events", checkpointSuid: "", headSuid: "", behindEvents: 0 }),
    appendDeliveryIncident: async (incident) => { incidents.push(incident); },
  };
}

const STORED_MATERIALIZER: MaterializedViewRowMaterializer<StoredEvent> = defineRowMaterializer({
  id: "g19-catch-up-v1",
  version: 1,
  indexDescriptors: [{ id: "event-id", valueType: "text", value: (_row, incoming) => incoming.eventId }],
  materialize: (incoming) => ({
    rowUpserts: [{ rowKey: incoming.eventId, value: { eventId: incoming.eventId }, sourceSuid: incoming.suid }],
  }),
});

describe("SDT-G19 D1 materialized-view store", () => {
  beforeAll(async () => {
    const migrationText = migration as string;
    const statements = migrationText.replace(/^\s*--.*$/gm, "")
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    await database().batch(statements.map((statement) => database().prepare(statement)));
  });

  it("atomically rolls back rows, indexes, and checkpoint on a stale CAS", async () => {
    const serviceId = `g19-atomic-${crypto.randomUUID()}`;
    const mv = store();
    await mv.initialize();
    await mv.createActive({ serviceId, viewId: MATERIALIZER.id, definitionVersion: MATERIALIZER.version, updatedAt: 1_000 });
    const first = event("suid-1", "event-1", 1);
    await mv.applyMutationsAndAdvanceCheckpoint({
      serviceId,
      viewId: MATERIALIZER.id,
      generation: 0,
      expectedLastSuid: null,
      lastSuid: first.suid,
      definitionVersion: MATERIALIZER.version,
      updatedAt: 1_001,
      mutations: MATERIALIZER.plan(first),
    });
    const before = {
      instance: await mv.readActive(serviceId, MATERIALIZER.id),
      rows: await mv.readRows(serviceId, MATERIALIZER.id),
      indexes: await mv.readIndexEntries(serviceId, MATERIALIZER.id),
    };
    const second = event("suid-2", "event-2", 2);
    await expect(mv.applyMutationsAndAdvanceCheckpoint({
      serviceId,
      viewId: MATERIALIZER.id,
      generation: 0,
      expectedLastSuid: "stale-suid",
      lastSuid: second.suid,
      definitionVersion: MATERIALIZER.version,
      updatedAt: 1_002,
      mutations: MATERIALIZER.plan(second),
    })).rejects.toBeInstanceOf(MaterializedViewCasError);
    expect(await mv.readActive(serviceId, MATERIALIZER.id)).toEqual(before.instance);
    expect(await mv.readRows(serviceId, MATERIALIZER.id)).toEqual(before.rows);
    expect(await mv.readIndexEntries(serviceId, MATERIALIZER.id)).toEqual(before.indexes);
  });

  it("keeps active generation isolated during rebuild and switches it by CAS promotion", async () => {
    const serviceId = `g19-generation-${crypto.randomUUID()}`;
    const mv = store();
    await mv.initialize();
    await mv.createActive({ serviceId, viewId: MATERIALIZER.id, definitionVersion: MATERIALIZER.version, updatedAt: 2_000 });
    const first = event("suid-1", "event-1", 1);
    await mv.applyMutationsAndAdvanceCheckpoint({
      serviceId, viewId: MATERIALIZER.id, generation: 0, expectedLastSuid: null,
      lastSuid: first.suid, definitionVersion: MATERIALIZER.version, updatedAt: 2_001, mutations: MATERIALIZER.plan(first),
    });
    const candidate = await mv.createCandidate({
      serviceId, viewId: MATERIALIZER.id, generation: 1, definitionVersion: MATERIALIZER.version, updatedAt: 2_002,
    });
    const second = event("suid-2", "event-2", 2);
    await mv.applyMutationsAndAdvanceCheckpoint({
      serviceId, viewId: MATERIALIZER.id, generation: candidate.generation, expectedLastSuid: null,
      lastSuid: second.suid, definitionVersion: MATERIALIZER.version, updatedAt: 2_003, mutations: MATERIALIZER.plan(second),
    });
    expect((await mv.readActive(serviceId, MATERIALIZER.id))?.generation).toBe(0);
    expect((await mv.readRows(serviceId, MATERIALIZER.id))?.map((row) => row.rowKey)).toEqual(["event-1"]);
    await expect(mv.promoteGeneration({
      serviceId, viewId: MATERIALIZER.id, candidateGeneration: candidate.generation,
      expectedActiveGeneration: 99, updatedAt: 2_004,
    })).rejects.toBeInstanceOf(MaterializedViewPromotionCasError);
    expect((await mv.readActive(serviceId, MATERIALIZER.id))?.generation).toBe(0);
    await mv.promoteGeneration({
      serviceId, viewId: MATERIALIZER.id, candidateGeneration: candidate.generation,
      expectedActiveGeneration: 0, updatedAt: 2_005,
    });
    expect((await mv.readActive(serviceId, MATERIALIZER.id))?.generation).toBe(1);
    expect((await mv.readRows(serviceId, MATERIALIZER.id))?.map((row) => row.rowKey)).toEqual(["event-2"]);
  });

  it("leaves the active generation untouched when a candidate rebuild crashes mid-follow", async () => {
    const serviceId = `g19-crash-${crypto.randomUUID()}`;
    const incidents: unknown[] = [];
    const source = sourceFor([
      storedEvent("suid-1", "event-1", 1_000),
      storedEvent("suid-2", "event-2", 1_001),
    ], 0, incidents);
    const mv = store();
    await mv.initialize();
    await mv.createActive({ serviceId, viewId: STORED_MATERIALIZER.id, definitionVersion: 1, updatedAt: 4_000 });
    const runtime = new MaterializedViewCatchUpRuntime(source, mv);
    await expect(runtime.rebuild(serviceId, STORED_MATERIALIZER, 50_000, "crash-rebuild", {
      beforeApply: () => { throw new Error("injected candidate crash"); },
    })).rejects.toThrow("injected candidate crash");
    expect((await mv.readActive(serviceId, STORED_MATERIALIZER.id))?.generation).toBe(0);
    expect(await mv.readRows(serviceId, STORED_MATERIALIZER.id)).toEqual([]);
    expect((await mv.readInstance(serviceId, STORED_MATERIALIZER.id, 1))?.status).toBe("candidate");
  });

  it("orders and pages rows through a typed D1 MV backing without request SQL paths", async () => {
    const serviceId = `g19-query-${crypto.randomUUID()}`;
    const mv = store();
    await mv.initialize();
    await mv.createActive({ serviceId, viewId: MATERIALIZER.id, definitionVersion: 1, updatedAt: 3_000 });
    for (const [index, item] of [event("suid-1", "event-b", 2), event("suid-2", "event-a", 1)].entries()) {
      await mv.applyMutationsAndAdvanceCheckpoint({
        serviceId, viewId: MATERIALIZER.id, generation: 0,
        expectedLastSuid: index === 0 ? null : `suid-${index}`,
        lastSuid: item.suid, definitionVersion: 1, updatedAt: 3_001 + index, mutations: MATERIALIZER.plan(item),
      });
    }
    const selection = selectQueryBacking({ backing: "d1-mv", memory: {
      readAllEvents: async () => [], currentLagBound: async () => 0, listProjectionTags: async () => [],
      readProjectionCheckpoint: async () => undefined,
    }, materializedView: mv });
    expect(selection.backing).toBe("d1-mv");
    if (selection.backing !== "d1-mv") throw new Error("D1 MV backing selection was not chosen");
    const page = await selection.store.queryRows(serviceId, MATERIALIZER.id, { indexId: "count", valueType: "integer", limit: 1, offset: 0 });
    expect(page.map((row) => row.rowKey)).toEqual(["event-a"]);
  });

  it("fails closed when the MV binding has not been initialized", async () => {
    const uninitialized = new D1MaterializedViewStore(database());
    await expect(uninitialized.readActive("missing", MATERIALIZER.id)).rejects.toMatchObject({
      name: MaterializedViewStoreError.name,
      code: "MV_STORE_NOT_INITIALIZED",
    });
  });

  it("applies only SafeWindow-safe events and stops at the first unsafe SUID", async () => {
    const serviceId = `g19-window-${crypto.randomUUID()}`;
    const incidents: unknown[] = [];
    const nowMs = 50_000;
    const source = sourceFor([
      storedEvent("suid-1", "event-1", 1_000),
      storedEvent("suid-2", "event-2", 40_000),
    ], 0, incidents);
    const mv = store();
    await mv.initialize();
    const runtime = new MaterializedViewCatchUpRuntime(source, mv);
    const result = await runtime.build(serviceId, STORED_MATERIALIZER, nowMs);
    expect(result.appliedEvents).toBe(1);
    expect(result.indeterminate).toBe(false);
    expect((await mv.readActive(serviceId, STORED_MATERIALIZER.id))?.lastSuid).toBe("suid-1");
    expect(incidents).toEqual([]);
  });

  it("records ORDER_VIOLATION and fails closed when the source is not strictly SUID ordered", async () => {
    const serviceId = `g19-order-${crypto.randomUUID()}`;
    const incidents: unknown[] = [];
    const source = sourceFor([
      storedEvent("suid-2", "event-2", 1_000),
      storedEvent("suid-1", "event-1", 1_001),
    ], 0, incidents);
    const mv = store();
    await mv.initialize();
    const runtime = new MaterializedViewCatchUpRuntime(source, mv);
    await expect(runtime.build(serviceId, STORED_MATERIALIZER, 50_000)).rejects.toThrow(/strictly SUID ordered/);
    expect(incidents).toEqual([expect.objectContaining({ classification: "ORDER_VIOLATION" })]);
    expect(await mv.readRows(serviceId, STORED_MATERIALIZER.id)).toEqual([]);
  });

  it("returns an indeterminate result above the published SafeWindow ceiling without applying events", async () => {
    const serviceId = `g19-ceiling-${crypto.randomUUID()}`;
    const incidents: unknown[] = [];
    const source = sourceFor([storedEvent("suid-1", "event-1", 1_000)], 120_001, incidents);
    const mv = store();
    await mv.initialize();
    const runtime = new MaterializedViewCatchUpRuntime(source, mv);
    const result = await runtime.build(serviceId, STORED_MATERIALIZER, 50_000);
    expect(result.indeterminate).toBe(true);
    expect(result.appliedEvents).toBe(0);
    expect(await mv.readRows(serviceId, STORED_MATERIALIZER.id)).toEqual([]);
  });

  it("keeps the existing memory backing functional while the MV backing is opt-in", async () => {
    const selection = selectQueryBacking({
      backing: "memory",
      memory: {
        readAllEvents: async () => [],
        currentLagBound: async () => 0,
        listProjectionTags: async () => ["g19:events"],
        readProjectionCheckpoint: async () => ({
          serviceId: "memory", projectionId: "tag-state:g19:events:g19-projector", lastSuid: "suid-1",
          stateJson: JSON.stringify([{ eventId: "event-1", suid: "suid-1", payload: "cA==" }]), version: 1, updatedAt: 1,
        }),
      },
    });
    const rows = await readRowsFromBacking(selection, "memory", "GetG19ListQuery", {
      queryType: "GetG19ListQuery", endpoint: "list-query", tagGroup: "g19", tagProjector: "g19-projector", enabled: true,
    });
    expect(rows).toEqual([{ eventId: "event-1", suid: "suid-1", payload: "cA==" }]);
  });
});
