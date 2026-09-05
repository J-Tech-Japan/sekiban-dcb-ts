import {
  type CommitEnvelope,
  type CommitHttpResult,
  type ExecuteResult,
  type ReadonlyTagStateResponse,
  type SerializedDcbTransport,
} from "@sekiban/dcb-client";
import {
  executeCommand,
  type CandidateEnvelope,
  type PortableSnapshot,
  type ProjectorLike,
  type SnapshotReader,
  type Tag,
} from "@sekiban/dcb-domain";
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
type GlobalAdmissionStatus = "admitted" | "not-admitted" | "unknown";
type MeetingRoomExecuteResult = ExecuteResult & { readonly globalAdmission?: GlobalAdmissionStatus };

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

function decodeJsonBytes(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return value;
  }
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
    async readTagState(request, signal) {
      const result = await call("/api/sekiban/serialized/tag-state", request, signal);
      if (result.status >= 200 && result.status < 300) return result.body as ReadonlyTagStateResponse;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTagStateResponse(value: unknown): value is ReadonlyTagStateResponse {
  return isRecord(value) &&
    typeof value.version === "number" &&
    typeof value.lastSortedUniqueId === "string" &&
    typeof value.tagGroup === "string" &&
    typeof value.tagContent === "string" &&
    typeof value.tagProjector === "string" &&
    "payload" in value;
}

function stateExists(payload: unknown): boolean {
  return isRecord(payload) && payload.status !== "empty";
}

function snapshotReader(transport: SerializedDcbTransport): SnapshotReader {
  const snapshots = new Map<string, PortableSnapshot>();
  return {
    read: async (projector: ProjectorLike, tag: Tag): Promise<PortableSnapshot> => {
      const key = `${tag.id}:${projector.id}`;
      const cached = snapshots.get(key);
      if (cached !== undefined) return cached;
      const value = await transport.readTagState({ tagStateId: key });
      if (!isTagStateResponse(value)) throw new Error("Runtime tag-state response was invalid");
      const responseTag = `${value.tagGroup}:${value.tagContent}`;
      if (responseTag !== tag.id || value.tagProjector !== projector.id) {
        throw new Error("Runtime tag-state response crossed a tag/projector boundary");
      }
      const decodedPayload = decodeJsonBytes(value.payload);
      const snapshotState = isRecord(decodedPayload) && decodedPayload.status === "empty"
        ? typeof projector.initialState === "function" ? projector.initialState() : projector.initialState
        : decodedPayload;
      const snapshot: PortableSnapshot = Object.freeze({
        projectorId: projector.id,
        tag,
        head: value.lastSortedUniqueId.length === 0 ? null : value.lastSortedUniqueId,
        state: snapshotState,
        exists: stateExists(decodedPayload),
      });
      snapshots.set(key, snapshot);
      return snapshot;
    },
  };
}

function v1CandidateEnvelope(envelope: CandidateEnvelope): CommitEnvelope {
  const eventTags = new Set(envelope.events.flatMap((event) => event.tags.map((tag) => tag.id)));
  const consistency = new Map<string, string>();
  for (const claim of envelope.readClaims) {
    if (eventTags.has(claim.tag.id) && claim.head !== null && !consistency.has(claim.tag.id)) {
      consistency.set(claim.tag.id, claim.head);
    }
  }
  return {
    candidates: envelope.events.map((event) => ({
      eventId: `authoring:${event.ordinal}`,
      eventPayloadName: event.eventName,
      payload: assertJsonValue(event.payload),
      tags: event.tags.map((tag) => tag.id),
    })),
    consistency: [...consistency].map(([tag, lastSortableUniqueId]) => ({ tag, lastSortableUniqueId })),
  };
}

function commitOutcome(value: unknown): { readonly kind: "accepted" | "consistency-conflict" | "unknown" | "rejected"; readonly error?: unknown; readonly code?: string } {
  if (!isRecord(value) || typeof value.status !== "number") return { kind: "accepted" };
  const body = isRecord(value.body) ? value.body : undefined;
  const code = typeof body?.code === "string" ? body.code : undefined;
  if (value.status >= 200 && value.status < 300) return { kind: "accepted" };
  if (value.status === 409 || code === "consistency_conflict") return { kind: "consistency-conflict", error: body, code };
  if (value.status === 504 || value.status >= 500) return { kind: "unknown", error: body, code };
  return { kind: "rejected", error: body, code };
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.error === "string") return error.error;
  if (error instanceof Error) return error.message;
  return String(error);
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

function withAdmission(result: ExecuteResult, globalAdmission: GlobalAdmissionStatus): MeetingRoomExecuteResult {
  return { ...result, globalAdmission };
}

function publicResult(
  commandId: string,
  result: Awaited<ReturnType<typeof executeCommand>>,
  commitResponseBody?: unknown,
): ExecuteResult {
  if (result.status === "accepted") {
    return {
      kind: "committed",
      attempts: result.attempts,
      status: 200,
      response: commitResponseBody ?? (result.decision.kind === "done" ? result.decision.value : undefined),
    };
  }
  if (result.status === "discarded") {
    if (result.decision.kind === "none") return { kind: "noop", attempts: result.attempts, reason: result.decision.reason };
    const details = result.decision.kind === "reject" && typeof result.decision.details === "string" ? result.decision.details : undefined;
    return {
      kind: "rejected",
      attempts: result.attempts,
      error: result.decision.kind === "reject" ? result.decision.reason : "Command was rejected",
      code: details ?? (result.decision.kind === "reject" ? result.decision.code : "command_rejected"),
    };
  }
  if (result.status === "unknown") return { kind: "timeout", attempts: result.attempts, code: "unknown_outcome", error: errorMessage(result.error) };
  if (result.status === "rejected") {
    if (result.decision.kind === "reject") {
      const details = typeof result.decision.details === "string" ? result.decision.details : undefined;
      return { kind: "rejected", attempts: result.attempts, error: result.decision.reason, code: details ?? result.decision.code };
    }
    const error = result.error;
    return { kind: "rejected", attempts: result.attempts, error: errorMessage(error), code: errorCode(error) ?? "commit_rejected" };
  }
  return { kind: "invalid", attempts: result.attempts, error: `Command ${commandId} did not produce a terminal outcome`, code: "invalid_command_result" };
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
  execute(commandId: string, input: unknown): Promise<ExecuteResult>;
}

export function commandExecutor(environment: MeetingRoomCommandEnvironment): MeetingRoomCommandExecutor {
  const transport = createV1Transport(runtimeFetcher(environment), environment.serviceId);
  return {
    async execute(commandId, input) {
      const command = commandFor(commandId);
      if (command === undefined) return withAdmission({ kind: "invalid", attempts: 0, error: "Unknown meeting-room command", code: "command_not_found" }, "unknown");
      try {
        let commitResponseBody: unknown;
        let globalAdmission: GlobalAdmissionStatus | undefined;
        const result = await executeCommand(command, input, {
          maxConflictRetries: 1,
          snapshots: snapshotReader(transport),
          timeProvider: { now: () => new Date().toISOString() },
          commit: async (envelope) => {
            const response = await transport.commit(v1CandidateEnvelope(envelope));
            if (isRecord(response) && isRecord(response.body)) commitResponseBody = response.body;
            globalAdmission = mergeAdmission(globalAdmission, admissionFrom(response));
            return commitOutcome(response);
          },
        });
        return withAdmission(publicResult(commandId, result, commitResponseBody), globalAdmission ?? "unknown");
      } catch (error) {
        const code = errorCode(error);
        return withAdmission({
          kind: "invalid",
          attempts: 1,
          error: errorMessage(error),
          code: code === "COMMAND_INPUT_INVALID" ? "invalid_command_input" : code ?? "invalid_command_input",
        }, "unknown");
      }
    },
  };
}

export async function executeMeetingRoomCommand(
  commandId: string,
  input: unknown,
  environment: MeetingRoomCommandEnvironment,
): Promise<ExecuteResult> {
  return commandExecutor(environment).execute(commandId, input);
}

export function roomStateId(roomId: string): string {
  return `${roomTag(roomId).id}:RoomProjector`;
}

export function reservationStateId(reservationId: string): string {
  return `${reservationTag(reservationId).id}:ReservationProjector`;
}

export const authoredCommandIds = Object.freeze(Object.keys(meetingRoomCommands));
