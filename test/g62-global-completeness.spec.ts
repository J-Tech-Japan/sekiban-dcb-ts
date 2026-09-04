import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { GlobalCompletenessReconciler } from "../packages/dcb-runtime/src/completeness/GlobalCompletenessReconciler";
import { G44_SCANNER_VERSION, type SourceObligationFact, type SourceObligationPage } from "../packages/dcb-runtime/src/completeness/types";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { D1EventStore } from "../packages/dcb-runtime/src/store/D1EventStore";
import { g32Message } from "./helpers/g32-fixtures";
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
    const serviceId = `g62-ac1-${crypto.randomUUID()}`;
    const baseTag = `room:g62:base:${crypto.randomUUID()}`;
    const message = g32Message({
      serviceId,
      tag: baseTag,
      eventId: "g62-ac1-frontier-event",
      suid: "g62-ac1-frontier-suid",
      obligationSequence: 1,
    });
    await registerPartition(serviceId, baseTag, 1, 1_000);
    const store = new D1EventStore(database());
    await store.initialize();
    await expect(store.recordDelivery(message, 2_000)).resolves.toMatchObject({ outcome: "stored" });

    const stableSource = sourceWithRows((input) => input.tag === baseTag ? [factFrom(message)] : []);
    const baseline = new GlobalCompletenessReconciler(database(), sourceNamespace(stableSource));
    await expect(baseline.reconcile(serviceId, 3_000)).resolves.toMatchObject({ kind: "FULL" });
    const baselineHealth = await baseline.readHealth(serviceId, 3_001);
    const baselineFrontier = baselineHealth.lastSettledFrontierSuid;
    expect(baselineFrontier).toBe(message.suid);

    let arrival = 0;
    const streamingSource = sourceWithRows(
      (input) => input.tag === baseTag ? [factFrom(message)] : [],
      async () => {
        arrival += 1;
        await registerPartition(serviceId, `room:g62:stream:${arrival}`, 0, 4_000 + arrival);
      },
    );
    const scanner = new GlobalCompletenessReconciler(database(), sourceNamespace(streamingSource));
    const observations: Array<Record<string, unknown>> = [];
    for (let pass = 1; pass <= 3; pass += 1) {
      const result = await scanner.reconcile(serviceId, 5_000 + pass);
      const health = await scanner.readHealth(serviceId, 5_000 + pass);
      const coverage = await scanner.coverage(serviceId, 5_000 + pass);
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
    // retained frontier rather than losing the useful failure context.
    console.error(`G62_AC1_OBSERVATIONS ${JSON.stringify({ baselineFrontier, observations })}`);
    expect(observations.map((observation) => observation.resultKind)).toEqual(["FULL", "FULL", "FULL"]);
    expect(observations.map((observation) => observation.coverageKind)).toEqual(["SETTLED", "SETTLED", "SETTLED"]);
    expect(observations.every((observation) => observation.frontierSuid === baselineFrontier)).toBe(true);
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
