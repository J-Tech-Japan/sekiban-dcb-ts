import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
// @ts-expect-error Vite raw asset import
import d1Migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";
// @ts-expect-error Vite raw asset import
import mvMigration from "../migrations/mv/0001_materialized_views.sql?raw";
// @ts-expect-error Vite raw asset import
import unsafeMigration from "../migrations/mv/0002_unsafe_window_materialized_views.sql?raw";
// @ts-expect-error Vite raw asset import
import hardeningMigration from "../migrations/mv/0003_checkpoint_ahead_hardening.sql?raw";
// @ts-expect-error Vite raw asset import
import unsafeFailureMigration from "../migrations/mv/0004_unsafe_window_failure_findings.sql?raw";
// @ts-expect-error Vite raw asset import
import g31WaitReceiptMigration from "../migrations/mv/0005_g31_wait_receipts.sql?raw";
// @ts-expect-error Vite raw asset import
import g31WaitPoisonMigration from "../migrations/mv/0006_g31_wait_target_poison.sql?raw";
// @ts-expect-error Vite raw asset import
import orderingQuarantineMigration from "../migrations/mv/0007_g69_ordering_quarantine.sql?raw";
// @ts-expect-error Vite raw asset import
import rebuildVerificationMigration from "../migrations/mv/0008_g69_rebuild_verification.sql?raw";
// @ts-expect-error Vite raw asset import
import rebuildProofMigration from "../migrations/mv/0009_g69_rebuild_proof.sql?raw";

import {
  DomainAuthoringError,
  defineListQuery,
  defineQuery,
  defineQueryView,
  domain,
  event,
  projector,
  tagFamily,
  toRuntimeDomain,
} from "@sekiban/dcb-domain";
import { composeRuntime } from "../packages/dcb-runtime/src/composition";
import { D1MaterializedViewStore } from "../packages/dcb-runtime/src/d1-mv";
import type { Env as WorkerEnv } from "../packages/dcb-runtime/src/index";
import * as runtimeRoot from "../packages/dcb-runtime/src/index";
import { readRawCheckpointCandidates } from "../packages/dcb-runtime/src/query/ProjectionQueryStore";
import {
  INTENDED_PUBLIC_QUERY_FAILURE_MAPPING,
  canonicalizeCheckpointCandidate,
  canonicalizeMaterializedCandidate,
  compareUtf8,
  executePortableQuery,
  type PortableQueryFailure,
  type PortableScanBatch,
} from "../packages/dcb-runtime/src/query/PortableQueryExecutor";
import {
  CosmosEventStore,
  type CosmosDocumentClient,
  type CosmosDocumentRecord,
} from "../packages/dcb-runtime/src/store/CosmosEventStore";
import { D1EventStore } from "../packages/dcb-runtime/src/store/D1EventStore";
import { PostgresEventStore } from "../packages/dcb-runtime/src/store/PostgresEventStore";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";
import { g32Suid } from "./helpers/g32-fixtures";

const TAG_GROUP = "room";
const TAG_PROJECTOR = "board";
const PREFIX = `tag-state:${TAG_GROUP}:`;
const SUFFIX = `:${TAG_PROJECTOR}`;

function statements(sql: string): string[] {
  return sql.replace(/^\s*--.*$/gm, "").split(";").map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}

function d1Database(): D1Database {
  const binding = (env as unknown as { D1?: D1Database }).D1;
  if (binding === undefined) throw new Error("D1 binding is required");
  return binding;
}

function mvDatabase(): D1Database {
  const binding = (env as unknown as { D1_MV?: D1Database }).D1_MV;
  if (binding === undefined) throw new Error("D1_MV binding is required");
  return binding;
}

function postgresUrl(): string {
  const url = (env as unknown as WorkerEnv).POSTGRES_URL;
  if (url === undefined) throw new Error("POSTGRES_URL binding is required");
  return url;
}

beforeAll(async () => {
  const d1 = d1Database();
  await d1.batch(statements(d1Migration as string).map((statement) => d1.prepare(statement)));
  await applyG44D1Migration(d1);
  const mv = mvDatabase();
  const mvSql = [
    mvMigration,
    unsafeMigration,
    hardeningMigration,
    unsafeFailureMigration,
    g31WaitReceiptMigration,
    g31WaitPoisonMigration,
    orderingQuarantineMigration,
    rebuildVerificationMigration,
    rebuildProofMigration,
  ].flatMap((migration) => statements(migration as string));
  await mv.batch(mvSql.map((statement) => mv.prepare(statement)));
});

function failureKeys(value: PortableQueryFailure): string[] {
  return Object.keys(value);
}

function rowCodec() {
  return {
    decode: (value: unknown) => {
      if (typeof value !== "object" || value === null || typeof (value as { label?: unknown }).label !== "string") {
        throw new Error("row");
      }
      return { label: (value as { label: string }).label };
    },
    encode: (value: { label: string }) => value,
  };
}

function listDefinition(sort: (left: string, right: string) => number = () => 0) {
  return {
    kind: "list" as const,
    rowCodec: rowCodec(),
    paramsCodec: { decode: () => ({ tie: "same" }), encode: (value: { tie: string }) => value },
    itemCodec: {
      decode: (value: unknown): { key: string; tie: string } => value as { key: string; tie: string },
      encode: (value: { key: string }) => ({ key: value.key }),
    },
    handleFilter: (projection: { rows: readonly { key: string }[] }) => projection.rows.map((row) => ({
      key: row.key,
      tie: "same",
    })),
    handleSort: (items: readonly { key: string; tie: string }[]) => [...items].sort((left, right) => sort(left.tie, right.tie)),
  };
}

