import { describe, expect, it } from "vitest";

import type { CommitTraceSnapshot, CommitTraceSpan } from "../packages/dcb-runtime/src/trace/CommitTrace";
import {
  COMMIT_SNAPSHOT_LOG_BYTE_BUDGET,
  assertCommitSnapshotLogSize,
  commitSnapshotLogRecord,
  createCommitTraceConsoleSink,
  encodedCommitSnapshotLogBytes,
} from "../packages/dcb-runtime/src/trace/CommitTraceConsoleSink";

const SERVICE = "g52-snapshot-fixture";
const CORRELATION = "g52-correlation";
const ROOT_ID = "g52-root";
/**
 * A successful multi-tag command records one root plus stage/member records.
 * Sixty-four rows is deliberately above the current success-path fanout used
 * by the sample while remaining a realistic deployed command envelope.
 */
const LARGEST_REALISTIC_S_ROW_COUNT = 64;

function span(rowId: string, index: number, root = false): CommitTraceSpan {
  const startMs = 1_000 + index * 3;
  const endMs = startMs + 2;
  return {
    rowId,
    schema: "sdt.commit/v1",
    face: root ? "accepted" : rowId === "S01" ? "pre-admission" : "accepted",
    span: root ? "sdt.commit" : `fixture.${rowId}`,
    emitter: root ? "root-worker" : "caller-worker",
    logicalParent: root ? null : "S00",
    rootId: ROOT_ID,
    clockDomain: "caller",
    startMs: root ? 1_000 : startMs,
    endMs: root ? 1_400 : endMs,
    present: true,
    attributes: {
      "schema.version": "sdt.commit/v1",
      "correlation.id": CORRELATION,
      "service.id": SERVICE,
      operation: root ? "sdt.commit" : `fixture.${rowId}`,
      "span.kind": "internal",
      outcome: "success",
      ...(root ? { "attempt.id": "00000000-0000-4000-8000-000000000052", "http.status": 200 } : {}),
    },
    zeroDurationPlatformLimited: false,
  };
}

function successfulSnapshot(rowCount = 4): CommitTraceSnapshot {
  const rows = [span("S00", 0, true)];
  for (let index = 1; index < rowCount; index += 1) rows.push(span(index % 2 === 0 ? "S12" : "S07", index));
  return {
    schema: "sdt.commit/v1",
    rootId: ROOT_ID,
    correlationId: CORRELATION,
    serviceId: SERVICE,
    spans: rows,
    provider: { scriptVersion: "g52-fixture", colo: "SJC" },
    diagnostics: {},
    runtimeVerification: { passed: true },
  };
}

describe("SDT-G52 retained commit snapshot sink", () => {
  it("emits one structured snapshot record for a successful commit with the known CF-Ray", () => {
    const records: unknown[] = [];
    const sink = createCommitTraceConsoleSink({
      platformRequestId: "0000000000000052-SJC",
      log: (record) => records.push(record),
    });

    sink.record(successfulSnapshot());

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      schema: "sdt.commit-snapshot/v1",
      event: "commit.snapshot",
      correlationId: CORRELATION,
      serviceId: SERVICE,
      platformRequestId: "0000000000000052-SJC",
      snapshotSchema: "sdt.commit/v1",
    });
    expect((records[0] as { rows: Array<Record<string, unknown>> }).rows[0]).toMatchObject({
      rowId: "S00",
      name: "sdt.commit",
      "sdt.row.id": "S00",
      startOffsetMs: 0,
      endOffsetMs: 400,
      durationMs: 400,
    });
  });

  it("does not create a retained snapshot record for a non-success outcome", () => {
    const accepted = successfulSnapshot();
    const rejected: CommitTraceSnapshot = {
      ...accepted,
      spans: accepted.spans.map((span, index) => index === 0
        ? { ...span, attributes: { ...span.attributes, outcome: "http-409", "http.status": 409 } }
        : span),
    };
    expect(commitSnapshotLogRecord(rejected, { platformRequestId: "0000000000000052-SJC" })).toBeUndefined();
  });

  it("keeps the largest realistic S-row projection well below the Workers Logs limit", () => {
    const record = commitSnapshotLogRecord(successfulSnapshot(LARGEST_REALISTIC_S_ROW_COUNT), {
      platformRequestId: "0000000000000052-SJC",
    });
    expect(record).toBeDefined();
    const encodedBytes = assertCommitSnapshotLogSize(record!);
    expect(record!.rows).toHaveLength(LARGEST_REALISTIC_S_ROW_COUNT);
    expect(encodedBytes).toBeLessThan(COMMIT_SNAPSHOT_LOG_BYTE_BUDGET);
  });

  it("fails deterministically instead of silently truncating an oversized snapshot", () => {
    const record = commitSnapshotLogRecord(successfulSnapshot(), { platformRequestId: "0000000000000052-SJC" })!;
    const oversized = structuredClone(record) as unknown as {
      rows: Array<{ attributes: Record<string, unknown> }>;
    };
    oversized.rows[0]!.attributes.padding = "x".repeat(COMMIT_SNAPSHOT_LOG_BYTE_BUDGET);
    expect(encodedCommitSnapshotLogBytes(oversized as unknown as typeof record)).toBeGreaterThan(COMMIT_SNAPSHOT_LOG_BYTE_BUDGET);
    expect(() => assertCommitSnapshotLogSize(oversized as unknown as typeof record)).toThrow(/budget/);

    const rejectedSize: unknown[] = [];
    const emitted: unknown[] = [];
    const sink = createCommitTraceConsoleSink({
      log: (value) => emitted.push(value),
      reportRejectedSize: (value) => rejectedSize.push(value),
    });
    const ordinarySnapshot = successfulSnapshot();
    const oversizedSnapshot: CommitTraceSnapshot = {
      ...ordinarySnapshot,
      spans: ordinarySnapshot.spans.map((span, index) => index === 0
        ? { ...span, attributes: { ...span.attributes, padding: "x".repeat(COMMIT_SNAPSHOT_LOG_BYTE_BUDGET) } }
        : span),
    };
    expect(() => sink.record(oversizedSnapshot)).toThrow(/budget/);
    expect(emitted).toHaveLength(0);
    expect(rejectedSize).toHaveLength(1);
  });
});
