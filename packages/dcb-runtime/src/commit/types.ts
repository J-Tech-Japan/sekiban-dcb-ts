import type { ConsistencyTag } from "../journal/types";

/** The exact V1 request candidate, retained without rewriting payload bytes. */
export interface SerializedCommitCandidate {
  payload: string;
  eventPayloadName: string;
  eventType: string;
  tags: string[];
}

export interface ValidatedCommitEnvelope {
  eventCandidates: SerializedCommitCandidate[];
  consistencyTags: ConsistencyTag[];
  allTags: string[];
}

export interface AllocatedCommitCandidate extends SerializedCommitCandidate {
  eventId: string;
  suid: string;
}

/**
 * Narrow fault hooks used only by the Miniflare adversarial tests. They are
 * carried in a private header rather than accepted in the V1 JSON envelope.
 */
export type CommitTestFault =
  | "reservation-delayed-success"
  | "allocator-commit"
  | "journal-cas-after-allocator"
  | "tag-append-always"
  | "tag-append-last"
  | "fence-install-partial"
  | "fence-not-durable"
  | "tag-state-unavailable"
  | "sealing-after-cas"
  | "tombstone-after-durable";

export const COMMIT_TEST_FAULTS: readonly CommitTestFault[] = [
  "reservation-delayed-success",
  "allocator-commit",
  "journal-cas-after-allocator",
  "tag-append-always",
  "tag-append-last",
  "fence-install-partial",
  "fence-not-durable",
  "tag-state-unavailable",
  "sealing-after-cas",
  "tombstone-after-durable",
];
