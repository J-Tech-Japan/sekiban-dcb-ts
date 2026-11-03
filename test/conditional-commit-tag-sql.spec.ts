import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { scopeIdFor } from "../packages/dcb-runtime/src/scope/ScopeName";
import { TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/service/ServiceIdentityProvider";
import {
  ConditionalReceiptUnsupported,
  TAG_CONDITIONAL_RECEIPT_DDL,
  assertConditionalReceiptShape,
  ensureConditionalReceiptSchema,
  type ConditionalSqlExecutor,
  type ConditionalSyncStorage,
} from "../packages/dcb-runtime/src/tag/TagConditionalReceipt";
import { G32_FIXTURE_TIMESTAMP, g32EventId, g32Suid } from "./helpers/g32-fixtures";

const FINGERPRINT_A = "a".repeat(64);
const FINGERPRINT_B = "b".repeat(64);

function serviceId(): string {
  return `cc${crypto.randomUUID().replaceAll("-", "")}`;
}

function tagNamespace(): DurableObjectNamespace {
  return (env as unknown as { TAG: DurableObjectNamespace }).TAG;
}

function tagStub(service: string, tag: string): DurableObjectStub {
  return tagNamespace().get(scopeIdFor(tagNamespace(), { serviceId: service, doClass: "tag", identity: tag }));
}

function tagRequest(service: string, tag: string, path: string, body: unknown): Request {
  const url = new URL(`https://tag.internal${path}`);
  url.searchParams.set("__tag", tag);
  url.searchParams.set("__serviceId", service);
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-spoofed-internal": "1" },
    body: JSON.stringify(body),
  });
}

function appendBody(service: string, tag: string, key: string, fingerprint: string, event: string, suid: string, payload = "{\"n\":1}", fault?: string) {
  return {
    serviceId: service,
    tag,
    normalizedKey: key,
    operationFingerprint: fingerprint,
    candidate: {
      attemptId: `attempt-${event}`,
      epoch: 0,
      eventId: g32EventId(event),
      suid: g32Suid(suid),
      payload,
      eventTags: [tag],
      allocatorLineageId: "conditional-lineage",
      eventType: "FixtureEvent",
      provenance: "g32",
      timestamp: G32_FIXTURE_TIMESTAMP,
    },
    ...(fault === undefined ? {} : { fault }),
  };
}

async function counts(service: string, tag: string): Promise<{ events: number; memberships: number; outbox: number; receipts: number; commits: number; head: string }> {
  return runInDurableObject(tagStub(service, tag), async (_instance, state) => {
    const row = state.storage.sql.exec(`
      SELECT
        (SELECT COUNT(*) FROM tag_event) AS events,
        (SELECT COUNT(*) FROM tag_committed_membership) AS memberships,
        (SELECT COUNT(*) FROM tag_outbox_obligation WHERE status = 'pending') AS outbox,
        (SELECT COUNT(*) FROM tag_conditional_receipt) AS receipts,
        (SELECT COUNT(*) FROM tag_commit_receipt) AS commits,
        (SELECT head_suid FROM tag_head WHERE singleton = 1) AS head
    `).one() as Record<string, number | string | null>;
    return {
      events: Number(row.events),
      memberships: Number(row.memberships),
      outbox: Number(row.outbox),
      receipts: Number(row.receipts),
      commits: Number(row.commits),
      head: typeof row.head === "string" ? row.head : "",
    };
  });
}

