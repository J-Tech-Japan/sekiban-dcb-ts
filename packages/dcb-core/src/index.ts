/**
 * Cloudflare-independent building blocks for Serialized DCB V1.
 *
 * This package intentionally contains no fetch, storage, queue, or Workers
 * types.  The runtime and client packages depend on these definitions rather
 * than the other way around.
 */

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export type JsonBoundary = "event-construction" | "state-persistence" | "command-input" | "value";

export class JsonValidationError extends Error {
  readonly code = "invalid_json_value" as const;
  readonly boundary: JsonBoundary;
  readonly path: string;

  constructor(message: string, boundary: JsonBoundary = "value", path = "$", options?: ErrorOptions) {
    super(message, options);
    this.name = "JsonValidationError";
    this.boundary = boundary;
    this.path = path;
  }
}

const isPlainRecord = (value: object): value is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** Validate and return a JSON value, rejecting non-finite values and cycles. */
export function assertJsonValue(value: unknown, boundary: JsonBoundary = "value"): JsonValue {
  const active = new WeakSet<object>();

  const visit = (candidate: unknown, path: string): JsonValue => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
      return candidate;
    }
    if (typeof candidate === "number") {
      if (Number.isFinite(candidate)) return candidate;
      throw new JsonValidationError("JSON numbers must be finite", boundary, path);
    }
    if (typeof candidate !== "object") {
      throw new JsonValidationError(`Value at ${path} is not JSON serializable`, boundary, path);
    }
    if (active.has(candidate)) {
      throw new JsonValidationError(`Cyclic JSON value at ${path}`, boundary, path);
    }
    active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        return candidate.map((item, index) => visit(item, `${path}[${index}]`));
      }
      if (!isPlainRecord(candidate)) {
        throw new JsonValidationError(`Value at ${path} must be a plain JSON object`, boundary, path);
      }
      const result: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(candidate)) {
        result[key] = visit(item, `${path}.${key}`);
      }
      return result;
    } finally {
      active.delete(candidate);
    }
  };

  return visit(value, "$");
}

export const validateJsonValue = assertJsonValue;

export class DcbDefinitionError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DcbDefinitionError";
    this.code = code;
  }
}

/** The event identity carried by the post-G27 internal delivery lanes. */
export interface CanonicalEventIdentity {
  readonly eventPayloadName: string;
  readonly version: number;
  readonly key: string;
}

export class CanonicalEventIdentityError extends DcbDefinitionError {
  readonly code = "CANONICAL_EVENT_IDENTITY_INVALID" as const;

  constructor(message: string) {
    super("CANONICAL_EVENT_IDENTITY_INVALID", message);
    this.name = "CanonicalEventIdentityError";
  }
}

function canonicalEventVersion(version: unknown): number {
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    throw new CanonicalEventIdentityError("Event identity version must be a positive safe integer");
  }
  return version;
}

/** Build the only accepted event identity spelling: name:decimal-version. */
export function canonicalEventKey(eventPayloadName: string, version = 1): string {
  if (typeof eventPayloadName !== "string" || eventPayloadName.length === 0 || eventPayloadName.includes(":")) {
    throw new CanonicalEventIdentityError("Event payload names must be non-empty and must not contain ':'");
  }
  const canonicalVersion = canonicalEventVersion(version);
  return `${eventPayloadName}:${canonicalVersion}`;
}

/** Parse and re-canonicalize an internal event identity without sniffing payload bytes. */
export function parseCanonicalEventKey(key: string): CanonicalEventIdentity {
  if (typeof key !== "string" || key.length === 0) {
    throw new CanonicalEventIdentityError("Event identity key must be a non-empty string");
  }
  const separator = key.lastIndexOf(":");
  if (separator <= 0 || separator === key.length - 1) {
    throw new CanonicalEventIdentityError("Event identity key must be eventPayloadName:version");
  }
  const eventPayloadName = key.slice(0, separator);
  const versionText = key.slice(separator + 1);
  if (!/^\d+$/.test(versionText) || (versionText.length > 1 && versionText.startsWith("0"))) {
    throw new CanonicalEventIdentityError("Event identity version must be canonical decimal text");
  }
  const version = Number(versionText);
  const canonical = canonicalEventKey(eventPayloadName, version);
  if (canonical !== key) {
    throw new CanonicalEventIdentityError("Event identity key is not canonical");
  }
  return Object.freeze({ eventPayloadName, version, key });
}

