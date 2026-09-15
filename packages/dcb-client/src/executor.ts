import { assertJsonValue as assertCoreJsonValue } from "@sekiban/dcb-core";
import {
  executeCommand,
  normalizeTag,
  DomainAuthoringError,
  type CandidateEnvelope,
  type CommandDefinition,
  type CommandInput,
  type CommitAttemptResult,
  type PortableSnapshot,
  type ProjectorLike,
  type RejectKind,
  type SnapshotReader,
  type Tag,
} from "@sekiban/dcb-domain";
import {
  ClientError,
  type CommitEnvelope,
  type CommitHttpResult,
  type ExecuteCommitted,
  type ExecuteConflict,
  type ExecuteRejected,
  type ExecuteResult,
  type ListQueryRequest,
  type ListQueryResponse,
  type QueryRequest,
  type QueryResponse,
  type ReadonlyTagStateResponse,
  type SerializedDcbTransport,
  type TagLatestSortableResponse,
} from "./index";
import { classifyFailure, commitReplyError, failureKindForCode } from "./classification.js";
import { awaitControlled, totalBudgetMsProblem } from "./control.js";
import { sanitizeTransportError } from "./errors.js";
import { v1Envelope } from "./wire.js";

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

/** Options shared by tag-state, authority, and generic-query reads. */
export interface ReadOptions {
  readonly signal?: AbortSignal;
}

export type ReadConsistency = "safe" | "unsafe";

