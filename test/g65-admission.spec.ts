import { beforeAll, describe, expect, it } from "vitest";
import { env, runInDurableObject, SELF } from "cloudflare:test";
// @ts-expect-error Vite raw source migration import.
import g32Migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";
import { D1EventStore, D1IdentityConflictError } from "../packages/dcb-runtime/src/store/D1EventStore";
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

function candidate(serviceId: string, tag: string, identity = "g65", suid = `${identity}-suid`): Pick<
  DownstreamOutboxMessage,
  "eventId" | "suid" | "payload" | "eventTags" | "eventType" | "provenance" | "timestamp" | "allocatorLineageId"
> {
  const envelope = g32Message({
    serviceId,
    tag,
    attemptId: `${identity}-attempt`,
    eventId: `${identity}-event`,
    suid,
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

const PUBLIC_COMMIT_SERVICE_ID = "local-test-runtime";

function publicCandidate(tag: string, identity: string): Record<string, unknown> {
  return {
    payload: btoa(JSON.stringify({ value: identity })),
    eventPayloadName: "G65PublicCommitEvent",
    tags: [tag],
  };
}

async function publicCommit(
  eventCandidates: readonly Record<string, unknown>[],
  consistencyTags: readonly Record<string, unknown>[],
): Promise<Response> {
  return SELF.fetch("https://commit.test/api/sekiban/serialized/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1, eventCandidates, consistencyTags }),
  });
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

  it("keeps the pre-G65 first-append path when the completeness binding is unavailable", async () => {
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
      expect(await response.clone().json()).toMatchObject({ status: "appended" });
      await runInDurableObject(stub, (_instance, state) => {
        const rows = state.storage.sql.exec<{ events: number; receipts: number }>(`
          SELECT
            (SELECT COUNT(*) FROM tag_event WHERE service_id = ?) AS events,
            (SELECT COUNT(*) FROM tag_commit_receipt WHERE attempt_id = ?) AS receipts
        `, serviceId, "g65-unavailable-attempt").toArray()[0];
        expect(rows).toEqual({ events: 1, receipts: 1 });
      });
    } finally {
      await runInDurableObject(stub, (instance) => {
        const runtime = instance as unknown as { env: { D1?: D1Database } };
        runtime.env.D1 = originalD1;
      });
    }
  });

  it("keeps the pre-G65 first-append path when D1 has no configured G44 store", async () => {
    const serviceId = `g65-unconfigured-${crypto.randomUUID()}`;
    const tag = `reservation:g65:unconfigured:${crypto.randomUUID()}`;
    const stub = realTagStub(serviceId, tag);
    const originalD1 = database();
    const unconfiguredD1 = {
      prepare: () => ({
        all: async () => { throw new Error("no such table: dcb_events"); },
      }),
    } as unknown as D1Database;
    await runInDurableObject(stub, (instance) => {
      const runtime = instance as unknown as { env: { D1?: D1Database; AUTO_DRAIN_OUTBOX?: string } };
      runtime.env.D1 = unconfiguredD1;
      runtime.env.AUTO_DRAIN_OUTBOX = "false";
    });
    try {
      const response = await SELF.fetch(
        `https://tag.test/tags/${encodeURIComponent(serviceId)}/${encodeURIComponent(tag)}/append`,
        {
          method: "POST",
          headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: serviceId },
          body: JSON.stringify({ attemptId: "g65-unconfigured-attempt", epoch: 0, candidates: [candidate(serviceId, tag, "g65-unconfigured")] }),
        },
      );
      expect(response.status).toBe(201);
      expect(await response.clone().json()).toMatchObject({ status: "appended" });
      await runInDurableObject(stub, (_instance, state) => {
        expect(state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM tag_event WHERE service_id = ?",
          serviceId,
        ).toArray()[0]?.count).toBe(1);
        expect(state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM tag_source_partition_registration WHERE service_id = ?",
          serviceId,
        ).toArray()[0]?.count).toBe(0);
      });
    } finally {
      await runInDurableObject(stub, (instance) => {
        const runtime = instance as unknown as { env: { D1?: D1Database } };
        runtime.env.D1 = originalD1;
      });
    }
  });

  it("does not synchronously probe global admission for an unconfigured store", async () => {
    const serviceId = `g65-unconfigured-admission-${crypto.randomUUID()}`;
    const tag = `reservation:g65:unconfigured-admission:${crypto.randomUUID()}`;
    const stub = realTagStub(serviceId, tag);
    const originalD1 = database();
    let originalQueue: Queue<DownstreamOutboxMessage> | undefined;
    let originalAutoDrain: string | undefined;
    let originalDirectDoorbell: string | undefined;
    let originalDoorbell: unknown;
    let admissionInitializeCalls = 0;
    let queueSends = 0;
    const unconfiguredD1 = {
      prepare: (sql: string) => {
        if (sql.includes("SELECT 1 AS migration_binding")) admissionInitializeCalls += 1;
        if (sql.includes('SELECT "EventDigest" FROM dcb_events')) {
          return { all: async () => { throw new Error("no such table: dcb_events"); } };
        }
        throw new Error("unconfigured completeness store must not be used for admission");
      },
    } as unknown as D1Database;
    await runInDurableObject(stub, (instance) => {
      const runtime = instance as unknown as {
        env: {
          D1?: D1Database;
          AUTO_DRAIN_OUTBOX?: string;
          DIRECT_DOORBELL?: string;
          DOWNSTREAM_DOORBELL?: unknown;
          DOWNSTREAM_QUEUE?: Queue<DownstreamOutboxMessage>;
        };
      };
      originalQueue = runtime.env.DOWNSTREAM_QUEUE;
      originalAutoDrain = runtime.env.AUTO_DRAIN_OUTBOX;
      originalDirectDoorbell = runtime.env.DIRECT_DOORBELL;
      originalDoorbell = runtime.env.DOWNSTREAM_DOORBELL;
      runtime.env.D1 = unconfiguredD1;
      runtime.env.AUTO_DRAIN_OUTBOX = "true";
      runtime.env.DIRECT_DOORBELL = "false";
      runtime.env.DOWNSTREAM_DOORBELL = undefined;
      runtime.env.DOWNSTREAM_QUEUE = {
        send: async () => { queueSends += 1; },
      } as unknown as Queue<DownstreamOutboxMessage>;
    });
    try {
      const response = await SELF.fetch(
        `https://tag.test/tags/${encodeURIComponent(serviceId)}/${encodeURIComponent(tag)}/append`,
        {
          method: "POST",
          headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: serviceId },
          body: JSON.stringify({
            attemptId: "g65-unconfigured-admission-attempt",
            epoch: 0,
            candidates: [candidate(serviceId, tag, "g65-unconfigured-admission")],
          }),
        },
      );
      expect(response.status).toBe(201);
      expect(response.headers.get("x-sdt-global-admission")).toBeNull();
      expect(admissionInitializeCalls).toBe(0);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(queueSends).toBeGreaterThan(0);
    } finally {
      await runInDurableObject(stub, (instance) => {
        const runtime = instance as unknown as {
          env: {
            D1?: D1Database;
            AUTO_DRAIN_OUTBOX?: string;
            DIRECT_DOORBELL?: string;
            DOWNSTREAM_DOORBELL?: unknown;
            DOWNSTREAM_QUEUE?: Queue<DownstreamOutboxMessage>;
          };
        };
        runtime.env.D1 = originalD1;
        runtime.env.AUTO_DRAIN_OUTBOX = originalAutoDrain;
        runtime.env.DIRECT_DOORBELL = originalDirectDoorbell;
        runtime.env.DOWNSTREAM_DOORBELL = originalDoorbell;
        runtime.env.DOWNSTREAM_QUEUE = originalQueue;
      });
    }
  });

  it("refuses a first append when source-partition registration hangs", async () => {
    const serviceId = `g65-source-probe-hang-${crypto.randomUUID()}`;
    const tag = `reservation:g65:source-probe-hang:${crypto.randomUUID()}`;
    const stub = realTagStub(serviceId, tag);
    const originalD1 = database();
    const hangingD1 = {
      prepare: (sql: string) => sql.includes('SELECT "EventDigest" FROM dcb_events')
        ? { all: async () => ({ results: [{}] }) }
        : { bind: () => ({ run: () => new Promise<never>(() => {}) }) },
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
      expect(response.status).toBe(503);
      expect(elapsedMs).toBeGreaterThanOrEqual(G65_DERIVED_WRITE_BUDGET_MS - 25);
      expect(elapsedMs).toBeLessThan(G65_DERIVED_WRITE_BUDGET_MS + 500);
      expect(await response.clone().json()).toMatchObject({
        code: "partition_registration_unavailable",
        retryable: true,
      });
      await runInDurableObject(stub, (_instance, state) => {
        const row = state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM tag_event WHERE service_id = ?",
          serviceId,
        ).toArray()[0];
        expect(row?.count).toBe(0);
      });
    } finally {
      await runInDurableObject(stub, (instance) => {
        const runtime = instance as unknown as { env: { D1?: D1Database } };
        runtime.env.D1 = originalD1;
      });
    }
  });

  it("refuses a first append when source-partition registration fails", async () => {
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
      expect(response.status).toBe(503);
      expect(elapsedMs).toBeLessThan(G65_DERIVED_WRITE_BUDGET_MS + 500);
      expect(await response.clone().json()).toMatchObject({
        code: "partition_registration_unavailable",
        retryable: true,
      });
      await runInDurableObject(stub, (_instance, state) => {
        const row = state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM tag_event WHERE service_id = ?",
          serviceId,
        ).toArray()[0];
        expect(row?.count).toBe(0);
      });
    } finally {
      await runInDurableObject(stub, (instance) => {
        const runtime = instance as unknown as { env: { D1?: D1Database } };
        runtime.env.D1 = originalD1;
      });
    }
  });

  it("serializes a configured first-partition registration failure as a retryable public refusal", async () => {
    const serviceId = PUBLIC_COMMIT_SERVICE_ID;
    const tag = `reservation:g65:public-registration-failure:${crypto.randomUUID()}`;
    const stub = realTagStub(serviceId, tag);
    const originalD1 = database();
    const failingD1 = {
      prepare: (sql: string) => sql.includes('SELECT "EventDigest" FROM dcb_events')
        ? { all: async () => ({ results: [{}] }) }
        : { bind: () => ({ run: async () => { throw new Error("g65_public_source_partition_insert_failed"); } }) },
    } as unknown as D1Database;
    await runInDurableObject(stub, (instance) => {
      const runtime = instance as unknown as { env: { D1?: D1Database; AUTO_DRAIN_OUTBOX?: string } };
      runtime.env.D1 = failingD1;
      runtime.env.AUTO_DRAIN_OUTBOX = "false";
    });
    try {
      const started = performance.now();
      const response = await publicCommit(
        [publicCandidate(tag, "public-registration-failure")],
        [{ tag, lastSortableUniqueId: "" }],
      );
      const elapsedMs = performance.now() - started;
      expect(response.status).toBe(503);
      expect(elapsedMs).toBeLessThan(G65_DERIVED_WRITE_BUDGET_MS * 2 + 500);
      expect(await response.clone().json()).toMatchObject({
        code: "partition_registration_unavailable",
        retryable: true,
      });
      await runInDurableObject(stub, (_instance, state) => {
        expect(state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM tag_event WHERE service_id = ?",
          serviceId,
        ).toArray()[0]?.count).toBe(0);
      });
    } finally {
      await runInDurableObject(stub, (instance) => {
        const runtime = instance as unknown as { env: { D1?: D1Database } };
        runtime.env.D1 = originalD1;
      });
    }
  });

  it("serializes a configured first-partition registration hang as a bounded public refusal", async () => {
    const serviceId = PUBLIC_COMMIT_SERVICE_ID;
    const tag = `reservation:g65:public-registration-hang:${crypto.randomUUID()}`;
    const stub = realTagStub(serviceId, tag);
    const originalD1 = database();
    const hangingD1 = {
      prepare: (sql: string) => sql.includes('SELECT "EventDigest" FROM dcb_events')
        ? { all: async () => ({ results: [{}] }) }
        : { bind: () => ({ run: () => new Promise<never>(() => {}) }) },
    } as unknown as D1Database;
    await runInDurableObject(stub, (instance) => {
      const runtime = instance as unknown as { env: { D1?: D1Database; AUTO_DRAIN_OUTBOX?: string } };
      runtime.env.D1 = hangingD1;
      runtime.env.AUTO_DRAIN_OUTBOX = "false";
    });
    try {
      const started = performance.now();
      const response = await publicCommit(
        [publicCandidate(tag, "public-registration-hang")],
        [{ tag, lastSortableUniqueId: "" }],
      );
      const elapsedMs = performance.now() - started;
      expect(response.status).toBe(503);
      expect(elapsedMs).toBeLessThan(G65_DERIVED_WRITE_BUDGET_MS * 2 + 900);
      expect(await response.clone().json()).toMatchObject({
        code: "partition_registration_unavailable",
        retryable: true,
      });
      await runInDurableObject(stub, (_instance, state) => {
        expect(state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM tag_event WHERE service_id = ?",
          serviceId,
        ).toArray()[0]?.count).toBe(0);
      });
    } finally {
      await runInDurableObject(stub, (instance) => {
        const runtime = instance as unknown as { env: { D1?: D1Database } };
        runtime.env.D1 = originalD1;
      });
    }
  });

  it("keeps mixed public commits as partial writes while refusing only the new partition", async () => {
    const serviceId = PUBLIC_COMMIT_SERVICE_ID;
    const existingTag = `reservation:g65:public-mixed-existing:${crypto.randomUUID()}`;
    const newTag = `reservation:g65:public-mixed-new:${crypto.randomUUID()}`;
    const first = await publicCommit(
      [publicCandidate(existingTag, "public-mixed-seed")],
      [{ tag: existingTag, lastSortableUniqueId: "" }],
    );
    expect(first.status).toBe(200);
    const firstBody = await first.clone().json() as { writtenEvents?: Array<{ sortableUniqueIdValue?: string }> };
    const existingHead = firstBody.writtenEvents?.[0]?.sortableUniqueIdValue;
    expect(existingHead).toMatch(/^\d{30}$/);

    const newStub = realTagStub(serviceId, newTag);
    const originalD1 = database();
    const failingD1 = {
      prepare: (sql: string) => sql.includes('SELECT "EventDigest" FROM dcb_events')
        ? { all: async () => ({ results: [{}] }) }
        : { bind: () => ({ run: async () => { throw new Error("g65_public_mixed_source_partition_insert_failed"); } }) },
    } as unknown as D1Database;
    await runInDurableObject(newStub, (instance) => {
      const runtime = instance as unknown as { env: { D1?: D1Database; AUTO_DRAIN_OUTBOX?: string } };
      runtime.env.D1 = failingD1;
      runtime.env.AUTO_DRAIN_OUTBOX = "false";
    });
    try {
      const started = performance.now();
      const response = await publicCommit(
        [
          publicCandidate(existingTag, "public-mixed-existing"),
          publicCandidate(newTag, "public-mixed-new"),
        ],
        [
          { tag: existingTag, lastSortableUniqueId: existingHead },
          { tag: newTag, lastSortableUniqueId: "" },
        ],
      );
      const elapsedMs = performance.now() - started;
      expect(response.status).toBe(500);
      expect(elapsedMs).toBeLessThan(G65_DERIVED_WRITE_BUDGET_MS * 2 + 500);
      expect(await response.clone().json()).toMatchObject({
        code: "partial_write",
        partial: {
          retryable: false,
          writtenTags: [existingTag],
          missingTags: [newTag],
        },
      });
      await runInDurableObject(newStub, (_instance, state) => {
        expect(state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM tag_event WHERE service_id = ?",
          serviceId,
        ).toArray()[0]?.count).toBe(0);
      });
    } finally {
      await runInDurableObject(newStub, (instance) => {
        const runtime = instance as unknown as { env: { D1?: D1Database } };
        runtime.env.D1 = originalD1;
      });
    }
  });

  it("commits a registered tag with D1 unavailable and reports not-admitted", async () => {
    const serviceId = `g65-registered-outage-${crypto.randomUUID()}`;
    const tag = `reservation:g65:registered-outage:${crypto.randomUUID()}`;
    const stub = realTagStub(serviceId, tag);
    const originalD1 = database();
    await runInDurableObject(stub, (instance) => {
      const runtime = instance as unknown as { env: { D1?: D1Database; AUTO_DRAIN_OUTBOX?: string } };
      runtime.env.D1 = originalD1;
      runtime.env.AUTO_DRAIN_OUTBOX = "false";
    });
    try {
      const first = await SELF.fetch(
        `https://tag.test/tags/${encodeURIComponent(serviceId)}/${encodeURIComponent(tag)}/append`,
        {
          method: "POST",
          headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: serviceId },
          body: JSON.stringify({ attemptId: "g65-registered-first-attempt", epoch: 0, candidates: [candidate(serviceId, tag, "g65-registered-first", "g65-registered-suid-100")] }),
        },
      );
      expect(first.status).toBe(201);
      await runInDurableObject(stub, (_instance, state) => {
        expect(state.storage.sql.exec<{ status: string }>(`
          SELECT status FROM tag_source_partition_registration
           WHERE service_id = ? AND partition_tag = ?
        `, serviceId, tag).toArray()[0]?.status).toBe("registered");
      });
      await runInDurableObject(stub, (instance) => {
        const runtime = instance as unknown as { env: { D1?: D1Database; AUTO_DRAIN_OUTBOX?: string } };
        runtime.env.D1 = undefined;
        runtime.env.AUTO_DRAIN_OUTBOX = "true";
      });
      const second = await SELF.fetch(
        `https://tag.test/tags/${encodeURIComponent(serviceId)}/${encodeURIComponent(tag)}/append`,
        {
          method: "POST",
          headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: serviceId },
          body: JSON.stringify({ attemptId: "g65-registered-second-attempt", epoch: 0, candidates: [candidate(serviceId, tag, "g65-registered-second", "g65-registered-suid-101")] }),
        },
      );
      expect(second.status).toBe(201);
      expect(second.headers.get("x-sdt-global-admission")).toBe("not-admitted");
      await runInDurableObject(stub, (_instance, state) => {
        expect(state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM tag_event WHERE service_id = ?",
          serviceId,
        ).toArray()[0]?.count).toBe(2);
      });
    } finally {
      await runInDurableObject(stub, (instance) => {
        const runtime = instance as unknown as { env: { D1?: D1Database; AUTO_DRAIN_OUTBOX?: string } };
        runtime.env.D1 = originalD1;
        runtime.env.AUTO_DRAIN_OUTBOX = "false";
      });
    }
  });

  it("does not await registration again for an already-registered tag", async () => {
    const serviceId = `g65-registered-noop-${crypto.randomUUID()}`;
    const tag = `reservation:g65:registered-noop:${crypto.randomUUID()}`;
    const stub = realTagStub(serviceId, tag);
    const originalD1 = database();
    await runInDurableObject(stub, (instance) => {
      const runtime = instance as unknown as { env: { D1?: D1Database; AUTO_DRAIN_OUTBOX?: string } };
      runtime.env.D1 = originalD1;
      runtime.env.AUTO_DRAIN_OUTBOX = "false";
    });
    try {
      const first = await SELF.fetch(
        `https://tag.test/tags/${encodeURIComponent(serviceId)}/${encodeURIComponent(tag)}/append`,
        {
          method: "POST",
          headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: serviceId },
          body: JSON.stringify({ attemptId: "g65-registered-noop-first", epoch: 0, candidates: [candidate(serviceId, tag, "g65-registered-noop-first", "g65-registered-noop-suid-100")] }),
        },
      );
      expect(first.status).toBe(201);
      const unavailableD1 = {
        prepare: () => ({ all: () => new Promise<never>(() => {}) }),
      } as unknown as D1Database;
      await runInDurableObject(stub, (instance) => {
        const runtime = instance as unknown as { env: { D1?: D1Database } };
        runtime.env.D1 = unavailableD1;
      });
      const started = performance.now();
      const second = await SELF.fetch(
        `https://tag.test/tags/${encodeURIComponent(serviceId)}/${encodeURIComponent(tag)}/append`,
        {
          method: "POST",
          headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: serviceId },
          body: JSON.stringify({ attemptId: "g65-registered-noop-second", epoch: 0, candidates: [candidate(serviceId, tag, "g65-registered-noop-second", "g65-registered-noop-suid-101")] }),
        },
      );
      expect(second.status).toBe(201);
      expect(performance.now() - started).toBeLessThan(G65_DERIVED_WRITE_BUDGET_MS);
      expect(second.headers.get("x-sdt-global-admission")).toBeNull();
    } finally {
      await runInDurableObject(stub, (instance) => {
        const runtime = instance as unknown as { env: { D1?: D1Database; AUTO_DRAIN_OUTBOX?: string } };
        runtime.env.D1 = originalD1;
        runtime.env.AUTO_DRAIN_OUTBOX = "false";
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