function scalarDefinition() {
  return {
    kind: "scalar" as const,
    rowCodec: rowCodec(),
    paramsCodec: { decode: () => ({}), encode: (value: Record<string, never>) => value },
    resultCodec: {
      decode: (value: unknown): { count: number } => value as { count: number },
      encode: (value: { count: number }) => value,
    },
    handleQuery: (projection: { rows: readonly unknown[] }) => ({ count: projection.rows.length }),
  };
}

function checkpointId(content: string, projector = TAG_PROJECTOR): string {
  return `tag-state:${TAG_GROUP}:${content}:${projector}`;
}

function candidate(content: string, stateJson = JSON.stringify({ label: content }), lastSuid = `suid-${content}`) {
  return { projectionId: checkpointId(content), lastSuid, stateJson };
}

async function executeList(
  scan: (limit: number) => Promise<PortableScanBatch>,
  page: { pageNumber: number; pageSize: number; descending: boolean },
  maximum = 10,
) {
  return executePortableQuery({
    definition: listDefinition(),
    params: {},
    maximum,
    page,
    scan,
    canonicalize: (value) => canonicalizeCheckpointCandidate(value, rowCodec().decode, {
      tagGroup: TAG_GROUP,
      tagProjector: TAG_PROJECTOR,
    }),
  });
}

const PAGE = { pageNumber: 1, pageSize: 2, descending: false } as const;

