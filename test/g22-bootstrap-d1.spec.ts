import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

// @ts-expect-error Vite raw asset import keeps migration execution tied to the committed SQL.
import migration from "../migrations/d1/0001_pipeline_store.sql?raw";
// @ts-expect-error Vite raw asset import keeps migration execution tied to the committed SQL.
import identityMigration from "../migrations/d1/0002_g27_event_identity.sql?raw";
import { createD1BootstrapAdapter, D1EventStore, D1IdentityConflictError } from "../packages/dcb-runtime/src/d1";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { runG22BootstrapProviderContract } from "./helpers/g22-bootstrap-provider-contract";

function database(): D1Database {
  const binding = (env as unknown as { D1?: D1Database }).D1;
  if (binding === undefined) throw new Error("D1 binding is required for the real Miniflare bootstrap contract");
  return binding;
}

describe("SDT-G22 D1 bootstrap provider adapter", () => {
  beforeAll(async () => {
    const statements = `${migration as string}\n${identityMigration as string}`.replace(/^\s*--.*$/gm, "").split(";").map((statement) => statement.trim()).filter(Boolean);
    await database().batch(statements.map((statement) => database().prepare(statement)));
  });

  it("runs export snapshot and admission identity invariants against D1EventStore in Miniflare", async () => {
    await runG22BootstrapProviderContract("d1", new D1EventStore(database()), (store) => createD1BootstrapAdapter(store as D1EventStore));
  });

  it("attributes canonical-key divergence to the D1 fail-before-batch guard", async () => {
    const serviceId = `g22-d1-direct-${crypto.randomUUID()}`;
    const tag = `g22:d1:direct:${crypto.randomUUID()}`;
    const canonical: DownstreamOutboxMessage = {
      version: 1,
      serviceId,
      allocatorLineageId: "g22-d1-direct-lineage",
      tag,
      attemptId: "g22-d1-direct-attempt",
      eventId: "DifferentIdentity:1",
      suid: "suid-00000000000000000000000000000031",
      payload: "AQ==",
      eventTags: [tag],
      eventType: "OrderPlaced:2",
      provenance: "g27",
      enqueuedAt: 1_000,
    };
    const initialStore = new D1EventStore(database());
    await initialStore.initialize();
    await initialStore.recordDelivery(canonical, 2_000);
    const snapshot = async () => ({
      events: await initialStore.readAllEvents(serviceId, ""),
      lag: await initialStore.currentLagBound(serviceId, 2_000),
      pending: await initialStore.listPending(serviceId),
      findings: await initialStore.listFindings(serviceId),
      incidents: await initialStore.listDeliveryIncidents(serviceId),
    });
    const before = await snapshot();
    let recordBatchStarts = 0;
    const guardedStore = new D1EventStore(database(), {
      beforeBatch: (operation, statements) => {
        if (operation === "recordDelivery") recordBatchStarts += 1;
        return statements;
      },
    });
    await guardedStore.initialize();
    await expect(guardedStore.recordDelivery({ ...canonical, eventType: "OrderPlaced:1" }, 2_001))
      .rejects.toBeInstanceOf(D1IdentityConflictError);
    expect(recordBatchStarts).toBe(0);
    expect(await snapshot()).toEqual(before);
  });
});
