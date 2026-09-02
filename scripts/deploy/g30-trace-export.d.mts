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
  /** Provider-owned request id retained from the raw structured log event. */
  platformRequestId: string;
  emittedAtMs: number;
  scriptVersion?: string;
  colo?: string;
  /** Present only on worker.invocation; it is observation-only attribution. */
  emittedWorkerRowIds?: readonly string[];
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
    rows: readonly { rowId: string; classification: string }[];
    classification: string;
  };
}

export interface G30TraceExportJoinState {
  requestId: string;
  ordinal: number;
  fullLedgerRank: number;
  clientLatencyMs: number;
  tracePresent: boolean;
  rootPresent: boolean;
  runtimeVerified: boolean;
  schemaComplete: boolean;
  stage: "schema-complete" | "schema-incomplete" | "root-absent";
  observedRequiredRows: readonly string[];
  missingRequiredRows: readonly string[];
}

export interface G30TraceExportFailureEvidence {
  task: "SDT-G30";
  phase: "B";
  result: "trace-export-failed";
  capturedAt: string;
  exportDeadline: string;
  failureClass: string;
  clientCount: number;
  schemaCompleteCount: number;
  missingCount: number;
  missingRequestIds: readonly string[];
  requestJoinStates: readonly G30TraceExportJoinState[];
  emittedRowInventory: readonly G30EmittedRowInventoryEntry[];
  rawDataHandling: string;
}

export function verifyExportedSuccessTrace(trace: unknown): Readonly<{ rows: number; complete: true }>;
export function normalizeTelemetryExport(raw: unknown, exportedAtMs?: number): readonly G30NormalizedTrace[];
export function normalizeTelemetryBundle(raw: unknown, exportedAtMs?: number, clientRequestIdsByRayId?: ReadonlyMap<string, string>): Readonly<{
  traces: readonly G30NormalizedTrace[];
  observations: readonly G30NormalizedObservation[];
  /** Worker observations retained even when their trace is schema-incomplete. */
  inventoryObservations: readonly G30NormalizedObservation[];
}>;
export function buildBoundedTelemetryQuery(template: Record<string, unknown>, filters: readonly Record<string, unknown>[]): Record<string, unknown>;
export const CLOUDFLARE_TELEMETRY_MAX_FILTER_NODES: 16;
export const TELEMETRY_QUERY_VALUE_BATCH: 10;
export const TELEMETRY_TRACE_ID_BATCH: 1;
export const TELEMETRY_RETRY_DELAY_MS: 15000;
export function telemetryFilterNodeCount(filters: readonly Record<string, unknown>[]): number;
export function cloudflareRayId(value: string, label?: string): string;
export function clientRequestIdByPlatformRayId(ledger: readonly Record<string, unknown>[]): ReadonlyMap<string, string>;
export function cohortValuesFilter(key: string, values: readonly string[]): Readonly<{
  key: string;
  operation: "in";
  type: "string";
  value: string;
}>;
export function exportDeadline(ledger: readonly Record<string, unknown>[]): number;
export function buildTraceExportFailureEvidence(input: Readonly<{
  ledger: readonly Record<string, unknown>[];
  traces: readonly G30NormalizedTrace[];
  emittedRowInventory?: readonly G30EmittedRowInventoryEntry[];
  capturedAtMs?: number;
  deadlineMs: number;
  error?: unknown;
}>): G30TraceExportFailureEvidence;
export function acquireCohortTelemetry<T>(input: Readonly<{
  fetchCohort: () => Promise<unknown>;
  validate: (raw: unknown) => Promise<T> | T;
  deadlineMs: number;
  retry?: boolean;
  now?: () => number;
  sleepFor?: (milliseconds: number) => Promise<void>;
}>): Promise<Readonly<{ raw: unknown; value: T }>>;
export function queryTelemetry(input: Readonly<{
  accountId: string;
  token: string;
  payload: Record<string, unknown>;
}>): Promise<unknown>;
export interface RetainedSnapshotLogReceipt {
  requestId: string;
  platformRayId: string;
  correlationId: string;
  rootId: string;
  rootStartedAtMs: number;
  rootEndedAtMs: number;
  logTruncated: boolean;
}
export function retainedSnapshotLogReceipts(raw: unknown): readonly RetainedSnapshotLogReceipt[];
export function querySnapshotLogsInFixedWindow(input: Readonly<{
  accountId: string;
  token: string;
  template: Record<string, unknown>;
  fromMs: number;
  toMs: number;
  requestTelemetry?: (input: { accountId: string; token: string; payload: Record<string, unknown> }) => Promise<unknown> | unknown;
}>): Promise<Readonly<{
  window: Readonly<{ from: number; to: number }>;
  receipts: readonly RetainedSnapshotLogReceipt[];
}>>;
export function exportCohortTelemetry(input: Readonly<{
  accountId: string;
  token: string;
  template: Record<string, unknown>;
  ledger: readonly Record<string, unknown>[];
}>): Promise<{ events: unknown[] }>;
