export const RESERVATION_WINDOW_MS = 30_000;
export const PARTIAL_WRITE_FENCE_REASON = "partial_write";
export const SEGMENT_ROTATION_FENCE_REASON = "segment_rotation";

export interface TagEpoch {
  attemptId: string;
  epoch: number;
}

/**
 * §3.1 consistency-entry spelling. F-001 preserves `lastSortedUniqueId`
 * only for the §5.3 tag-state response, not for this request entry.
 */
export interface TagConsistencyEntry {
  tag: string;
  lastSortableUniqueId: string | null;
}

export interface TagReservation {
  attemptId: string;
  epoch: number;
  token: string;
  expectedHead: string;
  expiresAt: number;
  alarmDueAt: number;
}

export interface TagEvent {
  attemptId: string;
  eventId: string;
  suid: string;
  payload: string;
  eventTags: string[];
}

export interface TagOutboxRow {
  attemptId: string;
  eventId: string;
  suid: string;
  payload: string;
}

export interface TagFence {
  reason: string;
  attemptId: string;
  epoch: number;
}

/**
 * The per-tag durable authority. Its `head` is read from SQLite inside every
 * consistency comparison; there is no in-memory cache of the head.
 */
export interface TagRecord {
  schemaVersion: 1;
  tag: string;
  head: string;
  activeReservation: TagReservation | null;
  alarmDueAt: number | null;
  events: TagEvent[];
  outbox: TagOutboxRow[];
  highestEpoch: TagEpoch[];
  sealedEpoch: TagEpoch[];
  tombstones: TagEpoch[];
  confirmations: TagEpoch[];
  fences: TagFence[];
  clearedFences: TagFence[];
  clockOffsetMs: number;
  clockNowMs: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}
