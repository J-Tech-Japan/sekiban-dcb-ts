import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { MaterializedViewMutationPlan } from "@sekiban/dcb-core";
// @ts-expect-error Vite raw migration fixture.
import g32Migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";
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
// @ts-expect-error Vite raw migration imports.
import orderingQuarantineMigration from "../migrations/mv/0007_g69_ordering_quarantine.sql?raw";
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
import { g32EventId, g32Message, g32Suid } from "./helpers/g32-fixtures";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";

const VIEW_ID = "g31-wait-view";
const QUERY_TYPE = "G31WaitListQuery";

function canonicalSuid(value: string): string {
  return g32Suid(value);
}

function canonicalEventId(value: string): string {
  return g32EventId(value);
}

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
      waitForSortableUniqueId: canonicalSuid(suid),
    }),
  });
}

function message(serviceId: string, eventId: string, suid: string, lineage = "g31-lineage"): DownstreamOutboxMessage {
  return g32Message({
    serviceId,
    allocatorLineageId: lineage,
    tag: `test:${serviceId}`,
    attemptId: `${eventId}-attempt`,
    eventId,
    suid,
    payload: JSON.stringify({ eventId, suid: canonicalSuid(suid) }),
    eventTags: [`test:${serviceId}`],
    eventType: "G31WaitFixtureEvent",
    enqueuedAt: 0,
  });
}

function mutation(eventId: string, suid: string) {
  return {
    rowUpserts: [{ rowKey: eventId, value: { eventId, suid: canonicalSuid(suid) }, rowVersion: 1, sourceSuid: canonicalSuid(suid) }],
    rowPatches: [],
    rowDeletes: [],
    indexEntries: [],
    indexDeletes: [],
  };
}

function noChangeMutation(): MaterializedViewMutationPlan {
  return { rowUpserts: [], rowPatches: [], rowDeletes: [], indexEntries: [], indexDeletes: [] };
}

function patchNotFoundMutation(suid: string): MaterializedViewMutationPlan {
  return {
    rowUpserts: [],
    rowPatches: [{ kind: "json_patch", rowKey: "missing", patch: { value: "x" }, rowVersion: 1, sourceSuid: canonicalSuid(suid), indexEntries: [] }],
    rowDeletes: [],
    indexEntries: [],
    indexDeletes: [],
  };
}