describe("dormant portable query executor", () => {
  it("keeps both execution refusals and leaves the executor off the runtime root", () => {
    const order = tagFamily("order");
    const placed = event("OrderPlaced", z.object({ orderId: z.string() }), {
      tags: (payload) => [order.of(payload.orderId)],
    });
    const orderProjector = projector({
      id: "order-projector",
      tag: order,
      events: [placed],
      initialState: { kind: "placed" as const },
      handlers: { OrderPlaced: () => ({ kind: "placed" as const }) },
    });
    const orders = defineQueryView({ id: "orders", version: 1, row: z.strictObject({ orderId: z.string() }) });
    const authored = defineQuery({
      id: "reservation-count",
      version: 1,
      source: orders,
      params: z.strictObject({ roomId: z.string() }),
      result: z.strictObject({ count: z.number() }),
      handleQuery: () => ({ count: 1 }),
    });
    const authoredDomain = domain({
      events: [placed],
      projectors: [orderProjector],
      views: [{ id: "orders", source: orderProjector.id }],
      queries: [authored],
    });
    expect(() => toRuntimeDomain(authoredDomain)).toThrow(DomainAuthoringError);
    try {
      toRuntimeDomain(authoredDomain);
    } catch (error) {
      expect(error).toMatchObject({
        code: "QUERY_EXECUTION_UNAVAILABLE",
        message: "Typed query execution is not available in this runtime bridge.",
      });
    }
    expect(() => composeRuntime(
      { queries: [{ ...authored, queryType: "reservation-count", tagGroup: TAG_GROUP, tagProjector: TAG_PROJECTOR, endpoint: "query" }] },
      {},
    )).toThrow(Error);
    try {
      composeRuntime(
        { queries: [{ ...authored, queryType: "reservation-count", tagGroup: TAG_GROUP, tagProjector: TAG_PROJECTOR, endpoint: "query" }] },
        {},
      );
    } catch (error) {
      expect(error).toMatchObject({
        name: "TypedQueryExecutionUnavailableError",
        code: "QUERY_EXECUTION_UNAVAILABLE",
        message: "Typed query execution is not available in runtime composition.",
      });
    }
    expect("executePortableQuery" in runtimeRoot).toBe(false);
    expect(INTENDED_PUBLIC_QUERY_FAILURE_MAPPING).toEqual({
      "projection-unavailable": "projection_unavailable",
      "row-invalid": "query_row_invalid",
    });
    const exported = Object.values(runtimeRoot) as readonly unknown[];
    expect(exported.includes("projection_unavailable")).toBe(false);
    expect(exported.includes("query_row_invalid")).toBe(false);
  });

  it("orders by UTF-8 bytes, then source id, and rejects a duplicate key", async () => {
    expect(compareUtf8("\uFFFF", "\u{10000}")).toBeLessThan(0);
    expect("\uFFFF" < "\u{10000}").toBe(false);
    const diverged = await executeList(async () => ({
      candidates: [candidate("\u{10000}"), candidate("\uFFFF"), candidate("a")],
    }), { pageNumber: 1, pageSize: 3, descending: false });
    expect(diverged).toMatchObject({
      ok: true,
      items: [{ key: "a" }, { key: "\uFFFF" }, { key: "\u{10000}" }],
    });
    const secondary = await executeList(async () => ({
      candidates: [
        { projectionId: checkpointId("\uD800"), lastSuid: "m", stateJson: JSON.stringify({ label: "first" }) },
        { projectionId: checkpointId("\uD801"), lastSuid: "a", stateJson: JSON.stringify({ label: "second" }) },
      ],
    }), { pageNumber: 1, pageSize: 2, descending: false });
    expect(secondary).toMatchObject({
      ok: true,
      items: [{ key: "\uD801" }, { key: "\uD800" }],
    });
    const duplicate = await executeList(async () => ({
      candidates: [candidate("a", JSON.stringify({ label: "a" }), "suid-1"), candidate("a", JSON.stringify({ label: "a" }), "suid-2")],
    }), PAGE);
    expect(duplicate).toEqual({ ok: false, kind: "row-invalid", message: "Query row is invalid." });
    expect(duplicate).not.toHaveProperty("items");
  });

  it("pages after the stable sort and reverses only the chosen direction", async () => {
    const candidates = [candidate("n"), candidate("é"), candidate("a")];
    const scan = async () => ({ candidates });
    expect(await executeList(scan, { pageNumber: 1, pageSize: 2, descending: false })).toMatchObject({
      ok: true,
      items: [{ key: "a" }, { key: "n" }],
      totalCount: 3,
      totalPages: 2,
      currentPage: 1,
      pageSize: 2,
    });
    expect(await executeList(scan, { pageNumber: 2, pageSize: 2, descending: false })).toMatchObject({
      ok: true,
      items: [{ key: "é" }],
      totalCount: 3,
      currentPage: 2,
    });
    expect(await executeList(scan, { pageNumber: 1, pageSize: 2, descending: true })).toMatchObject({
      ok: true,
      items: [{ key: "é" }, { key: "n" }],
    });
    expect(await executeList(scan, { pageNumber: 2, pageSize: 2, descending: true })).toMatchObject({
      ok: true,
      items: [{ key: "a" }],
    });
    const scalar = await executePortableQuery({
      definition: scalarDefinition(),
      params: {},
      maximum: 10,
      scan,
      canonicalize: (value) => canonicalizeCheckpointCandidate(value, rowCodec().decode, {
        tagGroup: TAG_GROUP,
        tagProjector: TAG_PROJECTOR,
      }),
    });
    expect(scalar).toEqual({ ok: true, kind: "scalar", result: { count: 3 } });
    const empty = await executeList(async () => ({ candidates: [] }), { pageNumber: 1, pageSize: 2, descending: false });
    expect(empty).toMatchObject({ ok: true, items: [], totalCount: 0, totalPages: 0 });
  });

  it("runs params, admission, scan, canonicalization, handlers, and encode in order", async () => {
    const phases: string[] = [];
    const result = await executePortableQuery({
      definition: {
        ...listDefinition(),
        paramsCodec: {
          decode: () => {
            phases.push("params");
            return { tie: "same" };
          },
          encode: (value: { tie: string }) => value,
        },
        itemCodec: {
          decode: (value: unknown): { key: string; tie: string } => value as { key: string; tie: string },
          encode: (value: { key: string }) => {
            phases.push("encode");
            return { key: value.key };
          },
        },
        handleFilter: (projection: { rows: readonly { key: string }[] }) => {
          phases.push("filter");
          return projection.rows.map((row) => ({ key: row.key, tie: "same" }));
        },
        handleSort: (items: readonly { key: string; tie: string }[]) => {
          phases.push("sort");
          return [...items];
        },
      },
      params: {},
      maximum: 10,
      page: { pageNumber: 1, pageSize: 2, descending: false },
      admit: () => {
        phases.push("admit");
      },
      scan: async (limit) => {
        phases.push(`scan:${limit}`);
        return { candidates: [candidate("n"), candidate("é"), candidate("a")], readHead: "head" };
      },
      canonicalize: (value) => {
        phases.push("canonicalize");
        return canonicalizeCheckpointCandidate(value, rowCodec().decode, {
          tagGroup: TAG_GROUP,
          tagProjector: TAG_PROJECTOR,
        });
      },
    });
    expect(phases).toEqual([
      "params",
      "admit",
      "scan:11",
      "canonicalize",
      "canonicalize",
      "canonicalize",
      "filter",
      "sort",
      "encode",
      "encode",
    ]);
    expect(result).toMatchObject({ ok: true, items: [{ key: "a" }, { key: "n" }], readHead: "head" });
  });

  it("refuses an overflow before any row codec or handler runs and allows exactly the maximum", async () => {
    let canonicalized = 0;
    let handled = 0;
    const overflow = await executePortableQuery({
      definition: {
        ...scalarDefinition(),
        handleQuery: () => {
          handled += 1;
          return { count: 1 };
        },
      },
      params: {},
      maximum: 2,
      scan: async (limit) => {
        expect(limit).toBe(3);
        return { candidates: [candidate("a"), candidate("n"), candidate("é")] };
      },
      canonicalize: (value) => {
        canonicalized += 1;
        return canonicalizeCheckpointCandidate(value, rowCodec().decode, {
          tagGroup: TAG_GROUP,
          tagProjector: TAG_PROJECTOR,
        });
      },
    });
    expect(overflow).toEqual({ ok: false, kind: "scan-limit-exceeded", message: "Query scan limit was exceeded." });
    expect(overflow).not.toHaveProperty("result");
    expect(canonicalized).toBe(0);
    expect(handled).toBe(0);
    const exact = await executePortableQuery({
      definition: scalarDefinition(),
      params: {},
      maximum: 2,
      scan: async (limit) => {
        expect(limit).toBe(3);
        return { candidates: [candidate("n"), candidate("a")] };
      },
      canonicalize: (value) => canonicalizeCheckpointCandidate(value, rowCodec().decode, {
        tagGroup: TAG_GROUP,
        tagProjector: TAG_PROJECTOR,
      }),
    });
    expect(exact).toEqual({ ok: true, kind: "scalar", result: { count: 2 } });
  });

  it("classifies invalid params, pages, handlers, and codecs without a partial result", async () => {
    let scans = 0;
    const scan = async () => {
      scans += 1;
      return { candidates: [] };
    };
    const paramsInvalid = await executePortableQuery({
      definition: {
        ...scalarDefinition(),
        paramsCodec: { decode: () => { throw new Error("secret {token}"); }, encode: (value: Record<string, never>) => value },
      },
      params: {},
      maximum: 10,
      scan,
      canonicalize: () => { throw new Error("nope"); },
    });
    expect(paramsInvalid).toEqual({ ok: false, kind: "params-invalid", message: "Query params are invalid." });
    expect(scans).toBe(0);
    if (paramsInvalid.ok) throw new Error("params must be rejected");
    expect(failureKeys(paramsInvalid)).toEqual(["ok", "kind", "message"]);
    expect(Object.getOwnPropertySymbols(paramsInvalid as object)).toEqual([]);
    expect(paramsInvalid.message).not.toContain("secret");
    expect(paramsInvalid.message).not.toContain("{");
    for (const maximum of [0, 1.5, 10_001, Number.NaN]) {
      const refused = await executePortableQuery({
        definition: scalarDefinition(),
        params: {},
        maximum,
        scan,
        canonicalize: () => { throw new Error("nope"); },
      });
      expect(refused).toMatchObject({ ok: false, kind: "scan-limit-exceeded" });
    }
    expect(scans).toBe(0);
    const page = await executePortableQuery({
      definition: listDefinition(),
      params: {},
      maximum: 10,
      page: { pageNumber: 0, pageSize: 1, descending: false },
      scan,
      canonicalize: () => { throw new Error("nope"); },
    });
    expect(page).toMatchObject({ ok: false, kind: "result-invalid" });
    expect(scans).toBe(0);
    const handler = await executePortableQuery({
      definition: {
        ...scalarDefinition(),
        handleQuery: () => ({ then: () => undefined }) as unknown as { count: number },
      },
      params: {},
      maximum: 10,
      scan,
      canonicalize: (value) => canonicalizeCheckpointCandidate(value, rowCodec().decode, {
        tagGroup: TAG_GROUP,
        tagProjector: TAG_PROJECTOR,
      }),
    });
    expect(handler).toEqual({ ok: false, kind: "handler-failed", message: "Query handler failed." });
    const dropped = await executePortableQuery({
      definition: {
        ...listDefinition(),
        handleSort: (items: readonly { key: string; tie: string }[]) => items.slice(0, -1),
      },
      params: {},
      maximum: 10,
      page: PAGE,
      scan: async () => ({ candidates: [candidate("a"), candidate("n")] }),
      canonicalize: (value) => canonicalizeCheckpointCandidate(value, rowCodec().decode, {
        tagGroup: TAG_GROUP,
        tagProjector: TAG_PROJECTOR,
      }),
    });
    expect(dropped).toMatchObject({ ok: false, kind: "result-invalid" });
    const disguised = await executePortableQuery({
      definition: {
        ...scalarDefinition(),
        resultCodec: {
          decode: (value: unknown): { count: number } => value as { count: number },
          encode: (value: { count: number }) => value,
        },
        handleQuery: () => ({ ok: false, kind: "row-invalid", message: "Query row is invalid." }) as unknown as { count: number },
      },
      params: {},
      maximum: 10,
      scan: async () => ({ candidates: [] }),
      canonicalize: () => { throw new Error("nope"); },
    });
    expect(disguised).toMatchObject({ ok: true, kind: "scalar" });
  });

  it("lets admission errors escape ahead of a corrupt row or a provider failure", async () => {
    const pairs = [
      ["quarantine", new Error("quarantine"), candidate("a", "{")],
      ["wait", new Error("wait"), candidate("a", "{")],
    ] as const;
    for (const [, admission] of pairs) {
      let scans = 0;
      let canonicalized = 0;
      await expect(executePortableQuery({
        definition: scalarDefinition(),
        params: {},
        maximum: 10,
        admit: () => { throw admission; },
        scan: async () => {
          scans += 1;
          return { candidates: [candidate("a", "{")] };
        },
        canonicalize: (value) => {
          canonicalized += 1;
          return canonicalizeCheckpointCandidate(value, rowCodec().decode, {
            tagGroup: TAG_GROUP,
            tagProjector: TAG_PROJECTOR,
          });
        },
      })).rejects.toBe(admission);
      await expect(executePortableQuery({
        definition: scalarDefinition(),
        params: {},
        maximum: 10,
        admit: () => { throw admission; },
        scan: async () => {
          scans += 1;
          throw new Error("connection reset secret {token}");
        },
        canonicalize: () => {
          canonicalized += 1;
          throw new Error("nope");
        },
      })).rejects.toBe(admission);
      expect(scans).toBe(0);
      expect(canonicalized).toBe(0);
    }
  });

  it("separates a corrupt raw candidate from a provider failure", async () => {
    let raw: unknown;
    const corrupt = await executePortableQuery({
      definition: scalarDefinition(),
      params: {},
      maximum: 10,
      scan: async () => {
        const rows = [candidate("a", "{")];
        raw = rows[0]?.stateJson;
        return { candidates: rows };
      },
      canonicalize: (value) => canonicalizeCheckpointCandidate(value, rowCodec().decode, {
        tagGroup: TAG_GROUP,
        tagProjector: TAG_PROJECTOR,
      }),
    });
    expect(raw).toBe("{");
    expect(corrupt).toEqual({ ok: false, kind: "row-invalid", message: "Query row is invalid." });
    if (corrupt.ok) throw new Error("corrupt row must be rejected");
    expect(corrupt.message).not.toContain("{");
    const provider = await executePortableQuery({
      definition: scalarDefinition(),
      params: {},
      maximum: 10,
      scan: async () => { throw new Error("connection reset secret {token}"); },
      canonicalize: () => { throw new Error("{"); },
    });
    expect(provider).toEqual({
      ok: false,
      kind: "projection-unavailable",
      message: "Query projection is unavailable.",
    });
    expect(JSON.stringify(provider)).not.toContain("connection");
    expect(JSON.stringify(provider)).not.toContain("secret");
    if (provider.ok) throw new Error("provider failure must be rejected");
    expect(failureKeys(provider)).toEqual(["ok", "kind", "message"]);
    const materialized = await executePortableQuery({
      definition: scalarDefinition(),
      params: {},
      maximum: 10,
      scan: async () => ({ candidates: [{ rowKey: "a", valueJson: "{", sourceSuid: "suid-a" }] }),
      canonicalize: (value) => canonicalizeMaterializedCandidate(value, rowCodec().decode),
    });
    expect(materialized).toMatchObject({ ok: false, kind: "row-invalid" });
  });

  it("copies Date, Map, and Set inputs per phase and keeps the encoded snapshot", async () => {
    const row = z.strictObject({
      at: z.codec(z.string(), z.date(), {
        decode: (value) => new Date(value),
        encode: (value) => value.toISOString(),
      }),
      tags: z.codec(z.array(z.tuple([z.string(), z.string()])), z.map(z.string(), z.string()), {
        decode: (pairs) => new Map(pairs),
        encode: (value) => [...value.entries()],
      }),
      ids: z.codec(z.array(z.string()), z.set(z.string()), {
        decode: (values) => new Set(values),
        encode: (value) => [...value],
      }),
    });
    const view = defineQueryView({ id: "copied-row", version: 1, row });
    const item = z.strictObject({
      key: z.string(),
      at: row.shape.at,
      tags: row.shape.tags,
      ids: row.shape.ids,
    });
    const seen: string[] = [];
    let retainedAt: Date | undefined;
    let retainedTags: Map<string, string> | undefined;
    let retainedIds: Set<string> | undefined;
    let sortAt: Date | undefined;
    const paramsSchema = z.strictObject({
      at: z.codec(z.string(), z.date(), {
        decode: (value) => new Date(value),
        encode: (value) => value.toISOString(),
      }),
    });
    const query = defineListQuery({
      id: "copied-list",
      version: 1,
      source: view,
      params: paramsSchema,
      item,
      handleFilter: (projection, params) => {
        const value = projection.rows[0]?.value;
        if (value === undefined) return [];
        seen.push(value.at.toISOString());
        seen.push(String(value.tags.size));
        seen.push(String(value.ids.size));
        seen.push(params.at.toISOString());
        retainedAt = value.at;
        retainedTags = value.tags;
        retainedIds = value.ids;
        value.at.setTime(value.at.getTime() + 60_000);
        value.tags.set("added", "x");
        value.ids.add("added");
        params.at.setTime(params.at.getTime() + 60_000);
        return [{ key: projection.rows[0]!.key, at: value.at, tags: value.tags, ids: value.ids }];
      },
      handleSort: (items, params) => {
        const first = items[0];
        if (first === undefined) return items;
        seen.push(first.at.toISOString());
        seen.push(String(first.tags.size));
        seen.push(params.at.toISOString());
        expect(first.at).not.toBe(retainedAt);
        sortAt = first.at;
        first.at.setTime(first.at.getTime() + 60_000);
        return [...items];
      },
    });
    const stored = JSON.stringify({
      at: "2020-01-01T00:00:00.000Z",
      tags: [["k", "v"]],
      ids: ["a"],
    });
    const run = () => executePortableQuery({
      definition: {
        kind: "list",
        rowCodec: view.rowCodec,
        paramsCodec: query.contract.params,
        itemCodec: query.contract.item,
        handleFilter: query.handleFilter,
        handleSort: query.handleSort,
      },
      params: { at: "2020-01-02T00:00:00.000Z" },
      maximum: 10,
      page: { pageNumber: 1, pageSize: 1, descending: false },
      scan: async () => ({ candidates: [candidate("a", stored)] }),
      canonicalize: (value) => canonicalizeCheckpointCandidate(value, view.rowCodec.decode, {
        tagGroup: TAG_GROUP,
        tagProjector: TAG_PROJECTOR,
      }),
    });
    const first = await run();
    expect(seen).toEqual([
      "2020-01-01T00:00:00.000Z",
      "1",
      "1",
      "2020-01-02T00:00:00.000Z",
      "2020-01-01T00:01:00.000Z",
      "2",
      "2020-01-02T00:00:00.000Z",
    ]);
    expect(first).toMatchObject({
      ok: true,
      items: [{
        key: "a",
        at: "2020-01-01T00:02:00.000Z",
        tags: [["k", "v"], ["added", "x"]],
        ids: ["a", "added"],
      }],
    });
    const encoded = JSON.stringify(first);
    retainedAt?.setTime(0);
    retainedTags?.set("later", "y");
    retainedIds?.add("later");
    sortAt?.setTime(0);
    expect(JSON.stringify(first)).toBe(encoded);
    expect(Object.isFrozen(retainedAt)).toBe(false);
    seen.length = 0;
    await run();
    expect(seen[0]).toBe("2020-01-01T00:00:00.000Z");
    expect(seen[1]).toBe("1");
    expect(seen[2]).toBe("1");
  });
});