/** The consistency lane is deliberately available only on listQuery. */
export interface ListQueryOptions {
  readonly consistency?: ReadConsistency;
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

/** A rejection; `rejectKind` and `details` are present only for a handler's reject decision. */
export type ExecutorRejected = ExecuteRejected & {
  readonly rejectKind?: RejectKind;
  readonly details?: unknown;
};

export type ExecuteCommandResult =
  | ExecutorCommitted
  | ExecutorConflict
  | ExecutorRejected
  | Exclude<ExecuteResult, ExecuteCommitted | ExecuteConflict | ExecuteRejected>;

export interface SekibanExecutor {
  execute<C extends CommandDefinition>(
    command: C,
    input: CommandInput<C>,
    options?: ExecuteCommandOptions,
  ): Promise<ExecuteCommandResult>;
  readState<P extends ProjectorLike>(projector: P, tag: Tag, options?: ReadOptions): Promise<PortableSnapshot>;
  exists(tag: Tag, options?: ReadOptions): Promise<PortableSnapshot<undefined>>;
  query(request: QueryRequest, options?: ReadOptions): Promise<QueryResponse>;
  listQuery(request: ListQueryRequest, options?: ListQueryOptions): Promise<ListQueryResponse>;
  readonly transport: SerializedDcbTransport;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpResult(value: unknown): value is CommitHttpResult {
  return isRecord(value) && typeof value.status === "number" && "body" in value;
}

function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    // Fixtures and older adapters may expose the JSON text directly instead
    // of the runtime's base64 JSON representation.  Decode that representation
    // too; existence is still decided exclusively by the authority response.
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
}

function bodyOf(value: unknown): unknown {
  return isHttpResult(value) ? value.body : value;
}

function httpFailure(value: CommitHttpResult): ClientError {
  return sanitizeTransportError(value, { fallbackCode: "http_error", status: value.status });
}

function successfulBody<T>(value: T | CommitHttpResult): T {
  if (isHttpResult(value)) {
    if (value.status < 200 || value.status >= 300) throw httpFailure(value);
    return value.body as T;
  }
  return value;
}

/** Runs one adapter call; the executor passes a controlled runner for the reads `execute` makes. */
type AdapterRunner = <T>(operation: () => Promise<T> | T) => Promise<T>;

const uncontrolled: AdapterRunner = async (operation) => operation();

async function readCall<T>(operation: () => Promise<T | CommitHttpResult>, label: string, run: AdapterRunner = uncontrolled): Promise<T> {
  void label;
  // The runner's own abort/timeout refusal stays outside the sanitizer.
  return run(async () => {
    try {
      return successfulBody(await operation());
    } catch (error) {
      throw sanitizeTransportError(error, { fallbackCode: "transport" });
    }
  });
}

function compareSortableUniqueId(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function rejectUnsupportedConsistency(options: unknown): void {
  if (isRecord(options) && options.consistency !== undefined) {
    throw new ClientError(
      "unsupported_consistency_mode",
      "Consistency is supported only for listQuery reads",
      { status: 400 },
    );
  }
}

function normalizeAuthority(value: unknown): TagLatestSortableResponse {
  if (!isRecord(value) || typeof value.exists !== "boolean" || typeof value.lastSortableUniqueId !== "string") {
    throw new ClientError("invalid_read_snapshot", "Latest-sortable authority response was invalid");
  }
  if (!value.exists && value.lastSortableUniqueId.length > 0) {
    throw new ClientError("incoherent_read_snapshot", "Latest-sortable authority returned a head for an absent tag", { status: 500 });
  }
  return value as unknown as TagLatestSortableResponse;
}

async function readAuthority(
  transport: SerializedDcbTransport,
  tag: string,
  signal: AbortSignal | undefined,
  run: AdapterRunner,
): Promise<TagLatestSortableResponse> {
  if (transport.readTagLatestSortable === undefined) {
    throw new ClientError(
      "unsupported_capability",
      "Transport does not implement the tag-latest-sortable authority read",
      { status: 501 },
    );
  }
  const value = await readCall(
    () => transport.readTagLatestSortable!({ tag }, signal),
    "Tag-latest-sortable authority",
    run,
  );
  return normalizeAuthority(value);
}

function normalizedQueryResponse(value: unknown): QueryResponse {
  if (!isRecord(value) || typeof value.resultJson !== "string") {
    throw new ClientError("invalid_query_response", "Query response was invalid");
  }
  return value as unknown as QueryResponse;
}

function normalizedListQueryResponse(value: unknown): ListQueryResponse {
  if (!isRecord(value) || typeof value.itemsJson !== "string" ||
      typeof value.totalCount !== "number" || typeof value.totalPages !== "number" ||
      typeof value.currentPage !== "number" || typeof value.pageSize !== "number" ||
      (value.readHead !== undefined && typeof value.readHead !== "string")) {
    throw new ClientError("invalid_query_response", "List-query response was invalid");
  }
  return value as unknown as ListQueryResponse;
}

function requestWithListConsistency(request: ListQueryRequest, options: ListQueryOptions): ListQueryRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.queryParamsJson);
  } catch (error) {
    throw new ClientError("invalid_query_request", "listQuery queryParamsJson must contain a JSON document", { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new ClientError("invalid_query_request", "listQuery queryParamsJson must contain an object");
  }
  const embedded = parsed.consistency;
  if (embedded !== undefined && embedded !== "safe" && embedded !== "unsafe") {
    throw new ClientError("invalid_consistency", "listQuery consistency must be safe or unsafe", { status: 400 });
  }
  if (options.consistency !== undefined && embedded !== undefined && options.consistency !== embedded) {
    throw new ClientError("consistency_conflict", "Public listQuery consistency conflicts with embedded consistency", { status: 400 });
  }
  if (options.consistency === undefined || embedded !== undefined) return request;
  // Preserve the established paging-field order for serialized callers while
  // making the executor-owned lane explicit.  JSON member order is not part of
  // the semantic contract, but retaining it keeps the V1 wire transcript
  // stable for existing adapters and fixtures.
  const withConsistency: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    withConsistency[key] = value;
    if (key === "PageSize") withConsistency.consistency = options.consistency;
  }
  if (withConsistency.consistency === undefined) withConsistency.consistency = options.consistency;
  return { ...request, queryParamsJson: JSON.stringify(withConsistency) };
}

function rejectQueryEmbeddedConsistency(request: QueryRequest): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.queryParamsJson);
  } catch {
    return;
  }
  if (isRecord(parsed) && parsed.consistency !== undefined) {
    throw new ClientError("unsupported_consistency_mode", "Consistency is supported only for listQuery reads", { status: 400 });
  }
}

async function responseResult(response: Response): Promise<CommitHttpResult> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = { code: "transport", error: `HTTP ${response.status}` };
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  return { status: response.status, headers, body };
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
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
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
  readonly serviceId?: string;
}): SerializedDcbTransport {
  return makeHttpTransport(options);
}

