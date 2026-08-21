import { canonicalEventKey, parseCanonicalEventKey, type CanonicalEventIdentity } from "@sekiban/dcb-core";
import type { DeliverySource } from "./downstream/types";

export type EventProvenance = "pre-g27" | "g27";
export type DeliveryProvenance = EventProvenance | "pre-g27-queue";

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
    super(`Post-G27 ${source} delivery is missing canonical event identity`);
    this.name = "MissingCanonicalEventIdentityError";
  }
}

export interface ResolvedDeliveryIdentity extends CanonicalEventIdentity {
  readonly provenance: EventProvenance;
  readonly legacy: boolean;
}

export function canonicalEventType(eventPayloadName: string, version = 1): string {
  return canonicalEventKey(eventPayloadName, version);
}

function provenanceFrom(value: unknown): DeliveryProvenance | undefined {
  if (value === undefined) return undefined;
  if (value === "g27" || value === "pre-g27" || value === "pre-g27-queue") return value;
  throw new DeliveryIdentityError("Unknown event identity provenance");
}

/**
 * Resolve identity at the delivery admission boundary.  The only permitted
 * legacy escape hatch is an explicitly queue-shaped pre-G27 envelope; no
 * payload discriminator is consulted here or downstream.
 */
export function resolveDeliveryIdentity(
  message: { readonly eventType?: string; readonly provenance?: DeliveryProvenance | EventProvenance },
  source: DeliverySource,
): ResolvedDeliveryIdentity {
  const provenance = provenanceFrom(message.provenance);
  if (message.eventType !== undefined) {
    const identity = parseCanonicalEventKey(message.eventType);
    if (provenance !== undefined && provenance !== "g27") {
      throw new DeliveryIdentityError("Canonical event identity requires g27 provenance");
    }
    return {
      ...identity,
      provenance: "g27",
      legacy: false,
    };
  }
  if (source === "fast" || provenance === "g27" || (provenance !== "pre-g27-queue" && provenance !== "pre-g27")) {
    throw new MissingCanonicalEventIdentityError(source);
  }
  return {
    eventPayloadName: "__legacy__",
    version: 1,
    key: "__legacy__:1",
    provenance: "pre-g27",
    legacy: true,
  };
}

export function assertCanonicalEventType(value: string): CanonicalEventIdentity {
  return parseCanonicalEventKey(value);
}
