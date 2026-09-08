import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { defineRowMaterializer, type MaterializedViewRowMaterializer } from "@sekiban/dcb-core";
// @ts-expect-error Vite raw migration import.
import pipelineMigration from "../migrations/d1/g32/0001_dcb_events.sql?raw";
// @ts-expect-error Vite raw migration import.
import mvMigration from "../migrations/mv/0001_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration import.
import unsafeMvMigration from "../migrations/mv/0002_unsafe_window_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration import.
import hardeningMvMigration from "../migrations/mv/0003_checkpoint_ahead_hardening.sql?raw";
// @ts-expect-error Vite raw migration import.
import unsafeFailureMvMigration from "../migrations/mv/0004_unsafe_window_failure_findings.sql?raw";
// @ts-expect-error Vite raw migration import.
import g31WaitReceiptMigration from "../migrations/mv/0005_g31_wait_receipts.sql?raw";
// @ts-expect-error Vite raw migration import.
import g31WaitPoisonMigration from "../migrations/mv/0006_g31_wait_target_poison.sql?raw";
// @ts-expect-error Vite raw migration import.
import orderingQuarantineMigration from "../migrations/mv/0007_g69_ordering_quarantine.sql?raw";
// @ts-expect-error Vite raw migration import.
import rebuildVerificationMigration from "../migrations/mv/0008_g69_rebuild_verification.sql?raw";
// @ts-expect-error Vite raw migration import.
import rebuildProofMigration from "../migrations/mv/0009_g69_rebuild_proof.sql?raw";
import { D1EventStore, D1MaterializedViewStore } from "../packages/dcb-runtime/src/d1";
import { appendG69AdmissionAttempt, type G69AdmissionAttemptReceipt } from "../packages/dcb-runtime/src/diagnostics/G69AdmissionAttempt";
import { handleDownstreamQueue } from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import type { StoredEvent } from "../packages/dcb-runtime/src/store/types";
import { scopeIdFor, TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/cloudflare";
import { composeRuntime } from "../packages/dcb-runtime/src/composition";
import { handleSerializedQuery } from "../packages/dcb-runtime/src/http/SerializedQueryWorker";
import { catchUpMeetingRoomMaterializedViews, reservationMaterializer } from "../samples/meeting-room/src/d1-mv";
import { meetingRoomDomain, meetingRoomRuntimeConfig } from "../samples/meeting-room/src/domain";
import { runMeetingRoomSafeLanePass } from "../samples/meeting-room/src/worker.cloudflare-only";
import { MaterializedViewCatchUpRuntime } from "../packages/dcb-runtime/src/mv/MaterializedViewCatchUp";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";
import { g32EventId, g32Message, g32Suid } from "./helpers/g32-fixtures";

function statements(database: D1Database, sql: string): D1PreparedStatement[] {
  return sql.replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => database.prepare(statement));
}

function pipeline(): D1Database {
  const database = (env as unknown as { D1?: D1Database }).D1;
  if (database === undefined) throw new Error("G69 requires the D1 pipeline binding");
  return database;
}

function materializedViews(): D1Database {
  const database = (env as unknown as { D1_MV?: D1Database }).D1_MV;
  if (database === undefined) throw new Error("G69 requires the D1_MV binding");
  return database;
}

async function allocateBeforeTagAppend(
  serviceId: string,
  tagSets: readonly (readonly string[])[],
  eventLabels: readonly string[],
): Promise<DownstreamOutboxMessage[][]> {
  const namespace = (env as unknown as { ALLOCATOR?: DurableObjectNamespace }).ALLOCATOR;
  if (namespace === undefined) throw new Error("G69 requires the allocator binding");
  const attemptId = `g69-held-attempt-${crypto.randomUUID()}`;
  const eventIds = eventLabels.map((label) => g32EventId(`g69-held-event-${label}-${crypto.randomUUID()}`));
  const allocator = namespace.get(scopeIdFor(namespace, { serviceId, doClass: "allocator", identity: "allocator" }));
  const response = await allocator.fetch(new Request("https://g69.test/allocate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      attemptId,
      serviceId,
      candidates: eventIds.map((eventId, candidateIndex) => ({ candidateIndex, eventId })),
    }),
  }));
  if (!response.ok) throw new Error(`G69 allocator allocation failed: ${response.status} ${await response.text()}`);
  const allocation = await response.json<{ allocatorLineageId: string; candidates: Array<{ suid: string }> }>();
  if (allocation.candidates.length !== eventLabels.length) throw new Error("G69 allocator returned an unexpected candidate count");
  return allocation.candidates.map((candidate, index) => {
    const eventId = eventIds[index]!;
    const label = eventLabels[index]!;
    const tags = tagSets[index]!;
    const base = g32Message({
      serviceId,
      allocatorLineageId: allocation.allocatorLineageId,
      tag: tags[0]!,
      attemptId,
      eventId,
      suid: candidate.suid,
      payload: JSON.stringify({ roomId: `${tags[0]}-${label}`, reservationId: `reservation:${tags[0]}-${label}`, userId: "g69-ordering-user" }),
      eventTags: tags,
      eventType: "RoomReserved",
      enqueuedAt: Date.now(),
    });
    return tags.map((tag) => ({
      ...base,
      tag,
      completeness: {
        ...base.completeness,
        localCommittedMembership: [{ serviceId, eventId, tag }],
      },
    }));
  });
}

async function appendHeldTag(message: DownstreamOutboxMessage): Promise<void> {
  const namespace = (env as unknown as { TAG?: DurableObjectNamespace }).TAG;
  if (namespace === undefined) throw new Error("G69 requires the Tag binding");
  const tag = namespace.get(scopeIdFor(namespace, { serviceId: message.serviceId, doClass: "tag", identity: message.tag }));
  const append = await tag.fetch(new Request(
    `https://g69.test/append?__tag=${encodeURIComponent(message.tag)}&__serviceId=${encodeURIComponent(message.serviceId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attemptId: message.attemptId,
        epoch: 0,
        allocatorLineageId: message.allocatorLineageId,
        candidates: [{
          eventId: message.eventId,
          suid: message.suid,
          payload: message.payload,
          eventType: message.eventType,
          provenance: "g32",
          eventTags: message.eventTags,
          allocatorLineageId: message.allocatorLineageId,
          timestamp: message.timestamp,
        }],
      }),
    },
  ));
  if (!append.ok) throw new Error(`G69 held-tag append failed: ${append.status} ${await append.text()}`);
}

async function pendingDeliveries(serviceId: string, tags: readonly string[], nowMs: number): Promise<DownstreamOutboxMessage[]> {
  const namespace = (env as unknown as { TAG?: DurableObjectNamespace }).TAG;
  if (namespace === undefined) throw new Error("G69 requires the Tag binding");
  const rows: DownstreamOutboxMessage[] = [];
  for (const tag of tags) {
    const stub = namespace.get(scopeIdFor(namespace, { serviceId, doClass: "tag", identity: tag }));
    const response = await stub.fetch(new Request(
      `https://g69.test/outbox/pending?__tag=${encodeURIComponent(tag)}&__serviceId=${encodeURIComponent(serviceId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nowMs, force: true, limit: 32 }),
      },
    ));
    if (!response.ok) throw new Error(`G69 pending outbox failed: ${response.status}`);
    const body = await response.json<{ rows?: DownstreamOutboxMessage[] }>();
    rows.push(...(body.rows ?? []));
  }
  return rows;
}

