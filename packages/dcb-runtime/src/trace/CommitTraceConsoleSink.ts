/**
 * Retained Workers Logs projection for a successful in-process commit trace.
 *
 * This module deliberately projects an already-frozen CommitTraceSnapshot; it
 * neither creates a span nor participates in the commit protocol.  Keeping
 * the log schema separate also avoids extending the sealed sdt.commit/v1
 * attribute matrix just to make a console payload queryable.
 */
import type {
  CommitTraceSink,
  CommitTraceSnapshot,
  CommitTraceSpan,
  TraceAttributeValue,
} from "./CommitTrace";

export const COMMIT_SNAPSHOT_LOG_SCHEMA = "sdt.commit-snapshot/v1" as const;
export const COMMIT_SNAPSHOT_LOG_EVENT = "commit.snapshot" as const;
/** Leave a substantial margin below the 256 KiB Workers Logs record limit. */
export const COMMIT_SNAPSHOT_LOG_BYTE_BUDGET = 192 * 1024;

export interface CommitSnapshotLogRow {
  readonly rowId: string;
  readonly name: string;
  /** Explicit log-only row identity; it does not alter native span attributes. */
  readonly "sdt.row.id": string;
  readonly startOffsetMs: number;
  readonly endOffsetMs: number;
  readonly durationMs: number;
  readonly face: CommitTraceSpan["face"];
  readonly clockDomain: CommitTraceSpan["clockDomain"];
  readonly zeroDurationPlatformLimited: boolean;
  readonly attributes: Readonly<Record<string, TraceAttributeValue>>;
}

export interface CommitSnapshotLogRecord {
  readonly schema: typeof COMMIT_SNAPSHOT_LOG_SCHEMA;
  readonly event: typeof COMMIT_SNAPSHOT_LOG_EVENT;
  readonly snapshotSchema: "sdt.commit/v1";
  readonly correlationId: string;
  readonly serviceId: string;
  /** The ingress CF-Ray when the hosting Worker knows it. */
  readonly platformRequestId?: string;
  readonly rootId: string;
  readonly rootStartedAtMs: number;
  readonly rootEndedAtMs: number;
  readonly rows: readonly CommitSnapshotLogRow[];
  readonly provider: CommitTraceSnapshot["provider"];
  readonly runtimeVerification?: CommitTraceSnapshot["runtimeVerification"];
}

export interface CommitTraceConsoleSinkOptions {
  readonly platformRequestId?: string;
  /** Test seam; production defaults to the structured Workers Logs transport. */
  readonly log?: (record: CommitSnapshotLogRecord) => void;
  /** A bounded receipt if the deterministic guard refuses an oversized log. */
  readonly reportRejectedSize?: (receipt: Readonly<{
    schema: typeof COMMIT_SNAPSHOT_LOG_SCHEMA;
    event: "commit.snapshot-size-rejected";
    serviceId: string;
    correlationId: string;
    encodedBytes: number;
    byteBudget: number;
  }>) => void;
}

