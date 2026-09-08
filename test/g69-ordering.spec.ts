import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
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
import { D1EventStore, D1MaterializedViewStore } from "../packages/dcb-runtime/src/d1";
import { appendG69AdmissionAttempt, type G69AdmissionAttemptReceipt } from "../packages/dcb-runtime/src/diagnostics/G69AdmissionAttempt";
import { handleDownstreamQueue } from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { scopeIdFor } from "../packages/dcb-runtime/src/cloudflare";
import { runMeetingRoomSafeLanePass } from "../samples/meeting-room/src/worker.cloudflare-only";
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

beforeAll(async () => {
  const database = pipeline();
  await database.batch(statements(database, pipelineMigration as string));
  await applyG44D1Migration(database);
  const mv = materializedViews();
  for (const migration of [mvMigration, unsafeMvMigration, hardeningMvMigration, unsafeFailureMvMigration, g31WaitReceiptMigration, g31WaitPoisonMigration, orderingQuarantineMigration, rebuildVerificationMigration]) {
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
      const lowerEvidence = await source.findLateLowerSuidEvidence(serviceId, higherEvent.sortableUniqueIdValue, Math.max(...checkpointFacts.results.map((row) => Number(row.updated_at ?? 0))));
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
      let lowerError = "";
      try {
        await runMeetingRoomSafeLanePass(passEnvironment, serviceId, "delivery", undefined, {
          passId: `g69-lower:${crypto.randomUUID()}`,
          scheduledAt: lowerArrival,
          trigger: "delivery",
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
    expect(lag).toMatchObject({ estimate_ms: 2_000, observed_at: 11_000 });
    const receipts = await database.prepare(
      `SELECT COUNT(*) AS count, MIN(first_arrived_at_before) AS first_before,
              MAX(last_arrived_at_after) AS last_after
         FROM serialized_dcb_g69_admission_attempts WHERE service_id = ?`,
    ).bind(serviceId).first<Record<string, unknown>>();
    expect(receipts).toMatchObject({ count: 4, first_before: 10_000, last_after: 11_000 });
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
    ).bind(serviceId).first<Record<string, unknown>>()).resolves.toMatchObject({ count: 0 });

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
      `SELECT queue_message_id, attempt_id, receipt_status, observation_consistency
         FROM serialized_dcb_g69_admission_attempts
        WHERE service_id = ? ORDER BY sequence`,
    ).bind(serviceId).all<Record<string, unknown>>();
    expect(lifecycleRows.results).toHaveLength(3);
    expect(lifecycleRows.results.map((row) => row.queue_message_id)).toEqual([
      "queue-concurrent-a", "queue-concurrent-b", "queue-replay",
    ]);
    expect(lifecycleRows.results.every((row) => row.attempt_id !== row.queue_message_id)).toBe(true);
    expect(lifecycleRows.results.every((row) => row.observation_consistency !== undefined)).toBe(true);

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
      observationConsistency: "before-core-absent",
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
    await expect(store.findLateLowerSuidEvidence(serviceId, checkpoint.suid, 150)).resolves.toMatchObject({ kind: "late-lower-suid" });
    await expect(store.findLateLowerSuidEvidence(serviceId, checkpoint.suid, 950)).resolves.toMatchObject({ kind: "miss" });

    // A rollback is unknown rather than a guessed refusal.
    await database.prepare(
      `UPDATE dcb_event_ops SET "FirstArrivedAt" = ?, "LastArrivedAt" = ?
        WHERE "ServiceId" = ? AND "Id" = ?`,
    ).bind(800, 700, serviceId, rollback.eventId).run();
    await expect(store.findLateLowerSuidEvidence(serviceId, checkpoint.suid, 150)).resolves.toMatchObject({ kind: "unknown", reason: "arrival-clock-rollback" });
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
    await expect(importedStore.findLateLowerSuidEvidence(importedServiceId, importedCheckpoint.suid, 150)).resolves.toMatchObject({ kind: "unknown", reason: "arrival-provenance-untrusted" });
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
    await expect(replayStore.findLateLowerSuidEvidence(replayServiceId, replayCheckpoint.suid, 150)).resolves.toMatchObject({ kind: "replay", event: { eventId: replayEvent.eventId } });
    const replayOps = await database.prepare(
      `SELECT "FirstArrivedAt" AS first_arrived_at, "LastArrivedAt" AS last_arrived_at
         FROM dcb_event_ops WHERE "ServiceId" = ? AND "Id" = ?`,
    ).bind(replayServiceId, replayEvent.eventId).first<Record<string, unknown>>();
    expect(replayOps).toMatchObject({ first_arrived_at: 100, last_arrived_at: 900 });
    const views = new D1MaterializedViewStore(materializedViews());
    await views.initialize();
    const recoveryService = `g69-generation-${crypto.randomUUID()}`;
    await views.createActive({ serviceId: recoveryService, viewId: "RoomProjector", definitionVersion: 1, updatedAt: 1 });
    await views.recordOrderingQuarantine({
      serviceId: recoveryService,
      viewId: "RoomProjector",
      generation: 0,
      checkpointSuid: checkpoint.suid,
      lateSuid: replayEvent.suid,
      eventId: replayEvent.eventId,
      classification: "LATE_LOWER_SUID",
      observedAt: 2,
    });
    await views.createCandidate({ serviceId: recoveryService, viewId: "RoomProjector", generation: 1, definitionVersion: 1, updatedAt: 3 });
    await expect(views.promoteGeneration({ serviceId: recoveryService, viewId: "RoomProjector", candidateGeneration: 1, expectedActiveGeneration: 0, updatedAt: 4 })).rejects.toMatchObject({ code: "MV_PROMOTION_CAS_MISMATCH" });
    await expect(views.readOrderingQuarantine(recoveryService, "RoomProjector")).resolves.toMatchObject({ status: "open" });
    await materializedViews().prepare(
      `INSERT INTO mv_rows
         (service_id, view_id, generation, row_key, value_json, row_version, source_suid)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      recoveryService,
      "RoomProjector",
      1,
      replayEvent.eventId,
      JSON.stringify({ eventId: replayEvent.eventId, suid: replayEvent.suid }),
      1,
      replayEvent.suid,
    ).run();
    await materializedViews().prepare(
      `UPDATE mv_instances SET last_suid = ? WHERE service_id = ? AND view_id = ? AND generation = ?`,
    ).bind(replayEvent.suid, recoveryService, "RoomProjector", 1).run();
    await views.markGenerationRebuilt({ serviceId: recoveryService, viewId: "RoomProjector", generation: 1, verifiedAt: 4, appliedEvents: 1 });
    await views.promoteGeneration({ serviceId: recoveryService, viewId: "RoomProjector", candidateGeneration: 1, expectedActiveGeneration: 0, updatedAt: 4 });
    await expect(views.readOrderingQuarantine(recoveryService, "RoomProjector")).resolves.toBeUndefined();
    await expect(views.readListPage(recoveryService, "RoomProjector", { consistency: "safe", limit: null })).resolves.toMatchObject({ rows: [{ rowKey: replayEvent.eventId, sourceSuid: replayEvent.suid }] });
    const resolved = await materializedViews().prepare(
      `SELECT status, resolved_at FROM mv_ordering_quarantines WHERE service_id = ? AND generation = 0`,
    ).bind(recoveryService).first<Record<string, unknown>>();
    expect(resolved?.status).toBe("resolved");
    expect(Number(resolved?.resolved_at)).toBe(4);
  });
});
