export const G30_PHASES: readonly ["A", "B", "A-prime"];
export const G30_SAMPLE_COUNT: 100;
export const G30_CADENCE_MS: 2_000;
export const G30_EXPORT_DEADLINE_MS: number;
export const G30_IDLE_SCHEDULE_MS: readonly [2_000, 15_000, 180_000];

export interface G30Trace {
  requestId: string;
  schema: "sdt.commit/v1";
  complete: boolean;
  runtimeVerified: boolean;
  boundary: string;
  exportedAtMs: number;
  callerCoverageIntervals: readonly string[];
  spans: G30TraceSpan[];
}

export interface G30TraceSpan {
  rowId: string;
  startMs: number;
  endMs: number;
  [key: string]: unknown;
}

export function assertEligiblePhaseWindow(
  phase: "A" | "B" | "A-prime",
  records: readonly object[],
  rawAttempts?: readonly unknown[],
): Readonly<Record<string, unknown>>;
export function assertTraceCohort(
  ledger: readonly object[],
  traces: readonly G30Trace[],
  exportCompletedAtMs: number,
): Readonly<{ requestCount: number; exportDeadlineMs: number }>;
export function assertWarmupProof(phase: string, warmup: unknown): Readonly<Record<string, unknown>>;
export function assertActivationIdleEvidence(activationIdle: unknown): Readonly<Record<string, unknown>>;
export function assertOutlierClassification(outliers: unknown): Readonly<{ classifiedOutliers: number; unclassifiedOutliers: number }>;
export function assertB0Evidence(evidence: unknown): Readonly<Record<string, unknown>>;
export function assertEligiblePhaseWindow(phase: string, records: readonly object[], rawAttempts?: readonly unknown[]): Readonly<Record<string, unknown>>;
export function assertPhaseConfiguration(phases: unknown): Readonly<Record<string, unknown>>;
export function assertAaaDrift(a: readonly object[], b: readonly object[], aprime: readonly object[]): Readonly<Record<string, unknown>>;
export function unattributedRatioFromTrace(trace: unknown): Readonly<{ rootDurationMs: number; coveredDurationMs: number; unattributedRatio: number }>;
export function phaseLatencySummary(records: readonly object[]): Readonly<{ p50: number; p95: number; max: number }>;
export function selfTest(): Readonly<Record<string, unknown>>;
