import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  AllocatorDurableObject,
  DOTNET_MAX_TICKS,
  UnsafeWindowMaterializedViewStore,
  allocateOrderRange,
  assertSortableUniqueId,
  createUuidV7,
  formatSortableUniqueId,
  handleDownstreamQueue,
  isUuidV7,
  parseBootstrapDump,
  processDownstreamDoorbell,
  safeWindowCutoffSuid,
  unixMsToDotNetTicks,
} from "@sekiban/dcb-runtime";
import { validateCommitEnvelope } from "../packages/dcb-runtime/src/commit/CommitWorker";
import { D1EventStore } from "../packages/dcb-runtime/src/store/D1EventStore";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { handleSerializedQuery } from "../packages/dcb-runtime/src/http/SerializedQueryWorker";
// @ts-expect-error Vite raw asset import
import g32Migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";
// @ts-expect-error Vite raw asset import
import goldenSource from "../fixtures/suid-allocator-golden.json?raw";

type GoldenFixture = {
  readonly requiredRowIds: readonly string[];
  readonly vectors: {
    readonly unixMsToTicks: readonly { readonly unixMs: string; readonly ticks: string }[];
    readonly invalidUnixMs: readonly string[];
    readonly invalidSuids: readonly string[];
  };
  readonly rows: readonly { readonly rowId: string; readonly input: Record<string, unknown>; readonly expect: Record<string, unknown> }[];
};

const golden = JSON.parse(goldenSource as string) as GoldenFixture;
const eventId = "018f9c51-6b74-7f5e-8ca1-0123456789ab";
const tick = unixMsToDotNetTicks("1787414836102");
const suid = formatSortableUniqueId(tick, 1n);

function fakeAllocatorStorage(seed: Record<string, unknown> = {}): {
  readonly storage: DurableObjectStorage;
  readonly snapshot: () => Record<string, unknown>;
} {
  const values = new Map(Object.entries(seed));
  const direct = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => { values.set(key, structuredClone(value)); },
    delete: async (key: string) => { values.delete(key); },
    list: async () => new Map(),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };
  return {
    storage: {
      ...direct,
      deleteAll: async () => { values.clear(); },
      transaction: async <T>(callback: (txn: DurableObjectTransaction) => Promise<T>) => {
        const staged = new Map([...values].map(([key, value]) => [key, structuredClone(value)]));
        const transaction = {
          get: async <Value>(key: string) => staged.get(key) as Value | undefined,
          put: async <Value>(key: string, value: Value) => { staged.set(key, structuredClone(value)); },
          delete: async (key: string) => { staged.delete(key); },
          list: async () => new Map(staged),
          setAlarm: async () => {},
          deleteAlarm: async () => {},
        } as unknown as DurableObjectTransaction;
        const result = await callback(transaction);
        values.clear();
        for (const [key, value] of staged) values.set(key, value);
        return result;
      },
    } as unknown as DurableObjectStorage,
    snapshot: () => structuredClone(Object.fromEntries(values)),
  };
}

