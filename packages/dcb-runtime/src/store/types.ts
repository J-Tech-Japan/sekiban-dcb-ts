import type { DownstreamOutboxMessage } from "../downstream/types";

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
  eventId: string;
  suid: string;
  payload: string;
  /** Complete durable tag membership, retained from the outbox envelope. */
  eventTags: string[];
  firstArrivedAt: number;
  lastArrivedAt: number;
  maxDeliveryLagMs: number;
  arrivals: DeliveryLagRecord[];
}

export const DELIVERY_INCIDENT_CLASSIFICATIONS = [
  "SUID_COLLISION",
  "ORDER_VIOLATION",
  "LINEAGE_MISMATCH",
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
  | { outcome: "stored"; kind: "stored"; event: StoredEvent }
  | { outcome: "suid-collision"; kind: "suid-collision"; incident: DeliveryIncident }
  | { outcome: "lineage-mismatch"; kind: "lineage-mismatch"; incident: DeliveryIncident };

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
  recordDelivery(message: DownstreamOutboxMessage, arrivedAt: number): Promise<DeliveryOutcome>;
  readAllEvents(serviceId: string, since: string): Promise<StoredEvent[]>;
  currentLagBound(serviceId: string, nowMs?: number): Promise<number>;
  /** Cosmos uses this optional retryable async landing projection. */
  projectDeliveryIncidents?(serviceId?: string): Promise<number>;
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
  currentLagBound(serviceId: string, nowMs?: number): Promise<number>;
  listProjectionTags(serviceId: string): Promise<string[]>;
  readProjectionCheckpoint(serviceId: string, projectionId: string): Promise<ProjectionCheckpoint | undefined>;
  advanceProjectionCheckpoint(input: ProjectionCheckpointAdvance): Promise<boolean>;
  projectionLag(serviceId: string, projectionId: string, tag: string): Promise<ProjectionLag>;
  /** Catch-up must persist an ORDER_VIOLATION before failing closed. */
  appendDeliveryIncident(incident: DeliveryIncident): Promise<void>;
}

export type PipelineStore = EventStore & DetectorStore & ProjectionStore;
