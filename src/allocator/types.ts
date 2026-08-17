export interface AllocationCandidate {
  candidateIndex: number;
  eventId: string;
}

export interface AllocatedCandidate extends AllocationCandidate {
  suid: string;
}

/**
 * The durable, attempt-keyed allocation result. Candidates are always ordered
 * by candidateIndex, rather than by the order in which a caller sent them.
 */
export interface AllocationVector {
  attemptId: string;
  candidates: AllocatedCandidate[];
  allocatedAt: string;
}

/** The persisted service head; it is the allocated watermark. */
export interface AllocatorState {
  schemaVersion: 1;
  allocatedWatermark: string | null;
}
