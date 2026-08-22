import { z } from "zod";
import {
  assertJsonValue,
  cloneAndFreeze,
  DomainAuthoringError,
  type EventOf,
  type EventPayload,
  type JsonValue,
  normalizeTag,
  type Tag,
  type TagDeriver,
  type TagFamily,
  type TagFamilyOfDeriver,
} from "./types";

const brandedPayloads = new WeakSet<object>();

function rememberPayload<T>(value: T): T {
  if (typeof value === "object" && value !== null) brandedPayloads.add(value);
  return value;
}

export function isEventPayload(value: unknown): boolean {
  return typeof value === "object" && value !== null && brandedPayloads.has(value);
}

export interface EventDefinition<
  Name extends string = string,
  Schema extends z.ZodTypeAny = z.ZodTypeAny,
  Family extends string = string,
  Version extends number = number,
> {
  readonly name: Name;
  readonly eventPayloadName: Name;
  readonly version: Version;
  readonly eventType: `${Name}:${Version}` | string;
  readonly key: `${Name}:${Version}` | string;
  readonly schema: Schema;
  readonly tags: (payload: z.infer<Schema>) => readonly Tag<Family>[];
  readonly make: (payload: unknown) => EventOf<EventDefinition<Name, Schema, Family, Version>>;
  readonly parse: (payload: unknown) => z.infer<Schema>;
  readonly create: (payload: unknown) => RuntimeEventValue;
  readonly construct: (payload: unknown) => RuntimeEventValue;
  readonly tagFamilies: readonly string[];
}

export interface RuntimeEventValue {
  readonly eventName: string;
  readonly eventPayloadName: string;
  readonly eventType: string;
  readonly version: number;
  readonly payload: JsonValue;
  readonly tags: readonly Tag[];
}

export interface EventOptions<Payload, Deriver extends TagDeriver<Payload>, Version extends number = number> {
  readonly tags: Deriver;
  readonly version?: Version;
  readonly tagFamily?: TagFamily | string;
}

export function event<
  const Name extends string,
  Schema extends z.ZodTypeAny,
  Deriver extends TagDeriver<z.infer<Schema>>,
  const Version extends number = 1,
>(
  name: Name,
  schema: Schema,
  options: EventOptions<z.infer<Schema>, Deriver, Version> & { readonly version?: Version },
): EventDefinition<Name, Schema, TagFamilyOfDeriver<Deriver>, Version> {
  if (name.length === 0) throw new DomainAuthoringError("EVENT_NAME_INVALID", "Event name must not be empty");
  if (name.includes(":")) throw new DomainAuthoringError("EVENT_NAME_INVALID", "Event name must not contain ':'");
  const version = (options.version ?? 1) as Version;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new DomainAuthoringError("EVENT_VERSION_INVALID", "Event version must be a positive safe integer");
  }
  const eventType = `${name}:${version}`;
  const parse = (payload: unknown): z.infer<Schema> => {
    const parsed = schema.parse(payload);
    assertJsonValue(parsed, "event-construction");
    return parsed;
  };
  const make = (payload: unknown): EventOf<EventDefinition<Name, Schema, TagFamilyOfDeriver<Deriver>, Version>> => {
    const parsed = cloneAndFreeze(parse(payload));
    return rememberPayload(parsed) as EventPayload<EventDefinition<Name, Schema, TagFamilyOfDeriver<Deriver>, Version>>;
  };
  const create = (payload: unknown): RuntimeEventValue => {
    const parsed = parse(payload);
    const rawTags = options.tags(parsed);
    if (!Array.isArray(rawTags)) throw new DomainAuthoringError("EVENT_TAGS_INVALID", `Event ${name} tags must be an array`);
    const tags = rawTags.map(normalizeTag);
    return Object.freeze({
      eventName: name,
      eventPayloadName: name,
      eventType,
      version,
      payload: assertJsonValue(parsed),
      tags,
    }) as RuntimeEventValue;
  };
  const tagFamilies = options.tagFamily === undefined
    ? []
    : [typeof options.tagFamily === "string" ? options.tagFamily : options.tagFamily.family];
  return Object.freeze({
    name,
    eventPayloadName: name,
    version,
    eventType,
    key: eventType,
    schema,
    tags: (payload: z.infer<Schema>) => {
      const rawTags = options.tags(payload);
      if (!Array.isArray(rawTags)) throw new DomainAuthoringError("EVENT_TAGS_INVALID", `Event ${name} tags must be an array`);
      return Object.freeze(rawTags.map(normalizeTag));
    },
    make,
    parse,
    create,
    construct: create,
    tagFamilies: Object.freeze(tagFamilies),
  }) as EventDefinition<Name, Schema, TagFamilyOfDeriver<Deriver>, Version>;
}

