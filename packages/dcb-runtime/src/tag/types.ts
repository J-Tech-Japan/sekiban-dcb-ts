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
  eventType: string;
  provenance: "g32";
  timestamp: string;
  /** Internal allocator lineage belongs to the sidecar/outbox path. */
  allocatorLineageId: string;
}

/**
 * The single internal source-read request for TagStateDO. It is dispatched
 * directly between Durable Objects through TagDurableObject's private
 * adapter, never through the public Worker router. `through` is omitted only
 * by the first page; the Tag DO then freezes it from scalar, identity-checked
 * head facts.
 */
export interface G43TagStateIncrementalRequest {
  readonly tag: string;
  readonly cursor: string;
  readonly limit: number;
  readonly through?: string;
}

/** A bounded page from the sole TagState event-source seam. */
export interface G43TagStateIncrementalPage {
  readonly events: readonly TagEvent[];
  readonly lastSortableUniqueId: string;
  readonly through: string;
  /** Non-null only when this cursor has consumed the frozen frontier. */
  readonly completeThrough: string | null;
}

export interface TagOutboxRow {
  attemptId: string;
  eventId: string;
  suid: string;
  payload: string;
  allocatorLineageId: string;
  eventType: string;
  provenance: "g32";
  timestamp: string;
}

/**
 * Separate from the immutable outbox row so an append remains a commit-path
 * write only. A drain records its first queue-attempt clock fact and delivery
 * acknowledgement here.
 */
export interface TagOutboxDelivery extends TagOutboxRow {
  enqueuedAt: number;
  deliveredAt: number | null;
}

export interface TagFence {
  reason: string;
  attemptId: string;
  epoch: number;
}

/** Bootstrap is intentionally separate from V1 append/reservation state. */
export interface TagBootstrapAdmission {
  importId: string;
  leaseEpoch: number;
  manifestDigest: string;
  targetServiceId: string;
  closed: boolean;
}

/**
 * SDT-G6 repair authority is deliberately held by the Tag DO rather than by
 * a Journal observation.  A scope item is the exact candidate that a repair
 * lease is permitted to touch.
 */
export interface RepairScopeItem {
  attemptId: string;
  eventId: string;
  suid: string;
  payload: string;
  eventTags: string[];
  allocatorLineageId: string;
  eventType: string;
  provenance: "g32";
  timestamp: string;
}

export type RepairBranch = "ROLLED_FORWARD" | "EXCLUDED_AUDITED" | "FAILED_CLOSED";

/** Durable fact written by the Tag DO after it has made a branch decision. */
export interface RepairResolution {
  attemptId: string;
  eventId: string;
  suid: string;
  branch: RepairBranch;
  epoch: number;
  owner: string;
  recordedAt: string;
}

/** An audit is intentionally separate from the original commit outcome. */
export interface RepairAudit {
  attemptId: string;
  eventId: string;
  suid: string;
  branch: Exclude<RepairBranch, "FAILED_CLOSED">;
  actor: string;
  epoch: number;
  owner: string;
  recordedAt: string;
}

export interface RepairFacts {
  resolutions: RepairResolution[];
  audits: RepairAudit[];
}

/**
 * The per-tag durable authority. Its `head` is read from SQLite inside every
 * consistency comparison; there is no in-memory cache of the head.
 */
export interface TagRecord {
  /** G32 is a fresh namespace; earlier durable Tag record shapes are rejected. */
  schemaVersion: 3;
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
  bootstrapAdmission: TagBootstrapAdmission | null;
  /** SDT-G6 repair fencing-token lease. */
  repairOwner: string | null;
  repairLeaseUntil: number | null;
  highestRepairEpoch: number;
  /** Durable, set-based authorization scope for the currently held lease. */
  repairScope: RepairScopeItem[];
  repairScopeVersion: number;
  clockOffsetMs: number;
  clockNowMs: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  /**
   * SDT-G36 non-SQL seam only. Maps `attemptId:epoch` to the write
   * transaction's own version and updatedAt. Absent on older records.
   */
  writeReceipts?: Readonly<Record<string, { readonly version: number; readonly updatedAt: string }>>;
}

/**
 * The immutable scalar facts needed by the commit response.  This is
 * intentionally distinct from TagRecord: a caller that only needs the head
 * must not hydrate or validate the tag's event history to obtain it.
 */
export interface TagHeadFacts {
  head: string;
  version: number;
  updatedAt: string;
}
