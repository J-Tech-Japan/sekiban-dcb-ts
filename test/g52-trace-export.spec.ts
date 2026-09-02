import { describe, expect, it } from "vitest";

import manifest from "../contracts/commit-trace-manifest.json";
import {
  exportCohortWindowTelemetry,
  normalizeTelemetryBundle,
  querySnapshotLogsInFixedWindow,
  SNAPSHOT_LOG_DO_OWNED_ROWS,
  SNAPSHOT_LOG_REQUIRED_ROWS,
} from "../scripts/deploy/g30-trace-export.mjs";

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

function applyPermittedRetainedCorrelationPrefix(telemetry: ReturnType<typeof snapshotTelemetry>) {
  const fullCorrelation = "0123456789abcdef0123456789abcdef-full-s00-correlation";
  const retainedPrefix = fullCorrelation.slice(0, 32);
  const snapshot = telemetry.events[0]!.source as {
    correlationId: string;
    rows: Array<{ "sdt.row.id": string; attributes: Record<string, string | number | boolean> }>;
  };
  snapshot.correlationId = retainedPrefix;
  for (const row of snapshot.rows) row.attributes["correlation.id"] = fullCorrelation;
  const root = snapshot.rows.find((row) => row["sdt.row.id"] === "S00")!;
  const rootAttributes = root.attributes as Record<string, unknown>;
  const rootCorrelation = rootAttributes["correlation.id"];
  const rootService = rootAttributes["service.id"];
  const rootSchema = rootAttributes["schema.version"];
  delete rootAttributes["correlation.id"];
  delete rootAttributes["service.id"];
  delete rootAttributes["schema.version"];
  rootAttributes.correlation = { id: rootCorrelation };
  rootAttributes.service = { id: rootService };
  rootAttributes.schema = { version: rootSchema };
  for (const event of telemetry.events.slice(1)) event.source.correlationId = fullCorrelation;
  // A retained snapshot can join the client ledger through its explicit
  // platformRequestId even when the provider envelope does not repeat a ray.
  delete (telemetry.events[0]!.$metadata as { rayId?: string }).rayId;
  return { fullCorrelation, retainedPrefix };
}

function selectedRows(bundle: ReturnType<typeof normalizeTelemetryBundle>) {
  return bundle.traces[0]!.spans.map((span) => ({ rowId: span.rowId, startMs: span.startMs, endMs: span.endMs }));
}

