import type {
  DomainDefinition,
  JsonValue,
  ProjectorDefinition,
} from "@sekiban/dcb-core";
import { handleSerializedCommit, type CommitWorkerEnv, type CommitWorkerHooks } from "./commit/CommitWorker";
import type { DeliveryClass } from "./downstream/Doorbell";
import { resolveDeliveryIdentity } from "./eventIdentity";
import {
  DEPLOYED_PROJECTOR_REGISTRY,
  ProjectorRegistry,
  type ProjectionEvent,
  type TagStateProjector,
} from "./projection/ProjectorRegistry";
import {
  DEPLOYED_QUERY_REGISTRY,
  QueryRegistry,
  type QueryDefinition,
  type QueryEndpoint,
} from "./query/QueryRegistry";

/** A query value accepted by the public runtime composition surface. */
export interface RuntimeQueryDefinition {
  readonly queryType?: string;
  readonly id?: string;
  readonly name?: string;
  readonly endpoint?: QueryEndpoint;
  readonly tagGroup: string;
  readonly tagProjector: string;
  readonly materializedViewId?: string;
  readonly enabled?: boolean;
}

/** Values which affect registration, never the serialized V1 wire format. */
export interface RuntimeWorkerConfig {
  /** Domain layer of the two-layer direct-delivery opt-in. */
  readonly deliveryClass?: DeliveryClass;
  readonly queries?: readonly RuntimeQueryDefinition[];
  readonly queryDefinitions?: readonly RuntimeQueryDefinition[];
  readonly projectorPayloadNames?: Readonly<Record<string, string>>;
  readonly tagPayloadNames?: Readonly<Record<string, string>>;
}

/** A command already normalized by the authoring-to-runtime bridge. */
export interface RuntimeCommandLike {
  readonly id: string;
  readonly name: string;
  readonly parseInput: (value: unknown) => unknown;
  readonly execute: (value: unknown, options?: unknown) => unknown | Promise<unknown>;
  readonly handle: (value: unknown, options?: unknown) => unknown | Promise<unknown>;
}

/** Runtime command registry exposed by composition, without importing dcb-domain. */
export class RuntimeCommandRegistry {
  private readonly byId: ReadonlyMap<string, RuntimeCommandLike>;

  constructor(values: readonly unknown[] = []) {
    const entries = new Map<string, RuntimeCommandLike>();
    for (const value of values) {
      if (!isRuntimeCommandLike(value)) throw new Error("Runtime command definitions require id, parseInput, execute, and handle");
      if (entries.has(value.id)) throw new Error(`Duplicate runtime command ${value.id}`);
      entries.set(value.id, value);
    }
    this.byId = entries;
  }

  resolve(id: string): RuntimeCommandLike | undefined {
    return this.byId.get(id);
  }

  list(): readonly RuntimeCommandLike[] {
    return Object.freeze([...this.byId.values()]);
  }

  execute(id: string, value: unknown, options?: unknown): unknown | Promise<unknown> {
    const command = this.resolve(id);
    if (command === undefined) throw new Error(`Runtime command ${id} is not registered`);
    return command.execute(value, options);
  }
}

export interface RuntimeComposition {
  readonly projectors: ProjectorRegistry;
  readonly queries: QueryRegistry;
  readonly commands: RuntimeCommandRegistry;
}

/** Structural bridge returned by @sekiban/dcb-domain without a reverse package import. */
export interface RuntimeDomainLike {
  readonly events?: readonly {
    readonly eventPayloadName: string;
    readonly parse?: (payload: unknown) => unknown;
  }[];
  readonly commands?: readonly unknown[];
  readonly projectors?: readonly unknown[];
  readonly queries?: readonly RuntimeQueryDefinition[];
}

/** Registered domain parsers are the exact-case admission authority. */
export function registeredEventParsers(domain: DomainDefinition | RuntimeDomainLike | undefined): Readonly<Record<string, (payload: unknown) => unknown>> {
  const entries: Array<readonly [string, (payload: unknown) => unknown]> = [];
  for (const event of domain?.events ?? []) {
    if (typeof event.parse === "function") entries.push([event.eventPayloadName, event.parse]);
  }
  return Object.freeze(Object.fromEntries(entries) as Record<string, (payload: unknown) => unknown>);
}

function decodeStoredJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function jsonBytes(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

interface RuntimeBridgedProjectorLike {
  readonly projectorId: string;
  readonly subscribedEventTypes: readonly string[];
  readonly apply: (
    state: JsonValue,
    event: {
      readonly eventType: string;
      readonly payload: unknown;
      readonly eventPayloadName?: string;
      readonly eventTags?: readonly string[];
      readonly provenance?: "g32";
    },
  ) => JsonValue;
}

function isRuntimeBridgedProjector(definition: ProjectorDefinition): definition is ProjectorDefinition & RuntimeBridgedProjectorLike {
  return "projectorId" in definition && "reduce" in definition;
}

function projectorFromDefinition(
  definition: ProjectorDefinition,
  config: RuntimeWorkerConfig,
): TagStateProjector {
  const payloadNames = config.projectorPayloadNames ?? config.tagPayloadNames ?? {};
  const payloadName = payloadNames[definition.id] ?? `${definition.id}State`;
  const apply = (state: JsonValue, event: ProjectionEvent): JsonValue => {
    const payload = decodeStoredJson(event.payload);
    const identity = resolveDeliveryIdentity({ eventType: event.eventType, provenance: event.provenance }, "queue");
    const eventName = identity.eventPayloadName;
    const normalizedEventType = identity.key;
    // Polling visits every registered projector for each discovered tag. A
    // projector must therefore turn an event from another family into a
    // state-preserving no-op before the authored bridge sees it.
    if (!definition.subscribedEventTypes.includes(normalizedEventType)) return state;
    if (isRuntimeBridgedProjector(definition)) {
      return definition.apply(state, {
        eventType: normalizedEventType,
        eventPayloadName: eventName,
        payload,
        eventTags: event.eventTags,
        provenance: event.provenance,
      });
    }
    return definition.apply(state, {
      eventName,
      eventPayloadName: eventName,
      // The legacy lane is only entered after provenance admission has
      // proven a pre-G27 row. The authored projector still requires the
      // canonical eventType field, so normalize that historical name to the
      // immutable v1 registry identity before calling the real reducer.
      eventType: normalizedEventType,
      payload: payload as JsonValue,
    });
  };
  return {
    id: definition.id,
    tagPayloadName: payloadName,
    projectorVersion: String(definition.version),
    initialState: () => definition.initialState,
    apply,
    serializeState: (state) => definition.serializeState(state as JsonValue),
    deserializeState: (serialized) => definition.deserializeState(serialized),
    payload: (state) => jsonBytes(state),
    version: (state) => {
      if (typeof state === "object" && state !== null && !Array.isArray(state)) {
        const candidate = (state as Record<string, unknown>).version;
        if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0) return candidate;
      }
      return 0;
    },
  };
}

function queryFromDefinition(value: RuntimeQueryDefinition): QueryDefinition {
  const queryType = value.queryType ?? value.id ?? value.name;
  if (queryType === undefined || queryType.length === 0) {
    throw new Error("Runtime query definitions require queryType or id");
  }
  return {
    queryType,
    endpoint: value.endpoint ?? "query",
    tagGroup: value.tagGroup,
    tagProjector: value.tagProjector,
    materializedViewId: value.materializedViewId ?? value.tagProjector,
    enabled: value.enabled ?? true,
  };
}

function isRuntimeCommandLike(value: unknown): value is RuntimeCommandLike {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RuntimeCommandLike>;
  return typeof candidate.id === "string" && candidate.id.length > 0 &&
    typeof candidate.name === "string" && typeof candidate.parseInput === "function" &&
    typeof candidate.execute === "function" && typeof candidate.handle === "function";
}

export interface RuntimeCommitCandidateLike {
  readonly kind: "candidate-envelope";
  readonly now: string | number | bigint;
  readonly events: readonly {
    readonly eventType: string;
    readonly eventName: string;
    readonly payload: unknown;
    readonly tags: readonly { readonly id: string }[];
    readonly ordinal: string;
  }[];
  readonly tags: readonly { readonly id: string }[];
  readonly readClaims: readonly {
    readonly kind: "state" | "exists";
    readonly projectorId?: string;
    readonly tag: { readonly id: string };
    readonly head: string | null;
  }[];
}

export interface RuntimeCommitAllocationLike {
  readonly candidates: readonly { readonly ordinal: string; readonly suid: string }[];
  readonly allocatorLineageId?: string;
  readonly attemptId?: string;
}

export type RuntimeCommitPortResult =
  | { readonly kind: "accepted"; readonly attemptId?: string }
  | { readonly kind: "consistency-conflict" }
  | { readonly kind: "unknown"; readonly error?: unknown; readonly attemptId?: string }
  | { readonly kind: "rejected"; readonly reason?: string; readonly code?: string };

export interface RuntimeCommitPort {
  readonly commit: (
    candidate: RuntimeCommitCandidateLike,
    allocation?: RuntimeCommitAllocationLike,
  ) => Promise<RuntimeCommitPortResult>;
}

export interface RuntimeCommitPortOptions {
  readonly requestUrl?: string;
  readonly hooks?: Omit<CommitWorkerHooks, "registeredEventParsers">;
  readonly registeredEventParsers?: Readonly<Record<string, (payload: unknown) => unknown>>;
}

