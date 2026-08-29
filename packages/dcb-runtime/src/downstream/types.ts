import { parseCanonicalEventKey } from "@sekiban/dcb-core";
import { isSortableUniqueId } from "../allocator/SortableUniqueId";
import { CANONICAL_UTC_TIMESTAMP_PATTERN, isUuidV7, serializedEventMetadata } from "../eventRecord";

/** A queue payload is intentionally an internal envelope, never part of V1. */
/**
 * `import` is a direct, operator-owned C# record import. It never traverses
 * Queue or doorbell, where a newly authored event must always be UUID v7.
 */
export type DeliverySource = "queue" | "fast" | "import";
/** G32 has no legacy delivery lane. Every durable envelope is explicitly g32. */
export type DeliveryProvenance = "g32";

/** One tag-local committed-membership fact carried by a G43 obligation. */
export interface OutboxCommittedMembership {
  readonly serviceId: string;
  readonly eventId: string;
  readonly tag: string;
}

/**
 * Source-authoritative facts required to turn a transport handoff into a
 * global-array receipt.  `canonicalBytesBase64` is the exact G43 digest
 * preimage, not a projection-derived reconstruction.
 */
export interface OutboxCompletenessFacts {
  readonly canonicalBytesBase64: string;
  readonly eventDigest: string;
  readonly declaredTagSet: readonly string[];
  readonly localCommittedMembership: readonly OutboxCommittedMembership[];
  /** Local to the source Tag DO; never treated as a global sequence. */
  readonly obligationSequence: number;
}

export interface DownstreamOutboxMessage {
  version: 1;
  serviceId: string;
  /** Stable identity of the allocator DO lineage that issued this delivery. */
  allocatorLineageId: string;
  tag: string;
  attemptId: string;
  eventId: string;
  suid: string;
  payload: string;
  /** UTC write-time timestamp carried with the exact event payload. */
  timestamp: string;
  /** Nullable only on the fenced C# import lane; normal delivery is exact constants. */
  causationId: string | null;
  correlationId: string | null;
  executedUser: string | null;
  /** The complete set of tag-side copies expected for this event. */
  eventTags: string[];
  /** Durable C# EventType = eventPayloadName. */
  eventType: string;
  provenance: DeliveryProvenance;
  /** Durable outbox clock fact, set before the first queue send attempt. */
  enqueuedAt: number;
  /** G43 source facts; required before the global array can acknowledge. */
  completeness: OutboxCompletenessFacts;
}

export interface OutboxDeliveryIdentity {
  attemptId: string;
  eventId: string;
  suid: string;
  allocatorLineageId: string;
  payload: string;
  eventType: string;
  provenance: DeliveryProvenance;
  timestamp: string;
  causationId: string | null;
  correlationId: string | null;
  executedUser: string | null;
  completeness: Pick<OutboxCompletenessFacts, "eventDigest" | "obligationSequence">;
}

export interface OutboxDelivery extends OutboxDeliveryIdentity {
  enqueuedAt: number;
  deliveredAt: number | null;
}

export interface PipelineClock {
  now(): number;
}

export const systemPipelineClock: PipelineClock = {
  now: () => Date.now(),
};

export function outboxIdentity(message: OutboxDeliveryIdentity): string {
  return [message.attemptId, message.eventId, message.suid, message.allocatorLineageId, message.payload, message.eventType, message.provenance, message.timestamp ?? "", message.causationId ?? "", message.correlationId ?? "", message.executedUser ?? "", message.completeness.eventDigest, String(message.completeness.obligationSequence)].join("\u0000");
}

function isCommittedMembership(value: unknown, candidate: Record<string, unknown>): value is OutboxCommittedMembership {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const membership = value as Record<string, unknown>;
  return membership.serviceId === candidate.serviceId &&
    membership.eventId === candidate.eventId &&
    typeof membership.tag === "string" && membership.tag.length > 0;
}

function isCompletenessFacts(value: unknown, candidate: Record<string, unknown>): value is OutboxCompletenessFacts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const facts = value as Record<string, unknown>;
  return typeof facts.canonicalBytesBase64 === "string" && facts.canonicalBytesBase64.length > 0 &&
    typeof facts.eventDigest === "string" && /^[0-9a-f]{64}$/.test(facts.eventDigest) &&
    Array.isArray(facts.declaredTagSet) && facts.declaredTagSet.length > 0 &&
    facts.declaredTagSet.every((tag) => typeof tag === "string" && tag.length > 0) &&
    new Set(facts.declaredTagSet).size === facts.declaredTagSet.length &&
    Array.isArray(facts.localCommittedMembership) && facts.localCommittedMembership.length === 1 &&
    facts.localCommittedMembership.every((membership) => isCommittedMembership(membership, candidate)) &&
    facts.localCommittedMembership[0] !== undefined &&
    (facts.localCommittedMembership[0] as OutboxCommittedMembership).tag === candidate.tag &&
    Number.isSafeInteger(facts.obligationSequence) && (facts.obligationSequence as number) > 0;
}

export function isDownstreamOutboxMessage(value: unknown): value is DownstreamOutboxMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.eventType !== "string" || candidate.eventType.length === 0 || candidate.provenance !== "g32") return false;
  try {
    parseCanonicalEventKey(candidate.eventType);
  } catch {
    return false;
  }
  const metadata = typeof candidate.eventId === "string" ? serializedEventMetadata(candidate.eventId) : undefined;
  return candidate.version === 1 &&
    typeof candidate.serviceId === "string" && candidate.serviceId.length > 0 &&
    typeof candidate.allocatorLineageId === "string" && candidate.allocatorLineageId.length > 0 &&
    typeof candidate.tag === "string" && candidate.tag.length > 0 &&
    typeof candidate.attemptId === "string" && candidate.attemptId.length > 0 &&
    isUuidV7(candidate.eventId) &&
    isSortableUniqueId(candidate.suid) &&
    typeof candidate.payload === "string" &&
    Array.isArray(candidate.eventTags) && candidate.eventTags.every((tag) => typeof tag === "string" && tag.length > 0) &&
    new Set(candidate.eventTags).size === candidate.eventTags.length && candidate.eventTags.includes(candidate.tag) &&
    typeof candidate.timestamp === "string" && CANONICAL_UTC_TIMESTAMP_PATTERN.test(candidate.timestamp) &&
    candidate.causationId === metadata?.causationId &&
    candidate.correlationId === metadata?.correlationId &&
    candidate.executedUser === metadata?.executedUser &&
    typeof candidate.enqueuedAt === "number" && Number.isSafeInteger(candidate.enqueuedAt) &&
    candidate.provenance === "g32" &&
    isCompletenessFacts(candidate.completeness, candidate);
}