export interface TagDefinition {
  readonly id: string;
  readonly group: string;
  readonly content: string;
  readonly tag: string;
}

export type TagInput =
  | TagDefinition
  | { readonly id?: string; readonly tag?: string; readonly group?: string; readonly content?: string }
  | string;

const tagParts = (input: TagInput, content?: string): { group: string; content: string; id?: string } => {
  if (typeof input === "string") {
    if (content !== undefined) return { group: input, content };
    const separator = input.indexOf(":");
    if (separator > 0) return { group: input.slice(0, separator), content: input.slice(separator + 1), id: input };
    throw new DcbDefinitionError("TAG_INVALID", "A tag string must be group:content");
  }
  const group = input.group;
  const tagContent = input.content;
  const id = input.id ?? input.tag;
  if (typeof group === "string" && typeof tagContent === "string") return { group, content: tagContent, id };
  if (typeof id === "string") {
    const separator = id.indexOf(":");
    if (separator > 0) return { group: id.slice(0, separator), content: id.slice(separator + 1), id };
  }
  throw new DcbDefinitionError("TAG_INVALID", "A tag requires group and content");
};

export function defineTag(group: string, content: string): TagDefinition;
export function defineTag(input: TagInput): TagDefinition;
export function defineTag(input: TagInput, content?: string): TagDefinition {
  const parts = tagParts(input, content);
  const id = parts.id ?? `${parts.group}:${parts.content}`;
  if (parts.group.length === 0 || parts.content.length === 0 || id.length === 0) {
    throw new DcbDefinitionError("TAG_INVALID", "Tag group, content, and id must be non-empty");
  }
  return Object.freeze({ id, group: parts.group, content: parts.content, tag: id });
}

export interface DefinedEvent<TPayload extends JsonValue = JsonValue> {
  readonly eventName: string;
  readonly eventPayloadName: string;
  readonly payload: TPayload;
}

export interface EventDefinition<TPayload extends JsonValue = JsonValue> {
  readonly name: string;
  readonly eventName: string;
  readonly eventPayloadName: string;
  readonly version: number;
  readonly eventType: string;
  readonly create: (payload: unknown) => DefinedEvent<TPayload>;
  readonly construct: (payload: unknown) => DefinedEvent<TPayload>;
  readonly parse: (payload: unknown) => TPayload;
}

export type EventParser<TPayload extends JsonValue> = (payload: unknown) => TPayload;
export type EventDefinitionOptions<TPayload extends JsonValue> = {
  readonly name?: string;
  readonly eventName?: string;
  readonly eventPayloadName?: string;
  /** Version of the payload schema; existing definitions default to v1. */
  readonly version?: number;
  readonly parse?: EventParser<TPayload>;
  readonly parser?: EventParser<TPayload>;
  readonly validate?: EventParser<TPayload>;
};

export function defineEvent<TPayload extends JsonValue = JsonValue>(
  name: string,
  parser?: EventParser<TPayload>,
): EventDefinition<TPayload>;
export function defineEvent<TPayload extends JsonValue = JsonValue>(
  options: EventDefinitionOptions<TPayload>,
): EventDefinition<TPayload>;
export function defineEvent<TPayload extends JsonValue = JsonValue>(
  input: string | EventDefinitionOptions<TPayload>,
  parser?: EventParser<TPayload>,
): EventDefinition<TPayload> {
  const options = typeof input === "string" ? { name: input, parse: parser } : input;
  const name = options.name ?? options.eventName;
  if (!name) throw new DcbDefinitionError("EVENT_NAME_REQUIRED", "Event name is required");
  const eventPayloadName = options.eventPayloadName ?? name;
  const version = options.version ?? 1;
  const eventType = canonicalEventKey(eventPayloadName, version);
  const validate = options.parse ?? options.parser ?? options.validate ?? ((payload: unknown) => payload as TPayload);
  const parse = (payload: unknown): TPayload => {
    let parsed: unknown;
    try {
      parsed = validate(payload);
    } catch (error) {
      throw new DcbDefinitionError("EVENT_PAYLOAD_INVALID", `Event ${name} payload was rejected`, {
        cause: error,
      });
    }
    return assertJsonValue(parsed, "event-construction") as TPayload;
  };
  const create = (payload: unknown): DefinedEvent<TPayload> =>
    Object.freeze({ eventName: name, eventPayloadName, payload: parse(payload) });
  return Object.freeze({ name, eventName: name, eventPayloadName, version, eventType, create, construct: create, parse });
}

