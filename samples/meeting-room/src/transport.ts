import {
  createInProcessTransport,
  createSekibanExecutor,
  type ExecuteCommandOptions,
  type ExecuteCommandResult,
  type CommitEnvelope,
  type CommitHttpResult,
  type ReadonlyTagStateResponse,
  type SerializedDcbTransport,
} from "@sekiban/dcb-client";
import { normalizeTag, type PortableSnapshot } from "@sekiban/dcb-domain";
import { assertJsonValue } from "@sekiban/dcb-core";
import {
  cancelReservationCommand,
  createRoomCommand,
  meetingRoomCommands,
  releaseRoomCommand,
  reserveRoomCommand,
  reservationTag,
  roomTag,
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
const G65_GLOBAL_ADMISSION_HEADER = "x-sdt-global-admission";
export type GlobalAdmissionStatus = "admitted" | "not-admitted" | "unknown";
const globalAdmissionByResult = new WeakMap<object, GlobalAdmissionStatus>();

/**
 * Admission is an HTTP response-header concern. Keep the transport metadata
 * out of the ExecuteResult object so V1 JSON serialization cannot acquire a
 * sample-only body member.
 */
export function globalAdmissionStatusFromResult(result: object): GlobalAdmissionStatus {
  return globalAdmissionByResult.get(result) ?? "unknown";
}

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

interface V1ConsistencyClaim {
  readonly tag: string;
  readonly head: string | null;
  readonly lastSortableUniqueId: string;
}

/** Keep the SDT-G56 empty-head sentinel explicit at the sample wire boundary. */
function v1ConsistencyEntry(claim: V1ConsistencyClaim): { readonly tag: string; readonly lastSortableUniqueId: string } {
  return {
    tag: claim.tag,
    lastSortableUniqueId: claim.head !== null ? claim.lastSortableUniqueId : "",
  };
}

/** The public V1 transport remains byte-compatible; authoring owns the candidate above it. */
export function createV1Transport(fetcher: InternalRuntimeFetcher, serviceId?: string): SerializedDcbTransport {
  const call = async (path: string, body: unknown, signal?: AbortSignal): Promise<CommitHttpResult> => {
    const response = await fetcher.fetch(`https://runtime.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...serviceHeaders(serviceId) },
      body: JSON.stringify(body),
      signal,
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    return {
      status: response.status,
      headers,
      body: await readBody(response),
    };
  };
  return {
    serviceId,
    async readTagState(request, signal) {
      const result = await call("/api/sekiban/serialized/tag-state", request, signal);
      if (result.status >= 200 && result.status < 300) return result.body as ReadonlyTagStateResponse;
      return result;
    },
    async readTagLatestSortable(request, signal) {
      const result = await call("/api/sekiban/serialized/tag-latest-sortable", request, signal);
      if (result.status >= 200 && result.status < 300) return result.body as { readonly exists: boolean; readonly lastSortableUniqueId: string };
      return result;
    },
    async commit(request: CommitEnvelope, signal) {
      const wire = {
        version: 1,
        eventCandidates: request.candidates.map((candidate) => ({
          payload: jsonBytes(candidate.payload),
          eventPayloadName: candidate.eventPayloadName,
          tags: [...candidate.tags],
        })),
        consistencyTags: request.consistency.map((entry) => v1ConsistencyEntry({
          tag: entry.tag,
          head: entry.lastSortableUniqueId.length === 0 ? null : entry.lastSortableUniqueId,
          lastSortableUniqueId: entry.lastSortableUniqueId,
        })),
      };
      return call("/api/sekiban/serialized/commit", wire, signal);
    },
    async query(request, signal) {
      const result = await call("/api/sekiban/serialized/query", request, signal);
      if (result.status >= 200 && result.status < 300) return result.body as { readonly resultJson: string };
      return result;
    },
    async listQuery(request, signal) {
      const result = await call("/api/sekiban/serialized/list-query", request, signal);
      if (result.status >= 200 && result.status < 300) return result.body as {
        readonly itemsJson: string;
        readonly totalCount: number;
        readonly totalPages: number;
        readonly currentPage: number;
        readonly pageSize: number;
      };
      return result;
    },
  };
}

function runtimeFetcher(environment: MeetingRoomCommandEnvironment): InternalRuntimeFetcher {
  const selected = environment.RUNTIME ?? environment.localRuntime;
  if (selected === undefined) throw new Error("Meeting-room commands require the internal RUNTIME service binding");
  return selected;
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

export interface MeetingRoomCommandExecutor {
  execute(commandId: string, input: unknown, options?: ExecuteCommandOptions): Promise<ExecuteCommandResult>;
}

export interface MeetingRoomCommandRequest {
  readonly input: unknown;
  readonly options?: ExecuteCommandOptions;
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

/** Accepts the legacy raw command body and the executor envelope used by the UI. */
export function parseMeetingRoomCommandRequest(body: unknown): MeetingRoomCommandRequest {
  if (!isRecord(body) || !("input" in body) || !isRecord(body.executor)) return { input: body };
  const executor = body.executor;
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

function admissionFrom(response: unknown): GlobalAdmissionStatus {
  const headers = isRecord(response) && isRecord(response.headers) ? response.headers : undefined;
  const value = typeof headers?.[G65_GLOBAL_ADMISSION_HEADER] === "string"
    ? headers[G65_GLOBAL_ADMISSION_HEADER]
    : undefined;
  return value === "admitted" || value === "not-admitted" || value === "unknown" ? value : "unknown";
}

function mergeAdmission(
  current: GlobalAdmissionStatus | undefined,
  incoming: GlobalAdmissionStatus,
): GlobalAdmissionStatus {
  if (current === undefined) return incoming;
  if (current === "not-admitted" || incoming === "not-admitted") return "not-admitted";
  if (current === "unknown" || incoming === "unknown") return "unknown";
  return "admitted";
}

function withAdmission<T extends object>(result: T, globalAdmission: GlobalAdmissionStatus): T {
  globalAdmissionByResult.set(result, globalAdmission);
  return result;
}

export function commandExecutor(environment: MeetingRoomCommandEnvironment): MeetingRoomCommandExecutor {
  const transport = createInProcessTransport({ RUNTIME: runtimeFetcher(environment) }, { serviceId: environment.serviceId });
  return {
    async execute(commandId, input, options) {
      const command = commandFor(commandId);
      if (command === undefined) {
        return withAdmission({ kind: "invalid", attempts: 0, error: "Unknown meeting-room command", code: "command_not_found" }, "unknown");
      }
      let globalAdmission: GlobalAdmissionStatus | undefined;
      const trackedTransport: SerializedDcbTransport = {
        ...transport,
        commit: async (envelope, signal) => {
          const response = await transport.commit(envelope, signal);
          globalAdmission = mergeAdmission(globalAdmission, admissionFrom(response));
          return response;
        },
      };
      const executor = createSekibanExecutor(trackedTransport, { serviceId: environment.serviceId });
      const result = await executor.execute(command, input as never, options);
      return withAdmission(result, globalAdmission ?? "unknown");
    },
  };
}

export async function executeMeetingRoomCommand(
  commandId: string,
  input: unknown,
  environment: MeetingRoomCommandEnvironment,
  options?: ExecuteCommandOptions,
): Promise<ExecuteCommandResult> {
  return commandExecutor(environment).execute(commandId, input, options);
}

export function roomStateId(roomId: string): string {
  return `${roomTag(roomId).id}:RoomProjector`;
}

export function reservationStateId(reservationId: string): string {
  return `${reservationTag(reservationId).id}:ReservationProjector`;
}

export const authoredCommandIds = Object.freeze(Object.keys(meetingRoomCommands));
