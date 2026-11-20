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

import { defineRowMaterializer, type MaterializedViewRowMaterializer } from "@sekiban/dcb-core";
import { composeFetch, SERIALIZED_PATHS } from "../packages/dcb-cloudflare/src/compose";
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
import { D1MaterializedViewStore } from "../packages/dcb-runtime/src/mv/MaterializedViewStore";
import {
  PROJECTION_STATUS_FAULT_MESSAGE,
  formatProjectionStatusUtc,
  mvProjectionStatusIdentity,
} from "../packages/dcb-runtime/src/mv/ProjectionStatus";
import type { ServiceIdentityProvider } from "../packages/dcb-runtime/src/service/ServiceIdentityProvider";
import { D1EventStore } from "../packages/dcb-runtime/src/store/D1EventStore";
import type { ProjectionStatusHeartbeat, StoredEvent } from "../packages/dcb-runtime/src/store/types";
import { g32EventId, g32Message, g32Suid } from "./helpers/g32-fixtures";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";

const TOKEN = "g151-operator-token";
const DTO_MEMBERS = [
  "serviceId",
  "viewName",
  "viewVersion",
  "started",
  "catchUpInProgress",
  "isCatchUpActive",
  "subscriptionActive",
  "bufferedEventCount",
  "currentPosition",
  "lastReceivedSortableUniqueId",
  "lastError",
  "lastCatchUpStartedAt",
  "lastCatchUpCompletedAt",
  "lastCatchUpAttemptAt",
  "consecutiveEmptyBatches",
  "lastProgressSortableUniqueId",
  "needsImmediateCatchUp",
  "catchUpBatchSkipCount",
  "catchUpHalted",
  "generation",
  "generationStatus",
  "rebuildRequired",
  "isFresh",
];

type Worker = ExportedHandler<never>;
type Composition = "ordinary" | "cloudflare";

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
  return `g151-view-${service}`;
}

function materializer(id: string, version: number, plan?: (event: StoredEvent) => void): MaterializedViewRowMaterializer<StoredEvent> {
  return defineRowMaterializer<StoredEvent>({
    id,
    version,
    indexDescriptors: [{ id: "event-id", valueType: "text", value: (_row, event) => event.eventId }],
    materialize: (event) => {
      plan?.(event);
      return { rowUpserts: [{ rowKey: event.eventId, value: { eventId: event.eventId }, sourceSuid: event.suid }] };
    },
  });
}