export type ProjectorState = JsonValue;
export type ProjectorEvent = DefinedEvent | {
  readonly eventName?: string;
  readonly eventPayloadName?: string;
  readonly eventType?: string;
  readonly payload?: unknown;
};
export type ProjectorHandler<TState extends JsonValue = JsonValue> = (
  state: TState,
  event: DefinedEvent,
) => TState;

export interface ProjectorDefinition<TState extends JsonValue = JsonValue> {
  readonly id: string;
  readonly projectorId: string;
  readonly version: number;
  readonly projectorVersion: number;
  readonly subscribedEventNames: readonly string[];
  readonly subscribedEventTypes: readonly string[];
  readonly initialState: TState;
  readonly apply: (state: TState, event: ProjectorEvent) => TState;
  readonly reduce: (state: TState, event: ProjectorEvent) => TState;
  readonly serializeState: (state: TState) => string;
  readonly deserializeState: (serialized: string) => TState;
}

export type ProjectorDefinitionOptions<TState extends JsonValue = JsonValue> = {
  readonly id?: string;
  readonly projectorId?: string;
  readonly version?: number;
  readonly projectorVersion?: number;
  readonly subscribedEventNames?: readonly string[];
  readonly subscriptions?: readonly string[];
  readonly events?: readonly (string | EventDefinition)[];
  readonly subscribedEventTypes?: readonly string[];
  readonly initialState: TState;
  readonly handlers?: Readonly<Record<string, ProjectorHandler<TState>>>;
  readonly eventHandlers?: Readonly<Record<string, ProjectorHandler<TState>>>;
  /** Optional canonical-key handlers; name handlers remain valid for v1. */
  readonly eventTypeHandlers?: Readonly<Record<string, ProjectorHandler<TState>>>;
  readonly serializeState?: (state: TState) => string;
  readonly deserializeState?: (serialized: string) => TState;
};

const eventNameOf = (event: ProjectorEvent): string | undefined => event.eventName ?? event.eventPayloadName;

