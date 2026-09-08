import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error Vite raw migration imports.
import migration0001 from "../migrations/mv/0001_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration imports.
import migration0002 from "../migrations/mv/0002_unsafe_window_materialized_views.sql?raw";
// @ts-expect-error Vite raw migration imports.
import migration0003 from "../migrations/mv/0003_checkpoint_ahead_hardening.sql?raw";
// @ts-expect-error Vite raw migration imports.
import migration0004 from "../migrations/mv/0004_unsafe_window_failure_findings.sql?raw";
// @ts-expect-error Vite raw migration imports.
import migration0005 from "../migrations/mv/0005_g31_wait_receipts.sql?raw";
// @ts-expect-error Vite raw migration imports.
import migration0006 from "../migrations/mv/0006_g31_wait_target_poison.sql?raw";
// @ts-expect-error Vite raw migration imports.
import migration0007 from "../migrations/mv/0007_g69_ordering_quarantine.sql?raw";
// @ts-expect-error Vite raw migration imports.
import migration0008 from "../migrations/mv/0008_g69_rebuild_verification.sql?raw";
// @ts-expect-error Vite raw migration imports.
import migration0009 from "../migrations/mv/0009_g69_rebuild_proof.sql?raw";
import { defineRowMaterializer } from "@sekiban/dcb-core";
import { D1MaterializedViewStore } from "../packages/dcb-runtime/src/d1-mv";
import type { MaterializedViewQueryPort } from "../packages/dcb-runtime/src/query/ProjectionQueryStore";
import { handleSerializedQuery } from "../packages/dcb-runtime/src/http/SerializedQueryWorker";
import { TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/http/testServiceId";
import { TEST_TAG_STATE_PROJECTOR } from "../packages/dcb-runtime/src/projection/ProjectorRegistry";
import { g32Suid } from "./helpers/g32-fixtures";

interface ReservationFixture {
  readonly eventId: string;
  readonly suid: string;
  readonly reservationId: string;
}

const VIEW_ID = TEST_TAG_STATE_PROJECTOR;
const MATERIALIZER = defineRowMaterializer<ReservationFixture>({
  id: VIEW_ID,
  version: 1,
  materialize: (event) => ({
    rowUpserts: [{
      rowKey: event.reservationId,
      value: {
        eventId: event.eventId,
        reservationId: event.reservationId,
        status: "reserved",
      },
      sourceSuid: event.suid,
    }],
  }),
});

function database(): D1Database {
  const binding = (env as unknown as { D1_MV?: D1Database }).D1_MV;
  if (binding === undefined) throw new Error("D1_MV binding is required");
  return binding;
}

function migrationStatements(sql: string): D1PreparedStatement[] {
  return sql.replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => database().prepare(statement));
}

function queryRequest(serviceId: string, queryParams: Record<string, unknown>): Request {
  return new Request("https://query.test/api/sekiban/serialized/list-query", {
    method: "POST",
    headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: serviceId },
    body: JSON.stringify({
      queryType: "GetTestListQuery",
      queryParamsJson: JSON.stringify(queryParams),
    }),
  });
}

function fixture(eventId: string, ordinal: string): ReservationFixture {
  return {
    eventId,
    suid: g32Suid(ordinal),
    reservationId: `reservation-${eventId}`,
  };
}

