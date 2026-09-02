import { describe, expect, it } from "vitest";

import manifest from "../contracts/commit-trace-manifest.json";
import { normalizeTelemetryBundle } from "../scripts/deploy/g30-trace-export.mjs";

const SERVICE = "g52-export-fixture";
const REQUEST_ID = "0000000000000052-SJC";
const CORRELATION = "g52-export-correlation";
const ROOT_ID = "g52-export-root";
const START = 1_000;
const END = 1_100;
const rows = manifest.schemas["sdt.commit/v1"].rows;
const successRows = manifest.schemas["sdt.commit/v1"].boundaries
  .find((boundary) => boundary.name === "success")!.requiredRows;

function actorClass(emitter: string): string {
  if (emitter === "root-worker") return "ROOT";
  if (emitter === "allocator-do") return "ALLOCATOR";
  if (emitter === "journal-do") return "JOURNAL";
  if (emitter === "callee-do") return "TAG";
  return "ROOT";
}

function attributes(rowId: string): Record<string, string | number | boolean> {
  const row = rows.find((candidate) => candidate.rowId === rowId)!;
  const preAdmission = rowId === "S01";
  const result: Record<string, string | number | boolean> = {
    "schema.version": "sdt.commit/v1",
    "correlation.id": CORRELATION,
    "service.id": SERVICE,
    "actor.class": actorClass(row.emitter),
    operation: row.span,
    "span.kind": row.kind,
    outcome: "success",
  };
  if (!preAdmission) {
    result["attempt.id"] = "00000000-0000-4000-8000-000000000052";
    result["actor.key_hash"] = "a".repeat(64);
  }
  if (/^S05([a-e])$/.test(rowId)) result["phase.ordinal"] = "abcde".indexOf(rowId.at(-1)!);
  if (manifest.attributeMatrix.attributes["member.index"].rowScope?.includes(rowId)) result["member.index"] = 0;
  if (manifest.attributeMatrix.attributes["tag.key_hash"].rowScope?.includes(rowId)) result["tag.key_hash"] = "b".repeat(64);
  if (rowId === "S00") {
    result["activation.first"] = false;
    result["script.version"] = "g52-fixture-version";
    result.colo = "SJC";
    result["http.status"] = 200;
  }
  return result;
}

function observation(event: "worker.invocation" | "do.handler", actorClassValue = "WORKER") {
  return {
    source: event === "worker.invocation"
      ? {
        schema: "sdt.observe/v1",
        event,
        emittedAtMs: END + 1,
        requestId: REQUEST_ID,
        correlationId: CORRELATION,
        actorClass: "WORKER",
        emittedWorkerRowIds: ["S00", "S01", "S02", "S03", "S04", "S05a", "S05b", "S05c", "S05d", "S06", "S07", "S08", "S10", "S11", "S12", "S13", "S14", "S15"],
        isolateInstanceId: "g52-fixture-isolate",
        activationFirst: false,
        scriptVersion: "g52-fixture-version",
        colo: "SJC",
        storageWrites: 0,
        usedForControl: false,
        exposedInPublicResponse: false,
      }
      : {
        schema: "sdt.observe/v1",
        event,
        emittedAtMs: END + 2,
        correlationId: CORRELATION,
        actorClass: actorClassValue,
        activationId: `g52-${actorClassValue}`,
        activationFirst: false,
        constructorToHandlerMs: 1,
        firstStorageReadMs: 1,
        subrequestWallMs: 2,
        storageWrites: 0,
        usedForControl: false,
        exposedInPublicResponse: false,
      },
    $metadata: { traceId: "g52-native-trace", requestId: "g52-provider-request", rayId: REQUEST_ID },
  };
}

function nativeTelemetry() {
  return {
    events: [
      ...successRows.map((rowId) => ({
        attributes: attributes(rowId),
        $metadata: {
          traceId: "g52-native-trace",
          requestId: "g52-provider-request",
          rayId: rowId === "S00" ? REQUEST_ID : undefined,
          startMs: START,
          endMs: END,
        },
      })),
      observation("worker.invocation"),
      observation("do.handler", "ALLOCATOR"),
      observation("do.handler", "TAG"),
    ],
  };
}

