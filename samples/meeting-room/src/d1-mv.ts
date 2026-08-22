import { defineRowMaterializer } from "@sekiban/dcb-core";
import {
  createD1StoreProvider,
} from "@sekiban/dcb-runtime/d1";
import {
  D1MaterializedViewStore,
  MaterializedViewCatchUpRuntime,
} from "@sekiban/dcb-runtime/d1-mv";
import type { DeliveryViewFailureClass, DeliveryViewHandler } from "@sekiban/dcb-runtime/d1-mv";
import type { StoredEvent } from "@sekiban/dcb-runtime/d1-mv";
interface MeetingRoomD1Env {
  readonly D1?: D1Database;
  readonly D1_MV?: D1Database;
  readonly SDT_SERVICE_ID?: string;
  readonly G26_VIEW_COUNT?: string;
}

function requiredServiceId(value: string | undefined): string {
  if (value !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value)) return value;
  throw new Error("SDT_SERVICE_ID is required and must be a non-empty deployment service identity");
}

interface StoredEventLike {
  readonly suid: string;
  readonly eventId: string;
  readonly payload: string;
  readonly eventTags: readonly string[];
  /** G27 identity is authoritative whenever the row carries it. */
  readonly eventType?: string;
  readonly provenance?: "g27" | "pre-g27";
}

function decodePayload(value: string): Record<string, unknown> {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * New rows dispatch by the stored canonical identity. Payload sniffing is
 * retained only for the immutable pre-G27 history lane, where the old V1
 * payload discriminator is the proven migration marker.
 */
function eventTypeFromStored(event: StoredEventLike, payload: Record<string, unknown>): string | undefined {
  if (event.eventType !== undefined) return event.eventType;
  // A pre-G27 StoredEvent read from an older in-memory/provider fixture may
  // omit provenance entirely; only an explicit G27 provenance must disable
  // the proven legacy payload lane.
  if (event.provenance !== "g27") {
    const legacyName = stringField(payload.eventType);
    if (legacyName === undefined) return undefined;
    return legacyName.includes(":") ? legacyName : `${legacyName}:1`;
  }
  return undefined;
}

/** One row per reservation, updated by reservation events in SUID order. */
export const reservationMaterializer = defineRowMaterializer<StoredEventLike>({
  id: "ReservationProjector",
  version: 1,
  indexDescriptors: [{
    id: "reservation-id",
    valueType: "text",
    value: (row) => (row as { reservationId?: unknown }).reservationId,
  }],
  materialize: (event) => {
    if (!event.eventTags.some((tag) => tag.startsWith("reservation:"))) return {};
    const payload = decodePayload(event.payload);
    const reservationId = stringField(payload.reservationId);
    if (reservationId === undefined) return {};
    const eventType = eventTypeFromStored(event, payload);
    if (eventType !== "RoomReserved:1" && eventType !== "ReservationCancelled:1") return {};
    if (eventType === "ReservationCancelled:1") {
      // Cancellation carries only changed fields. The database JSON patch
      // preserves the roomId written by the preceding reservation event.
      return {
        rowPatches: [{
          kind: "json_patch",
          rowKey: reservationId,
          patch: { status: "cancelled", version: 2 },
          rowVersion: 2,
          indexEntries: [{ indexId: "reservation-id", value: reservationId, rowKey: reservationId }],
        }],
      };
    }
    const roomId = stringField(payload.roomId);
    return {
      rowUpserts: [{
        rowKey: reservationId,
        value: {
          reservationId,
          ...(roomId === undefined ? {} : { roomId }),
          status: "reserved",
          version: 1,
        },
      }],
    };
  },
});

/** One row per room, updated by room lifecycle events in SUID order. */
export const roomMaterializer = defineRowMaterializer<StoredEventLike>({
  id: "RoomProjector",
  version: 1,
  indexDescriptors: [{
    id: "room-id",
    valueType: "text",
    value: (row) => (row as { roomId?: unknown }).roomId,
  }],
  materialize: (event) => {
    if (!event.eventTags.some((tag) => tag.startsWith("room:"))) return {};
    const payload = decodePayload(event.payload);
    const roomId = stringField(payload.roomId);
    if (roomId === undefined) return {};
    const eventType = eventTypeFromStored(event, payload);
    if (eventType !== "RoomCreated:1" && eventType !== "RoomReleased:1") return {};
    return {
      rowUpserts: [{
        rowKey: roomId,
        value: {
          roomId,
          name: stringField(payload.name) ?? "",
          status: eventType === "RoomCreated:1" ? "created" : "released",
          version: eventType === "RoomCreated:1" ? 1 : 2,
        },
      }],
    };
  },
});

function materializers() {
  return [roomMaterializer, reservationMaterializer] as const;
}

type MeetingRoomMaterializer = ReturnType<typeof materializers>[number];

const DEFAULT_FANOUT_VIEW_COUNT = 2;
const MAX_FANOUT_VIEW_COUNT = 20;

function configuredViewCount(value: string | undefined): number {
  if (value === undefined || value.length === 0) return DEFAULT_FANOUT_VIEW_COUNT;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_FANOUT_VIEW_COUNT) {
    throw new Error(`G26_VIEW_COUNT must be an integer between 1 and ${MAX_FANOUT_VIEW_COUNT}`);
  }
  return parsed;
}

