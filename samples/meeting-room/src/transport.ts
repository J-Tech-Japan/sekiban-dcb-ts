import {
  ClaimLedgerExecutor,
  type CommitEnvelope,
  type CommitHttpResult,
  type ExecuteResult,
  type SerializedDcbTransport,
} from "@sekiban/dcb-client";
import { assertJsonValue } from "@sekiban/dcb-core";
import {
  cancelReservationCommand,
  createRoomCommand,
  releaseRoomCommand,
  reserveRoomCommand,
  reservationTag,
  roomTag,
  meetingRoomEvents,
} from "./domain";

export interface InternalRuntimeFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface MeetingRoomCommandEnvironment {
  readonly RUNTIME?: InternalRuntimeFetcher;
  readonly serviceId?: string;
  /** Local Miniflare-only fallback; production uses the RUNTIME binding. */
  readonly localRuntime?: InternalRuntimeFetcher;
}

const G11_SERVICE_ID_HEADER = "x-sdt-g11-service-id";

function jsonBytes(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function serviceHeaders(serviceId: string | undefined): HeadersInit {
  return serviceId !== undefined && /^g11-[A-Za-z0-9-]{8,96}$/.test(serviceId)
    ? { [G11_SERVICE_ID_HEADER]: serviceId }
    : {};
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return { error: `HTTP ${response.status}`, code: "transport" };
  }
}

export function createV1Transport(
  fetcher: InternalRuntimeFetcher,
  serviceId?: string,
): SerializedDcbTransport {
  const call = async (path: string, body: unknown, signal?: AbortSignal): Promise<CommitHttpResult> => {
    const response = await fetcher.fetch(`https://runtime.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...serviceHeaders(serviceId) },
      body: JSON.stringify(body),
      signal,
    });
    return { status: response.status, body: await readBody(response) };
  };
  return {
    async readTagState(request, signal) {
      const result = await call("/api/sekiban/serialized/tag-state", request, signal);
      if (result.status >= 200 && result.status < 300) return result.body as never;
      return result;
    },
    async commit(request: CommitEnvelope, signal) {
      const wire = {
        version: 1,
        eventCandidates: request.candidates.map((candidate) => ({
          payload: jsonBytes(assertJsonValue(candidate.payload, "event-construction")),
          eventPayloadName: candidate.eventPayloadName,
          tags: [...candidate.tags],
        })),
        consistencyTags: request.consistency.map((entry) => ({
          tag: entry.tag,
          lastSortableUniqueId: entry.lastSortableUniqueId,
        })),
      };
      return call("/api/sekiban/serialized/commit", wire, signal);
    },
  };
}

function runtimeFetcher(environment: MeetingRoomCommandEnvironment): InternalRuntimeFetcher {
  const selected = environment.RUNTIME ?? environment.localRuntime;
  if (selected === undefined) throw new Error("Meeting-room commands require the internal RUNTIME service binding");
  return selected;
}

function roomStateId(roomId: string): string {
  return `${roomTag(roomId).id}:RoomProjector`;
}

function reservationStateId(reservationId: string): string {
  return `${reservationTag(reservationId).id}:ReservationProjector`;
}

export function commandExecutor(environment: MeetingRoomCommandEnvironment): ClaimLedgerExecutor {
  return new ClaimLedgerExecutor({
    transport: createV1Transport(runtimeFetcher(environment), environment.serviceId),
    maxConflictRetries: 1,
  });
}

export async function executeMeetingRoomCommand(
  commandId: string,
  input: unknown,
  environment: MeetingRoomCommandEnvironment,
): Promise<ExecuteResult> {
  const executor = commandExecutor(environment);
  try {
    switch (commandId) {
      case "create-room": {
        const parsed = createRoomCommand.parseInput(input);
        return executor.execute(async (ctx) => {
          const tag = roomTag(parsed.roomId);
          const existing = await ctx.state(`${tag.id}:RoomProjector`);
          if (existing !== undefined && existing !== null && typeof existing === "object" && !Array.isArray(existing) && (existing as Record<string, unknown>).status !== "empty") {
            return { kind: "rejected", error: "room already exists", code: "room_exists" };
          }
          ctx.append(meetingRoomEvents.roomCreated, {
            eventType: meetingRoomEvents.roomCreated.eventName,
            roomId: parsed.roomId,
            name: parsed.name ?? "",
          }, [tag]);
          return { kind: "committed", value: { roomId: parsed.roomId } };
        });
      }
      case "reserve-room": {
        const parsed = reserveRoomCommand.parseInput(input);
        return executor.execute(async (ctx) => {
          const state = await ctx.state(roomStateId(parsed.roomId));
          if (state === undefined || state === null) return { kind: "rejected", error: "room does not exist", code: "room_missing" };
          ctx.append(meetingRoomEvents.roomReserved, {
            eventType: meetingRoomEvents.roomReserved.eventName,
            roomId: parsed.roomId,
            reservationId: parsed.reservationId,
            userId: parsed.userId ?? "",
          }, [roomTag(parsed.roomId), reservationTag(parsed.reservationId)]);
          return { kind: "committed", value: { reservationId: parsed.reservationId } };
        });
      }
      case "cancel-reservation": {
        const parsed = cancelReservationCommand.parseInput(input);
        return executor.execute(async (ctx) => {
          const state = await ctx.state(reservationStateId(parsed.reservationId));
          if (state === undefined || state === null) return { kind: "rejected", error: "reservation does not exist", code: "reservation_missing" };
          ctx.append(meetingRoomEvents.reservationCancelled, {
            eventType: meetingRoomEvents.reservationCancelled.eventName,
            reservationId: parsed.reservationId,
          }, [reservationTag(parsed.reservationId)]);
          return { kind: "committed", value: { reservationId: parsed.reservationId } };
        });
      }
      case "release-room": {
        const parsed = releaseRoomCommand.parseInput(input);
        return executor.execute(async (ctx) => {
          const state = await ctx.state(roomStateId(parsed.roomId));
          if (state === undefined || state === null) return { kind: "rejected", error: "room does not exist", code: "room_missing" };
          if (typeof state === "object" && state !== null && !Array.isArray(state) && (state as Record<string, unknown>).status === "released") {
            return { kind: "noop", reason: "room is already released" };
          }
          ctx.append(meetingRoomEvents.roomReleased, {
            eventType: meetingRoomEvents.roomReleased.eventName,
            roomId: parsed.roomId,
          }, [roomTag(parsed.roomId)]);
          return { kind: "committed", value: { roomId: parsed.roomId } };
        });
      }
      default:
        return { kind: "invalid", attempts: 0, error: "Unknown meeting-room command", code: "command_not_found" };
    }
  } catch (error) {
    return {
      kind: "invalid",
      attempts: 0,
      error: error instanceof Error ? error.message : "Command input was invalid",
      code: "invalid_command_input",
    };
  }
}
