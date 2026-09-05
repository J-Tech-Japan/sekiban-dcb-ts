import { beforeAll, describe, expect, it } from "vitest";
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
// @ts-expect-error Vite raw source migration import.
import g32Migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";
import { D1EventStore, D1IdentityConflictError } from "../packages/dcb-runtime/src/store/D1EventStore";
import { GlobalCompletenessReconciler } from "../packages/dcb-runtime/src/completeness/GlobalCompletenessReconciler";
import { scopeIdFor } from "../packages/dcb-runtime/src/scope/ScopeName";
import { TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/service/ServiceIdentityProvider";
import { TagDurableObject, G65_DERIVED_WRITE_BUDGET_MS } from "../packages/dcb-runtime/src/tag/TagDurableObject";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { g32Message } from "./helpers/g32-fixtures";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";

function statements(database: D1Database, sql: string): D1PreparedStatement[] {
  return sql.replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => database.prepare(statement));
}

function tagStorage(): DurableObjectStorage {
  const values = new Map<string, unknown>();
  const transaction: DurableObjectTransaction = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => { values.set(key, value); },
    delete: async (key: string) => values.delete(key),
    list: async () => new Map(),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  } as unknown as DurableObjectTransaction;
  return {
    get: transaction.get,
    put: transaction.put,
    delete: transaction.delete,
    deleteAll: async () => { values.clear(); },
    list: transaction.list,
    setAlarm: transaction.setAlarm,
    deleteAlarm: transaction.deleteAlarm,
    transaction: async <T>(callback: (txn: DurableObjectTransaction) => Promise<T>) => callback(transaction),
  } as unknown as DurableObjectStorage;
}

function candidate(serviceId: string, tag: string, identity = "g65"): Pick<
  DownstreamOutboxMessage,
  "eventId" | "suid" | "payload" | "eventTags" | "eventType" | "provenance" | "timestamp" | "allocatorLineageId"
> {
  const envelope = g32Message({
    serviceId,
    tag,
    attemptId: `${identity}-attempt`,
    eventId: `${identity}-event`,
    suid: `${identity}-suid`,
    payload: JSON.stringify({ eventType: "G65" }),
    eventTags: [tag],
    eventType: "G65",
    allocatorLineageId: "g65-lineage",
  });
  return {
    eventId: envelope.eventId,
    suid: envelope.suid,
    payload: envelope.payload,
    eventTags: envelope.eventTags,
    eventType: envelope.eventType,
    provenance: envelope.provenance,
    timestamp: envelope.timestamp,
    allocatorLineageId: envelope.allocatorLineageId,
  };
}

function database(): D1Database {
  const value = (env as unknown as { D1?: D1Database }).D1;
  if (value === undefined) throw new Error("G65 tests require the local D1 binding");
  return value;
}

function tags(): DurableObjectNamespace {
  const value = (env as unknown as { TAG?: DurableObjectNamespace }).TAG;
  if (value === undefined) throw new Error("G65 tests require the Tag Durable Object namespace");
  return value;
}

function realTagStub(serviceId: string, tag: string): DurableObjectStub {
  return tags().get(scopeIdFor(tags(), { serviceId, doClass: "tag", identity: tag }));
}

