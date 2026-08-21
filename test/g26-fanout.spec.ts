import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error Vite raw migration fixture.
import pipelineMigration from "../migrations/d1/0001_pipeline_store.sql?raw";
// @ts-expect-error Vite raw migration fixture.
import identityMigration from "../migrations/d1/0002_g27_event_identity.sql?raw";
// @ts-expect-error Vite raw migration fixture.
import mvMigration from "../migrations/mv/0001_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration fixture.
import unsafeMigration from "../migrations/mv/0002_unsafe_window_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration fixture.
import hardeningMigration from "../migrations/mv/0003_checkpoint_ahead_hardening.sql?raw";
// @ts-expect-error Vite raw migration fixture.
import failureMigration from "../migrations/mv/0004_unsafe_window_failure_findings.sql?raw";
import { UnsafeWindowMaterializedViewStore } from "../packages/dcb-runtime/src/mv/UnsafeWindowMaterializedView";
import { D1MaterializedViewStore } from "../packages/dcb-runtime/src/mv/MaterializedViewStore";
import { D1EventStore } from "../packages/dcb-runtime/src/store/D1EventStore";
import {
  handleDownstreamQueue,
  processDownstreamDoorbell,
  type DeliveryViewHandler,
} from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";

function database(): D1Database {
  const value = (env as unknown as { D1_MV?: D1Database }).D1_MV;
  if (value === undefined) throw new Error("G26 fan-out requires D1_MV");
  return value;
}

function pipelineDatabase(): D1Database {
  const value = (env as unknown as { D1?: D1Database }).D1;
  if (value === undefined) throw new Error("G26 lag oracle requires D1");
  return value;
}

function statements(sql: string): D1PreparedStatement[] {
  return sql
    .replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => database().prepare(value));
}

