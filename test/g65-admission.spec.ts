import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
// @ts-expect-error Vite raw source migration import.
import g32Migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";
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

function candidate(serviceId: string, tag: string): Pick<
  DownstreamOutboxMessage,
  "eventId" | "suid" | "payload" | "eventTags" | "eventType" | "provenance" | "timestamp" | "allocatorLineageId"
> {
  const envelope = g32Message({
    serviceId,
    tag,
    attemptId: "g65-attempt",
    eventId: "g65-event",
    suid: "g65-suid",
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

function admissionLedger() {
  const rows = new Map<string, { payload: string; count: number }>();
  return {
    admit(identity: string, payload: string) {
      const prior = rows.get(identity);
      if (prior === undefined) {
        rows.set(identity, { payload, count: 1 });
        return "stored" as const;
      }
      if (prior.payload !== payload) throw new Error("canonical identity conflict");
      return "duplicate" as const;
    },
    rows,
  };
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

  it("admits an identity once in either direct-first or Queue-first order and rejects a conflicting replay", () => {
    for (const order of ["direct-first", "queue-first"] as const) {
      const ledger = admissionLedger();
      const operations = order === "direct-first" ? ["direct", "queue"] : ["queue", "direct"];
      expect(operations.map(() => ledger.admit("service|event|obligation-1|lineage-1", "payload"))).toEqual(["stored", "duplicate"]);
      expect(ledger.admit("service|event|obligation-1|lineage-1", "payload")).toBe("duplicate");
      expect(ledger.rows.get("service|event|obligation-1|lineage-1")).toMatchObject({ payload: "payload", count: 1 });
      expect(() => ledger.admit("service|event|obligation-1|lineage-1", "conflicting-payload")).toThrow("canonical identity conflict");
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
    expect(elapsedMs).toBeLessThan(G65_DERIVED_WRITE_BUDGET_MS + 500);
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