export function defineProjector<TState extends JsonValue = JsonValue>(
  options: ProjectorDefinitionOptions<TState>,
): ProjectorDefinition<TState> {
  const id = options.id ?? options.projectorId;
  if (!id) throw new DcbDefinitionError("PROJECTOR_ID_REQUIRED", "Projector id is required");
  const handlers = options.handlers ?? options.eventHandlers ?? {};
  const subscribed = options.subscribedEventNames ?? options.subscriptions ?? options.events?.map((event) => typeof event === "string" ? event : event.name) ?? Object.keys(handlers);
  const uniqueSubscribed = [...new Set(subscribed)];
  const eventTypeHandlers = options.eventTypeHandlers ?? {};
  const subscribedEventTypes = options.subscribedEventTypes ?? options.events?.map((event) =>
    typeof event === "string" ? canonicalEventKey(event, 1) : event.eventType,
  ) ?? uniqueSubscribed.map((name) => canonicalEventKey(name, 1));
  const uniqueSubscribedEventTypes = [...new Set(subscribedEventTypes.map((eventType) => parseCanonicalEventKey(eventType).key))];
  const missing = uniqueSubscribed.filter((name) =>
    handlers[name] === undefined && !uniqueSubscribedEventTypes.some((eventType) =>
      parseCanonicalEventKey(eventType).eventPayloadName === name && eventTypeHandlers[eventType] !== undefined,
    ),
  );
  if (missing.length > 0) {
    throw new DcbDefinitionError("PROJECTOR_HANDLER_REQUIRED", `Projector ${id} is missing handlers: ${missing.join(", ")}`);
  }
  const version = options.version ?? options.projectorVersion ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new DcbDefinitionError("PROJECTOR_VERSION_INVALID", "Projector version must be a positive integer");
  }
  const initialState = assertJsonValue(options.initialState, "state-persistence") as TState;
  const apply = (state: TState, event: ProjectorEvent): TState => {
    const eventType = "eventType" in event ? event.eventType : undefined;
    const identity = eventType === undefined ? undefined : parseCanonicalEventKey(eventType);
    const name = identity?.eventPayloadName ?? eventNameOf(event);
    if (!name || !uniqueSubscribed.includes(name)) return state;
    if (identity !== undefined && !uniqueSubscribedEventTypes.includes(identity.key)) {
      throw new DcbDefinitionError("EVENT_TYPE_UNREGISTERED", `Projector ${id} does not subscribe to ${identity.key}`);
    }
    const payload = assertJsonValue(event.payload, "event-construction");
    const definedEvent = Object.freeze({
      eventName: name,
      eventPayloadName: event.eventPayloadName ?? name,
      payload,
    });
    const handler = identity === undefined ? handlers[name] : eventTypeHandlers[identity.key] ?? handlers[name];
    if (handler === undefined) throw new DcbDefinitionError("PROJECTOR_HANDLER_REQUIRED", `Projector ${id} has no handler for ${identity?.key ?? name}`);
    const next = handler(state, definedEvent);
    return assertJsonValue(next, "state-persistence") as TState;
  };
  const serializeState = options.serializeState
    ? (state: TState) => {
        assertJsonValue(state, "state-persistence");
        const serialized = options.serializeState!(state);
        if (typeof serialized !== "string") throw new DcbDefinitionError("STATE_SERIALIZATION_INVALID", `Projector ${id} did not serialize to a string`);
        return serialized;
      }
    : (state: TState) => JSON.stringify(assertJsonValue(state, "state-persistence"));
  const deserializeState = options.deserializeState
    ? (serialized: string) => assertJsonValue(options.deserializeState!(serialized), "state-persistence") as TState
    : (serialized: string) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(serialized);
        } catch (error) {
          throw new DcbDefinitionError("STATE_DESERIALIZATION_INVALID", `Projector ${id} received invalid JSON`, { cause: error });
        }
        return assertJsonValue(parsed, "state-persistence") as TState;
      };
  return Object.freeze({
    id,
    projectorId: id,
    version,
    projectorVersion: version,
    subscribedEventNames: Object.freeze(uniqueSubscribed),
    subscribedEventTypes: Object.freeze(uniqueSubscribedEventTypes),
    initialState,
    apply,
    reduce: apply,
    serializeState,
    deserializeState,
  });
}

export interface AppendedEvent {
  readonly event: EventDefinition;
  readonly payload: JsonValue;
  readonly tags: readonly TagDefinition[];
}

export interface CommandContext<TState extends JsonValue = JsonValue> {
  readonly state: <T extends JsonValue = JsonValue>(tag: TagInput) => T | undefined;
  readonly assertEmpty: (tag: TagInput) => void;
  readonly append: (event: EventDefinition, payload: unknown, tags?: readonly TagInput[]) => AppendedEvent;
  readonly done: (value?: JsonValue) => CommandDone<TState>;
  readonly noop: (reason?: string) => Omit<CommandNoop, "events">;
  readonly reject: (reason: string, code?: string) => Omit<CommandRejected, "events">;
  readonly appendedEvents: readonly AppendedEvent[];
}

export interface CommandCommitted<TState extends JsonValue = JsonValue> {
  readonly kind: "committed";
  readonly value?: JsonValue;
  readonly state?: TState;
  readonly events: readonly AppendedEvent[];
}
export interface CommandDone<TState extends JsonValue = JsonValue> {
  readonly kind: "committed";
  readonly value?: JsonValue;
  readonly state?: TState;
}
export interface CommandNoop {
  readonly kind: "noop";
  readonly reason?: string;
  readonly events: readonly [];
}
export interface CommandRejected {
  readonly kind: "rejected";
  readonly reason: string;
  readonly code: string;
  readonly events: readonly [];
}
export type CommandHandlerOutcome<TState extends JsonValue = JsonValue> = CommandDone<TState> | Omit<CommandNoop, "events"> | Omit<CommandRejected, "events">;
export type CommandOutcome<TState extends JsonValue = JsonValue> = CommandCommitted<TState> | CommandNoop | CommandRejected;

export const done = <TState extends JsonValue = JsonValue>(value?: JsonValue, state?: TState): CommandDone<TState> =>
  Object.freeze({ kind: "committed" as const, value, state });
export const noop = (reason?: string): CommandNoop => Object.freeze({ kind: "noop" as const, reason, events: [] as const });
export const reject = (reason: string, code = "command_rejected"): CommandRejected =>
  Object.freeze({ kind: "rejected" as const, reason, code, events: [] as const });

