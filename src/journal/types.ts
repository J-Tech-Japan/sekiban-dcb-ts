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
  | "write-failure";

export interface RequeriedRecord {
  eventId: string;
  payload: string;
  present: boolean;
}

export interface ReconciliationInput {
  allocatorVector?: string[];
  records: RequeriedRecord[];
  failureCause: ReconciliationFailureCause;
}

export interface TakeoverProgress {
  active: true;
  sealedTags: string[];
}

export interface TerminalResponse {
  outcome: JournalTerminalState;
  ownerEpoch: number;
  stateVersion: number;
  reason: string;
}

export interface JournalRecord {
  schemaVersion: 1;
  candidates: JournalCandidate[];
  consistencyTags: ConsistencyTag[];
  allTags: string[];
  ownerEpoch: number;
  state: JournalState;
  version: number;
  alarm: AlarmSchedule | null;
  reconciliation: ReconciliationInput | null;
  takeover: TakeoverProgress | null;
  faultsRemaining: number;
  terminalResponse: TerminalResponse | null;
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
    ADMITTED: ["RESERVED", "SEALING", "ABANDONED"],
    RESERVED: ["ALLOCATED", "SEALING", "REFUSED", "FAILED"],
    ALLOCATED: ["WRITING", "SEALING", "COMPLETE", "REFUSED", "FAILED", "PARTIAL"],
    WRITING: ["SEALING", "COMPLETE", "REFUSED", "FAILED", "PARTIAL"],
    SEALING: ["COMPLETE", "REFUSED", "FAILED", "PARTIAL"],
    COMPLETE: [],
    REFUSED: [],
    FAILED: [],
    PARTIAL: [],
    ABANDONED: [],
  };

  return allowed[from].includes(to);
}