function successfulRoot(snapshot: CommitTraceSnapshot): CommitTraceSpan | undefined {
  if (snapshot.schema !== "sdt.commit/v1") return undefined;
  const root = snapshot.spans.find((span) => span.rowId === "S00" && span.logicalParent === null);
  if (root === undefined || root.face !== "accepted") return undefined;
  if (typeof root.attributes["attempt.id"] !== "string" || root.attributes["attempt.id"].length === 0) return undefined;
  return root.attributes.outcome === "success" && root.attributes["http.status"] === 200 ? root : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function rowForLog(span: CommitTraceSpan, root: CommitTraceSpan): CommitSnapshotLogRow {
  const startOffsetMs = span.startMs - root.startMs;
  const endOffsetMs = span.endMs - root.startMs;
  return Object.freeze({
    rowId: span.rowId,
    name: span.span,
    "sdt.row.id": span.rowId,
    startOffsetMs,
    endOffsetMs,
    durationMs: Math.max(0, span.endMs - span.startMs),
    face: span.face,
    clockDomain: span.clockDomain,
    zeroDurationPlatformLimited: span.zeroDurationPlatformLimited,
    attributes: Object.freeze({ ...span.attributes }),
  });
}

/**
 * Returns the one retained-log record for a successful V1 commit. Rejected,
 * no-op, partial, and failed paths deliberately produce no snapshot log.
 */
export function commitSnapshotLogRecord(
  snapshot: CommitTraceSnapshot,
  options: Pick<CommitTraceConsoleSinkOptions, "platformRequestId"> = {},
): CommitSnapshotLogRecord | undefined {
  const root = successfulRoot(snapshot);
  if (root === undefined) return undefined;
  return Object.freeze({
    schema: COMMIT_SNAPSHOT_LOG_SCHEMA,
    event: COMMIT_SNAPSHOT_LOG_EVENT,
    snapshotSchema: "sdt.commit/v1",
    correlationId: snapshot.correlationId,
    serviceId: snapshot.serviceId,
    ...(nonEmpty(options.platformRequestId) === undefined ? {} : { platformRequestId: nonEmpty(options.platformRequestId) }),
    rootId: snapshot.rootId,
    rootStartedAtMs: root.startMs,
    rootEndedAtMs: root.endMs,
    rows: Object.freeze(snapshot.spans.map((span) => rowForLog(span, root))),
    provider: Object.freeze({ ...snapshot.provider }),
    ...(snapshot.runtimeVerification === undefined ? {} : { runtimeVerification: snapshot.runtimeVerification }),
  });
}

export function encodedCommitSnapshotLogBytes(record: CommitSnapshotLogRecord): number {
  return new TextEncoder().encode(JSON.stringify(record)).byteLength;
}

export function assertCommitSnapshotLogSize(record: CommitSnapshotLogRecord): number {
  const encodedBytes = encodedCommitSnapshotLogBytes(record);
  if (encodedBytes > COMMIT_SNAPSHOT_LOG_BYTE_BUDGET) {
    const error = new Error(
      `Commit snapshot log is ${encodedBytes} bytes; budget is ${COMMIT_SNAPSHOT_LOG_BYTE_BUDGET} bytes`,
    ) as Error & { code?: string; encodedBytes?: number };
    error.code = "commit-snapshot-log-size";
    error.encodedBytes = encodedBytes;
    throw error;
  }
  return encodedBytes;
}

const workersConsoleLog = (record: CommitSnapshotLogRecord): void => {
  // Workers Logs indexes members of object console records directly.
  console.log(record);
};

const workersConsoleRejectedSize = (receipt: Readonly<{
  schema: typeof COMMIT_SNAPSHOT_LOG_SCHEMA;
  event: "commit.snapshot-size-rejected";
  serviceId: string;
  correlationId: string;
  encodedBytes: number;
  byteBudget: number;
}>): void => {
  // Never silently truncate a record. This compact, bounded receipt names the
  // observation loss while CommitTrace still returns the original response.
  console.error(receipt);
};

/**
 * Observation-only CommitTrace sink used by Cloudflare Worker compositions.
 * Its only side effect is one structured console record for an accepted HTTP
 * 200 commit; failure is rethrown for CommitTrace's existing fail-open receipt.
 */
export function createCommitTraceConsoleSink(options: CommitTraceConsoleSinkOptions = {}): CommitTraceSink {
  const log = options.log ?? workersConsoleLog;
  const reportRejectedSize = options.reportRejectedSize ?? workersConsoleRejectedSize;
  return Object.freeze({
    record(snapshot: CommitTraceSnapshot): void {
      const record = commitSnapshotLogRecord(snapshot, options);
      if (record === undefined) return;
      try {
        assertCommitSnapshotLogSize(record);
      } catch (error) {
        const encodedBytes = typeof error === "object" && error !== null && "encodedBytes" in error
          && typeof (error as { encodedBytes?: unknown }).encodedBytes === "number"
          ? (error as { encodedBytes: number }).encodedBytes
          : encodedCommitSnapshotLogBytes(record);
        reportRejectedSize(Object.freeze({
          schema: COMMIT_SNAPSHOT_LOG_SCHEMA,
          event: "commit.snapshot-size-rejected",
          serviceId: record.serviceId,
          correlationId: record.correlationId,
          encodedBytes,
          byteBudget: COMMIT_SNAPSHOT_LOG_BYTE_BUDGET,
        }));
        throw error;
      }
      log(record);
    },
  });
}