function validRows(): Map<string, Record<string, unknown>[]> {
  return new Map<string, Record<string, unknown>[]>([
    ["sqlite_master WHERE name", [{ type: "table", name: "tag_conditional_receipt", sql: TAG_CONDITIONAL_RECEIPT_DDL }]],
    ["table_info", [
      { cid: 0, name: "service_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
      { cid: 1, name: "normalized_key", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
      { cid: 2, name: "operation_fingerprint", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 3, name: "event_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 4, name: "event_digest", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ]],
    ["index_list", [
      { seq: 0, name: "sqlite_autoindex_tag_conditional_receipt_1", unique: 1, origin: "pk", partial: 0 },
      { seq: 1, name: "sqlite_autoindex_tag_conditional_receipt_2", unique: 1, origin: "u", partial: 0 },
    ]],
    ["index_info(\"sqlite_autoindex_tag_conditional_receipt_1\")", [
      { seqno: 0, cid: 0, name: "service_id" },
      { seqno: 1, cid: 1, name: "normalized_key" },
    ]],
    ["index_info(\"sqlite_autoindex_tag_conditional_receipt_2\")", [
      { seqno: 0, cid: 0, name: "service_id" },
      { seqno: 1, cid: 3, name: "event_id" },
    ]],
    ["foreign_key_list", [
      { id: 0, seq: 0, table: "tag_event", from: "service_id", to: "service_id", on_update: "NO ACTION", on_delete: "RESTRICT", match: "NONE" },
      { id: 0, seq: 1, table: "tag_event", from: "event_id", to: "event_id", on_update: "NO ACTION", on_delete: "RESTRICT", match: "NONE" },
    ]],
    ["type = 'trigger'", []],
  ]);
}

function fakeSql(rows: Map<string, Record<string, unknown>[]>): ConditionalSqlExecutor {
  return {
    exec(query: string) {
      const match = [...rows.entries()].find(([needle]) => query.includes(needle));
      const result = match?.[1] ?? [];
      return { toArray: () => result as never[], one: () => result[0] as never };
    },
  };
}

describe("conditional receipt schema", () => {
  it("creates the exact table once and rejects every mismatched shape without repair", () => {
    let created = false;
    let ddlRuns = 0;
    const storage = {
      sql: {
        exec(query: string) {
          if (query === TAG_CONDITIONAL_RECEIPT_DDL) {
            ddlRuns += 1;
            created = true;
            return { toArray: () => [], one: () => ({}) };
          }
          if (!created && query.includes("sqlite_master WHERE name")) return { toArray: () => [], one: () => undefined };
          const rows = validRows();
          const match = [...rows.entries()].find(([needle]) => query.includes(needle));
          const result = match?.[1] ?? [];
          return { toArray: () => result, one: () => result[0] };
        },
      },
      transactionSync(callback: () => void) { callback(); },
    };
    const syncStorage = storage as unknown as ConditionalSyncStorage;
    ensureConditionalReceiptSchema(syncStorage);
    ensureConditionalReceiptSchema(syncStorage);
    expect(ddlRuns).toBe(1);
    expect(() => ensureConditionalReceiptSchema({ sql: storage.sql } as unknown as ConditionalSyncStorage)).toThrow(ConditionalReceiptUnsupported);
    const cases: Array<[string, (rows: Map<string, Record<string, unknown>[]>) => void]> = [
      ["extra column", (rows) => rows.get("table_info")?.push({ cid: 5, name: "extra", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 })],
      ["renamed column", (rows) => { rows.get("table_info")![0]!.name = "service"; }],
      ["reordered column", (rows) => { const columns = rows.get("table_info")!; const [first] = columns.splice(0, 1); columns.push(first!); }],
      ["typed column", (rows) => { rows.get("table_info")![0]!.type = "INTEGER"; }],
      ["nullable column", (rows) => { rows.get("table_info")![0]!.notnull = 0; }],
      ["defaulted column", (rows) => { rows.get("table_info")![0]!.dflt_value = "x"; }],
      ["primary key", (rows) => { rows.get("table_info")![0]!.pk = 0; }],
      ["extra index", (rows) => rows.get("index_list")?.push({ seq: 2, name: "extra_idx", unique: 0, origin: "c", partial: 0 })],
      ["unique key", (rows) => { rows.get("index_info(\"sqlite_autoindex_tag_conditional_receipt_2\")")![1]!.name = "normalized_key"; }],
      ["foreign key", (rows) => { rows.get("foreign_key_list")![1]!.on_delete = "CASCADE"; }],
    ];
    for (const [label, mutate] of cases) {
      const rows = validRows();
      mutate(rows);
      expect(() => assertConditionalReceiptShape(fakeSql(rows)), label).toThrow(ConditionalReceiptUnsupported);
    }
  });
});

describe("conditional tag authority", () => {
  it("creates the receipt on the first private call and leaves V1 off that table", async () => {
    const service = serviceId();
    const tag = "Order:fresh";
    const absent = await tagStub(service, tag).fetch(tagRequest(service, tag, "/__internal/conditional/resolve", {
      serviceId: service, tag, normalizedKey: "key-1", operationFingerprint: FINGERPRINT_A,
    }));
    expect(absent.status).toBe(204);
    const master = await runInDurableObject(tagStub(service, tag), async (_instance, state) => {
      const row = state.storage.sql.exec("SELECT sql FROM sqlite_master WHERE name = 'tag_conditional_receipt'").toArray()[0] as { sql?: string } | undefined;
      const version = state.storage.sql.exec("SELECT schema_version FROM tag_control WHERE singleton = 1").toArray()[0] as { schema_version?: number } | undefined;
      return { sql: row?.sql, version: version?.schema_version ?? null };
    });
    expect(master.sql?.replace(/\s+/g, " ").trim()).toBe(TAG_CONDITIONAL_RECEIPT_DDL.replace(/\s+/g, " ").trim());
    expect(master.version).toBeNull();
    const again = await tagStub(service, tag).fetch(tagRequest(service, tag, "/__internal/conditional/resolve", {
      serviceId: service, tag, normalizedKey: "key-1", operationFingerprint: FINGERPRINT_A,
    }));
    expect(again.status).toBe(204);

    const v1 = await SELF.fetch(`https://tag.test/tags/${encodeURIComponent(service)}/${encodeURIComponent("Order:v1")}/append`, {
      method: "POST",
      headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: service },
      body: JSON.stringify({
        attemptId: "v1-only",
        epoch: 0,
        candidates: [{
          eventId: g32EventId("v1-only"),
          suid: g32Suid("v1-only"),
          payload: "{\"n\":1}",
          eventTags: ["Order:v1"],
          eventType: "FixtureEvent",
          provenance: "g32",
          allocatorLineageId: "conditional-lineage",
          timestamp: G32_FIXTURE_TIMESTAMP,
        }],
      }),
    });
    expect(v1.status).toBe(201);
    const v1Table = await runInDurableObject(tagStub(service, "Order:v1"), async (_instance, state) =>
      state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'tag_conditional_receipt'").toArray());
    expect(v1Table).toEqual([]);
  });

  it("appends, resends, conflicts, and keeps distinct tags independent", async () => {
    const service = serviceId();
    const tag = "Order:one";
    const other = "Order:two";
    const first = await tagStub(service, tag).fetch(tagRequest(service, tag, "/__internal/conditional/append", appendBody(service, tag, "shared", FINGERPRINT_A, "event-a", "10")));
    expect(first.status).toBe(201);
    const resent = await tagStub(service, tag).fetch(tagRequest(service, tag, "/__internal/conditional/append", appendBody(service, tag, "shared", FINGERPRINT_A, "event-b", "11")));
    expect(resent.status).toBe(200);
    const conflict = await tagStub(service, tag).fetch(tagRequest(service, tag, "/__internal/conditional/append", appendBody(service, tag, "shared", FINGERPRINT_B, "event-c", "12")));
    expect(conflict.status).toBe(409);
    const separate = await tagStub(service, other).fetch(tagRequest(service, other, "/__internal/conditional/append", appendBody(service, other, "shared", FINGERPRINT_B, "event-d", "13")));
    expect(separate.status).toBe(201);
    expect(await counts(service, tag)).toMatchObject({ events: 1, memberships: 1, outbox: 1, receipts: 1, commits: 1 });
    expect((await counts(service, other)).events).toBe(1);
  });

  it("keeps one winner under concurrency and rolls a duplicate receipt back before re-resolve", async () => {
    const service = serviceId();
    const tag = "Order:race";
    const same = await Promise.all(Array.from({ length: 8 }, (_item, index) =>
      tagStub(service, tag).fetch(tagRequest(service, tag, "/__internal/conditional/append", appendBody(service, tag, "race", FINGERPRINT_A, `same-${index}`, String(20 + index))))));
    const sameStatuses = (await Promise.all(same.map(async (response) => response.status))).sort();
    expect(sameStatuses.filter((status) => status === 201)).toHaveLength(1);
    expect(sameStatuses.filter((status) => status === 200)).toHaveLength(7);
    expect(await counts(service, tag)).toMatchObject({ events: 1, receipts: 1, commits: 1 });

    const conflictTag = "Order:conflict";
    const mixed = await Promise.all([0, 1, 2, 3].map((index) => tagStub(service, conflictTag).fetch(tagRequest(
      service,
      conflictTag,
      "/__internal/conditional/append",
      appendBody(service, conflictTag, "race", index % 2 === 0 ? FINGERPRINT_A : FINGERPRINT_B, `mix-${index}`, String(40 + index)),
    ))));
    const mixedStatuses = await Promise.all(mixed.map(async (response) => response.status));
    expect(mixedStatuses.filter((status) => status === 201)).toHaveLength(1);
    expect(mixedStatuses.filter((status) => status === 409)).toHaveLength(2);
    expect(mixedStatuses.filter((status) => status === 200)).toHaveLength(1);

    const fault = await tagStub(service, "Order:rollback").fetch(tagRequest(
      service,
      "Order:rollback",
      "/__internal/conditional/append",
      appendBody(service, "Order:rollback", "roll", FINGERPRINT_A, "roll-1", "50", "{\"n\":1}", "duplicate-receipt"),
    ));
    expect(fault.status).toBe(503);
    const rolled = await runInDurableObject(tagStub(service, "Order:rollback"), async (_instance, state) => {
      const names = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'tag_event'").toArray();
      if (names.length === 0) return { events: 0, memberships: 0, outbox: 0, receipts: 0, commits: 0, head: "" };
      const row = state.storage.sql.exec(`
        SELECT
          (SELECT COUNT(*) FROM tag_event) AS events,
          (SELECT COUNT(*) FROM tag_committed_membership) AS memberships,
          (SELECT COUNT(*) FROM tag_outbox_obligation WHERE status = 'pending') AS outbox,
          (SELECT COUNT(*) FROM tag_conditional_receipt) AS receipts,
          (SELECT COUNT(*) FROM tag_commit_receipt) AS commits,
          (SELECT head_suid FROM tag_head WHERE singleton = 1) AS head
      `).toArray()[0] as Record<string, number | string | null> | undefined;
      return {
        events: Number(row?.events ?? 0),
        memberships: Number(row?.memberships ?? 0),
        outbox: Number(row?.outbox ?? 0),
        receipts: Number(row?.receipts ?? 0),
        commits: Number(row?.commits ?? 0),
        head: typeof row?.head === "string" ? row.head : "",
      };
    });
    expect(rolled).toMatchObject({ events: 0, memberships: 0, outbox: 0, receipts: 0, commits: 0, head: "" });
  });

  it("rolls back every crash point and then accepts the same key", async () => {
    const faults = ["after-event", "after-membership", "after-outbox", "after-head", "after-conditional-receipt", "after-commit-receipt"];
    for (const fault of faults) {
      const service = serviceId();
      const tag = `Order:${fault}`;
      const crashed = await tagStub(service, tag).fetch(tagRequest(
        service, tag, "/__internal/conditional/append",
        appendBody(service, tag, "key", FINGERPRINT_A, fault, "60", "{\"n\":1}", fault),
      ));
      expect(crashed.status).not.toBe(201);
      const after = await runInDurableObject(tagStub(service, tag), async (_instance, state) => {
        const table = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'tag_event'").toArray();
        if (table.length === 0) return { events: 0, memberships: 0, outbox: 0, receipts: 0, commits: 0, head: "" };
        const row = state.storage.sql.exec(`
          SELECT
            (SELECT COUNT(*) FROM tag_event) AS events,
            (SELECT COUNT(*) FROM tag_committed_membership) AS memberships,
            (SELECT COUNT(*) FROM tag_outbox_obligation WHERE status = 'pending') AS outbox,
            (SELECT COUNT(*) FROM tag_conditional_receipt) AS receipts,
            (SELECT COUNT(*) FROM tag_commit_receipt) AS commits,
            (SELECT head_suid FROM tag_head WHERE singleton = 1) AS head
        `).toArray()[0] as Record<string, number | string | null> | undefined;
        return {
          events: Number(row?.events ?? 0),
          memberships: Number(row?.memberships ?? 0),
          outbox: Number(row?.outbox ?? 0),
          receipts: Number(row?.receipts ?? 0),
          commits: Number(row?.commits ?? 0),
          head: typeof row?.head === "string" ? row.head : "",
        };
      });
      expect(after).toMatchObject({ events: 0, memberships: 0, outbox: 0, receipts: 0, commits: 0, head: "" });
      const resent = await tagStub(service, tag).fetch(tagRequest(
        service, tag, "/__internal/conditional/append", appendBody(service, tag, "key", FINGERPRINT_A, `${fault}-ok`, "61"),
      ));
      expect(resent.status).toBe(201);
    }
  });

  it("preserves a winner across V1 head movement and blocks a fresh key behind a V1 reservation", async () => {
    const service = serviceId();
    const tag = "Order:mixed";
    const winner = await tagStub(service, tag).fetch(tagRequest(
      service, tag, "/__internal/conditional/append", appendBody(service, tag, "winner", FINGERPRINT_A, "mixed-1", "70"),
    ));
    expect(winner.status).toBe(201);
    const v1 = await SELF.fetch(`https://tag.test/tags/${encodeURIComponent(service)}/${encodeURIComponent(tag)}/append`, {
      method: "POST",
      headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: service },
      body: JSON.stringify({
        attemptId: "v1-after",
        epoch: 0,
        candidates: [{
          eventId: g32EventId("v1-after"),
          suid: g32Suid("90"),
          payload: "{\"n\":2}",
          eventTags: [tag],
          eventType: "FixtureEvent",
          provenance: "g32",
          allocatorLineageId: "conditional-lineage",
          timestamp: G32_FIXTURE_TIMESTAMP,
        }],
      }),
    });
    expect(v1.status).toBe(201);
    const still = await tagStub(service, tag).fetch(tagRequest(
      service, tag, "/__internal/conditional/resolve",
      { serviceId: service, tag, normalizedKey: "winner", operationFingerprint: FINGERPRINT_A },
    ));
    expect(still.status).toBe(200);
    const reserved = await SELF.fetch(`https://tag.test/tags/${encodeURIComponent(service)}/${encodeURIComponent(tag)}/acquire`, {
      method: "POST",
      headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: service },
      body: JSON.stringify({
        attemptId: "holder",
        epoch: 1,
        eventTags: [tag],
        consistencyTags: [{ tag, lastSortableUniqueId: g32Suid("90") }],
      }),
    });
    expect(reserved.status).toBe(201);
    const blocked = await tagStub(service, tag).fetch(tagRequest(
      service, tag, "/__internal/conditional/append", appendBody(service, tag, "fresh", FINGERPRINT_A, "mixed-2", "91"),
    ));
    expect(blocked.status).toBe(503);
    const hidden = await tagStub(service, tag).fetch(tagRequest(
      service, tag, "/__internal/conditional/append", appendBody(service, tag, "winner", FINGERPRINT_A, "mixed-3", "92"),
    ));
    expect(hidden.status).toBe(200);
  });

  it("rejects one overtaken sortable id without a second event", async () => {
    const service = serviceId();
    const tag = "Order:clock";
    const seeded = await SELF.fetch(`https://tag.test/tags/${encodeURIComponent(service)}/${encodeURIComponent(tag)}/append`, {
      method: "POST",
      headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: service },
      body: JSON.stringify({
        attemptId: "clock-seed",
        epoch: 0,
        candidates: [{
          eventId: g32EventId("clock-seed"),
          suid: g32Suid("90"),
          payload: "{\"n\":1}",
          eventTags: [tag],
          eventType: "FixtureEvent",
          provenance: "g32",
          allocatorLineageId: "conditional-lineage",
          timestamp: G32_FIXTURE_TIMESTAMP,
        }],
      }),
    });
    expect(seeded.status).toBe(201);
    const late = await tagStub(service, tag).fetch(tagRequest(
      service, tag, "/__internal/conditional/append", appendBody(service, tag, "late", FINGERPRINT_A, "clock-late", "1"),
    ));
    expect(late.status).toBe(503);
    expect((await counts(service, tag)).events).toBe(1);
  });

  it("fails closed for an imported marker, a bad table, and a candidate event without a receipt", async () => {
    const service = serviceId();
    const tag = "Order:import";
    await runInDurableObject(tagStub(service, tag), async (_instance, state) => {
      const now = new Date().toISOString();
      state.storage.sql.exec("INSERT INTO tag_identity (singleton, tag, created_at) VALUES (1, ?, ?)", tag, now);
      state.storage.sql.exec(`
        INSERT INTO tag_bootstrap_admission (singleton, import_id, lease_epoch, manifest_digest, target_service_id, closed)
        VALUES (1, 'import-1', 1, 'digest', ?, 0)
      `, service);
    });
    const unsupported = await tagStub(service, tag).fetch(tagRequest(service, tag, "/__internal/conditional/resolve", {
      serviceId: service, tag, normalizedKey: "imported", operationFingerprint: FINGERPRINT_A,
    }));
    expect(unsupported.status).toBe(501);

    const winnerService = serviceId();
    const winnerTag = "Order:marked";
    expect((await tagStub(winnerService, winnerTag).fetch(tagRequest(
      winnerService, winnerTag, "/__internal/conditional/append",
      appendBody(winnerService, winnerTag, "marked", FINGERPRINT_A, "marked-1", "80"),
    ))).status).toBe(201);
    await runInDurableObject(tagStub(winnerService, winnerTag), async (_instance, state) => {
      state.storage.sql.exec(`
        INSERT INTO tag_bootstrap_admission (singleton, import_id, lease_epoch, manifest_digest, target_service_id, closed)
        VALUES (1, 'import-2', 1, 'digest', ?, 0)
      `, winnerService);
    });
    const corrupt = await tagStub(winnerService, winnerTag).fetch(tagRequest(winnerService, winnerTag, "/__internal/conditional/resolve", {
      serviceId: winnerService, tag: winnerTag, normalizedKey: "marked", operationFingerprint: FINGERPRINT_A,
    }));
    expect(corrupt.status).toBe(500);

    const bad = serviceId();
    await runInDurableObject(tagStub(bad, "Order:bad"), async (_instance, state) => {
      state.storage.sql.exec("CREATE TABLE tag_conditional_receipt (service_id TEXT)");
    });
    const mismatch = await tagStub(bad, "Order:bad").fetch(tagRequest(bad, "Order:bad", "/__internal/conditional/resolve", {
      serviceId: bad, tag: "Order:bad", normalizedKey: "bad", operationFingerprint: FINGERPRINT_A,
    }));
    expect(mismatch.status).toBe(501);
    const stillBad = await runInDurableObject(tagStub(bad, "Order:bad"), async (_instance, state) =>
      state.storage.sql.exec("PRAGMA table_info('tag_conditional_receipt')").toArray());
    expect(stillBad).toHaveLength(1);

    const orphan = serviceId();
    const orphanTag = "Order:orphan";
    expect((await SELF.fetch(`https://tag.test/tags/${encodeURIComponent(orphan)}/${encodeURIComponent(orphanTag)}/append`, {
      method: "POST",
      headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: orphan },
      body: JSON.stringify({
        attemptId: "orphan-attempt",
        epoch: 0,
        candidates: [{
          eventId: g32EventId("orphan-event"),
          suid: g32Suid("81"),
          payload: "{\"n\":1}",
          eventTags: [orphanTag],
          eventType: "FixtureEvent",
          provenance: "g32",
          allocatorLineageId: "conditional-lineage",
          timestamp: G32_FIXTURE_TIMESTAMP,
        }],
      }),
    })).status).toBe(201);
    const contradictory = await tagStub(orphan, orphanTag).fetch(tagRequest(
      orphan, orphanTag, "/__internal/conditional/append",
      appendBody(orphan, orphanTag, "orphan", FINGERPRINT_A, "orphan-event", "82"),
    ));
    expect(contradictory.status).toBe(500);

    const malformed = await tagStub(service, tag).fetch(tagRequest(service, tag, "/__internal/conditional/append", {
      serviceId: service, tag, normalizedKey: "bad", operationFingerprint: FINGERPRINT_A, extra: true,
    }));
    expect(malformed.status).toBe(400);
  });
});
