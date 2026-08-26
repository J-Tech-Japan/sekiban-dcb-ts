import type { G30TraceSamplingSettlement } from "./deploy/g30-b0-measure.mjs";

export const G30_PHASES: readonly ["A", "B", "A-prime"];
export const G30_SAMPLE_COUNT: 100;
export const G30_MIN_SCHEMA_COMPLETE_COUNT: 95;
export const G30_TAIL_RANK_COUNT: 5;
export const G30_LATENCY_ESTIMATOR: "nearest-rank/full-client-ledger/v1";
export const G30_CADENCE_MS: 2_000;
export const G30_EXPORT_DEADLINE_MS: number;
export const G30_IDLE_SCHEDULE_MS: readonly [2_000, 15_000, 180_000];
export const G30_WINDOW_RESET_LIMIT: 5;

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
  /** Provider-owned request id retained from the raw structured log event. */
  platformRequestId: string;
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
  [key: string]: unknown;
}

export interface G30EmittedRowInventoryEntry {
  requestId: string;
  inventoryAvailable: boolean;
  tracePresent: boolean;
  emittedRows: readonly string[];
  ingestedRows: readonly string[];
  diff: {
    expectedNotEmitted: readonly string[];
    expectedNotIngested: readonly string[];
    emittedNotIngested: readonly string[];
    ingestedNotEmitted: readonly string[];
    rows: readonly {
      rowId: string;
      classification: "matched" | "ingestion-missing" | "inventory-divergence" | "emission-missing" | "inventory-unavailable";
    }[];
    classification: "matched" | "emission" | "ingestion" | "mixed" | "inventory-divergence" | "inventory-unavailable";
  };
}

export interface G30ObservationIndex {
  ledgerByRequestId: Map<string, Record<string, unknown>>;
  traceByRequestId: Map<string, G30Trace>;
  requestIdByTraceId: Map<string, string>;
  observationsByRequestId: Map<string, G30Observation[]>;
}

export interface G30MissingTrace {
  phase: "A" | "B" | "A-prime";
  ordinal: number;
  requestId: string;
  attemptId?: string;
  clientLatency: number;
  fullLedgerRank: number;
  percentile: number;
  stage: "root-absent" | "schema-incomplete";
  sensitivityEnvelope: {
    lowerBoundMs: 0;
    upperBoundMs: number;
    upperBoundSource: "client-latency" | "observed-root-duration";
  };
}

export interface G30TraceCohortProof {
  phase: "A" | "B" | "A-prime";
  requestCount: 100;
  clientCount: 100;
  schemaCompleteCount: number;
  missingCount: number;
  missingRequestIds: readonly string[];
  missing: readonly G30MissingTrace[];
  tailCoverage: {
    ordering: "clientLatency desc, requestId asc";
    ranks: readonly { rank: number; requestId: string; clientLatency: number }[];
    requestIds: readonly string[];
    complete: true;
  };
  latency: {
    universe: "full-100-client-ledger";
    estimator: "nearest-rank/full-client-ledger/v1";
    p50: number;
    p95: number;
    p99: number;
  };
  unattributed: readonly { requestId: string; rootDurationMs: number; coveredDurationMs: number; unattributedRatio: number }[];
  perHop: {
    basis: "schema-complete-joined-cohort";
    wholeCohortConclusion: false;
    joinedRequestCount: number;
    missingRequestCount: number;
    [key: string]: unknown;
  };
  exportDeadlineMs: number;
  [key: string]: unknown;
}

export function assertEligiblePhaseWindow(
  phase: "A" | "B" | "A-prime",
  records: readonly object[],
  rawAttempts?: readonly unknown[],
  windowResets?: number,
): Readonly<Record<string, unknown>>;
export function assertTraceCohort(
  ledger: readonly object[],
  traces: readonly G30Trace[],
  exportCompletedAtMs: number,
  phase?: "A" | "B" | "A-prime",
): Readonly<G30TraceCohortProof>;
export function observationLedgerForPhase(phaseB: unknown): readonly Record<string, unknown>[];
export function assertObservationStream(
  ledger: readonly Record<string, unknown>[],
  traces: readonly G30Trace[],
  observations: readonly G30Observation[],
  options?: Readonly<{ allowedMissingRequestIds?: readonly string[] }>,
): G30ObservationIndex;
export function reconcileEmittedRowInventory(
  ledger: readonly object[],
  traces: readonly G30Trace[],
  inventoryObservations: readonly G30Observation[],
): readonly G30EmittedRowInventoryEntry[];
export function assertEmittedRowInventory(
  ledger: readonly object[],
  traces: readonly G30Trace[],
  inventoryObservations: readonly G30Observation[],
  evidenceInventory: readonly G30EmittedRowInventoryEntry[],
): readonly G30EmittedRowInventoryEntry[];
export function assertIdleRequestReferences(
  window: unknown,
  label: string,
): Readonly<{ previousRequestId: string; nextRequestId: string }>;
export function assertWarmupProof(phase: "B", warmup: unknown, observationIndex: G30ObservationIndex): Readonly<Record<string, unknown>>;
export function assertBTraceSamplingSettlement(phaseB: unknown): Readonly<G30TraceSamplingSettlement>;
export function assertActivationIdleEvidence(
  idleExperiment: unknown,
  observationIndex: G30ObservationIndex,
): Readonly<Record<string, unknown>>;
export function assertOutlierClassification(
  phaseB: unknown,
  observationIndex: G30ObservationIndex,
): Readonly<{ classifiedOutliers: number; unclassifiedOutliers: number }>;
export function assertB0Evidence(evidence: unknown): Readonly<Record<string, unknown>>;
export function assertEligiblePhaseWindow(phase: string, records: readonly object[], rawAttempts?: readonly unknown[], windowResets?: number): Readonly<Record<string, unknown>>;
export function assertPhaseConfiguration(phases: unknown): Readonly<Record<string, unknown>>;
export function assertAaaDrift(a: readonly object[], b: readonly object[], aprime: readonly object[]): Readonly<Record<string, unknown>>;
export function unattributedRatioFromTrace(trace: unknown): Readonly<{ rootDurationMs: number; coveredDurationMs: number; unattributedRatio: number }>;
export function phaseLatencySummary(records: readonly object[]): Readonly<{ p50: number; p95: number; max: number }>;
export function selfTest(): Readonly<Record<string, unknown>>;
