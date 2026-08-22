import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error Vite raw migration fixture.
import pipelineMigration from "../migrations/d1/0001_pipeline_store.sql?raw";
// @ts-expect-error Vite raw migration fixture.
import identityMigration from "../migrations/d1/0002_g27_event_identity.sql?raw";
// @ts-expect-error Vite raw migration fixture.
import waitIncidentMigration from "../migrations/d1/0003_g31_wait_target_incidents.sql?raw";
// @ts-expect-error Vite raw migration fixture.
import mvMigration from "../migrations/mv/0001_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration fixture.
import unsafeMigration from "../migrations/mv/0002_unsafe_window_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration fixture.
import hardeningMigration from "../migrations/mv/0003_checkpoint_ahead_hardening.sql?raw";
// @ts-expect-error Vite raw migration fixture.
import failureMigration from "../migrations/mv/0004_unsafe_window_failure_findings.sql?raw";
// @ts-expect-error Vite raw migration fixture.
import waitReceiptMigration from "../migrations/mv/0005_g31_wait_receipts.sql?raw";
// @ts-expect-error Vite raw migration fixture.
import waitPoisonMigration from "../migrations/mv/0006_g31_wait_target_poison.sql?raw";
// @ts-expect-error Raw source fixture for the no-full-scan mutation oracle.
import queryWorkerSource from "../packages/dcb-runtime/src/http/SerializedQueryWorker.ts?raw";
import {
  D1_WAIT_MAX_ITERATIONS,
  D1_WAIT_MAX_POINT_READS,
  handleSerializedQuery,
} from "../packages/dcb-runtime/src/http/SerializedQueryWorker";
import {
  D1MaterializedViewStore,
  type MaterializedViewRow,
  type MaterializedViewWaitForState,
} from "../packages/dcb-runtime/src/mv/MaterializedViewStore";
import { QueryRegistry } from "../packages/dcb-runtime/src/query/QueryRegistry";
import type {
  MaterializedViewQueryPort,
  QueryProjectionStore,
  WaitForTargetLookup,
  WaitForTargetSourcePort,
} from "../packages/dcb-runtime/src/query/ProjectionQueryStore";
import { D1EventStore } from "../packages/dcb-runtime/src/store/D1EventStore";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/http/testServiceId";

const VIEW_ID = "g31-wait-view";
const QUERY_TYPE = "G31WaitListQuery";

function d1(): D1Database {
  const database = (env as unknown as { D1?: D1Database }).D1;
  if (database === undefined) throw new Error("G31 requires the D1 source binding");
  return database;
}

function mvDatabase(): D1Database {
  const database = (env as unknown as { D1_MV?: D1Database }).D1_MV;
  if (database === undefined) throw new Error("G31 requires the D1_MV binding");
  return database;
}

function statements(database: D1Database, sql: string): D1PreparedStatement[] {
  return sql.replace(/^\s*--.*$/gm, "").split(";").map((value) => value.trim()).filter(Boolean).map((value) => database.prepare(value));
}

function registry(): QueryRegistry {
  return new QueryRegistry([{
    queryType: QUERY_TYPE,
    endpoint: "list-query",
    tagGroup: "test",
    tagProjector: "test-projector",
    materializedViewId: VIEW_ID,
    enabled: true,
  }]);
}

function request(serviceId: string, suid: string): Request {
  return new Request("https://g31.test/api/sekiban/serialized/list-query", {
    method: "POST",
    headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: serviceId },
    body: JSON.stringify({
      queryType: QUERY_TYPE,
      queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 20 }),
      waitForSortableUniqueId: suid,
    }),
  });
}

function message(serviceId: string, eventId: string, suid: string, lineage = "g31-lineage"): DownstreamOutboxMessage {
  return {
    version: 1,
    serviceId,
    allocatorLineageId: lineage,
    tag: `test:${serviceId}`,
    attemptId: `${eventId}-attempt`,
    eventId,
    suid,
    payload: btoa(JSON.stringify({ eventId, suid })),
    eventTags: [`test:${serviceId}`],
    provenance: "pre-g27-queue",
    enqueuedAt: 0,
  };
}

