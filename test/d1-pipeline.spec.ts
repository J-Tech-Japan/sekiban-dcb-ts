import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { beforeAll } from "vitest";
// Vite's raw asset loader keeps the test migration identical to the committed
// new-database G32 baseline without making Node filesystem APIs part of a
// Worker test.
// @ts-expect-error Vite raw asset import
import migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";
import { runPipelineContract } from "../scripts/store-contract.mjs";
import { createD1StoreProvider, D1EventStore, D1IdentityConflictError } from "../packages/dcb-runtime/src/d1";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { handleSerializedQuery } from "../packages/dcb-runtime/src/http/SerializedQueryWorker";
import { handleSerializedRead } from "../packages/dcb-runtime/src/read/SerializedReadWorker";
import {
  recordDurableHop,
  recordDurableHopSubstep,
  recordDurableUnsafeWriterBoundary,
} from "../packages/dcb-runtime/src/diagnostics/G60DurableHop";
import { projectionIdFor } from "../packages/dcb-runtime/src/projection/ProjectionRuntime";
import type { Env as WorkerEnv } from "../packages/dcb-runtime/src/index";
import { g32EventId, g32Message, g32Suid, withG44FixtureFacts } from "./helpers/g32-fixtures";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";

function database(): D1Database {
  const binding = (env as unknown as { D1?: D1Database }).D1;
  if (binding === undefined) throw new Error("D1 binding is required; the Miniflare lane must not silently skip");
  return binding;
}