interface CheckpointStore {
  advanceProjectionCheckpoint(input: {
    serviceId: string;
    projectionId: string;
    expectedLastSuid: string | null;
    lastSuid: string;
    stateJson: string;
    version: number;
    updatedAt: number;
  }): Promise<boolean>;
  scanProjectionCheckpointCandidates(input: {
    serviceId: string;
    projectionIdPrefix: string;
    projectionIdSuffix: string;
    limit: number;
  }): Promise<readonly { projectionId: unknown; lastSuid: unknown; stateJson: unknown }[]>;
}

async function seedCheckpoints(store: CheckpointStore, serviceId: string, contents: readonly string[]): Promise<void> {
  for (const [index, content] of contents.entries()) {
    expect(await store.advanceProjectionCheckpoint({
      serviceId,
      projectionId: checkpointId(content),
      expectedLastSuid: null,
      lastSuid: `suid-${content}`,
      stateJson: JSON.stringify({ label: content }),
      version: 1,
      updatedAt: 50_000 + index,
    })).toBe(true);
  }
  expect(await store.advanceProjectionCheckpoint({
    serviceId,
    projectionId: checkpointId("000", "WRONG"),
    expectedLastSuid: null,
    lastSuid: "suid-decoy",
    stateJson: JSON.stringify({ label: "decoy" }),
    version: 1,
    updatedAt: 49_000,
  })).toBe(true);
  expect(await store.advanceProjectionCheckpoint({
    serviceId,
    projectionId: `tag-state:other:a:${TAG_PROJECTOR}`,
    expectedLastSuid: null,
    lastSuid: "suid-other",
    stateJson: JSON.stringify({ label: "other" }),
    version: 1,
    updatedAt: 49_001,
  })).toBe(true);
}

