import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error Vite raw source migration import.
import g32Migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";
// @ts-expect-error Vite raw source import.
import mvMigration from "../migrations/mv/0001_materialized_views.sql?raw";
// @ts-expect-error Vite raw source import.
import unsafeMigration from "../migrations/mv/0002_unsafe_window_materialized_views.sql?raw";
// @ts-expect-error Vite raw source import.
import hardeningMigration from "../migrations/mv/0003_checkpoint_ahead_hardening.sql?raw";
// @ts-expect-error Vite raw source import.
import failureMigration from "../migrations/mv/0004_unsafe_window_failure_findings.sql?raw";
// @ts-expect-error Vite raw source migration import.
import g31WaitReceiptMigration from "../migrations/mv/0005_g31_wait_receipts.sql?raw";
// @ts-expect-error Vite raw source migration import.
import g31WaitPoisonMigration from "../migrations/mv/0006_g31_wait_target_poison.sql?raw";
// @ts-expect-error Vite raw migration imports.
import orderingQuarantineMigration from "../migrations/mv/0007_g69_ordering_quarantine.sql?raw";
// @ts-expect-error Vite raw migration import.
import rebuildVerificationMigration from "../migrations/mv/0008_g69_rebuild_verification.sql?raw";
// @ts-expect-error Vite raw source migration import.
import rebuildProofMigration from "../migrations/mv/0009_g69_rebuild_proof.sql?raw";
import { D1MaterializedViewStore } from "../packages/dcb-runtime/src/mv/MaterializedViewStore";
import { UnsafeWindowMaterializedViewStore } from "../packages/dcb-runtime/src/mv/UnsafeWindowMaterializedView";
import { processDeliveryCore, type DeliveryCoreResult, type DeliveryViewHandler } from "../packages/dcb-runtime/src/downstream/DeliveryCore";
import { globalReceiptAcknowledgement } from "../packages/dcb-runtime/src/completeness/GlobalCompletenessReconciler";
import { D1EventStore } from "../packages/dcb-runtime/src/store/D1EventStore";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { TagDurableObject } from "../packages/dcb-runtime/src/tag/TagDurableObject";
import { g32Message } from "./helpers/g32-fixtures";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";

type Boundary = "none" | "before-record" | "after-pipeline" | "after-k-views" | "after-all-views";

function database(name: "D1" | "D1_MV"): D1Database {
  const value = (env as unknown as Record<string, unknown>)[name];
  if (value === undefined) throw new Error(`G26 integration requires ${name}`);
  return value as D1Database;
}

function statements(databaseValue: D1Database, sql: string): D1PreparedStatement[] {
  return sql.replace(/^\s*--.*$/gm, "").split(";").map((value) => value.trim()).filter(Boolean).map((value) => databaseValue.prepare(value));
}

function tagStorage(): { readonly storage: DurableObjectStorage; readonly values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  const transaction: DurableObjectTransaction = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => { values.set(key, value); },
    delete: async (key: string) => values.delete(key),
    list: async () => new Map(),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  } as unknown as DurableObjectTransaction;
  const storage = {
    get: transaction.get,
    put: transaction.put,
    delete: transaction.delete,
    deleteAll: async () => { values.clear(); },
    list: transaction.list,
    setAlarm: transaction.setAlarm,
    deleteAlarm: transaction.deleteAlarm,
    transaction: async <T>(callback: (txn: DurableObjectTransaction) => Promise<T>) => callback(transaction),
  } as unknown as DurableObjectStorage;
  return { storage, values };
}

function message(suffix: string): DownstreamOutboxMessage {
  const tag = `g26-integration:${suffix}`;
  return g32Message({
    serviceId: `g26-integration-${suffix}`,
    allocatorLineageId: `g26-integration-lineage-${suffix}`,
    tag,
    attemptId: `g26-integration-attempt-${suffix}`,
    eventId: `g26-integration-event-${suffix}`,
    suid: `g26-integration-suid-${suffix}`,
    payload: JSON.stringify({ eventType: "G26Integration", suffix }),
    eventTags: [tag],
    eventType: "G26Integration",
    enqueuedAt: 1_000,
  });
}