function messageBatch(messages: readonly DownstreamOutboxMessage[], timestamp: number): MessageBatch<unknown> {
  return {
    messages: messages.map((body) => ({
      // The Queue wrapper identity is distinct from the envelope attempt
      // identity; the receipt must not manufacture one from the other.
      id: `queue-wrapper:${body.attemptId}`,
      timestamp: new Date(timestamp),
      attempts: 1,
      body,
      ack: () => undefined,
      retry: () => undefined,
    })),
  } as never;
}

async function settleDiagnosticReceipts(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function deliver(
  database: D1Database,
  messages: readonly DownstreamOutboxMessage[],
  timestamp: number,
): Promise<void> {
  const runtimeEnv = env as unknown as Record<string, unknown>;
  await handleDownstreamQueue(messageBatch(messages, timestamp), runtimeEnv as never, {
    store: new D1EventStore(database),
    clock: { now: () => timestamp },
  });
}

function generationMessage(
  serviceId: string,
  ordinal: number,
  label: string,
): DownstreamOutboxMessage {
  const reservationId = `reservation:g69-generation-${label}-${crypto.randomUUID()}`;
  const tag = reservationId;
  return g32Message({
    serviceId,
    allocatorLineageId: `g69-generation-lineage-${serviceId}`,
    tag,
    eventId: `g69-generation-${label}-${crypto.randomUUID()}`,
    suid: g32Suid(ordinal),
    payload: JSON.stringify({ roomId: `room:g69-generation-${label}`, reservationId, userId: "g69-generation-user" }),
    eventTags: [tag],
    eventType: "RoomReserved",
    enqueuedAt: 100_000,
  });
}

async function publicGenerationRead(
  serviceId: string,
  mvDatabase: D1Database,
  consistency: "safe" | "unsafe",
): Promise<Response> {
  const composition = composeRuntime(meetingRoomDomain, meetingRoomRuntimeConfig);
  return handleSerializedQuery(new Request("https://g69-generation.test/api/sekiban/serialized/list-query", {
    method: "POST",
    headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: serviceId },
    body: JSON.stringify({
      queryType: "GetReservationListQuery",
      queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 20, consistency }),
    }),
  }), {}, {
    registry: composition.queries,
    projectors: composition.projectors,
    queryBacking: "d1-mv",
    materializedViewQueryPort: new D1MaterializedViewStore(mvDatabase),
  });
}

beforeAll(async () => {
  const database = pipeline();
  await database.batch(statements(database, pipelineMigration as string));
  await applyG44D1Migration(database);
  const mv = materializedViews();
  for (const migration of [mvMigration, unsafeMvMigration, hardeningMvMigration, unsafeFailureMvMigration, g31WaitReceiptMigration, g31WaitPoisonMigration, orderingQuarantineMigration, rebuildVerificationMigration, rebuildProofMigration]) {
    await mv.batch(statements(mv, migration as string));
  }
});

