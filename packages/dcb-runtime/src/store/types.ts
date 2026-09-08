import type { DeliverySource, DownstreamOutboxMessage } from "../downstream/types";
import type { EventProvenance } from "../eventIdentity";

/** A provider must reject canonical-key-only identity divergence before any durable write. */
export class CanonicalEventIdentityConflictError extends Error {
  readonly code: string = "CANONICAL_EVENT_IDENTITY_CONFLICT";

  constructor(readonly provider: string, readonly eventId: string, message?: string) {
    super(message ?? `${provider} EventId ${eventId} conflicts with its canonical event identity`);
    this.name = "CanonicalEventIdentityConflictError";
  }
}

export interface DeliveryLagRecord {
  serviceId: string;
  eventId: string;
  tag: string;
  enqueuedAt: number;
  arrivedAt: number;
  lagMs: number;
}

export interface StoredEvent {
  serviceId: string;
  /** C# logical-record Id; eventId remains the runtime alias. */
  id: string;
  eventId: string;
  /** C# logical-record SortableUniqueId; suid remains the runtime alias. */
  sortableUniqueId: string;
  suid: string;
  /** Byte-identical decoded UTF-8 JSON text. */
  payload: string;
  /** C# logical-record Tags in source emission order. */
  tags: string[];
  /** Complete durable tag membership, retained from the outbox envelope. */
  eventTags: string[];
  /** C# durable EventType = eventPayloadName. */
  eventType: string;
  timestamp: string;
  /** C# DbEvent keeps serialized metadata nullable for imported historical rows. */
  causationId: string | null;
  correlationId: string | null;
  executedUser: string | null;
  /** G32 internal provenance; it is never persisted in dcb_events. */
  provenance: EventProvenance;
  /** G43 source digest retained by the global receipt authority when present. */
  eventDigest?: string;
  firstArrivedAt: number;
  lastArrivedAt: number;
  maxDeliveryLagMs: number;
  arrivals: DeliveryLagRecord[];
}

/** Per-invocation diagnostic ownership; never part of admission semantics. */
export interface DeliveryAttemptContext {
  /** The platform Queue wrapper identity, when the caller has one. */
  readonly queueMessageId?: string | null;
  /** Registers diagnostic work with the current invocation lifetime. */
  readonly waitUntil?: (promise: Promise<void>) => void;
}

export const DELIVERY_INCIDENT_CLASSIFICATIONS = [
  "SUID_COLLISION",
  "ORDER_VIOLATION",
  "LINEAGE_MISMATCH",
  "ORDERING_DETECTOR_UNKNOWN",
] as const;

export type DeliveryIncidentClassification = (typeof DELIVERY_INCIDENT_CLASSIFICATIONS)[number];

/** A durable, idempotent fact for a poisoned delivery or provider ordering defect. */
export interface DeliveryIncident {
  serviceId: string;
  identityKey: string;
  classification: DeliveryIncidentClassification;
  suid?: string;
  existingEventId?: string;
  incomingEventId?: string;
  eventId?: string;
  boundLineageId?: string;
  incomingLineageId?: string;
  observedAt: number;
}

export type DeliveryOutcome =
  | { outcome: "stored"; kind: "stored"; event: StoredEvent; duplicate?: boolean }
  | { outcome: "suid-collision"; kind: "suid-collision"; incident: DeliveryIncident }
  | { outcome: "lineage-mismatch"; kind: "lineage-mismatch"; incident: DeliveryIncident };

/** A receipt is useful only when this complete event/membership join matches. */
export interface GlobalReceiptJoin {
  readonly serviceId: string;
  readonly eventId: string;
  readonly partitionTag: string;
  readonly obligationSequence: number;
  readonly eventDigest: string;
  readonly membershipTag: string;
  readonly receivedAt: number;
}

/**
 * A projection checkpoint stores both its opaque projector state and its
 * source SUID position. They advance atomically so a restarted poller cannot
 * double-apply an event that was already reflected in durable state.
 */
export interface ProjectionCheckpoint {
  serviceId: string;
  projectionId: string;
  lastSuid: string;
  stateJson: string;
  version: number;
  updatedAt: number;
}

export interface ProjectionCheckpointAdvance {
  serviceId: string;
  projectionId: string;
  /** Null means this is the first checkpoint for the projection. */
  expectedLastSuid: string | null;
  lastSuid: string;
  stateJson: string;
  version: number;
  updatedAt: number;
}

