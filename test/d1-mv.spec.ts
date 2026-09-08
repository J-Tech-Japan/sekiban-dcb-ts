import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

// Vite's raw asset loader keeps this fixture tied to the committed, versioned
// migration. The test harness does not apply the second D1 binding's Wrangler
// migration automatically; production still uses `wrangler d1 migrations
// apply`, never runtime DDL.
// @ts-expect-error Vite raw asset import
import migration from "../migrations/mv/0001_materialized_views.sql?raw";
// @ts-expect-error Vite raw asset import
import unsafeMigration from "../migrations/mv/0002_unsafe_window_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration imports.
import hardeningMigration from "../migrations/mv/0003_checkpoint_ahead_hardening.sql?raw";
// @ts-expect-error Vite raw migration imports.
import unsafeFailureMigration from "../migrations/mv/0004_unsafe_window_failure_findings.sql?raw";
// @ts-expect-error Vite raw migration imports.
import g31WaitReceiptMigration from "../migrations/mv/0005_g31_wait_receipts.sql?raw";
// @ts-expect-error Vite raw migration imports.
import g31WaitPoisonMigration from "../migrations/mv/0006_g31_wait_target_poison.sql?raw";
// @ts-expect-error Vite raw migration imports.
import orderingQuarantineMigration from "../migrations/mv/0007_g69_ordering_quarantine.sql?raw";
// @ts-expect-error Vite raw migration imports.
import rebuildVerificationMigration from "../migrations/mv/0008_g69_rebuild_verification.sql?raw";
// @ts-expect-error Vite raw migration imports.
import rebuildProofMigration from "../migrations/mv/0009_g69_rebuild_proof.sql?raw";

