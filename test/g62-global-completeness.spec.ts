import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { GlobalCompletenessReconciler } from "../packages/dcb-runtime/src/completeness/GlobalCompletenessReconciler";
import { G44_SCANNER_VERSION, type SourceObligationFact, type SourceObligationPage } from "../packages/dcb-runtime/src/completeness/types";
import { scopeIdFor } from "../packages/dcb-runtime/src/scope/ScopeName";
import { TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/service/ServiceIdentityProvider";
import { drainTagOutbox } from "../packages/dcb-runtime/src/downstream/OutboxDrain";
import { processDownstreamDelivery } from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import type { DeliveryViewHandler } from "../packages/dcb-runtime/src/downstream/DeliveryCore";
import { D1EventStore } from "../packages/dcb-runtime/src/store/D1EventStore";
import { G32_FIXTURE_TIMESTAMP, g32EventId, g32Message, g32SuidAt } from "./helpers/g32-fixtures";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";
// @ts-expect-error Vite raw import keeps the test database tied to the committed baseline.
import g32Migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";

interface SourceFixture {
  fetch(request: Request): Promise<Response>;
}

interface SourcePageInput {
  readonly serviceId: string;
  readonly tag: string;
  readonly upperBoundSequence: number;
  readonly afterSequence: number;
  readonly limit: number;
}

function database(): D1Database {
  const d1 = (env as unknown as { readonly D1?: D1Database }).D1;
  if (d1 === undefined) throw new Error("G62 requires the Miniflare D1 source binding");
  return d1;
}

interface RealScope {
  readonly serviceId: string;
  readonly tag: string;
}

function tags(): DurableObjectNamespace {
  const namespace = (env as unknown as { readonly TAG?: DurableObjectNamespace }).TAG;
  if (namespace === undefined) throw new Error("G62 requires the Miniflare Tag Durable Object namespace");
  return namespace;
}

function realTagStub(value: RealScope): DurableObjectStub {
  return tags().get(scopeIdFor(tags(), { serviceId: value.serviceId, doClass: "tag", identity: value.tag }));
}

async function configureRealSource(value: RealScope): Promise<void> {
  await runInDurableObject(realTagStub(value), (instance) => {
    const runtime = instance as unknown as {
      env: { D1?: D1Database; AUTO_DRAIN_OUTBOX?: string };
    };
    runtime.env.D1 = database();
    runtime.env.AUTO_DRAIN_OUTBOX = "false";
  });
}

async function appendRealSource(value: RealScope, suffix: string, suid: string): Promise<Response> {
  const candidate = {
    eventId: g32EventId(suffix),
    suid,
    payload: JSON.stringify({ fixture: "g62-real-source", suffix }),
    eventTags: [value.tag],
    allocatorLineageId: `g62-real-lineage-${value.serviceId}`,
    eventType: "G62Fixture",
    provenance: "g32" as const,
    timestamp: G32_FIXTURE_TIMESTAMP,
  };
  return SELF.fetch(
    `https://g62.test/tags/${encodeURIComponent(value.serviceId)}/${encodeURIComponent(value.tag)}/append`,
    {
      method: "POST",
      headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: value.serviceId },
      body: JSON.stringify({ attemptId: `g62-real-attempt-${suffix}`, epoch: 0, candidates: [candidate] }),
    },
  );
}

async function appendAndRecordRealSource(value: RealScope, suffix: string, suid: string, arrivedAt: number): Promise<DownstreamOutboxMessage> {
  await configureRealSource(value);
  const response = await appendRealSource(value, suffix, suid);
  if (response.status !== 201) throw new Error(`G62 real append failed: ${response.status}`);
  const handoffs: DownstreamOutboxMessage[] = [];
  const drain = await drainTagOutbox(
    { serviceId: value.serviceId, tag: value.tag },
    {
      TAG: tags(),
      DOWNSTREAM_QUEUE: { send: async (message: DownstreamOutboxMessage) => { handoffs.push(message); } } as unknown as Queue<DownstreamOutboxMessage>,
    },
    { now: () => arrivedAt - 1 },
    { acknowledgement: "global-receipt" },
  );
  if (drain.delivered !== 1 || handoffs.length !== 1) throw new Error("G62 real source did not produce one outbox handoff");
  const store = new D1EventStore(database());
  await store.initialize();
  const outcome = await store.recordDelivery(handoffs[0]!, arrivedAt);
  if (outcome.outcome !== "stored") throw new Error(`G62 real source delivery was not stored: ${outcome.outcome}`);
  return handoffs[0]!;
}

