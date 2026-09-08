import type {
  AppendedEvent,
  CommandDefinition,
  CommandOutcome,
  EventDefinition,
  JsonValue,
  TagDefinition,
  TagInput,
} from "@sekiban/dcb-core";
import { assertJsonValue, defineTag } from "@sekiban/dcb-core";

export interface ReadonlyTagStateResponse {
  readonly payload: JsonValue;
  readonly version: number;
  readonly lastSortedUniqueId: string;
  readonly tagGroup: string;
  readonly tagContent: string;
  readonly tagProjector: string;
  readonly tagPayloadName?: string;
  /** Runtime tag-state responses serialize projectorVersion as a string. */
  readonly projectorVersion?: string;
}

export type TagStateSnapshot = ReadonlyTagStateResponse & {
  readonly tag: string;
  readonly tagStateId: string;
};

export interface CommitCandidate {
  readonly eventId: string;
  readonly eventPayloadName: string;
  readonly payload: JsonValue;
  readonly tags: readonly string[];
}

export interface ConsistencyEntry {
  readonly tag: string;
  /** §3.1 commit-envelope spelling; §5.3 tag-state keeps lastSortedUniqueId. */
  readonly lastSortableUniqueId: string;
}

export interface CommitEnvelope {
  readonly candidates: readonly CommitCandidate[];
  readonly consistency: readonly ConsistencyEntry[];
  readonly [key: string]: unknown;
}

export interface CommitHttpResult {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface TagLatestSortableResponse {
  readonly exists: boolean;
  readonly lastSortableUniqueId: string;
}

export interface QueryRequest {
  readonly queryType: string;
  readonly queryParamsJson: string;
  readonly waitForSortableUniqueId?: string;
}

export interface QueryResponse {
  readonly resultJson: string;
}

export interface ListQueryRequest extends QueryRequest {
  readonly queryParamsJson: string;
}

export interface ListQueryResponse {
  readonly itemsJson: string;
  readonly totalCount: number;
  readonly totalPages: number;
  readonly currentPage: number;
  readonly pageSize: number;
}

export interface SerializedDcbTransport {
  readonly readTagState: (
    request: { readonly tagStateId: string },
    signal?: AbortSignal,
  ) => Promise<ReadonlyTagStateResponse | CommitHttpResult>;
  readonly readTagLatestSortable?: (
    request: { readonly tag: string },
    signal?: AbortSignal,
  ) => Promise<TagLatestSortableResponse | CommitHttpResult>;
  readonly commit: (request: CommitEnvelope, signal?: AbortSignal) => Promise<unknown | CommitHttpResult>;
  /** G57 makes the two read-only query endpoints part of every transport. */
  readonly query: (request: QueryRequest, signal?: AbortSignal) => Promise<QueryResponse | CommitHttpResult>;
  readonly listQuery: (request: ListQueryRequest, signal?: AbortSignal) => Promise<ListQueryResponse | CommitHttpResult>;
  /** Optional identity supplied by a transport that is already scoped. */
  readonly serviceId?: string;
}

export class ClientError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly partial?: unknown;