import { defineRowMaterializer, type MaterializedViewRowMaterializer } from "@sekiban/dcb-core";
import {
  D1MaterializedViewStore,
  MaterializedViewCasError,
  MaterializedViewPatchError,
  MaterializedViewPromotionCasError,
  MaterializedViewStoreError,
} from "../packages/dcb-runtime/src/d1-mv";
import { handleSerializedQuery } from "../packages/dcb-runtime/src/http/SerializedQueryWorker";
import { TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/http/testServiceId";
import { MaterializedViewCatchUpRuntime } from "../packages/dcb-runtime/src/mv/MaterializedViewCatchUp";
import { TEST_TAG_STATE_PROJECTOR } from "../packages/dcb-runtime/src/projection/ProjectorRegistry";
import { projectionIdFor } from "../packages/dcb-runtime/src/projection/ProjectionRuntime";
import { readRowsFromBacking, selectQueryBacking, type QueryProjectionStore } from "../packages/dcb-runtime/src/query/ProjectionQueryStore";
import type { ProjectionStore, StoredEvent } from "../packages/dcb-runtime/src/store/types";
import { reservationMaterializer } from "../samples/meeting-room/src/d1-mv";
import { meetingRoomDomain, meetingRoomRuntimeConfig } from "../samples/meeting-room/src/domain";
import { composeRuntime } from "../packages/dcb-runtime/src/composition";
import { G32_FIXTURE_TIMESTAMP, g32Suid } from "./helpers/g32-fixtures";

interface Event {
  suid: string;
  eventId: string;
  count: number;
}

const TEST_PROJECTOR = TEST_TAG_STATE_PROJECTOR;

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

function canonicalSuid(value: string): string {
  return g32Suid(value);
}

function event(suid: string, eventId: string, count: number): Event {
  return { suid: canonicalSuid(suid), eventId, count };
}

function patchEvent(
  suid: string,
  eventId: string,
  kind: PatchEvent["kind"],
  rowKey: string,
  value?: string,
): PatchEvent {
  return { suid: canonicalSuid(suid), eventId, kind, rowKey, ...(value === undefined ? {} : { value }) };
}

interface PatchEvent {
  suid: string;
  eventId: string;
  kind: "seed" | "cancel" | "rename";
  rowKey: string;
  value?: string;
}

const PATCH_MATERIALIZER: MaterializedViewRowMaterializer<PatchEvent> = defineRowMaterializer({
  id: "g20-patch-oracle-v1",
  version: 1,
  indexDescriptors: [{
    id: "status",
    valueType: "text",
    value: (row) => (row as { status?: unknown }).status,
  }],
  materialize: (incoming) => {
    if (incoming.kind === "seed") {
      return { rowUpserts: [{ rowKey: incoming.rowKey, value: { status: "reserved", value: incoming.value ?? "old" } }] };
    }
    if (incoming.kind === "cancel") {
      return {
        rowPatches: [{
          kind: "json_patch",
          rowKey: incoming.rowKey,
          patch: { status: "cancelled" },
          indexEntries: [{ indexId: "status", value: "cancelled", rowKey: incoming.rowKey }],
        }],
      };
    }
    return {
      rowPatches: [{
        kind: "json_patch",
        rowKey: incoming.rowKey,
        patch: { value: incoming.value ?? "new" },
      }],
    };
  },
});

function storedEvent(suid: string, eventId: string, lastArrivedAt: number): StoredEvent {
  return {
    serviceId: "g19-source",
    id: eventId,
    eventId,
    sortableUniqueId: canonicalSuid(suid),
    suid: canonicalSuid(suid),
    payload: JSON.stringify({ eventId }),
    tags: ["g19:events"],
    eventTags: ["g19:events"],
    eventType: "G19StoredFixtureEvent",
    timestamp: G32_FIXTURE_TIMESTAMP,
    causationId: null,
    correlationId: null,
    executedUser: null,
    provenance: "g32",
    firstArrivedAt: lastArrivedAt,
    lastArrivedAt,
    maxDeliveryLagMs: 0,
    arrivals: [],
  };
}

function storedPayloadEvent(
  serviceId: string,
  suid: string,
  eventId: string,
  payload: Record<string, unknown>,
  eventTags: readonly string[],
  lastArrivedAt = 1_000,
): StoredEvent {
  return {
    serviceId,
    id: eventId,
    eventId,
    sortableUniqueId: canonicalSuid(suid),
    suid: canonicalSuid(suid),
    payload: JSON.stringify(payload),
    tags: [...eventTags],
    eventTags: [...eventTags],
    eventType: typeof payload.eventType === "string" ? payload.eventType : "G19PayloadFixtureEvent",
    timestamp: G32_FIXTURE_TIMESTAMP,
    causationId: null,
    correlationId: null,
    executedUser: null,
    provenance: "g32",
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
    const statements = [migration as string, unsafeMigration as string, hardeningMigration as string, unsafeFailureMigration as string, g31WaitReceiptMigration as string, g31WaitPoisonMigration as string, orderingQuarantineMigration as string, rebuildVerificationMigration as string, rebuildProofMigration as string].flatMap((migrationText) => migrationText.replace(/^\s*--.*$/gm, "")
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0));
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
      expectedLastSuid: canonicalSuid("stale-suid"),
      lastSuid: second.suid,
      definitionVersion: MATERIALIZER.version,
      updatedAt: 1_002,
      mutations: MATERIALIZER.plan(second),
    })).rejects.toBeInstanceOf(MaterializedViewCasError);
    expect(await mv.readActive(serviceId, MATERIALIZER.id)).toEqual(before.instance);
    expect(await mv.readRows(serviceId, MATERIALIZER.id)).toEqual(before.rows);
    expect(await mv.readIndexEntries(serviceId, MATERIALIZER.id)).toEqual(before.indexes);
  });

  it("applies a declarative JSON patch and replaces changed index entries in one batch", async () => {
    const serviceId = `g20-patch-${crypto.randomUUID()}`;
    const mv = store();
    await mv.initialize();
    await mv.createActive({ serviceId, viewId: PATCH_MATERIALIZER.id, definitionVersion: 1, updatedAt: 1_000 });
    const seed = patchEvent("suid-1", "seed", "seed", "reservation-1", "old");
    await mv.applyMutationsAndAdvanceCheckpoint({
      serviceId, viewId: PATCH_MATERIALIZER.id, generation: 0, expectedLastSuid: null,
      lastSuid: seed.suid, definitionVersion: 1, updatedAt: 1_001, mutations: PATCH_MATERIALIZER.plan(seed),
    });
    const cancel = patchEvent("suid-2", "cancel", "cancel", seed.rowKey);
    await mv.applyMutationsAndAdvanceCheckpoint({
      serviceId, viewId: PATCH_MATERIALIZER.id, generation: 0, expectedLastSuid: seed.suid,
      lastSuid: cancel.suid, definitionVersion: 1, updatedAt: 1_002, mutations: PATCH_MATERIALIZER.plan(cancel),
    });
    expect((await mv.readRows(serviceId, PATCH_MATERIALIZER.id))[0]?.value).toEqual({ status: "cancelled", value: "old" });
    expect(await mv.queryRows(serviceId, PATCH_MATERIALIZER.id, { indexId: "status", valueType: "text", limit: null }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ rowKey: seed.rowKey, value: { status: "cancelled", value: "old" } })]));
    expect(await mv.readIndexEntries(serviceId, PATCH_MATERIALIZER.id)).toEqual([
      expect.objectContaining({ indexId: "status", value: "cancelled", rowKey: seed.rowKey }),
    ]);
  });

  it("fails closed for a patch targeting a missing row without advancing any region", async () => {
    const serviceId = `g20-patch-missing-${crypto.randomUUID()}`;
    const mv = store();
    await mv.initialize();
    await mv.createActive({ serviceId, viewId: PATCH_MATERIALIZER.id, definitionVersion: 1, updatedAt: 1_010 });
    await expect(mv.applyMutationsAndAdvanceCheckpoint({
      serviceId, viewId: PATCH_MATERIALIZER.id, generation: 0, expectedLastSuid: null,
      lastSuid: canonicalSuid("suid-missing"), definitionVersion: 1, updatedAt: 1_011,
      mutations: PATCH_MATERIALIZER.plan(patchEvent("suid-missing", "missing", "cancel", "absent")),
    })).rejects.toBeInstanceOf(MaterializedViewPatchError);
    expect(await mv.readActive(serviceId, PATCH_MATERIALIZER.id)).toEqual(expect.objectContaining({ lastSuid: "" }));
    expect(await mv.readRows(serviceId, PATCH_MATERIALIZER.id)).toEqual([]);
    expect(await mv.readIndexEntries(serviceId, PATCH_MATERIALIZER.id)).toEqual([]);
  });

  it("rolls back a JSON patch and its index update on a stale checkpoint CAS", async () => {
    const serviceId = `g20-patch-cas-${crypto.randomUUID()}`;
    const mv = store();
    await mv.initialize();
    await mv.createActive({ serviceId, viewId: PATCH_MATERIALIZER.id, definitionVersion: 1, updatedAt: 1_020 });
    const seed = patchEvent("suid-1", "seed-cas", "seed", "reservation-cas", "old");
    await mv.applyMutationsAndAdvanceCheckpoint({
      serviceId, viewId: PATCH_MATERIALIZER.id, generation: 0, expectedLastSuid: null,
      lastSuid: seed.suid, definitionVersion: 1, updatedAt: 1_021, mutations: PATCH_MATERIALIZER.plan(seed),
    });
    const before = {
      instance: await mv.readActive(serviceId, PATCH_MATERIALIZER.id),
      rows: await mv.readRows(serviceId, PATCH_MATERIALIZER.id),
      indexes: await mv.readIndexEntries(serviceId, PATCH_MATERIALIZER.id),
    };
    await expect(mv.applyMutationsAndAdvanceCheckpoint({
      serviceId, viewId: PATCH_MATERIALIZER.id, generation: 0, expectedLastSuid: canonicalSuid("stale"),
      lastSuid: canonicalSuid("suid-2"), definitionVersion: 1, updatedAt: 1_022,
      mutations: PATCH_MATERIALIZER.plan(patchEvent("suid-2", "cancel-cas", "cancel", seed.rowKey)),
    })).rejects.toBeInstanceOf(MaterializedViewCasError);
    expect(await mv.readActive(serviceId, PATCH_MATERIALIZER.id)).toEqual(before.instance);
    expect(await mv.readRows(serviceId, PATCH_MATERIALIZER.id)).toEqual(before.rows);
    expect(await mv.readIndexEntries(serviceId, PATCH_MATERIALIZER.id)).toEqual(before.indexes);
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
        expectedLastSuid: index === 0 ? null : canonicalSuid(`suid-${index}`),
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

  it("serves the V1 list-query shape from mv_rows identically to memory backing", async () => {
    const serviceId = `g19-endpoint-${crypto.randomUUID()}`;
    const tag = "test:g19-mv-endpoint";
    const events = [event("suid-1", "z-event", 2), event("suid-2", "a-event", 1)];
    const mv = store();
    await mv.initialize();
    await mv.createActive({ serviceId, viewId: TEST_PROJECTOR, definitionVersion: 1, updatedAt: 3_100 });
    for (const [index, incoming] of events.entries()) {
      await mv.applyMutationsAndAdvanceCheckpoint({
        serviceId,
        viewId: TEST_PROJECTOR,
        generation: 0,
        expectedLastSuid: index === 0 ? null : events[index - 1]!.suid,
        lastSuid: incoming.suid,
        definitionVersion: 1,
        updatedAt: 3_101 + index,
        mutations: MATERIALIZER.plan(incoming),
      });
    }
    const entries = events.map((incoming) => ({
      eventId: incoming.eventId,
      suid: incoming.suid,
      payload: JSON.stringify({ eventId: incoming.eventId, count: incoming.count }),
    }));
    const projectionId = projectionIdFor({
      tag,
      tagGroup: "test",
      tagContent: "g19-mv-endpoint",
      tagProjector: TEST_PROJECTOR,
    });
    const memory: QueryProjectionStore = {
      readAllEvents: async () => [],
      currentLagBound: async () => 0,
      listProjectionTags: async () => [tag],
      readProjectionCheckpoint: async () => ({
        serviceId,
        projectionId,
        lastSuid: events[1]!.suid,
        stateJson: JSON.stringify(entries),
        version: entries.length,
        updatedAt: 3_102,
      }),
    };
    const requestBody = JSON.stringify({
      queryType: "GetTestListQuery",
      queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 20 }),
    });
    const request = () => new Request("https://query.test/api/sekiban/serialized/list-query", {
      method: "POST",
      headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: serviceId },
      body: requestBody,
    });
    const memoryResponse = await handleSerializedQuery(request(), {}, { store: memory });
    const mvResponse = await handleSerializedQuery(request(), {}, {
      queryBacking: "d1-mv", materializedViewQueryPort: mv,
    });
    expect(mvResponse.status).toBe(200);
    // The safe row payload/page remains byte-identical to memory; G55 adds
    // the D1 active checkpoint as an explicit list-read watermark.
    const memoryBody = await memoryResponse.json<Record<string, unknown>>();
    expect(await mvResponse.json()).toEqual({
      ...memoryBody,
      readHead: events[1]!.suid,
    });
  });

  it("preserves roomId for a cancelled reservation in memory and D1 MV, including after rebuild", async () => {
    const serviceId = `g20-cancelled-${crypto.randomUUID()}`;
    const reservationId = "reservation-cancelled-1";
    const roomId = "room-cancelled-1";
    const tag = `reservation:${reservationId}`;
    const events = [
      storedPayloadEvent(serviceId, "suid-1", "reserved-event", {
        eventType: "RoomReserved", reservationId, roomId,
      }, [tag]),
      // The cancellation intentionally omits roomId; the patch must retain it.
      storedPayloadEvent(serviceId, "suid-2", "cancelled-event", {
        eventType: "ReservationCancelled", reservationId,
      }, [tag]),
    ];
    const incidents: unknown[] = [];
    const source = sourceFor(events, 0, incidents);
    const mv = store();
    await mv.initialize();
    const runtime = new MaterializedViewCatchUpRuntime(source, mv);
    await runtime.build(serviceId, reservationMaterializer, 50_000);
    const firstRead = await mv.readRows(serviceId, reservationMaterializer.id);
    expect(firstRead.map((row) => row.value)).toEqual([{
      reservationId, roomId, status: "cancelled", version: 2,
    }]);
    const rebuilt = await runtime.rebuild(serviceId, reservationMaterializer, 50_001, "g20-cancelled-rebuild");
    await runtime.promote(serviceId, reservationMaterializer as unknown as MaterializedViewRowMaterializer, rebuilt.candidateGeneration, 50_002);
    const rebuiltRows = await mv.readRows(serviceId, reservationMaterializer.id);
    expect(rebuiltRows.map((row) => row.value)).toEqual(firstRead.map((row) => row.value));

    const expected = { reservationId, roomId, status: "cancelled", version: 2 };
    const memory: QueryProjectionStore = {
      readAllEvents: async () => events,
      currentLagBound: async () => 0,
      listProjectionTags: async () => [tag],
      readProjectionCheckpoint: async () => ({
        serviceId,
        projectionId: projectionIdFor({
          tag, tagGroup: "reservation", tagContent: reservationId, tagProjector: reservationMaterializer.id,
        }),
        lastSuid: canonicalSuid("suid-2"),
        stateJson: JSON.stringify([{
          eventId: reservationId,
          suid: canonicalSuid("suid-2"),
          payload: JSON.stringify(expected),
        }]),
        version: 2,
        updatedAt: 50_002,
      }),
    };
    const request = () => new Request("https://query.test/api/sekiban/serialized/list-query", {
      method: "POST",
      headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: serviceId },
      body: JSON.stringify({
        queryType: "GetReservationListQuery",
        queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 20 }),
      }),
    });
    const composition = composeRuntime(meetingRoomDomain, meetingRoomRuntimeConfig);
    const memoryResponse = await handleSerializedQuery(request(), {}, {
      store: memory, registry: composition.queries, projectors: composition.projectors,
    });
    const mvResponse = await handleSerializedQuery(request(), {}, {
      queryBacking: "d1-mv",
      materializedViewQueryPort: mv,
      registry: composition.queries,
      projectors: composition.projectors,
    });
    expect(mvResponse.status).toBe(200);
    const memoryBody = await memoryResponse.json<Record<string, unknown>>();
    expect(await mvResponse.json()).toEqual({
      ...memoryBody,
      readHead: canonicalSuid("suid-2"),
    });
    expect(incidents).toEqual([]);
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
    expect((await mv.readActive(serviceId, STORED_MATERIALIZER.id))?.lastSuid).toBe(canonicalSuid("suid-1"));
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
    await expect(runtime.build(serviceId, STORED_MATERIALIZER, 50_000)).rejects.toMatchObject({
      code: "MV_ORDERING_QUARANTINED",
      message: expect.stringMatching(/ordering violation/),
    });
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