function mutation(viewId: string, event: DownstreamOutboxMessage) {
  const rowKey = `${viewId}-row`;
  return {
    rowUpserts: [{ rowKey, value: { eventId: event.eventId, viewId }, rowVersion: 1, sourceSuid: event.suid }],
    rowPatches: [],
    rowDeletes: [],
    indexEntries: [{ indexId: "event-id", valueType: "text" as const, value: event.eventId, rowKey }],
    indexDeletes: [],
  };
}

async function applyCount(mv: D1MaterializedViewStore, serviceId: string, viewId: string, event: DownstreamOutboxMessage): Promise<{ rows: number; indexes: number; receipts: number; markers: number; kicks: number }> {
  const values = await Promise.all([
    database("D1_MV").prepare("SELECT COUNT(*) AS count FROM mv_unsafe_rows WHERE service_id = ? AND view_id = ? AND generation = 0").bind(serviceId, viewId).first<{ count: number }>(),
    database("D1_MV").prepare("SELECT COUNT(*) AS count FROM mv_unsafe_index_entries WHERE service_id = ? AND view_id = ? AND generation = 0").bind(serviceId, viewId).first<{ count: number }>(),
    database("D1_MV").prepare("SELECT COUNT(*) AS count FROM mv_unsafe_receipts WHERE service_id = ? AND view_id = ? AND event_id = ?").bind(serviceId, viewId, event.eventId).first<{ count: number }>(),
    database("D1_MV").prepare("SELECT COUNT(*) AS count FROM mv_unsafe_markers WHERE service_id = ? AND view_id = ? AND generation = 0").bind(serviceId, viewId).first<{ count: number }>(),
    database("D1_MV").prepare("SELECT COUNT(*) AS count FROM mv_unsafe_kicks WHERE service_id = ? AND view_id = ?").bind(serviceId, viewId).first<{ count: number }>(),
  ]);
  void mv;
  return { rows: Number(values[0]?.count), indexes: Number(values[1]?.count), receipts: Number(values[2]?.count), markers: Number(values[3]?.count), kicks: Number(values[4]?.count) };
}

