import {
  defineCommand,
  defineDomain,
  defineEvent,
  defineProjector,
  defineTag,
  type DomainComponentDefinition,
  type JsonValue,
} from "@sekiban/dcb-core";

const objectPayload = (value: unknown): JsonValue => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("meeting-room event payload must be an object");
  }
  return value as JsonValue;
};

const roomCreated = defineEvent("RoomCreated", objectPayload);
const roomReserved = defineEvent("RoomReserved", objectPayload);
const reservationCancelled = defineEvent("ReservationCancelled", objectPayload);
const roomReleased = defineEvent("RoomReleased", objectPayload);

export const roomTag = (roomId: string) => defineTag("room", roomId);
export const reservationTag = (reservationId: string) => defineTag("reservation", reservationId);

interface RoomInput { readonly roomId: string; readonly name?: string; }
interface ReservationInput { readonly roomId: string; readonly reservationId: string; readonly userId?: string; }
interface ReservationOnlyInput { readonly reservationId: string; }

const nonEmpty = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
  return value;
};

const roomInput = (value: unknown): RoomInput => {
  if (typeof value !== "object" || value === null) throw new Error("room input must be an object");
  const record = value as Record<string, unknown>;
  const roomId = nonEmpty(record.roomId, "roomId");
  return typeof record.name === "string" ? { roomId, name: record.name } : { roomId };
};

const reservationInput = (value: unknown): ReservationInput => {
  if (typeof value !== "object" || value === null) throw new Error("reservation input must be an object");
  const record = value as Record<string, unknown>;
  const roomId = nonEmpty(record.roomId, "roomId");
  const reservationId = nonEmpty(record.reservationId, "reservationId");
  return typeof record.userId === "string" ? { roomId, reservationId, userId: record.userId } : { roomId, reservationId };
};

const reservationOnlyInput = (value: unknown): ReservationOnlyInput => {
  if (typeof value !== "object" || value === null) throw new Error("reservation input must be an object");
  return { reservationId: nonEmpty((value as Record<string, unknown>).reservationId, "reservationId") };
};

export const createRoomCommand = defineCommand<RoomInput>({
  id: "create-room",
  parseInput: roomInput,
  handler: (input, ctx) => {
    const tag = roomTag(input.roomId);
    ctx.assertEmpty(tag);
    ctx.append(roomCreated, {
      eventType: roomCreated.eventName,
      roomId: input.roomId,
      name: input.name ?? "",
    }, [tag]);
    return ctx.done({ roomId: input.roomId, name: input.name ?? "" });
  },
});

export const reserveRoomCommand = defineCommand<ReservationInput>({
  id: "reserve-room",
  parseInput: reservationInput,
  handler: (input, ctx) => {
    const room = ctx.state<{ readonly status?: string }>(roomTag(input.roomId));
    if (room === undefined) return ctx.reject("room does not exist", "room_missing");
    ctx.append(roomReserved, {
      eventType: roomReserved.eventName,
      roomId: input.roomId,
      reservationId: input.reservationId,
      userId: input.userId ?? "",
    }, [roomTag(input.roomId), reservationTag(input.reservationId)]);
    return ctx.done({ roomId: input.roomId, reservationId: input.reservationId });
  },
});

export const cancelReservationCommand = defineCommand<ReservationOnlyInput>({
  id: "cancel-reservation",
  parseInput: reservationOnlyInput,
  handler: (input, ctx) => {
    const reservation = ctx.state<{ readonly status?: string }>(reservationTag(input.reservationId));
    if (reservation === undefined) return ctx.reject("reservation does not exist", "reservation_missing");
    ctx.append(reservationCancelled, {
      eventType: reservationCancelled.eventName,
      reservationId: input.reservationId,
    }, [reservationTag(input.reservationId)]);
    return ctx.done({ reservationId: input.reservationId });
  },
});

export const releaseRoomCommand = defineCommand<RoomInput>({
  id: "release-room",
  parseInput: roomInput,
  handler: (input, ctx) => {
    const room = ctx.state<{ readonly status?: string }>(roomTag(input.roomId));
    if (room === undefined) return ctx.reject("room does not exist", "room_missing");
    if (room.status === "released") return ctx.noop("room is already released");
    ctx.append(roomReleased, {
      eventType: roomReleased.eventName,
      roomId: input.roomId,
    }, [roomTag(input.roomId)]);
    return ctx.done({ roomId: input.roomId });
  },
});

const roomProjector = defineProjector({
  id: "RoomProjector",
  version: 1,
  initialState: { version: 0, status: "empty", roomId: null as string | null, name: "" },
  handlers: {
    RoomCreated: (state, event) => {
      const payload = event.payload as { readonly roomId: string; readonly name?: string };
      return { version: state.version + 1, status: "created", roomId: payload.roomId, name: payload.name ?? "" };
    },
    RoomReleased: (state) => ({ ...state, version: state.version + 1, status: "released" }),
  },
});

const reservationProjector = defineProjector({
  id: "ReservationProjector",
  version: 1,
  initialState: { version: 0, status: "empty", reservationId: null as string | null, roomId: null as string | null },
  handlers: {
    RoomReserved: (state, event) => {
      const payload = event.payload as { readonly roomId: string; readonly reservationId: string };
      return { version: state.version + 1, status: "reserved", reservationId: payload.reservationId, roomId: payload.roomId };
    },
    ReservationCancelled: (state) => ({ ...state, version: state.version + 1, status: "cancelled" }),
  },
});

const roomQuery = {
  id: "GetRoomStateQuery",
  version: 1,
  queryType: "GetRoomStateQuery",
  endpoint: "query" as const,
  tagGroup: "room",
  tagProjector: "RoomProjector",
};
const reservationQuery = {
  id: "GetReservationListQuery",
  version: 1,
  queryType: "GetReservationListQuery",
  endpoint: "list-query" as const,
  tagGroup: "reservation",
  tagProjector: "ReservationProjector",
};

export const meetingRoomDomain = defineDomain({
  events: [roomCreated, roomReserved, reservationCancelled, roomReleased],
  commands: [createRoomCommand, reserveRoomCommand, cancelReservationCommand, releaseRoomCommand],
  projectors: [roomProjector, reservationProjector],
  queries: [roomQuery as DomainComponentDefinition, reservationQuery as DomainComponentDefinition],
  materializedViews: [{ id: "MeetingRoomSummary", version: 1 }],
});

export const meetingRoomRuntimeConfig = {
  projectorPayloadNames: {
    RoomProjector: "RoomState",
    ReservationProjector: "ReservationState",
  },
  queries: [roomQuery, reservationQuery],
} as const;

export const meetingRoomProjectors = { roomProjector, reservationProjector };
export const meetingRoomEvents = { roomCreated, roomReserved, reservationCancelled, roomReleased };