function fanoutViewId(index: number, viewCount = DEFAULT_FANOUT_VIEW_COUNT): string {
  // The one-view remote topology must still exercise the opted-in list view;
  // RoomProjector is a scalar projection and cannot satisfy the G26 visibility
  // oracle by itself.
  if (viewCount === 1 && index === 0) return reservationMaterializer.id;
  const base = materializers()[index];
  if (base !== undefined) return base.id;
  return `G26FanoutView${String(index + 1).padStart(2, "0")}`;
}

/**
 * Expand the sample's two real views with deterministic duplicate materializer
 * definitions for remote 1/5/10-view topology runs. The duplicates use the
 * same D1 MV handle and row plan, so the measurement exercises real per-view
 * receipts, rows, indexes, markers, and kicks without changing V1 query wire
 * shapes. Production/default composition remains two views.
 */
function fanoutMaterializers(viewCount: number): readonly MeetingRoomMaterializer[] {
  const base = materializers();
  const result: MeetingRoomMaterializer[] = [];
  for (let index = 0; index < viewCount; index += 1) {
    if (viewCount === 1 && index === 0) {
      result.push(reservationMaterializer);
      continue;
    }
    const source = base[index % base.length]!;
    result.push(index < base.length ? source : { ...source, id: fanoutViewId(index, viewCount) } as MeetingRoomMaterializer);
  }
  return result;
}

export function meetingRoomDeliveryViewIds(viewCount = DEFAULT_FANOUT_VIEW_COUNT): readonly string[] {
  const count = Math.min(Math.max(Math.trunc(viewCount), 1), MAX_FANOUT_VIEW_COUNT);
  return Array.from({ length: count }, (_, index) => fanoutViewId(index, count));
}

/**
 * Per-view lookup facade. The current deployment intentionally uses one MV
 * D1 binding, but callers resolve a handle by view id so a future split
 * reservation binding cannot leak SQL/database selection into delivery code.
 */
export function lookupMeetingRoomMaterializedView(
  views: D1MaterializedViewStore,
  viewId: string,
  configuredMaterializers: readonly MeetingRoomMaterializer[] = materializers(),
): { readonly id: string; readonly store: D1MaterializedViewStore; readonly materializer: MeetingRoomMaterializer } {
  const materializer = configuredMaterializers.find((candidate) => candidate.id === viewId);
  if (materializer === undefined) throw new Error(`Unknown meeting-room materialized view: ${viewId}`);
  return { id: viewId, store: views, materializer };
}

async function openMaterializedViews(env: MeetingRoomD1Env): Promise<{
  readonly views: D1MaterializedViewStore;
  readonly runtime: MaterializedViewCatchUpRuntime;
}> {
  if (env.D1 === undefined || env.D1_MV === undefined) {
    throw new Error("Cloudflare-only composition requires D1 and D1_MV bindings");
  }
  const provider = createD1StoreProvider();
  const source = provider.create({ D1: env.D1, D1_MV: env.D1_MV });
  await source.initialize();
  const views = new D1MaterializedViewStore(env.D1_MV);
  await views.initialize();
  return { views, runtime: new MaterializedViewCatchUpRuntime(source, views) };
}