describe("SDT-G55 D1 list read visibility", () => {
  beforeAll(async () => {
    await database().batch([
      migration0001,
      migration0002,
      migration0003,
      migration0004,
      migration0005,
      migration0006,
      migration0007,
      migration0008,
      migration0009,
    ].flatMap((migration) => migrationStatements(migration as string)));
  });

  it("keeps the default list safe, opts into the unsafe overlay, and reports only rows reflected in each page head", async () => {
    const serviceId = `g55-read-${crypto.randomUUID()}`;
    const safe = fixture("safe", "g55-safe");
    const unsafe = fixture("unsafe", "g55-unsafe");
    const mv = new D1MaterializedViewStore(database());
    await mv.initialize();
    await mv.createActive({ serviceId, viewId: VIEW_ID, definitionVersion: MATERIALIZER.version, updatedAt: 1 });
    await mv.applyMutationsAndAdvanceCheckpoint({
      serviceId,
      viewId: VIEW_ID,
      generation: 0,
      expectedLastSuid: null,
      lastSuid: safe.suid,
      definitionVersion: MATERIALIZER.version,
      updatedAt: 2,
      mutations: MATERIALIZER.plan(safe),
    });
    await mv.unsafeWindow().apply({
      serviceId,
      viewId: VIEW_ID,
      generation: 0,
      eventId: unsafe.eventId,
      suid: unsafe.suid,
      safeHead: safe.suid,
      updatedAt: 3,
      recordArrival: true,
      targetSuid: unsafe.suid,
      mutations: MATERIALIZER.plan(unsafe),
    });
    const receiptsBefore = await database().prepare(
      "SELECT COUNT(*) AS count FROM mv_unsafe_receipts WHERE service_id = ? AND view_id = ?",
    ).bind(serviceId, VIEW_ID).first<{ count: number }>();

    const defaultResponse = await handleSerializedQuery(queryRequest(serviceId, { PageNumber: 1, PageSize: 20 }), {}, {
      queryBacking: "d1-mv",
      materializedViewQueryPort: mv,
    });
    expect(defaultResponse.status).toBe(200);
    expect(await defaultResponse.json()).toEqual({
      itemsJson: JSON.stringify([{ eventId: safe.eventId, reservationId: safe.reservationId, status: "reserved" }]),
      totalCount: 1,
      totalPages: 1,
      currentPage: 1,
      pageSize: 20,
      readHead: safe.suid,
    });

    const unsafeFirstResponse = await handleSerializedQuery(queryRequest(serviceId, {
      PageNumber: 1,
      PageSize: 1,
      NewestFirst: true,
      consistency: "unsafe",
    }), {}, { queryBacking: "d1-mv", materializedViewQueryPort: mv });
    expect(unsafeFirstResponse.status).toBe(200);
    expect(await unsafeFirstResponse.json()).toEqual({
      itemsJson: JSON.stringify([{ eventId: unsafe.eventId, reservationId: unsafe.reservationId, status: "reserved" }]),
      totalCount: 2,
      totalPages: 2,
      currentPage: 1,
      pageSize: 1,
      readHead: unsafe.suid,
    });

    const unsafeSecondResponse = await handleSerializedQuery(queryRequest(serviceId, {
      PageNumber: 2,
      PageSize: 1,
      NewestFirst: true,
      consistency: "unsafe",
    }), {}, { queryBacking: "d1-mv", materializedViewQueryPort: mv });
    expect(unsafeSecondResponse.status).toBe(200);
    expect(await unsafeSecondResponse.json()).toMatchObject({
      itemsJson: JSON.stringify([{ eventId: safe.eventId, reservationId: safe.reservationId, status: "reserved" }]),
      totalCount: 2,
      totalPages: 2,
      currentPage: 2,
      pageSize: 1,
      readHead: safe.suid,
    });

    const receiptsAfter = await database().prepare(
      "SELECT COUNT(*) AS count FROM mv_unsafe_receipts WHERE service_id = ? AND view_id = ?",
    ).bind(serviceId, VIEW_ID).first<{ count: number }>();
    expect(receiptsAfter).toEqual(receiptsBefore);
  });

  it("maps a fake D1 active watermark into the additive list readHead without changing existing list bytes", async () => {
    const serviceId = `g55-fake-${crypto.randomUUID()}`;
    const safe = fixture("fake-safe", "g55-fake-safe");
    const calls: unknown[] = [];
    const port = {
      initialize: async () => undefined,
      queryRows: async () => [],
      readListPage: async (_service: string, _view: string, options: unknown) => {
        calls.push(options);
        return {
          rows: [{
            serviceId,
            viewId: VIEW_ID,
            generation: 0,
            rowKey: safe.reservationId,
            value: { eventId: safe.eventId, reservationId: safe.reservationId, status: "reserved" },
            rowVersion: 1,
            sourceSuid: safe.suid,
          }],
          totalCount: 1,
          readHead: safe.suid,
        };
      },
    };
    const response = await handleSerializedQuery(queryRequest(serviceId, { PageNumber: 1, PageSize: 20 }), {}, {
      queryBacking: "d1-mv",
      materializedViewQueryPort: port,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      itemsJson: JSON.stringify([{ eventId: safe.eventId, reservationId: safe.reservationId, status: "reserved" }]),
      totalCount: 1,
      totalPages: 1,
      currentPage: 1,
      pageSize: 20,
      readHead: safe.suid,
    });
    expect(calls).toEqual([{ limit: 20, offset: 0, consistency: "safe" }]);
  });

  it("rejects an unknown list consistency mode before it can select a read lane", async () => {
    const response = await handleSerializedQuery(queryRequest(`g55-invalid-${crypto.randomUUID()}`, {
      PageNumber: 1,
      PageSize: 20,
      consistency: "eventual",
    }), {}, { queryBacking: "d1-mv", materializedViewQueryPort: new D1MaterializedViewStore(database()) });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "validation_error" });
  });

  it("refuses the safe public read for the active generation's ordering quarantine while leaving unsafe explicit", async () => {
    const serviceId = `g69-quarantine-read-${crypto.randomUUID()}`;
    const mv = new D1MaterializedViewStore(database());
    await mv.initialize();
    await mv.createActive({ serviceId, viewId: VIEW_ID, definitionVersion: MATERIALIZER.version, updatedAt: 10 });
    await mv.recordOrderingQuarantine({
      serviceId,
      viewId: VIEW_ID,
      generation: 0,
      checkpointSuid: g32Suid("g69-q-checkpoint"),
      lateSuid: g32Suid("g69-q-late"),
      eventId: "g69-quarantine-event",
      classification: "LATE_LOWER_SUID",
      observedAt: 11,
    });
    const safe = await handleSerializedQuery(queryRequest(serviceId, { PageNumber: 1, PageSize: 20 }), {}, {
      queryBacking: "d1-mv",
      materializedViewQueryPort: mv,
    });
    expect(safe.status).toBe(503);
    await expect(safe.json()).resolves.toEqual({
      error: "The mapped query projection is quarantined for a source-ordering incident; rebuild and promote the affected generation",
      code: "projection_ordering_quarantined",
    });
    const unsafe = await handleSerializedQuery(queryRequest(serviceId, {
      PageNumber: 1,
      PageSize: 20,
      consistency: "unsafe",
    }), {}, {
      queryBacking: "d1-mv",
      materializedViewQueryPort: mv,
    });
    expect(unsafe.status).toBe(200);
  });

  it("fails closed when the active generation changes between a safe page and its response boundary", async () => {
    const serviceId = `g69-generation-page-${crypto.randomUUID()}`;
    const safe = fixture("generation-page", "g69-generation-page-safe");
    const mv = new D1MaterializedViewStore(database());
    await mv.initialize();
    await mv.createActive({ serviceId, viewId: VIEW_ID, definitionVersion: MATERIALIZER.version, updatedAt: 10 });
    await mv.applyMutationsAndAdvanceCheckpoint({
      serviceId,
      viewId: VIEW_ID,
      generation: 0,
      expectedLastSuid: null,
      lastSuid: safe.suid,
      definitionVersion: MATERIALIZER.version,
      updatedAt: 11,
      mutations: {
        rowUpserts: [{ rowKey: safe.reservationId, value: { eventId: safe.eventId, reservationId: safe.reservationId, status: "reserved" }, rowVersion: 1, sourceSuid: safe.suid }],
        rowPatches: [],
        rowDeletes: [],
        indexEntries: [],
        indexDeletes: [],
      },
    });
    await mv.createCandidate({ serviceId, viewId: VIEW_ID, generation: 1, definitionVersion: MATERIALIZER.version, updatedAt: 12, lastSuid: safe.suid });
    let promoted = false;
    const port = new Proxy(mv, {
      get(target, property, receiver) {
        if (property === "readListPage") {
          return async (...args: unknown[]) => {
            const page = await target.readListPage(args[0] as string, args[1] as string, args[2] as never);
            if (!promoted) {
              promoted = true;
              await target.promoteGeneration({ serviceId, viewId: VIEW_ID, candidateGeneration: 1, expectedActiveGeneration: 0, updatedAt: 13 });
            }
            return page;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as MaterializedViewQueryPort;
    const response = await handleSerializedQuery(queryRequest(serviceId, { PageNumber: 1, PageSize: 20 }), {}, {
      queryBacking: "d1-mv",
      materializedViewQueryPort: port,
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "projection_unavailable" });
  });
});