function message(serviceId: string, eventId: string, suid: string, tag: string): DownstreamOutboxMessage {
  return g32Message({
    serviceId,
    allocatorLineageId: "d1-test-lineage",
    tag,
    attemptId: `${eventId}-attempt`,
    eventId,
    suid,
    eventTags: [tag],
  });
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
    await applyG44D1Migration(database());
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
    const first = message(serviceId, "same-event", "identity-1", tag);
    await store.recordDelivery(first, 2_000);
    const before = await store.readAllEvents(serviceId, "");
    await expect(store.recordDelivery({ ...first, payload: JSON.stringify({ fixture: "contradict" }) }, 2_500))
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
    const entry = message(serviceId, "pipeline-event", "pipeline-1", tag);
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
      lastSuid: g32Suid("cas-1"),
      stateJson: JSON.stringify({ applied: ["one"] }),
      version: 1,
      updatedAt: 1,
    };
    expect(await store.advanceProjectionCheckpoint(input)).toBe(true);
    const before = await store.readProjectionCheckpoint(input.serviceId, input.projectionId);
    expect(await store.advanceProjectionCheckpoint({
      ...input,
      expectedLastSuid: g32Suid("stale"),
      lastSuid: g32Suid("cas-2"),
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
    const first = message(serviceId, "guard-first", "guard-1", tag);
    await store.recordDelivery(first, 2_000);

    // G17's lineage oracle must be independent of SUID collision detection.
    // This fresh SUID is from a foreign allocator lineage but does not collide
    // with any durable event, so removing the event-insert lineage predicate
    // would create a poisoned row while still returning lineage-mismatch.
    const beforeNonCollidingLineage = await store.readAllEvents(serviceId, "");
    const nonCollidingId = g32EventId("lineage-non-colliding-event");
    const { completeness: firstFacts, ...firstWithoutFacts } = first;
    expect(firstFacts.eventDigest).toMatch(/^[0-9a-f]{64}$/);
    const nonCollidingLineage = await store.recordDelivery(withG44FixtureFacts({
      ...firstWithoutFacts,
      eventId: nonCollidingId,
      causationId: nonCollidingId,
      suid: g32Suid("guard-2"),
      allocatorLineageId: "different-lineage",
    }), 2_050);
    expect(nonCollidingLineage.outcome).toBe("lineage-mismatch");
    expect((await store.listDeliveryIncidents(serviceId)).map((incident) => incident.classification)).toEqual([
      "LINEAGE_MISMATCH",
    ]);
    expect(await store.readAllEvents(serviceId, "")).toEqual(beforeNonCollidingLineage);

    const lineageId = g32EventId("lineage-event");
    const lineage = await store.recordDelivery(withG44FixtureFacts({ ...firstWithoutFacts, eventId: lineageId, causationId: lineageId, allocatorLineageId: "different-lineage" }), 2_100);
    expect(lineage.outcome).toBe("lineage-mismatch");
    expect((await store.listDeliveryIncidents(serviceId)).map((incident) => incident.classification)).toEqual(["LINEAGE_MISMATCH"]);
    expect(await store.readAllEvents(serviceId, "")).toHaveLength(1);
    const repeatedLineage = await store.recordDelivery(withG44FixtureFacts({ ...firstWithoutFacts, eventId: lineageId, causationId: lineageId, allocatorLineageId: "different-lineage" }), 2_200);
    expect(repeatedLineage.outcome).toBe("lineage-mismatch");
    expect(await store.listDeliveryIncidents(serviceId)).toHaveLength(1);

    const collisionId = g32EventId("collision-event");
    const collision = await store.recordDelivery(withG44FixtureFacts({ ...firstWithoutFacts, eventId: collisionId, causationId: collisionId, allocatorLineageId: first.allocatorLineageId }), 2_300);
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
    const first = message(serviceId, "pending-event", "pending-1", "d1:pending:a");
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
    const entry = message(serviceId, "fault-event", "fault-1", tag);
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
    const pendingEntry = message(pendingServiceId, "fault-pending", "fault-pending", tag);
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
      lastSuid: g32Suid("single-write"),
      stateJson: "[]",
      version: 1,
      updatedAt: 2_000,
    })).rejects.toThrow(/missing_fault_table/);
    expect(await failingStore.readProjectionCheckpoint(serviceId, "single-write-projection")).toBeUndefined();
  });

  it("uses the G32 new-database logical event record without a SUID uniqueness shortcut", async () => {
    const tables = await database().prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'serialized_dcb_%' ORDER BY name COLLATE BINARY",
    ).all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual([
      "serialized_dcb_allocator_bindings",
      "serialized_dcb_completeness_findings",
      "serialized_dcb_completeness_scanner_health",
      "serialized_dcb_delivery_incidents",
      "serialized_dcb_event_arrivals",
      "serialized_dcb_g65_admission_attempts",
      "serialized_dcb_g65_direct_rings",
      "serialized_dcb_g69_admission_attempts",
      "serialized_dcb_global_memberships",
      "serialized_dcb_global_receipts",
      "serialized_dcb_hop_measurements",
      "serialized_dcb_hop_submeasurements",
      "serialized_dcb_inconsistency_findings",
      "serialized_dcb_lag_estimates",
      "serialized_dcb_pending_arrivals",
      "serialized_dcb_projection_checkpoints",
      "serialized_dcb_safe_lane_health",
      "serialized_dcb_safe_lane_history",
      "serialized_dcb_safe_lane_passes",
      "serialized_dcb_source_partitions",
      "serialized_dcb_unsafe_writer_boundaries",
      "serialized_dcb_wait_target_incidents",
    ]);
    const eventSql = await database().prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dcb_events'",
    ).first<{ sql: string }>();
    expect(eventSql?.sql).toMatch(/PRIMARY KEY \("ServiceId", "Id"\)/);
    expect(eventSql?.sql).toMatch(/"SortableUniqueId" TEXT NOT NULL COLLATE BINARY/);
    expect(eventSql?.sql).not.toMatch(/UNIQUE \([^)]*SortableUniqueId/);
  });

  it("keeps G60 hop observations correlated, ordered, and idempotent without SUID uniqueness", async () => {
    const serviceId = `d1-g60-hop-${crypto.randomUUID()}`;
    const identity = {
      serviceId,
      eventId: "event-one",
      suid: "000000000000000000000000000001",
      attemptId: "attempt-one",
    };
    const observations = [
      { stage: "command-receipt" as const, observedAt: 1000 },
      { stage: "tag-append-committed" as const, partitionTag: "reservation:one", observedAt: 1001 },
      { stage: "outbox-obligation-written" as const, partitionTag: "reservation:one", observedAt: 1002 },
      { stage: "queue-send-returned" as const, partitionTag: "reservation:one", transport: "queue" as const, observedAt: 1003 },
      { stage: "consumer-invocation-started" as const, partitionTag: "reservation:one", transport: "queue" as const, observedAt: 1004 },
      { stage: "record-delivery-batch-committed" as const, partitionTag: "reservation:one", transport: "queue" as const, observedAt: 1005 },
      { stage: "first-unsafe-visible-read" as const, viewId: "ReservationProjector", transport: "public-read" as const, observedAt: 1006 },
    ];
    for (const observation of observations) await recordDurableHop(database(), { ...identity, ...observation });
    await recordDurableHop(database(), { ...identity, stage: "record-delivery-batch-committed", partitionTag: "reservation:one", transport: "queue", observedAt: 2000 });
    await recordDurableHop(database(), { ...identity, stage: "record-delivery-batch-committed", partitionTag: "reservation:one", transport: "queue", observedAt: 900 });
    await recordDurableHop(database(), { ...identity, stage: "command-receipt", observedAt: 1000, eventId: "event-two", attemptId: "attempt-two" });
    const rows = await database().prepare(
      `SELECT event_id, suid, stage, observed_at
         FROM serialized_dcb_hop_measurements
        WHERE service_id = ?
        ORDER BY event_id COLLATE BINARY, observed_at ASC, stage COLLATE BINARY`,
    ).bind(serviceId).all<{ event_id: string; suid: string; stage: string; observed_at: number }>();
    expect(rows.results).toHaveLength(8);
    expect(new Set(rows.results.filter((row) => row.event_id === "event-one").map((row) => row.stage))).toEqual(new Set(observations.map((row) => row.stage)));
    expect(rows.results.find((row) => row.stage === "record-delivery-batch-committed")?.observed_at).toBe(900);
    expect(rows.results.some((row) => row.event_id === "event-two" && row.suid === identity.suid)).toBe(true);
  });

  it("keeps G60 post-admission boundaries append-only and exactly correlated", async () => {
    const serviceId = `d1-g60-substeps-${crypto.randomUUID()}`;
    const identity = {
      serviceId,
      eventId: "substep-event",
      suid: "000000000000000000000000000002",
      attemptId: "substep-attempt",
      partitionTag: "reservation:substep",
      transport: "queue" as const,
    };
    const observations = [
      { stage: "post-record-delivery-global-receipt-readback" as const, boundary: "start" as const, outcome: "started", observedAt: 2000 },
      { stage: "post-record-delivery-global-receipt-readback" as const, boundary: "end" as const, outcome: "available", observedAt: 2001 },
      { stage: "source-tag-acknowledgement" as const, boundary: "start" as const, outcome: "started", observedAt: 2002 },
      { stage: "source-tag-acknowledgement" as const, boundary: "end" as const, outcome: "acknowledged", observedAt: 2003 },
      { stage: "completeness-coverage" as const, boundary: "start" as const, outcome: "started", observedAt: 2004 },
      { stage: "completeness-coverage" as const, boundary: "end" as const, outcome: "SETTLED", observedAt: 2005 },
      { stage: "detector" as const, boundary: "start" as const, outcome: "started", observedAt: 2006 },
      { stage: "detector" as const, boundary: "end" as const, outcome: "applied", observedAt: 2007 },
      { stage: "unsafe-view-apply" as const, boundary: "start" as const, outcome: "started", viewId: "RoomProjector", observedAt: 2008 },
      { stage: "unsafe-view-apply" as const, boundary: "end" as const, outcome: "applied", viewId: "RoomProjector", observedAt: 2009 },
      { stage: "unsafe-view-apply" as const, boundary: "start" as const, outcome: "started", viewId: "ReservationProjector", observedAt: 2010 },
      { stage: "unsafe-view-apply" as const, boundary: "end" as const, outcome: "applied", viewId: "ReservationProjector", observedAt: 2011 },
    ];
    for (const observation of observations) await recordDurableHopSubstep(database(), { ...identity, ...observation });
    await recordDurableHopSubstep(database(), { ...identity, ...observations[1], outcome: "mutated", observedAt: 9999 });
    const rows = await database().prepare(
      `SELECT event_id, suid, attempt_id, stage, boundary, outcome, partition_tag, view_id, transport, observed_at
         FROM serialized_dcb_hop_submeasurements
        WHERE service_id = ?
        ORDER BY observed_at ASC, stage COLLATE BINARY, boundary COLLATE BINARY, view_id COLLATE BINARY`,
    ).bind(serviceId).all<{
      event_id: string;
      suid: string;
      attempt_id: string;
      stage: string;
      boundary: string;
      outcome: string;
      partition_tag: string;
      view_id: string;
      transport: string;
      observed_at: number;
    }>();
    expect(rows.results).toHaveLength(observations.length);
    expect(rows.results.every((row) => row.event_id === identity.eventId && row.suid === identity.suid && row.attempt_id === identity.attemptId)).toBe(true);
    expect(rows.results.find((row) => row.stage === observations[1].stage && row.boundary === observations[1].boundary)?.outcome).toBe("available");
    expect(rows.results.filter((row) => row.stage === "unsafe-view-apply").map((row) => row.view_id)).toEqual([
      "RoomProjector",
      "RoomProjector",
      "ReservationProjector",
      "ReservationProjector",
    ]);
  });

  it("keeps G60 unsafe writer boundaries path-labelled and exactly correlated", async () => {
    const serviceId = `d1-g60-writer-${crypto.randomUUID()}`;
    const identity = {
      serviceId,
      eventId: "writer-event",
      suid: "000000000000000000000000000003",
      attemptId: "writer-attempt",
      viewId: "ReservationProjector",
      writerPath: "inline-delivery" as const,
      transport: "queue" as const,
    };
    await recordDurableUnsafeWriterBoundary(database(), { ...identity, boundary: "start", outcome: "started", observedAt: 3000 });
    await recordDurableUnsafeWriterBoundary(database(), { ...identity, boundary: "end", outcome: "applied", observedAt: 3001 });
    await recordDurableUnsafeWriterBoundary(database(), { ...identity, boundary: "end", outcome: "mutated", observedAt: 9999 });
    const rows = await database().prepare(
      `SELECT service_id, event_id, suid, attempt_id, writer_path, boundary,
              outcome, view_id, transport, observed_at
         FROM serialized_dcb_unsafe_writer_boundaries
        WHERE service_id = ?
        ORDER BY observed_at ASC, boundary COLLATE BINARY`,
    ).bind(serviceId).all<{
      service_id: string;
      event_id: string;
      suid: string;
      attempt_id: string;
      writer_path: string;
      boundary: string;
      outcome: string;
      view_id: string;
      transport: string;
      observed_at: number;
    }>();
    expect(rows.results).toEqual([
      { service_id: serviceId, event_id: "writer-event", suid: identity.suid, attempt_id: "writer-attempt", writer_path: "inline-delivery", boundary: "start", outcome: "started", view_id: "ReservationProjector", transport: "queue", observed_at: 3000 },
      { service_id: serviceId, event_id: "writer-event", suid: identity.suid, attempt_id: "writer-attempt", writer_path: "inline-delivery", boundary: "end", outcome: "applied", view_id: "ReservationProjector", transport: "queue", observed_at: 3001 },
    ]);
  });
});
