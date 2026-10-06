export const TASK: "SDT-G50";
export const DEFAULT_SAMPLE_COUNT: 50;
export const DEFAULT_INGESTION_TIMEOUT_MS: number;
export const MAX_INGESTION_TIMEOUT_MS: number;
export const ACTIVE_PER_HOP_ROWS: readonly string[];
export const STRUCTURALLY_REMOVED_G41_ROWS: readonly string[];

export interface G50LedgerEntry {
  ordinal: number;
  phase: "discarded-warmup" | "sample";
  endpoint: "POST /api/commands/create-room";
  roomId: string;
  requestId: string;
  colo: string | null;
  startedAtMs: number;
  completedAtMs: number;
  clientLatencyMs: number;
  status: number;
  committedSuid: string;
}

export interface G50Telemetry {
  ingestion?: { status?: string; [key: string]: unknown };
  observedTraceCount?: number;
  schemaCompleteTraceCount?: number;
  descriptiveLossCount?: number;
  rootSourceCounts?: Readonly<Record<string, number>>;
  perHopDescriptiveMedians: readonly { rowId: string; observedSpanCount: number; medianMs: number | null }[];
  retainedTraceTelemetry?: {
    traces: readonly { requestId: string; rootSource?: string; spans?: readonly { rowId: string; startMs: number; endMs: number }[] }[];
    observations: readonly Record<string, unknown>[];
  };
  [key: string]: unknown;
}

export interface G50Sample {
  schema: string;
  task: string;
  protocol: {
    discardedWarmupRequests: number;
    discardedFailedRequests: number;
    acceptedSampleRequests: number;
    [key: string]: unknown;
  };
  warmup: G50LedgerEntry;
  ledger: readonly G50LedgerEntry[];
  client: { count: number; p50: number | null; p95: number | null };
  callerColoDistribution: Readonly<Record<string, number>>;
  telemetry: G50Telemetry;
  [key: string]: unknown;
}

export function captureG50AppCommitLatency(input: {
  baseUrl: string;
  accountId: string;
  observabilityToken: string;
  serviceId: string;
  versionId: string;
  sourceCommit: string;
  sampleCount?: number;
  ingestionTimeoutMs?: number;
  ingestionPollIntervalMs?: number;
  runId?: string;
  task?: string;
  queryTemplate: Record<string, unknown>;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  captureTelemetry?: (input: { ledger: readonly G50LedgerEntry[]; [key: string]: unknown }) => Promise<G50Telemetry> | G50Telemetry;
  sampleIntervalMs?: number;
  sleepFor?: (milliseconds: number) => Promise<void> | void;
  now?: () => number;
  onWarmupAccepted?: (entry: G50LedgerEntry) => Promise<void> | void;
  onSampleAccepted?: (entry: G50LedgerEntry, progress: { warmup: G50LedgerEntry; acceptedSampleRequests: number }) => Promise<void> | void;
}): Promise<G50Sample>;
