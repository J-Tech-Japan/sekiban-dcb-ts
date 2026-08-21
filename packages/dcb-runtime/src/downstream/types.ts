import { parseCanonicalEventKey } from "@sekiban/dcb-core";

/** A queue payload is intentionally an internal envelope, never part of V1. */
export const LEGACY_ALLOCATOR_LINEAGE_ID = "legacy-pre-g17" as const;
export type DeliverySource = "queue" | "fast";
export type DeliveryProvenance = "g27" | "pre-g27-queue";
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
  /** The complete set of tag-side copies expected for this event. */
  eventTags: string[];
  /** Canonical eventPayloadName:version identity; absent only on legacy queue lane. */
  eventType?: string;
  /** Provenance proves whether the legacy compatibility lane is allowed. */
  provenance?: DeliveryProvenance;
  /** Durable outbox clock fact, set before the first queue send attempt. */
  enqueuedAt: number;
}

export interface OutboxDeliveryIdentity {
  attemptId: string;
  eventId: string;
  suid: string;
  payload: string;
  eventType?: string;
  provenance?: DeliveryProvenance;
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
  return [message.attemptId, message.eventId, message.suid, message.payload, message.eventType ?? "", message.provenance ?? ""].join("\u0000");
}

export function isDownstreamOutboxMessage(value: unknown): value is DownstreamOutboxMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.eventType !== undefined) {
    if (typeof candidate.eventType !== "string" || candidate.eventType.length === 0) return false;
    if (candidate.provenance !== undefined && candidate.provenance !== "g27") return false;
    try {
      parseCanonicalEventKey(candidate.eventType);
    } catch {
      return false;
    }
  }
  if (candidate.eventType === undefined && candidate.provenance === "g27") return false;
  return candidate.version === 1 &&
    typeof candidate.serviceId === "string" && candidate.serviceId.length > 0 &&
    typeof candidate.allocatorLineageId === "string" && candidate.allocatorLineageId.length > 0 &&
    typeof candidate.tag === "string" && candidate.tag.length > 0 &&
    typeof candidate.attemptId === "string" && candidate.attemptId.length > 0 &&
    typeof candidate.eventId === "string" && candidate.eventId.length > 0 &&
    typeof candidate.suid === "string" && candidate.suid.length > 0 &&
    typeof candidate.payload === "string" &&
    Array.isArray(candidate.eventTags) && candidate.eventTags.every((tag) => typeof tag === "string" && tag.length > 0) &&
    new Set(candidate.eventTags).size === candidate.eventTags.length && candidate.eventTags.includes(candidate.tag) &&
    typeof candidate.enqueuedAt === "number" && Number.isSafeInteger(candidate.enqueuedAt) &&
    (candidate.eventType === undefined || (typeof candidate.eventType === "string" && candidate.eventType.length > 0)) &&
    (candidate.provenance === undefined || candidate.provenance === "g27" || candidate.provenance === "pre-g27-queue");
}
