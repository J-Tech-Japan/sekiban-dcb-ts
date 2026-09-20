import { defineRowMaterializer } from "@sekiban/dcb-core";
import { createD1StoreProvider } from "@sekiban/dcb-runtime/d1";
import {
  D1MaterializedViewStore,
  MaterializedViewCatchUpRuntime,
  type DeliveryViewFailureClass,
  type DeliveryViewHandler,
  type StoredEvent,
} from "@sekiban/dcb-runtime/d1-mv";

export interface BookingDataEnvironment {
  readonly D1?: D1Database;
  readonly D1_MV?: D1Database;
  readonly SDT_SERVICE_ID?: string;
}

function objectPayload(event: StoredEvent): Record<string, unknown> {
  const value: unknown = JSON.parse(event.payload);
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const reservationMaterializer = defineRowMaterializer<StoredEvent>({
  id: "ReservationProjector",
  version: 1,
  indexDescriptors: [{ id: "reservation-id", valueType: "text", value: (row) => (row as { reservationId?: unknown }).reservationId }],
  materialize: (event) => {
    if (!event.eventTags.some((tag) => tag.startsWith("reservation:"))) return {};
    const payload = objectPayload(event);
    const reservationId = stringField(payload.reservationId);
    if (reservationId === undefined) return {};
    if (event.eventType === "ReservationCancelled") {
      return {
        rowPatches: [{
          kind: "json_patch" as const,
          rowKey: reservationId,
          patch: { status: "cancelled" },
          rowVersion: 2,
        }],
      };
    }
    if (event.eventType !== "RoomReserved") return {};
    return {
      rowUpserts: [{
        rowKey: reservationId,
        value: {
          reservationId,
          roomId: stringField(payload.roomId) ?? "",
          userId: stringField(payload.userId) ?? "",
          status: "reserved",
          version: 1,
        },
      }],
    };
  },
});

export const roomMaterializer = defineRowMaterializer<StoredEvent>({
  id: "RoomProjector",
  version: 1,
  indexDescriptors: [{ id: "room-id", valueType: "text", value: (row) => (row as { roomId?: unknown }).roomId }],
  materialize: (event) => {
    if (!event.eventTags.some((tag) => tag.startsWith("room:"))) return {};
    const payload = objectPayload(event);
    const roomId = stringField(payload.roomId);
    if (roomId === undefined || (event.eventType !== "RoomCreated" && event.eventType !== "RoomReleased")) return {};
    return {
      rowUpserts: [{
        rowKey: roomId,
        value: {
          roomId,
          name: stringField(payload.name) ?? "",
          status: event.eventType === "RoomCreated" ? "created" : "released",
          version: event.eventType === "RoomCreated" ? 1 : 2,
        },
      }],
    };
  },
});

const materializers = [reservationMaterializer, roomMaterializer] as const;

function requiredEnvironment(env: BookingDataEnvironment): { readonly D1: D1Database; readonly D1_MV: D1Database } {
  if (env.D1 === undefined || env.D1_MV === undefined) throw new Error("Booking materializers require D1 and D1_MV bindings");
  return { D1: env.D1, D1_MV: env.D1_MV };
}

async function open(env: BookingDataEnvironment): Promise<{
  readonly views: D1MaterializedViewStore;
  readonly runtime: MaterializedViewCatchUpRuntime;
}> {
  const bindings = requiredEnvironment(env);
  const provider = createD1StoreProvider();
  const source = provider.create(bindings);
  await source.initialize();
  const views = new D1MaterializedViewStore(bindings.D1_MV);
  await views.initialize();
  return { views, runtime: new MaterializedViewCatchUpRuntime(source, views) };
}

export async function ensureBookingViews(env: BookingDataEnvironment, serviceId: string): Promise<void> {
  const opened = await open(env);
  for (const materializer of materializers) {
    if (await opened.views.readActive(serviceId, materializer.id) === undefined) {
      await opened.runtime.build(serviceId, materializer, Date.now());
    }
  }
}

export async function catchUpBookingViews(env: BookingDataEnvironment, serviceId: string): Promise<void> {
  const opened = await open(env);
  for (const materializer of materializers) {
    if (await opened.views.readActive(serviceId, materializer.id) === undefined) {
      await opened.runtime.build(serviceId, materializer, Date.now());
    } else {
      await opened.runtime.follow(serviceId, materializer, Date.now());
    }
  }
}

export function bookingDeliveryViews(env: BookingDataEnvironment): readonly DeliveryViewHandler[] {
  let opened: Promise<Awaited<ReturnType<typeof open>>> | undefined;
  const context = async () => {
    opened ??= (async () => {
      const value = await open(env);
      const serviceId = env.SDT_SERVICE_ID;
      if (serviceId === undefined || serviceId.length === 0) throw new Error("SDT_SERVICE_ID is required");
      await ensureBookingViews(env, serviceId);
      return value;
    })();
    return opened;
  };
  return materializers.map((materializer) => ({
    id: materializer.id,
    admission: "independent-unsafe" as const,
    apply: async ({ event, arrivedAt }) => {
      const value = await context();
      const serviceId = env.SDT_SERVICE_ID;
      if (serviceId === undefined || serviceId.length === 0) throw new Error("SDT_SERVICE_ID is required");
      const active = await value.views.readActive(serviceId, materializer.id);
      if (active === undefined) throw new Error(`Materialized view ${materializer.id} is not initialized`);
      const result = await value.views.unsafeWindow().apply({
        serviceId,
        viewId: materializer.id,
        generation: active.generation,
        eventId: event.eventId,
        suid: event.suid,
        safeHead: active.lastSuid,
        updatedAt: arrivedAt,
        recordArrival: true,
        mutations: materializer.plan(event),
        targetSuid: event.suid,
      });
      return result.duplicate ? "duplicate-race" : "applied";
    },
    classifyError: (error: unknown): DeliveryViewFailureClass => {
      const typed = error as { readonly code?: unknown; readonly retryable?: unknown };
      if (typed.code === "UNSAFE_DUPLICATE_RACE") return "duplicate-race";
      if (typed.retryable === false) return "nonretryable-definition-poison";
      return "retryable-transient";
    },
  }));
}
