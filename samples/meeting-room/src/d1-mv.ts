import { defineRowMaterializer } from "@sekiban/dcb-core";
import { envServiceIdentity, requireServiceIdentity } from "@sekiban/dcb-runtime/cloudflare";
import type {
  LiveProjectionPollObservation,
  LiveProjectionPollOutcome,
} from "@sekiban/dcb-runtime/cloudflare";
import {
  D1EventStore,
  createD1StoreProvider,
  safeWindowCeilingExceeded,
  safeWindowMs,
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

/** The persisted result of the most recent scheduled G44 coverage decision. */
export interface MeetingRoomSafeLaneCoverage {
  readonly kind: "SETTLED" | "BLOCK/UNSETTLED";
  readonly reason: string | null;
  readonly partitionTag: string | null;
  /** Null means this service has not yet completed a FULL scanner snapshot. */
  readonly frontierSuid: string | null;
  readonly observedAt: number;
}

/** One immutable row for one scheduled safe-lane tick. */
export interface MeetingRoomSafeLaneHistoryEntry {
  readonly tickId: string;
  readonly kind: "SETTLED" | "BLOCK/UNSETTLED";
  readonly reason: string | null;
  readonly partitionTag: string | null;
  /** Null is an explicit persisted absence of a proven completeness frontier. */
  readonly frontierSuid: string | null;
  readonly observedAt: number;
}

export interface MeetingRoomReadHealth {
  readonly serviceId: string;
  readonly materializedViews: readonly Readonly<{
    viewId: string;
    generation: number | null;
    safeHead: string;
    safeHeadAgeMs: number | null;
    unsafeRows: number;
    unsafeReceipts: number;
  }>[];
  readonly coverage: Readonly<{
    kind: "SETTLED" | "BLOCK/UNSETTLED";
    reason: string | null;
    partitionTag: string | null;
    frontierSuid: string | null;
    observedAt: number | null;
  }>;
  readonly coverageHistory: readonly MeetingRoomSafeLaneHistoryEntry[];
  readonly lag: Readonly<{
    estimateMs: number | null;
    observedAt: number | null;
    decayedMs: number;
    safeWindowMs: number;
    ceilingExceeded: boolean;
  }>;
  readonly liveProjections: readonly Readonly<{
    projectorId: string;
    head: string;
    headAgeMs: number | null;
    lastPollAt: number | null;
    pollStatus: LiveProjectionPollOutcome;
    pollReason: string | null;
  }>[];
  readonly globalHead: string;
}

function asCount(value: unknown, name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Meeting-room ${name} was not a non-negative integer`);
  return parsed;
}

function nonNegativeAge(nowMs: number, updatedAt: number): number {
  return Math.max(0, nowMs - updatedAt);
}

function requiredServiceId(env: MeetingRoomD1Env): string {
  return requireServiceIdentity(envServiceIdentity(env));
}

/**
 * Scheduled maintenance supplies one stable observedAt for a coverage
 * decision.  The tick identity deliberately contains no request UUID: a
 * repeated observation of the same scheduled tick is idempotent and cannot
 * mutate an already-recorded history row.
 */
export function meetingRoomSafeLaneTickId(observedAt: number): string {
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
    throw new Error("Meeting-room safe-lane tick observedAt must be a non-negative integer");
  }
  return `scheduled:${String(observedAt)}`;
}

interface StoredEventLike {
  readonly suid: string;
  readonly eventId: string;
  readonly payload: string;
  readonly eventTags: readonly string[];
  /** G32 EventType is the sole dispatch authority. */
  readonly eventType: string;
  readonly provenance: "g32";
}

function decodePayload(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** G32 dispatch is solely the durable EventType; payload is never sniffed. */
function eventTypeFromStored(event: StoredEventLike): string | undefined {
  return event.eventType;
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
    const eventType = eventTypeFromStored(event);
    if (eventType !== "RoomReserved" && eventType !== "ReservationCancelled") return {};
    if (eventType === "ReservationCancelled") {
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
    const eventType = eventTypeFromStored(event);
    if (eventType !== "RoomCreated" && eventType !== "RoomReleased") return {};
    return {
      rowUpserts: [{
        rowKey: roomId,
        value: {
          roomId,
          name: stringField(payload.name) ?? "",
          status: eventType === "RoomCreated" ? "created" : "released",
          version: eventType === "RoomCreated" ? 1 : 2,
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
 * Persist the coverage decision made at the start of a cron tick.  Request
 * reads intentionally do not infer this from current scanner rows: operators
 * need to know which gate actually governed the scheduled safe-lane work.
 */
export async function recordMeetingRoomSafeLaneCoverage(
  env: MeetingRoomD1Env,
  serviceId: string,
  coverage: MeetingRoomSafeLaneCoverage,
): Promise<void> {
  if (env.D1 === undefined) throw new Error("Cloudflare-only composition requires the D1 binding");
  const tickId = meetingRoomSafeLaneTickId(coverage.observedAt);
  const frontierSuid = coverage.frontierSuid ?? "";
  const existing = await env.D1.prepare(
    `SELECT service_id, tick_id, coverage_kind, coverage_reason,
            coverage_partition_tag, settled_frontier_suid, observed_at
       FROM serialized_dcb_safe_lane_history
      WHERE service_id = ? AND tick_id = ?`,
  ).bind(serviceId, tickId).first<Record<string, unknown>>();
  const historyValues = [
    serviceId,
    tickId,
    coverage.kind,
    coverage.reason,
    coverage.partitionTag,
    frontierSuid,
    coverage.observedAt,
  ] as const;
  const sameHistoryRow = (row: Record<string, unknown>): boolean => (
    row.service_id === serviceId
      && row.tick_id === tickId
      && row.coverage_kind === coverage.kind
      && (row.coverage_reason === null || row.coverage_reason === undefined ? null : String(row.coverage_reason)) === coverage.reason
      && (row.coverage_partition_tag === null || row.coverage_partition_tag === undefined ? null : String(row.coverage_partition_tag)) === coverage.partitionTag
      && (row.settled_frontier_suid === null || row.settled_frontier_suid === undefined ? "" : String(row.settled_frontier_suid)) === frontierSuid
      && Number(row.observed_at) === coverage.observedAt
  );
  if (existing !== null && existing !== undefined && !sameHistoryRow(existing)) {
    throw new Error(`safe_lane_history_tick_conflict:${tickId}`);
  }
  if (existing === null || existing === undefined) {
    // DO NOTHING is intentional: scheduled history is append-only.  The
    // read-back closes the concurrent same-tick race without allowing a
    // second caller to rewrite the first caller's coverage decision.
    await env.D1.prepare(
      `INSERT INTO serialized_dcb_safe_lane_history
         (service_id, tick_id, coverage_kind, coverage_reason,
          coverage_partition_tag, settled_frontier_suid, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (service_id, tick_id) DO NOTHING`,
    ).bind(...historyValues).run();
    const persisted = await env.D1.prepare(
      `SELECT service_id, tick_id, coverage_kind, coverage_reason,
              coverage_partition_tag, settled_frontier_suid, observed_at
         FROM serialized_dcb_safe_lane_history
        WHERE service_id = ? AND tick_id = ?`,
    ).bind(serviceId, tickId).first<Record<string, unknown>>();
    if (persisted === null || persisted === undefined || !sameHistoryRow(persisted)) {
      throw new Error(`safe_lane_history_tick_conflict:${tickId}`);
    }
  }
  await env.D1.prepare(
    `INSERT INTO serialized_dcb_safe_lane_health
       (service_id, coverage_kind, coverage_reason, coverage_partition_tag, settled_frontier_suid, observed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (service_id) DO UPDATE SET
       coverage_kind = excluded.coverage_kind,
       coverage_reason = excluded.coverage_reason,
       coverage_partition_tag = excluded.coverage_partition_tag,
       settled_frontier_suid = excluded.settled_frontier_suid,
       observed_at = excluded.observed_at`,
  ).bind(
    serviceId,
    coverage.kind,
    coverage.reason,
    coverage.partitionTag,
    frontierSuid,
    coverage.observedAt,
  ).run();
}

const LIVE_POLL_OUTCOMES: readonly LiveProjectionPollOutcome[] = [
  "never-invoked",
  "invoked-and-threw",
  "invoked-but-no-work",
  "explicitly-gated",
  "advanced",
];

function livePollOutcome(value: unknown): LiveProjectionPollOutcome {
  return typeof value === "string" && LIVE_POLL_OUTCOMES.includes(value as LiveProjectionPollOutcome)
    ? value as LiveProjectionPollOutcome
    : "never-invoked";
}

/** Persist a per-projector attempt before bootstrap admission/store init. */
export async function recordMeetingRoomLivePollAttempt(
  env: MeetingRoomD1Env,
  serviceId: string,
  projectorIds: readonly string[],
  attemptedAt: number,
): Promise<void> {
  if (env.D1 === undefined) throw new Error("Cloudflare-only composition requires the D1 binding");
  if (projectorIds.length === 0) return;
  await env.D1.batch(projectorIds.map((projectorId) => env.D1!.prepare(
    `INSERT INTO serialized_dcb_live_poll_health
       (service_id, projector_id, attempted_at, outcome, reason, advanced_source_events)
     VALUES (?, ?, ?, 'invoked-but-no-work', 'poll_in_progress', 0)
     ON CONFLICT (service_id, projector_id) DO UPDATE SET
       attempted_at = excluded.attempted_at,
       outcome = excluded.outcome,
       reason = excluded.reason,
       advanced_source_events = excluded.advanced_source_events`,
  ).bind(serviceId, projectorId, attemptedAt)));
}

/** Persist the terminal result without affecting projection semantics. */
export async function recordMeetingRoomLivePollOutcome(
  env: MeetingRoomD1Env,
  observation: LiveProjectionPollObservation,
): Promise<void> {
  if (env.D1 === undefined) throw new Error("Cloudflare-only composition requires the D1 binding");
  await env.D1.prepare(
    `INSERT INTO serialized_dcb_live_poll_health
       (service_id, projector_id, attempted_at, outcome, reason, advanced_source_events)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (service_id, projector_id) DO UPDATE SET
       attempted_at = excluded.attempted_at,
       outcome = excluded.outcome,
       reason = excluded.reason,
       advanced_source_events = excluded.advanced_source_events`,
  ).bind(
    observation.serviceId,
    observation.projectorId,
    observation.attemptedAt,
    observation.outcome,
    observation.reason,
    observation.advancedSourceEvents,
  ).run();
}

/**
 * Read the authenticated operator health snapshot. Every value comes from an
 * existing operational table used by the safe or live-projection runtime; no
 * V1 query path is selected and this function never advances state.
 */
export async function readMeetingRoomHealth(
  env: MeetingRoomD1Env,
  serviceId = requiredServiceId(env),
  nowMs = Date.now(),
): Promise<MeetingRoomReadHealth> {
  if (env.D1 === undefined || env.D1_MV === undefined) {
    throw new Error("Cloudflare-only composition requires D1 and D1_MV bindings");
  }
  const { views } = await openMaterializedViews(env);
  const configured = fanoutMaterializers(configuredViewCount(env.G26_VIEW_COUNT));
  const materializedViews = await Promise.all(configured.map(async (materializer) => {
    const active = await views.readActive(serviceId, materializer.id);
    if (active === undefined) {
      return {
        viewId: materializer.id,
        generation: null,
        safeHead: "",
        safeHeadAgeMs: null,
        unsafeRows: 0,
        unsafeReceipts: 0,
      };
    }
    const counts = await env.D1_MV!.prepare(
      `SELECT
         (SELECT COUNT(*) FROM mv_unsafe_rows
           WHERE service_id = ? AND view_id = ? AND generation = ?) AS unsafe_rows,
         (SELECT COUNT(*) FROM mv_unsafe_receipts
           WHERE service_id = ? AND view_id = ?) AS unsafe_receipts`,
    ).bind(serviceId, materializer.id, active.generation, serviceId, materializer.id).first<Record<string, unknown>>();
    if (counts === null || counts === undefined) throw new Error("Materialized-view health count query returned no row");
    return {
      viewId: materializer.id,
      generation: active.generation,
      safeHead: active.lastSuid,
      safeHeadAgeMs: nonNegativeAge(nowMs, active.updatedAt),
      unsafeRows: asCount(counts.unsafe_rows, "unsafe_rows"),
      unsafeReceipts: asCount(counts.unsafe_receipts, "unsafe_receipts"),
    };
  }));

  const source = new D1EventStore(env.D1);
  await source.initialize();
  const lag = await source.lagBoundDiagnostics(serviceId, nowMs);
  const [coverageRow, coverageHistoryRows, globalHeadRow, projectionRows, livePollRows] = await Promise.all([
    env.D1.prepare(
      `SELECT coverage_kind, coverage_reason, coverage_partition_tag,
              settled_frontier_suid, observed_at
         FROM serialized_dcb_safe_lane_health
        WHERE service_id = ?`,
    ).bind(serviceId).first<Record<string, unknown>>(),
    env.D1.prepare(
      `SELECT tick_id, coverage_kind, coverage_reason, coverage_partition_tag,
              settled_frontier_suid, observed_at
         FROM serialized_dcb_safe_lane_history
        WHERE service_id = ?
        ORDER BY observed_at COLLATE BINARY ASC, tick_id COLLATE BINARY ASC`,
    ).bind(serviceId).all<Record<string, unknown>>(),
    env.D1.prepare(
      `SELECT COALESCE(MAX("SortableUniqueId" COLLATE BINARY), '') AS global_head
         FROM dcb_events
        WHERE "ServiceId" = ?`,
    ).bind(serviceId).first<Record<string, unknown>>(),
    env.D1.prepare(
      `SELECT projection_id, last_suid, updated_at
         FROM serialized_dcb_projection_checkpoints
        WHERE service_id = ?
      ORDER BY projection_id COLLATE BINARY ASC`,
    ).bind(serviceId).all<Record<string, unknown>>(),
    (async () => {
      try {
        return await env.D1!.prepare(
          `SELECT projector_id, attempted_at, outcome, reason, advanced_source_events
             FROM serialized_dcb_live_poll_health
            WHERE service_id = ?
            ORDER BY projector_id COLLATE BINARY ASC`,
        ).bind(serviceId).all<Record<string, unknown>>();
      } catch {
        // The additive table may be absent on a pre-G58 deployment. Expose an
        // explicit never-invoked status rather than deriving a false stale
        // timestamp from a checkpoint row.
        return { results: [] as Record<string, unknown>[] };
      }
    })(),
  ]);
  const globalHead = globalHeadRow === null || globalHeadRow === undefined || typeof globalHeadRow.global_head !== "string"
    ? ""
    : globalHeadRow.global_head;
  const checkpoints = projectionRows.results.map((row) => ({
    projectionId: typeof row.projection_id === "string" ? row.projection_id : "",
    head: typeof row.last_suid === "string" ? row.last_suid : "",
    updatedAt: asCount(row.updated_at, "projection.updated_at"),
  })).filter((row) => row.projectionId.length > 0);
  const livePollObservations = livePollRows.results.map((row) => ({
    projectorId: typeof row.projector_id === "string" ? row.projector_id : "",
    attemptedAt: asCount(row.attempted_at, "live_poll.attempted_at"),
    outcome: livePollOutcome(row.outcome),
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
  })).filter((row) => row.projectorId.length > 0);
  const liveProjections = materializers().map((projector) => {
    const states = checkpoints.filter((checkpoint) => checkpoint.projectionId.endsWith(`:${projector.id}`));
    const head = states.reduce((minimum, checkpoint) => minimum === "" || checkpoint.head < minimum ? checkpoint.head : minimum, "");
    const checkpointUpdatedAt = states.length === 0 ? null : Math.min(...states.map((state) => state.updatedAt));
    const observation = livePollObservations.find((row) => row.projectorId === projector.id);
    const lastPollAt = observation?.attemptedAt ?? null;
    return {
      projectorId: projector.id,
      head,
      headAgeMs: checkpointUpdatedAt === null ? null : nonNegativeAge(nowMs, checkpointUpdatedAt),
      lastPollAt,
      pollStatus: observation?.outcome ?? "never-invoked",
      pollReason: observation?.reason ?? "scheduled_live_poll_has_not_run",
    };
  });

  const coverageHistory = coverageHistoryRows.results.map((row) => {
    const tickId = typeof row.tick_id === "string" ? row.tick_id : "";
    if (tickId.length === 0) throw new Error("safe-lane history row omitted tick_id");
    return {
      tickId,
      kind: row.coverage_kind === "SETTLED" ? "SETTLED" as const : "BLOCK/UNSETTLED" as const,
      reason: row.coverage_reason === null || row.coverage_reason === undefined
        ? null
        : String(row.coverage_reason),
      partitionTag: row.coverage_partition_tag === null || row.coverage_partition_tag === undefined
        ? null
        : String(row.coverage_partition_tag),
      frontierSuid: typeof row.settled_frontier_suid === "string" && row.settled_frontier_suid.length > 0
        ? row.settled_frontier_suid
        : null,
      observedAt: asCount(row.observed_at, "coverage_history.observed_at"),
    } satisfies MeetingRoomSafeLaneHistoryEntry;
  });

  const coverage = coverageRow === null || coverageRow === undefined
    ? {
      kind: "BLOCK/UNSETTLED" as const,
      reason: "scheduled_maintenance_has_not_run",
      partitionTag: null,
      frontierSuid: null,
      observedAt: null,
    }
    : {
      kind: coverageRow.coverage_kind === "SETTLED" ? "SETTLED" as const : "BLOCK/UNSETTLED" as const,
      reason: coverageRow.coverage_reason === null || coverageRow.coverage_reason === undefined
        ? null
        : String(coverageRow.coverage_reason),
      partitionTag: coverageRow.coverage_partition_tag === null || coverageRow.coverage_partition_tag === undefined
        ? null
        : String(coverageRow.coverage_partition_tag),
      frontierSuid: typeof coverageRow.settled_frontier_suid === "string" && coverageRow.settled_frontier_suid.length > 0
        ? coverageRow.settled_frontier_suid
        : null,
      observedAt: asCount(coverageRow.observed_at, "coverage.observed_at"),
    };
  return {
    serviceId,
    materializedViews,
    coverage,
    coverageHistory,
    lag: {
      estimateMs: lag.rawEstimateMs,
      observedAt: lag.rawObservedAt,
      decayedMs: lag.dynamicLagBoundMs,
      safeWindowMs: safeWindowMs(lag.dynamicLagBoundMs),
      ceilingExceeded: safeWindowCeilingExceeded(lag.dynamicLagBoundMs),
    },
    liveProjections,
    globalHead,
  };
}

/**
 * Catch up both materialized views from the D1 PipelineStore. The source and
 * MV databases are intentionally separate bindings, while every source read
 * remains behind the existing SafeWindow/checkpoint rules.
 */
export async function catchUpMeetingRoomMaterializedViews(
  env: MeetingRoomD1Env,
  serviceId = requiredServiceId(env),
  frontierSuid: string | null | undefined = undefined,
): Promise<void> {
  const { runtime, views } = await openMaterializedViews(env);
  for (const materializer of fanoutMaterializers(configuredViewCount(env.G26_VIEW_COUNT))) {
    const active = await views.readActive(serviceId, materializer.id);
    if (active === undefined) {
      await runtime.build(serviceId, materializer, Date.now(), {}, { maximumSuid: frontierSuid });
    } else {
      await runtime.follow(serviceId, materializer, Date.now(), {}, { maximumSuid: frontierSuid });
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
      const serviceId = requiredServiceId(env);
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
  const serviceId = requiredServiceId(env);
  if (event.serviceId !== serviceId) throw new Error("Stored event service identity did not match SDT_SERVICE_ID");
  const { runtime, views } = await openMaterializedViews(env);
  const configured = fanoutMaterializers(configuredViewCount(env.G26_VIEW_COUNT));
  await ensureSafeInstances(runtime, views, serviceId, nowMs, configured);
  for (const materializer of configured) {
    await applyMeetingRoomUnsafeView(views, materializer, serviceId, event, nowMs, configured);
  }
}

/** Coalesced safe drain. A held lease is ordinary coalescing, not a Queue success/failure decision. */
export async function drainMeetingRoomUnsafeKicks(
  env: MeetingRoomD1Env,
  nowMs = Date.now(),
  frontierSuid: string | null | undefined = undefined,
): Promise<void> {
  const serviceId = requiredServiceId(env);
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
    const result = await runtime.follow(serviceId, materializer, nowMs, {}, { maximumSuid: frontierSuid });
    // `follow` may stop at the first recent event.  Pass the actual reached
    // checkpoint so finishKick re-arms the durable kick while its target is
    // still ahead, allowing a later scheduled tick to retry without a request
    // busy-wait or an irreversible clean transition.
    await unsafe.finishKick(serviceId, materializer.id, owner, result.instance.lastSuid);
  }
}
