import type { z } from "zod";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type DomainBoundary =
  | "http-command"
  | "queue"
  | "stored-event"
  | "wasm-restore"
  | "external-query";

export class DomainAuthoringError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DomainAuthoringError";
    this.code = code;
  }
}

export class DomainRegistrationError extends DomainAuthoringError {
  readonly collisions: readonly string[];

  constructor(message: string, collisions: readonly string[] = []) {
    super("DOMAIN_REGISTRATION_INVALID", message);
    this.name = "DomainRegistrationError";
    this.collisions = Object.freeze([...collisions]);
  }
}

declare const tagFamilyBrand: unique symbol;
declare const eventPayloadBrand: unique symbol;
declare const parsedBoundaryBrand: unique symbol;
declare const terminalDecisionBrand: unique symbol;

export interface Tag<Family extends string = string> {
  readonly family: Family;
  readonly group: Family;
  readonly value: string;
  readonly content: string;
  readonly id: string;
  readonly tag: string;
  readonly [tagFamilyBrand]: Family;
}

export interface TagFamily<Family extends string = string> {
  readonly family: Family;
  readonly group: Family;
  readonly of: (value: string) => Tag<Family>;
  readonly create: (value: string) => Tag<Family>;
  readonly [tagFamilyBrand]: Family;
}

export type TagInput<Family extends string = string> = Tag<Family> | string;

export function tagFamily<const Family extends string>(family: Family): TagFamily<Family> {
  if (family.length === 0) throw new DomainAuthoringError("TAG_FAMILY_INVALID", "Tag family must not be empty");
  const make = (value: string): Tag<Family> => {
    if (value.length === 0) throw new DomainAuthoringError("TAG_VALUE_INVALID", "Tag value must not be empty");
    const id = `${family}:${value}`;
    return Object.freeze({
      family,
      group: family,
      value,
      content: value,
      id,
      tag: id,
    }) as Tag<Family>;
  };
  return Object.freeze({ family, group: family, of: make, create: make }) as TagFamily<Family>;
}

export function tag<const Family extends string>(family: Family): TagFamily<Family>;
export function tag<const Family extends string>(family: Family, value: string): Tag<Family>;
export function tag<const Family extends string>(family: Family, value?: string): TagFamily<Family> | Tag<Family> {
  const familyValue = tagFamily(family);
  return value === undefined ? familyValue : familyValue.of(value);
}

export const defineTag = tag;

export function normalizeTag<Family extends string = string>(input: TagInput<Family>): Tag<Family> {
  if (typeof input === "string") {
    const separator = input.indexOf(":");
    if (separator <= 0 || separator === input.length - 1) {
      throw new DomainAuthoringError("TAG_INVALID", "A tag string must be family:value");
    }
    return tagFamily(input.slice(0, separator)).of(input.slice(separator + 1)) as Tag<Family>;
  }
  if (input.id.length === 0 || input.family.length === 0 || input.value.length === 0) {
    throw new DomainAuthoringError("TAG_INVALID", "Tag family, value, and id are required");
  }
  return input;
}

export type TagDeriver<Payload> = (payload: Payload) => readonly Tag[];
export type TagDeriverResult<Deriver> = Deriver extends (...args: never[]) => infer Result ? Result : never;
export type TagFamilyOf<Values> = Values extends readonly (infer Item)[]
  ? Item extends Tag<infer Family> ? Family : never
  : never;
export type TagFamilyOfDeriver<Deriver> = TagFamilyOf<TagDeriverResult<Deriver>> extends never
  ? string
  : TagFamilyOf<TagDeriverResult<Deriver>>;

export interface EventRecord<Payload = unknown, Family extends string = string> {
  readonly eventType: string;
  readonly eventName: string;
  readonly payload: Payload;
  readonly tags: readonly Tag<Family>[];
  readonly ordinal: string;
}

export type EventPayload<Event extends { readonly schema: z.ZodTypeAny }> =
  z.infer<Event["schema"]> & { readonly [eventPayloadBrand]: Event };

export type EventOf<Event extends { readonly schema: z.ZodTypeAny }> = EventPayload<Event>;

