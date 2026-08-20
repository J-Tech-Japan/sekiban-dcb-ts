import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error Vite raw migration import.
import migration0001 from "../migrations/mv/0001_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration import.
import migration0002 from "../migrations/mv/0002_unsafe_window_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration import.
import migration0003 from "../migrations/mv/0003_checkpoint_ahead_hardening.sql?raw";
// @ts-expect-error Vite raw source import for the literal-restoration mutation oracle.
import serviceIdentitySource from "../packages/dcb-runtime/src/http/testServiceId.ts?raw";
// @ts-expect-error Vite raw script import for deploy preflight verification.
import deployScriptSource from "../scripts/deploy/g15-deploy.sh?raw";
import { defineRowMaterializer } from "@sekiban/dcb-core";
import { createRuntimeWorker } from "../packages/dcb-runtime/src/index";
import { handleSerializedQuery } from "../packages/dcb-runtime/src/http/SerializedQueryWorker";
import { TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/http/testServiceId";
import { MaterializedViewCatchUpRuntime } from "../packages/dcb-runtime/src/mv/MaterializedViewCatchUp";
import { D1MaterializedViewStore } from "../packages/dcb-runtime/src/mv/MaterializedViewStore";
import type { ProjectionStore, StoredEvent } from "../packages/dcb-runtime/src/store/types";

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
  return { serviceId: "g24", eventId: `event-${suid}`, suid, payload: "e30=", eventTags: [], firstArrivedAt: 0, lastArrivedAt: 0, maxDeliveryLagMs: 0, arrivals: [] };
}

async function checkpointAheadFixture(): Promise<{ serviceId: string; views: D1MaterializedViewStore; runtime: MaterializedViewCatchUpRuntime }> {
  const serviceId = `g24-checkpoint-${crypto.randomUUID()}`;
  const views = new D1MaterializedViewStore(database());
  await views.initialize();
  await views.createActive({ serviceId, viewId: VIEW_ID, definitionVersion: 1, updatedAt: 1, lastSuid: "suid-9" });
  // This source has legal lineage, no collision, and monotonically ordered
  // rows. Only its maximum being behind the checkpoint can trigger G24.
  return { serviceId, views, runtime: new MaterializedViewCatchUpRuntime(source([event("suid-1")]), views) };
}

describe("SDT-G24 hardening guards", () => {
  beforeAll(async () => {
    await database().batch(statements(migration0001 as string));
    await database().batch(statements(migration0002 as string));
    await database().batch(statements(migration0003 as string));
  });

  it("records only the idempotent CHECKPOINT_AHEAD finding for a legal store-behind-checkpoint fixture, without rollback", async () => {
    const fixture = await checkpointAheadFixture();
    await expect(fixture.runtime.follow(fixture.serviceId, materializer, 100)).rejects.toThrow("CHECKPOINT_AHEAD");
    await expect(fixture.runtime.follow(fixture.serviceId, materializer, 101)).rejects.toThrow("CHECKPOINT_AHEAD");
    expect((await fixture.views.readActive(fixture.serviceId, VIEW_ID))?.lastSuid).toBe("suid-9");
    expect(await fixture.views.hasCheckpointAheadFinding(fixture.serviceId, VIEW_ID)).toBe(true);
    const persisted = await database().prepare("SELECT COUNT(*) AS count FROM mv_checkpoint_ahead_findings WHERE service_id = ? AND view_id = ?").bind(fixture.serviceId, VIEW_ID).first<{ count: number }>();
    expect(Number(persisted?.count)).toBe(1);
  });

  it("fails query and list-query closed in the existing V1 projection_unavailable shape while tag authority is not selected", async () => {
    const fixture = await checkpointAheadFixture();
    await expect(fixture.runtime.follow(fixture.serviceId, materializer, 100)).rejects.toThrow("CHECKPOINT_AHEAD");
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

  it("requires SDT_SERVICE_ID independently at fetch, queue, and scheduled entries", async () => {
    const worker = createRuntimeWorker();
    await expect(worker.fetch!(new Request("https://g24.test/api/sekiban/serialized/query", { method: "POST" }) as never, {} as never, {} as ExecutionContext)).rejects.toThrow("SDT_SERVICE_ID is required");
    await expect(worker.queue!({ messages: [] } as never, {} as never, {} as ExecutionContext)).rejects.toThrow("SDT_SERVICE_ID is required");
    await expect(worker.scheduled!({} as never, {} as never, {} as ExecutionContext)).rejects.toThrow("SDT_SERVICE_ID is required");
  });

  it("keeps the service guard independent: a configured identity reaches normal V1 validation without a checkpoint finding", async () => {
    const worker = createRuntimeWorker();
    const response = await worker.fetch!(new Request("https://g24.test/api/sekiban/serialized/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ queryType: "unknown", queryParamsJson: "{}" }) }) as never, { SDT_SERVICE_ID: "g24-consistent-service" } as never, {} as ExecutionContext);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "validation_error" });
  });

  it("rejects restoration of the retired literal default in the dedicated source mutation oracle", async () => {
    expect(serviceIdentitySource as string).not.toContain('"serialized-dcb-v1"');
    expect(deployScriptSource as string).toContain("G15_SERVICE_ID must be a non-empty deployment service identity");
  });
});