function mutation(eventId: string, suid: string) {
  return {
    rowUpserts: [{ rowKey: eventId, value: { eventId, suid }, rowVersion: 1, sourceSuid: suid }],
    rowPatches: [],
    rowDeletes: [],
    indexEntries: [],
    indexDeletes: [],
  };
}

async function sourceWithTarget(serviceId: string, eventId: string, suid: string): Promise<D1EventStore> {
  const source = new D1EventStore(d1());
  await source.initialize();
  expect((await source.recordDelivery(message(serviceId, eventId, suid), 0)).outcome).toBe("stored");
  return source;
}

async function activeView(serviceId: string, lastSuid = ""): Promise<D1MaterializedViewStore> {
  const views = new D1MaterializedViewStore(mvDatabase());
  await views.initialize();
  await views.createActive({ serviceId, viewId: VIEW_ID, definitionVersion: 1, updatedAt: 1, lastSuid });
  return views;
}

async function queryD1(
  source: QueryProjectionStore,
  views: MaterializedViewQueryPort,
  serviceId: string,
  suid: string,
  options: Parameters<typeof handleSerializedQuery>[2] = {},
): Promise<Response> {
  return handleSerializedQuery(request(serviceId, suid), {}, {
    queryBacking: "d1-mv",
    store: source,
    materializedViewQueryPort: views,
    registry: registry(),
    ...options,
  });
}

function state(overrides: Partial<MaterializedViewWaitForState> = {}): MaterializedViewWaitForState {
  return {
    activeGeneration: 0,
    activeDefinitionVersion: 1,
    safeContiguousHead: "",
    targetReceipt: false,
    checkpointAhead: false,
    rebuildRequired: false,
    poison: false,
    ...overrides,
  };
}

class FakeSource implements QueryProjectionStore, WaitForTargetSourcePort {
  target: WaitForTargetLookup = { kind: "pending" };
  targetReads = 0;
  lagReads = 0;
  fullScans = 0;

  async readWaitForTarget(): Promise<WaitForTargetLookup> {
    this.targetReads += 1;
    return this.target;
  }

  async readAllEvents(): Promise<never[]> {
    this.fullScans += 1;
    throw new Error("G31 d1-mv waitFor must not scan readAllEvents");
  }

  async currentLagBound(): Promise<number> {
    this.lagReads += 1;
    return 0;
  }

  async listProjectionTags(): Promise<string[]> { return []; }
  async readProjectionCheckpoint(): Promise<undefined> { return undefined; }
}

class FakeMaterializedView implements MaterializedViewQueryPort {
  stateReads = 0;

  constructor(private readonly states: MaterializedViewWaitForState[]) {}

  async queryRows(): Promise<MaterializedViewRow[]> { return []; }

  async readWaitForState(): Promise<MaterializedViewWaitForState> {
    this.stateReads += 1;
    return this.states[Math.min(this.stateReads - 1, this.states.length - 1)]!;
  }
}

class FlappingMaterializedView implements MaterializedViewQueryPort {
  stateReads = 0;

  async queryRows(): Promise<MaterializedViewRow[]> { return []; }

  async readWaitForState(): Promise<MaterializedViewWaitForState> {
    this.stateReads += 1;
    return state({ targetReceipt: this.stateReads % 2 === 1 });
  }
}

