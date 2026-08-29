import {
  DOTNET_UNIX_EPOCH_TICKS,
  formatSortableUniqueId,
  isSortableUniqueId,
} from "../../packages/dcb-runtime/src/allocator/SortableUniqueId";
import { isUuidV7, serializedEventMetadata } from "../../packages/dcb-runtime/src/eventRecord";
import type { DownstreamOutboxMessage } from "../../packages/dcb-runtime/src/downstream/types";
import type { StoredEvent } from "../../packages/dcb-runtime/src/store/types";

/**
 * Deterministic, valid G32 fixture values. They deliberately do not use the
 * production allocator or UUID generator: test inputs must not manufacture
 * their expected values through the code under test.
 */
function hash64(seed: string): bigint {
  let value = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(seed)) {
    value ^= BigInt(byte);
    value = BigInt.asUintN(64, value * 0x100000001b3n);
  }
  return value;
}

function trailingOrdinal(seed: string): bigint | undefined {
  const match = /(?:^|[^0-9])([0-9]+)$/.exec(seed);
  if (match?.[1] === undefined) return undefined;
  try { return BigInt(match[1]); } catch { return undefined; }
}

/** A 30-digit SortableUniqueId that keeps explicit numeric fixture order. */
export function g32Suid(seed: string | number): string {
  const text = String(seed);
  if (isSortableUniqueId(text)) return text;
  const hash = hash64(text);
  const ordinal = trailingOrdinal(text) ?? (hash >> 11n);
  // Keep fixture events close to the Unix epoch while leaving a wide stable
  // ordinal band for hand-written ordering tests.
  const ticks = DOTNET_UNIX_EPOCH_TICKS + (ordinal % 1_000_000_000n);
  return formatSortableUniqueId(ticks, hash % 100_000_000_000n);
}

/** A fixture SUID whose 19-digit tick segment represents a chosen Unix ms. */
export function g32SuidAt(unixMs: number, seed: string | number = unixMs): string {
  if (!Number.isSafeInteger(unixMs) || unixMs < 0) {
    throw new Error("G32 fixture SUID clock must be a non-negative safe integer");
  }
  const text = String(seed);
  const hash = hash64(text);
  const ordinal = trailingOrdinal(text) ?? hash;
  return formatSortableUniqueId(
    DOTNET_UNIX_EPOCH_TICKS + BigInt(unixMs) * 10_000n,
    ordinal % 100_000_000_000n,
  );
}

/** A deterministic lowercase UUID v7 for an arbitrary old fixture label. */
export function g32EventId(seed: string): string {
  if (isUuidV7(seed)) return seed;
  const high = hash64(`high:${seed}`);
  const low = hash64(`low:${seed}`);
  const bytes = new Uint8Array(16);
  let timestamp = high & 0xffff_ffff_ffffn;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = 0x70 | Number((high >> 48n) & 0x0fn);
  bytes[7] = Number((high >> 56n) & 0xffn);
  bytes[8] = 0x80 | Number((low >> 58n) & 0x3fn);
  for (let index = 9; index < bytes.length; index += 1) {
    bytes[index] = Number((low >> BigInt((index - 9) * 8)) & 0xffn);
  }
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const G32_FIXTURE_TIMESTAMP = "2026-08-22T17:00:00.123Z";

function fixtureDigest(seed: string): string {
  return ["a", "b", "c", "d"].map((prefix) => hash64(`${prefix}:${seed}`).toString(16).padStart(16, "0")).join("");
}

function fixtureBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Rebuild source-owned G44 facts after a fixture deliberately changes an
 * envelope identity. This is test data construction, not the production
 * digest implementation (which remains Tag EventDigest).
 */
export function withG44FixtureFacts(
  message: Omit<DownstreamOutboxMessage, "completeness">,
  obligationSequence?: number,
): DownstreamOutboxMessage {
  const declaredTagSet = [...message.eventTags].sort();
  return {
    ...message,
    completeness: {
      canonicalBytesBase64: fixtureBase64(JSON.stringify({
        eventId: message.eventId,
        payload: message.payload,
        eventTags: message.eventTags,
        eventType: message.eventType,
        timestamp: message.timestamp,
        allocatorLineageId: message.allocatorLineageId,
        attemptId: message.attemptId,
        suid: message.suid,
      })),
      eventDigest: fixtureDigest(`${message.serviceId}:${message.eventId}:${message.tag}:${message.attemptId}`),
      declaredTagSet,
      localCommittedMembership: [{ serviceId: message.serviceId, eventId: message.eventId, tag: message.tag }],
      obligationSequence: obligationSequence ?? Number(hash64(`g44-obligation:${message.serviceId}:${message.tag}:${message.eventId}`) % 1_000_000_000n) + 1,
    },
  };
}

/** Normalizes a direct-delivery fixture into the complete G32 envelope. */
export function g32Message(input: {
  readonly serviceId: string;
  readonly tag: string;
  readonly attemptId?: string;
  readonly eventId: string;
  readonly suid: string;
  readonly payload?: string;
  readonly eventTags?: readonly string[];
  readonly eventType?: string;
  readonly allocatorLineageId?: string;
  readonly enqueuedAt?: number;
  readonly timestamp?: string;
  readonly obligationSequence?: number;
}): DownstreamOutboxMessage {
  const eventId = g32EventId(input.eventId);
  const metadata = serializedEventMetadata(eventId);
  const eventTags = [...(input.eventTags ?? [input.tag])];
  const payload = input.payload !== undefined && (() => {
    try { JSON.parse(input.payload); return true; } catch { return false; }
  })() ? input.payload : JSON.stringify({ fixture: input.payload ?? input.eventId });
  const attemptId = input.attemptId ?? `g32-attempt:${input.eventId}`;
  const suid = g32Suid(input.suid);
  const eventType = input.eventType ?? "FixtureEvent";
  const timestamp = input.timestamp ?? G32_FIXTURE_TIMESTAMP;
  const allocatorLineageId = input.allocatorLineageId ?? "g32-test-lineage";
  return withG44FixtureFacts({
    version: 1,
    serviceId: input.serviceId,
    allocatorLineageId,
    tag: input.tag,
    attemptId,
    eventId,
    suid,
    payload,
    eventTags,
    eventType,
    provenance: "g32",
    timestamp,
    causationId: metadata.causationId,
    correlationId: metadata.correlationId,
    executedUser: metadata.executedUser,
    enqueuedAt: input.enqueuedAt ?? 1_000,
  }, input.obligationSequence);
}

/** Complete C#-logical StoredEvent fixture derived from a valid G32 envelope. */
export function g32StoredEvent(input: DownstreamOutboxMessage, arrivedAt = input.enqueuedAt): StoredEvent {
  return {
    serviceId: input.serviceId,
    id: input.eventId,
    eventId: input.eventId,
    sortableUniqueId: input.suid,
    suid: input.suid,
    payload: input.payload,
    tags: [...input.eventTags],
    eventTags: [...input.eventTags],
    eventType: input.eventType,
    timestamp: input.timestamp,
    causationId: input.causationId,
    correlationId: input.correlationId,
    executedUser: input.executedUser,
    provenance: "g32",
    firstArrivedAt: arrivedAt,
    lastArrivedAt: arrivedAt,
    maxDeliveryLagMs: Math.max(0, arrivedAt - input.enqueuedAt),
    arrivals: [],
  };
}