async function ensureSafeInstances(
  runtime: MaterializedViewCatchUpRuntime,
  views: D1MaterializedViewStore,
  serviceId: string,
  nowMs: number,
  configuredMaterializers: readonly MeetingRoomMaterializer[] = materializers(),
): Promise<void> {
  await Promise.all(configuredMaterializers.map(async (materializer) => {
    const active = await views.readActive(serviceId, materializer.id);
    if (active === undefined) await runtime.build(serviceId, materializer, nowMs);
  }));
}

/**
 * Catch up both materialized views from the D1 PipelineStore. The source and
 * MV databases are intentionally separate bindings, while every source read
 * remains behind the existing SafeWindow/checkpoint rules.
 */
export async function catchUpMeetingRoomMaterializedViews(env: MeetingRoomD1Env, serviceId = requiredServiceId(env.SDT_SERVICE_ID)): Promise<void> {
  const { runtime, views } = await openMaterializedViews(env);
  for (const materializer of fanoutMaterializers(configuredViewCount(env.G26_VIEW_COUNT))) {
    const active = await views.readActive(serviceId, materializer.id);
    if (active === undefined) {
      await runtime.build(serviceId, materializer, Date.now());
    } else {
      await runtime.follow(serviceId, materializer, Date.now());
    }
  }
}

async function applyMeetingRoomUnsafeView(
  views: D1MaterializedViewStore,
  materializer: MeetingRoomMaterializer,
  serviceId: string,
  event: StoredEvent,
  nowMs: number,
  configuredMaterializers: readonly MeetingRoomMaterializer[] = materializers(),
): Promise<"applied" | "duplicate-race" | void> {
  const handle = lookupMeetingRoomMaterializedView(views, materializer.id, configuredMaterializers);
  const active = await handle.store.readActive(serviceId, handle.id);
  if (active === undefined) throw new Error(`Materialized view ${handle.id} was not initialized`);
  // A startup build can safely fold an already-old event. Do not resurrect it
  // through the unsafe lane; a later safe catch-up owns that convergence.
  if (active.lastSuid >= event.suid) return;
  const unsafe = handle.store.unsafeWindow();
  const mutations = materializer.plan(event);
  const upsertOnly = mutations.rowUpserts.length === 1 && mutations.rowPatches.length === 0 && mutations.rowDeletes.length === 0;
  try {
    // Arrival observation belongs inside this view branch. It is not a
    // transport-level prelude and cannot be shared across view handlers.
    if (!upsertOnly) await unsafe.observeArrival(serviceId, handle.id, active.generation, event.eventId, event.suid);
    const applied = await unsafe.apply({
      serviceId,
      viewId: handle.id,
      generation: active.generation,
      eventId: event.eventId,
      suid: event.suid,
      safeHead: active.lastSuid,
      updatedAt: nowMs,
      recordArrival: upsertOnly,
      mutations,
      targetSuid: event.suid,
    });
    return applied.duplicate ? "duplicate-race" : "applied";
  } catch (error) {
    // The identity finding is retained for Queue retries/DLQ and operator
    // repair. A finding-write failure is part of the same view failure, but it
    // must not stop the core from invoking later views.
    try {
      await handle.store.recordUnsafeFailureFinding({
        serviceId,
        viewId: handle.id,
        generation: active.generation,
        eventId: event.eventId,
        suid: event.suid,
        observedAt: nowMs,
      });
    } catch (findingError) {
      const combined = new Error(
        `unsafe view ${handle.id} failed and finding write failed: ${String(findingError)}`,
        { cause: error },
      ) as Error & { failureClass?: DeliveryViewFailureClass };
      // A missing operational finding is itself retryable, even if the
      // underlying view error happened to be a duplicate race.
      combined.failureClass = "retryable-transient";
      throw combined;
    }
    throw error;
  }
}

