export interface G30NormalizedTrace {
  requestId: string;
  traceId: string;
  schema: "sdt.commit/v1";
  boundary: "success";
  complete: boolean;
  runtimeVerified: boolean;
  exportedAtMs: number;
  callerCoverageIntervals: readonly string[];
  /** Safe names from every provider span retained on the same trace. */
  providerSpanNames: readonly string[];
  spans: G30NormalizedTraceSpan[];
}

export interface G30NormalizedTraceSpan {
  rowId: string;
  startMs: number;
  endMs: number;
  [key: string]: unknown;
}

export interface G30NormalizedObservation {
  schema: "sdt.observe/v1";
  event: "worker.invocation" | "do.handler" | "fault.barrier";
  requestId: string;
  traceId: string;
  emittedAtMs: number;
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

export function verifyExportedSuccessTrace(trace: unknown): Readonly<{ rows: number; complete: true }>;
export function normalizeTelemetryExport(raw: unknown, exportedAtMs?: number): readonly G30NormalizedTrace[];
export function normalizeTelemetryBundle(raw: unknown, exportedAtMs?: number): Readonly<{
  traces: readonly G30NormalizedTrace[];
  observations: readonly G30NormalizedObservation[];
}>;
