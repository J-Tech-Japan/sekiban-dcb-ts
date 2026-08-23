import { canonicalEventKey, parseCanonicalEventKey, type CanonicalEventIdentity } from "@sekiban/dcb-core";
import type { DeliverySource } from "./downstream/types";

/** G32 has one durable delivery format; legacy lanes are deliberately gone. */
export type EventProvenance = "g32";
export type DeliveryProvenance = "g32";

export class DeliveryIdentityError extends Error {
  readonly code: string = "DELIVERY_IDENTITY_INVALID";
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "DeliveryIdentityError";
  }
}

export class MissingCanonicalEventIdentityError extends DeliveryIdentityError {
  readonly code = "MISSING_CANONICAL_EVENT_IDENTITY" as const;

  constructor(source: DeliverySource) {
    super(`G32 ${source} delivery is missing canonical event identity`);
    this.name = "MissingCanonicalEventIdentityError";
  }
}

export interface ResolvedDeliveryIdentity extends CanonicalEventIdentity {
  readonly provenance: "g32";
  /** Compatibility shape only; it is always false for an admitted G32 row. */
  readonly legacy: false;
}

export function canonicalEventType(eventPayloadName: string): string {
  return canonicalEventKey(eventPayloadName);
}

function provenanceFrom(value: unknown): DeliveryProvenance | undefined {
  if (value === undefined) return undefined;
  if (value === "g32") return value;
  throw new DeliveryIdentityError("Unknown event identity provenance");
}

/**
 * Resolve identity at the delivery admission boundary. A G32 delivery has a
 * durable EventType equal to eventPayloadName; no payload discriminator or
 * historical compatibility lane is permitted.
 */
export function resolveDeliveryIdentity(
  message: { readonly eventType?: string; readonly provenance?: DeliveryProvenance | EventProvenance },
  source: DeliverySource,
): ResolvedDeliveryIdentity {
  const provenance = provenanceFrom(message.provenance);
  if (message.eventType === undefined) {
    throw new MissingCanonicalEventIdentityError(source);
  }
  const identity = parseCanonicalEventKey(message.eventType);
  if (provenance !== "g32") {
    throw new DeliveryIdentityError("G32 delivery provenance is required");
  }
  return {
    ...identity,
    provenance: "g32",
    legacy: false,
  };
}

export function assertCanonicalEventType(value: string): CanonicalEventIdentity {
  return parseCanonicalEventKey(value);
}