async function assertCheckpointParity(store: CheckpointStore, serviceId: string): Promise<void> {
  const bounded = await store.scanProjectionCheckpointCandidates({
    serviceId,
    projectionIdPrefix: PREFIX,
    projectionIdSuffix: SUFFIX,
    limit: 3,
  });
  expect(bounded.map((row) => row.projectionId).sort()).toEqual([
    checkpointId("a"),
    checkpointId("n"),
    checkpointId("é"),
  ]);
  expect(bounded.every((row) => typeof row.stateJson === "string" && !String(row.stateJson).includes("decoy"))).toBe(true);
  const page = await executeList(
    async (limit) => {
      expect(limit).toBe(4);
      return {
        candidates: await store.scanProjectionCheckpointCandidates({
          serviceId,
          projectionIdPrefix: PREFIX,
          projectionIdSuffix: SUFFIX,
          limit,
        }),
      };
    },
    { pageNumber: 1, pageSize: 2, descending: false },
    3,
  );
  expect(page).toMatchObject({
    ok: true,
    items: [{ key: "a" }, { key: "n" }],
    totalCount: 3,
    totalPages: 2,
    currentPage: 1,
    pageSize: 2,
  });
  const descending = await executeList(
    (limit) => store.scanProjectionCheckpointCandidates({
      serviceId,
      projectionIdPrefix: PREFIX,
      projectionIdSuffix: SUFFIX,
      limit,
    }).then((candidates) => ({ candidates })),
    { pageNumber: 1, pageSize: 2, descending: true },
    3,
  );
  expect(descending).toMatchObject({ ok: true, items: [{ key: "é" }, { key: "n" }] });
  const scalar = await executePortableQuery({
    definition: scalarDefinition(),
    params: {},
    maximum: 3,
    scan: (limit) => store.scanProjectionCheckpointCandidates({
      serviceId,
      projectionIdPrefix: PREFIX,
      projectionIdSuffix: SUFFIX,
      limit,
    }).then((candidates) => ({ candidates })),
    canonicalize: (value) => canonicalizeCheckpointCandidate(value, rowCodec().decode, {
      tagGroup: TAG_GROUP,
      tagProjector: TAG_PROJECTOR,
    }),
  });
  expect(scalar).toEqual({ ok: true, kind: "scalar", result: { count: 3 } });
}

