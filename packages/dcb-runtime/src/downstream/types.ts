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
  return [message.attemptId, message.eventId, message.suid, message.allocatorLineageId, message.payload, message.eventType, message.provenance, message.timestamp ?? "", message.causationId ?? "", message.correlationId ?? "", message.executedUser ?? ""].join("\u0000");
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
    candidate.provenance === "g32";
}
