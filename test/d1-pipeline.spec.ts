import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { beforeAll } from "vitest";
// Vite's raw asset loader keeps the test migration identical to the committed
// versioned SQL without making Node filesystem APIs part of a Worker test.
// @ts-expect-error Vite raw asset import
import migration from "../migrations/d1/0001_pipeline_store.sql?raw";
import { runPipelineContract } from "../scripts/store-contract.mjs";
import { createD1StoreProvider, D1EventStore, D1IdentityConflictError } from "../packages/dcb-runtime/src/d1";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { handleSerializedQuery } from "../packages/dcb-runtime/src/http/SerializedQueryWorker";
import { handleSerializedRead } from "../packages/dcb-runtime/src/read/SerializedReadWorker";
import { projectionIdFor } from "../packages/dcb-runtime/src/projection/ProjectionRuntime";
import type { Env as WorkerEnv } from "../packages/dcb-runtime/src/index";

function database(): D1Database {
  const binding = (env as unknown as { D1?: D1Database }).D1;
  if (binding === undefined) throw new Error("D1 binding is required; the Miniflare lane must not silently skip");
  return binding;
}

function message(serviceId: string, eventId: string, suid: string, tag: string): DownstreamOutboxMessage {
  return {
    version: 1,
    serviceId,
    allocatorLineageId: "d1-test-lineage",
    tag,
    attemptId: `${eventId}-attempt`,
    eventId,
    suid,
    payload: "cGF5bG9hZA==",
    eventTags: [tag],
    enqueuedAt: 1_000,
  };
}

