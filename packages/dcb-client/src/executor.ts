import { assertJsonValue as assertCoreJsonValue } from "@sekiban/dcb-core";
import {
  executeCommand,
  normalizeTag,
  DomainAuthoringError,
  type CandidateEnvelope,
  type CommandDefinition,
  type CommandInput,
  type PortableSnapshot,
  type ProjectorLike,
  type SnapshotReader,
  type Tag,
} from "@sekiban/dcb-domain";
import {
  ClientError,
  type CommitEnvelope,
  type CommitHttpResult,
  type ExecuteCommitted,
  type ExecuteConflict,
  type ExecuteResult,
  type ListQueryRequest,
  type ListQueryResponse,
  type QueryRequest,
  type QueryResponse,
  type ReadonlyTagStateResponse,
  type SerializedDcbTransport,
  type TagLatestSortableResponse,
} from "./index";

/** The small Worker-side binding surface needed by the in-process adapter. */
export interface RuntimeBindings {
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly RUNTIME?: { readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  readonly runtime?: { readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
}

export interface ExecuteCommandOptions {
  readonly snapshots?: SnapshotReader | readonly PortableSnapshot[];
  readonly readMode?: "read-through" | "snapshot-only";
  readonly maxConflictRetries?: number;
  readonly signal?: AbortSignal;
  readonly totalBudgetMs?: number;
}

export interface ReadOptions {
  readonly consistency?: "safe" | "unsafe";
  readonly signal?: AbortSignal;
}

export interface WrittenEvent {
  readonly [key: string]: unknown;
}

export interface TagWriteResult {
  readonly [key: string]: unknown;
}

export type ExecutorCommitted = ExecuteCommitted & {
  readonly writtenEvents: readonly WrittenEvent[];
  readonly tagWriteResults: readonly TagWriteResult[];
  readonly head: string;
  readonly heads: readonly { readonly tag: Tag; readonly head: string }[];
};

export type ExecutorConflict = ExecuteConflict & {
  readonly conflicts: readonly {
    readonly tag: Tag;
    readonly expectedHead: string;
    readonly actualHead?: string;
  }[];
};

export type ExecuteCommandResult =
  | ExecutorCommitted
  | ExecutorConflict
  | Exclude<ExecuteResult, ExecuteCommitted | ExecuteConflict>;

export interface SekibanExecutor {
  execute<C extends CommandDefinition>(
    command: C,
    input: CommandInput<C>,
    options?: ExecuteCommandOptions,
  ): Promise<ExecuteCommandResult>;
  readState<P extends ProjectorLike>(projector: P, tag: Tag, options?: ReadOptions): Promise<PortableSnapshot>;
  exists(tag: Tag, options?: ReadOptions): Promise<PortableSnapshot<undefined>>;
  query(request: QueryRequest, options?: ReadOptions): Promise<QueryResponse>;
  listQuery(request: ListQueryRequest, options?: ReadOptions): Promise<ListQueryResponse>;
  readonly transport: SerializedDcbTransport;
}

export interface SekibanCloudTransportOptions {
  readonly BaseUrl: string;
  readonly ServiceId: string;
  readonly CredentialId: string;
  readonly CredentialSecret: string;
  readonly fetch?: typeof fetch;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpResult(value: unknown): value is CommitHttpResult {
  return isRecord(value) && typeof value.status === "number" && "body" in value;
}

function base64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return value;
  }
}

function bodyOf(value: unknown): unknown {
  return isHttpResult(value) ? value.body : value;
}

function httpFailure(value: CommitHttpResult): ClientError {
  const body = value.body;
  const code = isRecord(body) && typeof body.code === "string" ? body.code : "http_error";
  const message = isRecord(body) && typeof body.error === "string" ? body.error : `HTTP ${value.status}`;
  return new ClientError(code, message, {
    status: value.status,
    partial: isRecord(body) ? body.partial : undefined,
  });
}

function successfulBody<T>(value: T | CommitHttpResult): T {
  if (isHttpResult(value)) {
    if (value.status < 200 || value.status >= 300) throw httpFailure(value);
    return value.body as T;
  }
  return value;
}

async function responseResult(response: Response): Promise<CommitHttpResult> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = { code: "transport", error: `HTTP ${response.status}` };
  }
  return { status: response.status, body };
}

