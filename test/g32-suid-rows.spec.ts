import { describe, expect, it } from "vitest";
import {
  AllocatorDurableObject,
  allocateOrderRange,
  formatSortableUniqueId,
  handleDownstreamQueue,
  observeLegacySortableUniqueIdDecision,
  parseBootstrapDump,
  processDownstreamDoorbell,
  safeWindowCutoffSuid,
  unixMsToDotNetTicks,
  UnsafeWindowMaterializedViewStore,
} from "@sekiban/dcb-runtime";
import { D1EventStore } from "@sekiban/dcb-runtime/d1";
import { validateCommitEnvelope } from "../packages/dcb-runtime/src/commit/CommitWorker";
import { handleSerializedQuery } from "../packages/dcb-runtime/src/http/SerializedQueryWorker";
import { g32EventId, g32Message } from "./helpers/g32-fixtures";
// @ts-expect-error Immutable fixture table is an independent allocator oracle.
import goldenSource from "../fixtures/suid-allocator-golden.json?raw";

type GoldenRow = { readonly rowId: string; readonly input: Record<string, unknown>; readonly expect: Record<string, unknown> };
type Golden = { readonly rows: readonly GoldenRow[] };
const golden = JSON.parse(goldenSource as string) as Golden;
const eventId = g32EventId("g32-suid-row-event");
const tick = unixMsToDotNetTicks("1787414836102");
const oldSuid = "suid-00000000000000000001787414836102";

function row(rowId: string): GoldenRow {
  const value = golden.rows.find((entry) => entry.rowId === rowId);
  if (value === undefined) throw new Error(`missing golden ${rowId}`);
  return value;
}

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

function allocator(storage: DurableObjectStorage, clock: () => bigint): AllocatorDurableObject {
  return new AllocatorDurableObject({ storage } as unknown as DurableObjectState, undefined, { tick: clock });
}