export interface EventUnion<Events extends readonly EventDefinition[] = readonly EventDefinition[]> {
  readonly kind: "event-union";
  readonly events: Events;
  readonly eventTypes: readonly string[];
  readonly discriminator?: string;
  readonly schema: z.ZodType<EventOf<Events[number]>>;
  readonly parse: (value: unknown) => EventOf<Events[number]>;
  readonly safeParse: (value: unknown) => EventUnionSafeParse<EventOf<Events[number]>>;
}

export type EventUnionSafeParse<Value> =
  | { readonly success: true; readonly data: Value }
  | { readonly success: false; readonly error: z.ZodError };

function parseUnion<Events extends readonly EventDefinition[]>(events: Events, value: unknown): EventOf<Events[number]> {
  let lastError: unknown;
  for (const definition of events) {
    try {
      return definition.make(value) as EventOf<Events[number]>;
    } catch (error) {
      lastError = error;
    }
  }
  throw new DomainAuthoringError(
    "EVENT_UNION_INVALID",
    "Value did not match any event in the union",
    { cause: lastError },
  );
}

function schemaHasDiscriminator(schema: z.ZodTypeAny, discriminator: string): boolean {
  const candidate = schema as unknown as {
    readonly def?: { readonly type?: unknown; readonly shape?: unknown };
  };
  return candidate.def?.type === "object" &&
    typeof candidate.def.shape === "object" &&
    candidate.def.shape !== null &&
    discriminator in candidate.def.shape;
}

export function eventUnion<const Events extends readonly EventDefinition[]>(events: Events): EventUnion<Events>;
export function eventUnion<const Discriminator extends string, const Events extends readonly EventDefinition[]>(
  discriminator: Discriminator,
  events: Events,
): EventUnion<Events>;
export function eventUnion<const Events extends readonly EventDefinition[]>(
  discriminatorOrEvents: string | Events,
  maybeEvents?: Events,
): EventUnion<Events> {
  const discriminator = typeof discriminatorOrEvents === "string" ? discriminatorOrEvents : undefined;
  const events = (typeof discriminatorOrEvents === "string" ? maybeEvents : discriminatorOrEvents) ?? [] as unknown as Events;
  if (events.length === 0) throw new DomainAuthoringError("EVENT_UNION_EMPTY", "An event union must contain an event");
  let zodUnion: z.ZodType<EventOf<Events[number]>> | undefined;
  if (discriminator === undefined || events.every((definition) => schemaHasDiscriminator(definition.schema, discriminator))) {
    try {
      zodUnion = (discriminator === undefined
        ? z.union(events.map((definition) => definition.schema) as never)
        : z.discriminatedUnion(discriminator, events.map((definition) => definition.schema) as never)) as z.ZodType<EventOf<Events[number]>>;
    } catch {
      // A caller may use the optional discriminator only as an authoring label
      // while supplying schemas that are not Zod discriminated objects. The
      // branded parser below remains the fail-closed fallback for that surface.
      zodUnion = undefined;
    }
  }
  const parse = (value: unknown) => {
    if (discriminator !== undefined && (typeof value !== "object" || value === null || Array.isArray(value))) {
      throw new DomainAuthoringError("EVENT_UNION_DISCRIMINATOR_INVALID", `Union discriminator ${discriminator} was absent`);
    }
    if (discriminator !== undefined && zodUnion !== undefined) {
      try {
        zodUnion.parse(value);
      } catch (error) {
        throw new DomainAuthoringError("EVENT_UNION_INVALID", "Value did not match the event discriminator", { cause: error });
      }
    }
    return parseUnion(events, value);
  };
  const schema = zodUnion ?? z.any().refine((value) => {
    try {
      parse(value);
      return true;
    } catch {
      return false;
    }
  }, { message: "Value did not match the event union" }) as z.ZodType<EventOf<Events[number]>>;
  const safeParse = (value: unknown): EventUnionSafeParse<EventOf<Events[number]>> => {
    try {
      return { success: true, data: parse(value) };
    } catch (error) {
      return { success: false, error: error instanceof z.ZodError ? error : new z.ZodError([]) };
    }
  };
  return Object.freeze({
    kind: "event-union" as const,
    events,
    eventTypes: Object.freeze(events.map((definition) => definition.eventType)),
    ...(discriminator === undefined ? {} : { discriminator }),
    schema,
    parse,
    safeParse,
  });
}

export type EventUnionOf<Union extends EventUnion> = EventOf<Union["events"][number]>;
