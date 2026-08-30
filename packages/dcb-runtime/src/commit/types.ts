import type { ConsistencyTag } from "../journal/types";

/** The V1 base64 payload after fatal UTF-8 JSON admission, retained as text. */
export interface SerializedCommitCandidate {
  /** Decoded UTF-8 JSON text; whitespace and member order are preserved. */
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
  timestamp: string;
}

/**
 * Narrow fault hooks used only by the Miniflare adversarial tests. They are
 * carried in a private header rather than accepted in the V1 JSON envelope.
 */
export type CommitTestFault =
  | "reservation-delayed-success"
  | "after-reservations-before-allocation"
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
  "after-reservations-before-allocation",
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