function allocationRequest(body: unknown): Request {
  return new Request("https://allocator.g32/allocate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function invalidDump(): unknown {
  return {
    manifest: {
      format: "sekiban-dcb-bootstrap",
      version: 1,
      source: { serviceId: "source", lineageId: "lineage" },
      target: { serviceId: "target", allocatorLineageId: "lineage" },
      highWatermark: oldSuid,
      eventCount: 1,
      tagCounts: { "room:row": 1 },
      contentDigest: "not-reached",
      canonicalization: "utf8-json-sorted-keys-v1",
    },
    events: [{
      eventId,
      suid: oldSuid,
      payload: "{}",
      eventTags: ["room:row"],
      eventType: "RoomCreated",
      provenance: { origin: "g32" },
      timestamp: "2026-08-22T17:00:00.123Z",
      causationId: eventId,
      correlationId: "SerializedCommit",
      executedUser: "SerializedSekibanExecutor",
    }],
  };
}

describe("SDT-G32 allocator row-by-row production oracles", () => {
  it("M1 decodes all 30 characters before deriving the watermark tick", () => {
    const fixture = row("M1");
    const range = allocateOrderRange(fixture.input.watermark as string, 1, BigInt(fixture.input.unixMs as string), { suffixes: [1n] });
    expect(range.observedTicks?.toString().padStart(19, "0")).toBe(fixture.expect.observedTicks);
    expect(range.baseTicks.toString().padStart(19, "0")).toBe(fixture.expect.baseTicks);
  });

  it("M2 converts Unix milliseconds to .NET ticks exactly", () => {
    const fixture = row("M2");
    const range = allocateOrderRange(null, 1, BigInt(fixture.input.unixMs as string), { suffixes: [1n] });
    expect(range.physicalTicks.toString().padStart(19, "0")).toBe(fixture.expect.physicalTicks);
    expect(range.baseTicks.toString().padStart(19, "0")).toBe(fixture.expect.baseTicks);
  });

  it("M2a chooses the physical tick when it is ahead of the observed watermark", () => {
    const fixture = row("M2a");
    const range = allocateOrderRange(fixture.input.watermark as string, 1, BigInt(fixture.input.unixMs as string), { suffixes: [2n] });
    expect(range.baseTicks.toString().padStart(19, "0")).toBe(fixture.expect.baseTicks);
  });

  it("M2b advances from observed watermark plus one tick", () => {
    const fixture = row("M2b");
    const range = allocateOrderRange(fixture.input.watermark as string, 3, BigInt(fixture.input.unixMs as string), { suffixes: [3n, 4n, 5n] });
    expect(range.suids.map((value) => value.slice(0, 19))).toEqual(fixture.expect.vectorTicks);
  });

  it("M3 converts to BigInt before multiplying ticks", () => {
    const fixture = row("M3");
    expect(unixMsToDotNetTicks(fixture.input.unixMs as string).toString()).toBe(fixture.expect.ticks);
    expect(unixMsToDotNetTicks(fixture.input.unixMs as string).toString()).not.toBe(fixture.expect.mutantTicks);
  });

  it("M4 persists one byte-identical vector per attempt", async () => {
    const storage = fakeAllocatorStorage();
    const subject = allocator(storage.storage, () => 1_787_414_836_102n);
    const input = { attemptId: "m4", candidates: [{ candidateIndex: 0, eventId }, { candidateIndex: 1, eventId: g32EventId("m4-second") }] };
    const first = await subject.fetch(allocationRequest(input));
    const replay = await subject.fetch(allocationRequest(input));
    expect(first.status).toBe(201);
    expect(await replay.json()).toEqual(await first.clone().json());
  });

  it("M5 rolls back vector, watermark, and attempt together", async () => {
    const storage = fakeAllocatorStorage();
    const subject = allocator(storage.storage, () => 1_787_414_836_102n);
    const before = storage.snapshot();
    const response = await subject.fetch(allocationRequest({
      attemptId: "m5", candidates: [{ candidateIndex: 0, eventId }], faultInjection: "between-vector-and-watermark",
    }));
    expect(response.status).toBe(503);
    expect(storage.snapshot()).toEqual(before);
  });

  it("M6 routes a raw 37-character SUID through the retired-format decision before seed write", async () => {
    const storage = fakeAllocatorStorage();
    const subject = allocator(storage.storage, () => 1_787_414_836_102n);
    const observed: string[] = [];
    await observeLegacySortableUniqueIdDecision((value) => observed.push(value), async () => {
      const response = await subject.fetch(new Request("https://allocator.g32/seed-after", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ importId: "m6", leaseEpoch: 1, highWatermark: oldSuid }),
      }));
      expect(response.status).toBe(400);
    });
    expect(observed).toEqual([oldSuid]);
    expect(storage.snapshot()).toEqual({});
  });

  it("M7 fails before write when a complete vector would exceed .NET ticks", async () => {
    const fixture = row("M7");
    const storage = fakeAllocatorStorage({
      "allocator-state": {
        schemaVersion: 5,
        allocatorLineageId: "m7-lineage",
        // The immutable fixture, not a runtime constant, defines the C# max
        // boundary. Otherwise a widened production max mutates the setup and
        // lets the ceiling oracle remain vacuously green.
        allocatedWatermark: formatSortableUniqueId(BigInt(fixture.input.baseTicks as string), 0n),
        bootstrapSeed: null,
        lastRollbackWarningFingerprint: null,
      },
    });
    const subject = allocator(storage.storage, () => 1_787_414_836_102n);
    const before = storage.snapshot();
    const response = await subject.fetch(allocationRequest({
      attemptId: "m7", candidates: Array.from({ length: 5 }, (_, candidateIndex) => ({ candidateIndex, eventId: g32EventId(`m7-${candidateIndex}`) })),
    }));
    expect(response.status).toBe(409);
    expect(storage.snapshot()).toEqual(before);
  });

  it("M8 derives the twenty-second SafeWindow cutoff in tick space", () => {
    const fixture = row("M8");
    expect(safeWindowCutoffSuid(100_000, 0)).toBe(formatSortableUniqueId(unixMsToDotNetTicks(100_000 - Number(fixture.input.boundSeconds) * 1_000), 0n));
  });

  it("M9 sends every old SUID ingress through the shared retired-format decision before durable work", async () => {
    const observed: string[] = [];
    let storeInitializes = 0;
    let mvPrepares = 0;
    let d1QueryCalls = 0;
    const waitTargetDatabase = {
      prepare: () => ({
        all: async () => {
          d1QueryCalls += 1;
          return { results: [] };
        },
      }),
    } as unknown as D1Database;
    const directWaitTarget = new D1EventStore(waitTargetDatabase);
    await directWaitTarget.initialize();
    d1QueryCalls = 0;
    await observeLegacySortableUniqueIdDecision((value) => observed.push(value), async () => {
      const observe = async (label: string, run: () => Promise<void> | void): Promise<void> => {
        const before = observed.length;
        await run();
        expect(observed.slice(before), `${label} must reach the shared retired-SUID decision`).toEqual([oldSuid]);
      };
      await observe("commit", () => {
        const commit = validateCommitEnvelope({
          version: 1,
          eventCandidates: [{ payload: "e30=", eventPayloadName: "RoomCreated", tags: ["room:row"] }],
          consistencyTags: [{ tag: "room:row", lastSortableUniqueId: oldSuid }],
        });
        expect("error" in commit && commit.error.status).toBe(400);
      });

      for (const path of ["query", "list-query"] as const) {
        await observe(path, async () => {
          const response = await handleSerializedQuery(new Request(`https://query.test/api/sekiban/serialized/${path}`, {
            method: "POST", headers: { "content-type": "application/json", "x-sdt-g9-test-service-id": "m9" },
            body: JSON.stringify({ queryType: path === "query" ? "GetMeetingRoom" : "GetMeetingRooms", queryParamsJson: "{}", waitForSortableUniqueId: oldSuid }),
          }), {}, { store: { initialize: async () => { storeInitializes += 1; } } as never });
          expect(response.status).toBe(400);
        });
      }

      await observe("bootstrap dump", () => expect(() => parseBootstrapDump(invalidDump())).toThrow(/record/i));

      const invalid = { ...g32Message({ serviceId: "m9", tag: "room:row", eventId, suid: "m9" }), suid: oldSuid };
      await observe("queue", async () => {
        await handleDownstreamQueue({ messages: [{ body: invalid, ack: () => { throw new Error("must not ack"); }, retry: () => {} }] } as unknown as MessageBatch<unknown>, {}, {
          store: { initialize: async () => { storeInitializes += 1; } } as never,
        });
      });
      await observe("doorbell", async () => {
        await expect(processDownstreamDoorbell(invalid, {}, {
          store: { initialize: async () => { storeInitializes += 1; } } as never,
        })).rejects.toThrow(/invalid outbox/i);
      });
      await observe("D1 wait-target lookup", async () => {
        await expect(directWaitTarget.readWaitForTarget("m9", oldSuid)).rejects.toThrow(/30 ASCII decimal digits/);
      });

      const database = {
        prepare: () => { mvPrepares += 1; throw new Error("must not prepare"); },
        batch: async () => { throw new Error("must not batch"); },
      } as unknown as D1Database;
      const view = new UnsafeWindowMaterializedViewStore(database);
      await observe("materialized-view", async () => {
        await expect(view.apply({
          serviceId: "m9", viewId: "rows", generation: 1, eventId, suid: oldSuid, safeHead: "", updatedAt: 1,
          mutations: { rowUpserts: [], rowPatches: [], rowDeletes: [], indexEntries: [], indexDeletes: [] },
        })).rejects.toThrow(/30 ASCII decimal digits/);
      });
    });
    expect(new Set(observed)).toEqual(new Set([oldSuid]));
    expect(observed).toHaveLength(8);
    expect(storeInitializes).toBe(0);
    expect(mvPrepares).toBe(0);
    expect(d1QueryCalls).toBe(0);
  });

  it("M10 leaves no allocation state when the clock fails", async () => {
    const storage = fakeAllocatorStorage();
    const subject = allocator(storage.storage, () => { throw new Error("clock unavailable"); });
    const before = storage.snapshot();
    const response = await subject.fetch(allocationRequest({ attemptId: "m10", candidates: [{ candidateIndex: 0, eventId }] }));
    expect(response.status).toBe(503);
    expect(storage.snapshot()).toEqual(before);
  });

  it("M11 emits one warning per rollback window without changing the allocation base", async () => {
    const storage = fakeAllocatorStorage({
      "allocator-state": { schemaVersion: 5, allocatorLineageId: "m11-lineage", allocatedWatermark: formatSortableUniqueId(tick, 0n), bootstrapSeed: null, lastRollbackWarningFingerprint: null },
    });
    const subject = allocator(storage.storage, () => 1_787_414_836_101n);
    const warnings: unknown[] = [];
    const original = console.warn;
    console.warn = (value: unknown) => { warnings.push(value); };
    try {
      expect((await subject.fetch(allocationRequest({ attemptId: "m11-a", candidates: [{ candidateIndex: 0, eventId }] }))).status).toBe(201);
      expect((await subject.fetch(allocationRequest({ attemptId: "m11-b", candidates: [{ candidateIndex: 0, eventId: g32EventId("m11-b") }] }))).status).toBe(201);
    } finally {
      console.warn = original;
    }
    expect(warnings).toHaveLength(1);
  });

  it("M12 derives ordering only from the OrderClock, never business input", async () => {
    const firstStorage = fakeAllocatorStorage();
    const secondStorage = fakeAllocatorStorage();
    const first = allocator(firstStorage.storage, () => 1_787_414_836_102n);
    const second = allocator(secondStorage.storage, () => 1_787_414_836_102n);
    // The allocator contract intentionally accepts an opaque non-empty event
    // identifier.  These unequal strings make a business-input-derived clock
    // mutation observable instead of accidentally using two same-length UUIDs.
    const firstVector = await first.fetch(allocationRequest({ attemptId: "m12-a", candidates: [{ candidateIndex: 0, eventId: "a" }] }));
    const secondVector = await second.fetch(allocationRequest({ attemptId: "m12-b", candidates: [{ candidateIndex: 0, eventId: "business-input-must-not-order" }] }));
    const firstSuid = ((await firstVector.json()) as { candidates: readonly { suid: string }[] }).candidates[0]?.suid;
    const secondSuid = ((await secondVector.json()) as { candidates: readonly { suid: string }[] }).candidates[0]?.suid;
    expect(firstSuid?.slice(0, 19)).toBe(tick.toString().padStart(19, "0"));
    expect(secondSuid?.slice(0, 19)).toBe(tick.toString().padStart(19, "0"));
  });
});