export type ParsedAt<Boundary extends DomainBoundary, Value> = Value & {
  readonly [parsedBoundaryBrand]: Boundary;
};

export type RejectKind =
  | "validation"
  | "not-found"
  | "conflict"
  | "forbidden"
  | "invalid-state"
  | "internal";

export interface Reject<Kind extends RejectKind = RejectKind, Details = unknown> {
  readonly kind: "reject";
  readonly reason: string;
  readonly rejectKind: Kind;
  readonly code: string;
  readonly details?: Details;
  readonly [terminalDecisionBrand]: "reject";
}

export interface Done<Value extends JsonValue = JsonValue> {
  readonly kind: "done";
  readonly value?: Value;
  readonly [terminalDecisionBrand]: "done";
}

export interface None {
  readonly kind: "none";
  readonly reason?: string;
  readonly [terminalDecisionBrand]: "none";
}

export type TerminalDecision<Value extends JsonValue = JsonValue> = Done<Value> | None | Reject;

export const V1_REJECT_ERROR_CODES: Readonly<Record<RejectKind, string>> = Object.freeze({
  validation: "validation_error",
  "not-found": "not_found",
  conflict: "consistency_conflict",
  forbidden: "forbidden",
  "invalid-state": "invalid_state",
  internal: "internal_error",
});

export type FixedNow = string | number | bigint;

export interface TimeProvider {
  readonly now: () => FixedNow;
}

export interface PortableSnapshot<State = unknown> {
  readonly projectorId: string;
  readonly tag: Tag;
  readonly head: string | null;
  readonly state: State;
  readonly exists: boolean;
}

export interface ReadClaim {
  readonly kind: "state" | "exists";
  readonly projectorId?: string;
  readonly tag: Tag;
  readonly head: string | null;
}

export interface ReadSet {
  readonly claims: readonly ReadClaimDeclaration[];
  readonly tags: readonly Tag[];
  readonly has: (kind: ReadClaimDeclaration["kind"], projectorId: string | undefined, tag: Tag) => boolean;
}

export interface ReadClaimDeclaration {
  readonly kind: "state" | "exists";
  readonly projectorId?: string;
  readonly projector?: ProjectorLike;
  readonly tag: Tag;
}

export interface CommitCandidateEvent {
  readonly eventType: string;
  readonly eventName: string;
  readonly payload: unknown;
  readonly tags: readonly Tag[];
  readonly ordinal: string;
}

export interface DecisionLog {
  readonly now: FixedNow;
  readonly events: readonly CommitCandidateEvent[];
  readonly readClaims: readonly ReadClaim[];
  readonly terminal: TerminalDecision;
}

export interface CandidateEnvelope {
  readonly kind: "candidate-envelope";
  readonly now: FixedNow;
  readonly events: readonly CommitCandidateEvent[];
  readonly tags: readonly Tag[];
  readonly readClaims: readonly ReadClaim[];
  readonly decision: Done;
}

export interface SnapshotReader {
  readonly read: (projector: ProjectorLike, tag: Tag) => Promise<PortableSnapshot> | PortableSnapshot;
  readonly exists?: (tag: Tag) => Promise<boolean> | boolean;
  /** Optional exact head for exists-only reads; null is the assert-empty head. */
  readonly head?: (tag: Tag) => Promise<string | null> | string | null;
}

export interface ProjectorLike {
  readonly id: string;
  readonly version: number;
  readonly tag: TagFamily;
  readonly initialState: unknown | (() => unknown);
  readonly subscribes: (eventType: string) => boolean;
  readonly apply: (state: never, event: EventRecord) => unknown;
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every(isJsonValue);
}

export function assertJsonValue(value: unknown, boundary = "value"): JsonValue {
  if (!isJsonValue(value)) throw new DomainAuthoringError("INVALID_JSON_VALUE", `Value was not JSON serializable at ${boundary}`);
  return value;
}

export function cloneAndFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(cloneAndFreeze);
    return Object.freeze(value);
  }
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(cloneAndFreeze);
    return Object.freeze(value);
  }
  return value;
}