  constructor(code: string, message: string, options?: { readonly status?: number; readonly partial?: unknown; readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ClientError";
    this.code = code;
    this.status = options?.status;
    this.partial = options?.partial;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const normalizeTag = (tag: TagInput): string => defineTag(tag).id;

const snapshotTag = (response: ReadonlyTagStateResponse): string => {
  if (!nonEmptyString(response.tagGroup) || !nonEmptyString(response.tagContent)) {
    throw new ClientError("invalid_read_snapshot", "Tag-state response omitted tag identity");
  }
  return `${response.tagGroup}:${response.tagContent}`;
};

const snapshotStateId = (response: ReadonlyTagStateResponse): string => {
  const tag = snapshotTag(response);
  if (!nonEmptyString(response.tagProjector)) throw new ClientError("invalid_read_snapshot", "Tag-state response omitted projector identity");
  return `${tag}:${response.tagProjector}`;
};

function normalizeSnapshot(value: unknown, requestedTagStateId?: string): TagStateSnapshot {
  const body = unwrapHttpBody(value);
  if (!isRecord(body)) throw new ClientError("invalid_read_snapshot", "Tag-state response was not an object");
  const payload = assertJsonValue(body.payload, "value");
  if (typeof body.version !== "number" || !Number.isSafeInteger(body.version) || body.version < 0) {
    throw new ClientError("invalid_read_snapshot", "Tag-state response had an invalid version");
  }
  if (typeof body.lastSortedUniqueId !== "string") {
    throw new ClientError("invalid_read_snapshot", "Tag-state response omitted lastSortedUniqueId");
  }
  const response = body as unknown as ReadonlyTagStateResponse;
  const tag = snapshotTag(response);
  const tagStateId = snapshotStateId(response);
  if (requestedTagStateId !== undefined && requestedTagStateId !== tagStateId) {
    throw new ClientError("incoherent_read_snapshot", "Tag-state identity changed during one read", { status: 500 });
  }
  return Object.freeze({ ...response, payload, tag, tagStateId });
}

function unwrapHttpBody(value: unknown): unknown {
  if (isRecord(value) && typeof value.status === "number" && "body" in value) {
    if (value.status < 200 || value.status >= 300) {
      const body = value.body;
      const code = isRecord(body) && typeof body.code === "string" ? body.code : "http_error";
      const message = isRecord(body) && typeof body.error === "string" ? body.error : `HTTP ${value.status}`;
      throw new ClientError(code, message, {
        status: value.status,
        partial: isRecord(body) ? body.partial : undefined,
      });
    }
    return value.body;
  }
  return value;
}

export class SerializedDcbClient implements SerializedDcbTransport {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, fetchImpl: typeof fetch = globalThis.fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
  }

  async readTagState(
    request: { readonly tagStateId: string },
    signal?: AbortSignal,
  ): Promise<ReadonlyTagStateResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/sekiban/serialized/tag-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    return this.readResponse(response, request.tagStateId) as Promise<ReadonlyTagStateResponse>;
  }

  async readTagLatestSortable(
    request: { readonly tag: string },
    signal?: AbortSignal,
  ): Promise<TagLatestSortableResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/sekiban/serialized/tag-latest-sortable`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    return this.readResponse(response) as Promise<TagLatestSortableResponse>;
  }

  async query(request: QueryRequest, signal?: AbortSignal): Promise<QueryResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/sekiban/serialized/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    return this.readResponse(response) as Promise<QueryResponse>;
  }

  async listQuery(request: ListQueryRequest, signal?: AbortSignal): Promise<ListQueryResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/sekiban/serialized/list-query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    return this.readResponse(response) as Promise<ListQueryResponse>;
  }

  readonly tagLatestSortable = this.readTagLatestSortable.bind(this);
  readonly tagState = this.readTagState.bind(this);

  async commit(request: CommitEnvelope, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/sekiban/serialized/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    return this.readResponse(response);
  }

  private async readResponse(response: Response, requestedTagStateId?: string): Promise<unknown> {
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new ClientError("transport", "Serialized DCB response was not JSON", { status: response.status, cause: error });
    }
    if (!response.ok) {
      const code = isRecord(body) && typeof body.code === "string" ? body.code : "http_error";
      const message = isRecord(body) && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
      throw new ClientError(code, message, {
        status: response.status,
        partial: isRecord(body) ? body.partial : undefined,
      });
    }
    return requestedTagStateId === undefined ? body : normalizeSnapshot(body, requestedTagStateId);
  }
}

export class ClaimLedger {
  private readonly snapshotsByStateId = new Map<string, TagStateSnapshot>();
  private readonly snapshotsByTag = new Map<string, TagStateSnapshot>();
  private readonly transport: SerializedDcbTransport;

  constructor(transport: SerializedDcbTransport) {
    this.transport = transport;
  }

  async readTagState(tagStateId: string, signal?: AbortSignal): Promise<TagStateSnapshot>;
  async readTagState(tag: TagInput, projector: string, signal?: AbortSignal): Promise<TagStateSnapshot>;
  async readTagState(tagOrId: string | TagInput, projectorOrSignal?: string | AbortSignal, maybeSignal?: AbortSignal): Promise<TagStateSnapshot> {
    const projector = typeof projectorOrSignal === "string" ? projectorOrSignal : undefined;
    const signal = typeof projectorOrSignal === "string" ? maybeSignal : projectorOrSignal;
    const requestedTagStateId = projector === undefined ? String(tagOrId) : `${normalizeTag(tagOrId)}:${projector}`;
    const cached = this.snapshotsByStateId.get(requestedTagStateId);
    if (cached !== undefined) return cached;
    let response: unknown;
    try {
      response = await this.transport.readTagState({ tagStateId: requestedTagStateId }, signal);
    } catch (error) {
      if (error instanceof ClientError) throw error;
      throw new ClientError("transport", "Tag-state request failed", { cause: error });
    }
    const snapshot = normalizeSnapshot(response, requestedTagStateId);
    const existingForTag = this.snapshotsByTag.get(snapshot.tag);
    if (existingForTag !== undefined && existingForTag.lastSortedUniqueId !== snapshot.lastSortedUniqueId) {
      throw new ClientError(
        "incoherent_read_snapshot",
        `Tag ${snapshot.tag} was read with two different lastSortedUniqueId values`,
        { status: 409 },
      );
    }
    this.snapshotsByStateId.set(requestedTagStateId, snapshot);
    this.snapshotsByTag.set(snapshot.tag, existingForTag ?? snapshot);
    return snapshot;
  }

  read(tagStateId: string, signal?: AbortSignal): Promise<TagStateSnapshot> {
    return this.readTagState(tagStateId, signal);
  }

  get snapshots(): readonly TagStateSnapshot[] {
    return Object.freeze([...this.snapshotsByStateId.values()]);
  }

  clear(): void {
    this.snapshotsByStateId.clear();
    this.snapshotsByTag.clear();
  }
}

export interface PreflightInput {
  readonly candidates: readonly Pick<CommitCandidate, "tags">[];
  readonly consistency: readonly ConsistencyEntry[];
  readonly claims: readonly Pick<TagStateSnapshot, "tag" | "lastSortedUniqueId">[];
}

/** Validate the commit envelope before any transport call. */
export function preflightCommit(input: PreflightInput): void {
  const candidateTags = new Set(input.candidates.flatMap((candidate) => candidate.tags.map(normalizeTag)));
  const seenConsistency = new Set<string>();
  for (const entry of input.consistency) {
    const tag = normalizeTag(entry.tag);
    if (seenConsistency.has(tag)) {
      throw new ClientError("duplicate_consistency_entry", `More than one consistency entry was supplied for ${tag}`);
    }
    seenConsistency.add(tag);
    if (!candidateTags.has(tag)) {
      throw new ClientError("claim_not_in_candidate_tags", `Consistency claim ${tag} is not covered by candidate tags`);
    }
  }
  for (const claim of input.claims) {
    if (!candidateTags.has(normalizeTag(claim.tag))) {
      throw new ClientError("claim_not_in_candidate_tags", `Claim ${claim.tag} is not covered by candidate tags`);
    }
  }
}

export interface ClientCommandContext {
  readonly readTagState: (tagStateId: string, signal?: AbortSignal) => Promise<TagStateSnapshot>;
  readonly state: (tagStateId: string, signal?: AbortSignal) => Promise<JsonValue | undefined>;
  readonly assertEmpty: (tagStateId: string, signal?: AbortSignal) => Promise<void>;
  readonly append: (event: EventDefinition | string, payload: unknown, tags: readonly TagInput[]) => CommitCandidate;
  readonly claims: readonly TagStateSnapshot[];
  readonly candidates: readonly CommitCandidate[];
}

export type ClientCommandDecision =
  | { readonly kind: "committed" | "done"; readonly value?: JsonValue; readonly envelope?: Partial<CommitEnvelope> }
  | { readonly kind: "noop"; readonly reason?: string }
  | { readonly kind: "rejected"; readonly error: string; readonly code?: string }
  | { readonly kind: "invalid"; readonly error: string; readonly code?: string };

export interface ExecuteOptions {
  readonly input?: unknown;
  readonly maxConflictRetries?: number;
  readonly signal?: AbortSignal;
  readonly totalBudgetMs?: number;
}

export interface ExecuteCommon {
  readonly attempts: number;
  readonly status?: number;
  readonly code?: string;
  readonly error?: string;
  readonly cause?: unknown;
}
export interface ExecuteCommitted extends ExecuteCommon { readonly kind: "committed"; readonly response: unknown; }
export interface ExecuteNoop extends ExecuteCommon { readonly kind: "noop"; readonly reason?: string; }
export interface ExecuteRejected extends ExecuteCommon { readonly kind: "rejected"; readonly error: string; }
export interface ExecuteConflict extends ExecuteCommon { readonly kind: "conflict"; readonly response?: unknown; }
export interface ExecutePartial extends ExecuteCommon { readonly kind: "partial"; readonly partial: unknown; }
export interface ExecuteTimeout extends ExecuteCommon { readonly kind: "timeout"; }
export interface ExecuteUnavailable extends ExecuteCommon { readonly kind: "unavailable"; }
export interface ExecuteTransport extends ExecuteCommon { readonly kind: "transport"; }
export interface ExecuteInvalid extends ExecuteCommon { readonly kind: "invalid"; }
export type ExecuteResult = ExecuteCommitted | ExecuteNoop | ExecuteRejected | ExecuteConflict | ExecutePartial | ExecuteTimeout | ExecuteUnavailable | ExecuteTransport | ExecuteInvalid;

export interface ClaimLedgerExecutorOptions {
  readonly transport: SerializedDcbTransport;
  readonly maxConflictRetries?: number;
  readonly totalBudgetMs?: number;
}

type CommandLike =
  | ((context: ClientCommandContext, input?: unknown) => ClientCommandDecision | Promise<ClientCommandDecision>)
  | CommandDefinition;

const eventPayloadName = (event: EventDefinition | string): string => typeof event === "string" ? event : event.eventPayloadName;

const newEventId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `client-event-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

async function awaitControlled<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  deadline: number | undefined,
): Promise<T> {
  if (signal?.aborted) throw new ClientError("aborted", "Execution was aborted");
  const remaining = deadline === undefined ? undefined : deadline - Date.now();
  if (remaining !== undefined && remaining <= 0) throw new ClientError("timeout", "Execution budget expired");
  if (signal === undefined && remaining === undefined) return operation;
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new ClientError("aborted", "Execution was aborted"));
    };
    if (remaining !== undefined) {
      timer = setTimeout(() => {
        cleanup();
        reject(new ClientError("timeout", "Execution budget expired"));
      }, remaining);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    operation.then((value) => {
      cleanup();
      resolve(value);
    }, (error: unknown) => {
      cleanup();
      reject(error);
    });
  });
}

