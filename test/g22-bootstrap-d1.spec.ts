import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

// @ts-expect-error Vite raw asset import keeps migration execution tied to the committed SQL.
import g32Migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";
import { createD1BootstrapAdapter, D1EventStore, D1IdentityConflictError } from "../packages/dcb-runtime/src/d1";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { runG22BootstrapProviderContract } from "./helpers/g22-bootstrap-provider-contract";
import { g32Message } from "./helpers/g32-fixtures";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";

function database(): D1Database {
  const binding = (env as unknown as { D1?: D1Database }).D1;
  if (binding === undefined) throw new Error("D1 binding is required for the real Miniflare bootstrap contract");
  return binding;
}

// D1 result metadata contains both semantic mutation/query facts and
// provider-driver observations.  The latter are not durable state: Miniflare
// can report a different duration (or routing/retry metadata) for the same
// unchanged query.  Keep every result and semantic meta field in snapshots,
// while excluding only those non-semantic driver fields.
const D1_DRIVER_ONLY_META_KEYS = new Set([
  "duration",
  "served_by_region",
  "served_by_colo",
  "served_by_primary",
  "timings",
  "total_attempts",
]);

function semanticD1Result<T extends { readonly meta: Record<string, unknown> }>(result: T): Omit<T, "meta"> & { readonly meta: Record<string, unknown> } {
  const meta = Object.fromEntries(
    Object.entries(result.meta).filter(([key]) => !D1_DRIVER_ONLY_META_KEYS.has(key)),
  );
  return { ...result, meta };
}

describe("SDT-G22 D1 bootstrap provider adapter", () => {
  beforeAll(async () => {
    const statements = (g32Migration as string).replace(/^\s*--.*$/gm, "").split(";").map((statement) => statement.trim()).filter(Boolean);
    await database().batch(statements.map((statement) => database().prepare(statement)));
    await applyG44D1Migration(database());
  });

  it("runs export snapshot and admission identity invariants against D1EventStore in Miniflare", async () => {
    await runG22BootstrapProviderContract("d1", new D1EventStore(database()), (store) => createD1BootstrapAdapter(store as D1EventStore));
  });

  it("attributes canonical-key divergence to the D1 fail-before-batch guard", async () => {
    const serviceId = `g22-d1-direct-${crypto.randomUUID()}`;
    const tag = `g22:d1:direct:${crypto.randomUUID()}`;
    const canonical: DownstreamOutboxMessage = g32Message({
      serviceId,
      allocatorLineageId: "g22-d1-direct-lineage",
      tag,
      attemptId: "g22-d1-direct-attempt",
      eventId: "DifferentIdentity:1",
      suid: "g22-d1-direct",
      payload: JSON.stringify({ value: 1 }),
      eventTags: [tag],
      eventType: "OrderPlaced",
      enqueuedAt: 1_000,
    });
    const initialStore = new D1EventStore(database());
    await initialStore.initialize();
    const initialDiagnosticPromises: Promise<void>[] = [];
    await initialStore.recordDelivery(canonical, 2_000, "queue", {
      waitUntil: (promise) => initialDiagnosticPromises.push(promise),
    });
    await Promise.all(initialDiagnosticPromises);
    const snapshot = async () => ({
      events: await initialStore.readAllEvents(serviceId, ""),
      lag: await initialStore.currentLagBound(serviceId, 2_000),
      pending: await initialStore.listPending(serviceId),
      findings: await initialStore.listFindings(serviceId),
      incidents: await initialStore.listDeliveryIncidents(serviceId),
      diagnosticAttempts: semanticD1Result(await database().prepare(
        `SELECT sequence, event_id, receipt_status, mutation_evidence
           FROM serialized_dcb_g69_admission_attempts
          WHERE service_id = ? ORDER BY sequence`,
      ).bind(serviceId).all<Record<string, unknown>>()),
    });
    const before = await snapshot();
    let recordBatchStarts = 0;
    const deferredDiagnosticPromises: Promise<void>[] = [];
    const guardedStore = new D1EventStore(database(), {
      beforeBatch: (operation, statements) => {
        if (operation === "recordDelivery") recordBatchStarts += 1;
        return statements;
      },
    });
    await guardedStore.initialize();
    const rejected = guardedStore.recordDelivery({ ...canonical, eventType: "OrderPlacedRenamed" }, 2_001, "queue", {
      waitUntil: (promise) => deferredDiagnosticPromises.push(promise),
    });
    await expect(rejected).rejects.toBeInstanceOf(D1IdentityConflictError);
    expect(recordBatchStarts).toBe(0);
    expect(deferredDiagnosticPromises).toHaveLength(0);
    expect(await snapshot()).toEqual(before);
  });
});