type JsonObject = Record<string, unknown>;

class CheckpointMemoryClient implements CosmosDocumentClient {
  private readonly rows = new Map<string, Record<string, unknown>>();

  async initialize(): Promise<void> {}

  async read<T extends JsonObject>(container: string, id: string, partitionKey: string): Promise<CosmosDocumentRecord<T> | undefined> {
    const document = this.rows.get(`${container}\u0000${partitionKey}\u0000${id}`);
    return document === undefined ? undefined : { document: document as T, etag: "1" };
  }

  async create<T extends JsonObject>(container: string, document: T, partitionKey: string): Promise<CosmosDocumentRecord<T>> {
    this.rows.set(`${container}\u0000${partitionKey}\u0000${String(document.id)}`, document);
    return { document, etag: "1" };
  }

  async replace<T extends JsonObject>(_container: string, document: T): Promise<boolean> {
    return document === document;
  }

  async query<T extends JsonObject>(
    container: string,
    query: string,
    parameters: readonly { name: string; value: unknown }[],
    partitionKey?: string,
  ): Promise<CosmosDocumentRecord<T>[]> {
    const prefix = parameters.find((parameter) => parameter.name === "@prefix")?.value;
    const suffix = parameters.find((parameter) => parameter.name === "@suffix")?.value;
    const limit = parameters.find((parameter) => parameter.name === "@limit")?.value;
    const matches = [...this.rows.entries()].flatMap(([key, document]) => {
      if (!key.startsWith(`${container}\u0000`)) return [];
      if (partitionKey !== undefined && document.serviceId !== partitionKey) return [];
      if (query.includes("STARTSWITH(c.projectionId")) {
        if (typeof document.projectionId !== "string" || typeof prefix !== "string" || typeof suffix !== "string") return [];
        if (!document.projectionId.startsWith(prefix) || !document.projectionId.endsWith(suffix)) return [];
      }
      return [{ document: document as T, etag: "1" }];
    });
    const ordered = query.includes("ORDER BY c.projectionId")
      ? matches.sort((left, right) => String(left.document.projectionId) < String(right.document.projectionId) ? -1 : 1)
      : matches;
    return typeof limit === "number" ? ordered.slice(0, limit) : ordered;
  }
}

