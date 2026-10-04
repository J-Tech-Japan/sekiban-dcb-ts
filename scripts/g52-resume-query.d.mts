import type { G50LedgerEntry } from "./deploy/g50-commit-latency.mjs";
import type { G30NormalizedObservation, G30NormalizedTrace } from "./g30-trace-export.mjs";

export const TASK: "SDT-G52";
export const RESUME_STATE_SCHEMA: "sdt-g52-resume-query-state/v1";
export const SAMPLE_COUNT: 50;
export const COHORT_REQUEST_COUNT: 51;
export const RESUME_THRESHOLD: 40;
export const RESUME_BOUND_MS: number;
export const RESUME_INTERVAL_MS: number;
export const PACED_SAMPLE_INTERVAL_MS: 10000;
export const PACED_FALLBACK_DELAY_MS: number;
export const SNAPSHOT_PER_HOP_ROWS: readonly string[];
export const WINDOWED_RESUME_QUERY_SCOPE: "persisted-cohort-window-standard-script-type-filters-client-side-exact-ray-intersection";

export interface G52ResumeLatest {
  queriedAtMs: number;
  retainedInvocationRoots: number;
  retainedSampleRoots: number;
  schemaCompleteSampleRoots: number;
  missingSampleRequestIds: readonly string[];
  traces: readonly G30NormalizedTrace[];
  observations: readonly G30NormalizedObservation[];
  [key: string]: unknown;
}

export interface G52PacedResumeState {
  schema: "sdt-g52-resume-query-state/v1";
  task: "SDT-G52";
  cohortKind: "paced";
  runId: string;
  deployed: { baseUrl: string; accountId: string; serviceId: string; versionId: string; sourceCommit: string };
  warmup: G50LedgerEntry | null;
  ledger: G50LedgerEntry[];
  exactRaySet: string[];
  client?: { count: number; p50: number | null; p95: number | null };
  callerColoDistribution?: Readonly<Record<string, number>>;
  resume: {
    lifecycle: string;
    threshold: number;
    deadlineAtMs: number | null;
    nextQueryAtMs: number | null;
    queries: Array<{ attempt: number; queryScope: string; expectedSampleRequests?: number; schemaCompleteSampleRoots?: number; [key: string]: unknown }>;
    latest: G52ResumeLatest | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function createPacedResumeState(input: {
  baseUrl: string;
  accountId: string;
  serviceId: string;
  versionId: string;
  sourceCommit: string;
  runId: string;
  now?: () => number;
}): G52PacedResumeState;
export function capturePacedCohort(input: {
  state: G52PacedResumeState;
  persist: (state: G52PacedResumeState) => Promise<void> | void;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  sleepFor?: (milliseconds: number) => Promise<void> | void;
  now?: () => number;
}): Promise<G52PacedResumeState>;
export function resumeExactRayQuery(input: {
  state: G52PacedResumeState;
  accountId: string;
  token: string;
  template: Record<string, unknown>;
  now?: () => number;
  queryCohort?: (input: { accountId: string; token: string; template: Record<string, unknown>; ledger: readonly G50LedgerEntry[] }) => Promise<unknown> | unknown;
  normalizeBundle?: (raw: unknown, exportedAtMs?: number, clientRequestIdsByRayId?: ReadonlyMap<string, string>) => { traces: readonly G30NormalizedTrace[]; observations: readonly G30NormalizedObservation[] };
}): Promise<G52PacedResumeState>;
export function readResumeState(path: string): G52PacedResumeState;