function v1Envelope(request: CommitEnvelope): Record<string, unknown> {
  return {
    version: 1,
    eventCandidates: request.candidates.map((candidate) => ({
      payload: base64Json(candidate.payload),
      eventPayloadName: candidate.eventPayloadName,
      tags: [...candidate.tags],
    })),
    consistencyTags: request.consistency.map((entry) => ({
      tag: entry.tag,
      lastSortableUniqueId: entry.lastSortableUniqueId,
    })),
  };
}

function fetcherFrom(bindings: RuntimeBindings): Fetcher {
  const selected = bindings.fetch ?? bindings.RUNTIME?.fetch ?? bindings.runtime?.fetch;
  if (selected === undefined) throw new ClientError("transport", "In-process runtime fetch binding is missing");
  const owner = bindings.fetch !== undefined ? bindings : bindings.RUNTIME ?? bindings.runtime;
  return owner === undefined ? selected : selected.bind(owner);
}

interface HttpTransportOptions {
  readonly baseUrl: string;
  readonly headers?: Record<string, string>;
  readonly fetch?: typeof fetch;
  readonly serviceId?: string;
}

function makeHttpTransport(options: HttpTransportOptions): SerializedDcbTransport {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl: Fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const headers = { "content-type": "application/json", ...(options.headers ?? {}) };
  const call = async (path: string, body: unknown, signal?: AbortSignal): Promise<CommitHttpResult> => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    return responseResult(response);
  };
  const read = async <T>(path: string, body: unknown, signal?: AbortSignal): Promise<T | CommitHttpResult> => {
    const result = await call(path, body, signal);
    return result.status >= 200 && result.status < 300 ? result.body as T : result;
  };
  return Object.freeze({
    serviceId: options.serviceId,
    readTagState: (request: { readonly tagStateId: string }, signal?: AbortSignal) =>
      read<ReadonlyTagStateResponse>("/api/sekiban/serialized/tag-state", request, signal),
    readTagLatestSortable: (request: { readonly tag: string }, signal?: AbortSignal) =>
      read<TagLatestSortableResponse>("/api/sekiban/serialized/tag-latest-sortable", request, signal),
    commit: (request: CommitEnvelope, signal?: AbortSignal) => call("/api/sekiban/serialized/commit", v1Envelope(request), signal),
    query: (request: QueryRequest, signal?: AbortSignal) => read<QueryResponse>("/api/sekiban/serialized/query", request, signal),
    listQuery: (request: ListQueryRequest, signal?: AbortSignal) => read<ListQueryResponse>("/api/sekiban/serialized/list-query", request, signal),
  });
}

/** Use the Worker's internal service binding; no public HTTP hop is introduced. */
export function createInProcessTransport(
  env: RuntimeBindings,
  options: { readonly serviceId?: string } = {},
): SerializedDcbTransport {
  return makeHttpTransport({ baseUrl: "https://runtime.internal", fetch: fetcherFrom(env), serviceId: options.serviceId });
}

export function createHttpTransport(options: {
  readonly baseUrl: string;
  readonly headers?: Record<string, string>;
  readonly fetch?: typeof fetch;
}): SerializedDcbTransport {
  return makeHttpTransport(options);
}

function cloudResult<T>(value: T | CommitHttpResult): T | CommitHttpResult {
  if (isHttpResult(value) && (value.status === 401 || value.status === 403)) {
    throw new ClientError("credential.rejected", "SekibanCloud credential was rejected", { status: value.status });
  }
  return value;
}