describe("SDT-G31 d1-mv waitFor", () => {
  beforeAll(async () => {
    await d1().batch(statements(d1(), `${pipelineMigration as string}\n${identityMigration as string}\n${waitIncidentMigration as string}`));
    for (const migration of [mvMigration, unsafeMigration, hardeningMigration, failureMigration, waitReceiptMigration, waitPoisonMigration]) {
      await mvDatabase().batch(statements(mvDatabase(), migration as string));
    }
  });

  it("succeeds via the active-generation receipt, then via the unique-source plus safe-head branch after receipt GC", async () => {
    const serviceId = `g31-receipt-${crypto.randomUUID()}`;
    const eventId = "g31-receipt-event";
    const suid = "suid-00000000000000000000000000000031";
    const source = await sourceWithTarget(serviceId, eventId, suid);
    const views = await activeView(serviceId);
    const unsafe = views.unsafeWindow();
    await unsafe.apply({
      serviceId,
      viewId: VIEW_ID,
      generation: 0,
      eventId,
      suid,
      safeHead: "",
      updatedAt: 2,
      mutations: mutation(eventId, suid),
    });
    expect((await queryD1(source, views, serviceId, suid)).status).toBe(200);

    await views.applyMutationsAndAdvanceCheckpoint({
      serviceId,
      viewId: VIEW_ID,
      generation: 0,
      expectedLastSuid: null,
      lastSuid: suid,
      definitionVersion: 1,
      updatedAt: 3,
      mutations: mutation(eventId, suid),
    });
    await unsafe.observeSafeReceipt(serviceId, VIEW_ID, 0, eventId, suid);
    expect(await views.collectUnsafeGarbage(serviceId, VIEW_ID, 0, 1, suid)).toBe(1);
    const receipts = await mvDatabase().prepare(
      "SELECT COUNT(*) AS count FROM mv_wait_receipts WHERE service_id = ? AND view_id = ? AND event_id = ?",
    ).bind(serviceId, VIEW_ID, eventId).first<{ count: number }>();
    expect(Number(receipts?.count)).toBe(0);
    expect((await queryD1(source, views, serviceId, suid)).status).toBe(200);
  });

  it("binds a receipt to the active generation and definition rather than an old view instance", async () => {
    const serviceId = `g31-generation-${crypto.randomUUID()}`;
    const eventId = "g31-generation-event";
    const suid = "suid-00000000000000000000000000000041";
    const source = await sourceWithTarget(serviceId, eventId, suid);
    const views = await activeView(serviceId);
    await views.unsafeWindow().apply({
      serviceId,
      viewId: VIEW_ID,
      generation: 0,
      eventId,
      suid,
      safeHead: "",
      updatedAt: 2,
      mutations: mutation(eventId, suid),
    });
    expect((await views.readWaitForState(serviceId, VIEW_ID, { eventId, suid })).targetReceipt).toBe(true);
    await views.recordUnsafeFailureFinding({ serviceId, viewId: VIEW_ID, generation: 0, eventId, suid, observedAt: 2 });
    expect((await views.readWaitForState(serviceId, VIEW_ID, { eventId, suid })).poison).toBe(true);
    await views.createCandidate({ serviceId, viewId: VIEW_ID, generation: 1, definitionVersion: 2, updatedAt: 3 });
    await views.promoteGeneration({ serviceId, viewId: VIEW_ID, candidateGeneration: 1, expectedActiveGeneration: 0, updatedAt: 4 });
    expect(await views.readWaitForState(serviceId, VIEW_ID, { eventId, suid })).toMatchObject({
      activeGeneration: 1,
      activeDefinitionVersion: 2,
      targetReceipt: false,
      poison: false,
    });
    let now = 0;
    expect((await queryD1(source, views, serviceId, suid, {
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    })).status).toBe(504);
  });

  it("never revives the forbidden safe-head-only branch when the source target is absent", async () => {
    const serviceId = `g31-safe-head-${crypto.randomUUID()}`;
    const requestedSuid = "suid-00000000000000000000000000000050";
    const views = await activeView(serviceId, "suid-00000000000000000000000000000099");
    const source = new FakeSource();
    let now = 0;
    const response = await queryD1(source, views, serviceId, requestedSuid, {
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });
    expect(response.status).toBe(504);
    expect(source.fullScans).toBe(0);
  });

  it("returns 503 before either success branch for collision aliases, lineage aliases, checkpoint-ahead, rebuild, and poison", async () => {
    const collisionService = `g31-collision-${crypto.randomUUID()}`;
    const collisionSuid = "suid-00000000000000000000000000000061";
    const collisionSource = await sourceWithTarget(collisionService, "first", collisionSuid);
    const collisionViews = await activeView(collisionService, collisionSuid);
    expect((await collisionSource.recordDelivery(message(collisionService, "aliased", collisionSuid), 1)).outcome).toBe("suid-collision");
    expect((await queryD1(collisionSource, collisionViews, collisionService, collisionSuid)).status).toBe(503);

    const lineageService = `g31-lineage-${crypto.randomUUID()}`;
    const lineageSource = await sourceWithTarget(lineageService, "first", "suid-00000000000000000000000000000062");
    const lineageSuid = "suid-00000000000000000000000000000063";
    expect((await lineageSource.recordDelivery(message(lineageService, "wrong-lineage", lineageSuid, "wrong-lineage"), 1)).outcome).toBe("lineage-mismatch");
    const lineageViews = await activeView(lineageService, lineageSuid);
    expect((await queryD1(lineageSource, lineageViews, lineageService, lineageSuid)).status).toBe(503);

    for (const gate of ["checkpoint", "rebuild", "poison"] as const) {
      const serviceId = `g31-${gate}-${crypto.randomUUID()}`;
      const suid = "suid-00000000000000000000000000000070";
      const source = await sourceWithTarget(serviceId, `${gate}-event`, suid);
      const views = await activeView(serviceId, suid);
      if (gate === "checkpoint") {
        await views.recordCheckpointAhead({ serviceId, viewId: VIEW_ID, generation: 0, checkpointSuid: suid, storeMaxSuid: "", observedAt: 2 });
      } else if (gate === "rebuild") {
        await mvDatabase().prepare(
          `INSERT INTO mv_unsafe_arrivals (service_id, view_id, generation, safe_head, arrival_watermark, rebuild_required)
           VALUES (?, ?, 0, ?, ?, 1)`,
        ).bind(serviceId, VIEW_ID, suid, suid).run();
      } else {
        await views.recordUnsafeFailureFinding({ serviceId, viewId: VIEW_ID, eventId: `${gate}-event`, suid, observedAt: 2 });
      }
      expect((await queryD1(source, views, serviceId, suid)).status).toBe(503);
    }
  });

  it("rechecks incident gates immediately before success and treats a contradictory source target as unavailable", async () => {
    const serviceId = `g31-race-${crypto.randomUUID()}`;
    const suid = "suid-00000000000000000000000000000080";
    const source = new FakeSource();
    source.target = { kind: "stored", eventId: "g31-race-event", suid };
    const flipToCheckpointAhead = new FakeMaterializedView([
      state({ targetReceipt: true }),
      state({ targetReceipt: true, checkpointAhead: true }),
    ]);
    expect((await queryD1(source, flipToCheckpointAhead, serviceId, suid)).status).toBe(503);
    expect(source.targetReads).toBe(2);
    expect(flipToCheckpointAhead.stateReads).toBe(2);

    const contradictory = new FakeSource();
    contradictory.target = { kind: "unavailable", reason: "suid-contradiction" };
    const views = new FakeMaterializedView([state({ targetReceipt: true })]);
    expect((await queryD1(contradictory, views, serviceId, suid)).status).toBe(503);
    expect(views.stateReads).toBe(0);
  });

  it("snapshots one absolute deadline and caps source/MV point reads without a full scan or N+1 growth", async () => {
    const serviceId = `g31-budget-${crypto.randomUUID()}`;
    const source = new FakeSource();
    const views = new FakeMaterializedView([state({ safeContiguousHead: "suid-z" })]);
    let now = 100;
    const response = await queryD1(source, views, serviceId, "suid-not-stored", {
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });
    expect(response.status).toBe(504);
    expect(now).toBe(20_100);
    expect(source.lagReads).toBe(1);
    expect(source.fullScans).toBe(0);
    expect(source.targetReads).toBe(views.stateReads);
    expect(source.targetReads * 2).toBeLessThanOrEqual(D1_WAIT_MAX_POINT_READS);

    const frozenClock = new FakeSource();
    const frozenViews = new FakeMaterializedView([state()]);
    const frozen = await queryD1(frozenClock, frozenViews, `${serviceId}-frozen`, "suid-not-stored", {
      now: () => 0,
      sleep: async () => {},
    });
    expect(frozen.status).toBe(504);
    expect(frozenClock.targetReads).toBe(D1_WAIT_MAX_ITERATIONS);
    expect(frozenViews.stateReads).toBe(D1_WAIT_MAX_ITERATIONS);
    expect(frozenClock.fullScans).toBe(0);

    // A receipt that disappears during the required final recheck spends two
    // probes per iteration. The same global statement budget must still hold.
    const flappingSource = new FakeSource();
    flappingSource.target = { kind: "stored", eventId: "flapping", suid: "suid-flapping" };
    const flappingViews = new FlappingMaterializedView();
    const flapping = await queryD1(flappingSource, flappingViews, `${serviceId}-flapping`, "suid-flapping", {
      now: () => 0,
      sleep: async () => {},
    });
    expect(flapping.status).toBe(504);
    expect(flappingSource.targetReads).toBe(126);
    expect(flappingViews.stateReads).toBe(126);
    expect(flappingSource.targetReads * 2).toBe(D1_WAIT_MAX_POINT_READS);
  });

  it("keeps timeout status/code/keys stable while changing only its read-oriented text", async () => {
    const source = new FakeSource();
    const views = new FakeMaterializedView([state()]);
    let now = 0;
    const response = await queryD1(source, views, `g31-timeout-${crypto.randomUUID()}`, "suid-timeout", {
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });
    expect(response.status).toBe(504);
    const body = await response.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(["code", "error"]);
    expect(body).toMatchObject({ code: "timeout" });
    expect(body.error).toContain("refresh this read");
    expect(body.error).not.toContain("duplicate events");
  });

  it("serves the post-commit list page newest-first through the actual D1-MV query path", async () => {
    const serviceId = `g31-newest-${crypto.randomUUID()}`;
    const views = await activeView(serviceId);
    await views.applyMutationsAndAdvanceCheckpoint({
      serviceId,
      viewId: VIEW_ID,
      generation: 0,
      expectedLastSuid: null,
      lastSuid: "suid-00000000000000000000000000000001",
      definitionVersion: 1,
      updatedAt: 1,
      mutations: mutation("older", "suid-00000000000000000000000000000001"),
    });
    await views.applyMutationsAndAdvanceCheckpoint({
      serviceId,
      viewId: VIEW_ID,
      generation: 0,
      expectedLastSuid: "suid-00000000000000000000000000000001",
      lastSuid: "suid-00000000000000000000000000000002",
      definitionVersion: 1,
      updatedAt: 2,
      mutations: mutation("newer", "suid-00000000000000000000000000000002"),
    });
    const response = await handleSerializedQuery(new Request("https://g31.test/api/sekiban/serialized/list-query", {
      method: "POST",
      headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: serviceId },
      body: JSON.stringify({ queryType: QUERY_TYPE, queryParamsJson: JSON.stringify({ PageNumber: 1, PageSize: 20, NewestFirst: true }) }),
    }), {}, { queryBacking: "d1-mv", materializedViewQueryPort: views, registry: registry() });
    expect(response.status).toBe(200);
    const body = await response.json<{ itemsJson: string }>();
    expect(JSON.parse(body.itemsJson).map((entry: { eventId: string }) => entry.eventId)).toEqual(["newer", "older"]);
  });

  it("keeps the d1-mv wait implementation free of readAllEvents", () => {
    const source = queryWorkerSource as string;
    const d1Wait = source.slice(source.indexOf("async function readD1WaitFacts"), source.indexOf("function endpointFromPath"));
    expect(d1Wait).not.toContain("readAllEvents");
    expect(d1Wait).toContain("readWaitForTarget");
    expect(d1Wait).toContain("readWaitForState");
  });
});
