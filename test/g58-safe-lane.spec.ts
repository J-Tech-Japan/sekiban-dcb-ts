import { createExecutionContext, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error Vite raw migration import.
import pipelineMigration from "../migrations/d1/g32/0001_dcb_events.sql?raw";
// @ts-expect-error Vite raw migration import.
import mvMigration0001 from "../migrations/mv/0001_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration import.
import mvMigration0002 from "../migrations/mv/0002_unsafe_window_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration import.
import mvMigration0003 from "../migrations/mv/0003_checkpoint_ahead_hardening.sql?raw";
// @ts-expect-error Vite raw migration import.
import mvMigration0004 from "../migrations/mv/0004_unsafe_window_failure_findings.sql?raw";
// @ts-expect-error Vite raw migration import.
import mvMigration0005 from "../migrations/mv/0005_g31_wait_receipts.sql?raw";
// @ts-expect-error Vite raw migration import.
import mvMigration0006 from "../migrations/mv/0006_g31_wait_target_poison.sql?raw";
import { defineRowMaterializer } from "@sekiban/dcb-core";
import { D1EventStore, D1MaterializedViewStore, safeWindowMs } from "../packages/dcb-runtime/src/d1";
import { MaterializedViewCatchUpRuntime } from "../packages/dcb-runtime/src/mv/MaterializedViewCatchUp";
import type { GlobalCompletenessCoverage } from "../packages/dcb-runtime/src/completeness/types";
import type { ProjectionStore, StoredEvent } from "../packages/dcb-runtime/src/store/types";
import primaryWorker, { runMeetingRoomScheduledMaintenance } from "../samples/meeting-room/src/worker.cloudflare-only";
import {
  readMeetingRoomHealth,
  recordMeetingRoomSafeLaneCoverage,
} from "../samples/meeting-room/src/d1-mv";
import type { MeetingRoomCloudflareEnv } from "../samples/meeting-room/src/worker.cloudflare-env";
import { g32Message, g32StoredEvent, g32Suid } from "./helpers/g32-fixtures";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";

const VIEW_ID = "g58-safe-lane-fixture";
const materializer = defineRowMaterializer<StoredEvent>({
  id: VIEW_ID,
  version: 1,
  indexDescriptors: [],
  materialize: (event) => ({
    rowUpserts: [{ rowKey: event.eventId, value: { eventId: event.eventId }, sourceSuid: event.suid }],
  }),
});

function pipeline(): D1Database {
  const database = (env as unknown as { D1?: D1Database }).D1;
  if (database === undefined) throw new Error("G58 requires the D1 pipeline binding");
  return database;
}

function materializedViews(): D1Database {
  const database = (env as unknown as { D1_MV?: D1Database }).D1_MV;
  if (database === undefined) throw new Error("G58 requires the D1_MV binding");
  return database;
}

function statements(database: D1Database, sql: string): D1PreparedStatement[] {
  return sql.replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => database.prepare(statement));
}

function event(serviceId: string, suffix: string, ordinal: number): StoredEvent {
  return g32StoredEvent(g32Message({
    serviceId,
    tag: `room:g58-${suffix}`,
    eventId: `g58-${suffix}-${ordinal}`,
    suid: g32Suid(ordinal),
    eventTags: [`room:g58-${suffix}`],
    enqueuedAt: 0,
  }), 0);
}

function orderedSource(events: readonly StoredEvent[]): ProjectionStore {
  return {
    readAllEvents: async (_serviceId: string, since: string) => events.filter((entry) => entry.suid > since),
    currentLagBound: async () => 0,
    appendDeliveryIncident: async () => undefined,
  } as unknown as ProjectionStore;
}

function blockedCoverage(frontierSuid: string | null): GlobalCompletenessCoverage {
  return {
    kind: "BLOCK/UNSETTLED",
    frontierSuid,
    reason: "source present/global receipt absent",
    partitionTag: "room:g58-blocked",
    observedAt: 10_000,
    health: {
      serviceId: "g58",
      scannerVersion: "g44",
      status: "BLOCK",
      cursorJson: null,
      lastSettledFrontierSuid: frontierSuid,
      lastFullScanAt: 9_000,
      lastError: "source present/global receipt absent",
      updatedAt: 10_000,
    },
  };
}