function snapshotKey(projectorId: string, tag: Tag): string {
  return `${projectorId}\u0000${tag.id}`;
}

interface ExecuteReads {
  readonly readState: (projector: ProjectorLike, tag: Tag) => Promise<PortableSnapshot>;
  readonly exists: (tag: Tag) => Promise<PortableSnapshot<undefined>>;
}

function snapshotReaderFrom(
  reads: ExecuteReads,
  supplied: SnapshotReader | readonly PortableSnapshot[] | undefined,
  readMode: "read-through" | "snapshot-only",
  run: AdapterRunner,
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
      // A supplied reader has no signal parameter; the runner bounds it, and
      // its own budget or abort refusal is not turned into a missing snapshot.
      return run(async () => {
        try {
          return await reader.read(projector, tag);
        } catch (error) {
          if (readMode === "snapshot-only") return missing(projector.id, tag);
          throw error;
        }
      });
    }
    if (readMode === "snapshot-only") return missing(projector.id, tag);
    return reads.readState(projector, tag);
  };
  const fallbackExists = async (tag: Tag): Promise<boolean> => {
    const found = byTag.get(tag.id);
    if (found !== undefined) return found.exists;
    if (reader !== undefined && reader.exists !== undefined) {
      const exists = reader.exists;
      return run(() => exists(tag));
    }
    if (readMode === "snapshot-only") return missing(undefined, tag);
    return (await reads.exists(tag)).exists;
  };
  const fallbackHead = async (tag: Tag): Promise<string | null> => {
    const found = byTag.get(tag.id);
    if (found !== undefined) return found.head;
    if (reader !== undefined && reader.head !== undefined) {
      const head = reader.head;
      return run(() => head(tag));
    }
    if (readMode === "snapshot-only") return missing(undefined, tag);
    return (await reads.exists(tag)).head;
  };
  return { read: fallbackRead, exists: fallbackExists, head: fallbackHead };
}

/**
 * Parse a decoded tag-state payload through the projector's state schema when
 * it carries one. `ProjectorLike` does not declare `validateState`, so the
 * check is structural; a projector without it is not constrained.
 */
function parsedReadState(projector: ProjectorLike, decoded: unknown): unknown {
  const validateState = (projector as { readonly validateState?: unknown }).validateState;
  if (typeof validateState !== "function") return decoded;
  try {
    return (validateState as (state: unknown) => unknown).call(projector, decoded);
  } catch {
    throw new ClientError("invalid_read_snapshot", "Tag-state payload did not match the projector state schema");
  }
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

function writtenEventHeads(
  value: unknown,
  candidateEvents: readonly CandidateEnvelope["events"][number][],
): ReadonlyMap<string, string> {
  const heads = new Map<string, string>();
  for (const [index, written] of writtenEvents(value).entries()) {
    const suid = [written.sortableUniqueIdValue, written.suid, written.lastSortableUniqueId]
      .find((candidate): candidate is string => typeof candidate === "string");
    if (suid === undefined) continue;
    const writtenTags = Array.isArray(written.tags)
      ? written.tags.filter((tag): tag is string => typeof tag === "string")
      : [];
    const candidateTags = candidateEvents[index]?.tags.map((tag) => tag.id) ?? [];
    for (const tag of writtenTags.length > 0 ? writtenTags : candidateTags) {
      const previous = heads.get(tag);
      if (previous === undefined || suid > previous) heads.set(tag, suid);
    }
  }
  return heads;
}

function responseHeads(
  value: unknown,
  claims: readonly { readonly tag: Tag; readonly head: string | null }[],
  fallbackHead: string,
  updatedTags: ReadonlySet<string>,
  candidateEvents: readonly CandidateEnvelope["events"][number][],
): readonly { readonly tag: Tag; readonly head: string }[] {
  const responseBody = bodyOf(value);
  const raw = isRecord(responseBody) ? responseBody.heads : undefined;
  const rawHeads = new Map<string, string>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isRecord(item) || typeof item.tag !== "string" || typeof item.head !== "string") continue;
      rawHeads.set(normalizeTag(item.tag).id, item.head);
    }
  }
  const writtenHeads = writtenEventHeads(value, candidateEvents);
  if (claims.length === 0 && rawHeads.size > 0) {
    return [...rawHeads].map(([tag, head]) => ({ tag: normalizeTag(tag), head }));
  }
  return claims.map((claim) => {
    const writtenHead = writtenHeads.get(claim.tag.id);
    const rawHead = rawHeads.get(claim.tag.id);
    return {
      tag: claim.tag,
      head: updatedTags.has(claim.tag.id) ? writtenHead ?? rawHead ?? fallbackHead : claim.head ?? "",
    };
  });
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

