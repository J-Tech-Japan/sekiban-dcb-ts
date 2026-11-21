import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// @ts-expect-error Vite raw migration imports.
import g32Migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";
// @ts-expect-error Vite raw migration imports.
import d1StatusMigration from "../migrations/d1/g32/0022_g150_projection_statuses.sql?raw";
// @ts-expect-error Vite raw migration imports.
import mv0001 from "../migrations/mv/0001_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration imports.
import mv0002 from "../migrations/mv/0002_unsafe_window_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration imports.
import mv0003 from "../migrations/mv/0003_checkpoint_ahead_hardening.sql?raw";
// @ts-expect-error Vite raw migration imports.
import mv0004 from "../migrations/mv/0004_unsafe_window_failure_findings.sql?raw";
// @ts-expect-error Vite raw migration imports.
import mv0005 from "../migrations/mv/0005_g31_wait_receipts.sql?raw";
// @ts-expect-error Vite raw migration imports.
import mv0006 from "../migrations/mv/0006_g31_wait_target_poison.sql?raw";
// @ts-expect-error Vite raw migration imports.
import mv0007 from "../migrations/mv/0007_g69_ordering_quarantine.sql?raw";
// @ts-expect-error Vite raw migration imports.
import mv0008 from "../migrations/mv/0008_g69_rebuild_verification.sql?raw";
// @ts-expect-error Vite raw migration imports.
import mv0009 from "../migrations/mv/0009_g69_rebuild_proof.sql?raw";
// @ts-expect-error Vite raw migration imports.
import mv0010 from "../migrations/mv/0010_g152_force_reverse_audit.sql?raw";
// @ts-expect-error Vite raw migration imports.
import templateMv0010 from "../packages/create-dcb/template/migrations/mv/0010_g152_force_reverse_audit.sql?raw";

import { defineRowMaterializer, type MaterializedViewRowMaterializer } from "@sekiban/dcb-core";
import { SERIALIZED_PATHS } from "../packages/dcb-cloudflare/src/compose";
import { createCloudflareOnlyRuntimeWorker } from "../packages/dcb-runtime/src/cloudflare";
import { createD1StoreProvider } from "../packages/dcb-runtime/src/d1";
import { createRuntimeWorker } from "../packages/dcb-runtime/src/index";
import {
  MATERIALIZED_VIEW_ACTIONS_PREFIX,
  type MaterializedViewRuntimeStatus,
} from "../packages/dcb-runtime/src/mv/MaterializedViewActions";
import {
  MaterializedViewCatchUpRuntime,
  MaterializedViewDefinitionVersionMismatchError,
} from "../packages/dcb-runtime/src/mv/MaterializedViewCatchUp";
import {
  D1MaterializedViewStore,
  MaterializedViewStoreError,
} from "../packages/dcb-runtime/src/mv/MaterializedViewStore";
import { formatProjectionStatusUtc, mvProjectionStatusIdentity } from "../packages/dcb-runtime/src/mv/ProjectionStatus";
import type { ServiceIdentityProvider } from "../packages/dcb-runtime/src/service/ServiceIdentityProvider";
import { D1EventStore } from "../packages/dcb-runtime/src/store/D1EventStore";
import type { ProjectionStatusHeartbeat, StoredEvent } from "../packages/dcb-runtime/src/store/types";
import { g32Message, g32Suid } from "./helpers/g32-fixtures";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";

const TOKEN = "g152-operator-token";
const CONFLICT = "materialized_view_force_reverse_conflict";
const REJECTED = "materialized_view_force_reverse_rejected";
const INVALID = { error: "Materialized-view action request is invalid.", code: "materialized_view_action_invalid_request" };

type Worker = ExportedHandler<never>;
type Composition = "ordinary" | "cloudflare";
type PointerRow = { generation: number; updated_at: number; switch_kind: string; switch_reason: string | null; switched_at: number | null };
type QuarantineRow = Record<string, unknown>;

/** Evidence captured while the database had migrations 0001..0009 only. */
const upgrade = {
  initializeFailedBefore0010: false,
  legacyService: "",
  legacyView: "",
};

function d1(): D1Database {
  const binding = (env as unknown as { D1?: D1Database }).D1;
  if (binding === undefined) throw new Error("D1 binding is required");
  return binding;
}

function mvDatabase(): D1Database {
  const binding = (env as unknown as { D1_MV?: D1Database }).D1_MV;
  if (binding === undefined) throw new Error("D1_MV binding is required");
  return binding;
}

function statements(database: D1Database, source: string): D1PreparedStatement[] {
  return source.replace(/^\s*--.*$/gm, "").split(";").map((value) => value.trim()).filter(Boolean).map((value) => database.prepare(value));
}

async function tableExists(database: D1Database, name: string): Promise<boolean> {
  const row = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").bind(name).first<{ name: string }>();
  return row !== null && row !== undefined;
}