describe("SDT-G65 bounded two-lane admission", () => {
  beforeAll(async () => {
    const database = (env as unknown as { D1?: D1Database }).D1;
    if (database === undefined) throw new Error("G65 tests require the local D1 binding");
    const existing = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dcb_events'").first<{ name: string }>();
    if (existing === null || existing === undefined) {
      await database.batch(statements(database, g32Migration as string));
    }
    await applyG44D1Migration(database);
  });

  it("returns the commit after the direct doorbell budget when the receiver never resolves", async () => {
    const waits: Promise<unknown>[] = [];
    const serviceId = "g65-budget-service";
    const tag = "reservation:g65-budget";
    const storage = tagStorage();
    const instance = new TagDurableObject({
      storage,
      waitUntil: (promise: Promise<unknown>) => { waits.push(promise); },
    } as unknown as DurableObjectState, {
      AUTO_DRAIN_OUTBOX: "true",
      DOMAIN_DELIVERY_CLASS: "immediate-preferred",
      DIRECT_DOORBELL: "true",
      DIRECT_DOORBELL_ALLOWED_VIEWS: "ReservationProjector",
      DIRECT_DOORBELL_DEGRADATION: "queued-degraded",
      DOWNSTREAM_DOORBELL: {
        deliver: async () => new Promise<never>(() => {}),
      },
      DOWNSTREAM_QUEUE: {
        send: async () => ({}),
      },
    } as never);
    const started = performance.now();
    const response = await instance.fetch(new Request(
      `https://tag.test/append?__tag=${encodeURIComponent(tag)}&__serviceId=${serviceId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attemptId: "g65-attempt",
          epoch: 0,
          candidates: [candidate(serviceId, tag)],
        }),
      },
    ));
    const elapsedMs = performance.now() - started;

    expect(response.status).toBe(201);
    expect(response.headers.get("x-sdt-global-admission")).toBe("not-admitted");
    expect(elapsedMs).toBeGreaterThanOrEqual(G65_DERIVED_WRITE_BUDGET_MS - 25);
    expect(elapsedMs).toBeLessThan(G65_DERIVED_WRITE_BUDGET_MS + 500);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
  });

  it("uses the real shared D1 path for direct-first and Queue-first admission, duplicate replay, and conflict", async () => {
    for (const order of ["direct-first", "queue-first"] as const) {
      const serviceId = `g65-d1-order-${order}-${crypto.randomUUID()}`;
      const tag = `reservation:g65:d1:${order}:${crypto.randomUUID()}`;
      const first = g32Message({ serviceId, tag, eventId: `${order}-event`, suid: `${order}-suid`, attemptId: `${order}-attempt` });
      const store = new D1EventStore(database());
      await store.initialize();
      const sources = order === "direct-first" ? (["fast", "queue"] as const) : (["queue", "fast"] as const);
      await expect(store.recordDelivery(first, 10_000, sources[0])).resolves.toMatchObject({ outcome: "stored" });
      await expect(store.recordDelivery(first, 10_001, sources[1])).resolves.toMatchObject({ outcome: "stored" });
      const counts = await database().prepare(
        `SELECT
           (SELECT COUNT(*) FROM dcb_events WHERE "ServiceId" = ?) AS events,
           (SELECT COUNT(*) FROM serialized_dcb_global_memberships WHERE service_id = ?) AS memberships,
           (SELECT COUNT(*) FROM serialized_dcb_global_receipts WHERE service_id = ?) AS receipts,
           (SELECT COUNT(*) FROM serialized_dcb_source_partitions WHERE service_id = ?) AS partitions`,
      ).bind(serviceId, serviceId, serviceId, serviceId).first<{ events: number; memberships: number; receipts: number; partitions: number }>();
      expect(counts).toEqual({ events: 1, memberships: 1, receipts: 1, partitions: 1 });
      await expect(store.recordDelivery({ ...first, payload: JSON.stringify({ conflicting: true }) }, 10_002, "fast"))
        .rejects.toBeInstanceOf(D1IdentityConflictError);
      const afterConflict = await database().prepare(
        `SELECT COUNT(*) AS count FROM serialized_dcb_global_receipts WHERE service_id = ? AND partition_tag = ?`,
      ).bind(serviceId, tag).first<{ count: number }>();
      expect(afterConflict?.count).toBe(1);
    }
  });

  it("keeps source discoverability atomic with the real global event/membership/receipt batch", async () => {
    const serviceId = `g65-d1-atomic-${crypto.randomUUID()}`;
    const tag = `reservation:g65:atomic:${crypto.randomUUID()}`;
    const message = g32Message({ serviceId, tag, eventId: "atomic-event", suid: "atomic-suid" });
    const failing = new D1EventStore(database(), {
      beforeBatch: (_operation, statementsToRun, d1) => [...statementsToRun, d1.prepare("SELECT g65_missing_atomic_batch_table")],
    });
    await failing.initialize();
    await expect(failing.recordDelivery(message, 11_000, "fast")).rejects.toThrow(/g65_missing_atomic_batch_table/);
    const counts = await database().prepare(
      `SELECT
         (SELECT COUNT(*) FROM dcb_events WHERE "ServiceId" = ?) AS events,
         (SELECT COUNT(*) FROM serialized_dcb_global_receipts WHERE service_id = ?) AS receipts,
         (SELECT COUNT(*) FROM serialized_dcb_source_partitions WHERE service_id = ?) AS partitions`,
    ).bind(serviceId, serviceId, serviceId).first<{ events: number; receipts: number; partitions: number }>();
    expect(counts).toEqual({ events: 0, receipts: 0, partitions: 0 });
  });

  it("returns a real SQLite-backed public append while the runtime D1 binding is unavailable", async () => {
    const serviceId = `g65-unavailable-${crypto.randomUUID()}`;
    const tag = `reservation:g65:unavailable:${crypto.randomUUID()}`;
    const stub = realTagStub(serviceId, tag);
    const originalD1 = database();
    await runInDurableObject(stub, (instance) => {
      const runtime = instance as unknown as { env: { D1?: D1Database; AUTO_DRAIN_OUTBOX?: string } };
      runtime.env.D1 = undefined;
      runtime.env.AUTO_DRAIN_OUTBOX = "false";
    });
    try {
      const response = await SELF.fetch(
        `https://tag.test/tags/${encodeURIComponent(serviceId)}/${encodeURIComponent(tag)}/append`,
        {
          method: "POST",
          headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: serviceId },
          body: JSON.stringify({ attemptId: "g65-unavailable-attempt", epoch: 0, candidates: [candidate(serviceId, tag)] }),
        },
      );
      expect(response.status).toBe(201);
      expect(await response.clone().json()).not.toHaveProperty("globalAdmission");
      await runInDurableObject(stub, (_instance, state) => {
        const row = state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM tag_commit_receipt WHERE attempt_id = ?",
          "g65-unavailable-attempt",
        ).toArray()[0];
        expect(row?.count).toBe(1);
      });
    } finally {
      await runInDurableObject(stub, (instance) => {
        const runtime = instance as unknown as { env: { D1?: D1Database } };
        runtime.env.D1 = originalD1;
      });
    }
  });

  it("keeps a public SQLite commit independent of a hanging source-partition schema probe", async () => {
    const serviceId = `g65-source-probe-hang-${crypto.randomUUID()}`;
    const tag = `reservation:g65:source-probe-hang:${crypto.randomUUID()}`;
    const stub = realTagStub(serviceId, tag);
    const originalD1 = database();
    const hangingD1 = {
      prepare: () => ({ all: () => new Promise<never>(() => {}) }),
    } as unknown as D1Database;
    await runInDurableObject(stub, (instance) => {
      const runtime = instance as unknown as { env: { D1?: D1Database; AUTO_DRAIN_OUTBOX?: string } };
      runtime.env.D1 = hangingD1;
      runtime.env.AUTO_DRAIN_OUTBOX = "false";
    });
    try {
      const started = performance.now();
      const response = await SELF.fetch(
        `https://tag.test/tags/${encodeURIComponent(serviceId)}/${encodeURIComponent(tag)}/append`,
        {
          method: "POST",
          headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: serviceId },
          body: JSON.stringify({ attemptId: "g65-source-probe-hang-attempt", epoch: 0, candidates: [candidate(serviceId, tag, "g65-source-probe-hang")] }),
        },
      );
      const elapsedMs = performance.now() - started;
      expect(response.status).toBe(201);
      expect(elapsedMs).toBeLessThan(G65_DERIVED_WRITE_BUDGET_MS);
      expect(await response.clone().json()).not.toHaveProperty("globalAdmission");
    } finally {
      await runInDurableObject(stub, (instance) => {
        const runtime = instance as unknown as { env: { D1?: D1Database } };
        runtime.env.D1 = originalD1;
      });
    }
  });

  it("keeps a public SQLite commit independent of a source-partition INSERT failure", async () => {
    const serviceId = `g65-source-insert-failure-${crypto.randomUUID()}`;
    const tag = `reservation:g65:source-insert-failure:${crypto.randomUUID()}`;
    const stub = realTagStub(serviceId, tag);
    const originalD1 = database();
    const failingD1 = {
      prepare: (sql: string) => sql.includes('SELECT "EventDigest" FROM dcb_events')
        ? { all: async () => ({ results: [{}] }) }
        : { bind: () => ({ run: async () => { throw new Error("g65_source_partition_insert_failed"); } }) },
    } as unknown as D1Database;
    await runInDurableObject(stub, (instance) => {
      const runtime = instance as unknown as { env: { D1?: D1Database; AUTO_DRAIN_OUTBOX?: string } };
      runtime.env.D1 = failingD1;
      runtime.env.AUTO_DRAIN_OUTBOX = "false";
    });
    try {
      const started = performance.now();
      const response = await SELF.fetch(
        `https://tag.test/tags/${encodeURIComponent(serviceId)}/${encodeURIComponent(tag)}/append`,
        {
          method: "POST",
          headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: serviceId },
          body: JSON.stringify({ attemptId: "g65-source-insert-failure-attempt", epoch: 0, candidates: [candidate(serviceId, tag, "g65-source-insert-failure")] }),
        },
      );
      const elapsedMs = performance.now() - started;
      expect(response.status).toBe(201);
      expect(elapsedMs).toBeLessThan(G65_DERIVED_WRITE_BUDGET_MS);
      expect(await response.clone().json()).not.toHaveProperty("globalAdmission");
    } finally {
      await runInDurableObject(stub, (instance) => {
        const runtime = instance as unknown as { env: { D1?: D1Database } };
        runtime.env.D1 = originalD1;
      });
    }
  });

  it("retries source discoverability from durable Tag state after registration exhaustion without delivery", async () => {
    const serviceId = `g65-source-retry-${crypto.randomUUID()}`;
    const tag = `reservation:g65:source-retry:${crypto.randomUUID()}`;
    const stub = realTagStub(serviceId, tag);
    const originalD1 = database();
    const failingD1 = {
      prepare: () => ({ all: async () => { throw new Error("g65_source_registration_crashed"); } }),
    } as unknown as D1Database;
    await runInDurableObject(stub, (instance) => {
      const runtime = instance as unknown as { env: { D1?: D1Database; AUTO_DRAIN_OUTBOX?: string } };
      runtime.env.D1 = failingD1;
      runtime.env.AUTO_DRAIN_OUTBOX = "false";
    });
    try {
      const response = await SELF.fetch(
        `https://tag.test/tags/${encodeURIComponent(serviceId)}/${encodeURIComponent(tag)}/append`,
        {
          method: "POST",
          headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: serviceId },
          body: JSON.stringify({ attemptId: "g65-source-retry-attempt", epoch: 0, candidates: [candidate(serviceId, tag, "g65-source-retry")] }),
        },
      );
      expect(response.status).toBe(201);
      await new Promise<void>((resolve) => setTimeout(resolve, G65_DERIVED_WRITE_BUDGET_MS * 4));
      await runInDurableObject(stub, (_instance, state) => {
        const sql = (state.storage as unknown as { sql: SqlStorage }).sql;
        const row = sql.exec<{ status: string; attempt_count: number }>(`
          SELECT status, attempt_count
            FROM tag_source_partition_registration
           WHERE service_id = ? AND partition_tag = ?
        `, serviceId, tag).toArray()[0];
        expect(row?.status).toBe("pending");
        expect(Number(row?.attempt_count)).toBeGreaterThan(0);
      });

      await runInDurableObject(stub, (instance) => {
        const runtime = instance as unknown as { env: { D1?: D1Database } };
        runtime.env.D1 = originalD1;
      });
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      await expect(database().prepare(
        "SELECT last_obligation_sequence FROM serialized_dcb_source_partitions WHERE service_id = ? AND partition_tag = ?",
      ).bind(serviceId, tag).first<{ last_obligation_sequence: number }>()).resolves.toMatchObject({ last_obligation_sequence: 1 });
      await runInDurableObject(stub, (_instance, state) => {
        const sql = (state.storage as unknown as { sql: SqlStorage }).sql;
        expect(sql.exec<{ status: string }>(`
          SELECT status FROM tag_source_partition_registration
           WHERE service_id = ? AND partition_tag = ?
        `, serviceId, tag).toArray()[0]?.status).toBe("registered");
      });
      const scanner = new GlobalCompletenessReconciler(database(), tags());
      await expect(scanner.reconcile(serviceId, 12_000)).resolves.toMatchObject({ kind: "BLOCK", findingCount: 1 });
    } finally {
      await runInDurableObject(stub, (instance) => {
        const runtime = instance as unknown as { env: { D1?: D1Database } };
        runtime.env.D1 = originalD1;
      });
    }
  });

  it("returns after the bounded D1 admission attempt when the D1 binding never resolves", async () => {
    const waits: Promise<unknown>[] = [];
    let queueSent = 0;
    const serviceId = "g65-d1-budget-service";
    const tag = "reservation:g65-d1-budget";
    const instance = new TagDurableObject({
      storage: tagStorage(),
      waitUntil: (promise: Promise<unknown>) => { waits.push(promise); },
    } as unknown as DurableObjectState, {
      AUTO_DRAIN_OUTBOX: "true",
      DOMAIN_DELIVERY_CLASS: "immediate-preferred",
      DIRECT_DOORBELL: "true",
      DIRECT_DOORBELL_ALLOWED_VIEWS: "ReservationProjector",
      DIRECT_DOORBELL_DEGRADATION: "queued-degraded",
      D1: {
        prepare: () => ({ all: () => new Promise<never>(() => {}) }),
      } as unknown,
      DOWNSTREAM_DOORBELL: {
        deliver: async () => ({ fastDisposition: "completed" }),
      },
      DOWNSTREAM_QUEUE: {
        send: async () => { queueSent += 1; return {}; },
      },
    } as never);
    const started = performance.now();
    const response = await instance.fetch(new Request(
      `https://tag.test/append?__tag=${encodeURIComponent(tag)}&__serviceId=${serviceId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attemptId: "g65-attempt",
          epoch: 0,
          candidates: [candidate(serviceId, tag)],
        }),
      },
    ));
    const elapsedMs = performance.now() - started;

    expect(response.status).toBe(201);
    expect(response.headers.get("x-sdt-global-admission")).toBe("unknown");
    expect(elapsedMs).toBeGreaterThanOrEqual(G65_DERIVED_WRITE_BUDGET_MS - 25);
    expect(waits.length).toBeGreaterThan(0);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(queueSent).toBe(1);
  });

  it("keeps the committed response body/status identical while a counting D1 fake changes only admission status", async () => {
    const run = async (database: unknown, suffix: string) => {
      const serviceId = `g65-counting-${suffix}`;
      const tag = `reservation:g65-counting-${suffix}`;
      const instance = new TagDurableObject({
        storage: tagStorage(),
        waitUntil: () => {},
      } as unknown as DurableObjectState, {
        AUTO_DRAIN_OUTBOX: "true",
        DOMAIN_DELIVERY_CLASS: "immediate-preferred",
        DIRECT_DOORBELL: "true",
        DIRECT_DOORBELL_ALLOWED_VIEWS: "ReservationProjector",
        DIRECT_DOORBELL_DEGRADATION: "queued-degraded",
        D1: database,
        DOWNSTREAM_DOORBELL: { deliver: async () => ({ fastDisposition: "completed" }) },
        DOWNSTREAM_QUEUE: { send: async () => ({}) },
      } as never);
      const response = await instance.fetch(new Request(
        `https://tag.test/append?__tag=${encodeURIComponent(tag)}&__serviceId=${serviceId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            attemptId: "g65-counting-attempt",
            epoch: 0,
            candidates: [candidate(serviceId, tag)],
          }),
        },
      ));
      return {
        status: response.status,
        body: await response.json(),
        admission: response.headers.get("x-sdt-global-admission"),
      };
    };
    let prepareCount = 0;
    const base = (env as unknown as { D1?: D1Database }).D1;
    if (base === undefined) throw new Error("G65 counting-D1 test requires the local D1 binding");
    const countingD1 = {
      prepare: (sql: string) => {
        prepareCount += 1;
        return base.prepare(sql);
      },
      batch: (statementsToRun: D1PreparedStatement[]) => base.batch(statementsToRun),
    } as unknown as D1Database;
    const admitted = await run(countingD1, "success");
    const failed = await run({ prepare: () => { throw new Error("counting D1 outage"); } }, "failure");

    expect(admitted.status).toBe(201);
    expect(failed.status).toBe(admitted.status);
    expect(failed.body).toEqual(admitted.body);
    expect(admitted.admission).toBe("admitted");
    expect(failed.admission).toBe("not-admitted");
    expect(prepareCount).toBeGreaterThan(0);
  });
});