export type CommandInputParser<TInput> = (input: unknown) => TInput;
export type CommandHandler<TInput, TState extends JsonValue = JsonValue> = (
  input: TInput,
  context: CommandContext<TState>,
) => CommandHandlerOutcome<TState>;

export interface CommandDefinition<TInput = unknown, TState extends JsonValue = JsonValue> {
  readonly id: string;
  readonly name: string;
  readonly parseInput: (input: unknown) => TInput;
  readonly execute: (input: unknown, options?: { readonly state?: Readonly<Record<string, JsonValue>> }) => CommandOutcome<TState>;
  readonly handle: CommandDefinition<TInput, TState>["execute"];
}

export type CommandDefinitionOptions<TInput, TState extends JsonValue = JsonValue> = {
  readonly id?: string;
  readonly name?: string;
  readonly parseInput?: CommandInputParser<TInput>;
  readonly inputParser?: CommandInputParser<TInput>;
  readonly input?: CommandInputParser<TInput>;
  readonly handler: CommandHandler<TInput, TState>;
};

export function defineCommand<TInput, TState extends JsonValue = JsonValue>(
  options: CommandDefinitionOptions<TInput, TState>,
): CommandDefinition<TInput, TState> {
  const id = options.id ?? options.name;
  if (!id) throw new DcbDefinitionError("COMMAND_ID_REQUIRED", "Command id is required");
  const parser = options.parseInput ?? options.inputParser ?? options.input;
  if (!parser) throw new DcbDefinitionError("COMMAND_INPUT_PARSER_REQUIRED", `Command ${id} requires an input parser`);
  const parseInput = (input: unknown): TInput => {
    let parsed: unknown;
    try {
      parsed = parser(input);
    } catch (error) {
      throw new DcbDefinitionError("COMMAND_INPUT_INVALID", `Command ${id} input was rejected`, { cause: error });
    }
    assertJsonValue(parsed, "command-input");
    return parsed as TInput;
  };
  const execute = (input: unknown, executionOptions?: { readonly state?: Readonly<Record<string, JsonValue>> }): CommandOutcome<TState> => {
    const appended: AppendedEvent[] = [];
    const stateMap = executionOptions?.state ?? {};
    const context: CommandContext<TState> = {
      state: <T extends JsonValue = JsonValue>(tag: TagInput) => stateMap[defineTag(tag).id] as T | undefined,
      assertEmpty: (tag: TagInput) => {
        if (stateMap[defineTag(tag).id] !== undefined) throw new DcbDefinitionError("ASSERT_EMPTY_FAILED", `Tag ${defineTag(tag).id} is not empty`);
      },
      append: (event: EventDefinition, payload: unknown, tags: readonly TagInput[] = []) => {
        const entry = Object.freeze({ event, payload: event.parse(payload), tags: Object.freeze(tags.map((tag) => defineTag(tag))) });
        appended.push(entry);
        return entry;
      },
      done: (value?: JsonValue) => Object.freeze({ kind: "committed" as const, value }),
      noop: (reason?: string) => Object.freeze({ kind: "noop" as const, reason }),
      reject: (reason: string, code?: string) => Object.freeze({ kind: "rejected" as const, reason, code: code ?? "command_rejected" }),
      appendedEvents: appended,
    };
    const outcome = options.handler(parseInput(input), context);
    if (!outcome || typeof outcome !== "object" || !["committed", "noop", "rejected"].includes(outcome.kind)) {
      throw new DcbDefinitionError("COMMAND_OUTCOME_INVALID", `Command ${id} must return done, noop, or reject`);
    }
    if (outcome.kind === "committed") return Object.freeze({ ...outcome, events: Object.freeze([...appended]) });
    if (appended.length > 0) throw new DcbDefinitionError("COMMAND_EVENTS_WITHOUT_COMMIT", `Command ${id} appended events but did not return done`);
    return outcome.kind === "noop"
      ? Object.freeze({ ...outcome, events: [] as const })
      : Object.freeze({ ...outcome, events: [] as const });
  };
  return Object.freeze({ id, name: id, parseInput, execute, handle: execute });
}

export interface DomainComponentDefinition {
  readonly id?: string;
  readonly name?: string;
  readonly version?: number;
  readonly projectorVersion?: number;
  readonly queryVersion?: number;
}

