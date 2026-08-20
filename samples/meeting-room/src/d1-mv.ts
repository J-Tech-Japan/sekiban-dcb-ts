import { defineRowMaterializer } from "@sekiban/dcb-core";
import {
  createD1StoreProvider,
} from "@sekiban/dcb-runtime/d1";
import {
  D1MaterializedViewStore,
  MaterializedViewCatchUpRuntime,
} from "@sekiban/dcb-runtime/d1-mv";
interface MeetingRoomD1Env {
  readonly D1?: D1Database;
  readonly D1_MV?: D1Database;
  readonly SDT_SERVICE_ID?: string;
}

interface StoredEventLike {
  readonly suid: string;
  readonly eventId: string;
  readonly payload: string;
  readonly eventTags: readonly string[];
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
    const eventType = stringField(payload.eventType);
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
    const eventType = stringField(payload.eventType);
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

/**
 * Catch up both materialized views from the D1 PipelineStore. The source and
 * MV databases are intentionally separate bindings, while every source read
 * remains behind the existing SafeWindow/checkpoint rules.
 */
export async function catchUpMeetingRoomMaterializedViews(env: MeetingRoomD1Env, serviceId = env.SDT_SERVICE_ID ?? "serialized-dcb-v1"): Promise<void> {
  if (env.D1 === undefined || env.D1_MV === undefined) {
    throw new Error("Cloudflare-only composition requires D1 and D1_MV bindings");
  }
  const provider = createD1StoreProvider();
  const source = provider.create({ D1: env.D1, D1_MV: env.D1_MV });
  await source.initialize();
  const views = new D1MaterializedViewStore(env.D1_MV);
  await views.initialize();
  const runtime = new MaterializedViewCatchUpRuntime(source, views);
  for (const materializer of [roomMaterializer, reservationMaterializer]) {
    const active = await views.readActive(serviceId, materializer.id);
    if (active === undefined) {
      await runtime.build(serviceId, materializer, Date.now());
    } else {
      await runtime.follow(serviceId, materializer, Date.now());
    }
  }
}
