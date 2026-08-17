export const JOURNAL_STATES = [
  "ADMITTED",
  "RESERVED",
  "ALLOCATED",
  "WRITING",
  "SEALING",
  "COMPLETE",
  "REFUSED",
  "FAILED",
  "PARTIAL",
  "ABANDONED",
] as const;

export type JournalState = (typeof JOURNAL_STATES)[number];

export const TERMINAL_JOURNAL_STATES = new Set<JournalState>([
  "COMPLETE",
  "REFUSED",
  "FAILED",
  "PARTIAL",
  "ABANDONED",
]);

export type JournalTerminalState = Extract<
  JournalState,
  "COMPLETE" | "REFUSED" | "FAILED" | "PARTIAL" | "ABANDONED"
>;

export interface JournalCandidate {
  eventId: string;
  payload: string;
  tags: string[];
}

export interface ConsistencyTag {
  tag: string;
  lastSortableUniqueId: string;
}

export interface AlarmSchedule {
  attempt: number;
  dueAt: number;
  delayMs: number;
}

export type ReconciliationFailureCause =
  | "reservation-conflict"
  | "allocator-failure"
  | "write-failure"
  | "reservation-timeout"
  | "guard-rejection";

/**
 * Persisted fault points used by the commit-worker recovery tests. They are
 * consumed one at a time, so an at-least-once alarm can resume safely.
 */
export const ALARM_FAULT_POINTS = [
  "handler-entry",
  "after-rearm-before-seal",
  "after-partial-seal",
  "after-full-seal-before-requery",
  "after-fence-before-cancel",
  "before-outcome-cas",
] as const;

export type AlarmFaultPoint = (typeof ALARM_FAULT_POINTS)[number];

/** Information the Journal needs to recover an externally visible commit. */
export interface CommitAttemptContext {
  attemptId: string;
  serviceId: string;
  /** Private commit.test hook that makes partial-write fence installation unavailable. */
  testFenceNotDurable?: boolean;
  /** Private commit.test hook that interrupts immediately after one durable fence install. */
  testFenceInstallFaultOnce?: boolean;
}

export interface RequeriedRecord {
  eventId: string;
  payload: string;
  present: boolean;
}

export interface ReconciliationInput {
  allocatorVector?: string[];
  records: RequeriedRecord[];
  failureCause: ReconciliationFailureCause;
  /** Tags for which at least one requested candidate is still absent. */
  missingTags?: string[];
}

export interface TakeoverProgress {
  active: true;
  sealedTags: string[];
  /** Missing tags whose partial-write fence is durably installed. */
  fencedTags: string[];
}

export interface TerminalResponse {
  outcome: JournalTerminalState;
  ownerEpoch: number;
  stateVersion: number;
  reason: string;
}

/**
 * SDT-G6 repair progress is an observation log only.  It is never consulted
 * to authorize a Tag mutation, clear a fence, or change the original outcome.
 */
export type RepairObservationPhase = "PREPARED" | "VERIFIED" | "CLEARED";

export interface RepairObservation {
  owner: string;
  epoch: number;
  tag: string;
  attemptId: string;
  eventId: string;
  suid: string;
  phase: RepairObservationPhase;
  branch?: "ROLLED_FORWARD" | "EXCLUDED_AUDITED" | "FAILED_CLOSED";
  observedAt: string;
}

/** Durable classification recorded before the reservation cancel barrier. */
export interface ReservationFailure {
  outcome: Extract<JournalTerminalState, "REFUSED" | "FAILED">;
  reason: string;
  failureCause: ReconciliationFailureCause;
}

export interface JournalRecord {
  schemaVersion: 1;
  candidates: JournalCandidate[];
  consistencyTags: ConsistencyTag[];
  allTags: string[];
  /** Present only for the V1 commit worker; legacy Journal controls omit it. */
  commitContext?: CommitAttemptContext;
  ownerEpoch: number;
  state: JournalState;
  version: number;
  alarm: AlarmSchedule | null;
  reconciliation: ReconciliationInput | null;
  reservationFailure: ReservationFailure | null;
  takeover: TakeoverProgress | null;
  faultsRemaining: number;
  alarmFaults: AlarmFaultPoint[];
  terminalResponse: TerminalResponse | null;
  repairObservations: RepairObservation[];
  createdAt: string;
  updatedAt: string;
}

export interface CasExpectation {
  expectedState: JournalState;
  expectedVersion: number;
  expectedOwnerEpoch: number;
}

export function isTerminalState(state: JournalState): state is JournalTerminalState {
  return TERMINAL_JOURNAL_STATES.has(state);
}

export function isJournalState(value: unknown): value is JournalState {
  return typeof value === "string" && JOURNAL_STATES.includes(value as JournalState);
}

export function isAllowedTransition(from: JournalState, to: JournalState): boolean {
  const allowed: Record<JournalState, readonly JournalState[]> = {
    ADMITTED: ["RESERVED", "ALLOCATED", "SEALING", "ABANDONED"],
    RESERVED: ["ALLOCATED", "SEALING", "REFUSED", "FAILED", "ABANDONED"],
    ALLOCATED: ["WRITING", "SEALING", "COMPLETE"],
    WRITING: ["SEALING", "COMPLETE"],
    SEALING: ["COMPLETE", "REFUSED", "FAILED", "PARTIAL"],
    COMPLETE: [],
    REFUSED: [],
    FAILED: [],
    PARTIAL: [],
    ABANDONED: [],
  };

  return allowed[from].includes(to);
}
