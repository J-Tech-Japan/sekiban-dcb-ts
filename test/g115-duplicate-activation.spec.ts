import { beforeAll, describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
// @ts-expect-error Vite raw source migration import.
import g32Migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";
import { TagDurableObject } from "../packages/dcb-runtime/src/tag/TagDurableObject";
import { D1EventStore } from "../packages/dcb-runtime/src/store/D1EventStore";
import { scopeIdFor } from "../packages/dcb-runtime/src/scope/ScopeName";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { g32EventId, g32Message, g32Suid, G32_FIXTURE_TIMESTAMP } from "./helpers/g32-fixtures";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";

interface Scope {
  readonly serviceId: string;
  readonly tag: string;
}

interface TagFacts {
  readonly events: number;
  readonly receipts: number;
  readonly memberships: number;
  readonly obligations: number;
  readonly reservations: number;
  readonly version: number;
  readonly head: string;
}

interface TagResult {
  readonly status: number;
  readonly body: unknown;
}

function scope(): Scope {
  return { serviceId: `g115-${crypto.randomUUID()}`, tag: "orders" };
}

function tagStub(value: Scope): DurableObjectStub {
  const namespace = (env as unknown as { readonly TAG: DurableObjectNamespace }).TAG;
  return namespace.get(scopeIdFor(namespace, { serviceId: value.serviceId, doClass: "tag", identity: value.tag }));
}

async function tagCall(value: Scope, path: string, init: RequestInit = {}): Promise<TagResult> {
  return runInDurableObject(tagStub(value), async (original, durableState) => {
    const runtimeEnv = (original as unknown as { readonly env: unknown }).env;
    const instance = new TagDurableObject(durableState, runtimeEnv as never);
    const response = await instance.fetch(new Request(
      `https://tag.test${path}?__tag=${encodeURIComponent(value.tag)}&__serviceId=${encodeURIComponent(value.serviceId)}`,
      init,
    ));
    return { status: response.status, body: await response.json().catch(() => undefined) };
  });
}

async function post(value: Scope, path: string, body: unknown): Promise<TagResult> {
  return tagCall(value, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function state(value: Scope): Promise<Record<string, unknown>> {
  const response = await tagCall(value, "/state");
  expect(response.status).toBe(200);
  return response.body as Record<string, unknown>;
}

async function facts(value: Scope): Promise<TagFacts> {
  return runInDurableObject(tagStub(value), (_instance, durableState) => {
    const row = durableState.storage.sql.exec<{
      events: number;
      receipts: number;
      memberships: number;
      obligations: number;
      reservations: number;
      version: number;
      head: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM tag_event) AS events,
        (SELECT COUNT(*) FROM tag_commit_receipt) AS receipts,
        (SELECT COUNT(*) FROM tag_committed_membership) AS memberships,
        (SELECT COUNT(*) FROM tag_outbox_obligation) AS obligations,
        (SELECT COUNT(*) FROM tag_reservation) AS reservations,
        (SELECT version FROM tag_control WHERE singleton = 1) AS version,
        (SELECT head_suid FROM tag_head WHERE singleton = 1) AS head
    `).one();
    return row;
  });
}

function candidate(value: Scope, suffix: string, suid: string, payload = suffix) {
  return {
    eventId: g32EventId(`g115-${suffix}`),
    suid: g32Suid(suid),
    payload: JSON.stringify({ value: payload }),
    eventTags: [value.tag],
    eventType: "G115FixtureEvent",
    provenance: "g32",
    allocatorLineageId: "g115-lineage",
    timestamp: G32_FIXTURE_TIMESTAMP,
  };
}

function appendBody(value: Scope, attemptId: string, epoch: number, event: ReturnType<typeof candidate>) {
  return { attemptId, epoch, candidates: [event] };
}

function d1(): D1Database {
  const database = (env as unknown as { readonly D1?: D1Database }).D1;
  if (database === undefined) throw new Error("G115 tests require the local D1 binding");
  return database;
}

function statements(database: D1Database, sql: string): D1PreparedStatement[] {
  return sql.replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => database.prepare(statement));
}

beforeAll(async () => {
  const database = d1();
  const existing = await database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dcb_events'",
  ).first<{ name: string }>();
  if (existing === null || existing === undefined) {
    await database.batch(statements(database, g32Migration as string));
  }
  await applyG44D1Migration(database);
});

describe("SDT-G115 duplicate activation", () => {
  it("rejects a stale epoch after a newer epoch is durable", async () => {
    const value = scope();
    const attemptId = "g115-stale-epoch";
    const sealed = await post(value, "/seal", { attemptId, epoch: 1 });
    expect(sealed.status).toBe(200);
    const beforeState = await state(value);
    const beforeFacts = await facts(value);

    const response = await post(value, "/append", appendBody(
      value,
      attemptId,
      0,
      candidate(value, "stale-epoch", "g115-stale-epoch-1"),
    ));
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "tag_operation_rejected", reason: "stale_epoch" });
    expect(await state(value)).toEqual(beforeState);
    expect(await facts(value)).toEqual(beforeFacts);
  });

  it("rejects a stale head/version before creating a reservation", async () => {
    const value = scope();
    const first = candidate(value, "head-first", "g115-head-1");
    expect((await post(value, "/append", appendBody(value, "g115-head-first", 0, first))).status).toBe(201);
    const staleHead = (await state(value)).head as string;
    const second = candidate(value, "head-second", "g115-head-2");
    expect((await post(value, "/append", appendBody(value, "g115-head-second", 0, second))).status).toBe(201);
    const before = await facts(value);

    const response = await post(value, "/acquire", {
      attemptId: "g115-stale-head",
      epoch: 1,
      eventTags: [value.tag],
      consistencyTags: [{ tag: value.tag, lastSortableUniqueId: staleHead }],
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ reason: "consistency_head_mismatch" });
    expect(await facts(value)).toEqual({ ...before, reservations: 0 });
  });

  it("replays an exact duplicate from its stored receipt after the epoch advances", async () => {
    const value = scope();
    const attemptId = "g115-duplicate-replay";
    const event = candidate(value, "duplicate-replay", "g115-replay-1");
    const first = await post(value, "/append", appendBody(value, attemptId, 0, event));
    expect(first.status).toBe(201);
    const firstBody = first.body as { version: number; updatedAt: string };
    expect((await post(value, "/seal", { attemptId, epoch: 1 })).status).toBe(200);
    const before = await facts(value);
    expect(before).toMatchObject({ events: 1, receipts: 1, memberships: 1, obligations: 1 });

    const replay = await post(value, "/append", appendBody(value, attemptId, 0, event));
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      status: "duplicate",
      version: firstBody.version,
      updatedAt: firstBody.updatedAt,
    });
    expect(await facts(value)).toEqual(before);
  });

  it("replays one delivery without duplicating derived D1 identity rows", async () => {
    const serviceId = `g115-d1-${crypto.randomUUID()}`;
    const message: DownstreamOutboxMessage = g32Message({
      serviceId,
      tag: "g115:delivery",
      attemptId: "g115-delivery-attempt",
      eventId: "g115-delivery-event",
      suid: "g115-delivery-suid",
      payload: JSON.stringify({ value: "same" }),
      eventTags: ["g115:delivery"],
      eventType: "G115DeliveryEvent",
      allocatorLineageId: "g115-delivery-lineage",
    });
    const store = new D1EventStore(d1());
    await store.initialize();
    await expect(store.recordDelivery(message, 10_000, "fast")).resolves.toMatchObject({ outcome: "stored" });
    await expect(store.recordDelivery(message, 10_001, "queue")).resolves.toMatchObject({ outcome: "stored" });

    const counts = await d1().prepare(`
      SELECT
        (SELECT COUNT(*) FROM dcb_events WHERE "ServiceId" = ?) AS events,
        (SELECT COUNT(*) FROM serialized_dcb_global_memberships WHERE service_id = ?) AS memberships,
        (SELECT COUNT(*) FROM serialized_dcb_global_receipts WHERE service_id = ?) AS receipts
    `).bind(serviceId, serviceId, serviceId).first<{ events: number; memberships: number; receipts: number }>();
    expect(counts).toEqual({ events: 1, memberships: 1, receipts: 1 });
    expect(await store.listDeliveryIncidents(serviceId)).toHaveLength(0);
    expect((await store.readAllEvents(serviceId, ""))[0]).toMatchObject({
      eventId: message.eventId,
      suid: message.suid,
      payload: message.payload,
    });
  });

  it("two isolated Tag instances converge through the shared durable head", async () => {
    const value = scope();
    await runInDurableObject(tagStub(value), async (original, durableState) => {
      const runtimeEnv = (original as unknown as { readonly env: unknown }).env;
      const winner = new TagDurableObject(durableState, runtimeEnv as never);
      const stale = new TagDurableObject(durableState, runtimeEnv as never);
      const request = (event: ReturnType<typeof candidate>, attemptId: string) => new Request(
        `https://tag.test/append?__tag=${encodeURIComponent(value.tag)}&__serviceId=${encodeURIComponent(value.serviceId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(appendBody(value, attemptId, 0, event)),
        },
      );

      const higher = candidate(value, "shared-head-higher", "g115-shared-2");
      expect((await winner.fetch(request(higher, "g115-shared-winner"))).status).toBe(201);
      const lower = candidate(value, "shared-head-lower", "g115-shared-1");
      const response = await stale.fetch(request(lower, "g115-shared-stale"));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ reason: "non_monotonic_suid" });
      expect(durableState.storage.sql.exec<{ head_suid: string }>(
        "SELECT head_suid FROM tag_head WHERE singleton = 1",
      ).one().head_suid).toBe(higher.suid);
    });
  });
});