export interface DomainCollision {
  readonly kind: "event-name" | "command-id" | "projector-id" | "query-id" | "materialized-view-id" | "version-pair";
  readonly id: string;
  readonly version?: number;
  readonly indexes: readonly number[];
}

export class DomainDefinitionError extends DcbDefinitionError {
  readonly code = "DOMAIN_DEFINITION_INVALID" as const;
  readonly collisions: readonly DomainCollision[];

  constructor(collisions: readonly DomainCollision[]) {
    super("DOMAIN_DEFINITION_INVALID", `Domain contains ${collisions.length} duplicate definition collision(s)`);
    this.name = "DomainDefinitionError";
    this.collisions = Object.freeze([...collisions]);
  }
}

export interface DomainDefinition {
  readonly events: readonly EventDefinition[];
  readonly commands: readonly CommandDefinition[];
  readonly projectors: readonly DomainProjectorDefinition[];
  readonly queries: readonly DomainComponentDefinition[];
  readonly materializedViews: readonly DomainComponentDefinition[];
  readonly eventByName: ReadonlyMap<string, EventDefinition>;
}

/** The identity portion needed when registering a projector in a domain. */
export interface DomainProjectorDefinition {
  readonly id: string;
  readonly version: number;
}

export type DomainDefinitionOptions = {
  readonly events?: readonly EventDefinition[];
  readonly commands?: readonly CommandDefinition[];
  readonly projectors?: readonly DomainProjectorDefinition[];
  readonly queries?: readonly DomainComponentDefinition[];
  readonly materializedViews?: readonly DomainComponentDefinition[];
  readonly mvs?: readonly DomainComponentDefinition[];
};

const componentId = (component: DomainComponentDefinition): string => component.id ?? component.name ?? "";
const componentVersion = (component: DomainComponentDefinition): number | undefined => component.version ?? component.projectorVersion ?? component.queryVersion;

export function defineDomain(options: DomainDefinitionOptions): DomainDefinition {
  const events = [...(options.events ?? [])];
  const commands = [...(options.commands ?? [])];
  const projectors = [...(options.projectors ?? [])];
  const queries = [...(options.queries ?? [])];
  const materializedViews = [...(options.materializedViews ?? options.mvs ?? [])];
  const collisions: DomainCollision[] = [];
  const collect = (kind: DomainCollision["kind"], values: readonly string[]) => {
    const indexesById = new Map<string, number[]>();
    values.forEach((id, index) => {
      if (id.length === 0) return;
      const indexes = indexesById.get(id) ?? [];
      indexes.push(index);
      indexesById.set(id, indexes);
    });
    for (const [id, indexes] of indexesById) {
      if (indexes.length > 1) collisions.push({ kind, id, indexes: Object.freeze(indexes) });
    }
  };
  collect("event-name", events.map((event) => event.name));
  collect("command-id", commands.map((command) => command.id));
  collect("projector-id", projectors.map((projector) => projector.id));
  collect("query-id", queries.map(componentId));
  collect("materialized-view-id", materializedViews.map(componentId));
  const collectVersionPairs = (components: readonly DomainComponentDefinition[], kind: DomainCollision["kind"]) => {
    const pairs = new Map<string, number[]>();
    components.forEach((component, index) => {
      const id = componentId(component);
      const version = componentVersion(component);
      if (id.length === 0 || version === undefined) return;
      const key = `${id}\u0000${version}`;
      const indexes = pairs.get(key) ?? [];
      indexes.push(index);
      pairs.set(key, indexes);
    });
    for (const [key, indexes] of pairs) {
      if (indexes.length > 1) {
        const [id, version] = key.split("\u0000");
        collisions.push({ kind, id, version: Number(version), indexes: Object.freeze(indexes) });
      }
    }
  };
  collectVersionPairs(projectors, "version-pair");
  collectVersionPairs(queries, "version-pair");
  collectVersionPairs(materializedViews, "version-pair");
  if (collisions.length > 0) throw new DomainDefinitionError(collisions);
  return Object.freeze({
    events: Object.freeze(events),
    commands: Object.freeze(commands),
    projectors: Object.freeze(projectors),
    queries: Object.freeze(queries),
    materializedViews: Object.freeze(materializedViews),
    eventByName: new Map(events.map((event) => [event.name, event])),
  });
}

export * from "./materializedView";