function snapshotTelemetry(omitRowId?: string | readonly string[]) {
  const omittedRows = new Set(omitRowId === undefined ? [] : Array.isArray(omitRowId) ? omitRowId : [omitRowId]);
  return {
    events: [
      {
        source: {
          schema: "sdt.commit-snapshot/v1",
          event: "commit.snapshot",
          snapshotSchema: "sdt.commit/v1",
          correlationId: CORRELATION,
          serviceId: SERVICE,
          platformRequestId: REQUEST_ID,
          rootId: ROOT_ID,
          rootStartedAtMs: START,
          rootEndedAtMs: END,
          runtimeVerification: { passed: true },
          rows: successRows
            .filter((rowId) => !omittedRows.has(rowId))
            .map((rowId) => ({
              rowId,
              name: rows.find((candidate) => candidate.rowId === rowId)!.span,
              "sdt.row.id": rowId,
              startOffsetMs: 0,
              endOffsetMs: END - START,
              durationMs: END - START,
              face: rowId === "S01" ? "pre-admission" : "accepted",
              clockDomain: "caller",
              zeroDurationPlatformLimited: false,
              attributes: attributes(rowId),
            })),
        },
        $metadata: { requestId: "g52-provider-request", rayId: REQUEST_ID },
      },
      observation("worker.invocation"),
      observation("do.handler", "ALLOCATOR"),
      observation("do.handler", "TAG"),
    ],
  };
}

function selectedRows(bundle: ReturnType<typeof normalizeTelemetryBundle>) {
  return bundle.traces[0]!.spans.map((span) => ({ rowId: span.rowId, startMs: span.startMs, endMs: span.endMs }));
}

describe("SDT-G52 log-root telemetry export", () => {
  it("reconstructs the same per-hop rows from a retained snapshot log as from native spans", () => {
    const clientRequestIdsByRayId = new Map([["0000000000000052", REQUEST_ID]]);
    const native = normalizeTelemetryBundle(nativeTelemetry(), END + 10, clientRequestIdsByRayId);
    const snapshot = normalizeTelemetryBundle(snapshotTelemetry(), END + 10, clientRequestIdsByRayId);

    expect(native.traces).toHaveLength(1);
    expect(snapshot.traces).toHaveLength(1);
    expect(native.traces[0]).toMatchObject({ rootSource: "native-span", complete: true, runtimeVerified: true });
    expect(snapshot.traces[0]).toMatchObject({ rootSource: "snapshot-log", snapshotLogTruncated: false, complete: true, runtimeVerified: true });
    expect(selectedRows(snapshot)).toEqual(selectedRows(native));
    expect(snapshot.observations.filter((entry) => entry.event === "do.handler")).toHaveLength(2);
  });

  it("keeps the native-root path authoritative when both root sources are retained", () => {
    const native = nativeTelemetry();
    const snapshot = snapshotTelemetry();
    const snapshotLog = snapshot.events.find((entry) => entry.source?.schema === "sdt.commit-snapshot/v1")!;
    const bundle = normalizeTelemetryBundle({ events: [...native.events, snapshotLog] }, END + 10);

    expect(bundle.traces).toHaveLength(1);
    expect(bundle.traces[0]).toMatchObject({ rootSource: "native-span" });
  });

  it("fails closed when a retained snapshot omits a mapped success row", () => {
    expect(() => normalizeTelemetryBundle(snapshotTelemetry("S14"), END + 10)).toThrow(/missing mapped success row/);
  });

  it("accepts a complete Worker snapshot without DO-owned callback rows", () => {
    const bundle = normalizeTelemetryBundle(snapshotTelemetry(["S09", "S16"]), END + 10);
    expect(bundle.traces[0]).toMatchObject({ rootSource: "snapshot-log", complete: true, runtimeVerified: true });
    expect(bundle.traces[0]?.spans.map((span) => span.rowId)).not.toContain("S09");
    expect(bundle.traces[0]?.spans.map((span) => span.rowId)).not.toContain("S16");
  });

  it("fails closed when Workers marks a retained snapshot log as truncated", () => {
    const telemetry = snapshotTelemetry();
    Object.assign(telemetry.events[0]!, { $cloudflare: { truncated: true } });
    expect(() => normalizeTelemetryBundle(telemetry, END + 10)).toThrow(/\$cloudflare\.truncated: true/);
  });
});