describe("dormant scans on every backing", () => {
  it("encodes the same page from postgres, d1, cosmos, and bounded memory", async () => {
    const postgres = new PostgresEventStore(postgresUrl());
    await postgres.initialize();
    const serviceId = `portable-pg-${crypto.randomUUID()}`;
    await seedCheckpoints(postgres, serviceId, ["é", "n", "a"]);
    await assertCheckpointParity(postgres, serviceId);
    const raw = await postgres.scanProjectionCheckpointCandidates({
      serviceId,
      projectionIdPrefix: PREFIX,
      projectionIdSuffix: SUFFIX,
      limit: 1,
    });
    expect(typeof raw[0]?.stateJson).toBe("string");

    const unavailable = new PostgresEventStore(postgresUrl());
    const providerFailure = await executePortableQuery({
      definition: scalarDefinition(),
      params: {},
      maximum: 10,
      scan: async () => {
        await unavailable.scanProjectionCheckpointCandidates({
          serviceId: "unused",
          projectionIdPrefix: PREFIX,
          projectionIdSuffix: SUFFIX,
          limit: 1,
        });
        return { candidates: [] };
      },
      canonicalize: (value) => canonicalizeCheckpointCandidate(value, rowCodec().decode, {
        tagGroup: TAG_GROUP,
        tagProjector: TAG_PROJECTOR,
      }),
    });
    expect(providerFailure).toMatchObject({ ok: false, kind: "projection-unavailable" });

    const d1 = new D1EventStore(d1Database());
    await d1.initialize();
    const d1Service = `portable-d1-${crypto.randomUUID()}`;
    await seedCheckpoints(d1, d1Service, ["n", "é", "a"]);
    await assertCheckpointParity(d1, d1Service);
    const idleD1 = new D1EventStore(d1Database());
    const d1Failure = await executePortableQuery({
      definition: scalarDefinition(),
      params: {},
      maximum: 10,
      scan: async () => {
        await idleD1.scanProjectionCheckpointCandidates({
          serviceId: d1Service,
          projectionIdPrefix: PREFIX,
          projectionIdSuffix: SUFFIX,
          limit: 1,
        });
        return { candidates: [] };
      },
      canonicalize: () => { throw new Error("nope"); },
    });
    expect(d1Failure).toMatchObject({ ok: false, kind: "projection-unavailable" });

    const cosmos = new CosmosEventStore({ client: new CheckpointMemoryClient() });
    await cosmos.initialize();
    const cosmosService = `portable-cosmos-${crypto.randomUUID()}`;
    await seedCheckpoints(cosmos, cosmosService, ["a", "é", "n"]);
    await assertCheckpointParity(cosmos, cosmosService);

    const checkpoints = new Map<string, { projectionId: string; lastSuid: string; stateJson: string }>();
    const memoryOrder = ["é", "a", "n"];
    for (const content of memoryOrder) {
      const projectionId = checkpointId(content);
      checkpoints.set(projectionId, {
        projectionId,
        lastSuid: `suid-${content}`,
        stateJson: JSON.stringify({ label: content }),
      });
    }
    checkpoints.set(checkpointId("000", "WRONG"), {
      projectionId: checkpointId("000", "WRONG"),
      lastSuid: "suid-decoy",
      stateJson: JSON.stringify({ label: "decoy" }),
    });
    let reads = 0;
    const memory = {
      async listProjectionTags() {
        return ["room:é", "room:n", "room:a", "room:a:extra", "other:a"];
      },
      async readProjectionCheckpoint(_serviceId: string, projectionId: string) {
        reads += 1;
        const found = checkpoints.get(projectionId);
        return found === undefined ? undefined : { ...found, serviceId: "memory", version: 1, updatedAt: 1 };
      },
    };
    const boundedMemory = await readRawCheckpointCandidates(memory, "memory", TAG_GROUP, TAG_PROJECTOR, 2);
    expect(boundedMemory.map((row) => row.projectionId)).toEqual([checkpointId("a"), checkpointId("n")]);
    expect(reads).toBe(2);
    reads = 0;
    const memoryPage = await executeList(
      async (limit) => ({ candidates: await readRawCheckpointCandidates(memory, "memory", TAG_GROUP, TAG_PROJECTOR, limit) }),
      { pageNumber: 1, pageSize: 2, descending: false },
      3,
    );
    expect(memoryPage).toMatchObject({ ok: true, items: [{ key: "a" }, { key: "n" }], totalCount: 3 });
    expect(reads).toBe(3);
  });

  it("reads bounded raw materialized rows and preserves the safe checkpoint head", async () => {
    const database = mvDatabase();
    const store = new D1MaterializedViewStore(database);
    await store.initialize();
    const serviceId = `portable-mv-${crypto.randomUUID()}`;
    const viewId = "portable-view";
    const head = g32Suid("mv-head");
    const newer = g32Suid("mv-newer");
    const [checkpoint, unsafeSuid] = head < newer ? [head, newer] : [newer, head];
    const created = await store.createActive({
      serviceId,
      viewId,
      definitionVersion: 1,
      updatedAt: 1_000,
      lastSuid: checkpoint,
    });
    const inserted = ["n", "a", "é"];
    for (const key of inserted) {
      await database.prepare(
        `INSERT INTO mv_rows (service_id, view_id, generation, row_key, value_json, row_version, source_suid)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      ).bind(serviceId, viewId, created.generation, key, JSON.stringify({ label: key }), checkpoint).run();
    }
    const corruptView = `portable-corrupt-${crypto.randomUUID()}`;
    const corruptInstance = await store.createActive({
      serviceId,
      viewId: corruptView,
      definitionVersion: 1,
      updatedAt: 1_000,
      lastSuid: checkpoint,
    });
    await database.prepare(
      `INSERT INTO mv_rows (service_id, view_id, generation, row_key, value_json, row_version, source_suid)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    ).bind(serviceId, corruptView, corruptInstance.generation, "broken", "{", checkpoint).run();
    const bounded = await store.scanRows(serviceId, viewId, { consistency: "safe", limit: 2 });
    expect(bounded.rows.map((row) => row.rowKey)).toEqual(["a", "n"]);
    expect(bounded.readHead).toBe(checkpoint);
    expect(bounded.rows.every((row) => typeof row.valueJson === "string")).toBe(true);
    const emptyView = `portable-empty-${crypto.randomUUID()}`;
    await store.createActive({
      serviceId,
      viewId: emptyView,
      definitionVersion: 1,
      updatedAt: 1_000,
      lastSuid: checkpoint,
    });
    const empty = await store.scanRows(serviceId, emptyView, { consistency: "safe", limit: 5 });
    expect(empty).toEqual({ rows: [], readHead: checkpoint });
    await expect(store.scanRows(serviceId, viewId, { consistency: "safe", generation: 99, limit: 1 }))
      .rejects.toMatchObject({ code: "MV_INSTANCE_MISSING" });
    const missing = await executePortableQuery({
      definition: scalarDefinition(),
      params: {},
      maximum: 10,
      scan: async () => {
        await store.scanRows(serviceId, viewId, { consistency: "safe", generation: 99, limit: 11 });
        return { candidates: [] };
      },
      canonicalize: (value) => canonicalizeMaterializedCandidate(value, rowCodec().decode),
    });
    expect(missing).toMatchObject({ ok: false, kind: "projection-unavailable" });
    const corrupt = await executePortableQuery({
      definition: scalarDefinition(),
      params: {},
      maximum: 1,
      scan: async (limit) => {
        const batch = await store.scanRows(serviceId, corruptView, { consistency: "safe", limit });
        expect(batch.rows[0]?.valueJson).toBe("{");
        return { candidates: batch.rows, readHead: batch.readHead };
      },
      canonicalize: (value) => canonicalizeMaterializedCandidate(value, rowCodec().decode),
    });
    expect(corrupt).toMatchObject({ ok: false, kind: "row-invalid" });
    await database.prepare(
      `INSERT INTO mv_unsafe_rows (service_id, view_id, generation, row_key, value_json, row_version, source_suid, tombstone)
       VALUES (?, ?, ?, ?, ?, 1, ?, 0)`,
    ).bind(serviceId, viewId, created.generation, "z", JSON.stringify({ label: "z" }), unsafeSuid).run();
    const unsafe = await store.scanRows(serviceId, viewId, { consistency: "unsafe", limit: 10 });
    expect(unsafe.rows.some((row) => row.rowKey === "z" && row.sourceSuid === unsafeSuid)).toBe(true);
    expect(unsafe.readHead).toBe(unsafeSuid);
    const page = await executePortableQuery({
      definition: listDefinition(),
      params: {},
      maximum: 10,
      page: { pageNumber: 1, pageSize: 2, descending: false },
      scan: async (limit) => {
        const batch = await store.scanRows(serviceId, viewId, { consistency: "safe", limit });
        return { candidates: batch.rows, readHead: batch.readHead };
      },
      canonicalize: (value) => canonicalizeMaterializedCandidate(value, rowCodec().decode),
    });
    expect(page).toMatchObject({
      ok: true,
      items: [{ key: "a" }, { key: "n" }],
      totalCount: 3,
      readHead: checkpoint,
    });
  });
});
