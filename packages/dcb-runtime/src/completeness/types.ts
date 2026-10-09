import type { OutboxCommittedMembership } from "../downstream/types";

/** Fixed scanner identity; changing its semantics requires a new source build. */
export const G44_SCANNER_VERSION = "sdt-g44-global-completeness/v1";

export type GlobalCompletenessHealth = "HEALTHY" | "UNKNOWN" | "FAILED" | "STALE" | "BLOCK" | "UNSETTLED";

/** A health read is never inferred from the absence of a finding. */
export interface GlobalCompletenessHealthRecord {
  readonly serviceId: string;
  readonly scannerVersion: string;
  readonly status: GlobalCompletenessHealth;
  readonly cursorJson: string | null;
  /**
   * The high-water SUID from the most recent FULL source snapshot. It is
   * deliberately retained while a later scan is BLOCK/UNSETTLED so a safe
   * consumer can continue only through already-proven contiguous work.
   */
  readonly lastSettledFrontierSuid: string | null;
  readonly lastFullScanAt: number | null;
  readonly lastError: string | null;
  readonly updatedAt: number;
}

/** A deliberately conservative liveness bound for an otherwise idle scanner. */
export const G44_HEALTH_STALE_AFTER_MS = 5 * 60_000;

/** A vector cursor component: local obligation sequence is only tag-local. */
export interface SourcePartitionSnapshot {
  readonly serviceId: string;
  readonly tag: string;
  readonly upperBoundSequence: number;
}

/** Source-local fact returned by the Tag DO, independent of transport state. */
export interface SourceObligationFact {
  readonly obligationSequence: number;
  readonly eventId: string;
  readonly eventDigest: string;
  readonly canonicalBytesBase64: string;
  readonly declaredTagSet: readonly string[];
  readonly localCommittedMembership: readonly OutboxCommittedMembership[];
  readonly status: "pending" | "acknowledged" | "poison";
}

/** A bounded page within one fixed partition snapshot component. */
export interface SourceObligationPage {
  readonly serviceId: string;
  readonly tag: string;
  readonly upperBoundSequence: number;
  readonly observedMaxSequence: number;
  readonly afterSequence: number;
  readonly rows: readonly SourceObligationFact[];
  readonly hasMore: boolean;
}

export type GlobalCompletenessScanResult =
  | Readonly<{ kind: "FULL"; partitions: readonly SourcePartitionSnapshot[]; scannedObligations: number }>
  | Readonly<{ kind: "BLOCK"; partitions: readonly SourcePartitionSnapshot[]; findingCount: number }>
  | Readonly<{ kind: "UNKNOWN"; reason: string }>
  | Readonly<{ kind: "FAILED"; error: string }>;

export type IncidentLifecycleState =
  | "OPEN"
  | "ACKNOWLEDGED"
  | "CORRECTION_RECORDED"
  | "CLOSED"
  | "REOPENED";

export type IncidentCorrection = Readonly<{
  kind: "event" | "receipt";
  reference: string;
  digest: `sha256:${string}`;
}>;

export type IncidentCloseResolution =
  | Readonly<{ kind: "CORRECTED" }>
  | Readonly<{ kind: "ACCEPTED_AS_IS"; explanation: string }>;

export interface IncidentTransitionBase {
  readonly incidentIdentity: string;
  readonly transitionKey: string;
  readonly expectedVersion: number;
  readonly reason: string;
}

export type IncidentTransitionRequest =
  | (IncidentTransitionBase & Readonly<{
    action: "ACKNOWLEDGE";
    ownerId: string;
    deadlineAt: number;
  }>)
  | (IncidentTransitionBase & Readonly<{
    action: "UPDATE_ASSIGNMENT";
    ownerId: string;
    deadlineAt: number;
  }>)
  | (IncidentTransitionBase & Readonly<{
    action: "RECORD_CORRECTION";
    correction: IncidentCorrection;
  }>)
  | (IncidentTransitionBase & Readonly<{
    action: "CLOSE";
    resolution: IncidentCloseResolution;
  }>)
  | (IncidentTransitionBase & Readonly<{
    action: "REOPEN";
    ownerId: string;
    deadlineAt: number;
  }>);

export interface IncidentLifecycleProjection {
  readonly serviceId: string;
  readonly incidentIdentity: string;
  readonly lifecycleState: IncidentLifecycleState;
  readonly ownerId: string | null;
  readonly deadlineAt: number | null;
  readonly correction: IncidentCorrection | null;
  readonly closeResolution: "CORRECTED" | "ACCEPTED_AS_IS" | null;
  readonly closeReason: string | null;
  readonly version: number;
  readonly lastTransitionKey: string;
  readonly updatedAt: number;
}

export interface IncidentTransitionRecord {
  readonly transitionId: number;
  readonly serviceId: string;
  readonly incidentIdentity: string;
  readonly transitionKey: string;
  readonly requestDigest: string;
  readonly action: IncidentTransitionRequest["action"];
  readonly fromState: IncidentLifecycleState;
  readonly toState: IncidentLifecycleState;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly actorId: string;
  readonly before: IncidentLifecycleProjection;
  readonly after: IncidentLifecycleProjection;
  readonly reason: string;
  readonly occurredAt: number;
}

/** The sole temporary operational disposition; policy decisions remain open. */
export const GLOBAL_COMPLETENESS_INTERIM_DISPOSITION = "BLOCK/UNSETTLED" as const;

/**
 * This is an internal coverage decision, not a new public response schema.
 * Callers may advance a materialized/live view only after a concrete FULL
 * scanner health record; every other health state stays BLOCK/UNSETTLED.
 */
export type GlobalCompletenessCoverage =
  | Readonly<{
    kind: "SETTLED";
    health: GlobalCompletenessHealthRecord;
    frontierSuid: string | null;
    reason: null;
    partitionTag: null;
    observedAt: number;
  }>
  | Readonly<{
    kind: typeof GLOBAL_COMPLETENESS_INTERIM_DISPOSITION;
    health: GlobalCompletenessHealthRecord;
    frontierSuid: string | null;
    reason: string;
    partitionTag: string | null;
    observedAt: number;
  }>;