function newService(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function viewFor(service: string): string {
  return `g152-view-${service}`;
}

function materializer(id: string, version: number): MaterializedViewRowMaterializer<StoredEvent> {
  return defineRowMaterializer<StoredEvent>({
    id,
    version,
    indexDescriptors: [{ id: "event-id", valueType: "text", value: (_row, event) => event.eventId }],
    materialize: (event) => ({ rowUpserts: [{ rowKey: event.eventId, value: { eventId: event.eventId }, sourceSuid: event.suid }] }),
  });
}

function identity(service: string, calls?: { count: number }): ServiceIdentityProvider {
  const resolve = () => {
    if (calls !== undefined) calls.count += 1;
    return { serviceId: service, behavior: "deployment" as const };
  };
  return { deployment: resolve, forRequest: resolve };
}

function worker(
  composition: Composition,
  service: string,
  materializers: readonly MaterializedViewRowMaterializer<StoredEvent>[],
  identityProvider: ServiceIdentityProvider = identity(service),
): Worker {
  const actions = materializers as unknown as readonly MaterializedViewRowMaterializer[];
  return (composition === "ordinary"
    ? createRuntimeWorker({ storeProvider: createD1StoreProvider(), serviceIdentityProvider: identityProvider, materializedViewActions: actions })
    : createCloudflareOnlyRuntimeWorker({ serviceIdentityProvider: identityProvider, materializedViewActions: actions })) as unknown as Worker;
}

function trap(touches: { count: number }): never {
  return new Proxy({}, {
    get(): never {
      touches.count += 1;
      throw new Error("binding sentinel");
    },
  }) as never;
}

function liveEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const touches = { count: 0 };
  return {
    REPAIR_OPERATOR_TOKEN: TOKEN,
    D1: d1(),
    D1_MV: mvDatabase(),
    ALLOCATOR: trap(touches),
    BOOTSTRAP: trap(touches),
    JOURNAL: trap(touches),
    TAG: trap(touches),
    TAG_STATE: trap(touches),
    ...overrides,
  };
}

function path(viewId: string, action: string): string {
  return `${MATERIALIZED_VIEW_ACTIONS_PREFIX}/${encodeURIComponent(viewId)}/${action}`;
}

