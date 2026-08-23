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

export function verifyExportedSuccessTrace(trace: unknown): Readonly<{ rows: number; complete: true }>;
export function normalizeTelemetryExport(raw: unknown, exportedAtMs?: number): readonly G30NormalizedTrace[];