const classifyError = (error: unknown, attempts: number): ExecuteResult => {
  if (error instanceof ClientError) {
    if (error.code === "timeout" || error.code === "aborted") return { kind: "timeout", attempts, status: error.status, code: error.code, error: error.message, cause: error };
    if (error.code === "projection_unavailable") return { kind: "unavailable", attempts, status: error.status, code: error.code, error: error.message, cause: error };
    if (error.code === "partial_write" || error.partial !== undefined) return { kind: "partial", attempts, status: error.status, code: error.code, error: error.message, partial: error.partial, cause: error };
    if (error.code === "consistency_conflict") return { kind: "conflict", attempts, status: error.status, code: error.code, error: error.message, cause: error };
    return { kind: "invalid", attempts, status: error.status, code: error.code, error: error.message, cause: error };
  }
  return { kind: "transport", attempts, error: error instanceof Error ? error.message : "Transport request failed", cause: error };
};

function classifyCommitResponse(value: unknown, attempts: number): ExecuteResult {
  if (value instanceof Response) {
    return { kind: "transport", attempts, error: "A raw Response must be normalized by SerializedDcbClient" };
  }
  if (isRecord(value) && typeof value.status === "number" && "body" in value) {
    const status = value.status;
    const body = value.body;
    const code = isRecord(body) && typeof body.code === "string" ? body.code : undefined;
    const error = isRecord(body) && typeof body.error === "string" ? body.error : undefined;
    const partial = isRecord(body) ? body.partial : undefined;
    if (status >= 200 && status < 300) return { kind: "committed", attempts, status, response: body };
    if (code === "consistency_conflict" || status === 409) return { kind: "conflict", attempts, status, code, error, response: body };
    if (code === "partial_write" || partial !== undefined) return { kind: "partial", attempts, status, code, error, partial };
    if (code === "timeout" || status === 504) return { kind: "timeout", attempts, status, code, error };
    if (code === "projection_unavailable" || status === 503) return { kind: "unavailable", attempts, status, code, error };
    if (status >= 400 && status < 500) return { kind: "rejected", attempts, status, code, error: error ?? `HTTP ${status}` };
    return { kind: "transport", attempts, status, code, error: error ?? `HTTP ${status}` };
  }
  if (isRecord(value) && typeof value.code === "string") {
    if (value.code === "consistency_conflict") return { kind: "conflict", attempts, code: value.code, response: value };
    if (value.code === "partial_write") return { kind: "partial", attempts, code: value.code, partial: value.partial };
  }
  return { kind: "committed", attempts, status: 200, response: value };
}