async function runBoundary(boundary: Boundary, options: {
  readonly poisonView?: string;
  readonly findingWriteFailure?: boolean;
  readonly partialSuccessView?: string;
  readonly viewOrder?: readonly string[];
} = {}) {
  const event = message(`${boundary}-${crypto.randomUUID().slice(0, 8)}`);
  const pipeline = database("D1");
  const mv = new D1MaterializedViewStore(database("D1_MV"));
  await mv.initialize();
  const viewIds = ["G26IntegrationHead", "G26IntegrationMiddle", "G26IntegrationTail"];
  for (const viewId of viewIds) {
    await mv.createActive({ serviceId: event.serviceId, viewId, definitionVersion: 1, updatedAt: 1_000 });
  }
  if (options.findingWriteFailure) {
    const recordFinding = mv.recordUnsafeFailureFinding.bind(mv);
    let failed = false;
    mv.recordUnsafeFailureFinding = async (input: Parameters<D1MaterializedViewStore["recordUnsafeFailureFinding"]>[0]) => {
      if (!failed) {
        failed = true;
        throw new Error("G26 injected unsafe finding write failure");
      }
      return recordFinding(input);
    };
  }
  let recordFaulted = false;
  let viewFaulted = false;
  let drainFaulted = false;
  let findingFaulted = false;
  const store = new D1EventStore(pipeline, {
    beforeBatch: (operation, prepared) => {
      if (operation === "recordDelivery" && boundary === "before-record" && !recordFaulted) {
        recordFaulted = true;
        throw new Error("G26 injected cancellation before recordDelivery");
      }
      return prepared;
    },
  });
  const orderedViewIds = options.viewOrder ?? viewIds;
  const invocationCounts = new Map(viewIds.map((viewId) => [viewId, 0]));
  const mutationCounts = new Map(viewIds.map((viewId) => [viewId, 0]));
  let partialFailureInjected = false;
  const afterKCommitted: string[] = [];
  let releaseAfterKFailure!: () => void;
  const afterKFailure = new Promise<void>((resolve) => { releaseAfterKFailure = resolve; });
  let afterKFailureSignalled = false;
  const afterKFast = boundary === "after-k-views"
    ? new UnsafeWindowMaterializedViewStore(database("D1_MV"), {
      beforeApplyBatch: async (input) => {
        if (viewIds.slice(2).includes(input.viewId)) {
          await afterKFailure;
          throw new Error("G26 injected fast failure after receipt prefix commit");
        }
      },
      afterApplyBatch: async (input) => {
        afterKCommitted.push(input.viewId);
        if (afterKCommitted.length === 2 && !afterKFailureSignalled) {
          afterKFailureSignalled = true;
          releaseAfterKFailure();
          throw new Error("G26 injected fast failure after exactly k view receipts");
        }
      },
    })
    : undefined;
  const afterKQueue = boundary === "after-k-views" ? new UnsafeWindowMaterializedViewStore(database("D1_MV")) : undefined;
  const handlers: readonly DeliveryViewHandler[] = orderedViewIds.map((viewId) => ({
    id: viewId,
    apply: async ({ event: stored, source }) => {
      invocationCounts.set(viewId, (invocationCounts.get(viewId) ?? 0) + 1);
      if (options.poisonView === viewId) {
        const poison = new Error(`G26 definition poison ${viewId}`) as Error & { retryable?: boolean };
        poison.retryable = false;
        await mv.recordUnsafeFailureFinding({ serviceId: event.serviceId, viewId, eventId: stored.eventId, suid: stored.suid, observedAt: 1_010 });
        throw poison;
      }
      if (options.partialSuccessView === viewId && source === "fast" && !partialFailureInjected) {
        partialFailureInjected = true;
        await mv.recordUnsafeFailureFinding({ serviceId: event.serviceId, viewId, eventId: stored.eventId, suid: stored.suid, observedAt: 1_010 });
        throw new Error(`G26 partial-success injected failure for ${viewId}`);
      }
      if (boundary === "after-pipeline" && viewId === viewIds[0] && !viewFaulted) {
        viewFaulted = true;
        await mv.recordUnsafeFailureFinding({ serviceId: event.serviceId, viewId, eventId: stored.eventId, suid: stored.suid, observedAt: 1_010 });
        throw new Error("G26 injected cancellation after pipeline commit");
      }
      const unsafe = source === "fast" ? afterKFast ?? mv.unsafeWindow() : afterKQueue ?? mv.unsafeWindow();
      const active = await mv.readActive(event.serviceId, viewId);
      if (active === undefined) throw new Error(`missing active integration view ${viewId}`);
      await unsafe.observeArrival(event.serviceId, viewId, active.generation, stored.eventId, stored.suid);
      try {
        const applied = await unsafe.apply({
          serviceId: event.serviceId,
          viewId,
          generation: active.generation,
          eventId: stored.eventId,
          suid: stored.suid,
          safeHead: active.lastSuid,
          updatedAt: 1_010,
          mutations: mutation(viewId, event),
          targetSuid: stored.suid,
        });
        if (!applied.duplicate) mutationCounts.set(viewId, (mutationCounts.get(viewId) ?? 0) + 1);
        return applied.duplicate ? "duplicate-race" : "applied";
      } catch (error) {
        if (options.findingWriteFailure && !findingFaulted) {
          findingFaulted = true;
          throw new Error(`G26 finding write failed: ${String(error)}`, { cause: error });
        }
        await mv.recordUnsafeFailureFinding({ serviceId: event.serviceId, viewId, eventId: stored.eventId, suid: stored.suid, observedAt: 1_010 });
        throw error;
      }
    },
    classifyError: (error: unknown) => (error as { retryable?: boolean }).retryable === false ? "nonretryable-definition-poison" : "retryable-transient",
  }));

  const directResults: DeliveryCoreResult[] = [];
  const queueResults: DeliveryCoreResult[] = [];
  const queued: DownstreamOutboxMessage[] = [];
  const lifecycle: string[] = [];
  let directEnvelopeBytes: string | undefined;
  const { storage, values } = tagStorage();
  const waits: Promise<unknown>[] = [];
  const ctx = { storage, waitUntil: (promise: Promise<unknown>) => { waits.push(promise); } } as unknown as DurableObjectState;
  const tag = event.tag;
  const tagObject = new TagDurableObject(ctx, {
    // G44 verifies this receipt through the same D1 source of truth before
    // the queue replay can close the Tag-side obligation.
    D1: pipeline,
    AUTO_DRAIN_OUTBOX: "true",
    DOMAIN_DELIVERY_CLASS: "immediate-preferred",
    DIRECT_DOORBELL: "true",
    DIRECT_DOORBELL_ALLOWED_VIEWS: viewIds.join(","),
    DIRECT_DOORBELL_DEGRADATION: "queued-degraded",
    DOWNSTREAM_DOORBELL: {
      deliver: async (envelope: DownstreamOutboxMessage) => {
        lifecycle.push("direct-start");
        directEnvelopeBytes = JSON.stringify(envelope);
        try {
          const result = await processDeliveryCore(envelope, "fast", {}, {
            store,
            views: handlers,
            afterDelivery: async () => {
              if (boundary === "after-all-views" && !drainFaulted) {
                drainFaulted = true;
                throw new Error("G26 injected cancellation after all views");
              }
            },
          });
          directResults.push(result);
          return result;
        } finally {
          lifecycle.push("direct-end");
        }
      },
    },
    DOWNSTREAM_QUEUE: { send: async (envelope: DownstreamOutboxMessage) => { queued.push(envelope); } },
  } as never);
  const response = await tagObject.fetch(new Request(
    `https://tag.test/append?__tag=${encodeURIComponent(tag)}&__serviceId=${event.serviceId}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attemptId: event.attemptId,
        epoch: 0,
        candidates: [{ eventId: event.eventId, suid: event.suid, payload: event.payload, eventType: event.eventType, provenance: "g32", timestamp: event.timestamp, eventTags: event.eventTags, allocatorLineageId: event.allocatorLineageId }],
      }),
    },
  ));
  expect(response.status).toBe(201);
  lifecycle.push("response-returned");
  expect(lifecycle).toEqual(["direct-start", "direct-end", "response-returned"]);
  await Promise.all(waits);
  expect(queued).toHaveLength(1);
  expect(directEnvelopeBytes).toBe(JSON.stringify(queued[0]));
  expect(directResults[0]?.correlationId).toBe(`fast:${event.serviceId}:${event.eventId}:${event.attemptId}`);
  const receiptsBeforeReplay = await Promise.all(viewIds.map(async (viewId) => {
    const receipt = await database("D1_MV").prepare(
      "SELECT COUNT(*) AS count FROM mv_unsafe_receipts WHERE service_id = ? AND view_id = ? AND event_id = ?",
    ).bind(event.serviceId, viewId, event.eventId).first<{ count: number }>();
    return { viewId, count: Number(receipt?.count) };
  }));
  const queueResult = await processDeliveryCore(queued[0]!, "queue", {}, {
    store,
    views: handlers,
    afterGlobalReceipt: async ({ message: delivered, receipt, arrivedAt }) => {
      const acknowledged = await tagObject.fetch(new Request(
        `https://tag.test/outbox/mark-delivered?__tag=${encodeURIComponent(tag)}&__serviceId=${event.serviceId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(globalReceiptAcknowledgement(delivered, receipt.receivedAt || arrivedAt)),
        },
      ));
      if (!acknowledged.ok) throw new Error(`G44 source acknowledgement failed:${acknowledged.status}`);
    },
  });
  queueResults.push(queueResult);
  const deliveries = values.get("outbox-deliveries") as Array<{ deliveredAt: number | null }> | undefined;
  const counts = await Promise.all(viewIds.map((viewId) => applyCount(mv, event.serviceId, viewId, event)));
  const incidents = await pipeline.prepare("SELECT COUNT(*) AS count FROM serialized_dcb_delivery_incidents WHERE service_id = ?").bind(event.serviceId).first<{ count: number }>();
  const arrivals = await pipeline.prepare("SELECT COUNT(*) AS count FROM serialized_dcb_event_arrivals WHERE service_id = ?").bind(event.serviceId).first<{ count: number }>();
  const storedEvents = await pipeline.prepare('SELECT COUNT(*) AS count FROM dcb_events WHERE "ServiceId" = ?').bind(event.serviceId).first<{ count: number }>();
  const findings = await database("D1_MV").prepare("SELECT view_id, event_id, suid FROM mv_unsafe_failure_findings WHERE service_id = ? ORDER BY view_id").bind(event.serviceId).all<{ view_id: string; event_id: string; suid: string }>();
  return {
    event,
    direct: directResults[0],
    directBeforeResponse: lifecycle.indexOf("direct-end") < lifecycle.indexOf("response-returned"),
    queue: queueResults[0],
    receiptsBeforeReplay,
    afterKCommitted,
    invocations: Object.fromEntries(viewIds.map((viewId) => [viewId, invocationCounts.get(viewId) ?? 0])),
    mutations: Object.fromEntries(viewIds.map((viewId) => [viewId, mutationCounts.get(viewId) ?? 0])),
    counts,
    outboxDelivered: deliveries?.every((delivery) => delivery.deliveredAt !== null) ?? false,
    incidents: Number(incidents?.count),
    arrivals: Number(arrivals?.count),
    storedEvents: Number(storedEvents?.count),
    findings: findings.results,
  };
}

