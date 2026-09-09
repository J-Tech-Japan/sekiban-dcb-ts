export interface AllocationCandidate {
  candidateIndex: number;
  eventId: string;
  /** Source Tag membership that must durably accept or fence this issuance. */
  targetTags?: string[];
}

export interface AllocatedCandidate extends AllocationCandidate {
  suid: string;
}

export type IssuanceObligationDisposition = "installed" | "fenced" | "revoked";

/**
 * Durable issuance authority for one allocator candidate.  The obligation
 * is written in the same Durable Object transaction as the vector and
 * watermark; elapsed time, a response, or a single Tag can never close it.
 */
export interface IssuanceObligation {
  attemptId: string;
  candidateIndex: number;
  eventId: string;
  suid: string;
  allocatorLineageId: string;
  targetTags: string[];
  installedTags: string[];
  fencedTags: string[];
  /** Tags whose exact writer identity was durably revoked by the allocator. */
  revokedTags?: string[];
  status: "unresolved" | "resolved";
  /** Monotonic allocator-local sequence; used for bounded prefix advancement. */
  sequence?: number;
}

/**
 * Incremental certificate index.  It contains only the moving prefix and
 * unresolved count; individual obligations live under separate durable keys.
 * The allocator never rewrites the complete issuance history on the hot path.
 */
export interface ClosedPrefixIndex {
  version: 1;
  allocatorLineageId: string;
  nextSequence: number;
  closedSequence: number;
  closedPrefixSuid: string | null;
  unresolvedCount: number;
  /** Compatibility marker for the pre-G70 participant-free structural seam. */
  hasParticipantMembership?: boolean;
}

/** Durable recovery work owned by the allocator, not a request waitUntil. */
export interface IssuanceRecoveryRecord {
  serviceId: string;
  attemptId: string;
  candidateIndex: number;
  eventId: string;
  suid: string;
  allocatorLineageId: string;
  targetTags: string[];
  nextAttemptAt: number;
  attemptCount: number;
  /** After this deadline an absent writer is resolved by durable revocation. */
  revocationDueAt?: number;
}

export interface ClosedPrefixCertificate {
  certificateVersion: 1;
  /** The certificate is issued from the durable allocator index, never a caller-supplied SUID. */
  authority: "allocator-transaction";
  status: "ready" | "unreconciled";
  allocatorLineageId: string;
  /** Service identity bound to the consumer that may use this certificate. */
  serviceId?: string | null;
  closedPrefixSuid: string | null;
  unresolvedCount: number;
  generatedAt: number;
  /** Explicitly records why a legacy namespace is not yet safe. */
  migrationProofId: string | null;
  /** Diagnostic bounded-cost measurement for certificate acquisition. */
  acquisitionCostMs?: number;
  /** Durable allocation transaction persistence window, measured locally. */
  durableWriteCostMs?: number;
}

/**
 * The durable, attempt-keyed allocation result. Candidates are always ordered
 * by candidateIndex, rather than by the order in which a caller sent them.
 */
export interface AllocationVector {
  attemptId: string;
  /** Durable allocator lineage token; it changes when the allocator DO is recreated. */
  allocatorLineageId: string;
  /** Presence marks a vector written by the G70 obligation-aware allocator. */
  issuanceObligationVersion?: 1;
  candidates: AllocatedCandidate[];
  allocatedAt: string;
}

/** The persisted service head; it is the allocated watermark. */
export interface AllocatorState {
  schemaVersion: 5;
  allocatorLineageId: string;
  allocatedWatermark: string | null;
  bootstrapSeed: { importId: string; leaseEpoch: number; highWatermark: string } | null;
  /** The service namespace that owns this allocator, when supplied by G70. */
  serviceId?: string | null;
  /** Durable rate-limit key for rollback warnings; it is not allocation authority. */
  lastRollbackWarningFingerprint?: string | null;
  /** Measured persistence window for the most recent allocation transaction. */
  lastAllocationPersistenceMs?: number;
}