describe("SDT-G26 fan-out and receipt-race oracles", () => {
  beforeAll(async () => {
    const pipelineStatements = `${pipelineMigration as string}\n${identityMigration as string}`
      .replace(/^\s*--.*$/gm, "")
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => pipelineDatabase().prepare(value));
    await pipelineDatabase().batch(pipelineStatements);
    for (const migration of [mvMigration, unsafeMigration, hardeningMigration, failureMigration]) {
      await database().batch(statements(migration as string));
    }
  });

  it("aligns concurrent fast/queue callers after receipt pre-read: one batch commits and loser is typed duplicate-race", async () => {
    const serviceId = `g26-race-${crypto.randomUUID()}`;
    const viewId = "G26RaceView";
    let reached = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const barrier = async () => {
      reached += 1;
      if (reached === 2) release();
      await released;
    };
    const input = {
      serviceId,
      viewId,
      generation: 0,
      eventId: "g26-race-event",
      suid: "g26-race-suid",
      safeHead: "",
      updatedAt: 1,
      mutations: { rowUpserts: [], rowPatches: [], rowDeletes: [], indexEntries: [], indexDeletes: [] },
      targetSuid: "g26-race-suid",
    } as const;
    const fast = new UnsafeWindowMaterializedViewStore(database(), { beforeApplyBatch: barrier });
    const queued = new UnsafeWindowMaterializedViewStore(database(), { beforeApplyBatch: barrier });
    const results = await Promise.allSettled([fast.apply(input), queued.apply(input)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((result) => result.status === "rejected");
    expect(loser).toMatchObject({ status: "rejected", reason: { code: "UNSAFE_DUPLICATE_RACE" } });
    const receiptCount = await database().prepare(
      "SELECT COUNT(*) AS count FROM mv_unsafe_receipts WHERE service_id = ? AND view_id = ? AND event_id = ?",
    ).bind(serviceId, viewId, input.eventId).first<{ count: number }>();
    const kick = await database().prepare(
      "SELECT target_suid, dirty FROM mv_unsafe_kicks WHERE service_id = ? AND view_id = ?",
    ).bind(serviceId, viewId).first<{ target_suid: string; dirty: number }>();
    expect(Number(receiptCount?.count)).toBe(1);
    expect(kick).toEqual({ target_suid: input.suid, dirty: 1 });
  });

  it("makes Queue the deterministic race loser, retries once, then converges as a receipt no-op", async () => {
    const serviceId = `g26-shared-core-${crypto.randomUUID()}`;
    const event = {
      version: 1,
      serviceId,
      allocatorLineageId: "g26-shared-lineage",
      tag: "g26:shared",
      attemptId: "g26-shared-attempt",
      eventId: "g26-shared-event",
      suid: "g26-shared-suid",
      payload: btoa(JSON.stringify({ eventType: "G26Shared" })),
      eventTags: ["g26:shared"],
      eventType: "G26Shared:1",
      provenance: "g27",
      enqueuedAt: 1_000,
    } satisfies DownstreamOutboxMessage;
    const pipeline = new D1EventStore(pipelineDatabase());
    await pipeline.initialize();
    let recordArrivals = 0;
    let releaseRecord!: () => void;
    const recordReleased = new Promise<void>((resolve) => { releaseRecord = resolve; });
    const store = new D1EventStore(pipelineDatabase(), {
      beforeBatch: async (operation, prepared) => {
        if (operation === "recordDelivery") {
          recordArrivals += 1;
          if (recordArrivals === 2) releaseRecord();
          await recordReleased;
        }
        return prepared;
      },
    });
    await store.initialize();
    const materializedViews = new D1MaterializedViewStore(database());
    await materializedViews.initialize();
    await materializedViews.createActive({
      serviceId,
      viewId: "G26SharedCoreView",
      definitionVersion: 1,
      updatedAt: 1,
    });
    await database().prepare(
      "INSERT INTO mv_unsafe_kicks (service_id, view_id, target_suid, dirty) VALUES (?, ?, ?, 1)",
    ).bind(serviceId, "G26SharedCoreView", "g26-shared-aaa-target").run();
    let fastReached = false;
    let queueReached = false;
    let releaseBoth!: () => void;
    const bothReached = new Promise<void>((resolve) => { releaseBoth = resolve; });
    let fastCommitted!: () => void;
    const fastCommittedPromise = new Promise<void>((resolve) => { fastCommitted = resolve; });
    const fastUnsafe = new UnsafeWindowMaterializedViewStore(database(), {
      beforeApplyBatch: async () => {
        fastReached = true;
        if (queueReached) releaseBoth();
        await bothReached;
      },
      afterApplyBatch: async () => {
        fastCommitted();
      },
    });
    const queueRaceUnsafe = new UnsafeWindowMaterializedViewStore(database(), {
      beforeApplyBatch: async () => {
        queueReached = true;
        if (fastReached) releaseBoth();
        await bothReached;
        // The fast batch is deliberately released and committed first. The
        // queue batch then evaluates its prepared receipt guard against the
        // committed receipt and becomes the typed duplicate-race loser.
        await fastCommittedPromise;
      },
    });
    // The replay must use the production no-hook path: an existing receipt is
    // a duplicate no-op, not a second synthetic race.
    const queueReplayUnsafe = new UnsafeWindowMaterializedViewStore(database());
    let queueApplyCount = 0;
    let queueRaceObserved = false;
    let queueReplayObserved = false;
    const view: DeliveryViewHandler = {
      id: "G26SharedCoreView",
      apply: async ({ event: stored, source }) => {
        const unsafe = source === "fast"
          ? fastUnsafe
          : queueApplyCount++ === 0
            ? queueRaceUnsafe
            : queueReplayUnsafe;
        await unsafe.observeArrival(serviceId, "G26SharedCoreView", 0, stored.eventId, stored.suid);
        try {
          const applied = await unsafe.apply({
            serviceId,
            viewId: "G26SharedCoreView",
            generation: 0,
            eventId: stored.eventId,
            suid: stored.suid,
            safeHead: "",
            updatedAt: 1_010,
            mutations: {
              rowUpserts: [{ rowKey: "shared-row", value: { eventId: stored.eventId }, rowVersion: 1, sourceSuid: stored.suid }],
              rowPatches: [],
              rowDeletes: [],
              indexEntries: [{ indexId: "shared-event", valueType: "text", value: stored.eventId, rowKey: "shared-row" }],
              indexDeletes: [],
            },
            targetSuid: stored.suid,
          });
          if (source === "queue" && queueApplyCount === 2) queueReplayObserved = applied.duplicate;
          return applied.duplicate ? "duplicate-race" : "applied";
        } catch (error) {
          if (source === "queue" && queueApplyCount === 1 && (error as { readonly code?: unknown }).code === "UNSAFE_DUPLICATE_RACE") {
            queueRaceObserved = true;
          }
          throw error;
        }
      },
    };
    let queueAcked = 0;
    let queueRetried = 0;
    const queueBatch = (attempts: number): MessageBatch<unknown> => ({
      messages: [{
        body: event,
        attempts,
        ack: () => { queueAcked += 1; },
        retry: () => { queueRetried += 1; },
      }],
    } as unknown as MessageBatch<unknown>);
    const [fastResult] = await Promise.all([
      processDownstreamDoorbell(event, {}, { store, views: [view] }),
      handleDownstreamQueue(queueBatch(1), {}, { store, views: [view] }),
    ]);
    expect(fastResult.source).toBe("fast");
    expect(fastResult.fastDisposition).toBe("completed");
    expect(fastResult.views[0]?.status).toBe("applied");
    expect(queueRaceObserved).toBe(true);
    expect(queueAcked).toBe(0);
    expect(queueRetried).toBe(1);

    await handleDownstreamQueue(queueBatch(2), {}, { store, views: [view] });
    expect(queueApplyCount).toBe(2);
    expect(queueReplayObserved).toBe(true);
    expect(queueAcked).toBe(1);
    expect(queueRetried).toBe(1);
    const row = await database().prepare("SELECT COUNT(*) AS count FROM mv_unsafe_rows WHERE service_id = ? AND view_id = ?").bind(serviceId, "G26SharedCoreView").first<{ count: number }>();
    const index = await database().prepare("SELECT COUNT(*) AS count FROM mv_unsafe_index_entries WHERE service_id = ? AND view_id = ?").bind(serviceId, "G26SharedCoreView").first<{ count: number }>();
    const receipt = await database().prepare("SELECT COUNT(*) AS count FROM mv_unsafe_receipts WHERE service_id = ? AND view_id = ? AND event_id = ?").bind(serviceId, "G26SharedCoreView", event.eventId).first<{ count: number }>();
    const marker = await database().prepare("SELECT COUNT(*) AS count FROM mv_unsafe_markers WHERE service_id = ? AND view_id = ? AND event_id = ?").bind(serviceId, "G26SharedCoreView", event.eventId).first<{ count: number }>();
    const kick = await database().prepare("SELECT target_suid, dirty FROM mv_unsafe_kicks WHERE service_id = ? AND view_id = ?").bind(serviceId, "G26SharedCoreView").first<{ target_suid: string; dirty: number }>();
    const incidents = await pipeline.listDeliveryIncidents(serviceId);
    expect(Number(row?.count)).toBe(1);
    expect(Number(index?.count)).toBe(1);
    expect(Number(receipt?.count)).toBe(1);
    expect(Number(marker?.count)).toBe(0);
    expect(kick).toEqual({ target_suid: event.suid, dirty: 1 });
    expect(incidents).toEqual([]);
  });

  it("preserves concurrent recordDelivery arrivals without a false incident", async () => {
    const serviceId = `g26-arrivals-${crypto.randomUUID()}`;
    const base = (suffix: string): DownstreamOutboxMessage => ({
      version: 1,
      serviceId,
      allocatorLineageId: "g26-arrival-lineage",
      tag: `g26:arrival:${suffix}`,
      attemptId: `g26-arrival-attempt-${suffix}`,
      eventId: `g26-arrival-event-${suffix}`,
      suid: `g26-arrival-suid-${suffix}`,
      payload: btoa(JSON.stringify({ suffix })),
      eventTags: [`g26:arrival:${suffix}`],
      eventType: "G26Arrival:1",
      provenance: "g27",
      enqueuedAt: 1_000,
    });
    let reached = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const store = new D1EventStore(pipelineDatabase(), {
      beforeBatch: async (operation, prepared) => {
        if (operation === "recordDelivery") {
          reached += 1;
          if (reached === 2) release();
          await released;
        }
        return prepared;
      },
    });
    await store.initialize();
    await Promise.all([store.recordDelivery(base("one"), 1_010, "fast"), store.recordDelivery(base("two"), 1_020, "queue")]);
    expect(await store.listDeliveryIncidents(serviceId)).toEqual([]);
    const events = await pipelineDatabase().prepare("SELECT COUNT(*) AS count FROM serialized_dcb_events WHERE service_id = ?").bind(serviceId).first<{ count: number }>();
    const arrivals = await pipelineDatabase().prepare("SELECT COUNT(*) AS count FROM serialized_dcb_event_arrivals WHERE service_id = ?").bind(serviceId).first<{ count: number }>();
    expect(Number(events?.count)).toBe(2);
    expect(Number(arrivals?.count)).toBe(2);
  });

  it("labels real D1 statement/CPU measurements as local algorithmic slope", async () => {
    const measurements: Array<{ viewCount: number; d1Statements: number; cpuMs: number }> = [];
    for (const viewCount of [1, 5, 10]) {
      const serviceId = `g26-local-slope-${viewCount}-${crypto.randomUUID()}`;
      let d1Statements = 0;
      const materializedViews = new D1MaterializedViewStore(database());
      await materializedViews.initialize();
      const unsafe = new UnsafeWindowMaterializedViewStore(database(), {
        beforeApplyBatch: async (_input, statementsForBatch) => {
          d1Statements += statementsForBatch?.length ?? 0;
        },
      });
      const started = performance.now();
      for (let index = 0; index < viewCount; index += 1) {
        const viewId = `G26SlopeView${index + 1}`;
        await materializedViews.createActive({
          serviceId,
          viewId,
          definitionVersion: 1,
          updatedAt: 1,
        });
        await unsafe.apply({
          serviceId,
          viewId,
          generation: 0,
          eventId: `g26-local-event-${index}`,
          suid: `g26-local-suid-${String(index).padStart(3, "0")}`,
          safeHead: "",
          updatedAt: 1_000 + index,
          recordArrival: true,
          mutations: {
            rowUpserts: [{ rowKey: `row-${index}`, value: { index }, rowVersion: 1, sourceSuid: `g26-local-suid-${String(index).padStart(3, "0")}` }],
            rowPatches: [],
            rowDeletes: [],
            indexEntries: [{ indexId: "local-index", valueType: "integer", value: index, rowKey: `row-${index}` }],
            indexDeletes: [],
          },
          targetSuid: `g26-local-suid-${String(index).padStart(3, "0")}`,
        });
      }
      measurements.push({ viewCount, d1Statements, cpuMs: performance.now() - started });
    }
    expect(measurements.map((value) => value.viewCount)).toEqual([1, 5, 10]);
    expect(measurements.every((value) => value.d1Statements > 0 && value.cpuMs >= 0)).toBe(true);
    expect(measurements[1]!.d1Statements).toBeGreaterThan(measurements[0]!.d1Statements);
    expect(measurements[2]!.d1Statements).toBeGreaterThan(measurements[1]!.d1Statements);
    expect({ label: "local-algorithmic-slope", measurements }).toMatchObject({ label: "local-algorithmic-slope" });
  });

  it("does not let a fast observation shrink the queue-only lag estimator", async () => {
    const store = new D1EventStore(pipelineDatabase());
    await store.initialize();
    const serviceId = `g26-lag-${crypto.randomUUID()}`;
    const base = (suffix: string, suid: string): DownstreamOutboxMessage => ({
      version: 1,
      serviceId,
      allocatorLineageId: "g26-lag-lineage",
      tag: "g26:lag",
      attemptId: `g26-lag-attempt-${suffix}`,
      eventId: `g26-lag-event-${suffix}`,
      suid,
      payload: btoa(JSON.stringify({ suffix })),
      eventTags: ["g26:lag"],
      eventType: "G26Lag:1",
      provenance: "g27",
      enqueuedAt: 0,
    });
    await store.recordDelivery(base("fast", "suid-0001"), 10_000, "fast");
    expect(await store.currentLagBound(serviceId, 10_000)).toBe(0);
    await store.recordDelivery(base("queue", "suid-0002"), 500, "queue");
    expect(await store.currentLagBound(serviceId, 500)).toBe(500);
  });
});