export interface ProjectionLag {
  serviceId: string;
  projectionId: string;
  tag: string;
  checkpointSuid: string;
  headSuid: string;
  behindEvents: number;
}

export interface PendingArrivalRecord {
  serviceId: string;
  attemptId: string;
  eventId: string;
  suid: string;
  expectedPaths: string[];
  observedPaths: string[];
  firstObservedAt: number;
  lagBoundMs: number;
}

export type InconsistencyClassification = "MISSING_STABLE" | "EXCLUDED_AUDITED" | "RESOLVED_LATE";

export interface InconsistencyFinding {
  serviceId: string;
  eventId: string;
  path: string;
  classification: InconsistencyClassification;
  firstObservedAt: number;
  lagBoundMs: number;
  observedAt: number;
}

/** Adapter-only persistence port. The detector deliberately does not receive it. */
export interface EventStore {
  initialize(): Promise<void>;
  recordDelivery(
    message: DownstreamOutboxMessage,
    arrivedAt: number,
    deliverySource?: DeliverySource,
    attemptContext?: DeliveryAttemptContext,
  ): Promise<DeliveryOutcome>;
  readAllEvents(serviceId: string, since: string): Promise<StoredEvent[]>;
  currentLagBound(serviceId: string, nowMs?: number): Promise<number>;
  /** Conformance-only read diagnostic; production callers must not use it. */
  lagBoundDiagnostics?(serviceId: string, nowMs: number): Promise<{
    serviceIdUsed: string;
    dynamicLagBoundMs: number;
    rowFound: boolean;
    rawEstimateMs: number | null;
    rawObservedAt: number | null;
    nowMs: number;
  }>;
  /** Cosmos uses this optional retryable async landing projection. */
  projectDeliveryIncidents?(serviceId?: string): Promise<number>;
  /**
   * G44 source acknowledgement must be based on this read-back join, never
   * on a transport acknowledgement or a receipt row by itself.
   */
  readGlobalReceiptJoin?(message: DownstreamOutboxMessage): Promise<GlobalReceiptJoin | undefined>;
}

/** Detector-only persistence port. It cannot write event rows by construction. */
export interface DetectorStore {
  upsertPending(
    message: DownstreamOutboxMessage,
    firstObservedAt: number,
    lagBoundMs: number,
  ): Promise<PendingArrivalRecord>;
  listPending(serviceId?: string): Promise<PendingArrivalRecord[]>;
  appendFinding(finding: InconsistencyFinding): Promise<void>;
  hasFinding(
    serviceId: string,
    eventId: string,
    path: string,
    classification: InconsistencyClassification,
  ): Promise<boolean>;
  listFindings(serviceId?: string, eventId?: string): Promise<InconsistencyFinding[]>;
  appendDeliveryIncident(incident: DeliveryIncident): Promise<void>;
  hasDeliveryIncident(serviceId: string, identityKey: string): Promise<boolean>;
  listDeliveryIncidents(serviceId?: string): Promise<DeliveryIncident[]>;
}

/**
 * Read-only event consumption plus durable checkpoint operations. This port
 * intentionally omits recordDelivery, keeping SafeWindow projection unable to
 * write event data by construction.
 */
export interface ProjectionStore {
  readAllEvents(serviceId: string, since: string): Promise<StoredEvent[]>;
  /** Optional D1-backed detector for a newly admitted lower SUID. */
  findLateLowerSuid?(serviceId: string, checkpointSuid: string, checkpointUpdatedAt: number): Promise<StoredEvent | undefined>;
  /** Structured detector result; unknown evidence must not become a refusal. */
  findLateLowerSuidEvidence?(serviceId: string, checkpointSuid: string, checkpointUpdatedAt: number, generation?: number): Promise<{
    readonly kind: "late-lower-suid" | "replay" | "miss" | "unknown";
    readonly event?: StoredEvent;
    readonly reason?: string;
  }>;
  currentLagBound(serviceId: string, nowMs?: number): Promise<number>;
  listProjectionTags(serviceId: string): Promise<string[]>;
  readProjectionCheckpoint(serviceId: string, projectionId: string): Promise<ProjectionCheckpoint | undefined>;
  advanceProjectionCheckpoint(input: ProjectionCheckpointAdvance): Promise<boolean>;
  projectionLag(serviceId: string, projectionId: string, tag: string): Promise<ProjectionLag>;
  /** Catch-up must persist an ORDER_VIOLATION before failing closed. */
  appendDeliveryIncident(incident: DeliveryIncident): Promise<void>;
}

export type PipelineStore = EventStore & DetectorStore & ProjectionStore;