function conflictResult(attempts: number, commitError: unknown, response: unknown): ExecutorConflict {
  return {
    kind: "conflict",
    attempts,
    status: commitError instanceof ClientError ? commitError.status : undefined,
    code: "consistency_conflict",
    conflicts: conflictDetails(response),
  };
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

/**
 * What executeCommand needs to know about one commit reply. Only a 2xx reply
 * is accepted and only a consistency conflict is returned for a retry; every
 * other reply is thrown as its public error and classified once, by the
 * shared table, together with every other failure of `execute`.
 */
function commitAttemptResult(value: unknown): CommitAttemptResult {
  if (!isHttpResult(value)) {
    // A reply the facade does not recognise is not proof of a commit.
    throw new ClientError("unknown_outcome", "The command outcome is unknown");
  }
  if (value.status >= 200 && value.status < 300) return { kind: "accepted" };
  const error = commitReplyError(value);
  if (failureKindForCode(error.code) === "conflict") return { kind: "consistency-conflict", error };
  throw error;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && error.error instanceof Error) return error.error.message;
  return isRecord(error) && typeof error.error === "string" ? error.error : String(error);
}

/** Error names of dcb-domain's DomainAuthoringError family, for a copy that fails instanceof. */
const DOMAIN_AUTHORING_ERROR_NAMES = new Set([
  "DomainAuthoringError",
  "DomainRegistrationError",
  "BoundaryParseError",
  "SessionStateError",
  "UndeclaredReadError",
  "IncoherentSnapshotError",
]);

function isDomainAuthoringError(error: unknown): error is { readonly code: string } {
  if (error instanceof DomainAuthoringError) return true;
  return isRecord(error) && typeof error.code === "string" && typeof error.name === "string" && DOMAIN_AUTHORING_ERROR_NAMES.has(error.name);
}

function maxConflictRetriesProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return undefined;
  return `maxConflictRetries must be undefined or a non-negative safe integer; received ${String(value)}`;
}

