import { z } from "zod";
import {
  DomainAuthoringError,
  DomainRegistrationError,
  type EventOf,
  type EventRecord,
  type Tag,
  type ProjectorLike,
  type TagFamily,
} from "./types";
import type { EventDefinition } from "./event";

const projectorFamilyInvariant: unique symbol = Symbol("projector-family-invariant");

export interface StateUnion<Schema extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly kind: "state-union";
  readonly schema: Schema;
  readonly parse: (value: unknown) => z.infer<Schema>;
  /** The projector initial state when the projector declares neither `initialState` nor `initial`. */
  readonly initial: z.infer<Schema> | (() => z.infer<Schema>);
}

/**
 * Bind a closed state schema. A discriminated union's discriminator is owned by
 * the zod schema itself, which `parse` enforces; there is no separate option.
 */
export function stateUnion<Schema extends z.ZodTypeAny>(
  schema: Schema,
  options: { readonly initial: z.infer<Schema> | (() => z.infer<Schema>) },
): StateUnion<Schema> {
  return Object.freeze({
    kind: "state-union" as const,
    schema,
    parse: (value: unknown) => schema.parse(value),
    initial: options.initial,
  });
}

export const state = stateUnion;

export function states<
  const Variants extends readonly [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
>(
  variants: Variants,
  options: { readonly discriminator?: string; readonly initial: z.infer<Variants[number]> | (() => z.infer<Variants[number]>) },
): StateUnion<z.ZodType<z.infer<Variants[number]>>> {
  const discriminator = options.discriminator ?? "kind";
  // Keep the discriminator visible to Zod as well as to the authoring type.
  // The cast is limited to the public variadic tuple surface; callers are
  // expected to provide object variants carrying the selected discriminator.
  const schema = z.discriminatedUnion(discriminator, variants as never) as z.ZodType<z.infer<Variants[number]>>;
  return stateUnion(schema, { initial: options.initial });
}

export type StateOf<Definition extends StateUnion> = z.infer<Definition["schema"]>;

export type ValidateResult<Kind extends string = string, Details = unknown> =
  | { readonly kind: "reject"; readonly rejectKind: Kind; readonly reason: string; readonly details?: Details }
  | undefined;

export function validationReject<Kind extends string, Details = unknown>(
  rejectKind: Kind,
  reason: string,
  details?: Details,
): Exclude<ValidateResult<Kind, Details>, undefined> {
  return Object.freeze({ kind: "reject" as const, rejectKind, reason, ...(details === undefined ? {} : { details }) });
}

export type PureValidator<State, Args, Kind extends string = string, Details = unknown> =
  (state: State, args: Args) => ValidateResult<Kind, Details>;

export type PureEvolver<State, Event extends EventDefinition = EventDefinition> =
  (state: State, event: ProjectorEvent<Event>) => State;

export interface DeciderModule<State, Args, Event extends EventDefinition = EventDefinition, Kind extends string = string> {
  readonly validate: PureValidator<State, Args, Kind>;
  readonly evolve: PureEvolver<State, Event>;
}

export function validate<State, Args, Kind extends string = string, Details = unknown>(
  fn: PureValidator<State, Args, Kind, Details>,
): PureValidator<State, Args, Kind, Details> {
  return fn;
}

export function evolve<State, Event extends EventDefinition>(
  fn: PureEvolver<State, Event>,
): PureEvolver<State, Event> {
  return fn;
}

export function decider<State, Args, Event extends EventDefinition, Kind extends string = string>(
  module: DeciderModule<State, Args, Event, Kind>,
): DeciderModule<State, Args, Event, Kind> {
  return Object.freeze({ validate: module.validate, evolve: module.evolve });
}

export interface ProjectorEvent<Event extends EventDefinition = EventDefinition> {
  readonly definition: Event;
  readonly eventType: string;
  readonly payload: EventOf<Event>;
  readonly tags: readonly Tag[];
}

export type ProjectorHandler<State, Event extends EventDefinition = EventDefinition> = (
  state: State,
  event: ProjectorEvent<Event>,
) => State;

export interface ProjectorDefinition<
  State = unknown,
  Family extends string = string,
  Events extends readonly EventDefinition[] = readonly EventDefinition[],
> extends ProjectorLike {
  readonly id: string;
  readonly version: number;
  readonly tag: TagFamily<Family>;
  readonly [projectorFamilyInvariant]: (value: Family) => Family;
  readonly events: Events;
  readonly eventTypes: readonly string[];
  readonly initialState: State | (() => State);
  readonly handlers: Readonly<Record<string, ProjectorHandler<State, Events[number]>>>;
  readonly apply: (state: State, event: EventRecord) => State;
  readonly reduce: (state: State, event: EventRecord) => State;
  readonly validateState: (state: unknown) => State;
  readonly serializeState: (state: State) => string;
  readonly deserializeState: (serialized: string) => State;
}

export type ProjectorOptions<
  State,
  Family extends string,
  Events extends readonly EventDefinition[],
> = {
  readonly id: string;
  readonly version?: number;
  readonly tag: TagFamily<Family>;
  readonly state?: StateUnion<z.ZodType<State>>;
  readonly source?: EventUnionLike<Events>;
  readonly events?: Events;
  readonly initialState?: State | (() => State);
  readonly initial?: State | (() => State);
  readonly handlers: Readonly<Record<string, ProjectorHandler<State, Events[number]>>>;
  readonly serializeState?: (state: State) => string;
  readonly deserializeState?: (serialized: string) => State;
};

export interface EventUnionLike<Events extends readonly EventDefinition[]> {
  readonly events: Events;
  readonly eventTypes: readonly string[];
}

function initialStateOf<State>(value: State | (() => State) | undefined): State {
  if (value === undefined) throw new DomainAuthoringError("PROJECTOR_INITIAL_STATE_REQUIRED", "Projector initial state is required");
  return typeof value === "function" ? (value as () => State)() : value;
}

function eventNameFromType(eventType: string): string {
  if (eventType.length === 0 || eventType.includes(":")) {
    throw new DomainAuthoringError("CANONICAL_EVENT_IDENTITY_INVALID", `Event type ${eventType} is not an event payload name`);
  }
  return eventType;
}

export function projector<
  const State,
  const Family extends string,
  const Events extends readonly EventDefinition[],
>(
  options: ProjectorOptions<State, Family, Events>,
): ProjectorDefinition<State, Family, Events> {
  if (options.id.length === 0) throw new DomainAuthoringError("PROJECTOR_ID_REQUIRED", "Projector id is required");
  const events = options.events ?? options.source?.events ?? [] as unknown as Events;
  const eventTypes = Object.freeze(events.map((definition) => definition.eventType));
  const handlers = options.handlers;
  for (const eventType of eventTypes) {
    if (handlers[eventType] === undefined && handlers[eventNameFromType(eventType)] === undefined) {
      throw new DomainRegistrationError(`Projector ${options.id} is missing handler for ${eventType}`, [eventType]);
    }
  }
  const version = options.version ?? 1;
  if (!Number.isSafeInteger(version) || version < 1) throw new DomainAuthoringError("PROJECTOR_VERSION_INVALID", "Projector version must be positive");
  const stateSchema = options.state;
  const validateState = stateSchema === undefined
    ? (value: unknown) => value as State
    : (value: unknown) => stateSchema.parse(value);
  const serializeState = options.serializeState ?? ((state: State) => JSON.stringify(state));
  const restoreState = options.deserializeState ?? ((serialized: string) => JSON.parse(serialized) as State);
  // Restored bytes pass through the same schema as every evolution, so a
  // corrupt persisted state fails closed instead of reaching a handler.
  const deserializeState = (serialized: string): State => validateState(restoreState(serialized));
  // An explicit initialState or initial keeps precedence over the state default.
  const declaredInitial = initialStateOf(options.initialState ?? options.initial ?? stateSchema?.initial);
  let initial: State;
  try {
    initial = validateState(declaredInitial);
  } catch (error) {
    throw new DomainAuthoringError("PROJECTOR_INITIAL_STATE_INVALID", `Projector ${options.id} initial state does not match its state schema`, { cause: error });
  }
  const byType = new Map(events.map((definition) => [definition.eventType, definition]));
  const apply = (state: State, event: EventRecord): State => {
    const definition = byType.get(event.eventType);
    if (definition === undefined) {
      throw new DomainAuthoringError("EVENT_TYPE_UNREGISTERED", `Projector ${options.id} does not subscribe to ${event.eventType}`);
    }
    if (!event.tags.some((tag) => tag.family === options.tag.family)) return state;
    const payload = definition.make(event.payload) as EventOf<Events[number]>;
    const handler = handlers[definition.eventType] ?? handlers[definition.name];
    if (handler === undefined) throw new DomainRegistrationError(`Projector ${options.id} has no handler for ${definition.eventType}`, [definition.eventType]);
    const next = handler(state, {
      definition,
      eventType: definition.eventType,
      payload,
      tags: event.tags,
    });
    return validateState(next);
  };
  const subscribes = (eventType: string): boolean => byType.has(eventType);
  return Object.freeze({
    id: options.id,
    version,
    tag: options.tag,
    [projectorFamilyInvariant]: (value: Family) => value,
    events,
    eventTypes,
    initialState: initial,
    handlers,
    subscribes,
    apply,
    reduce: apply,
    validateState,
    serializeState,
    deserializeState,
  });
}

export function projectorInitialState<State>(definition: ProjectorDefinition<State>): State {
  return typeof definition.initialState === "function"
    ? (definition.initialState as () => State)()
    : definition.initialState;
}

export function projectorFamily<Definition extends ProjectorDefinition>(definition: Definition): Definition["tag"] {
  return definition.tag;
}

export type ProjectorState<Definition extends ProjectorDefinition> =
  Definition extends ProjectorDefinition<infer State> ? State : never;
