import {
  assertJsonValue,
  DomainAuthoringError,
  type JsonValue,
} from "./types";
import type { EventDefinition, RuntimeEventValue } from "./event";
import type { AuthoringDomain } from "./domain";
import type { ProjectorDefinition } from "./state";

export interface RuntimeProjectionEvent {
  readonly eventId?: string;
  readonly suid?: string;
  readonly eventType: string;
  readonly eventPayloadName?: string;
  readonly payload: unknown;
  readonly eventTags?: readonly string[];
  readonly provenance?: "g27" | "pre-g27";
}

export interface RuntimeEventDefinition {
  readonly name: string;
  readonly eventName: string;
  readonly eventPayloadName: string;
  readonly version: number;
  readonly eventType: string;
  readonly create: (payload: unknown) => RuntimeEventValue;
  readonly construct: (payload: unknown) => RuntimeEventValue;
  readonly parse: (payload: unknown) => JsonValue;
}

export interface RuntimeProjectorDefinition {
  readonly id: string;
  readonly projectorId: string;
  readonly version: number;
  readonly projectorVersion: number;
  readonly subscribedEventNames: readonly string[];
  readonly subscribedEventTypes: readonly string[];
  readonly initialState: JsonValue;
  readonly apply: (state: JsonValue, event: RuntimeProjectionEvent) => JsonValue;
  readonly reduce: (state: JsonValue, event: RuntimeProjectionEvent) => JsonValue;
  readonly serializeState: (state: JsonValue) => string;
  readonly deserializeState: (serialized: string) => JsonValue;
}

export interface RuntimeCommandDefinition {
  readonly id: string;
  readonly name: string;
  readonly parseInput: (value: unknown) => unknown;
  readonly execute: (...args: readonly unknown[]) => unknown;
  readonly handle: (...args: readonly unknown[]) => unknown;
}

export interface RuntimeDomainDefinition {
  readonly events: readonly RuntimeEventDefinition[];
  readonly commands: readonly RuntimeCommandDefinition[];
  readonly projectors: readonly RuntimeProjectorDefinition[];
  readonly queries: readonly [];
  readonly materializedViews: readonly [];
  readonly eventByName: ReadonlyMap<string, RuntimeEventDefinition>;
  readonly eventByType: ReadonlyMap<string, RuntimeEventDefinition>;
  readonly __sekibanAuthoringBridge: true;
}

interface LegacyEventDefinition {
  readonly name?: string;
  readonly eventName?: string;
  readonly eventPayloadName?: string;
  readonly version?: number;
  readonly eventType?: string;
  readonly parse?: (payload: unknown) => unknown;
  readonly create?: (payload: unknown) => { readonly payload?: unknown; readonly eventName?: string; readonly eventPayloadName?: string };
  readonly construct?: (payload: unknown) => { readonly payload?: unknown; readonly eventName?: string; readonly eventPayloadName?: string };
}

interface LegacyDomainDefinition {
  readonly events?: readonly LegacyEventDefinition[];
  readonly commands?: readonly RuntimeCommandDefinition[];
  readonly projectors?: readonly RuntimeProjectorDefinition[];
}

function runtimeEventFrom(definition: EventDefinition | LegacyEventDefinition): RuntimeEventDefinition {
  const name = definition.name ?? definition.eventPayloadName;
  if (name === undefined || name.length === 0 || name.includes(":")) throw new DomainAuthoringError("EVENT_NAME_INVALID", "Runtime event name is invalid");
  const eventPayloadName = definition.eventPayloadName ?? name;
  if (eventPayloadName.length === 0 || eventPayloadName.includes(":")) throw new DomainAuthoringError("EVENT_NAME_INVALID", "Runtime event payload name is invalid");
  const version = definition.version ?? 1;
  const expectedEventType = `${eventPayloadName}:${version}`;
  const eventType = definition.eventType ?? expectedEventType;
  if (eventType !== expectedEventType) throw new DomainAuthoringError("CANONICAL_EVENT_IDENTITY_INVALID", `Runtime event identity must be ${expectedEventType}`);
  const parse = (payload: unknown): JsonValue => {
    const parsed = definition.parse === undefined
      ? definition.create?.(payload)?.payload ?? definition.construct?.(payload)?.payload ?? payload
      : definition.parse(payload);
    return assertJsonValue(parsed, "event-construction");
  };
  const create = (payload: unknown): RuntimeEventValue => Object.freeze({
    eventName: name,
    eventPayloadName,
    eventType,
    version,
    payload: parse(payload),
    tags: Object.freeze([]),
  });
  return Object.freeze({
    name,
    eventName: name,
    eventPayloadName: definition.eventPayloadName ?? name,
    version,
    eventType,
    create,
    construct: create,
    parse,
  });
}