async function allocatorRequest(
  allocator: AllocatorDurableObject,
  body: unknown,
): Promise<Response> {
  return allocator.fetch(new Request("https://allocator.g32/allocate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function d1(): Promise<D1Database> {
  const database = (env as unknown as { D1?: D1Database }).D1;
  if (database === undefined) throw new Error("G32 D1 fixture requires the D1 binding");
  const statements = (g32Migration as string)
    .replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  await database.batch(statements.map((statement) => database.prepare(statement)));
  return database;
}

function message(overrides: Partial<DownstreamOutboxMessage> = {}): DownstreamOutboxMessage {
  return {
    version: 1,
    serviceId: "g32-parity-service",
    tag: "room:parity",
    eventId,
    suid,
    payload: "{\"roomId\":\"room-1\", \"name\":\"kept byte-for-byte\"}",
    eventTags: ["room:parity", "reservation:parity"],
    eventType: "RoomCreated",
    provenance: "g32",
    timestamp: "2026-08-22T17:00:00.123Z",
    causationId: eventId,
    correlationId: "SerializedCommit",
    executedUser: "SerializedSekibanExecutor",
    attemptId: "g32-attempt",
    allocatorLineageId: "g32-lineage",
    enqueuedAt: 1_000,
    ...overrides,
  };
}

describe("SDT-G32 C# parity", () => {
  it("has every independently named M-row exactly once", () => {
    expect(new Set(golden.requiredRowIds).size).toBe(golden.requiredRowIds.length);
    expect(golden.rows.map((row) => row.rowId).sort()).toEqual([...golden.requiredRowIds].sort());
  });

  it("M1/M2/M2a/M2b/M3 use C# fixed-width tick arithmetic", () => {
    for (const vector of golden.vectors.unixMsToTicks) {
      expect(unixMsToDotNetTicks(vector.unixMs).toString().padStart(19, "0")).toBe(vector.ticks);
    }
    for (const value of golden.vectors.invalidUnixMs) {
      expect(() => unixMsToDotNetTicks(value)).toThrow();
    }
    for (const value of golden.vectors.invalidSuids) {
      expect(() => assertSortableUniqueId(value)).toThrow();
    }

    const m1 = golden.rows.find((row) => row.rowId === "M1")!;
    const m1Range = allocateOrderRange(m1.input.watermark as string, 1, BigInt(m1.input.unixMs as string), { suffixes: [1n] });
    expect(m1Range.observedTicks?.toString().padStart(19, "0")).toBe(m1.expect.observedTicks);
    expect(m1Range.baseTicks.toString().padStart(19, "0")).toBe(m1.expect.baseTicks);

    const m2 = golden.rows.find((row) => row.rowId === "M2")!;
    const m2Range = allocateOrderRange(m2.input.watermark as string | null, 1, BigInt(m2.input.unixMs as string), { suffixes: [1n] });
    expect(m2Range.physicalTicks.toString().padStart(19, "0")).toBe(m2.expect.physicalTicks);
    expect(m2Range.baseTicks.toString().padStart(19, "0")).toBe(m2.expect.baseTicks);

    const m2a = golden.rows.find((row) => row.rowId === "M2a")!;
    const m2aRange = allocateOrderRange(m2a.input.watermark as string, 1, BigInt(m2a.input.unixMs as string), { suffixes: [2n] });
    expect(m2aRange.baseTicks.toString().padStart(19, "0")).toBe(m2a.expect.baseTicks);

    const m2b = golden.rows.find((row) => row.rowId === "M2b")!;
    const m2bRange = allocateOrderRange(m2b.input.watermark as string, 3, BigInt(m2b.input.unixMs as string), { suffixes: [3n, 4n, 5n] });
    expect(m2bRange.suids.map((value) => value.slice(0, 19))).toEqual(m2b.expect.vectorTicks);

    const m3 = golden.rows.find((row) => row.rowId === "M3")!;
    expect(unixMsToDotNetTicks(m3.input.unixMs as string).toString()).toBe(m3.expect.ticks);
    expect(unixMsToDotNetTicks(m3.input.unixMs as string).toString()).not.toBe(m3.expect.mutantTicks);
  });

  it("M4/M5/M6/M7/M10 keep the durable allocator atomic and retry-stable", async () => {
    const storage = fakeAllocatorStorage();
    const allocator = new AllocatorDurableObject(
      { storage: storage.storage } as unknown as DurableObjectState,
      undefined,
      { tick: () => 1_787_414_836_102n },
    );
    const input = {
      attemptId: "g32-replay-attempt",
      candidates: [{ candidateIndex: 0, eventId }, { candidateIndex: 1, eventId: "018f9c51-6b74-7f5e-8ca1-0123456789ac" }],
    };
    const first = await allocatorRequest(allocator, input);
    const firstBody = await first.json();
    const replay = await allocatorRequest(allocator, input);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);

    const beforeFault = storage.snapshot();
    const failed = await allocatorRequest(allocator, {
      ...input,
      attemptId: "g32-atomic-fault",
      faultInjection: "between-vector-and-watermark",
    });
    expect(failed.status).toBe(503);
    expect(storage.snapshot()).toEqual(beforeFault);

    const oldSeed = await allocator.fetch(new Request("https://allocator.g32/seed-after", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ importId: "g32-import", leaseEpoch: 1, highWatermark: "suid-00000000000000000001787414836102" }),
    }));
    expect(oldSeed.status).toBe(400);

    const ceilingStorage = fakeAllocatorStorage({
      "allocator-state": {
        schemaVersion: 5,
        allocatorLineageId: "g32-ceiling-lineage",
        allocatedWatermark: formatSortableUniqueId(DOTNET_MAX_TICKS - 1n, 0n),
        bootstrapSeed: null,
        lastRollbackWarningFingerprint: null,
      },
    });
    const ceilingAllocator = new AllocatorDurableObject(
      { storage: ceilingStorage.storage } as unknown as DurableObjectState,
      undefined,
      { tick: () => 1_787_414_836_102n },
    );
    const beforeCeiling = ceilingStorage.snapshot();
    const ceiling = await allocatorRequest(ceilingAllocator, {
      attemptId: "g32-ceiling-attempt",
      candidates: Array.from({ length: 5 }, (_, candidateIndex) => ({ candidateIndex, eventId: `ceiling-${candidateIndex}` })),
    });
    expect(ceiling.status).toBe(409);
    expect(ceilingStorage.snapshot()).toEqual(beforeCeiling);

    const clockFailureStorage = fakeAllocatorStorage();
    const clockFailureAllocator = new AllocatorDurableObject(
      { storage: clockFailureStorage.storage } as unknown as DurableObjectState,
      undefined,
      { tick: () => { throw new Error("clock unavailable"); } },
    );
    const beforeClockFailure = clockFailureStorage.snapshot();
    const clockFailure = await allocatorRequest(clockFailureAllocator, {
      attemptId: "g32-clock-failure",
      candidates: [{ candidateIndex: 0, eventId: "clock-failure" }],
    });
    expect(clockFailure.status).toBe(503);
    expect(clockFailureStorage.snapshot()).toEqual(beforeClockFailure);
  });

  it("M8/M11/M12 enforce SafeWindow ticks, rollback warning semantics, and clock-only order", async () => {
    expect(suid).toMatch(/^\d{30}$/);
    expect(suid.slice(0, 19)).toBe(tick.toString().padStart(19, "0"));
    expect(isUuidV7(createUuidV7(1_787_414_836_102))).toBe(true);
    expect(safeWindowCutoffSuid(100_000, 0)).toBe(formatSortableUniqueId(unixMsToDotNetTicks(80_000), 0n));
    expect(safeWindowCutoffSuid(200_000, 120_000)).toBe(formatSortableUniqueId(unixMsToDotNetTicks(80_000), 0n));

    const rollbackStorage = fakeAllocatorStorage({
      "allocator-state": {
        schemaVersion: 5,
        allocatorLineageId: "g32-rollback-lineage",
        allocatedWatermark: formatSortableUniqueId(tick, 0n),
        bootstrapSeed: null,
        lastRollbackWarningFingerprint: null,
      },
    });
    const rollbackAllocator = new AllocatorDurableObject(
      { storage: rollbackStorage.storage } as unknown as DurableObjectState,
      undefined,
      { tick: () => 1_787_414_836_101n },
    );
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (value: unknown) => { warnings.push(value); };
    try {
      const first = await allocatorRequest(rollbackAllocator, { attemptId: "rollback-1", candidates: [{ candidateIndex: 0, eventId: "rollback-a" }] });
      const second = await allocatorRequest(rollbackAllocator, { attemptId: "rollback-2", candidates: [{ candidateIndex: 0, eventId: "rollback-b" }] });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toHaveLength(1);

    const businessIndependentA = allocateOrderRange(null, 1, 1_787_414_836_102n, { suffixes: [77n] });
    const businessIndependentB = allocateOrderRange(null, 1, 1_787_414_836_102n, { suffixes: [77n] });
    expect(businessIndependentA.suids).toEqual(businessIndependentB.suids);
    expect(businessIndependentA.suids[0]!.slice(0, 19)).toBe(tick.toString().padStart(19, "0"));
  });

  it("M9 rejects an old SUID at commit admission before any durable actor", () => {
    const rejected = validateCommitEnvelope({
      version: 1,
      eventCandidates: [{ payload: "e30=", eventPayloadName: "RoomCreated", eventPayloadVersion: 1, tags: ["room:parity"] }],
      consistencyTags: [],
    });
    expect("error" in rejected && rejected.error.status).toBe(400);
    const noLegacySuid = validateCommitEnvelope({
      version: 1,
      eventCandidates: [{ payload: "e30=", eventPayloadName: "RoomCreated", tags: ["room:parity"] }],
      consistencyTags: [{ tag: "room:parity", lastSortableUniqueId: "suid-00000000000000000001787414836102" }],
    });
    expect("error" in noLegacySuid && noLegacySuid.error.status).toBe(400);
  });

  it("M9 rejects old SUIDs at list-query and waitFor before the source store", async () => {
    let calls = 0;
    const store = { initialize: async () => { calls += 1; } };
    for (const path of ["list-query", "query"]) {
      const response = await handleSerializedQuery(new Request(`https://query.test/api/sekiban/serialized/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queryType: path === "list-query" ? "GetMeetingRooms" : "GetMeetingRoom",
          queryParamsJson: "{}",
          waitForSortableUniqueId: "suid-00000000000000000001787414836102",
        }),
      }), { SDT_SERVICE_ID: "g32-query" }, { store: store as never });
      expect(response.status).toBe(400);
    }
    expect(calls).toBe(0);
  });

  it("M9 rejects old SUIDs at bootstrap and dump restore parsing", () => {
    const invalid = {
      manifest: {
        format: "sekiban-dcb-bootstrap",
        version: 1,
        source: { serviceId: "source", lineageId: "lineage" },
        target: { serviceId: "target", allocatorLineageId: "lineage" },
        highWatermark: "suid-00000000000000000001787414836102",
        eventCount: 1,
        tagCounts: { "room:parity": 1 },
        contentDigest: "not-reached",
        canonicalization: "utf8-json-sorted-keys-v1",
      },
      events: [{
        eventId,
        suid: "suid-00000000000000000001787414836102",
        payload: "{}",
        eventTags: ["room:parity"],
        eventType: "RoomCreated",
        provenance: { origin: "g32" },
        timestamp: "2026-08-22T17:00:00.123Z",
        causationId: eventId,
        correlationId: "SerializedCommit",
        executedUser: "SerializedSekibanExecutor",
      }],
    };
    expect(() => parseBootstrapDump(invalid)).toThrow(/record/i);
    expect(() => parseBootstrapDump(structuredClone(invalid))).toThrow(/record/i);
  });

  it("M9 rejects old SUIDs at Queue and doorbell before store initialization", async () => {
    let initializes = 0;
    const invalid = { ...message(), suid: "suid-00000000000000000001787414836102" } as unknown;
    const queued = { body: invalid, ack: () => { throw new Error("must not ack"); }, retry: () => {} };
    await handleDownstreamQueue({ messages: [queued] } as unknown as MessageBatch<unknown>, {}, {
      store: { initialize: async () => { initializes += 1; } } as never,
    });
    await expect(processDownstreamDoorbell(invalid, {}, {
      store: { initialize: async () => { initializes += 1; } } as never,
    })).rejects.toThrow(/invalid outbox/i);
    expect(initializes).toBe(0);
  });

  it("M9 rejects old SUIDs at MV apply before the first D1 statement", async () => {
    let prepares = 0;
    const database = {
      prepare: () => { prepares += 1; throw new Error("must not prepare"); },
      batch: async () => { throw new Error("must not batch"); },
    } as unknown as D1Database;
    const view = new UnsafeWindowMaterializedViewStore(database);
    await expect(view.apply({
      serviceId: "g32-mv",
      viewId: "rooms",
      generation: 1,
      eventId,
      suid: "suid-00000000000000000001787414836102",
      safeHead: "",
      updatedAt: 1,
      mutations: { rowUpserts: [], rowPatches: [], rowDeletes: [], indexEntries: [], indexDeletes: [] },
    })).rejects.toThrow(/30 ASCII decimal digits/);
    expect(prepares).toBe(0);
  });

  it("writes the C# logical D1 record with payload bytes and tag order unchanged", async () => {
    const database = await d1();
    const store = new D1EventStore(database);
    await store.initialize();
    const delivered = await store.recordDelivery(message(), 1_250, "queue");
    expect(delivered.kind).toBe("stored");
    const row = await database.prepare(
      `SELECT "ServiceId" AS serviceId, "Id" AS id, "SortableUniqueId" AS sortableUniqueId,
              "EventType" AS eventType, "Payload" AS payload, "Tags" AS tags, "Timestamp" AS timestamp,
              "CausationId" AS causationId, "CorrelationId" AS correlationId, "ExecutedUser" AS executedUser
         FROM dcb_events WHERE "ServiceId" = ? AND "Id" = ?`,
    ).bind("g32-parity-service", eventId).first<Record<string, unknown>>();
    expect(row).toEqual({
      serviceId: "g32-parity-service",
      id: eventId,
      sortableUniqueId: suid,
      eventType: "RoomCreated",
      payload: "{\"roomId\":\"room-1\", \"name\":\"kept byte-for-byte\"}",
      tags: "[\"room:parity\",\"reservation:parity\"]",
      timestamp: "2026-08-22T17:00:00.123Z",
      causationId: eventId,
      correlationId: "SerializedCommit",
      executedUser: "SerializedSekibanExecutor",
    });
    await expect(store.recordDelivery(message({ executedUser: "wrong" }), 1_300, "queue")).rejects.toThrow(/metadata/);

    const imported = message({
      serviceId: "g32-import",
      eventId: "550e8400-e29b-41d4-a716-446655440000",
      suid: formatSortableUniqueId(tick + 1n, 2n),
      causationId: null,
      correlationId: null,
      executedUser: null,
    });
    await expect(store.recordDelivery(imported, 1_400, "import")).resolves.toMatchObject({ kind: "stored" });
    const importedRow = await database.prepare(
      'SELECT "CausationId" AS causationId, "CorrelationId" AS correlationId, "ExecutedUser" AS executedUser FROM dcb_events WHERE "ServiceId" = ? AND "Id" = ?',
    ).bind("g32-import", imported.eventId).first<Record<string, unknown>>();
    expect(importedRow).toEqual({ causationId: null, correlationId: null, executedUser: null });
  });
});
