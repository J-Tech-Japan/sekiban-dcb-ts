import type { RetainedSnapshotLogReceipt } from "../g30-trace-export.mjs";

export {
  TASK,
  RESUME_STATE_SCHEMA,
  SAMPLE_COUNT,
  COHORT_REQUEST_COUNT,
  RESUME_THRESHOLD,
  RESUME_BOUND_MS,
  RESUME_INTERVAL_MS,
  PACED_SAMPLE_INTERVAL_MS,
  PACED_FALLBACK_DELAY_MS,
  SNAPSHOT_PER_HOP_ROWS,
  WINDOWED_RESUME_QUERY_SCOPE,
  createPacedResumeState,
  capturePacedCohort,
  resumeExactRayQuery,
  readResumeState,
} from "../g52-resume-query.mjs";
export type { G52ResumeLatest, G52PacedResumeState } from "../g52-resume-query.mjs";

export const W68_RECOVERY_SCHEMA: "sdt-g52-w68-recovery/v1";
export const W68_FIXED_WINDOW: Readonly<{ from: number; to: number; cohortStartedAtMs: number }>;

export interface G52W68RecoveryState {
  schema: "sdt-g52-w68-recovery/v1";
  task: "SDT-G52";
  cohortKind: "w68-burst";
  ledgerAvailability: string;
  resumed: {
    exactRaySet: readonly string[];
    retainedSnapshotReceipts: readonly RetainedSnapshotLogReceipt[];
    retentionRatio?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function createW68RecoveryState(now?: () => number): G52W68RecoveryState;
export function recoverW68SnapshotWindow(input: {
  state: G52W68RecoveryState;
  accountId: string;
  token: string;
  template: Record<string, unknown>;
  now?: () => number;
  queryFixedWindow?: (input: { accountId: string; token: string; template: Record<string, unknown>; fromMs: number; toMs: number }) => Promise<{ window: { from: number; to: number }; receipts: readonly RetainedSnapshotLogReceipt[] }> | { window: { from: number; to: number }; receipts: readonly RetainedSnapshotLogReceipt[] };
}): Promise<G52W68RecoveryState>;
export function createPacedFallbackSchedule(input: {
  w68Recovery: G52W68RecoveryState;
  pacedStatePath: string;
  now?: () => number;
}): Readonly<{
  schema: "sdt-g52-resume-query-schedule/v1";
  pacedFallback: Readonly<{ earliestStartAtMs: number; "24hBoundAtMs": number; decision: "start-paced-now" | "wait-until-two-hour-gate"; statePath: string }>;
  [key: string]: unknown;
}>;