export function createSekibanCloudTransport(options: SekibanCloudTransportOptions): SerializedDcbTransport {
  const base = makeHttpTransport({
    baseUrl: options.BaseUrl,
    serviceId: options.ServiceId,
    fetch: options.fetch,
    headers: {
      "X-Sekiban-Service-Id": options.ServiceId,
      "X-Sekiban-Credential-Id": options.CredentialId,
      "X-Sekiban-Credential-Secret": options.CredentialSecret,
    },
  });
  const protect = async <T>(operation: () => Promise<T | CommitHttpResult>): Promise<T | CommitHttpResult> => {
    try {
      return cloudResult(await operation());
    } catch (error) {
      if (error instanceof ClientError && error.code === "credential.rejected") throw error;
      throw new ClientError("transport", "SekibanCloud request failed");
    }
  };
  return Object.freeze({
    serviceId: options.ServiceId,
    readTagState: (request: { readonly tagStateId: string }, signal?: AbortSignal) =>
      protect(() => base.readTagState(request, signal)),
    readTagLatestSortable: (request: { readonly tag: string }, signal?: AbortSignal) =>
      protect(() => base.readTagLatestSortable!(request, signal)),
    commit: (request: CommitEnvelope, signal?: AbortSignal) => protect(() => base.commit(request, signal)),
    query: (request: QueryRequest, signal?: AbortSignal) => protect(() => base.query(request, signal)),
    listQuery: (request: ListQueryRequest, signal?: AbortSignal) => protect(() => base.listQuery(request, signal)),
  });
}

function snapshotKey(projectorId: string, tag: Tag): string {
  return `${projectorId}\u0000${tag.id}`;
}

function snapshotReaderFrom(
  executor: SekibanExecutor,
  supplied: SnapshotReader | readonly PortableSnapshot[] | undefined,
  readMode: "read-through" | "snapshot-only",
): SnapshotReader {
  const isSnapshotArray = (value: SnapshotReader | readonly PortableSnapshot[] | undefined): value is readonly PortableSnapshot[] => Array.isArray(value);
  const array = isSnapshotArray(supplied) ? supplied : undefined;
  const reader = supplied !== undefined && !isSnapshotArray(supplied) ? supplied : undefined;
  const byCell = new Map<string, PortableSnapshot>();
  const byTag = new Map<string, PortableSnapshot>();
  for (const snapshot of array ?? []) {
    byCell.set(snapshotKey(snapshot.projectorId, snapshot.tag), snapshot);
    byTag.set(snapshot.tag.id, snapshot);
  }
  const missing = (projectorId: string | undefined, tag: Tag): never => {
    throw new DomainAuthoringError("executor.snapshot_missing", `Snapshot is missing for ${projectorId ?? "exists"}/${tag.id}`);
  };
  const fallbackRead = async (projector: ProjectorLike, tag: Tag): Promise<PortableSnapshot> => {
    if (array !== undefined) {
      const found = byCell.get(snapshotKey(projector.id, tag));
      if (found !== undefined) return found;
      if (readMode === "snapshot-only") return missing(projector.id, tag);
    }
    if (reader !== undefined) {
      try {
        return await reader.read(projector, tag);
      } catch (error) {
        if (readMode === "snapshot-only") return missing(projector.id, tag);
        throw error;
      }
    }
    if (readMode === "snapshot-only") return missing(projector.id, tag);
    return executor.readState(projector, tag);
  };
  const fallbackExists = async (tag: Tag): Promise<boolean> => {
    const found = byTag.get(tag.id);
    if (found !== undefined) return found.exists;
    if (readMode === "snapshot-only") return missing(undefined, tag);
    if (reader !== undefined && reader.exists !== undefined) {
      return reader.exists(tag);
    }
    return (await executor.exists(tag)).exists;
  };
  const fallbackHead = async (tag: Tag): Promise<string | null> => {
    const found = byTag.get(tag.id);
    if (found !== undefined) return found.head;
    if (readMode === "snapshot-only") return missing(undefined, tag);
    if (reader !== undefined && reader.head !== undefined) {
      return reader.head(tag);
    }
    return (await executor.exists(tag)).head;
  };
  return { read: fallbackRead, exists: fallbackExists, head: fallbackHead };
}