describe("SDT-G26 real pipeline/MV/outbox convergence", () => {
  beforeAll(async () => {
    const pipeline = database("D1");
    await pipeline.batch(statements(pipeline, g32Migration as string));
    await applyG44D1Migration(pipeline);
    const mv = database("D1_MV");
    for (const migration of [mvMigration, unsafeMigration, hardeningMigration, failureMigration, g31WaitReceiptMigration, g31WaitPoisonMigration, orderingQuarantineMigration, rebuildVerificationMigration, rebuildProofMigration]) {
      await mv.batch(statements(mv, migration as string));
    }
  });

  it("has an independent before-record boundary fixture", async () => {
    const result = await runBoundary("before-record");
    expect(result.direct.fastDisposition).toBe("failed");
    expect(result.queue.queueDisposition).toBe("ack");
    expect(result.counts.every((count) => count.rows === 1 && count.indexes === 1 && count.receipts === 1 && count.markers === 0 && count.kicks === 1)).toBe(true);
    expect(result.outboxDelivered).toBe(true);
  });

  it("has an independent after-pipeline boundary fixture", async () => {
    const result = await runBoundary("after-pipeline");
    expect(result.direct.fastDisposition).toBe("failed");
    expect(result.queue.queueDisposition).toBe("ack");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ event_id: result.event.eventId, suid: result.event.suid });
    expect(result.outboxDelivered).toBe(true);
  });

  it("has an independent after-k-of-n boundary fixture with a committed receipt prefix and correlation-bound replay", async () => {
    const result = await runBoundary("after-k-views");
    expect(result.direct.fastDisposition).toBe("failed");
    expect(result.queue.queueDisposition).toBe("ack");
    expect(result.direct.correlationId).toBe(`fast:${result.event.serviceId}:${result.event.eventId}:${result.event.attemptId}`);
    expect(result.queue.correlationId).toBe(`queue:${result.event.serviceId}:${result.event.eventId}:${result.event.attemptId}`);
    expect(result.receiptsBeforeReplay).toEqual([
      { viewId: "G26IntegrationHead", count: 1 },
      { viewId: "G26IntegrationMiddle", count: 1 },
      { viewId: "G26IntegrationTail", count: 0 },
    ]);
    expect(new Set(result.afterKCommitted)).toEqual(new Set(["G26IntegrationHead", "G26IntegrationMiddle"]));
    expect(result.afterKCommitted).toHaveLength(2);
    expect(result.queue.views.map((view) => [view.id, view.status])).toEqual([
      ["G26IntegrationHead", "duplicate-race"],
      ["G26IntegrationMiddle", "duplicate-race"],
      ["G26IntegrationTail", "applied"],
    ]);
    expect(result.counts.every((count) => count.rows === 1 && count.indexes === 1 && count.receipts === 1 && count.markers === 0 && count.kicks === 1)).toBe(true);
    expect(result.arrivals).toBe(1);
    expect(result.outboxDelivered).toBe(true);
  });

  it("has an independent after-all-views boundary fixture with drain-only recovery", async () => {
    const result = await runBoundary("after-all-views");
    expect(result.direct.fastDisposition).toBe("failed");
    expect(result.direct.failures.at(-1)?.phase).toBe("drain");
    expect(result.queue.queueDisposition).toBe("ack");
    expect(result.counts.every((count) => count.rows === 1 && count.indexes === 1 && count.receipts === 1 && count.markers === 0 && count.kicks === 1)).toBe(true);
    expect(result.outboxDelivered).toBe(true);
  });

  it.each(["G26IntegrationHead", "G26IntegrationMiddle", "G26IntegrationTail"])(
    "keeps later real views running for %s poison and records finding identity",
    async (poisonView) => {
      const result = await runBoundary("none", { poisonView });
      expect(result.direct.queueDispositionReason).toBe("definition-poison-dlq");
      expect(result.direct.fastDisposition).toBe("failed");
      expect(result.queue.queueDispositionReason).toBe("definition-poison-dlq");
      expect(result.findings).toContainEqual(expect.objectContaining({ view_id: poisonView, event_id: result.event.eventId, suid: result.event.suid }));
      result.counts.forEach((count, index) => {
        if (["G26IntegrationHead", "G26IntegrationMiddle", "G26IntegrationTail"][index] === poisonView) {
          expect(count).toMatchObject({ rows: 0, indexes: 0, receipts: 0, markers: 0, kicks: 0 });
        } else {
          expect(count).toMatchObject({ rows: 1, indexes: 1, receipts: 1, markers: 0, kicks: 1 });
        }
      });
      expect(result.outboxDelivered).toBe(true);
    },
  );

  it("aggregates a finding-write failure without stopping later views", async () => {
    const result = await runBoundary("none", { poisonView: "G26IntegrationHead", findingWriteFailure: true });
    expect(result.direct.fastDisposition).toBe("failed");
    expect(result.direct.queueDispositionReason).toBe("retryable-transient");
    expect(result.queue.queueDisposition).toBe("retry-to-dlq");
    expect(result.queue.queueDispositionReason).toBe("definition-poison-dlq");
    expect(result.findings).toContainEqual(expect.objectContaining({ view_id: "G26IntegrationHead", event_id: result.event.eventId, suid: result.event.suid }));
    expect(result.counts[0]).toMatchObject({ rows: 0, indexes: 0, receipts: 0, markers: 0, kicks: 0 });
    expect(result.counts.slice(1).every((count) => count.rows === 1)).toBe(true);
    expect(result.outboxDelivered).toBe(true);
  });

  it("replays only the failed view after partial success and proves successful-view receipt no-ops", async () => {
    const failedView = "G26IntegrationTail";
    const result = await runBoundary("none", { partialSuccessView: failedView });
    expect(result.direct.fastDisposition).toBe("failed");
    expect(result.direct.queueDispositionReason).toBe("retryable-transient");
    expect(result.queue.queueDisposition).toBe("ack");
    expect(result.direct.views.map((view) => [view.id, view.status])).toEqual([
      ["G26IntegrationHead", "applied"],
      ["G26IntegrationMiddle", "applied"],
      [failedView, "failed"],
    ]);
    expect(result.queue.views.map((view) => [view.id, view.status])).toEqual([
      ["G26IntegrationHead", "duplicate-race"],
      ["G26IntegrationMiddle", "duplicate-race"],
      [failedView, "applied"],
    ]);
    expect(result.invocations).toEqual({
      G26IntegrationHead: 2,
      G26IntegrationMiddle: 2,
      G26IntegrationTail: 2,
    });
    expect(result.mutations).toEqual({
      G26IntegrationHead: 1,
      G26IntegrationMiddle: 1,
      G26IntegrationTail: 1,
    });
    expect(result.findings).toContainEqual(expect.objectContaining({ view_id: failedView, event_id: result.event.eventId, suid: result.event.suid }));
    expect(result.counts.every((count) => count.rows === 1 && count.indexes === 1 && count.receipts === 1 && count.markers === 0 && count.kicks === 1)).toBe(true);
    expect(result.outboxDelivered).toBe(true);
  });

  it("preserves the same final real MV state when view order is reversed", async () => {
    const first = await runBoundary("after-all-views");
    const second = await runBoundary("after-all-views", { viewOrder: ["G26IntegrationTail", "G26IntegrationMiddle", "G26IntegrationHead"] });
    expect(first.counts.map((count) => [count.rows, count.indexes, count.receipts, count.markers, count.kicks])).toEqual(
      second.counts.map((count) => [count.rows, count.indexes, count.receipts, count.markers, count.kicks]),
    );
  });
});
