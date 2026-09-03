import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { GlobalCompletenessReconciler } from "../packages/dcb-runtime/src/completeness/GlobalCompletenessReconciler";
import { buildScopeName, scopeIdFor } from "../packages/dcb-runtime/src/scope/ScopeName";
import { TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/service/ServiceIdentityProvider";
import {
  G44_HEALTH_STALE_AFTER_MS,
  GLOBAL_COMPLETENESS_INTERIM_DISPOSITION,
  G44_SCANNER_VERSION,
  type SourceObligationFact,
  type SourceObligationPage,
} from "../packages/dcb-runtime/src/completeness/types";
import { drainTagOutbox } from "../packages/dcb-runtime/src/downstream/OutboxDrain";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { processDownstreamDelivery } from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import { processDeliveryCore, type DeliveryViewHandler } from "../packages/dcb-runtime/src/downstream/DeliveryCore";
import { D1EventStore, D1IdentityConflictError } from "../packages/dcb-runtime/src/store/D1EventStore";
import { g32EventId, g32Message, g32Suid } from "./helpers/g32-fixtures";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";
import { runMeetingRoomScheduledMaintenance } from "../samples/meeting-room/src/worker.cloudflare-only";
// @ts-expect-error Vite raw import keeps the test database tied to the committed baseline.
import g32Migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";

interface Scope {
  readonly serviceId: string;
  readonly tag: string;
}

interface TagScannerSeam {
  g44ReadSourceObligations(input: Readonly<{
    serviceId: string;
    tag: string;
    upperBoundSequence: number;
    afterSequence: number;
    limit: number;
  }>): Promise<SourceObligationPage>;
}

type D1Count = { readonly count: number };

function database(): D1Database {
  const d1 = (env as unknown as { readonly D1?: D1Database }).D1;
  if (d1 === undefined) throw new Error("G44 requires the Miniflare D1 source binding");
  return d1;
}

function tags(): DurableObjectNamespace {
  const namespace = (env as unknown as { readonly TAG?: DurableObjectNamespace }).TAG;
  if (namespace === undefined) throw new Error("G44 requires the Tag Durable Object namespace");
  return namespace;
}

function scope(): Scope {
  return { serviceId: `g44-${crypto.randomUUID()}`, tag: `room:g44:${crypto.randomUUID()}` };
}

function tagStub(value: Scope): DurableObjectStub {
  return tags().get(scopeIdFor(tags(), { serviceId: value.serviceId, doClass: "tag", identity: value.tag }));
}

/** The source fixture must use the same physical tag identity as production. */
function tagScopeName(value: Scope): string {
  return buildScopeName({ serviceId: value.serviceId, doClass: "tag", identity: value.tag });
}

function candidate(value: Scope, suffix: string, eventTags = [value.tag]) {
  return {
    eventId: g32EventId(`g44-${suffix}`),
    suid: g32Suid(`g44-${suffix}`),
    payload: JSON.stringify({ name: "g44", suffix }),
    eventTags,
    allocatorLineageId: "g44-lineage",
    eventType: "G44Fixture",
    provenance: "g32" as const,
    timestamp: "2026-08-22T17:00:00.123Z",
  };
}

async function configureG44Source(value: Scope): Promise<void> {
  await runInDurableObject(tagStub(value), (instance) => {
    const runtime = instance as unknown as {
      env: { D1?: D1Database; AUTO_DRAIN_OUTBOX?: string };
    };
    runtime.env.D1 = database();
    runtime.env.AUTO_DRAIN_OUTBOX = "false";
  });
}

async function makeG44RetryDue(value: Scope): Promise<void> {
  await runInDurableObject(tagStub(value), async (_instance, state) => {
    state.storage.sql.exec("UPDATE tag_outbox_obligation SET next_attempt_at = 1 WHERE status = 'pending'");
    await state.storage.setAlarm(Date.now() + 60_000);
  });
}

async function replaceG44Queue(
  value: Scope,
  send: (message: DownstreamOutboxMessage) => Promise<void>,
): Promise<() => Promise<void>> {
  let originalQueue: Queue<DownstreamOutboxMessage> | undefined;
  let originalAutoDrain: string | undefined;
  await runInDurableObject(tagStub(value), (instance) => {
    const runtime = instance as unknown as {
      env: { DOWNSTREAM_QUEUE?: Queue<DownstreamOutboxMessage>; AUTO_DRAIN_OUTBOX?: string };
    };
    originalQueue = runtime.env.DOWNSTREAM_QUEUE;
    originalAutoDrain = runtime.env.AUTO_DRAIN_OUTBOX;
    runtime.env.DOWNSTREAM_QUEUE = { send } as unknown as Queue<DownstreamOutboxMessage>;
    runtime.env.AUTO_DRAIN_OUTBOX = "true";
  });
  return async () => {
    await runInDurableObject(tagStub(value), (instance) => {
      const runtime = instance as unknown as {
        env: { DOWNSTREAM_QUEUE?: Queue<DownstreamOutboxMessage>; AUTO_DRAIN_OUTBOX?: string };
      };
      runtime.env.DOWNSTREAM_QUEUE = originalQueue;
      runtime.env.AUTO_DRAIN_OUTBOX = originalAutoDrain;
    });
  };
}

async function append(value: Scope, suffix: string, eventTags = [value.tag]): Promise<Response> {
  return SELF.fetch(
    `https://tag.test/tags/${encodeURIComponent(value.serviceId)}/${encodeURIComponent(value.tag)}/append`,
    {
      method: "POST",
      headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: value.serviceId },
      body: JSON.stringify({ attemptId: `g44-attempt-${suffix}`, epoch: 0, candidates: [candidate(value, suffix, eventTags)] }),
    },
  );
}