function normalizedResponse(value: unknown, requestedTagStateId: string): ReadonlyTagStateResponse {
  const body = bodyOf(value);
  if (!isRecord(body) || typeof body.payload === "undefined") {
    throw new ClientError("invalid_read_snapshot", "Tag-state response was not an object");
  }
  if (typeof body.version !== "number" || typeof body.lastSortedUniqueId !== "string" ||
      typeof body.tagGroup !== "string" || typeof body.tagContent !== "string" || typeof body.tagProjector !== "string") {
    throw new ClientError("invalid_read_snapshot", "Tag-state response had invalid identity or head fields");
  }
  const stateId = `${body.tagGroup}:${body.tagContent}:${body.tagProjector}`;
  if (stateId !== requestedTagStateId) throw new ClientError("incoherent_read_snapshot", "Tag-state identity changed during one read", { status: 500 });
  return body as unknown as ReadonlyTagStateResponse;
}

function writtenEvents(value: unknown): readonly WrittenEvent[] {
  const body = bodyOf(value);
  return isRecord(body) && Array.isArray(body.writtenEvents)
    ? body.writtenEvents.filter(isRecord)
    : [];
}

function tagWriteResults(value: unknown): readonly TagWriteResult[] {
  const body = bodyOf(value);
  return isRecord(body) && Array.isArray(body.tagWriteResults)
    ? body.tagWriteResults.filter(isRecord)
    : [];
}

function stringField(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function responseHead(value: unknown, events: readonly WrittenEvent[]): string {
  const direct = stringField(bodyOf(value), "head");
  if (direct !== undefined) return direct;
  const suids = events.flatMap((event) => [event.sortableUniqueIdValue, event.suid, event.lastSortableUniqueId])
    .filter((candidate): candidate is string => typeof candidate === "string");
  return suids.sort().at(-1) ?? "";
}

function responseHeads(
  value: unknown,
  claims: readonly { readonly tag: Tag; readonly head: string | null }[],
  fallbackHead: string,
  updatedTags: ReadonlySet<string>,
): readonly { readonly tag: Tag; readonly head: string }[] {
  const responseBody = bodyOf(value);
  const raw = isRecord(responseBody) ? responseBody.heads : undefined;
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => {
      if (!isRecord(item) || typeof item.tag !== "string" || typeof item.head !== "string") return [];
      return [{ tag: normalizeTag(item.tag), head: item.head }];
    });
  }
  return claims.map((claim) => ({
    tag: claim.tag,
    head: updatedTags.has(claim.tag.id) ? fallbackHead : claim.head ?? "",
  }));
}

function conflictDetails(value: unknown): ExecutorConflict["conflicts"] {
  const body = bodyOf(value);
  const raw = isRecord(body) && Array.isArray(body.conflicts) ? body.conflicts : [];
  return raw.flatMap((item) => {
    if (!isRecord(item) || typeof item.tag !== "string" || typeof item.expectedHead !== "string") return [];
    return [{
      tag: normalizeTag(item.tag),
      expectedHead: item.expectedHead,
      ...(typeof item.actualHead === "string" ? { actualHead: item.actualHead } : {}),
    }];
  });
}

function envelopeFor(candidate: CandidateEnvelope): CommitEnvelope {
  const eventTags = new Set(candidate.events.flatMap((event) => event.tags.map((tag) => tag.id)));
  const consistency = new Map<string, string>();
  for (const claim of candidate.readClaims) {
    if (claim.head !== null && eventTags.has(claim.tag.id) && !consistency.has(claim.tag.id)) {
      consistency.set(claim.tag.id, claim.head);
    }
  }
  return {
    candidates: candidate.events.map((event) => ({
      eventId: `authoring:${event.ordinal}`,
      eventPayloadName: event.eventName,
      payload: assertCoreJsonValue(event.payload),
      tags: event.tags.map((tag) => tag.id),
    })),
    consistency: [...consistency].map(([tag, lastSortableUniqueId]) => ({ tag, lastSortableUniqueId })),
  };
}

