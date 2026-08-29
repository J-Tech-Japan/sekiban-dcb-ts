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

/** The sole temporary operational disposition; policy decisions remain open. */
export const GLOBAL_COMPLETENESS_INTERIM_DISPOSITION = "BLOCK/UNSETTLED" as const;

/**
 * This is an internal coverage decision, not a new public response schema.
 * Callers may advance a materialized/live view only after a concrete FULL
 * scanner health record; every other health state stays BLOCK/UNSETTLED.
 */
export type GlobalCompletenessCoverage =
  | Readonly<{ kind: "SETTLED"; health: GlobalCompletenessHealthRecord }>
  | Readonly<{ kind: typeof GLOBAL_COMPLETENESS_INTERIM_DISPOSITION; health: GlobalCompletenessHealthRecord }>;