async function sourcePage(value: Scope, upperBoundSequence = Number.MAX_SAFE_INTEGER): Promise<SourceObligationPage> {
  return runInDurableObject(tagStub(value), (instance) =>
    (instance as unknown as TagScannerSeam).g44ReadSourceObligations({
      serviceId: value.serviceId,
      tag: value.tag,
      upperBoundSequence,
      afterSequence: 0,
      limit: 64,
    }));
}

async function sourceRows(value: Scope): Promise<readonly SourceObligationFact[]> {
  const registry = await database().prepare(
    "SELECT last_obligation_sequence FROM serialized_dcb_source_partitions WHERE service_id = ? AND partition_tag = ?",
  ).bind(value.serviceId, value.tag).first<{ last_obligation_sequence: number }>();
  if (registry === null || registry === undefined) throw new Error("G44 source partition was not registered");
  return (await sourcePage(value, registry.last_obligation_sequence)).rows;
}

async function count(table: string, serviceId: string): Promise<number> {
  // `table` is a literal in this test module, never caller-controlled SQL.
  const serviceColumn = table === "dcb_events" ? '"ServiceId"' : "service_id";
  const row = await database().prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${serviceColumn} = ?`).bind(serviceId).first<D1Count>();
  return row?.count ?? 0;
}

function factFrom(message: DownstreamOutboxMessage, status: SourceObligationFact["status"] = "pending"): SourceObligationFact {
  return { ...message.completeness, eventId: message.eventId, status };
}

interface SourceFixture {
  fetch(request: Request): Promise<Response>;
}

function sourceNamespace(sources: ReadonlyMap<string, SourceFixture>): DurableObjectNamespace {
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => {
      const source = sources.get(id as unknown as string);
      if (source === undefined) throw new Error(`source_partition_unreadable:${String(id)}`);
      return source as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

function fixedSource(
  snapshot: { readonly serviceId: string; readonly tag: string; readonly upperBoundSequence: number },
  rows: readonly SourceObligationFact[],
): SourceFixture {
  return {
    async fetch(request) {
      const input = await request.json<Parameters<TagScannerSeam["g44ReadSourceObligations"]>[0]>();
      const pageRows = rows.filter((row) => row.obligationSequence > input.afterSequence && row.obligationSequence <= input.upperBoundSequence)
        .slice(0, input.limit);
      const hasMore = rows.some((row) => row.obligationSequence > (pageRows.at(-1)?.obligationSequence ?? input.afterSequence) && row.obligationSequence <= input.upperBoundSequence);
      return new Response(JSON.stringify({
        serviceId: snapshot.serviceId,
        tag: snapshot.tag,
        upperBoundSequence: snapshot.upperBoundSequence,
        observedMaxSequence: snapshot.upperBoundSequence,
        afterSequence: input.afterSequence,
        rows: pageRows,
        hasMore,
      }), { headers: { "content-type": "application/json" } });
    },
  };
}

async function registerSnapshot(value: Scope, upperBoundSequence: number): Promise<void> {
  await database().prepare(
    `INSERT INTO serialized_dcb_source_partitions (service_id, partition_tag, last_obligation_sequence, registered_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (service_id, partition_tag) DO UPDATE SET last_obligation_sequence = excluded.last_obligation_sequence`,
  ).bind(value.serviceId, value.tag, upperBoundSequence, 1_000).run();
}

beforeAll(async () => {
  const statements = (g32Migration as string).replace(/^\s*--.*$/gm, "")
    .split(";").map((statement) => statement.trim()).filter(Boolean)
    .map((statement) => database().prepare(statement));
  await database().batch(statements);
  await applyG44D1Migration(database());
});

describe("SDT-G44 global-array receipt, source registry, and detector health", () => {
  it("AC1: atomically writes event, tag-local committed membership, and receipt; retries converge and digest conflicts fail closed", async () => {
    const serviceId = `g44-atomic-${crypto.randomUUID()}`;
    const tagA = `room:g44:a:${crypto.randomUUID()}`;
    const tagB = `room:g44:b:${crypto.randomUUID()}`;
    const eventId = g32EventId("g44-atomic-event");
    const eventTags = [tagA, tagB].sort();
    const first = g32Message({
      serviceId, tag: tagA, attemptId: "g44-shared-attempt", eventId, suid: "g44-atomic-suid",
      payload: JSON.stringify({ fixture: "g44-atomic" }), eventTags, eventType: "G44Fixture", allocatorLineageId: "g44-atomic-lineage", obligationSequence: 1,
    });
    const second: DownstreamOutboxMessage = {
      ...first,
      tag: tagB,
      completeness: {
        ...first.completeness,
        localCommittedMembership: [{ serviceId, eventId, tag: tagB }],
        obligationSequence: 1,
      },
    };
    const store = new D1EventStore(database());
    await store.initialize();

    await expect(store.recordDelivery(first, 2_000)).resolves.toMatchObject({ outcome: "stored" });
    await expect(store.recordDelivery(first, 2_100)).resolves.toMatchObject({ outcome: "stored" });
    await expect(store.recordDelivery(second, 2_200)).resolves.toMatchObject({ outcome: "stored" });
    expect(await count("dcb_events", serviceId)).toBe(1);
    expect(await count("serialized_dcb_global_memberships", serviceId)).toBe(2);
    expect(await count("serialized_dcb_global_receipts", serviceId)).toBe(2);
    await expect(store.readGlobalReceiptJoin(first)).resolves.toMatchObject({ partitionTag: tagA, eventDigest: first.completeness.eventDigest });
    await expect(store.readGlobalReceiptJoin(second)).resolves.toMatchObject({ partitionTag: tagB, eventDigest: first.completeness.eventDigest });

    const conflictingDigest = { ...first, completeness: { ...first.completeness, eventDigest: "f".repeat(64) } };
    await expect(store.recordDelivery(conflictingDigest, 2_300)).rejects.toBeInstanceOf(D1IdentityConflictError);
    expect(await count("dcb_events", serviceId)).toBe(1);
    expect(await count("serialized_dcb_global_memberships", serviceId)).toBe(2);
    expect(await count("serialized_dcb_global_receipts", serviceId)).toBe(2);
  });

  it("AC1 mutation attribution: a batch failure leaves event, membership, and receipt all absent", async () => {
    const serviceId = `g44-batch-${crypto.randomUUID()}`;
    const message = g32Message({
      serviceId, tag: `room:g44:batch:${crypto.randomUUID()}`, eventId: "g44-batch-event", suid: "g44-batch-suid",
    });
    const store = new D1EventStore(database(), {
      beforeBatch: (_operation, statements, d1) => [...statements, d1.prepare("SELECT g44_missing_atomic_batch_table")],
    });
    await store.initialize();
    await expect(store.recordDelivery(message, 3_000)).rejects.toThrow(/g44_missing_atomic_batch_table/);
    await expect(count("dcb_events", serviceId)).resolves.toBe(0);
    await expect(count("serialized_dcb_global_memberships", serviceId)).resolves.toBe(0);
    await expect(count("serialized_dcb_global_receipts", serviceId)).resolves.toBe(0);
  });

  it("AC2/AC3/G53: a canonical scoped source drains through the Queue adapter into global D1 before acknowledgement", async () => {
    const value = scope();
    await configureG44Source(value);
    expect((await append(value, "handoff")).status).toBe(201);
    const registry = await database().prepare(
      "SELECT last_obligation_sequence FROM serialized_dcb_source_partitions WHERE service_id = ? AND partition_tag = ?",
    ).bind(value.serviceId, value.tag).first<{ last_obligation_sequence: number }>();
    expect(registry).toMatchObject({ last_obligation_sequence: 1 });

    const handoffs: DownstreamOutboxMessage[] = [];
    const result = await drainTagOutbox(
      { serviceId: value.serviceId, tag: value.tag },
      { TAG: tags(), DOWNSTREAM_QUEUE: { send: async (message: DownstreamOutboxMessage) => { handoffs.push(message); } } as unknown as Queue<DownstreamOutboxMessage> },
      { now: () => 4_000 },
      { acknowledgement: "global-receipt" },
    );
    expect(result.delivered).toBe(1);
    expect(handoffs).toHaveLength(1);
    expect((await sourceRows(value))[0]?.status).toBe("pending");

    const beforeJoin = await SELF.fetch(
      `https://tag.test/tags/${encodeURIComponent(value.serviceId)}/${encodeURIComponent(value.tag)}/outbox/mark-delivered`,
      { method: "POST", headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: value.serviceId }, body: JSON.stringify({ deliveries: handoffs, nowMs: 4_010 }) },
    );
    expect(beforeJoin.status).toBe(409);
    expect((await sourceRows(value))[0]?.status).toBe("pending");

    const store = new D1EventStore(database());
    await store.initialize();
    // The first receiver attempt has durably admitted the global event and
    // acknowledged its source, but it still retries until the independent
    // scanner establishes the first FULL frontier. That queue policy is
    // intentional and keeps views blocked while coverage is UNKNOWN.
    await expect(processDownstreamDelivery(handoffs[0]!, { D1: database(), TAG: tags() }, {
      store,
      clock: { now: () => 4_020 },
    })).rejects.toThrow(/^downstream_delivery_retry:/);
    expect(await count("dcb_events", value.serviceId)).toBe(1);
    expect((await sourceRows(value))[0]?.status).toBe("acknowledged");
    const scanner = new GlobalCompletenessReconciler(database(), tags());
    await expect(scanner.reconcile(value.serviceId, 4_040)).resolves.toMatchObject({ kind: "FULL", scannedObligations: 1 });
    await expect(processDownstreamDelivery(handoffs[0]!, { D1: database(), TAG: tags() }, {
      store,
      clock: { now: () => 4_050 },
    })).resolves.toBeUndefined();
    await expect(scanner.readHealth(value.serviceId, 4_041)).resolves.toMatchObject({
      status: "HEALTHY",
      lastFullScanAt: 4_040,
      cursorJson: expect.stringContaining(value.tag),
    });
  });

  it("AC4: zero delivery remains source-enumerable and creates exactly one stable unresolved finding without a healthy frontier", async () => {
    const value = scope();
    await configureG44Source(value);
    expect((await append(value, "zero-delivery")).status).toBe(201);
    const scanner = new GlobalCompletenessReconciler(database(), tags());

    await expect(scanner.reconcile(value.serviceId, 5_000)).resolves.toMatchObject({ kind: "BLOCK", findingCount: 1 });
    await expect(scanner.reconcile(value.serviceId, 5_100)).resolves.toMatchObject({ kind: "BLOCK", findingCount: 1 });
    expect((await sourceRows(value))[0]?.status).toBe("pending");
    const findings = await database().prepare(
      `SELECT incident_identity, incident_type, state FROM serialized_dcb_completeness_findings
       WHERE service_id = ? ORDER BY incident_identity`,
    ).bind(value.serviceId).all<{ incident_identity: string; incident_type: string; state: string }>();
    expect(findings.results).toEqual([expect.objectContaining({
      incident_type: "GLOBAL_ARRAY_RECEIPT_ABSENT",
      state: "OPEN",
    })]);
    const health = await scanner.readHealth(value.serviceId, 5_200);
    expect(health).toMatchObject({ status: "BLOCK", cursorJson: null, lastFullScanAt: null });
  });

  it("AC3/AC5: unreadable, truncated, and mid-scan changed source partitions become UNKNOWN; a scanner crash becomes FAILED", async () => {
    const value = scope();
    const message = g32Message({ serviceId: value.serviceId, tag: value.tag, eventId: "g44-source-page", suid: "g44-source-page" });
    await registerSnapshot(value, message.completeness.obligationSequence);
    const healthySource = fixedSource(
      { serviceId: value.serviceId, tag: value.tag, upperBoundSequence: message.completeness.obligationSequence },
      [],
    );
    const namespace = sourceNamespace(new Map([[tagScopeName(value), healthySource]]));
    const scanner = new GlobalCompletenessReconciler(database(), namespace);
    await expect(scanner.reconcile(value.serviceId, 6_000)).resolves.toMatchObject({ kind: "UNKNOWN" });
    expect((await scanner.readHealth(value.serviceId, 6_001)).status).toBe("UNKNOWN");

    const truncating: SourceFixture = {
      async fetch(request): Promise<Response> {
        const input = await request.json<Parameters<TagScannerSeam["g44ReadSourceObligations"]>[0]>();
        return new Response(JSON.stringify({
          serviceId: input.serviceId,
          tag: input.tag,
          upperBoundSequence: input.upperBoundSequence,
          observedMaxSequence: input.upperBoundSequence,
          afterSequence: input.afterSequence,
          rows: [],
          hasMore: true,
        }), { headers: { "content-type": "application/json" } });
      },
    };
    const unknownScanner = new GlobalCompletenessReconciler(database(), sourceNamespace(new Map([[tagScopeName(value), truncating]])));
    await expect(unknownScanner.reconcile(value.serviceId, 6_100)).resolves.toMatchObject({ kind: "UNKNOWN" });
    expect((await unknownScanner.readHealth(value.serviceId, 6_101)).status).toBe("UNKNOWN");

    const unreadable = new GlobalCompletenessReconciler(database(), sourceNamespace(new Map()));
    await expect(unreadable.reconcile(value.serviceId, 6_200)).resolves.toMatchObject({ kind: "UNKNOWN" });
    expect((await unreadable.readHealth(value.serviceId, 6_201)).status).toBe("UNKNOWN");

    const crashing: SourceFixture = { async fetch() { throw new Error("scanner_crashed"); } };
    const failed = new GlobalCompletenessReconciler(database(), sourceNamespace(new Map([[tagScopeName(value), crashing]])));
    await expect(failed.reconcile(value.serviceId, 6_300)).resolves.toMatchObject({ kind: "FAILED", error: "scanner_crashed" });
    expect((await failed.readHealth(value.serviceId, 6_301)).status).toBe("FAILED");
    const failureFindings = await database().prepare(
      `SELECT incident_type, state FROM serialized_dcb_completeness_findings
       WHERE service_id = ? ORDER BY incident_type`,
    ).bind(value.serviceId).all<{ incident_type: string; state: string }>();
    expect(failureFindings.results).toEqual(expect.arrayContaining([
      { incident_type: "GLOBAL_ARRAY_SOURCE_PARTITION_UNAVAILABLE", state: "OPEN" },
      { incident_type: "GLOBAL_ARRAY_SCANNER_FAILURE", state: "OPEN" },
    ]));

    const changingScope = scope();
    const changingMessage = g32Message({ serviceId: changingScope.serviceId, tag: changingScope.tag, eventId: "g44-changing", suid: "g44-changing", obligationSequence: 1 });
    await registerSnapshot(changingScope, changingMessage.completeness.obligationSequence);
    const addedTag = `room:g44:added:${crypto.randomUUID()}`;
    const mutatingSource: SourceFixture = {
      async fetch(request) {
        const input = await request.json<Parameters<TagScannerSeam["g44ReadSourceObligations"]>[0]>();
        await database().prepare(
          `INSERT INTO serialized_dcb_source_partitions (service_id, partition_tag, last_obligation_sequence, registered_at)
           VALUES (?, ?, 1, 6_400)`,
        ).bind(changingScope.serviceId, addedTag).run();
        return new Response(JSON.stringify({
          serviceId: input.serviceId,
          tag: input.tag,
          upperBoundSequence: input.upperBoundSequence,
          observedMaxSequence: input.upperBoundSequence,
          afterSequence: input.afterSequence,
          rows: [factFrom(changingMessage)],
          hasMore: false,
        }), { headers: { "content-type": "application/json" } });
      },
    };
    const changed = new GlobalCompletenessReconciler(database(), sourceNamespace(new Map([[tagScopeName(changingScope), mutatingSource]])));
    await expect(changed.reconcile(changingScope.serviceId, 6_400)).resolves.toMatchObject({ kind: "UNKNOWN", reason: "source_partition_set_changed_during_scan" });
    expect((await changed.readHealth(changingScope.serviceId, 6_401)).status).toBe("UNKNOWN");

    const duplicateScope = scope();
    const duplicateMessage = g32Message({ serviceId: duplicateScope.serviceId, tag: duplicateScope.tag, eventId: "g44-duplicate", suid: "g44-duplicate", obligationSequence: 1 });
    await registerSnapshot(duplicateScope, duplicateMessage.completeness.obligationSequence);
    // A source partition identity itself is primary-key unique. If a broken
    // source page nevertheless repeats its local sequence, it is equally
    // non-enumerable and must become UNKNOWN instead of FULL.
    const duplicatePage = fixedSource(
      { serviceId: duplicateScope.serviceId, tag: duplicateScope.tag, upperBoundSequence: 1 },
      [factFrom(duplicateMessage), factFrom(duplicateMessage)],
    );
    const duplicateScanner = new GlobalCompletenessReconciler(database(), sourceNamespace(new Map([[tagScopeName(duplicateScope), duplicatePage]])));
    await expect(duplicateScanner.reconcile(duplicateScope.serviceId, 6_450)).resolves.toMatchObject({ kind: "UNKNOWN", reason: expect.stringContaining("source_page_sequence_outside_snapshot") });
    await expect(database().prepare(
      `INSERT INTO serialized_dcb_source_partitions (service_id, partition_tag, last_obligation_sequence, registered_at)
       VALUES (?, ?, 2, 6_451)`,
    ).bind(duplicateScope.serviceId, duplicateScope.tag).run()).rejects.toThrow();

    const receiptScope = scope();
    const receiptMessage = g32Message({ serviceId: receiptScope.serviceId, tag: receiptScope.tag, eventId: "g44-receipt-read", suid: "g44-receipt-read", obligationSequence: 1 });
    await registerSnapshot(receiptScope, receiptMessage.completeness.obligationSequence);
    const receiptSource = fixedSource(
      { serviceId: receiptScope.serviceId, tag: receiptScope.tag, upperBoundSequence: 1 },
      [factFrom(receiptMessage)],
    );
    const receiptUnavailable = new GlobalCompletenessReconciler(
      database(),
      sourceNamespace(new Map([[tagScopeName(receiptScope), receiptSource]])),
      G44_SCANNER_VERSION,
      { globalReceiptMatcher: async () => { throw new Error("g44_fixture_receipt_join_unavailable"); } },
    );
    await expect(receiptUnavailable.reconcile(receiptScope.serviceId, 6_500)).resolves.toMatchObject({ kind: "FAILED", error: "g44_fixture_receipt_join_unavailable" });
    const receiptFindings = await database().prepare(
      `SELECT incident_type, state FROM serialized_dcb_completeness_findings
       WHERE service_id = ? ORDER BY incident_type`,
    ).bind(receiptScope.serviceId).all<{ incident_type: string; state: string }>();
    expect(receiptFindings.results).toEqual([
      { incident_type: "GLOBAL_ARRAY_RECEIPT_UNAVAILABLE", state: "OPEN" },
      { incident_type: "GLOBAL_ARRAY_SCANNER_FAILURE", state: "OPEN" },
    ]);
  });

  it("AC5/AC6: detector failure or BLOCK/UNSETTLED coverage blocks every view and materialized catch-up", async () => {
    const message = g32Message({
      serviceId: `g44-detector-${crypto.randomUUID()}`, tag: `room:g44:detector:${crypto.randomUUID()}`,
      eventId: "g44-detector", suid: "g44-detector",
    });
    const store = {
      initialize: async () => {},
      recordDelivery: async () => ({ outcome: "stored" as const, kind: "stored" as const, event: {
        serviceId: message.serviceId, id: message.eventId, eventId: message.eventId, sortableUniqueId: message.suid, suid: message.suid,
        payload: message.payload, tags: message.eventTags, eventTags: message.eventTags, eventType: message.eventType,
        timestamp: message.timestamp, causationId: message.causationId, correlationId: message.correlationId, executedUser: message.executedUser,
        provenance: "g32" as const, firstArrivedAt: 1, lastArrivedAt: 1, maxDeliveryLagMs: 0, arrivals: [],
      }}),
      upsertPending: async () => { throw new Error("g44-detector-threw"); },
    };
    const detectorHealth = new GlobalCompletenessReconciler(database(), sourceNamespace(new Map()));
    let views = 0;
    const view: DeliveryViewHandler = { id: "g44-view", apply: async () => { views += 1; } };
    const result = await processDeliveryCore(message, "queue", {}, {
      store: store as never,
      views: [view],
      clock: { now: () => 7_000 },
      onDetectorFailure: ({ error, arrivedAt }) => detectorHealth.recordDetectorFailure(message.serviceId, error, arrivedAt),
    });
    expect(result.failures).toEqual([expect.objectContaining({ phase: "detector" })]);
    expect(views).toBe(0);
    expect((await detectorHealth.readHealth(message.serviceId, 7_001)).status).toBe("FAILED");
    await expect(database().prepare(
      "SELECT incident_type, state FROM serialized_dcb_completeness_findings WHERE service_id = ?",
    ).bind(message.serviceId).first<{ incident_type: string; state: string }>()).resolves.toEqual({
      incident_type: "GLOBAL_ARRAY_DETECTOR_FAILURE",
      state: "OPEN",
    });

    const coverageResult = await processDeliveryCore(message, "queue", {}, {
      store: {
        ...store,
        upsertPending: async () => ({ serviceId: message.serviceId, eventId: message.eventId, expectedPaths: [], observedPaths: [], firstObservedAt: 1, lagBoundMs: 0 }),
      } as never,
      views: [view],
      beforeViews: async () => { throw new Error("global_completeness_BLOCK/UNSETTLED:UNKNOWN"); },
      clock: { now: () => 7_001 },
    });
    expect(coverageResult.failures).toEqual([expect.objectContaining({ phase: "completeness" })]);
    expect(views).toBe(0);

    const maintenance: string[] = [];
    await runMeetingRoomScheduledMaintenance({
      globalCoverage: async () => "BLOCK/UNSETTLED",
      catchUp: async () => { maintenance.push("catch-up"); },
      drainUnsafeKicks: async () => { maintenance.push("drain"); },
      runGenericScheduledWork: async () => { maintenance.push("generic"); },
    });
    expect(maintenance).toEqual(["generic"]);

    const scanner = new GlobalCompletenessReconciler(database(), sourceNamespace(new Map()));
    expect((await scanner.readHealth(`g44-never-${crypto.randomUUID()}`, 7_000)).status).toBe("UNKNOWN");
    const staleService = `g44-stale-${crypto.randomUUID()}`;
    await database().prepare(
      `INSERT INTO serialized_dcb_completeness_scanner_health
       (service_id, scanner_version, status, cursor_json, last_full_scan_at, last_error, updated_at)
       VALUES (?, 'fixture', 'HEALTHY', '[{"tag":"fixture","upperBoundSequence":1}]', ?, NULL, ?)`,
    ).bind(staleService, 1, 1).run();
    expect((await scanner.readHealth(staleService, 1 + G44_HEALTH_STALE_AFTER_MS + 1)).status).toBe("STALE");
  });

  it("AC6/AC7: the only interim disposition is BLOCK/UNSETTLED and poison stays source-enumerable as OPEN/UNRESOLVED", async () => {
    expect(GLOBAL_COMPLETENESS_INTERIM_DISPOSITION).toBe("BLOCK/UNSETTLED");
    const value = scope();
    const message = g32Message({ serviceId: value.serviceId, tag: value.tag, eventId: "g44-poison", suid: "g44-poison", obligationSequence: 1 });
    await registerSnapshot(value, message.completeness.obligationSequence);
    const source = fixedSource(
      { serviceId: value.serviceId, tag: value.tag, upperBoundSequence: message.completeness.obligationSequence },
      [factFrom(message, "poison")],
    );
    const scanner = new GlobalCompletenessReconciler(database(), sourceNamespace(new Map([[tagScopeName(value), source]])));
    await expect(scanner.reconcile(value.serviceId, 8_000)).resolves.toMatchObject({ kind: "BLOCK", findingCount: 1 });
    const finding = await database().prepare(
      `SELECT incident_type, state FROM serialized_dcb_completeness_findings WHERE service_id = ?`,
    ).bind(value.serviceId).first<{ incident_type: string; state: string }>();
    expect(finding).toEqual({ incident_type: "GLOBAL_ARRAY_POISON_OBLIGATION", state: "OPEN" });
  });

  it("AC7: a retry-exhausted Queue/DLQ handoff remains an actual enumerable source obligation", async () => {
    const value = scope();
    await configureG44Source(value);
    expect((await append(value, "dlq")).status).toBe(201);
    const restoreQueue = await replaceG44Queue(value, async () => {
      throw new Error("fixture Queue delivery reaches terminal DLQ handling");
    });
    try {
      for (let attempt = 0; attempt < 4 && (await sourceRows(value))[0]?.status !== "poison"; attempt += 1) {
        await makeG44RetryDue(value);
        expect(await runDurableObjectAlarm(tagStub(value))).toBe(true);
      }
      expect((await sourceRows(value))[0]).toMatchObject({ status: "poison" });
      const scanner = new GlobalCompletenessReconciler(database(), tags());
      await expect(scanner.reconcile(value.serviceId, 8_100)).resolves.toMatchObject({ kind: "BLOCK", findingCount: 1 });
      const finding = await database().prepare(
        `SELECT incident_identity, incident_type, state FROM serialized_dcb_completeness_findings
         WHERE service_id = ?`,
      ).bind(value.serviceId).first<{ incident_identity: string; incident_type: string; state: string }>();
      expect(finding).toMatchObject({
        incident_identity: expect.stringContaining("SOURCE_RECEIPT_ABSENT"),
        incident_type: "GLOBAL_ARRAY_POISON_OBLIGATION",
        state: "OPEN",
      });
    } finally {
      await restoreQueue();
    }
  });
});
