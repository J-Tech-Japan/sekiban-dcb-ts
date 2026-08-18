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
  firstArrivedAt: number;
  lastArrivedAt: number;
  maxDeliveryLagMs: number;
  arrivals: DeliveryLagRecord[];
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
  recordDelivery(message: DownstreamOutboxMessage, arrivedAt: number): Promise<StoredEvent>;
  readAllEvents(serviceId: string, since: string): Promise<StoredEvent[]>;
  currentLagBound(serviceId: string): Promise<number>;
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
}

export type PipelineStore = EventStore & DetectorStore;
