import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error Vite raw migration imports.
import migration0001 from "../migrations/mv/0001_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration imports.
import migration0002 from "../migrations/mv/0002_unsafe_window_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration imports.
import migration0003 from "../migrations/mv/0003_checkpoint_ahead_hardening.sql?raw";
// @ts-expect-error Vite raw migration imports.
import migration0004 from "../migrations/mv/0004_unsafe_window_failure_findings.sql?raw";
// @ts-expect-error Vite raw migration imports.
import migration0005 from "../migrations/mv/0005_g31_wait_receipts.sql?raw";
// @ts-expect-error Vite raw migration imports.
import migration0006 from "../migrations/mv/0006_g31_wait_target_poison.sql?raw";
// @ts-expect-error Vite raw migration imports.
import migration0007 from "../migrations/mv/0007_g69_ordering_quarantine.sql?raw";
// @ts-expect-error Vite raw migration imports.
import migration0008 from "../migrations/mv/0008_g69_rebuild_verification.sql?raw";
import { defineRowMaterializer } from "@sekiban/dcb-core";
import {
  D1MaterializedViewStore,
  MaterializedViewCatchUpRuntime,
  type UnsafeWindowApplyInput,
} from "../packages/dcb-runtime/src/d1-mv";
import type { ProjectionStore, StoredEvent } from "../packages/dcb-runtime/src/store/types";
import { g32Message, g32StoredEvent, g32Suid } from "./helpers/g32-fixtures";

const ROOM_VIEW = "RoomProjector";
const RESERVATION_VIEW = "ReservationProjector";
const MATERIALIZERS = {
  room: defineRowMaterializer<StoredEvent>({
    id: ROOM_VIEW,
    version: 1,
    indexDescriptors: [],
    materialize: (event) => ({
      rowUpserts: [{
        rowKey: "frontier-row",
        value: { view: ROOM_VIEW, suid: event.suid },
        rowVersion: 1,
        sourceSuid: event.suid,
      }],
    }),
  }),
  reservation: defineRowMaterializer<StoredEvent>({
    id: RESERVATION_VIEW,
    version: 1,
    indexDescriptors: [],
    materialize: (event) => ({
      rowUpserts: [{
        rowKey: "frontier-row",
        value: { view: RESERVATION_VIEW, suid: event.suid },
        rowVersion: 1,
        sourceSuid: event.suid,
      }],
    }),
  }),
} as const;

function database(): D1Database {
  const binding = (env as unknown as { D1_MV?: D1Database }).D1_MV;
  if (binding === undefined) throw new Error("D1_MV binding is required");
  return binding;
}

function statements(sql: string): D1PreparedStatement[] {
  return sql
    .replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((statement) => database().prepare(statement));
}

function source(events: readonly StoredEvent[]): ProjectionStore {
  return {
    readAllEvents: async (_serviceId, since) => events.filter((event) => event.suid > since),
    currentLagBound: async () => 0,
    listProjectionTags: async () => [],
    readProjectionCheckpoint: async () => undefined,
    advanceProjectionCheckpoint: async () => true,
    projectionLag: async (serviceId, projectionId, tag) => ({
      serviceId,
      projectionId,
      tag,
      checkpointSuid: "",
      headSuid: "",
      behindEvents: 0,
    }),
    appendDeliveryIncident: async () => undefined,
  };
}

function event(serviceId: string, eventId: string, suid: string, lastArrivedAt: number): StoredEvent {
  const tag = `g58:reentry:${serviceId}`;
  const message = g32Message({
    serviceId,
    tag,
    eventId,
    suid,
    eventTags: [tag],
    eventType: "G58Reentry",
    payload: JSON.stringify({ eventId, suid }),
  });
  return { ...g32StoredEvent(message, lastArrivedAt), lastArrivedAt };
}

async function applyUnsafeTarget(
  unsafe: ReturnType<D1MaterializedViewStore["unsafeWindow"]>,
  serviceId: string,
  eventValue: StoredEvent,
): Promise<void> {
  const input: UnsafeWindowApplyInput = {
    serviceId,
    viewId: RESERVATION_VIEW,
    generation: 0,
    eventId: eventValue.eventId,
    suid: eventValue.suid,
    safeHead: g32Suid(1),
    updatedAt: eventValue.lastArrivedAt,
    targetSuid: eventValue.suid,
    mutations: MATERIALIZERS.reservation.plan(eventValue),
  };
  await unsafe.apply(input);
}

async function kickRow(serviceId: string): Promise<{ targetSuid: string; dirty: number; leaseOwner: string | null }> {
  const row = await database().prepare(
    "SELECT target_suid, dirty, lease_owner FROM mv_unsafe_kicks WHERE service_id = ? AND view_id = ?",
  ).bind(serviceId, RESERVATION_VIEW).first<{ target_suid: string; dirty: number; lease_owner: string | null }>();
  if (row === null || row === undefined) throw new Error("reservation kick row was not persisted");
  return { targetSuid: row.target_suid, dirty: Number(row.dirty), leaseOwner: row.lease_owner };
}