function runtimeProjectorFrom(
  definition: ProjectorDefinition,
  events: ReadonlyMap<string, RuntimeEventDefinition>,
): RuntimeProjectorDefinition {
  const eventTypes = Object.freeze([...definition.eventTypes]);
  const eventNames = Object.freeze(eventTypes.map((eventType) => events.get(eventType)?.name ?? eventType.split(":")[0] ?? eventType));
  const initial = typeof definition.initialState === "function"
    ? (definition.initialState as () => unknown)()
    : definition.initialState;
  const apply = (state: JsonValue, event: RuntimeProjectionEvent): JsonValue => {
    const registered = events.get(event.eventType);
    if (registered === undefined || !eventTypes.includes(event.eventType)) {
      throw new DomainAuthoringError("EVENT_TYPE_UNREGISTERED", `Runtime projector received ${event.eventType}`);
    }
    const syntheticTag = definition.tag.of("__runtime__");
    const next = definition.apply(state, {
      eventType: event.eventType,
      eventName: registered.name,
      payload: registered.parse(event.payload),
      tags: [syntheticTag],
      ordinal: "runtime",
    });
    return assertJsonValue(next, "state-persistence");
  };
  const serializeState = (state: JsonValue): string => definition.serializeState(state);
  const deserializeState = (serialized: string): JsonValue => assertJsonValue(definition.deserializeState(serialized), "state-persistence");
  return Object.freeze({
    id: definition.id,
    projectorId: definition.id,
    version: definition.version,
    projectorVersion: definition.version,
    subscribedEventNames: eventNames,
    subscribedEventTypes: eventTypes,
    initialState: assertJsonValue(initial, "state-persistence"),
    apply,
    reduce: apply,
    serializeState,
    deserializeState,
  });
}

export function toRuntimeDomain(
  domain: AuthoringDomain<readonly EventDefinition[], readonly unknown[], readonly unknown[]> | LegacyDomainDefinition,
): RuntimeDomainDefinition {
  const rawEvents = domain.events ?? [];
  const events = rawEvents.map(runtimeEventFrom);
  const byType = new Map<string, RuntimeEventDefinition>();
  for (const event of events) {
    if (byType.has(event.eventType)) throw new DomainAuthoringError("DUPLICATE_CANONICAL_EVENT_IDENTITY", `Duplicate event identity ${event.eventType}`);
    byType.set(event.eventType, event);
  }
  const byName = new Map<string, RuntimeEventDefinition>();
  for (const event of events) if (!byName.has(event.name)) byName.set(event.name, event);
  const projectors: RuntimeProjectorDefinition[] = [];
  for (const projectorValue of domain.projectors ?? []) {
    if (typeof projectorValue === "object" && projectorValue !== null && "tag" in projectorValue) {
      projectors.push(runtimeProjectorFrom(projectorValue as ProjectorDefinition, byType));
    } else {
      projectors.push(projectorValue as RuntimeProjectorDefinition);
    }
  }
  const commands = (domain.commands ?? []).map((command) => command as RuntimeCommandDefinition);
  return Object.freeze({
    events: Object.freeze(events),
    commands: Object.freeze(commands),
    projectors: Object.freeze(projectors),
    queries: Object.freeze([]) as readonly [],
    materializedViews: Object.freeze([]) as readonly [],
    eventByName: byName,
    eventByType: byType,
    __sekibanAuthoringBridge: true as const,
  });
}

export const normalizeRuntimeDomain = toRuntimeDomain;
