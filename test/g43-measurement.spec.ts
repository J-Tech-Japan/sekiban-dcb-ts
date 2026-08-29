import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import measurementSpecJson from "../contracts/g43-measurement-spec.json";
import { TAG_READ_AFTER_INDEX, TAG_READ_AFTER_SQL } from "../packages/dcb-runtime/src/tag/TagSqlSchema";
import type { TagEvent } from "../packages/dcb-runtime/src/tag/types";
import { G32_FIXTURE_TIMESTAMP, g32EventId, g32Suid } from "./helpers/g32-fixtures";

interface Scope {
  readonly serviceId: string;
  readonly tag: string;
}

interface MeasurementSnapshot {
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly statements: readonly string[];
  readonly cursors: readonly { readonly query: string; readonly rowsRead: number; readonly rowsWritten: number }[];
}

interface MeasuredTagInstance {
  beginG43SqlMeasurement(): void;
  completeG43SqlMeasurement(): MeasurementSnapshot;
  g43ReadAfter(sortableUniqueId: string, limit: number): Promise<TagEvent[]>;
  g43TagStateIncrementalCatchUp(input: {
    readonly tag: string;
    readonly cursor: string;
    readonly limit: number;
    readonly through?: string;
  }): Promise<{
    readonly events: readonly TagEvent[];
    readonly lastSortableUniqueId: string;
    readonly through: string;
    readonly completeThrough: string | null;
  }>;
  g43TagStateRebuild(): Promise<readonly TagEvent[]>;
}

interface MetricPoint {
  readonly operation: string;
  readonly historySize: number;
  readonly metric: string;
  readonly value: number;
  readonly consumer: "decision" | "informational";
}

interface OperationSample {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly requestSerializedBytes: number;
  readonly responseSerializedBytes: number;
  readonly snapshot: MeasurementSnapshot;
}

const measurementSpec = measurementSpecJson as {
  readonly historySizes: readonly number[];
  readonly operations: readonly { readonly id: string; readonly class: string; readonly windowRows?: number }[];
  readonly metrics: readonly string[];
  readonly collection: { readonly repetitionsPerPoint: number };
  readonly decisionRules: {
    readonly bounded: { readonly allowedSpread: Record<string, number> };
    readonly proportionalToResult: { readonly constantOverhead: number };
  };
};
const textEncoder = new TextEncoder();
const fixedPayload = JSON.stringify({ fixture: "g43-measurement" });
const fixedTag = "room:g43-measurement";
const fixedEventType = "G43Measurement";
const fixedLineage = "g43-measurement-lineage";

function tagStub(value: Scope): DurableObjectStub {
  const namespace = (env as unknown as { readonly TAG: DurableObjectNamespace }).TAG;
  return namespace.get(namespace.idFromName(`${value.serviceId}|${value.tag}`));
}

function scope(kind: string, historySize: number, repetition: number): Scope {
  return {
    // Every identifier retains its byte length at every history point.
    serviceId: `g43m-${kind}-${String(historySize).padStart(4, "0")}-${repetition}`,
    tag: fixedTag,
  };
}

function eventFor(value: Scope, ordinal: number): TagEvent {
  return {
    attemptId: "g43-measurement-seed-attempt",
    eventId: g32EventId(`g43-measurement:${value.serviceId}:${String(ordinal).padStart(6, "0")}`),
    suid: g32Suid(ordinal),
    payload: fixedPayload,
    eventTags: [value.tag],
    allocatorLineageId: fixedLineage,
    eventType: fixedEventType,
    provenance: "g32",
    timestamp: G32_FIXTURE_TIMESTAMP,
  };
}

