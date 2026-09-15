import { z } from "zod";
import {
  assertJsonValue,
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
const CAMEL_CASE_KEY = /^[a-z][A-Za-z0-9]*$/;
const FORBIDDEN_PAYLOAD_DISCRIMINATORS = new Set(["eventType", "eventName", "eventPayloadName"]);

function rememberPayload<T>(value: T): T {
  if (typeof value === "object" && value !== null) brandedPayloads.add(value);
  return value;
}

export function isEventPayload(value: unknown): boolean {
  return typeof value === "object" && value !== null && brandedPayloads.has(value);
}

/**
 * Freeze a copy of an already validated JSON value. Objects under `z.any()` or
 * `z.unknown()` still belong to the caller, so they are never frozen in place.
 */
function frozenJsonCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenJsonCopy)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, frozenJsonCopy(item)]))) as T;
  }
  return value;
}

/**
 * C# serialized payloads use JsonNamingPolicy.CamelCase and fail on a
 * case-mismatched member. Check the authoring schema once so callers cannot
 * accidentally publish a PascalCase or discriminator-bearing wire shape.
 */
function assertCamelCaseSchemaKeys(schema: z.ZodTypeAny, path = "$"): void {
  const definition = schema as unknown as {
    readonly def?: {
      readonly type?: unknown;
      readonly shape?: unknown;
      readonly element?: unknown;
      readonly innerType?: unknown;
      readonly options?: unknown;
    };
  };
  const def = definition.def;
  if (def?.type === "object" && typeof def.shape === "object" && def.shape !== null) {
    for (const [key, child] of Object.entries(def.shape as Record<string, z.ZodTypeAny>)) {
      if (!CAMEL_CASE_KEY.test(key) || FORBIDDEN_PAYLOAD_DISCRIMINATORS.has(key)) {
        throw new DomainAuthoringError("EVENT_PAYLOAD_CAMEL_CASE_REQUIRED", `Event schema member ${path}.${key} must be camelCase and must not be a type discriminator`);
      }
      assertCamelCaseSchemaKeys(child, `${path}.${key}`);
    }
    return;
  }
  if (def?.type === "array" && def.element instanceof z.ZodType) {
    assertCamelCaseSchemaKeys(def.element, `${path}[]`);
    return;
  }
  if (def?.innerType instanceof z.ZodType) {
    assertCamelCaseSchemaKeys(def.innerType, path);
    return;
  }
  if (Array.isArray(def?.options)) {
    for (const option of def.options) if (option instanceof z.ZodType) assertCamelCaseSchemaKeys(option, path);
  }
}

export interface EventDefinition<
  Name extends string = string,
  Schema extends z.ZodTypeAny = z.ZodTypeAny,
  Family extends string = string,
> {
  readonly name: Name;
  readonly eventPayloadName: Name;
  readonly eventType: Name | string;
  readonly key: Name | string;
  readonly schema: Schema;
  readonly tags: (payload: z.infer<Schema>) => readonly Tag<Family>[];
  readonly make: (payload: unknown) => EventOf<EventDefinition<Name, Schema, Family>>;
  readonly parse: (payload: unknown) => z.infer<Schema>;
  readonly create: (payload: unknown) => RuntimeEventValue;
  readonly construct: (payload: unknown) => RuntimeEventValue;
  readonly tagFamilies: readonly string[];
}

export interface RuntimeEventValue {
  readonly eventName?: string;
  readonly eventPayloadName?: string;
  readonly eventType: string;
  readonly payload: JsonValue;
  readonly tags: readonly Tag[];
}

export interface EventOptions<Payload, Deriver extends TagDeriver<Payload>> {
  readonly tags: Deriver;
  /** Removed by G32: define a distinct event name for each payload revision. */
  readonly version?: never;
  readonly tagFamily?: TagFamily | string;
}

export function event<
  const Name extends string,
  Schema extends z.ZodTypeAny,
  Deriver extends TagDeriver<z.infer<Schema>>,
>(
  name: Name,
  schema: Schema,
  options: EventOptions<z.infer<Schema>, Deriver>,
): EventDefinition<Name, Schema, TagFamilyOfDeriver<Deriver>> {
  if (name.length === 0) throw new DomainAuthoringError("EVENT_NAME_INVALID", "Event name must not be empty");
  if (name.includes(":")) throw new DomainAuthoringError("EVENT_NAME_INVALID", "Event name must not contain ':'");
  if (Object.prototype.hasOwnProperty.call(options, "version")) {
    throw new DomainAuthoringError("EVENT_VERSION_REMOVED", "Event version is removed; use a distinct event payload name");
  }
  const eventType = name;
  assertCamelCaseSchemaKeys(schema);
  const parse = (payload: unknown): z.infer<Schema> => {
    const parsed = schema.parse(payload);
    assertJsonValue(parsed, "event-construction");
    return parsed;
  };
  const make = (payload: unknown): EventOf<EventDefinition<Name, Schema, TagFamilyOfDeriver<Deriver>>> => {
    const parsed = frozenJsonCopy(parse(payload));
    return rememberPayload(parsed) as EventPayload<EventDefinition<Name, Schema, TagFamilyOfDeriver<Deriver>>>;
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
  }) as EventDefinition<Name, Schema, TagFamilyOfDeriver<Deriver>>;
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