/** Every failure of `execute` takes its kind from the shared classification table. */
function failureResult(error: unknown, attempts: number): ExecuteCommandResult {
  const failure = classifyFailure(error);
  const common = { attempts, status: failure.status, code: failure.code, error: failure.error };
  switch (failure.kind) {
    case "partial": return { kind: "partial", ...common, partial: failure.partial };
    case "conflict": return { kind: "conflict", ...common, conflicts: [] };
    case "rejected": return { kind: "rejected", ...common };
    default: return { kind: failure.kind, ...common };
  }
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

  const assertScope = (): void => {
    if (scopeMismatch) throw new ClientError("scope.mismatch", "Executor service scope does not match its transport");
  };

  const readStateWith = async (projector: ProjectorLike, tag: Tag, signal: AbortSignal | undefined, run: AdapterRunner): Promise<PortableSnapshot> => {
    const tagValue = normalizeTag(tag);
    const stateId = `${tagValue.id}:${projector.id}`;
    const emptyState = () => typeof projector.initialState === "function" ? projector.initialState() : projector.initialState;
    // A bounded two-observation read closes the authority/tag-state race.  A
    // stale projector response is never relabelled as an absent tag or an
    // apparently coherent snapshot.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const authority = await readAuthority(transport, tagValue.id, signal, run);
      if (!authority.exists) {
        return Object.freeze({
          projectorId: projector.id,
          tag: tagValue,
          head: null,
          state: emptyState(),
          exists: false,
        });
      }
      const raw = await readCall(
        () => transport.readTagState({ tagStateId: stateId }, signal),
        "Tag-state",
        run,
      );
      const response = normalizedResponse(raw, stateId);
      if (compareSortableUniqueId(response.lastSortedUniqueId, authority.lastSortableUniqueId) < 0) {
        if (attempt === 0) continue;
        throw new ClientError(
          "read_unavailable",
          "Tag-state did not reach the captured latest-sortable authority head",
          { status: 503 },
        );
      }
      const decoded = decodeJson(response.payload);
      const empty = isRecord(decoded) && decoded.status === "empty";
      return Object.freeze({
        projectorId: projector.id,
        tag: tagValue,
        head: response.lastSortedUniqueId.length === 0 ? null : response.lastSortedUniqueId,
        state: empty ? emptyState() : parsedReadState(projector, decoded),
        exists: true,
      });
    }
    throw new ClientError("read_unavailable", "Tag-state read could not reach a coherent authority observation", { status: 503 });
  };

  const existsWith = async (tag: Tag, signal: AbortSignal | undefined, run: AdapterRunner): Promise<PortableSnapshot<undefined>> => {
    const tagValue = normalizeTag(tag);
    const value = await readAuthority(transport, tagValue.id, signal, run);
    return Object.freeze({
      projectorId: "exists",
      tag: tagValue,
      head: value.lastSortableUniqueId.length === 0 ? null : value.lastSortableUniqueId,
      state: undefined,
      exists: value.exists,
    });
  };

  const readState = async <P extends ProjectorLike>(projector: P, tag: Tag, readOptions: ReadOptions = {}): Promise<PortableSnapshot> => {
    assertScope();
    rejectUnsupportedConsistency(readOptions);
    return readStateWith(projector, tag, readOptions.signal, uncontrolled);
  };

  const exists = async (tag: Tag, readOptions: ReadOptions = {}): Promise<PortableSnapshot<undefined>> => {
    assertScope();
    rejectUnsupportedConsistency(readOptions);
    return existsWith(tag, readOptions.signal, uncontrolled);
  };

  const query = async (request: QueryRequest, readOptions: ReadOptions = {}): Promise<QueryResponse> => {
    assertScope();
    rejectUnsupportedConsistency(readOptions);
    rejectQueryEmbeddedConsistency(request);
    return normalizedQueryResponse(await readCall(() => transport.query(request, readOptions.signal), "Query"));
  };
  const listQuery = async (request: ListQueryRequest, readOptions: ListQueryOptions = {}): Promise<ListQueryResponse> => {
    assertScope();
    const withConsistency = requestWithListConsistency(request, readOptions);
    return normalizedListQueryResponse(await readCall(
      () => transport.listQuery(withConsistency, readOptions.signal),
      "List-query",
    ));
  };

  const execute = async <C extends CommandDefinition>(command: C, input: CommandInput<C>, executeOptions: ExecuteCommandOptions = {}): Promise<ExecuteCommandResult> => {
    if (scopeMismatch) return { kind: "invalid", attempts: 0, code: "scope.mismatch", error: "Executor service scope does not match its transport" };
    // Options are refused before any read or commit, and before snapshot-only
    // replaces the retry count, so an invalid value is never silently ignored.
    const optionsProblem = totalBudgetMsProblem(executeOptions.totalBudgetMs) ?? maxConflictRetriesProblem(executeOptions.maxConflictRetries);
    if (optionsProblem !== undefined) return failureResult(new ClientError("invalid_execute_options", optionsProblem), 0);
    const readMode = executeOptions.readMode ?? "read-through";
    const signal = executeOptions.signal;
    // One deadline for the whole execute; every adapter and reader call runs under it.
    const deadline = executeOptions.totalBudgetMs === undefined ? undefined : Date.now() + executeOptions.totalBudgetMs;
    const run: AdapterRunner = (operation) => awaitControlled(operation, signal, deadline);
    if (signal?.aborted) return failureResult(new ClientError("aborted", "Execution was aborted"), 0);
    if (deadline !== undefined && deadline - Date.now() <= 0) return failureResult(new ClientError("timeout", "Execution budget expired"), 0);
    const snapshots = snapshotReaderFrom({
      readState: (projector, tag) => readStateWith(projector, tag, signal, run),
      exists: (tag) => existsWith(tag, signal, run),
    }, executeOptions.snapshots, readMode, run);
    const maxConflictRetries = readMode === "snapshot-only" ? 0 : executeOptions.maxConflictRetries ?? 1;
    let commitAttempts = 0;
    let committing = false;
    let lastResponse: unknown;
    try {
      const result = await executeCommand(command, input, {
        timeProvider: { now: clock },
        snapshots,
        maxConflictRetries,
        commit: async (candidate) => {
          commitAttempts += 1;
          committing = true;
          // A dispatched commit that expires or is aborted is an unknown
          // outcome: it rejects out of executeCommand and is never retried.
          let raw: unknown;
          try {
            raw = await run(() => transport.commit(envelopeFor(candidate), signal));
          } catch (error) {
            const publicError = sanitizeTransportError(error, { fallbackCode: "transport" });
            if (failureKindForCode(publicError.code) === "conflict") {
              committing = false;
              return { kind: "consistency-conflict" };
            }
            throw publicError;
          }
          lastResponse = raw;
          const attemptResult = commitAttemptResult(raw);
          committing = false;
          return attemptResult;
        },
        onPropagation: undefined,
      });
      if (result.status === "accepted" && result.decision.kind === "done") {
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
          heads: responseHeads(lastResponse, result.envelope?.readClaims.map((claim) => ({ tag: claim.tag, head: claim.head })) ?? [], head, updatedTags, result.envelope?.events ?? []),
          ...(result.decision.value === undefined ? {} : { value: result.decision.value }),
        };
      }
      if (result.status === "conflict") {
        return conflictResult(result.attempts, result.error, lastResponse);
      }
      if (result.decision.kind === "none") return { kind: "noop", attempts: result.attempts, reason: result.decision.reason };
      if (result.decision.kind === "reject") {
        const decision = result.decision;
        return {
          kind: "rejected",
          attempts: result.attempts,
          error: decision.reason,
          // SDT-G57: a string details is the application code, else the V1 reject code.
          code: typeof decision.details === "string" ? decision.details : decision.code,
          rejectKind: decision.rejectKind,
          ...(decision.details === undefined ? {} : { details: decision.details }),
        };
      }
      const decisionKind = (result.decision as { readonly kind?: unknown }).kind;
      if (result.envelope === undefined && !["done", "none", "reject"].includes(String(decisionKind))) {
        return failureResult(new ClientError("invalid_command_result", "Command did not return a recognised decision"), result.attempts);
      }
      // The commit closure accepts, retries a conflict or throws; any other
      // status cannot be trusted as a commit.
      return failureResult(new ClientError("unknown_outcome", "The command outcome is unknown"), result.attempts);
    } catch (error) {
      // The facade and the authored sample can resolve separate package
      // copies in a Worker bundle, so preserve the domain error code across
      // that package boundary instead of relying on instanceof alone.
      const authoringCode = error instanceof DomainAuthoringError
        ? error.code
        : isRecord(error) && typeof error.code === "string" ? error.code : undefined;
      if (authoringCode === "executor.snapshot_missing") {
        return { kind: "invalid", attempts: 0, code: authoringCode, error: errorText(error) };
      }
      // An invalid retry count is refused before any read or commit.
      if (authoringCode === "EXECUTE_OPTIONS_INVALID") {
        return failureResult(new ClientError("invalid_execute_options", errorText(error)), 0);
      }
      // Command input validation is a typed application rejection, not a
      // transport failure. The executor facade must preserve the public
      // invalid-command contract used by the meeting-room API.
      if (authoringCode === "COMMAND_INPUT_INVALID") {
        return failureResult(new ClientError("invalid_command_input", errorText(error)), 1);
      }
      const attempts = committing ? commitAttempts : commitAttempts + 1;
      // Adapter-backed live read-through that observes conflicting heads for
      // the same tag is a transport-classified incoherence, not a handler bug.
      if (authoringCode === "INCOHERENT_SNAPSHOT" && readMode === "read-through" && executeOptions.snapshots === undefined) {
        return failureResult(new ClientError("incoherent_read_snapshot", errorText(error)), attempts);
      }
      // Any other authoring error from the handler or the domain layer is a
      // definite refusal; nothing was sent for it.
      if (isDomainAuthoringError(error)) {
        return failureResult(new ClientError("domain_authoring_error", error.code), attempts);
      }
      return failureResult(error, attempts);
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