describe("SDT-G18 D1 PipelineStore", () => {
  beforeAll(async () => {
    // The test harness does not apply Wrangler migrations automatically. The
    // fixture applies the committed versioned migration once; production
    // deploys use `wrangler d1 migrations apply`, never runtime DDL.
    const migrationText = migration as string;
    const statements: string[] = migrationText.replace(/^\s*--.*$/gm, "")
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    await database().batch(statements.map((statement) => database().prepare(statement)));
  });

  it("runs the exact shared PG/Cosmos contract against Miniflare D1", async () => {
    await runPipelineContract("d1", async () => {
      const provider = createD1StoreProvider();
      if (!provider.isConfigured?.({ D1: database() })) throw new Error("D1 provider was not configured");
      const store = provider.create({ D1: database() });
      await store.initialize();
      return store;
    });
  });

  it("keeps contradictory EventId identity fail-closed with no arrival/lag side effects", async () => {
    const store = new D1EventStore(database());
    await store.initialize();
    const serviceId = `d1-identity-${crypto.randomUUID()}`;
    const tag = `d1:identity:${crypto.randomUUID()}`;
    const first = message(serviceId, "same-event", "suid-identity-1", tag);
    await store.recordDelivery(first, 2_000);
    const before = await store.readAllEvents(serviceId, "");
    await expect(store.recordDelivery({ ...first, payload: "Y29udHJhZGljdA==" }, 2_500))
      .rejects.toBeInstanceOf(D1IdentityConflictError);
    expect(await store.readAllEvents(serviceId, "")).toEqual(before);
    expect(await store.currentLagBound(serviceId, 2_500)).toBe(1_000);
  });

  it("runs the unchanged query/read handlers through the explicit D1 provider", async () => {
    const d1 = database();
    const provider = createD1StoreProvider();
    const store = provider.create({ D1: d1 });
    await store.initialize();
    const serviceId = `d1-pipeline-${crypto.randomUUID()}`;
    const tag = `test:${crypto.randomUUID()}`;
    const entry = message(serviceId, "pipeline-event", "suid-pipeline-1", tag);
    await store.recordDelivery(entry, 2_000);
    const tagIdentity = {
      tag,
      tagGroup: "test",
      tagContent: tag.slice("test:".length),
      tagProjector: "test-projector",
    };
    await store.advanceProjectionCheckpoint({
      serviceId,
      projectionId: projectionIdFor(tagIdentity),
      expectedLastSuid: null,
      lastSuid: entry.suid,
      stateJson: JSON.stringify([{ eventId: entry.eventId, suid: entry.suid, payload: entry.payload }]),
      version: 1,
      updatedAt: 2_000,
    });

    const queryResponse = await handleSerializedQuery(new Request("https://query.test/api/sekiban/serialized/query", {
      method: "POST",
      headers: { "content-type": "application/json", "x-sdt-g9-test-service-id": serviceId },
      body: JSON.stringify({ queryType: "GetTestCountQuery", queryParamsJson: "{}" }),
    }), { D1: d1 }, { storeProvider: provider });
    expect(queryResponse.status).toBe(200);
    expect(await queryResponse.json()).toEqual({ resultJson: JSON.stringify({ count: 1 }) });

    const workerEnv = env as unknown as WorkerEnv;
    const readResponse = await handleSerializedRead(new Request("https://query.test/api/sekiban/serialized/tag-latest-sortable", {
      method: "POST",
      headers: { "content-type": "application/json", "x-sdt-g9-test-service-id": serviceId },
      body: JSON.stringify({ tag }),
    }), { TAG: workerEnv.TAG, D1: d1 }, undefined, provider);
    expect(readResponse.status).toBe(200);
    expect(readResponse.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("uses a single meta.changes CAS statement for stale checkpoint rejection", async () => {
    const store = new D1EventStore(database());
    await store.initialize();
    const input = {
      serviceId: `d1-cas-${crypto.randomUUID()}`,
      projectionId: `d1-projection-${crypto.randomUUID()}`,
      expectedLastSuid: null,
      lastSuid: "suid-cas-1",
      stateJson: JSON.stringify({ applied: ["one"] }),
      version: 1,
      updatedAt: 1,
    };
    expect(await store.advanceProjectionCheckpoint(input)).toBe(true);
    const before = await store.readProjectionCheckpoint(input.serviceId, input.projectionId);
    expect(await store.advanceProjectionCheckpoint({
      ...input,
      expectedLastSuid: "suid-stale",
      lastSuid: "suid-cas-2",
      stateJson: JSON.stringify({ applied: ["one", "two"] }),
      version: 2,
    })).toBe(false);
    expect(await store.readProjectionCheckpoint(input.serviceId, input.projectionId)).toEqual(before);
  });

  it("preserves G17 lineage/collision incident kinds and idempotent findings", async () => {
    const store = new D1EventStore(database());
    await store.initialize();
    const serviceId = `d1-guards-${crypto.randomUUID()}`;
    const tag = `d1:guards:${crypto.randomUUID()}`;
    const first = message(serviceId, "guard-first", "suid-guard-1", tag);
    await store.recordDelivery(first, 2_000);

    const lineage = await store.recordDelivery({ ...first, eventId: "lineage-event", allocatorLineageId: "different-lineage" }, 2_100);
    expect(lineage.outcome).toBe("lineage-mismatch");
    expect((await store.listDeliveryIncidents(serviceId)).map((incident) => incident.classification)).toEqual(["LINEAGE_MISMATCH"]);
    expect(await store.readAllEvents(serviceId, "")).toHaveLength(1);
    const repeatedLineage = await store.recordDelivery({ ...first, eventId: "lineage-event", allocatorLineageId: "different-lineage" }, 2_200);
    expect(repeatedLineage.outcome).toBe("lineage-mismatch");
    expect(await store.listDeliveryIncidents(serviceId)).toHaveLength(1);

    const collision = await store.recordDelivery({ ...first, eventId: "collision-event", allocatorLineageId: first.allocatorLineageId }, 2_300);
    // Same SUID with a different EventId is rejected before event mutation.
    expect(collision.outcome).toBe("suid-collision");
    expect((await store.listDeliveryIncidents(serviceId)).map((incident) => incident.classification)).toEqual([
      "LINEAGE_MISMATCH",
      "SUID_COLLISION",
    ]);
    expect(await store.readAllEvents(serviceId, "")).toHaveLength(1);
  });

  it("unions concurrent pending paths in guarded SQL without lost updates", async () => {
    const store = new D1EventStore(database());
    await store.initialize();
    const serviceId = `d1-pending-${crypto.randomUUID()}`;
    const first = message(serviceId, "pending-event", "suid-pending-1", "d1:pending:a");
    const second = { ...first, tag: "d1:pending:b", eventTags: ["d1:pending:a", "d1:pending:b"] };
    const third = { ...first, tag: "d1:pending:c", eventTags: ["d1:pending:a", "d1:pending:c"] };
    await Promise.all([
      store.upsertPending(first, 2_000, 20_000),
      store.upsertPending(second, 2_100, 22_000),
      store.upsertPending(third, 2_200, 24_000),
    ]);
    const pending = (await store.listPending(serviceId))[0]!;
    expect(pending.expectedPaths).toEqual(["d1:pending:a", "d1:pending:b", "d1:pending:c"]);
    expect(pending.observedPaths).toEqual(["d1:pending:a", "d1:pending:b", "d1:pending:c"]);
    expect(pending.firstObservedAt).toBe(2_000);
    expect(pending.lagBoundMs).toBe(24_000);
  });

  it("rolls back every statement in a failed D1 recordDelivery/upsertPending batch", async () => {
    const failBatch = (_operation: string, statements: readonly D1PreparedStatement[], db: D1Database) => [
      ...statements,
      db.prepare("SELECT missing_fault_table_for_d1_atomicity"),
    ];
    const serviceId = `d1-fault-${crypto.randomUUID()}`;
    const tag = `d1:fault:${crypto.randomUUID()}`;
    const entry = message(serviceId, "fault-event", "suid-fault-1", tag);
    const failingStore = new D1EventStore(database(), { beforeBatch: failBatch });
    await failingStore.initialize();
    await expect(failingStore.recordDelivery(entry, 2_000)).rejects.toThrow(/missing_fault_table/);
    expect(await failingStore.readAllEvents(serviceId, "")).toEqual([]);
    expect(await failingStore.listDeliveryIncidents(serviceId)).toEqual([]);
    const recovered = new D1EventStore(database());
    await recovered.initialize();
    await recovered.recordDelivery(entry, 2_000);
    expect(await recovered.readAllEvents(serviceId, "")).toHaveLength(1);

    const pendingServiceId = `d1-fault-pending-${crypto.randomUUID()}`;
    const pendingEntry = message(pendingServiceId, "fault-pending", "suid-fault-pending", tag);
    const failingPendingStore = new D1EventStore(database(), { beforeBatch: failBatch });
    await failingPendingStore.initialize();
    await expect(failingPendingStore.upsertPending(pendingEntry, 2_000, 20_000)).rejects.toThrow(/missing_fault_table/);
    expect(await failingPendingStore.listPending(pendingServiceId)).toEqual([]);
    await recovered.upsertPending(pendingEntry, 2_000, 20_000);
    expect(await recovered.listPending(pendingServiceId)).toHaveLength(1);
  });

  it("keeps single-statement finding and checkpoint writes fail-closed", async () => {
    const failWrite = (_operation: string, _statement: D1PreparedStatement, db: D1Database) =>
      db.prepare("SELECT missing_fault_table_for_d1_single_write");
    const serviceId = `d1-single-write-${crypto.randomUUID()}`;
    const finding = {
      serviceId,
      eventId: "single-write-event",
      path: "test:path",
      classification: "MISSING_STABLE" as const,
      firstObservedAt: 2_000,
      lagBoundMs: 20_000,
      observedAt: 22_000,
    };
    const failingStore = new D1EventStore(database(), { beforeWrite: failWrite });
    await failingStore.initialize();
    await expect(failingStore.appendFinding(finding)).rejects.toThrow(/missing_fault_table/);
    expect(await failingStore.listFindings(serviceId)).toEqual([]);
    await expect(failingStore.advanceProjectionCheckpoint({
      serviceId,
      projectionId: "single-write-projection",
      expectedLastSuid: null,
      lastSuid: "suid-single-write",
      stateJson: "[]",
      version: 1,
      updatedAt: 2_000,
    })).rejects.toThrow(/missing_fault_table/);
    expect(await failingStore.readProjectionCheckpoint(serviceId, "single-write-projection")).toBeUndefined();
  });

  it("pins BINARY SUID schema/indexes and the public migration boundary", async () => {
    const tables = await database().prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'serialized_dcb_%' ORDER BY name COLLATE BINARY",
    ).all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual([
      "serialized_dcb_allocator_bindings",
      "serialized_dcb_delivery_incidents",
      "serialized_dcb_event_arrivals",
      "serialized_dcb_events",
      "serialized_dcb_inconsistency_findings",
      "serialized_dcb_lag_estimates",
      "serialized_dcb_pending_arrivals",
      "serialized_dcb_projection_checkpoints",
    ]);
    const eventSql = await database().prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'serialized_dcb_events'",
    ).first<{ sql: string }>();
    expect(eventSql?.sql).toMatch(/suid TEXT NOT NULL COLLATE BINARY/);
    expect(eventSql?.sql).toMatch(/UNIQUE \(service_id, suid COLLATE BINARY\)/);
  });
});