/** Build one continuation-safe handler per configured meeting-room view. */
export function meetingRoomDeliveryViews(env: MeetingRoomD1Env): readonly DeliveryViewHandler[] {
  const configured = fanoutMaterializers(configuredViewCount(env.G26_VIEW_COUNT));
  // Start the opted-in list view first. The branches still run concurrently
  // and every configured view is awaited, but this lets the deployed
  // response-to-visible oracle observe ReservationProjector without waiting
  // behind the scalar room branch or a later fan-out clone.
  const reservation = configured.find((materializer) => materializer.id === reservationMaterializer.id);
  const deliveryOrder = reservation === undefined
    ? configured
    : [reservation, ...configured.filter((materializer) => materializer !== reservation)];
  let opened: Promise<{
    readonly views: D1MaterializedViewStore;
    readonly runtime: MaterializedViewCatchUpRuntime;
    readonly serviceId: string;
  }> | undefined;
  const context = async () => {
    opened ??= (async () => {
      const serviceId = requiredServiceId(env.SDT_SERVICE_ID);
      const value = await openMaterializedViews(env);
      await ensureSafeInstances(value.runtime, value.views, serviceId, Date.now(), configured);
      return { ...value, serviceId };
    })();
    return opened;
  };
  return deliveryOrder.map((materializer) => ({
    id: materializer.id,
    apply: async ({ event, arrivedAt }) => {
      const value = await context();
      return applyMeetingRoomUnsafeView(value.views, materializer, value.serviceId, event, arrivedAt, configured);
    },
    classifyError: (error: unknown): DeliveryViewFailureClass => {
      const typed = error as { readonly code?: unknown; readonly retryable?: unknown; readonly failureClass?: unknown };
      if (typed.failureClass === "duplicate-race" || typed.code === "UNSAFE_DUPLICATE_RACE") return "duplicate-race";
      if (typed.failureClass === "nonretryable-definition-poison" || typed.retryable === false) return "nonretryable-definition-poison";
      return "retryable-transient";
    },
  }));
}

/**
 * G25's exceptional immediate lane.  The input is the PipelineStore's stored
 * outcome, never a raw Queue payload.  Each apply owns its row mutation,
 * receipt and max-merged kick in the one G23 atomic batch.
 */
export async function applyMeetingRoomUnsafeArrival(
  env: MeetingRoomD1Env,
  event: StoredEvent,
  nowMs = Date.now(),
): Promise<void> {
  const serviceId = requiredServiceId(env.SDT_SERVICE_ID);
  if (event.serviceId !== serviceId) throw new Error("Stored event service identity did not match SDT_SERVICE_ID");
  const { runtime, views } = await openMaterializedViews(env);
  const configured = fanoutMaterializers(configuredViewCount(env.G26_VIEW_COUNT));
  await ensureSafeInstances(runtime, views, serviceId, nowMs, configured);
  for (const materializer of configured) {
    await applyMeetingRoomUnsafeView(views, materializer, serviceId, event, nowMs, configured);
  }
}

/** Coalesced safe drain. A held lease is ordinary coalescing, not a Queue success/failure decision. */
export async function drainMeetingRoomUnsafeKicks(env: MeetingRoomD1Env, nowMs = Date.now()): Promise<void> {
  const serviceId = requiredServiceId(env.SDT_SERVICE_ID);
  const { runtime, views } = await openMaterializedViews(env);
  for (const materializer of fanoutMaterializers(configuredViewCount(env.G26_VIEW_COUNT))) {
    const unsafe = views.unsafeWindow();
    const owner = `meeting-room-${crypto.randomUUID()}`;
    let lease;
    try {
      lease = await unsafe.acquireKick(serviceId, materializer.id, owner, nowMs, 60_000);
    } catch {
      continue;
    }
    if (lease === undefined) continue;
    // If this fails, retain the lease until expiry rather than marking work
    // clean. Cron still runs the normal safe catch-up as the recovery net.
    await runtime.follow(serviceId, materializer, nowMs);
    await unsafe.finishKick(serviceId, materializer.id, owner);
  }
}
