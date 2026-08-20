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
  /** Durable allocator lineage token; it changes when the allocator DO is recreated. */
  allocatorLineageId: string;
  candidates: AllocatedCandidate[];
  allocatedAt: string;
}

/** The persisted service head; it is the allocated watermark. */
export interface AllocatorState {
  schemaVersion: 3;
  allocatorLineageId: string;
  allocatedWatermark: string | null;
  bootstrapSeed: { importId: string; leaseEpoch: number; highWatermark: string } | null;
}

/** The only allocator namespace that serves a particular service. */
export function allocatorNameForService(serviceId: string): string {
  return `service-allocator:${serviceId}`;
}