function identity(service: string, calls?: { count: number }, fail = false): ServiceIdentityProvider {
  const resolve = () => {
    if (calls !== undefined) calls.count += 1;
    if (fail) throw new Error("identity sentinel");
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

function path(viewId: string, action: string, query = ""): string {
  return `${MATERIALIZED_VIEW_ACTIONS_PREFIX}/${encodeURIComponent(viewId)}/${action}${query}`;
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
  return target.fetch!(new Request(`https://g151.test${route}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  }) as never, bindings as never, createExecutionContext());
}

async function record(service: string, seed: number, arrivedAt = 0): Promise<{ eventId: string; suid: string }> {
  const source = new D1EventStore(d1());
  await source.initialize();
  const message = g32Message({
    serviceId: service,
    tag: `g151:${service}`,
    eventId: `${service}-event-${seed}`,
    suid: g32Suid(seed),
    eventType: "G151FixtureEvent",
    // Equal enqueue/arrival keeps the measured lag bound at zero.
    enqueuedAt: arrivedAt,
  });
  expect((await source.recordDelivery(message, arrivedAt)).outcome).toBe("stored");
  return { eventId: message.eventId, suid: message.suid };
}

async function views(): Promise<D1MaterializedViewStore> {
  const store = new D1MaterializedViewStore(mvDatabase());
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

async function body<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

/** Counts real D1 statements by SQL text without replacing the provider. */
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

describe("SDT-G151 authenticated materialized-view actions", () => {
  beforeAll(async () => {
    if (!(await tableExists(d1(), "dcb_events"))) await d1().batch(statements(d1(), g32Migration as string));
    await applyG44D1Migration(d1());
    if (!(await tableExists(d1(), "dcb_projection_statuses"))) await d1().batch(statements(d1(), d1StatusMigration as string));
    if (!(await tableExists(mvDatabase(), "mv_instances"))) {
      for (const migration of [mv0001, mv0002, mv0003, mv0004, mv0005, mv0006, mv0007, mv0008, mv0009]) {
        await mvDatabase().batch(statements(mvDatabase(), migration as string));
      }
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const composition of ["ordinary", "cloudflare"] as const) {
    it(`${composition}: authenticates the reserved prefix before parsing, identity, stores, or durable objects`, async () => {
      const service = newService("g151a");
      const viewId = viewFor(service);
      const identityCalls = { count: 0 };
      const touches = { count: 0 };
      let created = 0;
      const actions = [materializer(viewId, 1)] as unknown as readonly MaterializedViewRowMaterializer[];
      const throwingIdentity = identity(service, identityCalls, true);
      const target = (composition === "ordinary"
        ? createRuntimeWorker({
          serviceIdentityProvider: throwingIdentity,
          materializedViewActions: actions,
          storeProvider: { name: "sentinel", create: () => { created += 1; throw new Error("store sentinel"); } },
        })
        : createCloudflareOnlyRuntimeWorker({ serviceIdentityProvider: throwingIdentity, materializedViewActions: actions })) as unknown as Worker;
      const sentinelEnv = (token: unknown): Record<string, unknown> => ({
        REPAIR_OPERATOR_TOKEN: token,
        D1: trap(touches),
        D1_MV: trap(touches),
        ALLOCATOR: trap(touches),
        BOOTSTRAP: trap(touches),
        JOURNAL: trap(touches),
        TAG: trap(touches),
        TAG_STATE: trap(touches),
      });
      const probes: Array<[string, string, string | undefined]> = [
        ["GET", path(viewId, "status"), undefined],
        ["POST", `${MATERIALIZED_VIEW_ACTIONS_PREFIX}/%E0%A4%A/refresh`, "{}"],
        ["POST", path(viewId, "refresh"), "{not-json"],
        ["POST", path(viewId, "unknown"), undefined],
        ["GET", MATERIALIZED_VIEW_ACTIONS_PREFIX, undefined],
      ];
      for (const token of [undefined, 42, "", "   "]) {
        for (const [method, route, payload] of probes) {
          const response = await call(target, sentinelEnv(token), method, route, { body: payload });
          expect(response.status).toBe(404);
          expect(await body(response)).toEqual({ error: "Operator repair route not found", code: "operator_repair_route_not_found" });
        }
      }
      for (const authorization of [null, "Bearer wrong", `bearer ${TOKEN}`, `Bearer ${TOKEN.toUpperCase()}`, `Bearer  ${TOKEN}`, `Bearer ${TOKEN} x`]) {
        for (const [method, route, payload] of probes) {
          const response = await call(target, sentinelEnv(TOKEN), method, route, { body: payload, authorization });
          expect(response.status).toBe(401);
          expect((await body<{ code: string }>(response)).code).toBe("operator_auth_required");
        }
      }
      // A configured token with surrounding whitespace is matched exactly; a
      // trimmed bearer is not accepted.
      expect((await call(target, sentinelEnv(` ${TOKEN} `), "GET", path(viewId, "status"))).status).toBe(401);
      expect(identityCalls.count).toBe(0);
      expect(touches.count).toBe(0);
      expect(created).toBe(0);

      const authorized = sentinelEnv(TOKEN);
      const notFound = [
        ["GET", path(viewId, "refresh")],
        ["POST", path(viewId, "status")],
        ["POST", path(viewId, "force-reverse")],
        ["POST", path(viewId, "deactivate")],
        ["POST", `${path(viewId, "refresh")}/extra`],
        ["POST", `${MATERIALIZED_VIEW_ACTIONS_PREFIX}/${viewId}`],
        ["GET", MATERIALIZED_VIEW_ACTIONS_PREFIX],
        ["GET", path("unregistered-view", "status")],
      ] as const;
      for (const [method, route] of notFound) {
        const response = await call(target, authorized, method, route);
        expect(response.status).toBe(404);
        expect((await body<{ code: string }>(response)).code).toBe("materialized_view_action_not_found");
      }
      for (const route of [
        `${MATERIALIZED_VIEW_ACTIONS_PREFIX}/%E0%A4%A/status`,
        `${MATERIALIZED_VIEW_ACTIONS_PREFIX}//status`,
        `${MATERIALIZED_VIEW_ACTIONS_PREFIX}/${encodeURIComponent(`${viewId}/x`)}/status`,
      ]) {
        const response = await call(target, authorized, "GET", route);
        expect(response.status).toBe(400);
      }
      expect((await call(target, authorized, "POST", path(viewId, "refresh"), { body: "{not-json" })).status).toBe(400);
      expect(identityCalls.count).toBe(0);
      expect(touches.count).toBe(0);

      const scoped = await call(target, authorized, "GET", path(viewId, "status"));
      expect(scoped.status).toBe(503);
      expect((await body<{ code: string }>(scoped)).code).toBe("scope.identity_missing");
      expect(identityCalls.count).toBe(1);
      expect(touches.count).toBe(0);
      expect(created).toBe(0);
    });
  }

  it("indexes a server registry once and refuses request-supplied selectors before opening stores", () => {
    const duplicate = [materializer("dup", 1), materializer("dup", 2)] as unknown as readonly MaterializedViewRowMaterializer[];
    expect(() => createRuntimeWorker({ materializedViewActions: duplicate })).toThrow("duplicate materializer id");
    expect(() => createCloudflareOnlyRuntimeWorker({ materializedViewActions: duplicate })).toThrow("duplicate materializer id");
    expect(() => createRuntimeWorker({ materializedViewActions: [{ id: "", version: 1 }] as never })).toThrow("invalid row materializer");
    expect(() => createRuntimeWorker()).not.toThrow();
  });

  for (const composition of ["ordinary", "cloudflare"] as const) {
    it(`${composition}: rejects invalid authorized input with a fixed 400 before any factory runs`, async () => {
      const service = newService("g151i");
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
      const bindings = { REPAIR_OPERATOR_TOKEN: TOKEN, D1: trap(touches), D1_MV: trap(touches), TAG: trap(touches), JOURNAL: trap(touches) };
      const suid = g32Suid(1);
      const invalid: Array<[string, string, string | undefined]> = [
        ["POST", path(viewId, "ensure-started"), "{\"version\":2}"],
        ["POST", path(viewId, "ensure-started"), "{\"serviceId\":\"other\"}"],
        ["POST", path(viewId, "ensure-started"), "[]"],
        ["POST", path(viewId, "ensure-started"), "null"],
        ["POST", path(viewId, "refresh"), "{}{}"],
        ["POST", path(viewId, "refresh"), "{\"code\":\"x\",\"table\":\"mv_rows\",\"provider\":\"postgres\"}"],
        ["POST", path(viewId, "refresh"), "{\"hooks\":{},\"maximumSuid\":null}"],
        ["POST", path(viewId, "refresh", "?serviceId=other"), undefined],
        ["POST", path(viewId, "prepare"), "{\"rebuildId\":\"\"}"],
        ["POST", path(viewId, "prepare"), JSON.stringify({ rebuildId: "あ".repeat(43) })],
        ["POST", path(viewId, "prepare"), "{\"rebuildId\":7}"],
        ["POST", path(viewId, "prepare"), "{\"rebuildId\":\"r\",\"generation\":2}"],
        ["POST", path(viewId, "prepare"), "{\"definitionVersion\":3}"],
        ["POST", path(viewId, "switch"), undefined],
        ["POST", path(viewId, "switch"), "{}"],
        ["POST", path(viewId, "switch"), "{\"candidateGeneration\":1}"],
        ["POST", path(viewId, "switch"), "{\"candidateGeneration\":null,\"expectedActiveGeneration\":0}"],
        ["POST", path(viewId, "switch"), "{\"candidateGeneration\":-1,\"expectedActiveGeneration\":0}"],
        ["POST", path(viewId, "switch"), "{\"candidateGeneration\":1.5,\"expectedActiveGeneration\":0}"],
        ["POST", path(viewId, "switch"), "{\"candidateGeneration\":\"1\",\"expectedActiveGeneration\":0}"],
        ["POST", path(viewId, "switch"), "{\"candidateGeneration\":1,\"expectedActiveGeneration\":\"0\"}"],
        ["POST", path(viewId, "switch"), "{\"candidateGeneration\":9007199254740992,\"expectedActiveGeneration\":0}"],
        ["POST", path(viewId, "switch"), "{\"candidateGeneration\":1,\"expectedActiveGeneration\":0,\"force\":true}"],
        ["GET", path(viewId, "status", "?serviceId=other"), undefined],
        ["GET", path(viewId, "received"), undefined],
        ["GET", path(viewId, "received", "?sortableUniqueId=not-a-suid"), undefined],
        ["GET", path(viewId, "received", `?sortableUniqueId=${suid}&sortableUniqueId=${suid}`), undefined],
        ["GET", path(viewId, "received", `?sortableUniqueId=${suid}&serviceId=other`), undefined],
        ["GET", path(viewId, "received", `?SortableUniqueId=${suid}`), undefined],
      ];
      for (const [method, route, payload] of invalid) {
        const response = await call(target, bindings, method, route, { body: payload });
        expect({ route, payload, status: response.status }).toEqual({ route, payload, status: 400 });
        expect(await body(response)).toEqual({ error: "Materialized-view action request is invalid.", code: "materialized_view_action_invalid_request" });
      }
      expect(identityCalls.count).toBe(0);
      expect(touches.count).toBe(0);
      expect(created).toBe(0);
    });
  }

  it("reports unsupported providers as 501, missing D1_MV as 503, and closes owned sources", async () => {
    const service = newService("g151u");
    const viewId = viewFor(service);
    let closed = 0;
    let initialized = 0;
    let statusOpened = 0;
    const target = createRuntimeWorker({
      serviceIdentityProvider: identity(service),
      materializedViewActions: [materializer(viewId, 1)] as unknown as readonly MaterializedViewRowMaterializer[],
      storeProvider: {
        name: "cosmos-like",
        create: () => ({
          initialize: async () => { initialized += 1; },
          close: async () => { closed += 1; },
          readAllEvents: async () => [],
        }) as never,
      },
    }) as unknown as Worker;
    const status = await call(target, liveEnv(), "GET", path(viewId, "status"));
    expect(status.status).toBe(501);
    expect((await body<{ code: string }>(status)).code).toBe("materialized_view_action_unsupported");
    const received = await call(target, liveEnv(), "GET", path(viewId, "received", `?sortableUniqueId=${g32Suid(1)}`));
    expect(received.status).toBe(501);
    expect(initialized).toBe(0);
    expect(closed).toBe(2);

    const missing = await call(target, liveEnv({ D1_MV: undefined }), "POST", path(viewId, "refresh"));
    expect(missing.status).toBe(503);
    expect((await body<{ code: string }>(missing)).code).toBe("materialized_view_action_unavailable");
    expect(closed).toBe(3);

    // A PostgreSQL-shaped source is opened through its connection-only seam.
    const postgresLike = createRuntimeWorker({
      serviceIdentityProvider: identity(service),
      materializedViewActions: [materializer(viewId, 1)] as unknown as readonly MaterializedViewRowMaterializer[],
      storeProvider: {
        name: "postgres-like",
        create: () => ({
          initialize: async () => { throw new Error("schema DDL must not run"); },
          openProjectionStatusConnection: async () => { statusOpened += 1; },
          close: async () => { closed += 1; },
          readAllEvents: async () => [],
          readProjectionStatusHeartbeat: async () => undefined,
          upsertProjectionStatusHeartbeat: async () => { throw new Error("status write"); },
          listProjectionStatusHeartbeats: async () => [],
        }) as never,
      },
    }) as unknown as Worker;
    const pgStatus = await call(postgresLike, liveEnv(), "GET", path(viewId, "status"));
    expect(pgStatus.status).toBe(200);
    expect((await body<MaterializedViewRuntimeStatus>(pgStatus)).started).toBe(false);
    expect(statusOpened).toBe(1);
    expect(closed).toBe(4);
  });

  for (const composition of ["ordinary", "cloudflare"] as const) {
    it(`${composition}: executes all six routes through the shared handler`, async () => {
      const service = newService(composition === "ordinary" ? "g151o" : "g151c");
      const viewId = `${viewFor(service)} ä`;
      const first = await record(service, 1);
      const target = worker(composition, service, [materializer(viewId, 1)]);
      const bindings = liveEnv();
      const ensured = await call(target, bindings, "POST", path(viewId, "ensure-started"));
      expect(ensured.status).toBe(200);
      const ensureBody = await body<{ result: { instance: { generation: number } }; status: MaterializedViewRuntimeStatus }>(ensured);
      expect(ensureBody.result.instance.generation).toBe(0);
      expect(ensureBody.status).toMatchObject({ viewName: viewId, started: true, generation: 0, currentPosition: first.suid });
      await record(service, 2);
      const refreshed = await call(target, bindings, "POST", path(viewId, "refresh"), { body: "{}" });
      expect(refreshed.status).toBe(200);
      expect((await body<{ result: { appliedEvents: number } }>(refreshed)).result.appliedEvents).toBe(1);
      const prepared = await call(target, bindings, "POST", path(viewId, "prepare"), { body: "{\"rebuildId\":\"g151-six\"}" });
      expect(prepared.status).toBe(200);
      const preparedBody = await body<{ result: { candidateGeneration: number; rebuildId: string } }>(prepared);
      expect(preparedBody.result).toMatchObject({ candidateGeneration: 1, rebuildId: "g151-six" });
      const switched = await call(target, bindings, "POST", path(viewId, "switch"), {
        body: JSON.stringify({ candidateGeneration: 1, expectedActiveGeneration: 0 }),
      });
      expect(switched.status).toBe(200);
      expect((await body<{ result: { generation: number; status: string } }>(switched)).result).toMatchObject({ generation: 1, status: "active" });
      const status = await call(target, bindings, "GET", path(viewId, "status"));
      expect(status.status).toBe(200);
      expect(await body<MaterializedViewRuntimeStatus>(status)).toMatchObject({ generation: 1, generationStatus: "active", viewVersion: 1 });
      const received = await call(target, bindings, "GET", path(viewId, "received", `?sortableUniqueId=${first.suid}`));
      expect(received.status).toBe(200);
      expect(await received.text()).toBe("true");
      expect((await heartbeatFor(service, viewId, 1))?.activationId).toBe("operator");
    });
  }

  it("serves the routes only through an explicit composeFetch extraPrefixes mount", async () => {
    expect(SERIALIZED_PATHS).toHaveLength(7);
    expect(SERIALIZED_PATHS.some((route) => route.startsWith(MATERIALIZED_VIEW_ACTIONS_PREFIX))).toBe(false);
    const service = newService("g151m");
    const viewId = viewFor(service);
    const runtime = worker("ordinary", service, [materializer(viewId, 1)]);
    let authorized = 0;
    const mount = (extraPrefixes?: readonly string[]) => composeFetch<Record<string, unknown>>({
      application: () => new Response("application", { status: 299 }),
      sekiban: {
        prefix: "/sekiban",
        fetch: (request, bindings, ctx) => runtime.fetch!(request as never, bindings as never, ctx),
        authorize: () => { authorized += 1; return true; },
        ...(extraPrefixes === undefined ? {} : { extraPrefixes }),
      },
    });
    const request = () => new Request(`https://g151.test/sekiban${path(viewId, "status")}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const unmounted = await mount()(request() as never, liveEnv(), createExecutionContext());
    expect(unmounted.status).toBe(404);
    expect(await unmounted.text()).toBe("runtime route is not forwarded");
    expect(authorized).toBe(0);
    const mounted = await mount([MATERIALIZED_VIEW_ACTIONS_PREFIX])(request() as never, liveEnv(), createExecutionContext());
    expect(mounted.status).toBe(200);
    expect(authorized).toBe(1);
    const unauthenticated = await mount([MATERIALIZED_VIEW_ACTIONS_PREFIX])(
      new Request(`https://g151.test/sekiban${path(viewId, "status")}`) as never,
      liveEnv(),
      createExecutionContext(),
    );
    expect(unauthenticated.status).toBe(401);
  });

  it("ensure-started builds once, repeats without writes, converges concurrently, and never fabricates success", async () => {
    const service = newService("g151e");
    const viewId = viewFor(service);
    await record(service, 1);
    const buildSpy = vi.spyOn(MaterializedViewCatchUpRuntime.prototype, "build");
    const followSpy = vi.spyOn(MaterializedViewCatchUpRuntime.prototype, "follow");
    const target = worker("ordinary", service, [materializer(viewId, 1)]);
    const first = await call(target, liveEnv(), "POST", path(viewId, "ensure-started"));
    expect(first.status).toBe(200);
    expect(buildSpy).toHaveBeenCalledTimes(1);
    const published = await heartbeatFor(service, viewId, 1);
    expect(published?.activationId).toBe("operator");
    const rowsBefore = await (await views()).readRows(service, viewId, 0);
    expect(rowsBefore).toHaveLength(1);
    const instanceBefore = await (await views()).readInstance(service, viewId, 0);

    await record(service, 2);
    const repeated = await call(target, liveEnv(), "POST", path(viewId, "ensure-started"), { body: "{}" });
    expect(repeated.status).toBe(200);
    const repeatedBody = await body<{ result: unknown; status: MaterializedViewRuntimeStatus }>(repeated);
    expect(repeatedBody.result).toBeNull();
    expect(repeatedBody.status.started).toBe(true);
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(followSpy).not.toHaveBeenCalled();
    expect(await (await views()).readRows(service, viewId, 0)).toEqual(rowsBefore);
    expect(await (await views()).readInstance(service, viewId, 0)).toEqual(instanceBefore);
    expect((await heartbeatFor(service, viewId, 1))?.sequence).toBe(published?.sequence);

    const concurrent = newService("g151k");
    const concurrentView = viewFor(concurrent);
    const concurrentWorker = worker("ordinary", concurrent, [materializer(concurrentView, 1)]);
    const responses = await Promise.all([
      call(concurrentWorker, liveEnv(), "POST", path(concurrentView, "ensure-started")),
      call(concurrentWorker, liveEnv(), "POST", path(concurrentView, "ensure-started")),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await instances(concurrent, concurrentView)).toEqual([{ generation: 0, status: "active", definition_version: 1 }]);

    const failing = newService("g151f");
    const failingView = viewFor(failing);
    const failingWorker = worker("ordinary", failing, [materializer(failingView, 1)]);
    const brokenTarget = new Proxy(mvDatabase(), {
      get(database, property) {
        if (property === "batch") return async () => { throw new Error("secret-batch-failure"); };
        const value = Reflect.get(database, property, database);
        return typeof value === "function" ? value.bind(database) : value;
      },
    });
    const failed = await call(failingWorker, liveEnv({ D1_MV: brokenTarget }), "POST", path(failingView, "ensure-started"));
    expect(failed.status).toBe(503);
    const failedText = await failed.text();
    expect(failedText).not.toContain("secret");
    expect(JSON.parse(failedText)).toEqual({ error: "Materialized-view action is unavailable.", code: "materialized_view_action_unavailable" });
    expect(await instances(failing, failingView)).toEqual([]);
  });

  it("refresh follows once, never builds, and refuses a definition-version mismatch without touching serving rows", async () => {
    const service = newService("g151r");
    const viewId = viewFor(service);
    await record(service, 1);
    const v1 = worker("ordinary", service, [materializer(viewId, 1)]);
    const v2 = worker("ordinary", service, [materializer(viewId, 2)]);
    const missing = await call(v1, liveEnv(), "POST", path(viewId, "refresh"));
    expect(missing.status).toBe(409);
    expect((await body<{ code: string }>(missing)).code).toBe("materialized_view_not_started");
    expect(await instances(service, viewId)).toEqual([]);

    expect((await call(v1, liveEnv(), "POST", path(viewId, "ensure-started"))).status).toBe(200);
    await record(service, 2);
    const followSpy = vi.spyOn(MaterializedViewCatchUpRuntime.prototype, "follow");
    const buildSpy = vi.spyOn(MaterializedViewCatchUpRuntime.prototype, "build");
    const refreshed = await call(v1, liveEnv(), "POST", path(viewId, "refresh"));
    expect(refreshed.status).toBe(200);
    expect(followSpy).toHaveBeenCalledTimes(1);
    expect(buildSpy).not.toHaveBeenCalled();
    expect(await (await views()).readRows(service, viewId, 0)).toHaveLength(2);

    await record(service, 3);
    const servingRows = await (await views()).readRows(service, viewId, 0);
    const servingInstance = await (await views()).readInstance(service, viewId, 0);
    const v1Heartbeat = await heartbeatFor(service, viewId, 1);
    const mismatch = await call(v2, liveEnv(), "POST", path(viewId, "refresh"));
    expect(mismatch.status).toBe(409);
    expect(await body(mismatch)).toEqual({
      error: "The registered materialized-view definition version does not match the serving generation.",
      code: "materialized_view_definition_version_mismatch",
    });
    expect(await (await views()).readRows(service, viewId, 0)).toEqual(servingRows);
    expect(await (await views()).readInstance(service, viewId, 0)).toEqual(servingInstance);
    expect(await heartbeatFor(service, viewId, 2)).toBeUndefined();
    expect(await heartbeatFor(service, viewId, 1)).toEqual(v1Heartbeat);

    const direct = new MaterializedViewCatchUpRuntime(await source(), await views());
    await expect(direct.follow(service, materializer(viewId, 2), Date.now())).rejects.toBeInstanceOf(MaterializedViewDefinitionVersionMismatchError);
    expect(await (await views()).readInstance(service, viewId, 0)).toEqual(servingInstance);
    expect(await (await views()).readRows(service, viewId, 0)).toEqual(servingRows);
    expect(await heartbeatFor(service, viewId, 2)).toBeUndefined();

    // Version-changing prepare is the supported path; a concurrent refresh
    // with the new definition cannot rewrite N, and switch remains coherent.
    const prepared = await call(v2, liveEnv(), "POST", path(viewId, "prepare"));
    expect(prepared.status).toBe(200);
    const candidate = (await body<{ result: { candidateGeneration: number } }>(prepared)).result.candidateGeneration;
    const [raced, switched] = await Promise.all([
      call(v2, liveEnv(), "POST", path(viewId, "refresh")),
      call(v2, liveEnv(), "POST", path(viewId, "switch"), { body: JSON.stringify({ candidateGeneration: candidate, expectedActiveGeneration: 0 }) }),
    ]);
    expect(switched.status).toBe(200);
    expect([200, 409]).toContain(raced.status);
    expect(await instances(service, viewId)).toEqual([
      { generation: 0, status: "retired", definition_version: 1 },
      { generation: candidate, status: "active", definition_version: 2 },
    ]);
    expect(await (await views()).readRows(service, viewId, 0)).toEqual(servingRows);
    const afterCutover = await call(v1, liveEnv(), "POST", path(viewId, "refresh"));
    expect(afterCutover.status).toBe(409);
    expect((await body<{ code: string }>(afterCutover)).code).toBe("materialized_view_definition_version_mismatch");
  });

  it("prepare keeps generation N serving through failed, stopped, and complete N+1 rebuilds", async () => {
    const service = newService("g151p");
    const viewId = viewFor(service);
    await record(service, 1);
    const v1 = worker("ordinary", service, [materializer(viewId, 1)]);
    expect((await call(v1, liveEnv(), "POST", path(viewId, "ensure-started"))).status).toBe(200);
    const servingRows = await (await views()).readRows(service, viewId, 0);
    const promoteSpy = vi.spyOn(MaterializedViewCatchUpRuntime.prototype, "promote");
    const assertServing = async () => {
      const active = await (await views()).readActive(service, viewId);
      expect(active).toMatchObject({ generation: 0, definitionVersion: 1, status: "active" });
      expect(await (await views()).readRows(service, viewId, 0)).toEqual(servingRows);
    };

    const failing = worker("ordinary", service, [materializer(viewId, 3, () => { throw new Error("secret-plan-failure"); })]);
    const failed = await call(failing, liveEnv(), "POST", path(viewId, "prepare"));
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("secret");
    await assertServing();

    const v2 = worker("ordinary", service, [materializer(viewId, 2)]);
    const complete = await call(v2, liveEnv(), "POST", path(viewId, "prepare"), { body: "{\"rebuildId\":\"g151-complete\"}" });
    expect(complete.status).toBe(200);
    const completeBody = await body<{ result: { candidateGeneration: number; rebuildId: string; stopReason: string | null }; status: MaterializedViewRuntimeStatus }>(complete);
    expect(completeBody.result).toMatchObject({ rebuildId: "g151-complete", stopReason: null });
    const completeCandidate = await (await views()).readInstance(service, viewId, completeBody.result.candidateGeneration);
    expect(completeCandidate).toMatchObject({ status: "candidate", definitionVersion: 2 });
    expect(completeCandidate?.rebuildVerifiedAt).not.toBeNull();
    // Status keeps the serving identity even though a v2 candidate exists.
    expect(completeBody.status).toMatchObject({ viewVersion: 1, generation: 0, generationStatus: "active" });
    await assertServing();

    await record(service, 2, Date.now());
    const stopped = await call(v2, liveEnv(), "POST", path(viewId, "prepare"), { body: "{}" });
    expect(stopped.status).toBe(200);
    const stoppedBody = await body<{ result: { candidateGeneration: number; stopReason: string | null; rebuildId: string } }>(stopped);
    expect(stoppedBody.result.stopReason).toBe("safe_window_fence");
    expect(stoppedBody.result.rebuildId).toMatch(/^g69-rebuild-/);
    expect((await (await views()).readInstance(service, viewId, stoppedBody.result.candidateGeneration))?.rebuildVerifiedAt).toBeNull();
    await assertServing();
    expect(promoteSpy).not.toHaveBeenCalled();

    const status = await call(v2, liveEnv(), "GET", path(viewId, "status"));
    expect(await body<MaterializedViewRuntimeStatus>(status)).toMatchObject({ viewVersion: 1, generation: 0, currentPosition: servingRows[0]?.sourceSuid });
  });

  it("switch forwards the caller expectation to provider CAS and settles a real two-candidate race", async () => {
    const service = newService("g151s");
    const viewId = viewFor(service);
    await record(service, 1);
    const target = worker("ordinary", service, [materializer(viewId, 1)]);
    expect((await call(target, liveEnv(), "POST", path(viewId, "ensure-started"))).status).toBe(200);
    const one = await body<{ result: { candidateGeneration: number } }>(await call(target, liveEnv(), "POST", path(viewId, "prepare")));
    const two = await body<{ result: { candidateGeneration: number } }>(await call(target, liveEnv(), "POST", path(viewId, "prepare")));
    expect([one.result.candidateGeneration, two.result.candidateGeneration]).toEqual([1, 2]);
    const recording = vi.spyOn(D1MaterializedViewStore.prototype, "promoteGeneration");

    const nullExpectation = await call(target, liveEnv(), "POST", path(viewId, "switch"), {
      body: JSON.stringify({ candidateGeneration: 1, expectedActiveGeneration: null }),
    });
    expect(nullExpectation.status).toBe(409);
    expect((await body<{ code: string }>(nullExpectation)).code).toBe("materialized_view_switch_conflict");
    expect(recording.mock.calls.at(-1)?.[0]).toMatchObject({ candidateGeneration: 1, expectedActiveGeneration: null });

    const [first, second] = await Promise.all([
      call(target, liveEnv(), "POST", path(viewId, "switch"), { body: JSON.stringify({ candidateGeneration: 1, expectedActiveGeneration: 0 }) }),
      call(target, liveEnv(), "POST", path(viewId, "switch"), { body: JSON.stringify({ candidateGeneration: 2, expectedActiveGeneration: 0 }) }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = first.status === 200 ? 1 : 2;
    const loser = winner === 1 ? 2 : 1;
    expect(recording.mock.calls.slice(-2).map((entry) => entry[0].expectedActiveGeneration)).toEqual([0, 0]);
    const rows = await instances(service, viewId);
    expect(rows.filter((row) => row.status === "active")).toEqual([{ generation: winner, status: "active", definition_version: 1 }]);
    expect(rows.find((row) => row.generation === 0)?.status).toBe("retired");
    expect(rows.find((row) => row.generation === loser)?.status).toBe("candidate");
    expect((await (await views()).readActive(service, viewId))?.generation).toBe(winner);

    for (const [candidateGeneration, expectedActiveGeneration] of [[loser, 0], [0, winner], [99, winner], [loser, null]] as const) {
      const refused = await call(target, liveEnv(), "POST", path(viewId, "switch"), {
        body: JSON.stringify({ candidateGeneration, expectedActiveGeneration }),
      });
      expect(refused.status).toBe(409);
      expect((await body<{ code: string }>(refused)).code).toBe("materialized_view_switch_conflict");
      expect(recording.mock.calls.at(-1)?.[0].expectedActiveGeneration).toBe(expectedActiveGeneration);
    }
    expect((await (await views()).readActive(service, viewId))?.generation).toBe(winner);
  });

  it("returns a committed switch with status:null when the later observation fails", async () => {
    const service = newService("g151n");
    const viewId = viewFor(service);
    await record(service, 1);
    const target = worker("ordinary", service, [materializer(viewId, 1)]);
    expect((await call(target, liveEnv(), "POST", path(viewId, "ensure-started"))).status).toBe(200);
    const prepared = await body<{ result: { candidateGeneration: number } }>(await call(target, liveEnv(), "POST", path(viewId, "prepare")));
    const log: string[] = [];
    const brokenStatus = countingDatabase(d1(), log, (sql) => sql.includes("dcb_projection_statuses"));
    const switched = await call(target, liveEnv({ D1: brokenStatus }), "POST", path(viewId, "switch"), {
      body: JSON.stringify({ candidateGeneration: prepared.result.candidateGeneration, expectedActiveGeneration: 0 }),
    });
    expect(switched.status).toBe(200);
    const switchedBody = await body<{ result: { generation: number }; status: unknown }>(switched);
    expect(switchedBody.result.generation).toBe(prepared.result.candidateGeneration);
    expect(switchedBody.status).toBeNull();
    expect((await (await views()).readActive(service, viewId))?.generation).toBe(prepared.result.candidateGeneration);
    const standalone = await call(target, liveEnv({ D1: brokenStatus }), "GET", path(viewId, "status"));
    expect(standalone.status).toBe(503);
    expect(await standalone.text()).not.toContain("secret");
  });

  it("maps every status DTO member from active instance, target facts, and the raw heartbeat", async () => {
    const service = newService("g151d");
    const viewId = viewFor(service);
    const event = await record(service, 1);
    const target = worker("ordinary", service, [materializer(viewId, 1)]);
    const empty = await call(target, liveEnv(), "GET", path(viewId, "status"));
    expect(empty.status).toBe(200);
    expect(await body(empty)).toEqual({
      serviceId: service,
      viewName: viewId,
      viewVersion: null,
      started: false,
      catchUpInProgress: false,
      isCatchUpActive: false,
      subscriptionActive: false,
      bufferedEventCount: 0,
      currentPosition: null,
      lastReceivedSortableUniqueId: null,
      lastError: null,
      lastCatchUpStartedAt: null,
      lastCatchUpCompletedAt: null,
      lastCatchUpAttemptAt: null,
      consecutiveEmptyBatches: 0,
      lastProgressSortableUniqueId: null,
      needsImmediateCatchUp: false,
      catchUpBatchSkipCount: 0,
      catchUpHalted: false,
      generation: null,
      generationStatus: null,
      rebuildRequired: false,
      isFresh: false,
    });
    expect((await call(target, liveEnv(), "POST", path(viewId, "ensure-started"))).status).toBe(200);
    const raw = await heartbeatFor(service, viewId, 1);
    expect(raw).toBeDefined();
    const instanceBefore = await (await views()).readInstance(service, viewId, 0);
    const log: string[] = [];
    const response = await call(target, liveEnv({ D1: countingDatabase(d1(), log) }), "GET", path(viewId, "status"));
    expect(response.status).toBe(200);
    const dto = await body<Record<string, unknown>>(response);
    expect(Object.keys(dto)).toEqual(DTO_MEMBERS);
    expect(dto).toEqual({
      serviceId: service,
      viewName: viewId,
      viewVersion: 1,
      started: true,
      catchUpInProgress: false,
      isCatchUpActive: false,
      subscriptionActive: false,
      bufferedEventCount: 0,
      currentPosition: event.suid,
      lastReceivedSortableUniqueId: event.suid,
      lastError: null,
      lastCatchUpStartedAt: null,
      lastCatchUpCompletedAt: formatProjectionStatusUtc(raw!.recordedAt),
      lastCatchUpAttemptAt: formatProjectionStatusUtc(raw!.recordedAt),
      consecutiveEmptyBatches: 0,
      lastProgressSortableUniqueId: event.suid,
      needsImmediateCatchUp: false,
      catchUpBatchSkipCount: 0,
      catchUpHalted: false,
      generation: 0,
      generationStatus: "active",
      rebuildRequired: false,
      isFresh: true,
    });
    // GET is observation only: no heartbeat or target writes.
    expect(log.some((sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql))).toBe(false);
    expect(await heartbeatFor(service, viewId, 1)).toEqual(raw);
    expect(await (await views()).readInstance(service, viewId, 0)).toEqual(instanceBefore);
  });

  it("keeps stale, expired, conflicting, faulted, and missing heartbeats from manufacturing activity", async () => {
    const now = Date.now();
    const scenario = async (
      label: string,
      rows: ReadonlyArray<Partial<ProjectionStatusHeartbeat>>,
      findings: (service: string, viewId: string) => Promise<void> = async () => undefined,
    ): Promise<MaterializedViewRuntimeStatus> => {
      const service = newService(`g151${label}`);
      const viewId = viewFor(service);
      const event = await record(service, 1);
      const mv = await views();
      await mv.createActive({ serviceId: service, viewId, definitionVersion: 1, updatedAt: 1, lastSuid: event.suid });
      const id = mvProjectionStatusIdentity(viewId, 1);
      const store = await source();
      for (const row of rows) {
        const heartbeat: ProjectionStatusHeartbeat = {
          serviceId: service,
          projectorName: id.projectorName,
          projectorVersion: id.projectorVersion,
          clusterId: "cloudflare",
          activationId: "scheduled",
          sequence: 1,
          appliedEventCount: 0,
          lastAppliedSortableUniqueId: null,
          lastTraversedSortableUniqueId: null,
          recordedAt: now,
          phase: "active",
          leaseExpiresAt: now + 120_000,
          isFaulted: false,
          faultMessage: null,
          switchKind: null,
          switchReason: null,
          switchedAt: null,
          ...row,
        };
        expect((await store.upsertProjectionStatusHeartbeat(heartbeat, 0)).committed).toBe(true);
      }
      await findings(service, viewId);
      const response = await call(worker("ordinary", service, [materializer(viewId, 1)]), liveEnv(), "GET", path(viewId, "status"));
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).not.toContain("secret");
      return JSON.parse(text) as MaterializedViewRuntimeStatus;
    };

    const missing = await scenario("h0", []);
    expect(missing).toMatchObject({ started: true, isFresh: false, catchUpInProgress: false, needsImmediateCatchUp: false, lastCatchUpAttemptAt: null, lastReceivedSortableUniqueId: null, lastError: null, catchUpHalted: false });
    expect(missing.currentPosition).not.toBeNull();

    const catchingUp = await scenario("h1", [{ phase: "catchingUp" }]);
    expect(catchingUp).toMatchObject({ isFresh: true, catchUpInProgress: true, isCatchUpActive: true, needsImmediateCatchUp: true });

    const behind = await scenario("h2", [{ phase: "active" }]);
    expect(behind).toMatchObject({ isFresh: true, catchUpInProgress: false, needsImmediateCatchUp: true });

    const millis = Date.UTC(2026, 0, 2, 3, 4, 5, 120);
    const stale = await scenario("h3", [{ phase: "catchingUp", recordedAt: millis, leaseExpiresAt: millis + 120_000 }]);
    expect(stale).toMatchObject({ isFresh: false, catchUpInProgress: false, needsImmediateCatchUp: false, lastCatchUpAttemptAt: "2026-01-02T03:04:05.12+00:00", lastCatchUpCompletedAt: "2026-01-02T03:04:05.12+00:00" });

    const expired = await scenario("h4", [{ phase: "catchingUp", leaseExpiresAt: now - 1 }]);
    expect(expired).toMatchObject({ isFresh: false, catchUpInProgress: false, needsImmediateCatchUp: false });

    const conflicting = await scenario("h5", [{ phase: "catchingUp" }, { phase: "catchingUp", clusterId: "other-cluster", activationId: "other" }]);
    expect(conflicting).toMatchObject({ isFresh: false, catchUpInProgress: false, isCatchUpActive: false, needsImmediateCatchUp: false });

    const faulted = await scenario("h6", [{ phase: "faulted", isFaulted: true, faultMessage: "secret SQL detail" }]);
    expect(faulted).toMatchObject({ lastError: PROJECTION_STATUS_FAULT_MESSAGE, catchUpHalted: true, needsImmediateCatchUp: false, catchUpInProgress: false });

    const checkpoint = await scenario("h7", [], async (service, viewId) => {
      await mvDatabase().prepare(
        "INSERT INTO mv_checkpoint_ahead_findings (service_id, view_id, generation, checkpoint_suid, store_max_suid, observed_at) VALUES (?, ?, 0, ?, '', 1)",
      ).bind(service, viewId, g32Suid(9)).run();
    });
    expect(checkpoint).toMatchObject({ catchUpHalted: true, rebuildRequired: false });

    const rebuild = await scenario("h8", [], async (service, viewId) => {
      await mvDatabase().prepare(
        "INSERT INTO mv_unsafe_arrivals (service_id, view_id, generation, rebuild_required) VALUES (?, ?, 0, 1)",
      ).bind(service, viewId).run();
    });
    expect(rebuild).toMatchObject({ catchUpHalted: false, rebuildRequired: true });

    const poison = await scenario("h9", [], async (service, viewId) => {
      await mvDatabase().prepare(
        "INSERT INTO mv_wait_target_poison (service_id, view_id, generation, definition_version, event_id, suid, classification, observed_at) VALUES (?, ?, 0, 1, ?, ?, 'UNSAFE_APPLY_RETRY', 1)",
      ).bind(service, viewId, g32EventId("poison"), g32Suid(8)).run();
    });
    expect(poison.catchUpHalted).toBe(true);

    const quarantine = await scenario("hq", [], async (service, viewId) => {
      await (await views()).recordOrderingQuarantine({
        serviceId: service,
        viewId,
        generation: 0,
        checkpointSuid: g32Suid(1),
        lateSuid: g32Suid(0),
        eventId: g32EventId("late"),
        classification: "ORDER_VIOLATION",
        observedAt: 1,
      });
    });
    expect(quarantine.catchUpHalted).toBe(true);
  });

  it("answers received with one source and one target point read and fails closed on every hard gate", async () => {
    const scenario = async (
      label: string,
      setup: (input: { service: string; viewId: string; eventId: string; suid: string; mv: D1MaterializedViewStore }) => Promise<void>,
      query?: (suid: string) => string,
    ): Promise<{ status: number; text: string; sourceReads: number; targetReads: number; other: string[] }> => {
      const service = newService(`g151${label}`);
      const viewId = viewFor(service);
      const event = await record(service, 5);
      const mv = await views();
      await setup({ service, viewId, eventId: event.eventId, suid: event.suid, mv });
      const sourceLog: string[] = [];
      const targetLog: string[] = [];
      const response = await call(
        worker("ordinary", service, [materializer(viewId, 1)]),
        liveEnv({ D1: countingDatabase(d1(), sourceLog), D1_MV: countingDatabase(mvDatabase(), targetLog) }),
        "GET",
        path(viewId, "received", `?sortableUniqueId=${(query ?? ((suid) => suid))(event.suid)}`),
      );
      const sourceReads = sourceLog.filter((sql) => sql.includes("WITH target AS")).length;
      const targetReads = targetLog.filter((sql) => sql.includes("mv_wait_receipts")).length;
      const other = [
        ...sourceLog.filter((sql) => !sql.includes("WITH target AS") && !sql.includes("migration_binding")),
        ...targetLog.filter((sql) => !sql.includes("mv_wait_receipts") && !/^SELECT 1 FROM mv_/.test(sql)),
      ];
      return { status: response.status, text: await response.text(), sourceReads, targetReads, other };
    };
    const head = async ({ service, viewId, suid, mv }: { service: string; viewId: string; suid: string; mv: D1MaterializedViewStore }) => {
      await mv.createActive({ serviceId: service, viewId, definitionVersion: 1, updatedAt: 1, lastSuid: suid });
    };
    const receipt = (generation: number, version: number, eventOverride?: string) => async (input: { service: string; viewId: string; eventId: string; suid: string; mv: D1MaterializedViewStore }) => {
      await input.mv.createActive({ serviceId: input.service, viewId: input.viewId, definitionVersion: 1, updatedAt: 1 });
      if (generation !== 0) await input.mv.createCandidate({ serviceId: input.service, viewId: input.viewId, generation, definitionVersion: version, updatedAt: 1 });
      await mvDatabase().prepare(
        "INSERT INTO mv_wait_receipts (service_id, view_id, generation, definition_version, event_id, suid, observed_at) VALUES (?, ?, ?, ?, ?, ?, 1)",
      ).bind(input.service, input.viewId, generation, version, eventOverride ?? input.eventId, input.suid).run();
    };

    const success = await scenario("w1", head);
    expect(success).toMatchObject({ status: 200, text: "true", sourceReads: 1, targetReads: 1, other: [] });
    expect(await scenario("w2", receipt(0, 1))).toMatchObject({ status: 200, text: "true", sourceReads: 1, targetReads: 1 });
    expect(await scenario("w3", receipt(0, 2))).toMatchObject({ status: 200, text: "false" });
    expect(await scenario("w4", receipt(1, 1))).toMatchObject({ status: 200, text: "false" });
    expect(await scenario("w5", receipt(0, 1, g32EventId("foreign")))).toMatchObject({ status: 200, text: "false" });
    expect(await scenario("w6", async () => undefined)).toMatchObject({ status: 200, text: "false", sourceReads: 1, targetReads: 1 });
    expect(await scenario("w7", async ({ service, viewId, mv }) => {
      await mv.createActive({ serviceId: service, viewId, definitionVersion: 1, updatedAt: 1, lastSuid: g32Suid(1) });
    })).toMatchObject({ status: 200, text: "false" });
    // Pending: a higher safe head never proves an unstored target.
    expect(await scenario("w8", async ({ service, viewId, mv }) => {
      await mv.createActive({ serviceId: service, viewId, definitionVersion: 1, updatedAt: 1, lastSuid: g32Suid(9) });
    }, () => g32Suid(7))).toMatchObject({ status: 200, text: "false", sourceReads: 1, targetReads: 1 });

    const incident = await scenario("w9", async (input) => {
      await head(input);
      await d1().prepare(
        "INSERT INTO serialized_dcb_wait_target_incidents (service_id, suid, classification, event_id, observed_at) VALUES (?, ?, 'SUID_COLLISION', NULL, 1)",
      ).bind(input.service, input.suid).run();
    });
    expect(incident).toMatchObject({ status: 503, sourceReads: 1, targetReads: 0 });
    expect(JSON.parse(incident.text)).toEqual({ error: "Materialized-view action is unavailable.", code: "materialized_view_action_unavailable" });

    expect(await scenario("wa", async (input) => {
      await head(input);
      await mvDatabase().prepare(
        "INSERT INTO mv_checkpoint_ahead_findings (service_id, view_id, generation, checkpoint_suid, store_max_suid, observed_at) VALUES (?, ?, 0, ?, '', 1)",
      ).bind(input.service, input.viewId, input.suid).run();
    })).toMatchObject({ status: 503, sourceReads: 1, targetReads: 1 });
    expect(await scenario("wb", async (input) => {
      await head(input);
      await mvDatabase().prepare(
        "INSERT INTO mv_unsafe_arrivals (service_id, view_id, generation, rebuild_required) VALUES (?, ?, 0, 1)",
      ).bind(input.service, input.viewId).run();
    })).toMatchObject({ status: 503, sourceReads: 1, targetReads: 1 });
    expect(await scenario("wc", async (input) => {
      await receipt(0, 1)(input);
      await mvDatabase().prepare(
        "INSERT INTO mv_wait_target_poison (service_id, view_id, generation, definition_version, event_id, suid, classification, observed_at) VALUES (?, ?, 0, 1, ?, ?, 'UNSAFE_APPLY_RETRY', 1)",
      ).bind(input.service, input.viewId, input.eventId, input.suid).run();
    })).toMatchObject({ status: 503, sourceReads: 1, targetReads: 1 });
  });

  it("keeps the scheduled lane default, publishes the operator lane only from actions, and never publishes from GET", async () => {
    const service = newService("g151l");
    const viewId = viewFor(service);
    await record(service, 1);
    const scheduled = new MaterializedViewCatchUpRuntime(await source(), await views());
    await scheduled.build(service, materializer(viewId, 1), Date.now());
    const scheduledRow = await heartbeatFor(service, viewId, 1);
    expect(scheduledRow).toMatchObject({ activationId: "scheduled", sequence: 1 });
    const target = worker("ordinary", service, [materializer(viewId, 1)]);
    const log: string[] = [];
    const counted = liveEnv({ D1: countingDatabase(d1(), log) });
    for (const route of [path(viewId, "status"), path(viewId, "received", `?sortableUniqueId=${g32Suid(1)}`)]) {
      expect((await call(target, counted, "GET", route)).status).toBe(200);
    }
    expect((await call(target, counted, "POST", path(viewId, "ensure-started"))).status).toBe(200);
    expect(log.some((sql) => sql.includes("dcb_projection_statuses") && /INSERT|UPDATE/i.test(sql))).toBe(false);
    expect(await heartbeatFor(service, viewId, 1)).toEqual(scheduledRow);
    await record(service, 2);
    expect((await call(target, liveEnv(), "POST", path(viewId, "refresh"))).status).toBe(200);
    expect(await heartbeatFor(service, viewId, 1)).toMatchObject({ activationId: "operator", sequence: 2, clusterId: "cloudflare" });
    const next = new MaterializedViewCatchUpRuntime(await source(), await views());
    await record(service, 3);
    await next.follow(service, materializer(viewId, 1), Date.now());
    expect(await heartbeatFor(service, viewId, 1)).toMatchObject({ activationId: "scheduled", sequence: 3 });
  });
});