describe("SDT-G69 allocator-to-Tag-to-D1 ordering proof", () => {
  it("runs the real allocation race and records an unsafe frontier witness instead of forcing SETTLED", async () => {
    const database = pipeline();
    const serviceId = `g69-ordering-${crypto.randomUUID()}`;
    const lowerRoom = `room:g69-lower-${crypto.randomUUID()}`;
    const lowerReservation = `reservation:g69-lower-${crypto.randomUUID()}`;
    const higherRoom = `room:g69-higher-${crypto.randomUUID()}`;
    const higherReservation = `reservation:g69-higher-${crypto.randomUUID()}`;
    const [lowerAllocatedMessages, higherAllocatedMessages] = await allocateBeforeTagAppend(
      serviceId,
      [[lowerRoom, lowerReservation], [higherRoom, higherReservation]],
      ["lower", "higher"],
    );
    await Promise.all(higherAllocatedMessages.map((message) => appendHeldTag(message)));
    try {
      const higherEvent = {
        id: higherAllocatedMessages[0]!.eventId,
        sortableUniqueIdValue: higherAllocatedMessages[0]!.suid,
      };

      const higherArrival = Date.now() - 60_000;
      const higherMessages = await pendingDeliveries(serviceId, [higherRoom, higherReservation], higherArrival);
      expect(higherMessages).toHaveLength(2);
      expect(new Set(higherMessages.map((message) => message.eventId))).toEqual(new Set([higherEvent.id]));
      await deliver(database, higherMessages, higherArrival);

      const passEnvironment = {
        ...(env as unknown as Record<string, unknown>),
        D1: database,
        D1_MV: materializedViews(),
        SDT_SERVICE_ID: serviceId,
        AUTO_DRAIN_OUTBOX: "false",
      } as never;
      await runMeetingRoomSafeLanePass(passEnvironment, serviceId, "delivery", undefined, {
        passId: `g69-higher:${crypto.randomUUID()}`,
        scheduledAt: higherArrival,
        trigger: "delivery",
        owner: {
          eventId: higherEvent.id,
          suid: higherEvent.sortableUniqueIdValue,
          attemptId: higherMessages[0]!.attemptId,
          partitionTag: higherMessages[0]!.tag,
          obligationSequence: higherMessages[0]!.completeness.obligationSequence,
        },
      });
      const higherPass = await database.prepare(
        `SELECT coverage_kind, settled_frontier_suid, catch_up_outcome, catch_up_error,
                catch_up_result_json, safe_heads_before_json, safe_heads_after_json, stop_reason
           FROM serialized_dcb_safe_lane_passes
          WHERE service_id = ? ORDER BY scheduled_at DESC, pass_id DESC LIMIT 1`,
      ).bind(serviceId).first<Record<string, unknown>>();
      expect(higherPass).toMatchObject({ coverage_kind: "SETTLED", catch_up_outcome: "completed" });
      const higherCatchUp = JSON.parse(String(higherPass?.catch_up_result_json)) as Array<{ lateLowerQueryDurationMs?: unknown }>;
      expect(higherCatchUp.length).toBeGreaterThan(0);
      expect(higherCatchUp.every((observation) => typeof observation.lateLowerQueryDurationMs === "number" && observation.lateLowerQueryDurationMs >= 0)).toBe(true);
      expect(higherCatchUp.every((observation) => observation.lateLowerQueryDurationMs === 0)).toBe(true);
      console.log("G69_HOTPATH_COSTS", JSON.stringify({
        lateLowerQueryDurationMs: higherCatchUp.map((observation) => observation.lateLowerQueryDurationMs),
      }));
      const views = new D1MaterializedViewStore(materializedViews());
      await views.initialize();
      const higherSafeRows = await views.readListPage(serviceId, "ReservationProjector", { consistency: "safe", limit: null });
      const higherSafe = higherSafeRows.rows.some((row) => String(row.sourceSuid) === higherEvent.sortableUniqueIdValue);
      // This is a structural allocator witness under accelerated time: the
      // higher candidate is directly Tag-appended while the lower candidate
      // remains held. It is not a production incident. After lower admission,
      // the detector must persist a generation-scoped quarantine and fail
      // closed without changing the source ordering contract.
      expect(higherSafe, `higher SUID ${higherEvent.sortableUniqueIdValue} became safe before lower admission`).toBe(true);

      await Promise.all(lowerAllocatedMessages.map((message) => appendHeldTag(message)));
      const lowerEvent = {
        id: lowerAllocatedMessages[0]!.eventId,
        sortableUniqueIdValue: lowerAllocatedMessages[0]!.suid,
      };
      expect(lowerEvent.sortableUniqueIdValue < higherEvent.sortableUniqueIdValue).toBe(true);

      // Keep the lower admission strictly after the higher pass checkpoint;
      // equal-ms arrivals are intentionally excluded by the detector guard.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      const lowerArrival = Date.now();
      const lowerMessages = await pendingDeliveries(serviceId, [lowerRoom, lowerReservation], lowerArrival);
      expect(lowerMessages).toHaveLength(2);
      await deliver(database, lowerMessages, lowerArrival);
      const lowerFacts = await database.prepare(
        `SELECT e."Id" AS event_id, e."SortableUniqueId" AS suid,
                o."FirstArrivedAt" AS first_arrived_at, o."LastArrivedAt" AS last_arrived_at
           FROM dcb_events e JOIN dcb_event_ops o
             ON o."ServiceId" = e."ServiceId" AND o."Id" = e."Id"
          WHERE e."ServiceId" = ? ORDER BY e."SortableUniqueId" COLLATE BINARY ASC`,
      ).bind(serviceId).all<Record<string, unknown>>();
      const checkpointFacts = await materializedViews().prepare(
        `SELECT instance.view_id, instance.last_suid, instance.updated_at
           FROM mv_active_generations pointer
           JOIN mv_instances instance
             ON instance.service_id = pointer.service_id
            AND instance.view_id = pointer.view_id
            AND instance.generation = pointer.generation
          WHERE pointer.service_id = ? ORDER BY instance.view_id`,
      ).bind(serviceId).all<Record<string, unknown>>();
      const source = new D1EventStore(database);
      await source.initialize();
      const lowerEvidence = await source.findLateLowerSuidEvidence(serviceId, higherEvent.sortableUniqueIdValue, Math.max(...checkpointFacts.results.map((row) => Number(row.updated_at ?? 0))), 0);
      expect(lowerEvidence).toMatchObject({ kind: "late-lower-suid", event: { eventId: lowerEvent.id } });
      expect(lowerFacts.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ event_id: lowerEvent.id, first_arrived_at: lowerArrival, last_arrived_at: lowerArrival }),
      ]));
      const detectorProbe = await source.findLateLowerSuid(
        serviceId,
        higherEvent.sortableUniqueIdValue,
        Math.max(...checkpointFacts.results.map((row) => Number(row.updated_at ?? 0))),
      );
      expect(detectorProbe).toBeDefined();
      // Production safe-lane triggers deliberately keep the detector off the
      // hot path. Exercise the retained WAKE-166 fail-closed proof through an
      // explicit isolated scheduled-maintenance detector invocation instead;
      // this keeps the guard real without making the production pass pay the
      // detector cost.
      let lowerError = "";
      try {
        await runMeetingRoomSafeLanePass(passEnvironment, serviceId, "cron", undefined, {
          passId: `g69-lower:${crypto.randomUUID()}`,
          scheduledAt: lowerArrival,
          trigger: "cron",
          owner: {
            eventId: lowerEvent.id,
            suid: lowerEvent.sortableUniqueIdValue,
            attemptId: lowerMessages[0]!.attemptId,
            partitionTag: lowerMessages[0]!.tag,
            obligationSequence: lowerMessages[0]!.completeness.obligationSequence,
          },
        });
      } catch (error) {
        lowerError = error instanceof Error ? error.message : String(error);
      }
      if (lowerError.length === 0) {
        try {
          await catchUpMeetingRoomMaterializedViews(passEnvironment, serviceId, undefined, {
            runOrderingDetector: true,
          });
        } catch (error) {
          lowerError = error instanceof Error ? error.message : String(error);
        }
      }
      const lowerPasses = await database.prepare(
        `SELECT catch_up_outcome, catch_up_error, catch_up_result_json, stop_reason
           FROM serialized_dcb_safe_lane_passes
          WHERE service_id = ? ORDER BY scheduled_at ASC, pass_id ASC`,
      ).bind(serviceId).all<Record<string, unknown>>();
      expect(lowerPasses.results.length).toBeGreaterThanOrEqual(2);
      // Queue delivery schedules its own non-blocking safe-lane kick. The
      // explicit proof pass and that kick may race, so the latest row is not
      // the ordering oracle. The durable quarantine/incident is the oracle;
      // at least one pass must expose the typed fail-closed boundary when the
      // race is serialized through the catch-up body.
      expect(lowerError).toContain("quarantined");

      const incident = await database.prepare(
        `SELECT classification, identity_key, event_id, incoming_event_id, suid
           FROM serialized_dcb_delivery_incidents
          WHERE service_id = ? AND classification = 'ORDER_VIOLATION'
          ORDER BY observed_at DESC LIMIT 1`,
      ).bind(serviceId).first<Record<string, unknown>>();
      expect(incident).toMatchObject({
        classification: "ORDER_VIOLATION",
        event_id: lowerEvent.id,
        incoming_event_id: lowerEvent.id,
        suid: lowerEvent.sortableUniqueIdValue,
      });
      expect(String(incident?.identity_key)).toContain(`LATE_LOWER_SUID|${serviceId}`);

      const quarantine = await materializedViews().prepare(
        `SELECT service_id, view_id, generation, checkpoint_suid, late_suid, event_id,
                classification, status
           FROM mv_ordering_quarantines
          WHERE service_id = ? ORDER BY generation DESC LIMIT 1`,
      ).bind(serviceId).first<Record<string, unknown>>();
      expect(quarantine).toMatchObject({
        service_id: serviceId,
        checkpoint_suid: higherEvent.sortableUniqueIdValue,
        late_suid: lowerEvent.sortableUniqueIdValue,
        event_id: lowerEvent.id,
        classification: "LATE_LOWER_SUID",
        status: "open",
      });

      await settleDiagnosticReceipts();
      const receiptRows = await database.prepare(
        `SELECT delivery_source, queue_message_id, attempt_id, receipt_status, first_arrived_at_before,
                first_arrived_at_after, last_arrived_at_after, clock_origin
           FROM serialized_dcb_g69_admission_attempts
          WHERE service_id = ?
          ORDER BY sequence ASC`,
      ).bind(serviceId).all<Record<string, unknown>>();
      expect(receiptRows.results.length).toBeGreaterThanOrEqual(4);
      expect(receiptRows.results.every((row) => row.delivery_source === "queue")).toBe(true);
      expect(receiptRows.results.every((row) => typeof row.queue_message_id === "string" && row.queue_message_id.length > 0)).toBe(true);
      expect(receiptRows.results.every((row) => row.attempt_id !== row.queue_message_id)).toBe(true);
      expect(receiptRows.results.every((row) => row.clock_origin === "Date.now epoch ms")).toBe(true);
      expect(receiptRows.results.some((row) => row.receipt_status === "stored")).toBe(true);
      console.log(`G69_ORDERING_PROOF ${JSON.stringify({
        serviceId,
        lowerAllocatedBeforeHigherCommit: true,
        higherSuid: higherEvent.sortableUniqueIdValue,
        lowerSuid: lowerEvent.sortableUniqueIdValue,
        higherSafeBeforeLowerAdmission: higherSafe,
        lowerFirstArrivedAt: lowerFacts.results.find((row) => row.event_id === lowerEvent.id)?.first_arrived_at ?? null,
        checkpointUpdatedAt: checkpointFacts.results.map((row) => row.updated_at),
        detector: "LATE_LOWER_SUID",
        lowerError,
      })}`);
    } finally {
      // The lower allocation is intentionally appended only after the higher
      // Tag/D1 path has run; there is no held Promise or cleanup mutation.
    }
  });

  it("updates the lag estimate and keeps every delivery attempt append-only", async () => {
    const database = pipeline();
    const serviceId = `g69-lag-${crypto.randomUUID()}`;
    const tag = `room:g69-lag-${crypto.randomUUID()}`;
    const base = {
      serviceId,
      allocatorLineageId: `g69-lag-lineage-${crypto.randomUUID()}`,
      tag,
      eventTags: [tag],
      eventType: "G69LagEvent",
      payload: JSON.stringify({ g69: "lag" }),
      timestamp: "2026-08-22T17:00:00.123Z",
    };
    const high = g32Message({
      ...base,
      attemptId: `g69-lag-high-${crypto.randomUUID()}`,
      eventId: g32EventId(`g69-lag-high-${crypto.randomUUID()}`),
      suid: g32Suid(20),
      enqueuedAt: 1_000,
    });
    const lower = g32Message({
      ...base,
      attemptId: `g69-lag-lower-${crypto.randomUUID()}`,
      eventId: g32EventId(`g69-lag-lower-${crypto.randomUUID()}`),
      suid: g32Suid(10),
      enqueuedAt: 9_000,
    });
    const store = new D1EventStore(database);
    await store.initialize();
    await expect(store.recordDelivery(high, 2_000, "queue")).resolves.toMatchObject({ outcome: "stored" });
    await expect(store.recordDelivery(lower, 10_000, "queue")).resolves.toMatchObject({ outcome: "stored" });
    await expect(store.recordDelivery(lower, 11_000, "queue")).resolves.toMatchObject({ outcome: "stored" });
    // A replay with a decreasing observed clock preserves FirstArrivedAt as
    // the durable minimum while LastArrivedAt remains the observed maximum.
    await expect(store.recordDelivery(lower, 9_000, "queue")).resolves.toMatchObject({ outcome: "stored", duplicate: true });
    await settleDiagnosticReceipts();
    const lag = await database.prepare(
      `SELECT estimate_ms, observed_at FROM serialized_dcb_lag_estimates WHERE service_id = ?`,
    ).bind(serviceId).first<Record<string, unknown>>();
    // A lower-SUID delivery must not make the public lag estimate forget the
    // existing higher-SUID backlog. This is the pre-G69 fail-closed rule.
    expect(lag).toMatchObject({ estimate_ms: 1_000, observed_at: 2_000 });
    const receipts = await database.prepare(
      `SELECT COUNT(*) AS count, MIN(first_arrived_at_before) AS first_before,
              MAX(last_arrived_at_after) AS last_after,
              MAX(diagnostic_duration_ms) AS diagnostic_duration_ms
         FROM serialized_dcb_g69_admission_attempts WHERE service_id = ?`,
      ).bind(serviceId).first<Record<string, unknown>>();
    expect(receipts).toMatchObject({ count: 4, last_after: 11_000 });
    expect(receipts?.first_before ?? null).toBe(null);
    expect(Number(receipts?.diagnostic_duration_ms)).toBeGreaterThanOrEqual(0);
    console.log("G69_HOTPATH_COSTS", JSON.stringify({
      diagnosticDurationMs: Number(receipts?.diagnostic_duration_ms),
    }));
    const lowerOps = await database.prepare(
      `SELECT "FirstArrivedAt" AS first_arrived_at, "LastArrivedAt" AS last_arrived_at
         FROM dcb_event_ops WHERE "ServiceId" = ? AND "Id" = ?`,
    ).bind(serviceId, lower.eventId).first<Record<string, unknown>>();
    expect(lowerOps).toMatchObject({ first_arrived_at: 9_000, last_arrived_at: 11_000 });
  });

  it("retains the PR-base incoming observed clock for a newer-SUID lag sample", async () => {
    const database = pipeline();
    const serviceId = `g69-lag-clock-${crypto.randomUUID()}`;
    const tag = `room:g69-lag-clock-${crypto.randomUUID()}`;
    const lineage = `g69-lag-clock-lineage-${crypto.randomUUID()}`;
    const message = (label: string, suid: number): DownstreamOutboxMessage => g32Message({
      serviceId,
      allocatorLineageId: lineage,
      tag,
      eventTags: [tag],
      eventType: "G69LagClockEvent",
      payload: JSON.stringify({ label }),
      eventId: `g69-lag-clock-${label}-${crypto.randomUUID()}`,
      suid: g32Suid(suid),
      attemptId: `g69-lag-clock-attempt-${label}-${crypto.randomUUID()}`,
      enqueuedAt: 0,
    });
    const first = new D1EventStore(database);
    await first.initialize();
    await expect(first.recordDelivery(message("first", 10), 5_000, "queue")).resolves.toMatchObject({ outcome: "stored" });
    await expect(first.recordDelivery(message("newer", 20), 1_000, "queue")).resolves.toMatchObject({ outcome: "stored" });
    const lag = await database.prepare(
      `SELECT estimate_ms, observed_at FROM serialized_dcb_lag_estimates WHERE service_id = ?`,
    ).bind(serviceId).first<Record<string, unknown>>();
    // This is the unchanged PR-base estimator contract: the estimate remains
    // the high sample, while the incoming observed clock is authoritative.
    expect(lag).toMatchObject({ estimate_ms: 5_000, observed_at: 1_000 });
  });

  it("runs the late-lower detector once per catch-up pass, not once per event", async () => {
    const database = pipeline();
    const serviceId = `g69-detector-cost-${crypto.randomUUID()}`;
    const tag = `room:g69-detector-cost-${crypto.randomUUID()}`;
    const lineage = `g69-detector-cost-lineage-${crypto.randomUUID()}`;
    const messages = [1, 2, 3].map((ordinal) => g32Message({
      serviceId,
      allocatorLineageId: lineage,
      tag,
      eventTags: [tag],
      eventType: "G69DetectorCostEvent",
      payload: JSON.stringify({ detector: "cost" }),
      eventId: `g69-detector-cost-${ordinal}-${crypto.randomUUID()}`,
      suid: g32Suid(ordinal),
      attemptId: `g69-detector-cost-attempt-${ordinal}-${crypto.randomUUID()}`,
    }));
    const source = new D1EventStore(database);
    await source.initialize();
    let detectorCalls = 0;
    const originalDetector = source.findLateLowerSuidEvidence.bind(source);
    source.findLateLowerSuidEvidence = async (...args) => {
      detectorCalls += 1;
      return originalDetector(...args);
    };
    const views = new D1MaterializedViewStore(materializedViews());
    await views.initialize();
    const runtime = new MaterializedViewCatchUpRuntime(source, views);
    const materializer = defineRowMaterializer<StoredEvent>({
      id: "G69DetectorCostProjector",
      version: 1,
      indexDescriptors: [],
      materialize: (event) => ({ rowUpserts: [{ rowKey: event.eventId, value: { suid: event.suid } }] }),
    });
    await source.recordDelivery(messages[0]!, 0, "queue");
    await runtime.build(serviceId, materializer, 100_000);
    await source.recordDelivery(messages[1]!, 0, "queue");
    await source.recordDelivery(messages[2]!, 0, "queue");
    const result = await runtime.follow(serviceId, materializer, 100_000, {}, { runOrderingDetector: true });
    expect(result.advancedSourceEvents).toBe(2);
    expect(detectorCalls).toBe(1);
    expect(result.lateLowerQueryDurationMs).toBeGreaterThanOrEqual(0);
    console.log("G69_HOTPATH_COSTS", JSON.stringify({
      detectorCalls,
      lateLowerQueryDurationMs: result.lateLowerQueryDurationMs,
      advancedSourceEvents: result.advancedSourceEvents,
    }));
  });

  it("drives clock schedules through real MV generations and the public safe reader", async () => {
    const database = pipeline();
    const mv = materializedViews();
    const cases: Array<{
      readonly name: string;
      readonly classification: "miss" | "replay" | "unknown" | "late-lower-suid";
      readonly checkpointSuid: string;
      readonly generation: number;
      readonly quarantine: boolean;
      readonly safeStatus: number;
      readonly unsafeStatus: number;
      readonly error: string | null;
    }> = [];

    const runCase = async (
      name: string,
      arrange: (input: {
        readonly source: D1EventStore;
        readonly views: D1MaterializedViewStore;
        readonly runtime: MaterializedViewCatchUpRuntime;
        readonly serviceId: string;
        readonly higher: DownstreamOutboxMessage;
      }) => Promise<{
        readonly classification: "miss" | "replay" | "unknown" | "late-lower-suid";
        readonly quarantine: boolean;
        readonly expectedCheckpointSuid: string;
        readonly safeStatus: number;
        readonly unsafeStatus: number;
        readonly error: string | null;
      }>,
    ): Promise<void> => {
      const serviceId = `g69-generation-boundary-${name}-${crypto.randomUUID()}`;
      const source = new D1EventStore(database);
      const views = new D1MaterializedViewStore(mv);
      const runtime = new MaterializedViewCatchUpRuntime(source, views);
      await source.initialize();
      await views.initialize();
      const higher = generationMessage(serviceId, 20, `${name}-higher`);
      await expect(source.recordDelivery(higher, 100_000, "queue")).resolves.toMatchObject({ outcome: "stored" });
      // The logical clock is deliberately beyond the unchanged 20-second
      // SafeWindow floor so generation application, not a detector-only
      // shortcut, establishes the real checkpoint used by each case.
      const built = await runtime.build(serviceId, reservationMaterializer, 200_000, {}, { runOrderingDetector: true });
      expect(built.instance.generation).toBe(0);
      expect(built.instance.lastSuid).toBe(higher.suid);

      const outcome = await arrange({ source, views, runtime, serviceId, higher });
      const active = await views.readActive(serviceId, reservationMaterializer.id);
      expect(active).toBeDefined();
      const detector = await source.findLateLowerSuidEvidence(
        serviceId,
        higher.suid,
        active?.updatedAt ?? 0,
        active?.generation,
      );
      const quarantine = await views.readOrderingQuarantine(serviceId, reservationMaterializer.id);
      const safe = await publicGenerationRead(serviceId, mv, "safe");
      const unsafe = await publicGenerationRead(serviceId, mv, "unsafe");
      expect(active?.generation).toBe(0);
      expect(active?.lastSuid).toBe(outcome.expectedCheckpointSuid);
      expect(detector.kind).toBe(outcome.classification);
      expect(quarantine !== undefined).toBe(outcome.quarantine);
      expect(safe.status).toBe(outcome.safeStatus);
      expect(unsafe.status, `${name} unsafe response: ${await unsafe.clone().text()}`).toBe(outcome.unsafeStatus);
      if (outcome.quarantine) {
        await expect(safe.json()).resolves.toMatchObject({ code: "projection_ordering_quarantined" });
      }
      cases.push({
        name,
        classification: detector.kind,
        checkpointSuid: active?.lastSuid ?? "",
        generation: active?.generation ?? -1,
        quarantine: quarantine !== undefined,
        safeStatus: safe.status,
        unsafeStatus: unsafe.status,
        error: outcome.error,
      });
    };

    await runCase("captured-before-admission", async ({ source, runtime, serviceId, higher }) => {
      // The lower event's observed arrival is before the checkpoint's actual
      // generation application. It is admitted after the application only to
      // exercise the detector against the durable generation timestamp.
      const lower = generationMessage(serviceId, 10, "captured-before-admission-lower");
      await source.recordDelivery(lower, 199_000, "queue");
      await runtime.follow(serviceId, reservationMaterializer, 220_000, {}, { runOrderingDetector: true });
      return { classification: "miss", quarantine: false, expectedCheckpointSuid: higher.suid, safeStatus: 200, unsafeStatus: 200, error: null };
    });

    await runCase("equal-millisecond", async ({ source, runtime, serviceId, higher }) => {
      const lower = generationMessage(serviceId, 10, "equal-millisecond-lower");
      await source.recordDelivery(lower, 200_000, "queue");
      await runtime.follow(serviceId, reservationMaterializer, 220_000, {}, { runOrderingDetector: true });
      return { classification: "miss", quarantine: false, expectedCheckpointSuid: higher.suid, safeStatus: 200, unsafeStatus: 200, error: null };
    });

    await runCase("checkpoint-overwrite", async ({ source, runtime, serviceId }) => {
      const lower = generationMessage(serviceId, 10, "checkpoint-overwrite-lower");
      const later = generationMessage(serviceId, 30, "checkpoint-overwrite-later");
      await source.recordDelivery(lower, 199_000, "queue");
      await source.recordDelivery(later, 210_000, "queue");
      const followed = await runtime.follow(serviceId, reservationMaterializer, 400_000, {}, { runOrderingDetector: true });
      expect(followed.instance.lastSuid).toBe(later.suid);
      return { classification: "miss", quarantine: false, expectedCheckpointSuid: later.suid, safeStatus: 200, unsafeStatus: 200, error: null };
    });

    await runCase("decreasing-replay", async ({ source, runtime, serviceId, higher }) => {
      const lower = generationMessage(serviceId, 10, "decreasing-replay-lower");
      await source.recordDelivery(lower, 199_000, "queue");
      await source.recordDelivery(lower, 210_000, "queue");
      await runtime.follow(serviceId, reservationMaterializer, 230_000, {}, { runOrderingDetector: true });
      return { classification: "replay", quarantine: false, expectedCheckpointSuid: higher.suid, safeStatus: 200, unsafeStatus: 200, error: null };
    });

    await runCase("clock-rollback", async ({ source, runtime, serviceId, higher }) => {
      const lower = generationMessage(serviceId, 10, "clock-rollback-lower");
      await source.recordDelivery(lower, 199_000, "queue");
      await database.prepare(
        `UPDATE dcb_event_ops
            SET "FirstArrivedAt" = ?, "LastArrivedAt" = ?,
                "FirstArrivedSource" = 'queue', "LastArrivedSource" = 'queue'
          WHERE "ServiceId" = ? AND "Id" = ?`,
      ).bind(199_000, 198_000, serviceId, lower.eventId).run();
      await runtime.follow(serviceId, reservationMaterializer, 230_000, {}, { runOrderingDetector: true });
      const incident = await database.prepare(
        `SELECT classification FROM serialized_dcb_delivery_incidents
          WHERE service_id = ? AND classification = 'ORDERING_DETECTOR_UNKNOWN'
          ORDER BY observed_at DESC LIMIT 1`,
      ).bind(serviceId).first<{ classification?: unknown }>();
      expect(incident?.classification).toBe("ORDERING_DETECTOR_UNKNOWN");
      return { classification: "unknown", quarantine: false, expectedCheckpointSuid: higher.suid, safeStatus: 200, unsafeStatus: 200, error: null };
    });

    await runCase("late-lower-control", async ({ source, runtime, serviceId, higher, views }) => {
      const lower = generationMessage(serviceId, 10, "late-lower-control");
      await source.recordDelivery(lower, 202_000, "queue");
      let error: string | null = null;
      try {
        await runtime.follow(serviceId, reservationMaterializer, 230_000, {}, { runOrderingDetector: true });
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      expect(error).toContain("quarantined");
      const active = await views.readActive(serviceId, reservationMaterializer.id);
      expect(active?.lastSuid).toBe(higher.suid);
      return { classification: "late-lower-suid", quarantine: true, expectedCheckpointSuid: higher.suid, safeStatus: 503, unsafeStatus: 200, error };
    });

    expect(cases).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "captured-before-admission", generation: 0, quarantine: false, safeStatus: 200, unsafeStatus: 200 }),
      expect.objectContaining({ name: "equal-millisecond", generation: 0, quarantine: false, safeStatus: 200, unsafeStatus: 200 }),
      expect.objectContaining({ name: "checkpoint-overwrite", generation: 0, quarantine: false, safeStatus: 200, unsafeStatus: 200 }),
      expect.objectContaining({ name: "decreasing-replay", classification: "replay", generation: 0, quarantine: false, safeStatus: 200, unsafeStatus: 200 }),
      expect.objectContaining({ name: "clock-rollback", classification: "unknown", generation: 0, quarantine: false, safeStatus: 200, unsafeStatus: 200 }),
      expect.objectContaining({ name: "late-lower-control", classification: "late-lower-suid", generation: 0, quarantine: true, safeStatus: 503, unsafeStatus: 200 }),
    ]));
    console.log("G69_REAL_GENERATION_PUBLIC_PROOF", JSON.stringify(cases));
  });

  it("returns core admission while the bounded diagnostic receipt is still pending", async () => {
    const database = pipeline();
    const serviceId = `g69-nonblocking-${crypto.randomUUID()}`;
    const tag = `room:g69-nonblocking-${crypto.randomUUID()}`;
    const message = g32Message({
      serviceId,
      tag,
      eventId: g32EventId(`g69-nonblocking-event-${crypto.randomUUID()}`),
      suid: g32Suid("g69-nonblocking"),
      allocatorLineageId: `g69-nonblocking-lineage-${crypto.randomUUID()}`,
    });
    let releaseReceipt: (() => void) | undefined;
    const receiptGate = new Promise<void>((resolve) => { releaseReceipt = resolve; });
    const store = new D1EventStore(database, {
      beforeG69AdmissionAttempt: async () => receiptGate,
    });
    await store.initialize();
    const receiptPromises: Promise<void>[] = [];
    const queueMessageId = `queue-wrapper:${message.attemptId}`;
    const outcome = await Promise.race([
      store.recordDelivery(message, 2_000, "queue", {
        queueMessageId,
        waitUntil: (promise) => receiptPromises.push(promise),
      }).then(() => "core-returned" as const),
      new Promise<"receipt-blocked">((resolve) => setTimeout(() => resolve("receipt-blocked"), 500)),
    ]);
    expect(outcome).toBe("core-returned");
    expect(receiptPromises).toHaveLength(1);
    releaseReceipt?.();
    await receiptPromises[0];
  });

  it("keeps diagnostic failure best-effort, identifies concurrent/replayed delivery, and bounds retention", async () => {
    const database = pipeline();
    const serviceId = `g69-receipt-lifecycle-${crypto.randomUUID()}`;
    const message = g32Message({
      serviceId,
      tag: `room:g69-receipt-lifecycle-${crypto.randomUUID()}`,
      eventId: g32EventId(`g69-receipt-failure-${crypto.randomUUID()}`),
      suid: g32Suid(700),
      allocatorLineageId: `g69-receipt-lineage-${crypto.randomUUID()}`,
    });
    const failingStore = new D1EventStore(database, {
      beforeG69AdmissionAttempt: async () => { throw new Error("diagnostic-failure-fixture"); },
    });
    await failingStore.initialize();
    await expect(failingStore.recordDelivery(message, 7_000, "queue")).resolves.toMatchObject({ outcome: "stored" });
    await expect(database.prepare(
      `SELECT COUNT(*) AS count FROM serialized_dcb_g69_admission_attempts WHERE service_id = ?`,
    ).bind(serviceId).first<Record<string, unknown>>()).resolves.toMatchObject({ count: 1 });

    const store = new D1EventStore(database);
    await store.initialize();
    const diagnosticPromises: Promise<void>[] = [];
    const concurrentResults = await Promise.all([
      store.recordDelivery(message, 7_001, "queue", { queueMessageId: "queue-concurrent-a", waitUntil: (promise) => diagnosticPromises.push(promise) }),
      store.recordDelivery(message, 7_002, "queue", { queueMessageId: "queue-concurrent-b", waitUntil: (promise) => diagnosticPromises.push(promise) }),
    ]);
    await store.recordDelivery(message, 7_003, "queue", { queueMessageId: "queue-replay", waitUntil: (promise) => diagnosticPromises.push(promise) });
    await Promise.all(diagnosticPromises);
    expect(concurrentResults.every((result) => result.outcome === "stored")).toBe(true);
    const lifecycleRows = await database.prepare(
      `SELECT queue_message_id, attempt_id, receipt_status, observation_consistency,
              mutation_evidence, diagnostic_duration_ms
         FROM serialized_dcb_g69_admission_attempts
        WHERE service_id = ? ORDER BY sequence`,
    ).bind(serviceId).all<Record<string, unknown>>();
    expect(lifecycleRows.results).toHaveLength(4);
    expect(lifecycleRows.results.map((row) => row.queue_message_id)).toEqual([
      null, "queue-concurrent-a", "queue-concurrent-b", "queue-replay",
    ]);
    expect(lifecycleRows.results.every((row) => row.attempt_id !== row.queue_message_id)).toBe(true);
    expect(lifecycleRows.results.every((row) => row.observation_consistency !== undefined)).toBe(true);
    expect(lifecycleRows.results.every((row) => row.mutation_evidence !== undefined)).toBe(true);
    expect(lifecycleRows.results.every((row) => Number(row.diagnostic_duration_ms) >= 0)).toBe(true);

    const retentionServiceId = `g69-retention-${crypto.randomUUID()}`;
    const retentionReceipt: G69AdmissionAttemptReceipt = {
      serviceId: retentionServiceId,
      eventId: message.eventId,
      suid: message.suid,
      tag: message.tag,
      deliverySource: "queue",
      queueMessageId: "queue-retention",
      attemptId: message.attemptId,
      allocatorLineageId: message.allocatorLineageId,
      obligationSequence: 1,
      enqueuedAt: 1,
      observedAt: 1,
      arrivedAt: 1,
      firstArrivedAtBefore: null,
      lastArrivedAtBefore: null,
      firstArrivedAtAfter: 1,
      lastArrivedAtAfter: 1,
      beforeObservedAt: 1,
      afterObservedAt: 1,
      observationConsistency: "before-admission-absent",
      mutationEvidence: "unverified",
      diagnosticDurationMs: 0,
      status: "stored",
      retryReason: null,
    };
    for (let index = 0; index < 513; index += 1) {
      await appendG69AdmissionAttempt(database, {
        ...retentionReceipt,
        eventId: `${message.eventId.slice(0, -3)}${String(index).padStart(3, "0")}`,
        attemptId: `retention-attempt-${index}`,
        observedAt: index + 1,
      });
    }
    await expect(database.prepare(
      `SELECT COUNT(*) AS count,
              MIN(attempt_id) AS oldest_attempt,
              SUM(CASE WHEN attempt_id = 'retention-attempt-0' THEN 1 ELSE 0 END) AS dropped_oldest
         FROM serialized_dcb_g69_admission_attempts WHERE service_id = ?`,
    ).bind(retentionServiceId).first<Record<string, unknown>>()).resolves.toMatchObject({ count: 512, oldest_attempt: "retention-attempt-1", dropped_oldest: 0 });
  });

  it("excludes equal-ms, delayed-admission, overwrite, replay, rollback, import, and generation false positives", async () => {
    const database = pipeline();
    const serviceId = `g69-false-positive-${crypto.randomUUID()}`;
    const tag = `room:g69-false-positive-${crypto.randomUUID()}`;
    const lineage = `g69-false-positive-lineage-${crypto.randomUUID()}`;
    const message = (label: string, ordinal: number) => g32Message({
      serviceId,
      tag,
      eventId: g32EventId(`g69-false-positive-${label}-${crypto.randomUUID()}`),
      suid: g32Suid(ordinal),
      allocatorLineageId: lineage,
    });
    const earlier = message("earlier", 10);
    const equalMs = message("equal-ms", 15);
    const delayedAdmission = message("delayed-admission", 11);
    const rollback = message("rollback", 13);
    const checkpoint = message("checkpoint", 20);
    const store = new D1EventStore(database);
    await store.initialize();
    await store.recordDelivery(earlier, 100, "queue");
    // This event was durably admitted before the checkpoint but is replayed
    // later. Its later LastArrivedAt must not turn it into a new witness.
    await store.recordDelivery(delayedAdmission, 120, "queue");
    await store.recordDelivery(checkpoint, 150, "queue");
    // Equal-ms arrival is not strictly after the checkpoint observation.
    await store.recordDelivery(equalMs, 150, "queue");
    await store.recordDelivery(rollback, 800, "queue");

    // Equal-ms and delayed-admission/replay are distinguishable from an
    // ordinary miss. A later checkpoint observation removes every candidate
    // without using authored timestamps as a substitute for arrival clocks.
    await expect(store.findLateLowerSuidEvidence(serviceId, checkpoint.suid, 150, 0)).resolves.toMatchObject({ kind: "late-lower-suid" });
    await expect(store.findLateLowerSuidEvidence(serviceId, checkpoint.suid, 950, 0)).resolves.toMatchObject({ kind: "miss" });

    // A rollback is unknown rather than a guessed refusal.
    await database.prepare(
      `UPDATE dcb_event_ops SET "FirstArrivedAt" = ?, "LastArrivedAt" = ?
        WHERE "ServiceId" = ? AND "Id" = ?`,
    ).bind(800, 700, serviceId, rollback.eventId).run();
    await expect(store.findLateLowerSuidEvidence(serviceId, checkpoint.suid, 150, 0)).resolves.toMatchObject({ kind: "unknown", reason: "arrival-clock-rollback" });

    // Unknown evidence must not short-circuit a later proven violation. The
    // imported row is untrusted, but the Queue row after it is a known late
    // lower-SUID arrival and must win the accumulated detector result.
    const mixedServiceId = `g69-mixed-${crypto.randomUUID()}`;
    const rehome = (value: ReturnType<typeof message>) => ({
      ...value,
      serviceId: mixedServiceId,
      completeness: {
        ...value.completeness,
        localCommittedMembership: value.completeness.localCommittedMembership.map((membership) => ({
          ...membership,
          serviceId: mixedServiceId,
          eventId: value.eventId,
        })),
      },
    });
    const mixedCheckpoint = rehome(message("mixed-checkpoint", 30));
    const mixedUnknown = rehome(message("mixed-import", 12));
    const mixedViolation = rehome(message("mixed-queue", 11));
    await store.recordDelivery(mixedCheckpoint, 100, "queue");
    await store.recordDelivery(mixedUnknown, 200, "import");
    await store.recordDelivery(mixedViolation, 201, "queue");
    await expect(store.findLateLowerSuidEvidence(mixedServiceId, mixedCheckpoint.suid, 150, 1)).resolves.toMatchObject({
      kind: "late-lower-suid",
      event: { eventId: mixedViolation.eventId },
    });
    const importedServiceId = `g69-import-${crypto.randomUUID()}`;
    const importedStore = new D1EventStore(database);
    await importedStore.initialize();
    const importedCheckpoint = g32Message({
      serviceId: importedServiceId,
      tag: `room:g69-import-${crypto.randomUUID()}`,
      eventId: g32EventId(`g69-import-checkpoint-${crypto.randomUUID()}`),
      suid: g32Suid(20),
      allocatorLineageId: `g69-import-lineage-${crypto.randomUUID()}`,
    });
    const importedEvent = g32Message({
      ...importedCheckpoint,
      eventId: g32EventId(`g69-import-event-${crypto.randomUUID()}`),
      suid: g32Suid(12),
    });
    await importedStore.recordDelivery(importedEvent, 500, "import");
    await expect(importedStore.findLateLowerSuidEvidence(importedServiceId, importedCheckpoint.suid, 150, 0)).resolves.toMatchObject({ kind: "unknown", reason: "arrival-provenance-untrusted" });
    // Isolate a genuine replay: the event was observed before the checkpoint
    // and restamped after it, so the detector reports replay rather than a
    // new late-lower allocation witness.
    const replayServiceId = `g69-replay-${crypto.randomUUID()}`;
    const replayStore = new D1EventStore(database);
    await replayStore.initialize();
    const replayCheckpoint = g32Message({
      serviceId: replayServiceId,
      tag: `room:g69-replay-${crypto.randomUUID()}`,
      eventId: g32EventId(`g69-replay-checkpoint-${crypto.randomUUID()}`),
      suid: g32Suid(20),
      allocatorLineageId: `g69-replay-lineage-${crypto.randomUUID()}`,
    });
    const replayEvent = g32Message({
      ...replayCheckpoint,
      eventId: g32EventId(`g69-replay-event-${crypto.randomUUID()}`),
      suid: g32Suid(12),
    });
    await replayStore.recordDelivery(replayEvent, 100, "queue");
    await replayStore.recordDelivery(replayCheckpoint, 150, "queue");
    await replayStore.recordDelivery(replayEvent, 900, "queue");
    await expect(replayStore.findLateLowerSuidEvidence(replayServiceId, replayCheckpoint.suid, 150, 0)).resolves.toMatchObject({ kind: "replay", event: { eventId: replayEvent.eventId } });
    const replayOps = await database.prepare(
      `SELECT "FirstArrivedAt" AS first_arrived_at, "LastArrivedAt" AS last_arrived_at
         FROM dcb_event_ops WHERE "ServiceId" = ? AND "Id" = ?`,
    ).bind(replayServiceId, replayEvent.eventId).first<Record<string, unknown>>();
    expect(replayOps).toMatchObject({ first_arrived_at: 100, last_arrived_at: 900 });
    const views = new D1MaterializedViewStore(materializedViews());
    await views.initialize();
    const recoveryService = `g69-generation-${crypto.randomUUID()}`;
    const recoveryEvent = g32Message({
      serviceId: recoveryService,
      tag: `room:g69-recovery-${crypto.randomUUID()}`,
      eventId: g32EventId(`g69-recovery-event-${crypto.randomUUID()}`),
      suid: g32Suid("g69-recovery"),
      allocatorLineageId: `g69-recovery-lineage-${crypto.randomUUID()}`,
    });
    const recoverySource = new D1EventStore(database);
    await recoverySource.initialize();
    await recoverySource.recordDelivery(recoveryEvent, 1, "queue");
    await views.createActive({ serviceId: recoveryService, viewId: "RoomProjector", definitionVersion: 1, updatedAt: 1 });
    await views.recordOrderingQuarantine({
      serviceId: recoveryService,
      viewId: "RoomProjector",
      generation: 0,
      checkpointSuid: g32Suid("g69-recovery-checkpoint"),
      lateSuid: recoveryEvent.suid,
      eventId: recoveryEvent.eventId,
      classification: "LATE_LOWER_SUID",
      observedAt: 2,
    });
    const emptyRebuildMaterializer = defineRowMaterializer<StoredEvent>({
      id: "RoomProjector",
      version: 1,
      indexDescriptors: [],
      materialize: () => ({ rowDeletes: [{ rowKey: "not-present" }] }),
    });
    await views.createCandidate({ serviceId: recoveryService, viewId: "RoomProjector", generation: 1, definitionVersion: 1, updatedAt: 3 });
    await expect(views.promoteGeneration({ serviceId: recoveryService, viewId: "RoomProjector", candidateGeneration: 1, expectedActiveGeneration: 0, updatedAt: 4 })).rejects.toMatchObject({ code: "MV_PROMOTION_CAS_MISMATCH" });
    await expect(views.readOrderingQuarantine(recoveryService, "RoomProjector")).resolves.toMatchObject({ status: "open" });
    // A fabricated/nonempty marker cannot substitute for the real rebuild
    // path: the proof must contain the offending event history and generation.
    await expect(views.markGenerationRebuilt({
      serviceId: recoveryService,
      viewId: "RoomProjector",
      generation: 1,
      verifiedAt: 4,
      rebuildId: "fabricated",
      sourceEventCount: 1,
      sourceEventIds: [],
      sourceSuids: [],
      sourceMaxSuid: recoveryEvent.suid,
      sourceHistoryDigest: "fabricated-digest",
    })).rejects.toMatchObject({ code: "MV_REBUILD_NOT_VERIFIED" });
    const catchUp = new MaterializedViewCatchUpRuntime(recoverySource, views);
    const staleProof = await catchUp.rebuild(recoveryService, emptyRebuildMaterializer, 100_000, "recovery-stale-proof");
    const staleCandidate = await views.readInstance(recoveryService, "RoomProjector", staleProof.candidateGeneration);
    expect(staleCandidate?.rebuildVerifiedAt).not.toBeNull();
    await views.applyMutationsAndAdvanceCheckpoint({
      serviceId: recoveryService,
      viewId: "RoomProjector",
      generation: staleProof.candidateGeneration,
      expectedLastSuid: recoveryEvent.suid,
      lastSuid: recoveryEvent.suid,
      definitionVersion: 1,
      updatedAt: 100_001,
      mutations: { rowUpserts: [], rowPatches: [], rowDeletes: [], indexEntries: [], indexDeletes: [] },
    });
    await expect(views.promoteGeneration({
      serviceId: recoveryService,
      viewId: "RoomProjector",
      candidateGeneration: staleProof.candidateGeneration,
      expectedActiveGeneration: 0,
      updatedAt: 100_002,
    })).rejects.toMatchObject({ code: "MV_PROMOTION_CAS_MISMATCH" });

    // A second run through the real source-history/rebuild path produces a
    // durable incident-bound proof. Empty output is valid when the complete
    // materializer intentionally deletes a missing row.
    const rebuilt = await catchUp.rebuild(recoveryService, emptyRebuildMaterializer, 100_003, "recovery-complete");
    await catchUp.promote(recoveryService, emptyRebuildMaterializer as MaterializedViewRowMaterializer, rebuilt.candidateGeneration, 100_004);
    await expect(views.readOrderingQuarantine(recoveryService, "RoomProjector")).resolves.toBeUndefined();
    await expect(views.readListPage(recoveryService, "RoomProjector", { consistency: "safe", limit: null })).resolves.toMatchObject({ rows: [], readHead: recoveryEvent.suid });
    const resolved = await materializedViews().prepare(
      `SELECT status, resolved_at FROM mv_ordering_quarantines WHERE service_id = ? AND generation = 0`,
    ).bind(recoveryService).first<Record<string, unknown>>();
    expect(resolved?.status).toBe("resolved");
    expect(Number(resolved?.resolved_at)).toBe(100_004);
  });
});
