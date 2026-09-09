export interface AllocationCandidate {
  candidateIndex: number;
  eventId: string;
}

export interface AllocatedCandidate extends AllocationCandidate {
  suid: string;
}

/**
 * Allocator-issued authority for a closed SUID prefix.
 *
 * The issuance and reconciliation protocol that produces this value belongs
 * to the allocator closure slice.  Projection consumers treat the value as a
 * cached, consumer-bound fact; they never manufacture one from a high-water
 * mark or fetch one as part of an ordinary read.
 */
export interface ClosedPrefixCertificate {
  readonly certificateVersion: 1;
  readonly authority: "allocator-transaction";
  readonly status: "ready" | "unreconciled";
  readonly allocatorLineageId: string;
  readonly serviceId: string;
  readonly closedPrefixSuid: string | null;
  readonly unresolvedCount: number;
  readonly generatedAt: number;
  readonly migrationProofId: string | null;
}

/**
 * The durable, attempt-keyed allocation result. Candidates are always ordered
 * by candidateIndex, rather than by the order in which a caller sent them.
 */
export interface AllocationVector {
  attemptId: string;
  /** Durable allocator lineage token; it changes when the allocator DO is recreated. */
  allocatorLineageId: string;
  candidates: AllocatedCandidate[];
  allocatedAt: string;
}

/** The persisted service head; it is the allocated watermark. */
export interface AllocatorState {
  schemaVersion: 5;
  allocatorLineageId: string;
  allocatedWatermark: string | null;
  bootstrapSeed: { importId: string; leaseEpoch: number; highWatermark: string } | null;
  /** Durable rate-limit key for rollback warnings; it is not allocation authority. */
  lastRollbackWarningFingerprint?: string | null;
}
