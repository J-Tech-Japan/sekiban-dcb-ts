export const G30_PHASES: readonly ["A", "B", "A-prime"];
export const G30_SAMPLE_COUNT: 100;
export const G30_CADENCE_MS: 2_000;
export const G30_EXPORT_DEADLINE_MS: number;
export const G30_IDLE_SCHEDULE_MS: readonly [2_000, 15_000, 180_000];

export interface G30Trace {
  requestId: string;
  traceId: string;
  schema: "sdt.commit/v1";
  complete: boolean;
  runtimeVerified: boolean;
  boundary: string;
  exportedAtMs: number;
  callerCoverageIntervals: readonly string[];
  /** Names retained from every exported provider span on this request trace. */
  providerSpanNames: readonly string[];
  spans: G30TraceSpan[];
}

export interface G30TraceSpan {
  rowId: string;
  startMs: number;
  endMs: number;
  [key: string]: unknown;
}

export interface G30Observation {
  schema: "sdt.observe/v1";
  event: "worker.invocation" | "do.handler" | "fault.barrier";
  requestId: string;
  traceId: string;
  emittedAtMs: number;
  /** Values emitted by the structured observation and cross-checked to S00. */
  scriptVersion?: string;
  colo?: string;
  provider: {
    scriptVersion: string;
    colo: string;
    cpuTimeMs: number;
    wallTimeMs: number;
  };
  [key: string]: any;
}

export interface G30ObservationIndex {
  ledgerByRequestId: Map<string, Record<string, any>>;
  traceByRequestId: Map<string, G30Trace>;
  requestIdByTraceId: Map<string, string>;
  observationsByRequestId: Map<string, G30Observation[]>;
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
export function observationLedgerForPhase(phaseB: unknown): readonly Record<string, any>[];
export function assertObservationStream(
  ledger: readonly Record<string, any>[],
  traces: readonly G30Trace[],
  observations: readonly G30Observation[],
): G30ObservationIndex;
export function assertIdleRequestReferences(
  window: unknown,
  label: string,
): Readonly<{ previousRequestId: string; nextRequestId: string }>;
export function assertWarmupProof(phase: "B", warmup: unknown, observationIndex: G30ObservationIndex): Readonly<Record<string, unknown>>;
export function assertActivationIdleEvidence(
  idleExperiment: unknown,
  observationIndex: G30ObservationIndex,
): Readonly<Record<string, unknown>>;
export function assertOutlierClassification(
  phaseB: unknown,
  observationIndex: G30ObservationIndex,
): Readonly<{ classifiedOutliers: number; unclassifiedOutliers: number }>;
export function assertB0Evidence(evidence: unknown): Readonly<Record<string, unknown>>;
export function assertEligiblePhaseWindow(phase: string, records: readonly object[], rawAttempts?: readonly unknown[]): Readonly<Record<string, unknown>>;
export function assertPhaseConfiguration(phases: unknown): Readonly<Record<string, unknown>>;
export function assertAaaDrift(a: readonly object[], b: readonly object[], aprime: readonly object[]): Readonly<Record<string, unknown>>;
export function unattributedRatioFromTrace(trace: unknown): Readonly<{ rootDurationMs: number; coveredDurationMs: number; unattributedRatio: number }>;
export function phaseLatencySummary(records: readonly object[]): Readonly<{ p50: number; p95: number; max: number }>;
export function selfTest(): Readonly<Record<string, unknown>>;