function realSourceNamespaceWithArrival(onFirstFetch: () => Promise<void>): DurableObjectNamespace {
  let arrived = false;
  return {
    idFromName: (name: string) => tags().idFromName(name),
    get: (id: DurableObjectId) => {
      const delegate = tags().get(id);
      return {
        fetch: async (request: Request) => {
          if (!arrived) {
            arrived = true;
            await onFirstFetch();
          }
          return delegate.fetch(request);
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

function sourceNamespace(source: SourceFixture): DurableObjectNamespace {
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    // The fixture intentionally uses one source stub for every tag. The
    // request body still carries the exact partition identity being scanned.
    get: () => source as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace;
}

function factFrom(message: DownstreamOutboxMessage, obligationSequence = message.completeness.obligationSequence): SourceObligationFact {
  return {
    ...message.completeness,
    obligationSequence,
    eventId: message.eventId,
    status: "acknowledged",
  };
}

function pageResponse(input: SourcePageInput, rows: readonly SourceObligationFact[]): Response {
  const pageRows = rows
    .filter((row) => row.obligationSequence > input.afterSequence && row.obligationSequence <= input.upperBoundSequence)
    .slice(0, input.limit);
  const lastSequence = pageRows.at(-1)?.obligationSequence ?? input.afterSequence;
  const hasMore = rows.some((row) => row.obligationSequence > lastSequence && row.obligationSequence <= input.upperBoundSequence);
  const page: SourceObligationPage = {
    serviceId: input.serviceId,
    tag: input.tag,
    upperBoundSequence: input.upperBoundSequence,
    observedMaxSequence: input.upperBoundSequence,
    afterSequence: input.afterSequence,
    rows: pageRows,
    hasMore,
  };
  return new Response(JSON.stringify(page), { headers: { "content-type": "application/json" } });
}

function sourceWithRows(rowsForTag: (input: SourcePageInput) => readonly SourceObligationFact[], onFetch?: (input: SourcePageInput) => Promise<void>): SourceFixture {
  return {
    async fetch(request): Promise<Response> {
      const input = await request.json<SourcePageInput>();
      await onFetch?.(input);
      return pageResponse(input, rowsForTag(input));
    },
  };
}

async function registerPartition(serviceId: string, tag: string, upperBoundSequence: number, registeredAt: number): Promise<void> {
  await database().prepare(
    `INSERT INTO serialized_dcb_source_partitions (service_id, partition_tag, last_obligation_sequence, registered_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (service_id, partition_tag) DO UPDATE SET last_obligation_sequence = excluded.last_obligation_sequence`,
  ).bind(serviceId, tag, upperBoundSequence, registeredAt).run();
}

async function applyBaseMigrations(): Promise<void> {
  const statements = (g32Migration as string).replace(/^\s*--.*$/gm, "")
    .split(";").map((statement) => statement.trim()).filter(Boolean)
    .map((statement) => database().prepare(statement));
  await database().batch(statements);
  await applyG44D1Migration(database());
}

beforeAll(async () => {
  await applyBaseMigrations();
});

describe("SDT-G62 local completeness frontier soundness", () => {
  it("AC1: sustained new source-partition stream settles the start-of-pass frontier", async () => {
    const serviceId = `g62-ac1-real-${crypto.randomUUID()}`;
    const base = { serviceId, tag: `room:g62:real-base:${crypto.randomUUID()}` };
    const baseMessage = await appendAndRecordRealSource(
      base,
      "g62-ac1-real-base",
      g32SuidAt(1_000, "g62-ac1-real-base"),
      2_000,
    );
    const baseline = new GlobalCompletenessReconciler(database(), tags());
    await expect(baseline.reconcile(serviceId, 3_000)).resolves.toMatchObject({ kind: "FULL", scannedObligations: 1 });
    const baselineHealth = await baseline.readHealth(serviceId, 3_001);
    const baselineFrontier = baselineHealth.lastSettledFrontierSuid;
    expect(baselineFrontier).toBe(baseMessage.suid);

    const streamMessages: DownstreamOutboxMessage[] = [];
    const observations: Array<Record<string, unknown>> = [];
    for (let pass = 1; pass <= 3; pass += 1) {
      const streamTag = `room:g62:real-stream:${pass}:${crypto.randomUUID()}`;
      const streamScanner = new GlobalCompletenessReconciler(
        database(),
        realSourceNamespaceWithArrival(async () => {
          streamMessages.push(await appendAndRecordRealSource(
            { serviceId, tag: streamTag },
            `g62-ac1-real-stream-${pass}`,
            g32SuidAt(2_000 + pass, `g62-ac1-real-stream-${pass}`),
            4_000 + pass,
          ));
        }),
      );
      const result = await streamScanner.reconcile(serviceId, 5_000 + pass);
      const health = await streamScanner.readHealth(serviceId, 5_000 + pass);
      const coverage = await streamScanner.coverage(serviceId, 5_000 + pass);
      observations.push({
        pass,
        resultKind: result.kind,
        resultReason: "reason" in result ? result.reason : null,
        healthStatus: health.status,
        healthLastError: health.lastError,
        coverageKind: coverage.kind,
        coverageReason: coverage.reason,
        frontierSuid: coverage.frontierSuid,
        lastSettledFrontierSuid: health.lastSettledFrontierSuid,
      });
    }

    // This JSON marker is intentionally emitted before the green expectation:
    // the pre-fix guard captures all current-main BLOCK/UNKNOWN ticks and the
    // retained frontier rather than losing the useful failure context. Every
    // stream row came from a real Tag DO commit, registry row, and D1 receipt.
    console.error(`G62_AC1_OBSERVATIONS ${JSON.stringify({
      baselineFrontier,
      committedObligations: streamMessages.map((message) => ({
        serviceId: message.serviceId,
        tag: message.tag,
        obligationSequence: message.completeness.obligationSequence,
        eventId: message.eventId,
        suid: message.suid,
      })),
      observations,
    })}`);
    expect(observations.map((observation) => observation.resultKind)).toEqual(["FULL", "FULL", "FULL"]);
    expect(observations.map((observation) => observation.coverageKind)).toEqual(["SETTLED", "SETTLED", "SETTLED"]);
    const frontiers = observations.map((observation) => observation.frontierSuid);
    expect(frontiers.every((frontier) => typeof frontier === "string")).toBe(true);
    expect(frontiers[0]).toBe(baselineFrontier);
    expect(frontiers.every((frontier, index) => index === 0 || (frontier as string) > (frontiers[index - 1] as string))).toBe(true);
    expect(frontiers[1]).toBe(streamMessages[0]?.suid);
    expect(frontiers[2]).toBe(streamMessages[1]?.suid);
  });

  it("AC2: cursor-aware admission blocks a committed post-snapshot obligation until a later scan includes it", async () => {
    const serviceId = `g62-ac2-cursor-${crypto.randomUUID()}`;
    const scopeA = { serviceId, tag: `room:g62:cursor-a:${crypto.randomUUID()}` };
    const scopeB = { serviceId, tag: `room:g62:cursor-b:${crypto.randomUUID()}` };
    const messageA = await appendAndRecordRealSource(scopeA, "g62-ac2-cursor-a", g32SuidAt(10_000, "g62-ac2-cursor-a"), 10_001);
    const store = new D1EventStore(database());
    await store.initialize();
    const scanner = new GlobalCompletenessReconciler(database(), tags());
    await expect(scanner.reconcile(serviceId, 11_000)).resolves.toMatchObject({ kind: "FULL", scannedObligations: 1 });
    const afterA = await scanner.readHealth(serviceId, 11_001);
    const afterACursor = JSON.parse(afterA.cursorJson ?? "null") as { snapshots?: unknown };
    expect(afterACursor.snapshots).toEqual([{ serviceId, tag: scopeA.tag, upperBoundSequence: 1 }]);

    const appliedEventIds: string[] = [];
    const view: DeliveryViewHandler = {
      id: "g62-cursor-view",
      apply: async ({ message }) => {
        appliedEventIds.push(message.eventId);
        return "applied";
      },
    };
    await expect(processDownstreamDelivery(messageA, { D1: database(), TAG: tags() }, {
      store,
      views: [view],
      clock: { now: () => 11_002 },
    })).resolves.toBeUndefined();
    expect(appliedEventIds).toEqual([messageA.eventId]);

    // B is a real post-snapshot Tag commit and registered source obligation.
    // Its global receipt exists before the admission attempt, so the only
    // remaining proof is whether the persisted cursor contains B.
    const messageB = await appendAndRecordRealSource(scopeB, "g62-ac2-cursor-b", g32SuidAt(10_001, "g62-ac2-cursor-b"), 12_001);
    await expect(processDownstreamDelivery(messageB, { D1: database(), TAG: tags() }, {
      store,
      views: [view],
      clock: { now: () => 12_002 },
    })).rejects.toThrow(/^downstream_delivery_retry:/);
    expect(appliedEventIds).toEqual([messageA.eventId]);

    const beforeB = await scanner.readHealth(serviceId, 12_003);
    const beforeBCursor = JSON.parse(beforeB.cursorJson ?? "null") as { snapshots?: unknown };
    await expect(scanner.coverageForObligation(
      serviceId,
      scopeB.tag,
      messageB.completeness.obligationSequence,
      12_004,
    )).resolves.toMatchObject({
      kind: "BLOCK/UNSETTLED",
      reason: `obligation_not_in_settled_cursor:${scopeB.tag}:${messageB.completeness.obligationSequence}`,
      partitionTag: scopeB.tag,
    });
    await expect(scanner.reconcile(serviceId, 13_000)).resolves.toMatchObject({ kind: "FULL", scannedObligations: 2 });
    const afterB = await scanner.readHealth(serviceId, 13_001);
    const afterBCursor = JSON.parse(afterB.cursorJson ?? "null") as { snapshots?: unknown };
    expect(afterBCursor.snapshots).toEqual([
      { serviceId, tag: scopeA.tag, upperBoundSequence: 1 },
      { serviceId, tag: scopeB.tag, upperBoundSequence: 1 },
    ]);
    await expect(processDownstreamDelivery(messageB, { D1: database(), TAG: tags() }, {
      store,
      views: [view],
      clock: { now: () => 13_002 },
    })).resolves.toBeUndefined();
    expect(appliedEventIds).toEqual([messageA.eventId, messageB.eventId]);
    console.error(`G62_AC2_CURSOR_OBSERVATIONS ${JSON.stringify({
      a: { serviceId, tag: scopeA.tag, obligationSequence: messageA.completeness.obligationSequence, cursor: afterACursor, applied: true },
      b: {
        serviceId,
        tag: scopeB.tag,
        obligationSequence: messageB.completeness.obligationSequence,
        cursorBeforeAdmission: beforeBCursor,
        blockedWhileOmitted: true,
        cursorAfterScan: afterBCursor,
        appliedAfterInclusion: true,
      },
    })}`);
  });

  it("AC3: a gap in a start-of-pass partition prevents frontier advancement", async () => {
    const serviceId = `g62-ac3-${crypto.randomUUID()}`;
    const tag = `room:g62:gap:${crypto.randomUUID()}`;
    const first = g32Message({ serviceId, tag, eventId: "g62-ac3-first", suid: "g62-ac3-first", obligationSequence: 1 });
    const gap = g32Message({ serviceId, tag, eventId: "g62-ac3-gap", suid: "g62-ac3-gap", obligationSequence: 3 });
    await registerPartition(serviceId, tag, 3, 6_000);
    const source = sourceWithRows(() => [factFrom(first, 1), factFrom(gap, 3)]);
    const scanner = new GlobalCompletenessReconciler(
      database(),
      sourceNamespace(source),
      G44_SCANNER_VERSION,
      { globalReceiptMatcher: async () => true },
    );

    await expect(scanner.reconcile(serviceId, 7_000)).resolves.toMatchObject({
      kind: "UNKNOWN",
      reason: expect.stringContaining("source_page_sequence_outside_snapshot"),
    });
    await expect(scanner.coverage(serviceId, 7_001)).resolves.toMatchObject({
      kind: "BLOCK/UNSETTLED",
      reason: expect.stringContaining("source_page_sequence_outside_snapshot"),
      frontierSuid: null,
    });
  });
});