function encodeJsonPayload(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function candidateToV1Envelope(candidate: RuntimeCommitCandidateLike): {
  version: 1;
  eventCandidates: readonly { payload: string; eventPayloadName: string; tags: readonly string[] }[];
  consistencyTags: readonly { tag: string; lastSortableUniqueId: string }[];
} {
  const eventTags = new Set(candidate.events.flatMap((event) => event.tags.map((tag) => tag.id)));
  const claims = new Map<string, string>();
  for (const claim of candidate.readClaims) {
    // An observed empty head is the explicit V1 assert-empty sentinel. An
    // unread/unknown claim remains null and is omitted from the wire.
    if (eventTags.has(claim.tag.id) && claim.head !== null && !claims.has(claim.tag.id)) {
      claims.set(claim.tag.id, claim.head);
    }
  }
  return {
    version: 1,
    eventCandidates: candidate.events.map((event) => ({
      payload: encodeJsonPayload(event.payload),
      eventPayloadName: event.eventName,
      tags: event.tags.map((tag) => tag.id),
    })),
    consistencyTags: [...claims].map(([tag, lastSortableUniqueId]) => ({ tag, lastSortableUniqueId })),
  };
}

async function responseBody(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = await response.clone().json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function attemptIdFromResponse(body: Record<string, unknown> | undefined): string | undefined {
  const writtenEvents = body?.writtenEvents;
  if (!Array.isArray(writtenEvents)) return undefined;
  const metadata = writtenEvents[0];
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return undefined;
  const eventMetadata = (metadata as Record<string, unknown>).eventMetadata;
  if (typeof eventMetadata !== "object" || eventMetadata === null || Array.isArray(eventMetadata)) return undefined;
  const causationId = (eventMetadata as Record<string, unknown>).causationId;
  return typeof causationId === "string" && causationId.length > 0 ? causationId : undefined;
}

/**
 * Adapt the composed command port to the existing serialized commit Worker.
 * The Worker owns admission, tag reservation/acquire, allocation, append, and
 * response mapping; this adapter is intentionally only a transport seam.
 */
export function createRuntimeCommitPort(
  env: CommitWorkerEnv,
  options: RuntimeCommitPortOptions = {},
): RuntimeCommitPort {
  return Object.freeze({
    commit: async (candidate: RuntimeCommitCandidateLike): Promise<RuntimeCommitPortResult> => {
      const request = new Request(
        options.requestUrl ?? "https://runtime.internal/api/sekiban/serialized/commit",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(candidateToV1Envelope(candidate)),
        },
      );
      const response = await handleSerializedCommit(request, env, {
        ...(options.hooks ?? {}),
        registeredEventParsers: options.registeredEventParsers,
      });
      const body = await responseBody(response);
      if (response.ok) return { kind: "accepted", attemptId: attemptIdFromResponse(body) };
      const code = typeof body?.code === "string" ? body.code : undefined;
      if (code === "consistency_conflict" || response.status === 409) {
        return { kind: "consistency-conflict" };
      }
      if (response.status === 504 || response.status >= 500) {
        return {
          kind: "unknown",
          ...(attemptIdFromResponse(body) === undefined ? {} : { attemptId: attemptIdFromResponse(body) }),
          error: body,
        };
      }
      return {
        kind: "rejected",
        ...(code === undefined ? {} : { code }),
        ...(typeof body?.error === "string" ? { reason: body.error } : {}),
      };
    },
  });
}

/**
 * Build the two private registries used by the HTTP runtime. The registries
 * intentionally never cross the package entrypoint; consumers provide only
 * immutable dcb-core definition values and registration metadata.
 */
export function composeRuntime(
  domain: DomainDefinition | RuntimeDomainLike | undefined,
  config: RuntimeWorkerConfig = {},
): RuntimeComposition {
  if (domain === undefined && config.queries === undefined && config.queryDefinitions === undefined) {
    return { projectors: DEPLOYED_PROJECTOR_REGISTRY, queries: DEPLOYED_QUERY_REGISTRY, commands: new RuntimeCommandRegistry() };
  }
  const projectors = new ProjectorRegistry(
    (domain?.projectors ?? []).map((value) => projectorFromDefinition(value as ProjectorDefinition, config)),
  );
  const configuredQueries = config.queryDefinitions ?? config.queries;
  const domainQueries = (domain?.queries ?? []) as readonly RuntimeQueryDefinition[];
  const queries = new QueryRegistry(
    (configuredQueries ?? domainQueries).map(queryFromDefinition),
  );
  return { projectors, queries, commands: new RuntimeCommandRegistry(domain?.commands ?? []) };
}
