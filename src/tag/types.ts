export const RESERVATION_WINDOW_MS = 30_000;

export interface TagEpoch {
  attemptId: string;
  epoch: number;
}

/** V1 wire spelling is intentionally `lastSortedUniqueId`. */
export interface TagConsistencyEntry {
  tag: string;
  lastSortedUniqueId: string | null;
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
