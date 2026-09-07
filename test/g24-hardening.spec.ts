import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
// @ts-expect-error Vite raw migration import.
import migration0001 from "../migrations/mv/0001_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration import.
import migration0002 from "../migrations/mv/0002_unsafe_window_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration import.
import migration0003 from "../migrations/mv/0003_checkpoint_ahead_hardening.sql?raw";
// @ts-expect-error Vite raw migration import.
import migration0004 from "../migrations/mv/0004_unsafe_window_failure_findings.sql?raw";
// @ts-expect-error Vite raw migration import.
import migration0005 from "../migrations/mv/0005_g31_wait_receipts.sql?raw";
// @ts-expect-error Vite raw migration import.
import migration0006 from "../migrations/mv/0006_g31_wait_target_poison.sql?raw";
// @ts-expect-error Vite raw migration imports.
import migration0007 from "../migrations/mv/0007_g69_ordering_quarantine.sql?raw";
// @ts-expect-error Vite raw source import for the literal-restoration mutation oracle.
import serviceIdentitySource from "../packages/dcb-runtime/src/http/testServiceId.ts?raw";
import { defineRowMaterializer } from "@sekiban/dcb-core";
import { createRuntimeWorker } from "../packages/dcb-runtime/src/index";
import { handleSerializedQuery } from "../packages/dcb-runtime/src/http/SerializedQueryWorker";
import { TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/http/testServiceId";
import { MaterializedViewCatchUpRuntime } from "../packages/dcb-runtime/src/mv/MaterializedViewCatchUp";
import { D1MaterializedViewStore } from "../packages/dcb-runtime/src/mv/MaterializedViewStore";
import type { ProjectionStore, StoredEvent } from "../packages/dcb-runtime/src/store/types";
import type * as DownstreamAdapter from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import type * as LiveProjectionWorker from "../packages/dcb-runtime/src/projection/LiveProjectionWorker";
import { G32_FIXTURE_TIMESTAMP, g32EventId, g32Suid } from "./helpers/g32-fixtures";

// The scheduled-entry oracle must not be satisfied by a later identity check
// in either downstream stabilization or projection polling.  These test-local
// seams leave every other RuntimeWorker path on its production implementation.
const scheduledDependencies = vi.hoisted(() => ({
  stabilize: vi.fn(async () => {}),
  poll: vi.fn(async () => []),
}));

vi.mock("../packages/dcb-runtime/src/downstream/DownstreamAdapter", async (importOriginal) => {
  const original = await importOriginal<typeof DownstreamAdapter>();
  return { ...original, stabilizeDownstream: scheduledDependencies.stabilize };
});

vi.mock("../packages/dcb-runtime/src/projection/LiveProjectionWorker", async (importOriginal) => {
  const original = await importOriginal<typeof LiveProjectionWorker>();
  return { ...original, pollLiveProjections: scheduledDependencies.poll };
});

const VIEW_ID = "test-projector";
const materializer = defineRowMaterializer<StoredEvent>({
  id: VIEW_ID,
  version: 1,
  indexDescriptors: [],
  materialize: (event) => ({ rowUpserts: [{ rowKey: event.eventId, value: { eventId: event.eventId }, sourceSuid: event.suid }] }),
});

function database(): D1Database {
  const binding = (env as unknown as { D1_MV?: D1Database }).D1_MV;
  if (binding === undefined) throw new Error("G24 requires D1_MV");
  return binding;
}

function statements(sql: string): D1PreparedStatement[] {
  return sql.replace(/^\s*--.*$/gm, "").split(";").map((item) => item.trim()).filter(Boolean).map((item) => database().prepare(item));
}

function source(events: readonly StoredEvent[]): ProjectionStore {
  return {
    readAllEvents: async (_serviceId, since) => events.filter((event) => event.suid > since),
    currentLagBound: async () => 0,
    listProjectionTags: async () => [],
    readProjectionCheckpoint: async () => undefined,
    advanceProjectionCheckpoint: async () => false,
    projectionLag: async () => ({ serviceId: "g24", projectionId: "g24", tag: "g24", checkpointSuid: "", headSuid: "", behindEvents: 0 }),
    appendDeliveryIncident: async () => {},
  };
}

function event(suid: string): StoredEvent {
  return {
    serviceId: "g24",
    id: g32EventId(`event-${suid}`),
    eventId: g32EventId(`event-${suid}`),
    sortableUniqueId: g32Suid(suid),
    suid: g32Suid(suid),
    payload: JSON.stringify({}),
    tags: [],
    eventTags: [],
    eventType: "G24FixtureEvent",
    timestamp: G32_FIXTURE_TIMESTAMP,
    causationId: null,
    correlationId: null,
    executedUser: null,
    provenance: "g32",
    firstArrivedAt: 0,
    lastArrivedAt: 0,
    maxDeliveryLagMs: 0,
    arrivals: [],
  };
}

async function checkpointAheadFixture(): Promise<{ serviceId: string; views: D1MaterializedViewStore; runtime: MaterializedViewCatchUpRuntime }> {
  const serviceId = `g24-checkpoint-${crypto.randomUUID()}`;
  const views = new D1MaterializedViewStore(database());
  await views.initialize();
  await views.createActive({ serviceId, viewId: VIEW_ID, definitionVersion: 1, updatedAt: 1, lastSuid: g32Suid("g24-suid-9") });
  // This source has legal lineage, no collision, and monotonically ordered
  // rows. Only its maximum being behind the checkpoint can trigger G24.
  return { serviceId, views, runtime: new MaterializedViewCatchUpRuntime(source([event("g24-suid-1")]), views) };
}

async function checkpointAheadReadFixture(): Promise<{ serviceId: string; views: D1MaterializedViewStore }> {
  const fixture = await checkpointAheadFixture();
  // AC#2 starts from the already-persisted operational finding.  It must not
  // rely on the catch-up detector whose own mutation belongs exclusively to
  // AC#1.
  await fixture.views.recordCheckpointAhead({
    serviceId: fixture.serviceId,
    viewId: VIEW_ID,
    generation: 0,
    checkpointSuid: g32Suid("g24-suid-9"),
    storeMaxSuid: g32Suid("g24-suid-1"),
    observedAt: 100,
  });
  return fixture;
}

describe("SDT-G24 hardening guards", () => {
  beforeAll(async () => {
    await database().batch(statements(migration0001 as string));
    await database().batch(statements(migration0002 as string));
    await database().batch(statements(migration0003 as string));
    await database().batch(statements(migration0004 as string));
    await database().batch(statements(migration0005 as string));
    await database().batch(statements(migration0006 as string));
    await database().batch(statements(migration0007 as string));
  });

  it("records only the idempotent CHECKPOINT_AHEAD finding for a legal store-behind-checkpoint fixture, without rollback", async () => {
    const fixture = await checkpointAheadFixture();
    await expect(fixture.runtime.follow(fixture.serviceId, materializer, 100)).rejects.toThrow("CHECKPOINT_AHEAD");
    await expect(fixture.runtime.follow(fixture.serviceId, materializer, 101)).rejects.toThrow("CHECKPOINT_AHEAD");
    expect((await fixture.views.readActive(fixture.serviceId, VIEW_ID))?.lastSuid).toBe(g32Suid("g24-suid-9"));
    expect(await fixture.views.hasCheckpointAheadFinding(fixture.serviceId, VIEW_ID)).toBe(true);
    const persisted = await database().prepare("SELECT COUNT(*) AS count FROM mv_checkpoint_ahead_findings WHERE service_id = ? AND view_id = ?").bind(fixture.serviceId, VIEW_ID).first<{ count: number }>();
    expect(Number(persisted?.count)).toBe(1);
  });

  it("fails query and list-query closed in the existing V1 projection_unavailable shape while tag authority is not selected", async () => {
    const fixture = await checkpointAheadReadFixture();
    for (const endpoint of ["query", "list-query"] as const) {
      const response = await handleSerializedQuery(new Request(`https://g24.test/api/sekiban/serialized/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: fixture.serviceId },
        body: JSON.stringify({ queryType: endpoint === "query" ? "GetTestCountQuery" : "GetTestListQuery", queryParamsJson: endpoint === "query" ? "{}" : "{\"PageNumber\":1,\"PageSize\":1}" }),
      }), {}, { queryBacking: "d1-mv", materializedViewQueryPort: fixture.views });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "projection_unavailable" });
    }
  });

  it("allows the explicit .test service-id override to reach ordinary V1 validation", async () => {
    const worker = createRuntimeWorker();
    const response = await worker.fetch!(new Request("https://g24.test/api/sekiban/serialized/query", {
      method: "POST",
      headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: "g24-fetch-test-identity" },
      body: JSON.stringify({ queryType: "unknown", queryParamsJson: "{}" }),
    }) as never, {} as never, {} as ExecutionContext);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "validation_error" });
  });

  it("returns typed scope.identity_missing when neither deployment nor explicit test identity resolves", async () => {
    const worker = createRuntimeWorker();
    const response = await worker.fetch!(new Request("https://g24.example/api/sekiban/serialized/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queryType: "unknown", queryParamsJson: "{}" }),
    }) as never, {} as never, {} as ExecutionContext);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "scope.identity_missing" });
  });

  it("requires SDT_SERVICE_ID at queue before an empty batch can reach downstream handling", async () => {
    const worker = createRuntimeWorker();
    await expect(worker.queue!({ messages: [] } as never, {} as never, {} as ExecutionContext)).rejects.toThrow("SDT_SERVICE_ID is required");
  });

  it("requires SDT_SERVICE_ID at scheduled before downstream identity guards can run", async () => {
    const worker = createRuntimeWorker();
    scheduledDependencies.stabilize.mockClear();
    scheduledDependencies.poll.mockClear();
    await expect(worker.scheduled!({} as never, {} as never, {} as ExecutionContext)).rejects.toThrow("SDT_SERVICE_ID is required");
    expect(scheduledDependencies.stabilize).not.toHaveBeenCalled();
    expect(scheduledDependencies.poll).not.toHaveBeenCalled();
  });

  it("keeps the service guard independent: a configured identity reaches normal V1 validation without a checkpoint finding", async () => {
    const worker = createRuntimeWorker();
    const response = await worker.fetch!(new Request("https://g24.test/api/sekiban/serialized/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ queryType: "unknown", queryParamsJson: "{}" }) }) as never, { SDT_SERVICE_ID: "g24-consistent-service" } as never, {} as ExecutionContext);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "validation_error" });
  });

  it("rejects restoration of the retired literal default in the dedicated source mutation oracle", async () => {
    expect(serviceIdentitySource as string).not.toContain('"serialized-dcb-v1"');
  });
});