describe("SDT-G52 log-root telemetry export", () => {
  it("uses the explicit fixed recovery window only for historical snapshot identity discovery", async () => {
    const result = await querySnapshotLogsInFixedWindow({
      accountId: "g52-export-account",
      token: "test-only-token",
      template: {
        parameters: {
          filterCombination: "or",
          filters: [
            { key: "$workers.scriptName", operation: "eq", type: "string", value: "primary" },
            { key: "$workers.scriptName", operation: "eq", type: "string", value: "receiver" },
          ],
        },
      },
      fromMs: 1_000,
      toMs: 2_000,
      requestTelemetry: async ({ payload }) => {
        const query = payload as { timeframe: { from: number; to: number }; parameters: { filters: unknown[] } };
        expect(query.timeframe).toEqual({ from: 1_000, to: 2_000 });
        expect(query.parameters.filters).toHaveLength(3);
        return snapshotTelemetry();
      },
    });
    expect(result.window).toEqual({ from: 1_000, to: 2_000 });
    expect(result.receipts).toEqual([expect.objectContaining({ requestId: REQUEST_ID, logTruncated: false })]);
  });

  it("uses only standard script/type filters over a persisted cohort window before client-side ray intersection", async () => {
    const telemetry = snapshotTelemetry();
    applyPermittedRetainedCorrelationPrefix(telemetry);
    const unrelated = structuredClone(observation("do.handler", "JOURNAL"));
    unrelated.$metadata.rayId = "0000000000000999-SJC";
    unrelated.source.correlationId = "unrelated-correlation";
    const calls: Array<Record<string, unknown>> = [];
    const result = await exportCohortWindowTelemetry({
      accountId: "g52-export-account",
      token: "test-only-token",
      template: {
        view: "events",
        limit: 2000,
        parameters: {
          filterCombination: "or",
          filters: [
            { key: "$workers.scriptName", operation: "eq", type: "string", value: "primary" },
            { key: "$workers.scriptName", operation: "eq", type: "string", value: "receiver" },
          ],
        },
      },
      ledger: [{ requestId: REQUEST_ID }],
      fromMs: START,
      toMs: END,
      requestTelemetry: async ({ payload }) => {
        calls.push(payload);
        const serialized = JSON.stringify(payload.parameters);
        return serialized.includes("sdt.commit-snapshot/v1")
          ? { events: [telemetry.events[0]] }
          : { events: [...telemetry.events.slice(1), unrelated] };
      },
    });

    expect(calls).toHaveLength(2);
    for (const payload of calls) {
      expect(payload.timeframe).toEqual({ from: START, to: END });
      expect(JSON.stringify(payload.parameters)).not.toContain("$metadata.rayId");
    }
    expect(result.resumeQuery).toMatchObject({
      shape: "persisted-cohort-window-standard-script-type-filters-client-side-exact-ray-intersection",
      window: { from: START, to: END },
      exactRayCount: 1,
      retainedSnapshotLogRootCount: 1,
      retainedDoHandlerObservationCount: 2,
    });
    expect(result.events).toHaveLength(4);
    expect(result.cohortDoHandlerObservations).toHaveLength(2);
    expect(normalizeTelemetryBundle(result, END + 10, new Map([["0000000000000052", REQUEST_ID]])).traces)
      .toMatchObject([{ requestId: REQUEST_ID, rootSource: "snapshot-log", complete: true }]);
  });

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

  it("uses platformRequestId as the client join while accepting a permitted retained correlation prefix", () => {
    const telemetry = snapshotTelemetry();
    const { fullCorrelation, retainedPrefix } = applyPermittedRetainedCorrelationPrefix(telemetry);
    const bundle = normalizeTelemetryBundle(telemetry, END + 10, new Map([["0000000000000052", REQUEST_ID]]));

    expect(retainedPrefix).toHaveLength(32);
    expect(bundle.traces).toMatchObject([{ requestId: REQUEST_ID, rootSource: "snapshot-log", complete: true }]);
    const root = bundle.traces[0]?.spans.find((span) => span.rowId === "S00");
    expect((root?.attributes as Record<string, unknown> | undefined)?.["correlation.id"])
      .toBe(fullCorrelation);
    expect(bundle.observations).toHaveLength(3);
  });

  it("fails closed for a short or nonmatching retained correlation prefix", () => {
    for (const invalidTopLevelCorrelationId of ["0123456789abcdef0123456789abcde", "fedcba9876543210fedcba9876543210"]) {
      const telemetry = snapshotTelemetry();
      applyPermittedRetainedCorrelationPrefix(telemetry);
      telemetry.events[0]!.source.correlationId = invalidTopLevelCorrelationId;

      expect(() => normalizeTelemetryBundle(telemetry, END + 10)).toThrow(/top-level identity/);
    }
  });

  it("keeps the native-root path authoritative when both root sources are retained", () => {
    const native = nativeTelemetry();
    const snapshot = snapshotTelemetry();
    const snapshotLog = snapshot.events.find((entry) => entry.source?.schema === "sdt.commit-snapshot/v1")!;
    const bundle = normalizeTelemetryBundle({ events: [...native.events, snapshotLog] }, END + 10);

    expect(bundle.traces).toHaveLength(1);
    expect(bundle.traces[0]).toMatchObject({ rootSource: "native-span" });
  });

  it("fails closed when a retained snapshot omits a Worker-owned mapped success row", () => {
    expect(SNAPSHOT_LOG_REQUIRED_ROWS).toContain("S10");
    expect(() => normalizeTelemetryBundle(snapshotTelemetry("S10"), END + 10)).toThrow(/missing mapped success row/);
  });

  it("accepts a Worker snapshot without any DO-owned member or callback row", () => {
    expect(SNAPSHOT_LOG_DO_OWNED_ROWS).toEqual(["S07", "S09", "S12", "S14", "S16"]);
    for (const rowId of SNAPSHOT_LOG_DO_OWNED_ROWS) {
      expect(SNAPSHOT_LOG_REQUIRED_ROWS).not.toContain(rowId);
    }
    const bundle = normalizeTelemetryBundle(snapshotTelemetry(SNAPSHOT_LOG_DO_OWNED_ROWS), END + 10);
    expect(bundle.traces[0]).toMatchObject({ rootSource: "snapshot-log", complete: true, runtimeVerified: true });
    for (const rowId of SNAPSHOT_LOG_DO_OWNED_ROWS) {
      expect(bundle.traces[0]?.spans.map((span) => span.rowId)).not.toContain(rowId);
    }
  });

  it("fails closed when Workers marks a retained snapshot log as truncated", () => {
    const telemetry = snapshotTelemetry();
    Object.assign(telemetry.events[0]!, { $cloudflare: { truncated: true } });
    expect(() => normalizeTelemetryBundle(telemetry, END + 10)).toThrow(/\$cloudflare\.truncated: true/);
  });
});
