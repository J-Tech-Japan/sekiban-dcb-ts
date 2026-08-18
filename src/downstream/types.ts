/** A queue payload is intentionally an internal envelope, never part of V1. */
export interface DownstreamOutboxMessage {
  version: 1;
  serviceId: string;
  tag: string;
  attemptId: string;
  eventId: string;
  suid: string;
  payload: string;
  /** The complete set of tag-side copies expected for this event. */
  eventTags: string[];
  /** Durable outbox clock fact, set before the first queue send attempt. */
  enqueuedAt: number;
}

export interface OutboxDeliveryIdentity {
  attemptId: string;
  eventId: string;
  suid: string;
  payload: string;
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
  return [message.attemptId, message.eventId, message.suid, message.payload].join("\u0000");
}

export function isDownstreamOutboxMessage(value: unknown): value is DownstreamOutboxMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 &&
    typeof candidate.serviceId === "string" && candidate.serviceId.length > 0 &&
    typeof candidate.tag === "string" && candidate.tag.length > 0 &&
    typeof candidate.attemptId === "string" && candidate.attemptId.length > 0 &&
    typeof candidate.eventId === "string" && candidate.eventId.length > 0 &&
    typeof candidate.suid === "string" && candidate.suid.length > 0 &&
    typeof candidate.payload === "string" &&
    Array.isArray(candidate.eventTags) && candidate.eventTags.every((tag) => typeof tag === "string" && tag.length > 0) &&
    new Set(candidate.eventTags).size === candidate.eventTags.length && candidate.eventTags.includes(candidate.tag) &&
    typeof candidate.enqueuedAt === "number" && Number.isSafeInteger(candidate.enqueuedAt);
}
