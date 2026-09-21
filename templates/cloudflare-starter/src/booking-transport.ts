import {
  createInProcessTransport,
  createSekibanExecutor,
  type CommitEnvelope,
  type CommitHttpResult,
  type ExecuteCommandOptions,
  type ExecuteCommandResult,
  type ReadonlyTagStateResponse,
  type SerializedDcbTransport,
} from "@sekiban/dcb-client";
import { normalizeTag, type PortableSnapshot } from "@sekiban/dcb-domain";
import { assertJsonValue } from "@sekiban/dcb-core";
import {
  bookingCommands,
  cancelReservationCommand,
  createRoomCommand,
  releaseRoomCommand,
  reserveRoomCommand,
} from "./booking-domain";

export interface InternalRuntimeFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface BookingCommandEnvironment {
  readonly RUNTIME: InternalRuntimeFetcher;
  readonly serviceId: string;
}

export interface BookingCommandRequest {
  readonly input: unknown;
  readonly options?: ExecuteCommandOptions;
}

function jsonBytes(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function v1ConsistencyEntry(entry: { readonly tag: string; readonly lastSortableUniqueId: string }): { readonly tag: string; readonly lastSortableUniqueId: string } {
  return { tag: entry.tag, lastSortableUniqueId: entry.lastSortableUniqueId };
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return { error: `HTTP ${response.status}`, code: "transport" };
  }
}

/** Small V1 transport used by the demo's query routes. */
export function createV1Transport(fetcher: InternalRuntimeFetcher, serviceId: string): SerializedDcbTransport {
  const call = async (path: string, body: unknown, signal?: AbortSignal): Promise<CommitHttpResult> => {
    const response = await fetcher.fetch(`https://runtime.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    return { status: response.status, headers, body: await readBody(response) };
  };
  return {
    serviceId,
    async readTagState(request, signal) {
      const result = await call("/api/sekiban/serialized/tag-state", request, signal);
      return result.status >= 200 && result.status < 300 ? result.body as ReadonlyTagStateResponse : result;
    },
    async readTagLatestSortable(request, signal) {
      const result = await call("/api/sekiban/serialized/tag-latest-sortable", request, signal);
      return result.status >= 200 && result.status < 300
        ? result.body as { readonly exists: boolean; readonly lastSortableUniqueId: string }
        : result;
    },
    async commit(request: CommitEnvelope, signal) {
      return call("/api/sekiban/serialized/commit", {
        version: 1,
        eventCandidates: request.candidates.map((candidate) => ({
          payload: jsonBytes(candidate.payload),
          eventPayloadName: candidate.eventPayloadName,
          tags: [...candidate.tags],
        })),
        consistencyTags: request.consistency.map(v1ConsistencyEntry),
      }, signal);
    },
    async query(request, signal) {
      const result = await call("/api/sekiban/serialized/query", request, signal);
      return result.status >= 200 && result.status < 300 ? result.body as { readonly resultJson: string } : result;
    },
    async listQuery(request, signal) {
      const result = await call("/api/sekiban/serialized/list-query", request, signal);
      return result.status >= 200 && result.status < 300 ? result.body as {
        readonly itemsJson: string;
        readonly totalCount: number;
        readonly totalPages: number;
        readonly currentPage: number;
        readonly pageSize: number;
      } : result;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function portableSnapshot(value: unknown): PortableSnapshot {
  if (!isRecord(value) || typeof value.projectorId !== "string" || typeof value.tag !== "string" ||
      (value.head !== null && typeof value.head !== "string") || typeof value.exists !== "boolean" || !("state" in value)) {
    throw new Error("Portable snapshot fields are invalid");
  }
  return Object.freeze({
    projectorId: value.projectorId,
    tag: normalizeTag(value.tag),
    head: value.head as string | null,
    state: assertJsonValue(value.state, "state-persistence"),
    exists: value.exists,
  });
}

export function parseBookingCommandRequest(body: unknown): BookingCommandRequest {
  if (!isRecord(body) || !("input" in body)) return { input: body };
  const executor = body.executor;
  if (executor === undefined) return { input: body.input };
  if (!isRecord(executor)) throw new Error("executor must be an object");
  const readMode = executor.readMode;
  if (readMode !== undefined && readMode !== "read-through" && readMode !== "snapshot-only") {
    throw new Error("Executor readMode must be read-through or snapshot-only");
  }
  const rawSnapshots = executor.snapshots;
  if (rawSnapshots !== undefined && !Array.isArray(rawSnapshots)) throw new Error("Executor snapshots must be an array");
  const snapshots = rawSnapshots === undefined ? undefined : rawSnapshots.map(portableSnapshot);
  return {
    input: body.input,
    options: {
      ...(snapshots === undefined ? {} : { snapshots }),
      ...(readMode === undefined ? {} : { readMode }),
    },
  };
}

function commandFor(commandId: string) {
  switch (commandId) {
    case "create-room": return createRoomCommand;
    case "reserve-room": return reserveRoomCommand;
    case "cancel-reservation": return cancelReservationCommand;
    case "release-room": return releaseRoomCommand;
    default: return undefined;
  }
}

export async function executeBookingCommand(
  commandId: string,
  input: unknown,
  environment: BookingCommandEnvironment,
  options?: ExecuteCommandOptions,
): Promise<ExecuteCommandResult> {
  const command = commandFor(commandId);
  if (command === undefined || !(commandId in bookingCommands)) {
    return { kind: "invalid", attempts: 0, error: "Unknown booking command", code: "command_not_found" } as ExecuteCommandResult;
  }
  const transport = createInProcessTransport({ RUNTIME: environment.RUNTIME }, { serviceId: environment.serviceId });
  const executor = createSekibanExecutor(transport, { serviceId: environment.serviceId });
  return executor.execute(command, input as never, options);
}