async function call(
  target: Worker,
  bindings: Record<string, unknown>,
  method: string,
  route: string,
  options: { readonly body?: string; readonly authorization?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const authorization = options.authorization === undefined ? `Bearer ${TOKEN}` : options.authorization;
  if (authorization !== null) headers.authorization = authorization;
  return target.fetch!(new Request(`https://g152.test${route}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  }) as never, bindings as never, createExecutionContext());
}

function reverseBody(retainedGeneration: unknown, expectedActiveGeneration: unknown, reason: unknown): string {
  return JSON.stringify({ retainedGeneration, expectedActiveGeneration, reason });
}

async function record(service: string, seed: number): Promise<{ eventId: string; suid: string }> {
  const source = new D1EventStore(d1());
  await source.initialize();
  const message = g32Message({
    serviceId: service,
    tag: `g152:${service}`,
    eventId: `${service}-event-${seed}`,
    suid: g32Suid(seed),
    eventType: "G152FixtureEvent",
    enqueuedAt: 0,
  });
  expect((await source.recordDelivery(message, 0)).outcome).toBe("stored");
  return { eventId: message.eventId, suid: message.suid };
}

async function views(database: D1Database = mvDatabase()): Promise<D1MaterializedViewStore> {
  const store = new D1MaterializedViewStore(database);
  await store.initialize();
  return store;
}

async function source(): Promise<D1EventStore> {
  const store = new D1EventStore(d1());
  await store.initialize();
  return store;
}

async function heartbeatFor(service: string, viewId: string, version: number): Promise<ProjectionStatusHeartbeat | undefined> {
  const id = mvProjectionStatusIdentity(viewId, version);
  return (await source()).readProjectionStatusHeartbeat(service, id.projectorName, id.projectorVersion, "cloudflare");
}

async function instances(service: string, viewId: string): Promise<Array<{ generation: number; status: string; definition_version: number }>> {
  const result = await mvDatabase().prepare(
    "SELECT generation, status, definition_version FROM mv_instances WHERE service_id = ? AND view_id = ? ORDER BY generation",
  ).bind(service, viewId).all<{ generation: number; status: string; definition_version: number }>();
  return result.results;
}

async function pointer(service: string, viewId: string): Promise<PointerRow | undefined> {
  const row = await mvDatabase().prepare(
    "SELECT generation, updated_at, switch_kind, switch_reason, switched_at FROM mv_active_generations WHERE service_id = ? AND view_id = ?",
  ).bind(service, viewId).first<PointerRow>();
  return row ?? undefined;
}

async function quarantines(service: string, viewId: string): Promise<QuarantineRow[]> {
  const result = await mvDatabase().prepare(
    "SELECT * FROM mv_ordering_quarantines WHERE service_id = ? AND view_id = ? ORDER BY generation",
  ).bind(service, viewId).all<QuarantineRow>();
  return result.results;
}

async function body<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

/** Records real D1 statement text without replacing the provider. */
function countingDatabase(database: D1Database, log: string[], failWhen?: (sql: string) => boolean): D1Database {
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          log.push(sql);
          if (failWhen?.(sql) === true) throw new Error("secret-statement-failure");
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

/** Ensure-started N=0, prepare N+1=1, switch 0 -> 1 through the real routes. */
async function servingOne(target: Worker, viewId: string): Promise<void> {
  expect((await call(target, liveEnv(), "POST", path(viewId, "ensure-started"))).status).toBe(200);
  const prepared = await call(target, liveEnv(), "POST", path(viewId, "prepare"));
  expect(prepared.status).toBe(200);
  expect((await body<{ result: { candidateGeneration: number } }>(prepared)).result.candidateGeneration).toBe(1);
  const switched = await call(target, liveEnv(), "POST", path(viewId, "switch"), {
    body: JSON.stringify({ candidateGeneration: 1, expectedActiveGeneration: 0 }),
  });
  expect(switched.status).toBe(200);
}

async function openQuarantine(service: string, viewId: string, generation: number, event: { eventId: string; suid: string }): Promise<void> {
  await (await views()).recordOrderingQuarantine({
    serviceId: service,
    viewId,
    generation,
    checkpointSuid: g32Suid(90),
    lateSuid: event.suid,
    eventId: event.eventId,
    classification: "LATE_LOWER_SUID",
    observedAt: 1,
  });
}

describe("SDT-G152 break-glass materialized-view force reverse", () => {
  beforeAll(async () => {
    if (!(await tableExists(d1(), "dcb_events"))) await d1().batch(statements(d1(), g32Migration as string));
    await applyG44D1Migration(d1());
    if (!(await tableExists(d1(), "dcb_projection_statuses"))) await d1().batch(statements(d1(), d1StatusMigration as string));
    if (!(await tableExists(mvDatabase(), "mv_instances"))) {
      for (const migration of [mv0001, mv0002, mv0003, mv0004, mv0005, mv0006, mv0007, mv0008, mv0009]) {
        await mvDatabase().batch(statements(mvDatabase(), migration as string));
      }
      // A 0001..0009 database must fail initialize() before any switch path.
      try {
        await new D1MaterializedViewStore(mvDatabase()).initialize();
      } catch {
        upgrade.initializeFailedBefore0010 = true;
      }
      // A pointer written by pre-0010 code (four columns only).
      upgrade.legacyService = newService("g152legacy");
      upgrade.legacyView = viewFor(upgrade.legacyService);
      await mvDatabase().batch([
        mvDatabase().prepare(
          `INSERT INTO mv_instances (service_id, view_id, generation, status, last_suid, definition_version, updated_at)
           VALUES (?, ?, 0, 'active', '', 1, 7)`,
        ).bind(upgrade.legacyService, upgrade.legacyView),
        mvDatabase().prepare(
          "INSERT INTO mv_active_generations (service_id, view_id, generation, updated_at) VALUES (?, ?, 0, 7)",
        ).bind(upgrade.legacyService, upgrade.legacyView),
      ]);
      await mvDatabase().batch(statements(mvDatabase(), mv0010 as string));
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ships 0010 byte-identically, fails initialize without it, and reads pre-0010 pointers as legacy", async () => {
    expect(templateMv0010).toBe(mv0010);
    expect(upgrade.initializeFailedBefore0010).toBe(true);
    expect(await pointer(upgrade.legacyService, upgrade.legacyView)).toEqual({
      generation: 0,
      updated_at: 7,
      switch_kind: "legacy",
      switch_reason: null,
      switched_at: null,
    });
    const facts = await (await views()).readStatusFacts(upgrade.legacyService, upgrade.legacyView, 0);
    expect(facts).toMatchObject({ switchKind: "legacy", switchReason: null, switchedAt: null, nonActiveOpenOrderingQuarantine: false });
    const status = await call(worker("ordinary", upgrade.legacyService, [materializer(upgrade.legacyView, 1)]), liveEnv(), "GET", path(upgrade.legacyView, "status"));
    expect(status.status).toBe(200);
    expect(await body<MaterializedViewRuntimeStatus>(status)).toMatchObject({
      started: true,
      switchKind: "legacy",
      switchReason: null,
      switchedAt: null,
      leavingGenerationQuarantineOpen: false,
    });
    // The CHECK constraint refuses an unknown kind; no reader invents one.
    await expect(mvDatabase().prepare(
      "UPDATE mv_active_generations SET switch_kind = 'unknown' WHERE service_id = ? AND view_id = ?",
    ).bind(upgrade.legacyService, upgrade.legacyView).run()).rejects.toThrow();
  });

  it("createActive and ordinary promote write honest ordinary audit; promote still refuses retired rows", async () => {
    const service = newService("g152w");
    const viewId = viewFor(service);
    const store = await views();
    await store.createActive({ serviceId: service, viewId, definitionVersion: 1, updatedAt: 11 });
    expect(await pointer(service, viewId)).toEqual({ generation: 0, updated_at: 11, switch_kind: "ordinary", switch_reason: null, switched_at: 11 });
    await store.createCandidate({ serviceId: service, viewId, generation: 1, definitionVersion: 1, updatedAt: 12 });
    await store.promoteGeneration({ serviceId: service, viewId, candidateGeneration: 1, expectedActiveGeneration: 0, updatedAt: 13 });
    expect(await pointer(service, viewId)).toEqual({ generation: 1, updated_at: 13, switch_kind: "ordinary", switch_reason: null, switched_at: 13 });
    await store.forceReverseGeneration({ serviceId: service, viewId, retainedGeneration: 0, expectedActiveGeneration: 1, reason: "roll back", updatedAt: 14 });
    expect(await pointer(service, viewId)).toEqual({ generation: 0, updated_at: 14, switch_kind: "forced", switch_reason: "roll back", switched_at: 14 });
    // promote cannot reverse: the retired generation is not a candidate.
    await expect(store.promoteGeneration({ serviceId: service, viewId, candidateGeneration: 1, expectedActiveGeneration: 0, updatedAt: 15 }))
      .rejects.toMatchObject({ code: "MV_PROMOTION_CAS_MISMATCH" });
    await store.createCandidate({ serviceId: service, viewId, generation: 2, definitionVersion: 1, updatedAt: 16 });
    await store.promoteGeneration({ serviceId: service, viewId, candidateGeneration: 2, expectedActiveGeneration: 0, updatedAt: 17 });
    // Ordinary promote clears the forced reason.
    expect(await pointer(service, viewId)).toEqual({ generation: 2, updated_at: 17, switch_kind: "ordinary", switch_reason: null, switched_at: 17 });
    expect(await instances(service, viewId)).toEqual([
      { generation: 0, status: "retired", definition_version: 1 },
      { generation: 1, status: "retired", definition_version: 1 },
      { generation: 2, status: "active", definition_version: 1 },
    ]);
  });

  for (const composition of ["ordinary", "cloudflare"] as const) {
    it(`${composition}: reverses N+1 to N with a forced audit, switch-shaped result, status, and heartbeat`, async () => {
      const service = newService(composition === "ordinary" ? "g152o" : "g152c");
      const viewId = `${viewFor(service)} ä`;
      await record(service, 1);
      const target = worker(composition, service, [materializer(viewId, 1)]);
      await servingOne(target, viewId);
      const switchedShape = await (await views()).readActive(service, viewId);
      const before = Date.now();
      const reason = "  roll back bad switch　 ";
      const reversed = await call(target, liveEnv(), "POST", path(viewId, "force-reverse"), { body: reverseBody(0, 1, reason) });
      expect(reversed.status).toBe(200);
      const reversedBody = await body<{ result: Record<string, unknown>; status: MaterializedViewRuntimeStatus }>(reversed);
      expect(Object.keys(reversedBody)).toEqual(["result", "status"]);
      expect(Object.keys(reversedBody.result).sort()).toEqual(Object.keys(switchedShape!).sort());
      expect(reversedBody.result).toMatchObject({ generation: 0, status: "active", definitionVersion: 1 });
      expect(await instances(service, viewId)).toEqual([
        { generation: 0, status: "active", definition_version: 1 },
        { generation: 1, status: "retired", definition_version: 1 },
      ]);
      const audit = await pointer(service, viewId);
      expect(audit).toMatchObject({ generation: 0, switch_kind: "forced", switch_reason: "roll back bad switch" });
      expect(audit!.switched_at).toBeGreaterThanOrEqual(before);
      expect(reversedBody.status).toMatchObject({
        generation: 0,
        generationStatus: "active",
        switchKind: "forced",
        switchReason: "roll back bad switch",
        switchedAt: formatProjectionStatusUtc(audit!.switched_at!),
        leavingGenerationQuarantineOpen: false,
      });
      expect(await heartbeatFor(service, viewId, 1)).toMatchObject({
        activationId: "operator",
        switchKind: "forced",
        switchReason: "roll back bad switch",
        switchedAt: audit!.switched_at,
      });

      // Replaying the winner is refused: the retained generation is now active.
      const replay = await call(target, liveEnv(), "POST", path(viewId, "force-reverse"), { body: reverseBody(0, 1, "again") });
      expect(replay.status).toBe(409);
      expect(await body(replay)).toEqual({ error: "The retained materialized-view generation cannot be re-served.", code: REJECTED });
      // Ordinary switch still cannot move to the retired generation.
      const forward = await call(target, liveEnv(), "POST", path(viewId, "switch"), {
        body: JSON.stringify({ candidateGeneration: 1, expectedActiveGeneration: 0 }),
      });
      expect(forward.status).toBe(409);
      expect((await body<{ code: string }>(forward)).code).toBe("materialized_view_switch_conflict");
      expect((await pointer(service, viewId))?.generation).toBe(0);
    });
  }

  it("settles a real concurrent pair with exactly one success and no partial state", async () => {
    const service = newService("g152r");
    const viewId = viewFor(service);
    await record(service, 1);
    const target = worker("ordinary", service, [materializer(viewId, 1)]);
    await servingOne(target, viewId);
    const responses = await Promise.all([
      call(target, liveEnv(), "POST", path(viewId, "force-reverse"), { body: reverseBody(0, 1, "first") }),
      call(target, liveEnv(), "POST", path(viewId, "force-reverse"), { body: reverseBody(0, 1, "second") }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const loser = responses.find((response) => response.status === 409)!;
    expect([CONFLICT, REJECTED]).toContain((await body<{ code: string }>(loser)).code);
    const winnerReason = responses[0]!.status === 200 ? "first" : "second";
    expect(await instances(service, viewId)).toEqual([
      { generation: 0, status: "active", definition_version: 1 },
      { generation: 1, status: "retired", definition_version: 1 },
    ]);
    expect(await pointer(service, viewId)).toMatchObject({ generation: 0, switch_kind: "forced", switch_reason: winnerReason });
  });

  it("loses the in-batch fence after classification passes and leaves pointer and statuses untouched", async () => {
    const service = newService("g152f");
    const viewId = viewFor(service);
    const store = await views();
    await store.createActive({ serviceId: service, viewId, definitionVersion: 1, updatedAt: 1 });
    await store.createCandidate({ serviceId: service, viewId, generation: 1, definitionVersion: 1, updatedAt: 2 });
    await store.promoteGeneration({ serviceId: service, viewId, candidateGeneration: 1, expectedActiveGeneration: 0, updatedAt: 3 });
    const competitor = await views();
    let raced = false;
    const racing = new Proxy(mvDatabase(), {
      get(database, property) {
        if (property === "batch") {
          return async (batch: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              await competitor.forceReverseGeneration({ serviceId: service, viewId, retainedGeneration: 0, expectedActiveGeneration: 1, reason: "winner", updatedAt: 4 });
            }
            return database.batch(batch);
          };
        }
        const value = Reflect.get(database, property, database);
        return typeof value === "function" ? value.bind(database) : value;
      },
    }) as D1Database;
    const loser = await views(racing);
    const quarantineBefore = await quarantines(service, viewId);
    await expect(loser.forceReverseGeneration({ serviceId: service, viewId, retainedGeneration: 0, expectedActiveGeneration: 1, reason: "loser", updatedAt: 5 }))
      .rejects.toMatchObject({ operation: "force-reverse", code: "MV_FORCE_REVERSE_CAS_MISMATCH" });
    expect(raced).toBe(true);
    expect(await instances(service, viewId)).toEqual([
      { generation: 0, status: "active", definition_version: 1 },
      { generation: 1, status: "retired", definition_version: 1 },
    ]);
    expect(await pointer(service, viewId)).toEqual({ generation: 0, updated_at: 4, switch_kind: "forced", switch_reason: "winner", switched_at: 4 });
    expect(await quarantines(service, viewId)).toEqual(quarantineBefore);
    expect(await mvDatabase().prepare("SELECT COUNT(*) AS count FROM mv_atomic_guards").first<{ count: number }>()).toEqual({ count: 0 });

    // A stale expectation and a pointed row that is not active both fail the fence.
    await store.createCandidate({ serviceId: service, viewId, generation: 2, definitionVersion: 1, updatedAt: 6 });
    await store.promoteGeneration({ serviceId: service, viewId, candidateGeneration: 2, expectedActiveGeneration: 0, updatedAt: 7 });
    await expect(store.forceReverseGeneration({ serviceId: service, viewId, retainedGeneration: 0, expectedActiveGeneration: 1, reason: "stale", updatedAt: 8 }))
      .rejects.toMatchObject({ code: "MV_FORCE_REVERSE_CAS_MISMATCH" });
    await mvDatabase().prepare("UPDATE mv_instances SET status = 'retired' WHERE service_id = ? AND view_id = ? AND generation = 2").bind(service, viewId).run();
    await expect(store.forceReverseGeneration({ serviceId: service, viewId, retainedGeneration: 1, expectedActiveGeneration: 2, reason: "orphan", updatedAt: 9 }))
      .rejects.toMatchObject({ code: "MV_FORCE_REVERSE_CAS_MISMATCH" });
    expect(await pointer(service, viewId)).toMatchObject({ generation: 2, switch_kind: "ordinary", updated_at: 7 });
    expect((await instances(service, viewId)).map((row) => row.status)).toEqual(["retired", "retired", "retired"]);
  });

  it("validates before any read or DML and retires before it activates", async () => {
    const service = newService("g152v");
    const viewId = viewFor(service);
    const log: string[] = [];
    const store = await views(countingDatabase(mvDatabase(), log));
    log.length = 0;
    const base = { serviceId: service, viewId, retainedGeneration: 0, expectedActiveGeneration: 1, reason: "ok", updatedAt: 1 };
    const invalid: Array<[Record<string, unknown>, string]> = [
      [{ retainedGeneration: -1 }, "MV_GENERATION_INVALID"],
      [{ retainedGeneration: 0.5 }, "MV_GENERATION_INVALID"],
      [{ expectedActiveGeneration: null }, "MV_GENERATION_INVALID"],
      [{ expectedActiveGeneration: Number.MAX_SAFE_INTEGER + 1 }, "MV_GENERATION_INVALID"],
      [{ retainedGeneration: 1, expectedActiveGeneration: 1 }, "MV_GENERATION_INVALID"],
      [{ retainedGeneration: 2, expectedActiveGeneration: 1 }, "MV_GENERATION_INVALID"],
      [{ reason: "" }, "MV_VALUE_INVALID"],
      [{ reason: " \t " }, "MV_VALUE_INVALID"],
      [{ reason: "x".repeat(1025) }, "MV_VALUE_INVALID"],
      [{ reason: "a\u0000b" }, "MV_VALUE_INVALID"],
      [{ reason: "a\nb" }, "MV_VALUE_INVALID"],
      [{ reason: "a\u007fb" }, "MV_VALUE_INVALID"],
      [{ reason: "a\u0085b" }, "MV_VALUE_INVALID"],
      [{ reason: 7 }, "MV_VALUE_INVALID"],
    ];
    for (const [override, code] of invalid) {
      const error = await store.forceReverseGeneration({ ...base, ...override } as never).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MaterializedViewStoreError);
      expect(error).toMatchObject({ operation: "force-reverse", code });
    }
    expect(log).toEqual([]);

    const plain = await views();
    await plain.createActive({ serviceId: service, viewId, definitionVersion: 1, updatedAt: 1 });
    await plain.createCandidate({ serviceId: service, viewId, generation: 1, definitionVersion: 1, updatedAt: 2 });
    await plain.promoteGeneration({ serviceId: service, viewId, candidateGeneration: 1, expectedActiveGeneration: 0, updatedAt: 3 });
    log.length = 0;
    const padded = ` ${"r".repeat(1024)} `;
    await store.forceReverseGeneration({ ...base, reason: padded, updatedAt: 4 });
    expect((await pointer(service, viewId))?.switch_reason).toBe("r".repeat(1024));
    const retire = log.findIndex((sql) => sql.includes("SET status = 'retired'"));
    const activate = log.findIndex((sql) => sql.includes("SET status = 'active'"));
    expect(retire).toBeGreaterThan(-1);
    expect(activate).toBeGreaterThan(retire);
    // Reverse never writes quarantine rows.
    expect(log.some((sql) => /(UPDATE|DELETE FROM|INSERT INTO)\s+mv_ordering_quarantines/i.test(sql))).toBe(false);
    // The retained checkpoint timestamp survives so late-lower detection still covers its retired window.
    expect((await plain.readInstance(service, viewId, 0))?.updatedAt).toBe(3);
  });

  it("refuses candidate, active, missing, and quarantine-history retained generations without touching quarantine rows", async () => {
    const service = newService("g152q");
    const viewId = viewFor(service);
    const store = await views();
    await store.createActive({ serviceId: service, viewId, generation: 5, definitionVersion: 1, updatedAt: 1 });
    await store.createCandidate({ serviceId: service, viewId, generation: 2, definitionVersion: 1, updatedAt: 1 });
    const target = worker("ordinary", service, [materializer(viewId, 1)]);
    const refuse = async (retained: number, expected: number, code: string) => {
      const pointerBefore = await pointer(service, viewId);
      const instancesBefore = await instances(service, viewId);
      const quarantinesBefore = await quarantines(service, viewId);
      const response = await call(target, liveEnv(), "POST", path(viewId, "force-reverse"), { body: reverseBody(retained, expected, "secret-reason") });
      const text = await response.text();
      expect({ retained, expected, status: response.status, code: (JSON.parse(text) as { code: string }).code }).toEqual({ retained, expected, status: 409, code });
      expect(text).not.toContain("secret");
      expect(await pointer(service, viewId)).toEqual(pointerBefore);
      expect(await instances(service, viewId)).toEqual(instancesBefore);
      expect(await quarantines(service, viewId)).toEqual(quarantinesBefore);
    };
    await refuse(2, 5, REJECTED); // candidate
    await refuse(5, 6, REJECTED); // the current active
    await refuse(3, 5, REJECTED); // missing
    await refuse(4, 6, REJECTED); // missing, and the pointer is not 6 either

    // A retired generation with an open quarantine is refused.
    const second = newService("g152h");
    const secondView = viewFor(second);
    const secondEvent = await record(second, 1);
    const secondTarget = worker("ordinary", second, [materializer(secondView, 1)]);
    await servingOne(secondTarget, secondView);
    await openQuarantine(second, secondView, 0, secondEvent);
    const openBefore = await quarantines(second, secondView);
    const open = await call(secondTarget, liveEnv(), "POST", path(secondView, "force-reverse"), { body: reverseBody(0, 1, "retry") });
    expect(open.status).toBe(409);
    expect((await body<{ code: string }>(open)).code).toBe(REJECTED);
    expect(await quarantines(second, secondView)).toEqual(openBefore);
    // ...and so is one whose quarantine was resolved by an earlier promote.
    await mvDatabase().prepare(
      "UPDATE mv_ordering_quarantines SET status = 'resolved', resolved_at = 2 WHERE service_id = ? AND view_id = ? AND generation = 0",
    ).bind(second, secondView).run();
    const resolvedBefore = await quarantines(second, secondView);
    expect(resolvedBefore).toEqual([expect.objectContaining({ generation: 0, status: "resolved" })]);
    const resolved = await call(secondTarget, liveEnv(), "POST", path(secondView, "force-reverse"), { body: reverseBody(0, 1, "retry") });
    expect(resolved.status).toBe(409);
    expect((await body<{ code: string }>(resolved)).code).toBe(REJECTED);
    expect(await quarantines(second, secondView)).toEqual(resolvedBefore);
    expect(await instances(second, secondView)).toEqual([
      { generation: 0, status: "retired", definition_version: 1 },
      { generation: 1, status: "active", definition_version: 1 },
    ]);
    // The store path refuses the same history directly, before its batch.
    await expect(store.forceReverseGeneration({ serviceId: second, viewId: secondView, retainedGeneration: 0, expectedActiveGeneration: 1, reason: "r", updatedAt: 9 }))
      .rejects.toMatchObject({ code: "MV_FORCE_REVERSE_REJECTED" });
  });

  it("leaves a leaving-generation quarantine open, ungated for re-served reads, blocking promote, and feeding rebuild", async () => {
    const service = newService("g152l");
    const viewId = viewFor(service);
    const event = await record(service, 1);
    const target = worker("ordinary", service, [materializer(viewId, 1)]);
    await servingOne(target, viewId);
    const store = await views();
    await openQuarantine(service, viewId, 1, event);
    // Before reverse the open quarantine gates safe reads of the active generation.
    expect(await store.readOrderingQuarantine(service, viewId)).toMatchObject({ generation: 1, status: "open" });
    const quarantineBefore = await quarantines(service, viewId);

    const reversed = await call(target, liveEnv(), "POST", path(viewId, "force-reverse"), { body: reverseBody(0, 1, "leave quarantined generation") });
    expect(reversed.status).toBe(200);
    expect(await quarantines(service, viewId)).toEqual(quarantineBefore);
    expect(quarantineBefore).toEqual([expect.objectContaining({ generation: 1, status: "open" })]);
    // The safe-read gate only joins the active generation; generation 0 serves.
    expect(await store.readOrderingQuarantine(service, viewId)).toBeUndefined();
    const page = await store.readListPage(service, viewId, { consistency: "safe" });
    expect(page.rows.map((row) => [row.generation, row.rowKey])).toEqual([[0, event.eventId]]);
    const status = await call(target, liveEnv(), "GET", path(viewId, "status"));
    expect(await body<MaterializedViewRuntimeStatus>(status)).toMatchObject({
      generation: 0,
      switchKind: "forced",
      switchReason: "leave quarantined generation",
      leavingGenerationQuarantineOpen: true,
      catchUpHalted: false,
    });

    // A later ordinary promote of an unproven candidate is still refused.
    await store.createCandidate({ serviceId: service, viewId, generation: 2, definitionVersion: 1, updatedAt: 1 });
    await expect(store.promoteGeneration({ serviceId: service, viewId, candidateGeneration: 2, expectedActiveGeneration: 0, updatedAt: 2 }))
      .rejects.toMatchObject({ code: "MV_PROMOTION_CAS_MISMATCH" });
    // Rebuild still selects the open quarantine on the leaving generation.
    const prepared = await call(target, liveEnv(), "POST", path(viewId, "prepare"));
    expect(prepared.status).toBe(200);
    const candidate = (await body<{ result: { candidateGeneration: number } }>(prepared)).result.candidateGeneration;
    expect(await store.readInstance(service, viewId, candidate)).toMatchObject({
      status: "candidate",
      rebuildIncidentGeneration: 1,
      rebuildIncidentIdentity: quarantineBefore[0]!.incident_identity,
    });
    expect(await quarantines(service, viewId)).toEqual(quarantineBefore);
  });

  for (const composition of ["ordinary", "cloudflare"] as const) {
    it(`${composition}: authenticates first and rejects invalid bodies with a fixed 400 before any factory`, async () => {
      const service = newService("g152i");
      const viewId = viewFor(service);
      const identityCalls = { count: 0 };
      const touches = { count: 0 };
      let created = 0;
      const actions = [materializer(viewId, 1)] as unknown as readonly MaterializedViewRowMaterializer[];
      const target = (composition === "ordinary"
        ? createRuntimeWorker({
          serviceIdentityProvider: identity(service, identityCalls),
          materializedViewActions: actions,
          storeProvider: { name: "sentinel", create: () => { created += 1; throw new Error("store sentinel"); } },
        })
        : createCloudflareOnlyRuntimeWorker({ serviceIdentityProvider: identity(service, identityCalls), materializedViewActions: actions })) as unknown as Worker;
      const bindings = (token: unknown) => ({ REPAIR_OPERATOR_TOKEN: token, D1: trap(touches), D1_MV: trap(touches), TAG: trap(touches), JOURNAL: trap(touches) });
      const valid = reverseBody(0, 1, "ok");
      for (const token of [undefined, ""]) {
        const response = await call(target, bindings(token), "POST", path(viewId, "force-reverse"), { body: valid });
        expect(response.status).toBe(404);
        expect((await body<{ code: string }>(response)).code).toBe("operator_repair_route_not_found");
      }
      for (const authorization of [null, "Bearer wrong", `bearer ${TOKEN}`]) {
        const response = await call(target, bindings(TOKEN), "POST", path(viewId, "force-reverse"), { body: valid, authorization });
        expect(response.status).toBe(401);
      }
      for (const [method, route] of [["POST", path("unregistered-view", "force-reverse")], ["GET", path(viewId, "force-reverse")]] as const) {
        const response = await call(target, bindings(TOKEN), method, route, { body: method === "POST" ? valid : undefined });
        expect(response.status).toBe(404);
        expect((await body<{ code: string }>(response)).code).toBe("materialized_view_action_not_found");
      }
      const invalid: Array<string | undefined> = [
        undefined,
        "",
        "{}",
        "[]",
        "null",
        "{not-json",
        JSON.stringify({ retainedGeneration: 0, expectedActiveGeneration: 1 }),
        JSON.stringify({ retainedGeneration: 0, reason: "r" }),
        JSON.stringify({ retainedGeneration: 0, expectedActiveGeneration: 1, reason: "r", force: true }),
        reverseBody(0, null, "r"),
        reverseBody(null, 1, "r"),
        reverseBody(-1, 1, "r"),
        reverseBody(0.5, 1, "r"),
        reverseBody("0", 1, "r"),
        reverseBody(0, 9007199254740992, "r"),
        reverseBody(1, 1, "r"),
        reverseBody(2, 1, "r"),
        reverseBody(0, 1, ""),
        reverseBody(0, 1, "   "),
        reverseBody(0, 1, "x".repeat(1025)),
        reverseBody(0, 1, "line\nbreak"),
        reverseBody(0, 1, "nul\u0000"),
        reverseBody(0, 1, "c1\u009b"),
        reverseBody(0, 1, null),
        reverseBody(0, 1, 42),
      ];
      for (const payload of invalid) {
        const response = await call(target, bindings(TOKEN), "POST", path(viewId, "force-reverse"), { body: payload });
        expect({ payload, status: response.status }).toEqual({ payload, status: 400 });
        expect(await body(response)).toEqual(INVALID);
      }
      expect(identityCalls.count).toBe(0);
      expect(touches.count).toBe(0);
      expect(created).toBe(0);
    });
  }

  it("keeps the route off the serialized path set", () => {
    expect(SERIALIZED_PATHS).toHaveLength(7);
    expect(SERIALIZED_PATHS.some((route) => route.startsWith(MATERIALIZED_VIEW_ACTIONS_PREFIX))).toBe(false);
  });

  it("never rewrites definition_version: reversing to an older definition makes refresh fail closed", async () => {
    const service = newService("g152d");
    const viewId = viewFor(service);
    await record(service, 1);
    const v1 = worker("ordinary", service, [materializer(viewId, 1)]);
    const v2 = worker("ordinary", service, [materializer(viewId, 2)]);
    expect((await call(v1, liveEnv(), "POST", path(viewId, "ensure-started"))).status).toBe(200);
    const prepared = await body<{ result: { candidateGeneration: number } }>(await call(v2, liveEnv(), "POST", path(viewId, "prepare")));
    expect((await call(v2, liveEnv(), "POST", path(viewId, "switch"), {
      body: JSON.stringify({ candidateGeneration: prepared.result.candidateGeneration, expectedActiveGeneration: 0 }),
    })).status).toBe(200);
    const reversed = await call(v2, liveEnv(), "POST", path(viewId, "force-reverse"), {
      body: reverseBody(0, prepared.result.candidateGeneration, "v2 regression"),
    });
    expect(reversed.status).toBe(200);
    expect(await instances(service, viewId)).toEqual([
      { generation: 0, status: "active", definition_version: 1 },
      { generation: prepared.result.candidateGeneration, status: "retired", definition_version: 2 },
    ]);
    // Different identities: the previous v2 heartbeat is written without a switch, the v1 one as forced.
    expect(await heartbeatFor(service, viewId, 1)).toMatchObject({ switchKind: "forced", switchReason: "v2 regression" });
    expect(await heartbeatFor(service, viewId, 2)).toMatchObject({ phase: "stopped", switchKind: null });
    const refresh = await call(v2, liveEnv(), "POST", path(viewId, "refresh"));
    expect(refresh.status).toBe(409);
    expect((await body<{ code: string }>(refresh)).code).toBe("materialized_view_definition_version_mismatch");
    const direct = new MaterializedViewCatchUpRuntime(await source(), await views());
    await expect(direct.follow(service, materializer(viewId, 2), Date.now())).rejects.toBeInstanceOf(MaterializedViewDefinitionVersionMismatchError);
    expect((await (await views()).readActive(service, viewId))?.definitionVersion).toBe(1);
    // Redeploying matching code serves again.
    expect((await call(v1, liveEnv(), "POST", path(viewId, "refresh"))).status).toBe(200);
  });

  it("calls the store once and keeps a committed reverse when publication or observation fails", async () => {
    const service = newService("g152p");
    const viewId = viewFor(service);
    await record(service, 1);
    const target = worker("ordinary", service, [materializer(viewId, 1)]);
    await servingOne(target, viewId);
    const storeSpy = vi.spyOn(D1MaterializedViewStore.prototype, "forceReverseGeneration");
    const promoteSpy = vi.spyOn(D1MaterializedViewStore.prototype, "promoteGeneration");
    const heartbeatBefore = await heartbeatFor(service, viewId, 1);
    const log: string[] = [];
    const broken = countingDatabase(d1(), log, (sql) => sql.includes("dcb_projection_statuses"));
    const reversed = await call(target, liveEnv({ D1: broken }), "POST", path(viewId, "force-reverse"), { body: reverseBody(0, 1, "publication down") });
    expect(reversed.status).toBe(200);
    const reversedBody = await body<{ result: { generation: number }; status: unknown }>(reversed);
    expect(reversedBody.result.generation).toBe(0);
    expect(reversedBody.status).toBeNull();
    expect(storeSpy).toHaveBeenCalledTimes(1);
    expect(storeSpy.mock.calls[0]![0]).toMatchObject({ retainedGeneration: 0, expectedActiveGeneration: 1, reason: "publication down" });
    expect(promoteSpy).not.toHaveBeenCalled();
    expect(await heartbeatFor(service, viewId, 1)).toEqual(heartbeatBefore);
    expect(await pointer(service, viewId)).toMatchObject({ generation: 0, switch_kind: "forced", switch_reason: "publication down" });
  });
});