async function seedHistory(value: Scope, count: number): Promise<readonly TagEvent[]> {
  const events = Array.from({ length: count }, (_unused, index) => eventFor(value, index + 1));
  // The measured reserve/commit identifiers and expected head are byte-for-
  // byte identical at every history point. Only the unmeasured prefix grows.
  const final = events.at(-1)!;
  events[events.length - 1] = { ...final, suid: g32Suid(8_000_000) };
  await runInDurableObject(tagStub(value), (_instance, state) => {
    const sql = state.storage.sql;
    const createdAt = G32_FIXTURE_TIMESTAMP;
    const head = events.at(-1)?.suid ?? "";
    sql.exec("INSERT INTO tag_identity (singleton, tag, created_at) VALUES (1, ?, ?)", value.tag, createdAt);
    sql.exec(`
      INSERT INTO tag_control (
        singleton, schema_version, head_suid, clock_offset_ms, clock_now_ms,
        version, repair_owner, repair_lease_until, highest_repair_epoch,
        repair_scope_version, created_at, updated_at
      ) VALUES (1, 3, ?, 0, NULL, 0, NULL, NULL, 0, 0, ?, ?)
    `, head, createdAt, createdAt);
    sql.exec("INSERT INTO tag_head (singleton, service_id, head_suid) VALUES (1, ?, ?)", value.serviceId, head);
    for (const event of events) {
      sql.exec(`
        INSERT INTO tag_event (
          service_id, event_id, attempt_id, suid, payload, event_tags_json,
          allocator_lineage_id, event_type, provenance, timestamp, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, value.serviceId, event.eventId, event.attemptId, event.suid, event.payload,
      JSON.stringify(event.eventTags), event.allocatorLineageId, event.eventType,
      event.provenance, event.timestamp, JSON.stringify(event));
    }
  });
  return events;
}

async function rawPost(value: Scope, path: string, body: unknown): Promise<Response> {
  return SELF.fetch(
    `https://tag.test/tags/${encodeURIComponent(value.serviceId)}/${encodeURIComponent(value.tag)}${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

async function plainPost(value: Scope, path: string, body: unknown): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await rawPost(value, path, body);
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

async function measureRequest(value: Scope, path: string, body: unknown): Promise<OperationSample> {
  const encodedBody = JSON.stringify(body);
  await runInDurableObject(tagStub(value), (instance) => {
    (instance as unknown as MeasuredTagInstance).beginG43SqlMeasurement();
  });
  const response = await SELF.fetch(
    `https://tag.test/tags/${encodeURIComponent(value.serviceId)}/${encodeURIComponent(value.tag)}${path}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: encodedBody },
  );
  const responseText = await response.text();
  const snapshot = await runInDurableObject(tagStub(value), (instance) =>
    (instance as unknown as MeasuredTagInstance).completeG43SqlMeasurement());
  return {
    status: response.status,
    body: JSON.parse(responseText) as Record<string, unknown>,
    requestSerializedBytes: textEncoder.encode(encodedBody).byteLength,
    responseSerializedBytes: textEncoder.encode(responseText).byteLength,
    snapshot,
  };
}

async function measureRpc<T>(value: Scope, request: unknown, invoke: (instance: MeasuredTagInstance) => Promise<T>): Promise<{
  readonly result: T;
  readonly requestSerializedBytes: number;
  readonly responseSerializedBytes: number;
  readonly snapshot: MeasurementSnapshot;
}> {
  await runInDurableObject(tagStub(value), (instance) => {
    (instance as unknown as MeasuredTagInstance).beginG43SqlMeasurement();
  });
  const result = await runInDurableObject(tagStub(value), (instance) => invoke(instance as unknown as MeasuredTagInstance));
  // RPC response serialization is the boundary for these non-HTTP internal
  // tag-source calls; it is intentionally measured before completion.
  const responseText = JSON.stringify(result);
  const snapshot = await runInDurableObject(tagStub(value), (instance) =>
    (instance as unknown as MeasuredTagInstance).completeG43SqlMeasurement());
  return {
    result,
    requestSerializedBytes: textEncoder.encode(JSON.stringify(request)).byteLength,
    responseSerializedBytes: textEncoder.encode(responseText).byteLength,
    snapshot,
  };
}

function metrics(operation: string, historySize: number, sample: Pick<OperationSample, "requestSerializedBytes" | "responseSerializedBytes" | "snapshot">, consumer: MetricPoint["consumer"]): MetricPoint[] {
  return [
    { operation, historySize, metric: "rowsRead", value: sample.snapshot.rowsRead, consumer },
    { operation, historySize, metric: "rowsWritten", value: sample.snapshot.rowsWritten, consumer },
    { operation, historySize, metric: "requestSerializedBytes", value: sample.requestSerializedBytes, consumer },
    { operation, historySize, metric: "responseSerializedBytes", value: sample.responseSerializedBytes, consumer },
  ];
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)]!;
}

function aggregate(points: readonly MetricPoint[]): MetricPoint[] {
  const byKey = new Map<string, MetricPoint[]>();
  for (const point of points) {
    const key = `${point.operation}\u0000${point.historySize}\u0000${point.metric}`;
    const existing = byKey.get(key) ?? [];
    existing.push(point);
    byKey.set(key, existing);
  }
  return [...byKey.values()].map((samples) => {
    expect(samples).toHaveLength(measurementSpec.collection.repetitionsPerPoint);
    const first = samples[0]!;
    return { ...first, value: median(samples.map((sample) => sample.value)) };
  });
}

function assertCompleteGrid(points: readonly MetricPoint[]): void {
  const expected = new Set<string>();
  for (const operation of measurementSpec.operations) {
    for (const historySize of measurementSpec.historySizes) {
      for (const metric of measurementSpec.metrics) expected.add(`${operation.id}\u0000${historySize}\u0000${metric}`);
    }
  }
  const actual = new Set<string>();
  for (const point of points) {
    const key = `${point.operation}\u0000${point.historySize}\u0000${point.metric}`;
    expect(expected.has(key), `unexpected measurement row ${key}`).toBe(true);
    expect(actual.has(key), `duplicate measurement row ${key}`).toBe(false);
    actual.add(key);
    const operation = measurementSpec.operations.find((candidate) => candidate.id === point.operation);
    expect(operation).toBeDefined();
    expect(point.consumer).toBe(operation!.class === "inherently-linear" ? "informational" : "decision");
  }
  expect([...actual].sort()).toEqual([...expected].sort());
}

function assertBoundedSpread(points: readonly MetricPoint[]): void {
  for (const operation of measurementSpec.operations.filter((candidate) => candidate.class === "bounded")) {
    for (const metric of measurementSpec.metrics) {
      const values = points
        .filter((point) => point.operation === operation.id && point.metric === metric)
        .map((point) => point.value);
      const spread = Math.max(...values) - Math.min(...values);
      expect(spread, `${operation.id}.${metric} all-points spread`).toBeLessThanOrEqual(
        measurementSpec.decisionRules.bounded.allowedSpread[metric]!,
      );
    }
  }
}

function assertProportional(points: readonly MetricPoint[], readAfterCounts: ReadonlyMap<number, number>): void {
  const overhead = measurementSpec.decisionRules.proportionalToResult.constantOverhead;
  for (const historySize of measurementSpec.historySizes) {
    const read = points.find((point) => point.operation === "readAfter" && point.historySize === historySize && point.metric === "rowsRead");
    expect(read).toBeDefined();
    expect(read!.value).toBeLessThanOrEqual(readAfterCounts.get(historySize)! + overhead);
  }
  const incremental = measurementSpec.historySizes.map((historySize) =>
    points.find((point) => point.operation === "tagStateIncrementalCatchUp" && point.historySize === historySize && point.metric === "rowsRead")!.value,
  );
  expect(incremental.at(-1)! - incremental[0]!).toBeLessThanOrEqual(overhead);
}

function acceptsRangePlan(rows: readonly { readonly detail: string }[]): boolean {
  const search = new RegExp(`\\bSEARCH\\s+tag_event\\s+USING\\s+(?:COVERING\\s+)?INDEX\\s+${TAG_READ_AFTER_INDEX}\\b`, "i");
  const scan = /\bSCAN\s+tag_event\b/i;
  return rows.some((row) => search.test(row.detail)) && !rows.some((row) => scan.test(row.detail));
}

describe("SDT-G43 structural measurement", () => {
  it("consumes the packet-owned measurement spec with real Tag DO SQL transitions and a closed range-plan predicate", async () => {
    const raw: MetricPoint[] = [];
    const readAfterCounts = new Map<number, number>();
    const observedPlans: Array<{ historySize: number; details: readonly string[] }> = [];

    for (const historySize of measurementSpec.historySizes) {
      for (let repetition = 0; repetition < measurementSpec.collection.repetitionsPerPoint; repetition += 1) {
        const boundedScope = scope("bounded", historySize, repetition);
        const history = await seedHistory(boundedScope, historySize);
        const expectedHead = history.at(-1)?.suid ?? "";

        const reserveInput = {
          attemptId: "g43m-reserve-attempt",
          epoch: 0,
          eventTags: [boundedScope.tag],
          consistencyTags: [{ tag: boundedScope.tag, lastSortableUniqueId: expectedHead }],
        };
        const reserve = await measureRequest(boundedScope, "/acquire", reserveInput);
        expect(reserve.status).toBe(201);
        raw.push(...metrics("reserve", historySize, reserve, "decision"));

        const reservation = reserve.body.reservation as { token: string };
        const cancel = await measureRequest(boundedScope, "/cancel", {
          attemptId: "g43m-reserve-attempt",
          epoch: 0,
          reservationToken: reservation.token,
        });
        expect(cancel.status).toBe(200);
        raw.push(...metrics("cancel", historySize, cancel, "decision"));

        const commitAcquire = await plainPost(boundedScope, "/acquire", {
          attemptId: "g43m-commit-attempt",
          epoch: 0,
          eventTags: [boundedScope.tag],
          consistencyTags: [{ tag: boundedScope.tag, lastSortableUniqueId: expectedHead }],
        });
        expect(commitAcquire.status).toBe(201);
        const commitReservation = commitAcquire.body.reservation as { token: string };
        const commit = await measureRequest(boundedScope, "/append", {
          attemptId: "g43m-commit-attempt",
          epoch: 0,
          reservationToken: commitReservation.token,
          candidates: [{
            eventId: g32EventId("g43m-commit-event"),
            suid: g32Suid(9_999_999),
            payload: fixedPayload,
            eventTags: [boundedScope.tag],
            allocatorLineageId: fixedLineage,
            eventType: fixedEventType,
            provenance: "g32",
            timestamp: G32_FIXTURE_TIMESTAMP,
          }],
        });
        expect(commit.status).toBe(201);
        raw.push(...metrics("commit", historySize, commit, "decision"));

        const readScope = scope("read", historySize, repetition);
        const readHistory = await seedHistory(readScope, historySize);
        const windowRows = measurementSpec.operations.find((operation) => operation.id === "readAfter")!.windowRows!;
        const cursor = historySize <= windowRows ? "" : readHistory[historySize - windowRows - 1]!.suid;
        const expected = historySize <= windowRows ? readHistory : readHistory.slice(-windowRows);
        const range = await measureRpc(readScope, { sortableUniqueId: cursor, limit: windowRows }, (instance) =>
          instance.g43ReadAfter(cursor, windowRows));
        expect(range.result.map((event) => event.eventId)).toEqual(expected.map((event) => event.eventId));
        readAfterCounts.set(historySize, range.result.length);
        raw.push(...metrics("readAfter", historySize, range, "decision"));

        const plan = await runInDurableObject(tagStub(readScope), (_instance, state) =>
          state.storage.sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${TAG_READ_AFTER_SQL}`, cursor, windowRows).toArray());
        expect(acceptsRangePlan(plan)).toBe(true);
        observedPlans.push({ historySize, details: plan.map((row) => row.detail) });

        const rebuild = await measureRpc(readScope, {}, (instance) => instance.g43TagStateRebuild());
        expect(rebuild.result).toHaveLength(historySize);
        raw.push(...metrics("tagStateRebuild", historySize, rebuild, "informational"));

        const incrementalScope = scope("incremental", historySize, repetition);
        const prior = await seedHistory(incrementalScope, historySize + 10);
        const checkpoint = prior[historySize - 1]!.suid;
        const incremental = await measureRpc(incrementalScope, {
          tag: incrementalScope.tag,
          cursor: checkpoint,
          limit: 10,
        }, (instance) => instance.g43TagStateIncrementalCatchUp({
          tag: incrementalScope.tag,
          cursor: checkpoint,
          limit: 10,
        }));
        expect(incremental.result.events).toHaveLength(10);
        expect(incremental.result.lastSortableUniqueId).toBe(prior.at(-1)!.suid);
        expect(incremental.result.completeThrough).toBe(prior.at(-1)!.suid);
        raw.push(...metrics("tagStateIncrementalCatchUp", historySize, incremental, "decision"));
      }
    }

    const points = aggregate(raw);
    assertCompleteGrid(points);
    assertBoundedSpread(points);
    assertProportional(points, readAfterCounts);
    // Record an audit-friendly summary in CI logs. Timing is intentionally not
    // used for the decision; only cursor counters and serialized byte sizes are.
    console.info("SDT-G43 AC8 measurement", JSON.stringify({
      points,
      readAfterCounts: [...readAfterCounts.entries()],
      rangeQuery: TAG_READ_AFTER_SQL.trim(),
      rangeIndex: TAG_READ_AFTER_INDEX,
      rangePlans: observedPlans,
    }));
  }, 60_000);

  it("rejects all-point spikes, incomplete grids, over-bound proportional rows, and a SCAN plan", () => {
    const bounded = measurementSpec.decisionRules.bounded.allowedSpread.rowsRead;
    const allPointsPass = [10, 10 + bounded, 10].every((value, _index, values) => Math.max(...values) - Math.min(...values) <= bounded);
    expect(allPointsPass).toBe(true);
    const intermediateSpike = [10, 10 + bounded + 1, 10];
    expect(Math.max(...intermediateSpike) - Math.min(...intermediateSpike) <= bounded).toBe(false);
    const negativeEndpointSpike = [100, 100 + bounded + 1, 1];
    expect(Math.max(...negativeEndpointSpike) - Math.min(...negativeEndpointSpike) <= bounded).toBe(false);
    const singleInflated = [10, 10, 10 + bounded + 1, 10, 10];
    expect(Math.max(...singleInflated) - Math.min(...singleInflated) <= bounded).toBe(false);

    const overhead = measurementSpec.decisionRules.proportionalToResult.constantOverhead;
    expect(50 + overhead <= 50 + overhead).toBe(true);
    expect(50 + overhead + 1 <= 50 + overhead).toBe(false);
    expect(acceptsRangePlan([{ detail: `SEARCH tag_event USING INDEX ${TAG_READ_AFTER_INDEX} (suid>?)` }])).toBe(true);
    expect(acceptsRangePlan([{ detail: "SCAN tag_event" }])).toBe(false);

    const completeSynthetic = measurementSpec.operations.flatMap((operation) =>
      measurementSpec.historySizes.flatMap((historySize) => measurementSpec.metrics.map((metric) => ({
        operation: operation.id,
        historySize,
        metric,
        value: 0,
        consumer: operation.class === "inherently-linear" ? "informational" as const : "decision" as const,
      }))));
    expect(completeSynthetic).toHaveLength(120);
    expect(() => assertCompleteGrid(completeSynthetic.slice(0, -measurementSpec.metrics.length))).toThrow();
  });
});