function deleteWithoutRowMutation(): MaterializedViewMutationPlan {
  return {
    rowUpserts: [],
    rowPatches: [],
    rowDeletes: [{ rowKey: "missing" }],
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
  await views.createActive({ serviceId, viewId: VIEW_ID, definitionVersion: 1, updatedAt: 1, lastSuid: lastSuid === "" ? "" : canonicalSuid(lastSuid) });
  return views;
}

async function setLagBound(serviceId: string, estimateMs: number): Promise<void> {
  await d1().prepare(
    `INSERT INTO serialized_dcb_lag_estimates (service_id, estimate_ms, observed_at)
     VALUES (?, ?, 0)
     ON CONFLICT (service_id) DO UPDATE SET estimate_ms = excluded.estimate_ms, observed_at = excluded.observed_at`,
  ).bind(serviceId, estimateMs).run();
}

/**
 * This wraps real Miniflare D1 statements rather than a source/view port. It
 * records the actual indexed source and MV wait SQL executions and rows read.
 */
class D1WaitSqlBudget {
  statements = 0;
  rowsRead = 0;
  waitStatements = 0;
  waitRowsRead = 0;
  readonly database: D1Database;

  constructor(
    database: D1Database,
    private readonly waitSql: (sql: string) => boolean,
  ) {
    this.database = new Proxy(database, {
      get: (target, property) => {
        if (property === "prepare") {
          return (sql: string) => this.wrapStatement(target.prepare(sql), sql);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
  }

  reset(): void {
    this.statements = 0;
    this.rowsRead = 0;
    this.waitStatements = 0;
    this.waitRowsRead = 0;
  }

  private record(sql: string, rowsRead: number): void {
    this.statements += 1;
    this.rowsRead += rowsRead;
    if (this.waitSql(sql)) {
      this.waitStatements += 1;
      this.waitRowsRead += rowsRead;
    }
  }

  private wrapStatement(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    return new Proxy(statement, {
      get: (target, property) => {
        if (property === "bind") {
          return (...values: unknown[]) => this.wrapStatement(target.bind(...values), sql);
        }
        if (property === "first") {
          return async (columnName?: string) => {
            const row = columnName === undefined ? await target.first() : await target.first(columnName);
            this.record(sql, row === null ? 0 : 1);
            return row;
          };
        }
        if (property === "all") {
          return async () => {
            const result = await target.all();
            this.record(sql, result.results.length);
            return result;
          };
        }
        if (property === "run") {
          return async () => {
            const result = await target.run();
            this.record(sql, result.results.length);
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1PreparedStatement;
  }
}

function sourceWaitSql(sql: string): boolean {
  return sql.includes("WITH target AS") && sql.includes("serialized_dcb_wait_target_incidents");
}

function materializedViewWaitSql(sql: string): boolean {
  return sql.includes("WITH active AS") && sql.includes("mv_wait_receipts");
}

async function runActualD1PendingWait(lagBoundMs: number): Promise<{
  readonly response: Response;
  readonly now: () => number;
  readonly sleeps: readonly number[];
  readonly sourceBudget: D1WaitSqlBudget;
  readonly viewBudget: D1WaitSqlBudget;
}> {
  const serviceId = `g31-actual-budget-${crypto.randomUUID()}`;
  const eventId = "g31-actual-budget-event";
  const suid = "suid-00000000000000000000000000000310";
  await sourceWithTarget(serviceId, eventId, suid);
  await activeView(serviceId);
  await setLagBound(serviceId, lagBoundMs);

  const sourceBudget = new D1WaitSqlBudget(d1(), sourceWaitSql);
  const viewBudget = new D1WaitSqlBudget(mvDatabase(), materializedViewWaitSql);
  const source = new D1EventStore(sourceBudget.database);
  const views = new D1MaterializedViewStore(viewBudget.database);
  await source.initialize();
  await views.initialize();
  sourceBudget.reset();
  viewBudget.reset();

  let clock = 0;
  const sleeps: number[] = [];
  const response = await queryD1(source, views, serviceId, suid, {
    now: () => clock,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
  });
  return { response, now: () => clock, sleeps, sourceBudget, viewBudget };
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
  const { safeContiguousHead, ...rest } = overrides;
  return {
    activeGeneration: 0,
    activeDefinitionVersion: 1,
    targetReceipt: false,
    checkpointAhead: false,
    rebuildRequired: false,
    poison: false,
    ...rest,
    safeContiguousHead: safeContiguousHead === undefined || safeContiguousHead === ""
      ? ""
      : canonicalSuid(safeContiguousHead),
  };
}

class FakeSource implements QueryProjectionStore, WaitForTargetSourcePort {
  target: WaitForTargetLookup = { kind: "pending" };
  targetReads = 0;
  lagReads = 0;
  fullScans = 0;
  lagBoundMs = 0;
  lagSamples: readonly number[] | undefined;

  async readWaitForTarget(): Promise<WaitForTargetLookup> {
    this.targetReads += 1;
    return this.target.kind === "stored"
      ? { ...this.target, suid: canonicalSuid(this.target.suid) }
      : this.target;
  }

  async readAllEvents(): Promise<never[]> {
    this.fullScans += 1;
    throw new Error("G31 d1-mv waitFor must not scan readAllEvents");
  }

  async currentLagBound(): Promise<number> {
    this.lagReads += 1;
    return this.lagSamples?.[Math.min(this.lagReads - 1, this.lagSamples.length - 1)] ?? this.lagBoundMs;
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

function flipRealD1WaitState(
  views: D1MaterializedViewStore,
  afterFirstRead: () => Promise<void>,
): { readonly port: MaterializedViewQueryPort; readonly reads: () => number; readonly postWaitQueryRows: () => number } {
  let reads = 0;
  let postWaitQueryRows = 0;
  return {
    reads: () => reads,
    postWaitQueryRows: () => postWaitQueryRows,
    port: {
      initialize: () => views.initialize(),
      queryRows: (...args) => {
        postWaitQueryRows += 1;
        return views.queryRows(...args);
      },
      queryRowsWithTotal: (...args) => {
        postWaitQueryRows += 1;
        return views.queryRowsWithTotal(...args);
      },
      hasTargetReceipt: (...args) => views.hasTargetReceipt(...args),
      hasCheckpointAheadFinding: (...args) => views.hasCheckpointAheadFinding(...args),
      readWaitForState: async (...args) => {
        const result = await views.readWaitForState(...args);
        reads += 1;
        if (reads === 1) await afterFirstRead();
        return result;
      },
    },
  };
}

async function expectProjectionUnavailable(response: Response): Promise<void> {
  expect(response.status).toBe(503);
  const body = await response.json<Record<string, unknown>>();
  expect(Object.keys(body).sort()).toEqual(["code", "error"]);
  expect(body).toMatchObject({ code: "projection_unavailable" });
  expect(typeof body.error).toBe("string");
}

async function assertStoredOutcomeReceipt(
  outcome: "no-change" | "patch-not-found" | "delete-without-row",
  mutations: MaterializedViewMutationPlan,
): Promise<void> {
  const serviceId = `g31-${outcome}-${crypto.randomUUID()}`;
  const eventId = canonicalEventId(`${outcome}-event`);
  const suid = canonicalSuid(`g31-${outcome}-${outcome.length}`);
  const source = await sourceWithTarget(serviceId, eventId, suid);
  const views = await activeView(serviceId);
  await expect(views.unsafeWindow().apply({
    serviceId,
    viewId: VIEW_ID,
    generation: 0,
    eventId,
    suid,
    safeHead: "",
    updatedAt: 2,
    mutations,
  })).resolves.toMatchObject({ outcome, duplicate: false });
  expect(await views.readWaitForState(serviceId, VIEW_ID, { eventId, suid })).toMatchObject({
    activeGeneration: 0,
    activeDefinitionVersion: 1,
    targetReceipt: true,
  });
  expect((await queryD1(source, views, serviceId, suid)).status).toBe(200);
}

describe("SDT-G31 d1-mv waitFor", () => {
  beforeAll(async () => {
    await d1().batch(statements(d1(), g32Migration as string));
    await applyG44D1Migration(d1());
    for (const migration of [mvMigration, unsafeMigration, hardeningMigration, failureMigration, waitReceiptMigration, waitPoisonMigration, orderingQuarantineMigration]) {
      await mvDatabase().batch(statements(mvDatabase(), migration as string));
    }
  });

  it("fast-path-satisfied: succeeds through the active-generation target receipt", async () => {
    const serviceId = `g31-receipt-${crypto.randomUUID()}`;
    const eventId = canonicalEventId("g31-receipt-event");
    const suid = canonicalSuid("suid-00000000000000000000000000000031");
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
    expect((await views.readWaitForState(serviceId, VIEW_ID, { eventId, suid })).targetReceipt).toBe(true);
    expect((await queryD1(source, views, serviceId, suid)).status).toBe(200);
  });

  it("queue-fallback-satisfied: succeeds through unique source plus active safe head after receipt GC", async () => {
    const serviceId = `g31-receipt-gc-${crypto.randomUUID()}`;
    const eventId = canonicalEventId("g31-receipt-gc-event");
    const suid = canonicalSuid("suid-00000000000000000000000000000032");
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
    expect(await views.readWaitForState(serviceId, VIEW_ID, { eventId, suid })).toMatchObject({
      targetReceipt: false,
      safeContiguousHead: suid,
    });
    expect((await queryD1(source, views, serviceId, suid)).status).toBe(200);
  });

  it("records an active-generation wait receipt for stored no-change", async () => {
    await assertStoredOutcomeReceipt("no-change", noChangeMutation());
  });

  it("records an active-generation wait receipt for stored patch-not-found", async () => {
    const suid = canonicalSuid("suid-00000000000000000000000000000015");
    await assertStoredOutcomeReceipt("patch-not-found", patchNotFoundMutation(suid));
  });

  it("records an active-generation wait receipt for stored delete-without-row", async () => {
    await assertStoredOutcomeReceipt("delete-without-row", deleteWithoutRowMutation());
  });

  it("binds a receipt to the active generation and definition rather than an old view instance", async () => {
    const serviceId = `g31-generation-${crypto.randomUUID()}`;
    const eventId = canonicalEventId("g31-generation-event");
    const suid = canonicalSuid("suid-00000000000000000000000000000041");
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

  it("fails a non-stored SUID collision before its aliased receipt can satisfy waitFor", async () => {
    const collisionService = `g31-collision-${crypto.randomUUID()}`;
    const collisionSuid = canonicalSuid("suid-00000000000000000000000000000061");
    const firstEventId = canonicalEventId("first");
    const collisionSource = await sourceWithTarget(collisionService, firstEventId, collisionSuid);
    const collisionViews = await activeView(collisionService);
    await collisionViews.unsafeWindow().apply({
      serviceId: collisionService,
      viewId: VIEW_ID,
      generation: 0,
      eventId: firstEventId,
      suid: collisionSuid,
      safeHead: "",
      updatedAt: 2,
      mutations: mutation(firstEventId, collisionSuid),
    });
    expect((await collisionSource.recordDelivery(message(collisionService, canonicalEventId("aliased"), collisionSuid), 1)).outcome).toBe("suid-collision");
    await expectProjectionUnavailable(await queryD1(collisionSource, collisionViews, collisionService, collisionSuid));
  });

  it("fails a non-stored lineage mismatch instead of degrading it to a timeout", async () => {
    const lineageService = `g31-lineage-${crypto.randomUUID()}`;
    const lineageSource = await sourceWithTarget(lineageService, canonicalEventId("first"), canonicalSuid("suid-00000000000000000000000000000062"));
    const lineageSuid = canonicalSuid("suid-00000000000000000000000000000063");
    expect((await lineageSource.recordDelivery(message(lineageService, canonicalEventId("wrong-lineage"), lineageSuid, "wrong-lineage"), 1)).outcome).toBe("lineage-mismatch");
    const lineageViews = await activeView(lineageService, lineageSuid);
    await expectProjectionUnavailable(await queryD1(lineageSource, lineageViews, lineageService, lineageSuid));
  });

  it("fails closed on an already-open CHECKPOINT_AHEAD finding", async () => {
    const serviceId = `g31-checkpoint-${crypto.randomUUID()}`;
    const eventId = canonicalEventId("checkpoint-event");
    const suid = canonicalSuid("suid-00000000000000000000000000000070");
    const source = await sourceWithTarget(serviceId, eventId, suid);
    const views = await activeView(serviceId, suid);
    await views.recordCheckpointAhead({ serviceId, viewId: VIEW_ID, generation: 0, checkpointSuid: suid, storeMaxSuid: "", observedAt: 2 });
    await expectProjectionUnavailable(await queryD1(source, views, serviceId, suid));
  });

  it("rechecks a real D1 CHECKPOINT_AHEAD finding immediately before success", async () => {
    const serviceId = `g31-checkpoint-flip-${crypto.randomUUID()}`;
    const eventId = canonicalEventId("checkpoint-flip-event");
    const suid = canonicalSuid("suid-00000000000000000000000000000080");
    const source = await sourceWithTarget(serviceId, eventId, suid);
    const views = await activeView(serviceId);
    await views.unsafeWindow().apply({ serviceId, viewId: VIEW_ID, generation: 0, eventId, suid, safeHead: "", updatedAt: 2, mutations: mutation(eventId, suid) });
    const flipped = flipRealD1WaitState(views, () => views.recordCheckpointAhead({
      serviceId,
      viewId: VIEW_ID,
      generation: 0,
      checkpointSuid: suid,
      storeMaxSuid: "",
      observedAt: 3,
    }));
    await expectProjectionUnavailable(await queryD1(source, flipped.port, serviceId, suid));
    expect(flipped.reads()).toBe(2);
    expect(flipped.postWaitQueryRows()).toBe(0);
  });

  it("rechecks a real D1 rebuild-required finding immediately before success", async () => {
    const serviceId = `g31-rebuild-flip-${crypto.randomUUID()}`;
    const eventId = canonicalEventId("rebuild-flip-event");
    const suid = canonicalSuid("suid-00000000000000000000000000000081");
    const source = await sourceWithTarget(serviceId, eventId, suid);
    const views = await activeView(serviceId);
    await views.unsafeWindow().apply({ serviceId, viewId: VIEW_ID, generation: 0, eventId, suid, safeHead: "", updatedAt: 2, mutations: mutation(eventId, suid) });
    const flipped = flipRealD1WaitState(views, async () => {
      await mvDatabase().prepare(
        `INSERT INTO mv_unsafe_arrivals (service_id, view_id, generation, safe_head, arrival_watermark, rebuild_required)
         VALUES (?, ?, 0, ?, ?, 1)`,
      ).bind(serviceId, VIEW_ID, suid, suid).run();
    });
    await expectProjectionUnavailable(await queryD1(source, flipped.port, serviceId, suid));
    expect(flipped.reads()).toBe(2);
    expect(flipped.postWaitQueryRows()).toBe(0);
  });

  it("rechecks a real D1 target poison finding immediately before success", async () => {
    const serviceId = `g31-poison-flip-${crypto.randomUUID()}`;
    const eventId = canonicalEventId("poison-flip-event");
    const suid = canonicalSuid("suid-00000000000000000000000000000082");
    const source = await sourceWithTarget(serviceId, eventId, suid);
    const views = await activeView(serviceId);
    await views.unsafeWindow().apply({ serviceId, viewId: VIEW_ID, generation: 0, eventId, suid, safeHead: "", updatedAt: 2, mutations: mutation(eventId, suid) });
    const flipped = flipRealD1WaitState(views, () => views.recordUnsafeFailureFinding({
      serviceId,
      viewId: VIEW_ID,
      generation: 0,
      eventId,
      suid,
      observedAt: 3,
    }));
    await expectProjectionUnavailable(await queryD1(source, flipped.port, serviceId, suid));
    expect(flipped.reads()).toBe(2);
    expect(flipped.postWaitQueryRows()).toBe(0);
  });

  it("keeps a contradictory source target unavailable before any MV read", async () => {
    const source = new FakeSource();
    source.target = { kind: "unavailable", reason: "suid-contradiction" };
    const views = new FakeMaterializedView([state({ targetReceipt: true })]);
    await expectProjectionUnavailable(await queryD1(source, views, `g31-contradictory-${crypto.randomUUID()}`, "suid-contradictory"));
    expect(views.stateReads).toBe(0);
  });

  it("honors the 20s floor exactly with actual D1 statement and rows-read budgets", async () => {
    const result = await runActualD1PendingWait(0);
    expect(result.response.status).toBe(504);
    expect(result.now()).toBe(20_000);
    expect(result.sleeps).toHaveLength(25);
    expect(result.sleeps.slice(0, 7)).toEqual([25, 50, 100, 200, 400, 800, 1_000]);
    expect(result.sleeps.at(-1)).toBe(425);
    expect(Math.max(...result.sleeps)).toBe(1_000);
    expect(result.sleeps.reduce((total, milliseconds) => total + milliseconds, 0)).toBe(20_000);
    expect(result.sourceBudget.waitStatements).toBe(26);
    expect(result.viewBudget.waitStatements).toBe(26);
    expect(result.sourceBudget.waitRowsRead).toBe(26);
    expect(result.viewBudget.waitRowsRead).toBe(26);
    expect(result.sourceBudget.statements).toBe(27); // one lag snapshot plus 26 source target probes
    expect(result.viewBudget.statements).toBe(28); // one ordering-quarantine read, one initial CHECKPOINT_AHEAD gate, plus 26 MV wait probes
    expect(result.sourceBudget.rowsRead + result.viewBudget.rowsRead).toBe(53); // the empty initial checkpoint gate reads zero rows
  });

  it("clock-advance honors the 120s ceiling exactly with actual D1 statement and rows-read budgets", async () => {
    const result = await runActualD1PendingWait(120_000);
    expect(result.response.status).toBe(504);
    expect(result.now()).toBe(120_000);
    expect(result.sleeps).toHaveLength(125);
    expect(result.sleeps.slice(0, 7)).toEqual([25, 50, 100, 200, 400, 800, 1_000]);
    expect(result.sleeps.at(-1)).toBe(425);
    expect(Math.max(...result.sleeps)).toBe(1_000);
    expect(result.sleeps.reduce((total, milliseconds) => total + milliseconds, 0)).toBe(120_000);
    expect(result.sourceBudget.waitStatements).toBe(126);
    expect(result.viewBudget.waitStatements).toBe(126);
    expect(result.sourceBudget.waitRowsRead).toBe(126);
    expect(result.viewBudget.waitRowsRead).toBe(126);
    expect(result.sourceBudget.statements).toBe(127); // one lag snapshot plus 126 source target probes
    expect(result.viewBudget.statements).toBe(128); // one ordering-quarantine read, one initial CHECKPOINT_AHEAD gate, plus 126 MV wait probes
    expect(result.sourceBudget.rowsRead + result.viewBudget.rowsRead).toBe(253); // the empty initial checkpoint gate reads zero rows
  });

  it("does not spend its final 120s poll slot before a healthy late receipt becomes visible", async () => {
    const serviceId = `g31-late-success-${crypto.randomUUID()}`;
    const suid = "suid-00000000000000000000000000000090";
    const source = new FakeSource();
    source.target = { kind: "stored", eventId: "late-success", suid };
    source.lagBoundMs = 120_000;
    let now = 0;
    let stateReads = 0;
    const views: MaterializedViewQueryPort = {
      queryRows: async () => [],
      readWaitForState: async () => {
        stateReads += 1;
        return state({ targetReceipt: now >= 119_900 });
      },
    };
    const response = await queryD1(source, views, serviceId, suid, {
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });
    expect(response.status).toBe(200);
    expect(now).toBe(120_000);
    expect(source.targetReads).toBe(127);
    expect(stateReads).toBe(127);
    expect(source.targetReads * 2).toBe(D1_WAIT_MAX_POINT_READS);
  });

  it("snapshots one absolute request-start deadline and caps reads without a full scan or N+1 growth", async () => {
    const serviceId = `g31-budget-${crypto.randomUUID()}`;
    const source = new FakeSource();
    source.lagSamples = [0, 120_000];
    const views = new FakeMaterializedView([state({ safeContiguousHead: "suid-z" })]);
    let now = 0;
    const response = await queryD1(source, views, serviceId, "suid-not-stored", {
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });
    expect(response.status).toBe(504);
    expect(now).toBe(20_000);
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
    expect(flappingSource.targetReads).toBe(127);
    expect(flappingViews.stateReads).toBe(127);
    expect(flappingSource.targetReads * 2).toBe(D1_WAIT_MAX_POINT_READS);
  });

  it("ceiling: returns an immediate indeterminate timeout even when a receipt is ready", async () => {
    const source = new FakeSource();
    source.target = { kind: "stored", eventId: "ceiling-event", suid: "suid-ceiling" };
    source.lagBoundMs = 120_001;
    const views = new FakeMaterializedView([state({ targetReceipt: true })]);
    let sleeps = 0;
    const response = await queryD1(source, views, `g31-ceiling-${crypto.randomUUID()}`, "suid-ceiling", {
      now: () => 0,
      sleep: async () => { sleeps += 1; },
    });
    expect(response.status).toBe(504);
    expect(source.targetReads).toBe(1);
    expect(views.stateReads).toBe(1);
    expect(sleeps).toBe(0);
  });

  it("keeps 503 projection_unavailable status, code, and exact keys independent of the timeout wire oracle", async () => {
    const source = new FakeSource();
    source.target = { kind: "unavailable", reason: "incident" };
    const views = new FakeMaterializedView([state({ targetReceipt: true })]);
    await expectProjectionUnavailable(await queryD1(source, views, `g31-unavailable-${crypto.randomUUID()}`, "suid-unavailable"));
    expect(views.stateReads).toBe(0);
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
    const olderSuid = canonicalSuid("suid-00000000000000000000000000000001");
    const newerSuid = canonicalSuid("suid-00000000000000000000000000000002");
    await views.applyMutationsAndAdvanceCheckpoint({
      serviceId,
      viewId: VIEW_ID,
      generation: 0,
      expectedLastSuid: null,
      lastSuid: olderSuid,
      definitionVersion: 1,
      updatedAt: 1,
      mutations: mutation("older", olderSuid),
    });
    await views.applyMutationsAndAdvanceCheckpoint({
      serviceId,
      viewId: VIEW_ID,
      generation: 0,
      expectedLastSuid: olderSuid,
      lastSuid: newerSuid,
      definitionVersion: 1,
      updatedAt: 2,
      mutations: mutation("newer", newerSuid),
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
