import type {
  JournalRecord,
  ReconciliationFailureCause,
  ReconciliationInput,
} from "../journal/types";

export interface WrittenEventResponse {
  payload: string;
  sortableUniqueIdValue: string;
  id: string;
  eventMetadata: {
    causationId: string;
    correlationId: string;
    executedUser: string;
  };
  tags: string[];
  eventPayloadName: string;
}

export interface TagWriteResultResponse {
  tag: string;
  version: number;
  writtenAt: string;
}

export interface CompleteCommitResponse {
  writtenEvents: WrittenEventResponse[];
  tagWriteResults: TagWriteResultResponse[];
  duration: string;
}

export interface CommitHttpMapping {
  status: number;
  body: unknown;
}

export interface ActualTagRecord {
  tag: string;
  events: Array<{ eventId: string; payload: string }>;
}

/**
 * Purely derives the requery facts from durable tag snapshots. It is shared by
 * the response-layer tests so outcome classification is never inferred from a
 * Journal state alone.
 */
export function requeryFactsFromTagRecords(
  record: Pick<JournalRecord, "candidates" | "allTags" | "reconciliation">,
  tagRecords: ActualTagRecord[],
): ReconciliationInput {
  const recordsByTag = new Map(tagRecords.map((entry) => [entry.tag, entry.events]));
  const contains = (tag: string, eventId: string, payload: string): boolean =>
    (recordsByTag.get(tag) ?? []).some((event) => event.eventId === eventId && event.payload === payload);
  const missingTags = record.allTags.filter((tag) =>
    record.candidates
      .filter((candidate) => candidate.tags.includes(tag))
      .some((candidate) => !contains(tag, candidate.eventId, candidate.payload)),
  );
  return {
    allocatorVector: record.reconciliation?.allocatorVector,
    records: record.candidates.map((candidate) => ({
      eventId: candidate.eventId,
      payload: candidate.payload,
      present: candidate.tags.some((tag) => contains(tag, candidate.eventId, candidate.payload)),
    })),
    failureCause: record.reconciliation?.failureCause ?? "write-failure",
    missingTags,
  };
}

function failureMapping(cause: ReconciliationFailureCause | undefined): CommitHttpMapping {
  if (cause === "reservation-timeout") {
    return {
      status: 504,
      body: { error: "serialized commit timed out", code: "timeout" },
    };
  }
  return {
    status: 500,
    body: { error: "serialized commit failed before writing requested records", code: "internal_error" },
  };
}

/**
 * Pure V1 terminal-outcome mapping. `undefined` intentionally means that a
 * nonterminal/abandoned Journal has no application outcome to serialize.
 */
export function mapTerminalCommitOutcome(
  record: Pick<JournalRecord, "state" | "allTags" | "reconciliation">,
  complete?: CompleteCommitResponse,
): CommitHttpMapping | undefined {
  switch (record.state) {
    case "COMPLETE":
      return complete === undefined ? undefined : { status: 200, body: complete };
    case "REFUSED":
      return {
        status: 400,
        body: {
          error: "serialized commit was refused by a consistency reservation",
          code: "consistency_conflict",
        },
      };
    case "FAILED":
      return failureMapping(record.reconciliation?.failureCause);
    case "PARTIAL": {
      const reconciliation = record.reconciliation;
      const writtenEventIds = reconciliation?.records.filter((entry) => entry.present).map((entry) => entry.eventId) ?? [];
      const failedEventIds = reconciliation?.records.filter((entry) => !entry.present).map((entry) => entry.eventId) ?? [];
      const missingTags = reconciliation?.missingTags ?? [];
      return {
        status: 500,
        body: {
          error: "serialized commit partially failed",
          code: "partial_write",
          partial: {
            writtenEventIds,
            failedEventIds,
            writtenTags: record.allTags.filter((tag) => !missingTags.includes(tag)),
            missingTags,
            eventsDeleted: false,
            retryable: false,
          },
        },
      };
    }
    default:
      return undefined;
  }
}

export function durationSince(startedAtMs: number): string {
  return `PT${Math.max(0, Date.now() - startedAtMs) / 1_000}S`;
}