describe("SDT-G58 ReservationProjector unsafe-kick re-entry", () => {
  beforeAll(async () => {
    await database().batch(statements(migration0001 as string));
    await database().batch(statements(migration0002 as string));
    await database().batch(statements(migration0003 as string));
    await database().batch(statements(migration0004 as string));
    await database().batch(statements(migration0005 as string));
    await database().batch(statements(migration0006 as string));
    await database().batch(statements(migration0007 as string));
    await database().batch(statements(migration0008 as string));
  });

  it("re-arms a partially settled kick and re-enters after the first unsafe event ages", async () => {
    const serviceId = `g58-reentry-${crypto.randomUUID()}`;
    const nowMs = 1_788_428_500_000;
    const oldSuid = g32Suid(1);
    const targetSuid = g32Suid(2);
    const oldEvent = event(serviceId, "g58-reentry-old", oldSuid, nowMs - 30_000);
    const roomTarget = event(serviceId, "g58-reentry-room-target", targetSuid, nowMs - 30_000);
    const reservationTarget = event(serviceId, "g58-reentry-reservation-target", targetSuid, nowMs - 1_000);
    const views = new D1MaterializedViewStore(database());
    await views.initialize();
    const roomRuntime = new MaterializedViewCatchUpRuntime(source([oldEvent, roomTarget]), views);
    const reservationRuntime = new MaterializedViewCatchUpRuntime(source([oldEvent, reservationTarget]), views);

    // Decision 1: Room independently reaches the retained frontier; the
    // Reservation view applies only the old event and stops at the first
    // recent event. The same maximumSuid is the proven scheduled frontier.
    const roomInitial = await roomRuntime.build(serviceId, MATERIALIZERS.room, nowMs, {}, { maximumSuid: targetSuid });
    const reservationInitial = await reservationRuntime.build(serviceId, MATERIALIZERS.reservation, nowMs, {}, { maximumSuid: targetSuid });
    expect(roomInitial.instance.lastSuid).toBe(targetSuid);
    expect(reservationInitial.instance.lastSuid).toBe(oldSuid);
    expect(reservationInitial.appliedEvents).toBe(1);
    await applyUnsafeTarget(views.unsafeWindow(), serviceId, reservationTarget);

    // Decision 2: the unsafe kick is acquired, but follow still stops at the
    // same first-unsafe event. A finish that ignores the reached checkpoint is
    // the W105 baseline defect: it would make this target permanently clean.
    const firstFollow = await reservationRuntime.follow(serviceId, MATERIALIZERS.reservation, nowMs, {}, { maximumSuid: targetSuid });
    expect(firstFollow.instance.lastSuid).toBe(oldSuid);
    const lease = await views.unsafeWindow().acquireKick(serviceId, RESERVATION_VIEW, "w106-first", nowMs, 60_000);
    expect(lease?.targetSuid).toBe(targetSuid);
    const blockedDrain = await reservationRuntime.follow(serviceId, MATERIALIZERS.reservation, nowMs, {}, { maximumSuid: targetSuid });
    expect(blockedDrain.instance.lastSuid).toBe(oldSuid);
    await expect(views.unsafeWindow().finishKick(
      serviceId,
      RESERVATION_VIEW,
      "w106-first",
      blockedDrain.instance.lastSuid,
    )).resolves.toBe(true);
    expect(await kickRow(serviceId)).toEqual({ targetSuid, dirty: 1, leaseOwner: null });

    // Decision 3: once the same event is SafeWindow-eligible, the re-armed
    // kick is acquired and the Reservation view reaches the target. Room's
    // independent convergence remains unchanged.
    const eligibleAt = nowMs + 21_000;
    const reentryLease = await views.unsafeWindow().acquireKick(serviceId, RESERVATION_VIEW, "w106-second", eligibleAt, 60_000);
    expect(reentryLease?.targetSuid).toBe(targetSuid);
    const reentered = await reservationRuntime.follow(serviceId, MATERIALIZERS.reservation, eligibleAt, {}, { maximumSuid: targetSuid });
    expect(reentered.instance.lastSuid).toBe(targetSuid);
    expect(reentered.appliedEvents).toBe(1);
    await expect(views.unsafeWindow().finishKick(
      serviceId,
      RESERVATION_VIEW,
      "w106-second",
      reentered.instance.lastSuid,
    )).resolves.toBe(true);
    expect(await kickRow(serviceId)).toEqual({ targetSuid, dirty: 0, leaseOwner: null });
    expect((await views.readActive(serviceId, ROOM_VIEW))?.lastSuid).toBe(targetSuid);
  });
});