export class ClaimLedgerExecutor {
  private readonly transport: SerializedDcbTransport;
  private readonly defaultRetries: number;
  private readonly defaultBudget?: number;

  constructor(options: ClaimLedgerExecutorOptions) {
    this.transport = options.transport;
    this.defaultRetries = Math.min(1, Math.max(0, options.maxConflictRetries ?? 0));
    this.defaultBudget = options.totalBudgetMs;
  }

  async execute(command: CommandLike, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    const maxRetries = Math.min(1, Math.max(0, options.maxConflictRetries ?? this.defaultRetries));
    const deadline = options.totalBudgetMs === undefined && this.defaultBudget === undefined
      ? undefined
      : Date.now() + (options.totalBudgetMs ?? this.defaultBudget ?? 0);
    let attempts = 0;
    for (;;) {
      attempts += 1;
      if (options.signal?.aborted) return { kind: "timeout", attempts, code: "aborted", error: "Execution was aborted" };
      if (deadline !== undefined && Date.now() >= deadline) return { kind: "timeout", attempts, code: "timeout", error: "Execution budget expired" };
      const ledger = new ClaimLedger(this.transport);
      let decision: ClientCommandDecision;
      let context: ClientCommandContext;
      try {
        const attemptCandidates: CommitCandidate[] = [];
        context = {
          readTagState: (tagStateId, signal) => ledger.readTagState(tagStateId, signal),
          state: async (tagStateId, signal) => (await ledger.readTagState(tagStateId, signal)).payload,
          assertEmpty: async (tagStateId, signal) => {
            const snapshot = await ledger.readTagState(tagStateId, signal);
            const emptyPayload = snapshot.payload === null || snapshot.payload === undefined ||
              (isRecord(snapshot.payload) && Object.keys(snapshot.payload).length === 0) ||
              (isRecord(snapshot.payload) && snapshot.payload.status === "empty") ||
              (Array.isArray(snapshot.payload) && snapshot.payload.length === 0);
            if (!emptyPayload) {
              throw new ClientError("assert_empty_failed", `Tag-state ${tagStateId} is not empty`);
            }
          },
          append: (event, payload, tags) => {
            const jsonPayload = assertJsonValue(payload, "event-construction");
            const candidate = Object.freeze({
              eventId: newEventId(),
              eventPayloadName: eventPayloadName(event),
              payload: jsonPayload,
              tags: Object.freeze(tags.map(normalizeTag)),
            });
            attemptCandidates.push(candidate);
            return candidate;
          },
          get claims() { return ledger.snapshots; },
          get candidates() { return Object.freeze([...attemptCandidates]); },
        };
        if (typeof command === "function") {
          decision = await awaitControlled(Promise.resolve(command(context, options.input)), options.signal, deadline);
        } else {
          const outcome = await awaitControlled(Promise.resolve(command.execute(options.input)), options.signal, deadline);
          decision = outcome.kind === "committed"
            ? { kind: "committed", value: outcome.value }
            : outcome.kind === "noop"
              ? { kind: "noop", reason: outcome.reason }
              : { kind: "rejected", error: outcome.reason, code: outcome.code };
        }
        if (!decision || typeof decision !== "object") throw new ClientError("invalid_command_result", "Command did not return a decision");
        if (decision.kind === "noop") return { kind: "noop", attempts, reason: decision.reason };
        if (decision.kind === "rejected") return { kind: "rejected", attempts, error: decision.error, code: decision.code };
        if (decision.kind === "invalid") return { kind: "invalid", attempts, error: decision.error, code: decision.code };
        const candidates = context.candidates;
        if (candidates.length === 0) return { kind: "noop", attempts, reason: "command appended no events" };
        // Claims retain the §5.3 tag-state spelling internally, but the commit
        // envelope is a §3.1 wire value and must use lastSortableUniqueId.
        // An empty tag head is the explicit V1 assert-empty sentinel and must
        // survive this adapter byte-for-byte.
        const consistency = decision.envelope?.consistency ?? context.claims
          .map((claim) => ({
            tag: claim.tag,
            lastSortableUniqueId: claim.lastSortedUniqueId,
          }));
        const envelope: CommitEnvelope = Object.freeze({
          ...(decision.envelope ?? {}),
          candidates,
          consistency: Object.freeze(consistency.map((entry) => ({
            tag: normalizeTag(entry.tag),
            lastSortableUniqueId: entry.lastSortableUniqueId,
          }))),
        });
        preflightCommit({ candidates, consistency: envelope.consistency, claims: context.claims });
        const signal = options.signal;
        const result = await awaitControlled(this.transport.commit(envelope, signal), signal, deadline);
        const classified = classifyCommitResponse(result, attempts);
        if (classified.kind === "conflict" && attempts <= maxRetries) continue;
        return classified;
      } catch (error) {
        const classified = classifyError(error, attempts);
        if (classified.kind === "conflict" && attempts <= maxRetries) continue;
        return classified;
      }
    }
  }
}

export const createClaimLedgerExecutor = (options: ClaimLedgerExecutorOptions): ClaimLedgerExecutor =>
  new ClaimLedgerExecutor(options);

export const createSerializedDcbClient = (baseUrl: string, fetchImpl?: typeof fetch): SerializedDcbClient =>
  new SerializedDcbClient(baseUrl, fetchImpl);

export type { AppendedEvent, CommandDefinition, CommandOutcome, EventDefinition, JsonValue, TagDefinition, TagInput };

export * from "./executor.js";