beforeAll(async () => {
  await pipeline().batch(statements(pipeline(), pipelineMigration as string));
  await applyG44D1Migration(pipeline());
  await materializedViews().batch([
    mvMigration0001,
    mvMigration0002,
    mvMigration0003,
    mvMigration0004,
    mvMigration0005,
    mvMigration0006,
  ].flatMap((migration) => statements(materializedViews(), migration as string)));
});

describe("SDT-G58 safe-lane and live-projection reliability", () => {
  it("continues a BLOCK tick through only the retained FULL frontier and never passes an unproven event", async () => {
    const serviceId = `g58-frontier-${crypto.randomUUID()}`;
    const proven = event(serviceId, "proven", 1);
    const unproven = event(serviceId, "unproven", 2);
    const views = new D1MaterializedViewStore(materializedViews());
    await views.initialize();
    const runtime = new MaterializedViewCatchUpRuntime(orderedSource([proven, unproven]), views);

    await runtime.build(serviceId, materializer, 100_000, {}, { maximumSuid: proven.suid });
    expect((await views.readActive(serviceId, VIEW_ID))?.lastSuid).toBe(proven.suid);

    // A never-settled BLOCK is even stricter: it can perform ordinary GC but
    // cannot advance the source checkpoint at all.
    await runtime.follow(serviceId, materializer, 100_001, {}, { maximumSuid: null });
    expect((await views.readActive(serviceId, VIEW_ID))?.lastSuid).toBe(proven.suid);

    const calls: Array<readonly [string, string | null | undefined]> = [];
    await runMeetingRoomScheduledMaintenance({
      globalCoverage: async () => blockedCoverage(proven.suid),
      recordCoverage: async (coverage) => { calls.push(["coverage", coverage.frontierSuid]); },
      catchUp: async (frontierSuid) => { calls.push(["catch-up", frontierSuid]); },
      drainUnsafeKicks: async (frontierSuid) => { calls.push(["drain", frontierSuid]); },
      runGenericScheduledWork: async () => { calls.push(["generic", undefined]); },
    });
    expect(calls).toEqual([
      ["coverage", proven.suid],
      ["catch-up", proven.suid],
      ["drain", proven.suid],
      ["generic", undefined],
    ]);
  });

  it("returns the bearer-only health surface from persisted safe-lane, lag, MV, and projection facts", async () => {
    const serviceId = `g58-health-${crypto.randomUUID()}`;
    const nowMs = Date.now();
    const tag = `room:g58-health-${crypto.randomUUID()}`;
    const sourceEvent = g32Message({
      serviceId,
      tag,
      eventId: `g58-health-event-${crypto.randomUUID()}`,
      suid: g32Suid(10),
      eventTags: [tag],
      enqueuedAt: nowMs - 2_000,
    });
    const source = new D1EventStore(pipeline());
    await source.initialize();
    await source.recordDelivery(sourceEvent, nowMs);

    const mv = new D1MaterializedViewStore(materializedViews());
    await mv.initialize();
    await mv.createActive({ serviceId, viewId: "RoomProjector", definitionVersion: 1, updatedAt: nowMs - 100, lastSuid: sourceEvent.suid });
    await mv.createActive({ serviceId, viewId: "ReservationProjector", definitionVersion: 1, updatedAt: nowMs - 200, lastSuid: sourceEvent.suid });
    await materializedViews().prepare(
      `INSERT INTO mv_unsafe_rows
         (service_id, view_id, generation, row_key, value_json, row_version, source_suid, tombstone)
       VALUES (?, 'RoomProjector', 0, 'g58-health-row', '{}', 1, ?, 0)`,
    ).bind(serviceId, sourceEvent.suid).run();
    await materializedViews().prepare(
      `INSERT INTO mv_unsafe_receipts (service_id, view_id, event_id, suid, outcome, observed_at)
       VALUES (?, 'RoomProjector', 'g58-health-receipt', ?, 'applied', ?)`,
    ).bind(serviceId, sourceEvent.suid, nowMs).run();
    for (const projectorId of ["RoomProjector", "ReservationProjector"]) {
      await pipeline().prepare(
        `INSERT INTO serialized_dcb_projection_checkpoints
           (service_id, projection_id, last_suid, state_json, version, updated_at)
         VALUES (?, ?, ?, '[]', 1, ?)`,
      ).bind(serviceId, `tag-state:${tag}:${projectorId}`, sourceEvent.suid, nowMs - 50).run();
    }
    await recordMeetingRoomSafeLaneCoverage({ D1: pipeline(), D1_MV: materializedViews() }, serviceId, {
      kind: "BLOCK/UNSETTLED",
      reason: "source present/global receipt absent",
      partitionTag: tag,
      frontierSuid: sourceEvent.suid,
      observedAt: nowMs,
    });

    const direct = await readMeetingRoomHealth({ D1: pipeline(), D1_MV: materializedViews(), SDT_SERVICE_ID: serviceId }, serviceId, nowMs + 1);
    expect(direct).toMatchObject({
      serviceId,
      coverage: { kind: "BLOCK/UNSETTLED", reason: "source present/global receipt absent", partitionTag: tag },
      lag: { estimateMs: 2_000, safeWindowMs: 20_000, ceilingExceeded: false },
      globalHead: sourceEvent.suid,
    });
    expect(direct.materializedViews).toEqual(expect.arrayContaining([
      expect.objectContaining({ viewId: "RoomProjector", safeHead: sourceEvent.suid, unsafeRows: 1, unsafeReceipts: 1 }),
      expect.objectContaining({ viewId: "ReservationProjector", safeHead: sourceEvent.suid }),
    ]));
    expect(direct.liveProjections).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectorId: "RoomProjector", head: sourceEvent.suid }),
      expect.objectContaining({ projectorId: "ReservationProjector", head: sourceEvent.suid }),
    ]));

    const workerFetch = primaryWorker.fetch;
    if (workerFetch === undefined) throw new Error("Meeting-room Worker must expose fetch");
    const workerEnv = {
      D1: pipeline(),
      D1_MV: materializedViews(),
      SDT_SERVICE_ID: serviceId,
      G32_COMPONENT: "primary",
      CONFORMANCE_TOKEN: "g58-test-bearer",
    } as unknown as MeetingRoomCloudflareEnv;
    const denied = await workerFetch(new Request("https://g58.test/conformance/v1/read-health") as never, workerEnv, createExecutionContext());
    expect(denied.status).toBe(403);
    const response = await workerFetch(new Request("https://g58.test/conformance/v1/read-health", {
      headers: { authorization: "Bearer g58-test-bearer" },
    }) as never, workerEnv, createExecutionContext());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      serviceId,
      coverage: { kind: "BLOCK/UNSETTLED" },
      lag: { decayedMs: expect.any(Number), safeWindowMs: expect.any(Number) },
      globalHead: sourceEvent.suid,
    });
    const tagStateId = `${tag}:RoomProjector`;
    const lag = await workerFetch(new Request(`https://g58.test/conformance/v1/internal/projection/lag?tagStateId=${encodeURIComponent(tagStateId)}`, {
      headers: { authorization: "Bearer g58-test-bearer" },
    }) as never, workerEnv, createExecutionContext());
    expect(lag.status).toBe(200);
    await expect(lag.json()).resolves.toMatchObject({
      tagStateId,
      checkpointSuid: sourceEvent.suid,
      headSuid: sourceEvent.suid,
      behindEvents: 0,
    });
  });

  it("decays a retired lag estimate back to the published 20-second safe-window floor after one decay interval", async () => {
    const serviceId = `g58-lag-${crypto.randomUUID()}`;
    const observedAt = Date.now() - 80_000;
    await pipeline().prepare(
      `INSERT INTO serialized_dcb_lag_estimates (service_id, estimate_ms, observed_at)
       VALUES (?, 80000, ?)`,
    ).bind(serviceId, observedAt).run();
    const source = new D1EventStore(pipeline());
    await source.initialize();
    const decayed = await source.currentLagBound(serviceId, observedAt + 80_000);
    expect(decayed).toBe(0);
    expect(safeWindowMs(decayed)).toBe(20_000);
  });
});