function commitDecision(value: unknown): { readonly kind: "accepted" | "consistency-conflict" | "unknown" | "rejected"; readonly error?: unknown } {
  if (!isHttpResult(value)) return { kind: "accepted" };
  const body = value.body;
  const code = stringField(body, "code");
  if (value.status >= 200 && value.status < 300) return { kind: "accepted" };
  if (value.status === 409 || code === "consistency_conflict") return { kind: "consistency-conflict", error: body };
  if (value.status >= 500 || code === "unknown_outcome") return { kind: "unknown", error: body };
  return { kind: "rejected", error: body };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return isRecord(error) && typeof error.error === "string" ? error.error : String(error);
}

export function createSekibanExecutor(
  transport: SerializedDcbTransport,
  options: { readonly serviceId?: string; readonly clock?: () => number } = {},
): SekibanExecutor {
  const scopeMismatch = options.serviceId !== undefined && transport.serviceId !== undefined && options.serviceId !== transport.serviceId;
  const clock = options.clock ?? (() => Date.now());
  const executor = {} as {
    readState: SekibanExecutor["readState"];
    exists: SekibanExecutor["exists"];
    query: SekibanExecutor["query"];
    listQuery: SekibanExecutor["listQuery"];
    transport: SerializedDcbTransport;
    execute: SekibanExecutor["execute"];
  };

  const readState = async <P extends ProjectorLike>(projector: P, tag: Tag, readOptions: ReadOptions = {}): Promise<PortableSnapshot> => {
    const tagValue = normalizeTag(tag);
    const stateId = `${tagValue.id}:${projector.id}`;
    const raw = await transport.readTagState({ tagStateId: stateId }, readOptions.signal);
    const response = normalizedResponse(raw, stateId);
    const decoded = decodeJson(response.payload);
    const empty = isRecord(decoded) && decoded.status === "empty";
    const state = empty
      ? (typeof projector.initialState === "function" ? projector.initialState() : projector.initialState)
      : decoded;
    return Object.freeze({
      projectorId: projector.id,
      tag: tagValue,
      head: response.lastSortedUniqueId.length === 0 ? null : response.lastSortedUniqueId,
      state,
      exists: !empty,
    });
  };

  const exists = async (tag: Tag, readOptions: ReadOptions = {}): Promise<PortableSnapshot<undefined>> => {
    if (transport.readTagLatestSortable === undefined) throw new ClientError("transport", "Transport does not implement exists reads");
    const tagValue = normalizeTag(tag);
    const raw = await transport.readTagLatestSortable({ tag: tagValue.id }, readOptions.signal);
    const value = successfulBody<TagLatestSortableResponse>(raw);
    if (typeof value.lastSortableUniqueId !== "string" || typeof value.exists !== "boolean") {
      throw new ClientError("invalid_read_snapshot", "Latest-sortable response was invalid");
    }
    return Object.freeze({
      projectorId: "exists",
      tag: tagValue,
      head: value.lastSortableUniqueId.length === 0 ? null : value.lastSortableUniqueId,
      state: undefined,
      exists: value.exists,
    });
  };

  const query = async (request: QueryRequest, readOptions: ReadOptions = {}): Promise<QueryResponse> =>
    successfulBody(await transport.query(request, readOptions.signal));
  const listQuery = async (request: ListQueryRequest, readOptions: ReadOptions = {}): Promise<ListQueryResponse> =>
    successfulBody(await transport.listQuery(request, readOptions.signal));

  const execute = async <C extends CommandDefinition>(command: C, input: CommandInput<C>, executeOptions: ExecuteCommandOptions = {}): Promise<ExecuteCommandResult> => {
    if (scopeMismatch) return { kind: "invalid", attempts: 0, code: "scope.mismatch", error: "Executor service scope does not match its transport" };
    const snapshots = snapshotReaderFrom(executor, executeOptions.snapshots, executeOptions.readMode ?? "read-through");
    const maxConflictRetries = executeOptions.readMode === "snapshot-only" ? 0 : executeOptions.maxConflictRetries ?? 1;
    let commitAttempts = 0;
    let lastResponse: unknown;
    try {
      const result = await executeCommand(command, input, {
        timeProvider: { now: clock },
        snapshots,
        maxConflictRetries,
        commit: async (candidate) => {
          commitAttempts += 1;
          const raw = await transport.commit(envelopeFor(candidate), executeOptions.signal);
          lastResponse = raw;
          const decision = commitDecision(raw);
          if (decision.kind === "consistency-conflict") {
            return commitAttempts > maxConflictRetries
              ? { kind: "rejected", error: decision.error }
              : { kind: "consistency-conflict", error: decision.error };
          }
          if (decision.kind === "unknown") return { kind: "unknown", error: decision.error };
          if (decision.kind === "rejected") return { kind: "rejected", error: decision.error };
          return { kind: "accepted" };
        },
        onPropagation: undefined,
      });
      if (result.status === "accepted") {
        const events = writtenEvents(lastResponse);
        const head = responseHead(lastResponse, events);
        const updatedTags = new Set(result.envelope?.events.flatMap((event) => event.tags.map((tag) => tag.id)) ?? []);
        return {
          kind: "committed",
          attempts: result.attempts,
          status: isHttpResult(lastResponse) ? lastResponse.status : 200,
          response: bodyOf(lastResponse),
          writtenEvents: events,
          tagWriteResults: tagWriteResults(lastResponse),
          head,
          heads: responseHeads(lastResponse, result.envelope?.readClaims.map((claim) => ({ tag: claim.tag, head: claim.head })) ?? [], head, updatedTags),
        };
      }
      if (result.status === "discarded") {
        if (result.decision.kind === "none") return { kind: "noop", attempts: result.attempts, reason: result.decision.reason };
        const details = result.decision.kind === "reject" && typeof result.decision.details === "string"
          ? result.decision.details
          : undefined;
        return {
          kind: "rejected",
          attempts: result.attempts,
          error: result.decision.kind === "reject" ? result.decision.reason : "Command was rejected",
          code: result.decision.kind === "reject" ? details ?? result.decision.code : "command_rejected",
        };
      }
      if (result.status === "rejected") {
        const conflict = result.error !== undefined && lastResponse !== undefined && isHttpResult(lastResponse)
          && (lastResponse.status === 409 || stringField(lastResponse.body, "code") === "consistency_conflict");
        if (conflict) {
          return {
            kind: "conflict",
            attempts: result.attempts,
            status: isHttpResult(lastResponse) ? lastResponse.status : undefined,
            code: "consistency_conflict",
            response: bodyOf(lastResponse),
            conflicts: conflictDetails(lastResponse),
          };
        }
        if (result.error !== undefined) {
          return { kind: "rejected", attempts: result.attempts, error: errorText(result.error), code: stringField(result.error, "code") };
        }
        const details = result.decision.kind === "reject" && typeof result.decision.details === "string"
          ? result.decision.details
          : undefined;
        return {
          kind: "rejected",
          attempts: result.attempts,
          error: result.decision.kind === "reject" ? result.decision.reason : "Command was rejected",
          code: result.decision.kind === "reject" ? details ?? result.decision.code : "command_rejected",
        };
      }
      if (result.status === "unknown") return { kind: "timeout", attempts: result.attempts, code: "unknown_outcome", error: errorText(result.error) };
      return { kind: "rejected", attempts: result.attempts, error: `Command ${command.id} was rejected`, code: "command_rejected" };
    } catch (error) {
      if (error instanceof DomainAuthoringError && error.code === "executor.snapshot_missing") {
        return { kind: "invalid", attempts: 0, code: error.code, error: error.message };
      }
      if (error instanceof ClientError) {
        if (error.code === "timeout" || error.code === "aborted") return { kind: "timeout", attempts: 1, code: error.code, error: error.message };
        return { kind: "invalid", attempts: 1, status: error.status, code: error.code, error: error.message };
      }
      return { kind: "transport", attempts: 1, error: errorText(error) };
    }
  };
  executor.readState = readState;
  executor.exists = exists;
  executor.query = query;
  executor.listQuery = listQuery;
  executor.transport = transport;
  executor.execute = execute;
  return Object.freeze(executor);
}
