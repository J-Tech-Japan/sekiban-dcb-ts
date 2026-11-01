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
  it("bridges executable queries and leaves the executor off the runtime root", () => {
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
    let calls = 0;
    const authored = defineQuery({
      id: "reservation-count",
      version: 1,
      source: orders,
      params: z.strictObject({ roomId: z.string() }),
      result: z.strictObject({ count: z.number() }),
      handleQuery: () => {
        calls += 1;
        return { count: 1 };
      },
    });
    const authoredDomain = domain({
      events: [placed],
      projectors: [orderProjector],
      views: [{ id: "orders", source: orderProjector.id }],
      queries: [authored],
    });
    const bridged = toRuntimeDomain(authoredDomain);
    expect(bridged.queries).toHaveLength(1);
    expect(bridged.queries[0]).toMatchObject({
      queryType: "reservation-count",
      endpoint: "query",
      tagGroup: "order",
      tagProjector: "order-projector",
      materializedViewId: "orders",
      version: 1,
      enabled: true,
    });
    expect(bridged.queries[0]?.execution.kind).toBe("scalar");
    const composed = composeRuntime(bridged);
    expect(composed.queries.resolve("reservation-count")?.endpoint).toBe("query");
    expect(composed.maxScanRows).toBe(1_000);
    expect(calls).toBe(0);
    expect("executePortableQuery" in runtimeRoot).toBe(false);
    expect(INTENDED_PUBLIC_QUERY_FAILURE_MAPPING).toEqual({
      "params-invalid": "query_params_invalid",
      "scan-limit-exceeded": "query_scan_limit_exceeded",
      "row-invalid": "query_row_invalid",
      "result-invalid": "query_result_invalid",
      "handler-failed": "query_handler_failed",
      "projection-unavailable": "projection_unavailable",
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

  it("runs post-scan admission before overflow and handlers, and skips it when the scan rejects", async () => {
    let canonicalized = 0;
    let handled = 0;
    const quarantine = new Error("post-scan-quarantine");
    await expect(executePortableQuery({
      definition: {
        ...scalarDefinition(),
        handleQuery: () => {
          handled += 1;
          return { count: 1 };
        },
      },
      params: {},
      maximum: 1,
      scan: async () => ({ candidates: [candidate("a", "{"), candidate("b", "{")] }),
      canonicalize: () => {
        canonicalized += 1;
        return canonicalizeCheckpointCandidate(candidate("a"), rowCodec().decode, {
          tagGroup: TAG_GROUP,
          tagProjector: TAG_PROJECTOR,
        });
      },
      afterScanAdmission: () => { throw quarantine; },
    })).rejects.toBe(quarantine);
    expect(canonicalized).toBe(0);
    expect(handled).toBe(0);
    const generation = new Error("post-scan-generation");
    await expect(executePortableQuery({
      definition: scalarDefinition(),
      params: {},
      maximum: 10,
      scan: async () => ({ candidates: [candidate("a")] }),
      canonicalize: () => {
        canonicalized += 1;
        throw new Error("row");
      },
      afterScanAdmission: () => { throw generation; },
    })).rejects.toBe(generation);
    expect(canonicalized).toBe(0);
    let afterScan = 0;
    const provider = await executePortableQuery({
      definition: scalarDefinition(),
      params: {},
      maximum: 10,
      scan: async () => { throw new Error("connection reset secret"); },
      canonicalize: () => { throw new Error("row"); },
      afterScanAdmission: () => { afterScan += 1; },
    });
    expect(provider).toEqual({ ok: false, kind: "projection-unavailable", message: "Query projection is unavailable." });
    expect(afterScan).toBe(0);
    const overflow = await executePortableQuery({
      definition: scalarDefinition(),
      params: {},
      maximum: 1,
      scan: async () => ({ candidates: [candidate("a"), candidate("b")] }),
      canonicalize: () => {
        canonicalized += 1;
        throw new Error("row");
      },
      afterScanAdmission: () => { afterScan += 1; },
    });
    expect(overflow).toEqual({ ok: false, kind: "scan-limit-exceeded", message: "Query scan limit was exceeded." });
    expect(afterScan).toBe(1);
    expect(canonicalized).toBe(0);
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

  it("rejects subclasses, accessors, and symbol keys before cloning", async () => {
    defineQueryView({ id: "admit-date", version: 1, row: z.date() });
    defineQueryView({ id: "admit-map", version: 1, row: z.map(z.string(), z.string()) });
    defineQueryView({ id: "admit-set", version: 1, row: z.set(z.string()) });
    defineQueryView({ id: "admit-array", version: 1, row: z.array(z.string()) });
    defineQueryView({ id: "admit-object", version: 1, row: z.strictObject({ name: z.string() }) });
    class MarkedDate extends Date {}
    class MarkedMap extends Map<string, string> {}
    class MarkedSet extends Set<string> {}
    class MarkedArray extends Array<string> {}
    const accessorDate = new Date(0);
    Object.defineProperty(accessorDate, "secret", { get: () => 1 });
    const symbolDate = new Date(0);
    Object.defineProperty(symbolDate, Symbol.for("mark"), { value: 1 });
    const extraDate = new Date(0);
    Object.defineProperty(extraDate, "extra", { value: 1 });
    const accessorArray = ["a"];
    Object.defineProperty(accessorArray, 0, { get: () => "a" });
    const symbolArray = ["a"];
    Object.defineProperty(symbolArray, Symbol.for("mark"), { value: 1 });
    const accessorObject = {};
    Object.defineProperty(accessorObject, "name", { get: () => "a" });
    const symbolObject = { name: "a" };
    Object.defineProperty(symbolObject, Symbol.for("mark"), { value: 1 });
    const rowCases = [
      ["date subclass", () => new MarkedDate(0)],
      ["date accessor", () => accessorDate],
      ["date symbol", () => symbolDate],
      ["date own property", () => extraDate],
      ["map subclass", () => new MarkedMap([["a", "b"]])],
      ["set subclass", () => new MarkedSet(["a"])],
      ["array subclass", () => new MarkedArray("a")],
      ["array accessor", () => accessorArray],
      ["array symbol", () => symbolArray],
      ["object accessor", () => accessorObject],
      ["object symbol", () => symbolObject],
    ] as const;
    for (const [name, produce] of rowCases) {
      let calls = 0;
      const decode = () => produce();
      const result = await executePortableQuery({
        definition: {
          kind: "scalar",
          rowCodec: { decode, encode: () => ({ count: 0 }) },
          paramsCodec: { decode: () => ({}), encode: (value: Record<string, never>) => value },
          resultCodec: {
            decode: (value: unknown): { count: number } => value as { count: number },
            encode: (value: { count: number }) => value,
          },
          handleQuery: () => {
            calls += 1;
            return { count: 1 };
          },
        },
        params: {},
        maximum: 10,
        scan: async () => ({ candidates: [candidate("a", "null")] }),
        canonicalize: (value) => canonicalizeCheckpointCandidate(value, decode, {
          tagGroup: TAG_GROUP,
          tagProjector: TAG_PROJECTOR,
        }),
      });
      expect(result, name).toEqual({ ok: false, kind: "row-invalid", message: "Query row is invalid." });
      expect(calls, name).toBe(0);
      const returned = await executePortableQuery({
        definition: {
          kind: "scalar",
          rowCodec: rowCodec(),
          paramsCodec: { decode: () => ({}), encode: (value: Record<string, never>) => value },
          resultCodec: {
            decode: (value: unknown): unknown => value,
            encode: (value: unknown): { count: number } => ({ count: value === null ? 0 : 0 }),
          },
          handleQuery: () => produce(),
        },
        params: {},
        maximum: 10,
        scan: async () => ({ candidates: [candidate("a", JSON.stringify({ label: "a" }))] }),
        canonicalize: (value) => canonicalizeCheckpointCandidate(value, rowCodec().decode, {
          tagGroup: TAG_GROUP,
          tagProjector: TAG_PROJECTOR,
        }),
      });
      expect(returned, name).toEqual({ ok: false, kind: "result-invalid", message: "Query result is invalid." });
    }
    const dated = defineQueryView({
      id: "exotic-date-codec",
      version: 1,
      row: z.codec(z.unknown(), z.date(), {
        decode: () => new MarkedDate(0),
        encode: (value) => value.toISOString(),
      }),
    });
    const throughCodec = await executePortableQuery({
      definition: {
        kind: "scalar",
        rowCodec: dated.rowCodec,
        paramsCodec: { decode: () => ({}), encode: (value: Record<string, never>) => value },
        resultCodec: {
          decode: (value: unknown): { count: number } => value as { count: number },
          encode: (value: { count: number }) => value,
        },
        handleQuery: () => ({ count: 1 }),
      },
      params: {},
      maximum: 10,
      scan: async () => ({ candidates: [candidate("a", "null")] }),
      canonicalize: (value) => canonicalizeCheckpointCandidate(value, dated.rowCodec.decode, {
        tagGroup: TAG_GROUP,
        tagProjector: TAG_PROJECTOR,
      }),
    });
    expect(throughCodec).toEqual({ ok: false, kind: "row-invalid", message: "Query row is invalid." });
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
        const first = projection.rows[0];
        const second = projection.rows[1];
        if (first === undefined || second === undefined) return [];
        expect(second.value.at).not.toBe(first.value.at);
        const untouched = second.value.at.toISOString();
        seen.push(first.value.at.toISOString());
        seen.push(String(first.value.tags.size));
        seen.push(String(first.value.ids.size));
        seen.push(second.value.at.toISOString());
        seen.push(params.at.toISOString());
        retainedAt = first.value.at;
        retainedTags = first.value.tags;
        retainedIds = first.value.ids;
        first.value.at.setTime(first.value.at.getTime() + 60_000);
        first.value.tags.set("added", "x");
        first.value.ids.add("added");
        params.at.setTime(params.at.getTime() + 60_000);
        expect(second.value.at.toISOString()).toBe(untouched);
        expect(second.value.tags.size).toBe(1);
        expect(second.value.ids.size).toBe(1);
        return projection.rows.map((row) => ({
          key: row.key,
          at: row.value.at,
          tags: row.value.tags,
          ids: row.value.ids,
        }));
      },
      handleSort: (items, params) => {
        const first = items[0];
        const second = items[1];
        if (first === undefined || second === undefined) return items;
        seen.push(first.at.toISOString());
        seen.push(String(first.tags.size));
        seen.push(second.at.toISOString());
        seen.push(params.at.toISOString());
        expect(first.at).not.toBe(retainedAt);
        expect(second.at).not.toBe(first.at);
        expect(second.at.toISOString()).toBe("2020-06-01T00:00:00.000Z");
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
    const later = JSON.stringify({
      at: "2020-06-01T00:00:00.000Z",
      tags: [["m", "n"]],
      ids: ["b"],
    });
    const expectedItems = [
      {
        key: "a",
        at: "2020-01-01T00:02:00.000Z",
        tags: [["k", "v"], ["added", "x"]],
        ids: ["a", "added"],
      },
      {
        key: "n",
        at: "2020-06-01T00:00:00.000Z",
        tags: [["m", "n"]],
        ids: ["b"],
      },
    ];
    const run = (
      scan: (limit: number) => Promise<PortableScanBatch> = async () => ({
        candidates: [candidate("a", stored), candidate("n", later)],
      }),
      canonicalize: (value: unknown) => { key: string; value: unknown; sourceSuid: string } = (value) =>
        canonicalizeCheckpointCandidate(value, view.rowCodec.decode, {
          tagGroup: TAG_GROUP,
          tagProjector: TAG_PROJECTOR,
        }),
    ) => executePortableQuery({
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
      page: { pageNumber: 1, pageSize: 2, descending: false },
      scan,
      canonicalize,
    });
    const first = await run();
    expect(seen).toEqual([
      "2020-01-01T00:00:00.000Z",
      "1",
      "1",
      "2020-06-01T00:00:00.000Z",
      "2020-01-02T00:00:00.000Z",
      "2020-01-01T00:01:00.000Z",
      "2",
      "2020-06-01T00:00:00.000Z",
      "2020-01-02T00:00:00.000Z",
    ]);
    expect(first).toMatchObject({ ok: true, items: expectedItems });
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

const PARITY_ROWS = [
  { key: "a", label: "alpha", sourceSuid: "suid-a" },
  { key: "n", label: "north", sourceSuid: "suid-n" },
  { key: "é", label: "latin", sourceSuid: "suid-e" },
] as const;

const PARITY_DIGEST = PARITY_ROWS.map((row) => `${row.key}=${row.label}@${row.sourceSuid}`).join("|");

function parityByKey(key: string): (typeof PARITY_ROWS)[number] {
  const row = PARITY_ROWS.find((candidate) => candidate.key === key);
  if (row === undefined) throw new Error(`missing parity row ${key}`);
  return row;
}

function parityRowCodec() {
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

function parityListDefinition() {
  return {
    kind: "list" as const,
    rowCodec: parityRowCodec(),
    paramsCodec: { decode: () => ({ tie: "same" }), encode: (value: { tie: string }) => value },
    itemCodec: {
      decode: (value: unknown): { key: string; label: string; sourceSuid: string } =>
        value as { key: string; label: string; sourceSuid: string },
      encode: (value: { key: string; label: string; sourceSuid: string }) => ({
        key: value.key,
        label: value.label,
        sourceSuid: value.sourceSuid,
      }),
    },
    handleFilter: (projection: { rows: readonly { key: string; value: { label: string }; sourceSuid: string }[] }) =>
      projection.rows.map((row) => ({
        key: row.key,
        label: row.value.label,
        sourceSuid: row.sourceSuid,
        tie: "same",
      })),
    handleSort: (items: readonly { key: string; label: string; sourceSuid: string }[]) => [...items],
  };
}

function parityScalarDefinition() {
  return {
    kind: "scalar" as const,
    rowCodec: parityRowCodec(),
    paramsCodec: { decode: () => ({}), encode: (value: Record<string, never>) => value },
    resultCodec: {
      decode: (value: unknown): { count: number; digest: string } => value as { count: number; digest: string },
      encode: (value: { count: number; digest: string }) => value,
    },
    handleQuery: (projection: { rows: readonly { key: string; value: { label: string }; sourceSuid: string }[] }) => ({
      count: projection.rows.length,
      digest: projection.rows.map((row) => `${row.key}=${row.value.label}@${row.sourceSuid}`).join("|"),
    }),
  };
}

async function executeParity(
  scan: (limit: number) => Promise<PortableScanBatch>,
  page: { pageNumber: number; pageSize: number; descending: boolean },
  canonicalize: (candidate: unknown) => { key: string; value: unknown; sourceSuid: string },
) {
  return executePortableQuery({
    definition: parityListDefinition(),
    params: {},
    maximum: 3,
    page,
    scan,
    canonicalize,
  });
}

async function assertBackingParity(
  scan: (limit: number) => Promise<PortableScanBatch>,
  canonicalize: (candidate: unknown) => { key: string; value: unknown; sourceSuid: string },
  readHead?: string,
): Promise<void> {
  const ascending = await executeParity(scan, { pageNumber: 1, pageSize: 2, descending: false }, canonicalize);
  const ascendingTail = await executeParity(scan, { pageNumber: 2, pageSize: 2, descending: false }, canonicalize);
  const descending = await executeParity(scan, { pageNumber: 1, pageSize: 2, descending: true }, canonicalize);
  const descendingTail = await executeParity(scan, { pageNumber: 2, pageSize: 2, descending: true }, canonicalize);
  const head = readHead === undefined ? {} : { readHead };
  expect(ascending).toMatchObject({
    ok: true,
    items: [
      { key: "a", label: "alpha", sourceSuid: "suid-a" },
      { key: "n", label: "north", sourceSuid: "suid-n" },
    ],
    totalCount: 3,
    totalPages: 2,
    currentPage: 1,
    pageSize: 2,
    ...head,
  });
  expect(ascendingTail).toMatchObject({
    ok: true,
    items: [{ key: "é", label: "latin", sourceSuid: "suid-e" }],
    totalCount: 3,
    currentPage: 2,
    ...head,
  });
  expect(descending).toMatchObject({
    ok: true,
    items: [
      { key: "é", label: "latin", sourceSuid: "suid-e" },
      { key: "n", label: "north", sourceSuid: "suid-n" },
    ],
    totalCount: 3,
    currentPage: 1,
    ...head,
  });
  expect(descendingTail).toMatchObject({
    ok: true,
    items: [{ key: "a", label: "alpha", sourceSuid: "suid-a" }],
    totalCount: 3,
    currentPage: 2,
    ...head,
  });
  if (readHead === undefined) {
    expect(ascending).not.toHaveProperty("readHead");
  }
  const scalar = await executePortableQuery({
    definition: parityScalarDefinition(),
    params: {},
    maximum: 3,
    scan,
    canonicalize,
  });
  expect(scalar).toMatchObject({ ok: true, kind: "scalar", result: { count: 3, digest: PARITY_DIGEST }, ...head });
}

async function seedCheckpoints(store: CheckpointStore, serviceId: string, order: readonly string[]): Promise<void> {
  for (const [index, key] of order.entries()) {
    const row = parityByKey(key);
    expect(await store.advanceProjectionCheckpoint({
      serviceId,
      projectionId: checkpointId(row.key),
      expectedLastSuid: null,
      lastSuid: row.sourceSuid,
      stateJson: JSON.stringify({ label: row.label }),
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

function checkpointCanonicalize(value: unknown) {
  return canonicalizeCheckpointCandidate(value, parityRowCodec().decode, {
    tagGroup: TAG_GROUP,
    tagProjector: TAG_PROJECTOR,
  });
}

function checkpointScan(store: CheckpointStore, serviceId: string): (limit: number) => Promise<PortableScanBatch> {
  return async (limit) => ({
    candidates: await store.scanProjectionCheckpointCandidates({
      serviceId,
      projectionIdPrefix: PREFIX,
      projectionIdSuffix: SUFFIX,
      limit,
    }),
  });
}

async function assertCheckpointParity(store: CheckpointStore, serviceId: string): Promise<void> {
  const bounded = await store.scanProjectionCheckpointCandidates({
    serviceId,
    projectionIdPrefix: PREFIX,
    projectionIdSuffix: SUFFIX,
    limit: 3,
  });
  expect(bounded.map((row) => row.projectionId)).toEqual([
    checkpointId("a"),
    checkpointId("n"),
    checkpointId("é"),
  ]);
  expect(bounded.map((row) => [row.lastSuid, row.stateJson])).toEqual(PARITY_ROWS.map((row) => [
    row.sourceSuid,
    JSON.stringify({ label: row.label }),
  ]));
  let scannedLimit = 0;
  await assertBackingParity(async (limit) => {
    scannedLimit = limit;
    return checkpointScan(store, serviceId)(limit);
  }, checkpointCanonicalize);
  expect(scannedLimit).toBe(4);
}

async function persistCorruptCheckpoints(store: CheckpointStore, serviceId: string): Promise<void> {
  const malformedId = `tag-state:${TAG_GROUP}::${TAG_PROJECTOR}`;
  expect(await store.advanceProjectionCheckpoint({
    serviceId,
    projectionId: checkpointId("bad"),
    expectedLastSuid: null,
    lastSuid: "suid-bad",
    stateJson: "{",
    version: 1,
    updatedAt: 60_000,
  })).toBe(true);
  expect(await store.advanceProjectionCheckpoint({
    serviceId,
    projectionId: malformedId,
    expectedLastSuid: null,
    lastSuid: "suid-malformed",
    stateJson: JSON.stringify({ label: "empty" }),
    version: 1,
    updatedAt: 60_001,
  })).toBe(true);
  const raw = await store.scanProjectionCheckpointCandidates({
    serviceId,
    projectionIdPrefix: PREFIX,
    projectionIdSuffix: SUFFIX,
    limit: 10,
  });
  expect(raw.some((row) => row.stateJson === "{")).toBe(true);
  expect(raw.some((row) => row.projectionId === malformedId)).toBe(true);
  const result = await executePortableQuery({
    definition: scalarDefinition(),
    params: {},
    maximum: 10,
    scan: checkpointScan(store, serviceId),
    canonicalize: (value) => canonicalizeCheckpointCandidate(value, rowCodec().decode, {
      tagGroup: TAG_GROUP,
      tagProjector: TAG_PROJECTOR,
    }),
  });
  expect(result).toEqual({ ok: false, kind: "row-invalid", message: "Query row is invalid." });
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

async function copiedItems(
  scan: (limit: number) => Promise<PortableScanBatch>,
  kind: "checkpoint" | "materialized",
): Promise<string> {
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
  const view = defineQueryView({ id: "copied-provider-row", version: 1, row });
  const query = defineListQuery({
    id: "copied-provider-list",
    version: 1,
    source: view,
    params: z.strictObject({
      at: z.codec(z.string(), z.date(), {
        decode: (value) => new Date(value),
        encode: (value) => value.toISOString(),
      }),
    }),
    item: z.strictObject({
      key: z.string(),
      at: row.shape.at,
      tags: row.shape.tags,
      ids: row.shape.ids,
    }),
    handleFilter: (projection) => {
      const [first, second] = projection.rows;
      if (first === undefined || second === undefined) return [];
      const untouched = second.value.at.toISOString();
      first.value.at.setTime(first.value.at.getTime() + 60_000);
      first.value.tags.set("added", "x");
      expect(second.value.at.toISOString()).toBe(untouched);
      expect(second.value).not.toBe(first.value);
      return projection.rows.map((entry) => ({
        key: entry.key,
        at: entry.value.at,
        tags: entry.value.tags,
        ids: entry.value.ids,
      }));
    },
    handleSort: (items) => items,
  });
  const result = await executePortableQuery({
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
    page: { pageNumber: 1, pageSize: 2, descending: false },
    scan,
    canonicalize: (value) => kind === "checkpoint"
      ? canonicalizeCheckpointCandidate(value, view.rowCodec.decode, {
        tagGroup: TAG_GROUP,
        tagProjector: TAG_PROJECTOR,
      })
      : canonicalizeMaterializedCandidate(value, view.rowCodec.decode),
  });
  expect(result).toMatchObject({ ok: true });
  return JSON.stringify(result);
}

describe("dormant scans on every backing", () => {
  it("encodes the same page from postgres, d1, cosmos, and bounded memory", async () => {
    const postgres = new PostgresEventStore(postgresUrl());
    await postgres.initialize();
    const serviceId = `portable-pg-${crypto.randomUUID()}`;
    await seedCheckpoints(postgres, serviceId, ["é", "n", "a"]);
    await assertCheckpointParity(postgres, serviceId);
    await persistCorruptCheckpoints(postgres, `${serviceId}-corrupt`);
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
    await persistCorruptCheckpoints(d1, `${d1Service}-corrupt`);
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
    await persistCorruptCheckpoints(cosmos, `${cosmosService}-corrupt`);
    const idleCosmos = new CosmosEventStore({ client: new CheckpointMemoryClient() });
    const cosmosFailure = await executePortableQuery({
      definition: scalarDefinition(),
      params: {},
      maximum: 10,
      scan: async () => ({
        candidates: await idleCosmos.scanProjectionCheckpointCandidates({
          serviceId: cosmosService,
          projectionIdPrefix: PREFIX,
          projectionIdSuffix: SUFFIX,
          limit: 1,
        }),
      }),
      canonicalize: checkpointCanonicalize,
    });
    expect(cosmosFailure).toEqual({
      ok: false,
      kind: "projection-unavailable",
      message: "Query projection is unavailable.",
    });

    const checkpoints = new Map<string, { projectionId: string; lastSuid: string; stateJson: string }>();
    for (const row of PARITY_ROWS) {
      const projectionId = checkpointId(row.key);
      checkpoints.set(projectionId, {
        projectionId,
        lastSuid: row.sourceSuid,
        stateJson: JSON.stringify({ label: row.label }),
      });
    }
    checkpoints.set(checkpointId("000", "WRONG"), {
      projectionId: checkpointId("000", "WRONG"),
      lastSuid: "suid-decoy",
      stateJson: JSON.stringify({ label: "decoy" }),
    });
    const malformedId = `tag-state:${TAG_GROUP}::${TAG_PROJECTOR}`;
    checkpoints.set(checkpointId("bad"), {
      projectionId: checkpointId("bad"),
      lastSuid: "suid-bad",
      stateJson: "{",
    });
    checkpoints.set(checkpointId("odd"), {
      projectionId: malformedId,
      lastSuid: "suid-malformed",
      stateJson: JSON.stringify({ label: "empty" }),
    });
    let reads = 0;
    let failTags = false;
    const memory = {
      async listProjectionTags() {
        if (failTags) throw new Error("memory tag index unavailable");
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
    expect(boundedMemory.map((row) => [row.lastSuid, row.stateJson])).toEqual([
      ["suid-a", JSON.stringify({ label: "alpha" })],
      ["suid-n", JSON.stringify({ label: "north" })],
    ]);
    expect(reads).toBe(2);
    reads = 0;
    await assertBackingParity(
      async (limit) => ({
        candidates: await readRawCheckpointCandidates(memory, "memory", TAG_GROUP, TAG_PROJECTOR, limit),
      }),
      checkpointCanonicalize,
    );
    expect(reads).toBeGreaterThan(0);
    const corruptMemory = {
      async listProjectionTags() {
        return ["room:bad", "room:odd"];
      },
      async readProjectionCheckpoint(_serviceId: string, projectionId: string) {
        const found = checkpoints.get(projectionId);
        return found === undefined ? undefined : { ...found, serviceId: "memory-corrupt", version: 1, updatedAt: 1 };
      },
    };
    const rawCorrupt = await readRawCheckpointCandidates(corruptMemory, "memory-corrupt", TAG_GROUP, TAG_PROJECTOR, 10);
    expect(rawCorrupt.some((row) => row.stateJson === "{")).toBe(true);
    expect(rawCorrupt.some((row) => row.projectionId === malformedId)).toBe(true);
    const corrupt = await executePortableQuery({
      definition: scalarDefinition(),
      params: {},
      maximum: 10,
      scan: async (limit) => ({
        candidates: await readRawCheckpointCandidates(corruptMemory, "memory-corrupt", TAG_GROUP, TAG_PROJECTOR, limit),
      }),
      canonicalize: checkpointCanonicalize,
    });
    expect(corrupt).toEqual({ ok: false, kind: "row-invalid", message: "Query row is invalid." });
    failTags = true;
    const memoryFailure = await executePortableQuery({
      definition: scalarDefinition(),
      params: {},
      maximum: 10,
      scan: async () => ({
        candidates: await readRawCheckpointCandidates(memory, "memory", TAG_GROUP, TAG_PROJECTOR, 1),
      }),
      canonicalize: checkpointCanonicalize,
    });
    expect(memoryFailure).toEqual({
      ok: false,
      kind: "projection-unavailable",
      message: "Query projection is unavailable.",
    });

    const copyRows = {
      a: JSON.stringify({ at: "2020-01-01T00:00:00.000Z", tags: [["k", "v"]], ids: ["a"] }),
      n: JSON.stringify({ at: "2020-06-01T00:00:00.000Z", tags: [["m", "n"]], ids: ["b"] }),
    };
    const seedCopy = async (store: CheckpointStore, copyService: string) => {
      for (const [index, key] of (["n", "a"] as const).entries()) {
        expect(await store.advanceProjectionCheckpoint({
          serviceId: copyService,
          projectionId: checkpointId(key),
          expectedLastSuid: null,
          lastSuid: `copy-${key}`,
          stateJson: copyRows[key],
          version: 1,
          updatedAt: 70_000 + index,
        })).toBe(true);
      }
    };
    const repeated = await copiedItems(async () => ({
      candidates: [candidate("a", copyRows.a), candidate("n", copyRows.n)],
    }), "checkpoint");
    expect(await copiedItems(async () => ({
      candidates: [candidate("a", copyRows.a), candidate("n", copyRows.n)],
    }), "checkpoint")).toBe(repeated);
    await seedCopy(postgres, `${serviceId}-copy`);
    await seedCopy(d1, `${d1Service}-copy`);
    await seedCopy(cosmos, `${cosmosService}-copy`);
    const copyMemory = {
      async listProjectionTags() {
        return ["room:n", "room:a"];
      },
      async readProjectionCheckpoint(_serviceId: string, projectionId: string) {
        const key = projectionId === checkpointId("a") ? "a" : "n";
        return {
          serviceId: "copy-memory",
          projectionId,
          lastSuid: `copy-${key}`,
          stateJson: copyRows[key],
          version: 1,
          updatedAt: 1,
        };
      },
    };
    expect(await copiedItems(checkpointScan(postgres, `${serviceId}-copy`), "checkpoint")).toBe(repeated);
    expect(await copiedItems(checkpointScan(d1, `${d1Service}-copy`), "checkpoint")).toBe(repeated);
    expect(await copiedItems(checkpointScan(cosmos, `${cosmosService}-copy`), "checkpoint")).toBe(repeated);
    expect(await copiedItems(async (limit) => ({
      candidates: await readRawCheckpointCandidates(copyMemory, "copy-memory", TAG_GROUP, TAG_PROJECTOR, limit),
    }), "checkpoint")).toBe(repeated);
  });

  it("reads bounded raw materialized rows and preserves the safe checkpoint head", async () => {
    const database = mvDatabase();
    const store = new D1MaterializedViewStore(database);
    await store.initialize();
    const serviceId = `portable-mv-${crypto.randomUUID()}`;
    const viewId = "portable-view";
    const [checkpoint, lowSuid, midSuid, highSuid] = [
      g32Suid("mv-head"),
      g32Suid("mv-newer"),
      g32Suid("mv-low"),
      g32Suid("mv-mid"),
    ].sort() as [string, string, string, string];
    const created = await store.createActive({
      serviceId,
      viewId,
      definitionVersion: 1,
      updatedAt: 1_000,
      lastSuid: checkpoint,
    });
    const inserted = ["n", "a", "é"];
    for (const key of inserted) {
      const row = parityByKey(key);
      await database.prepare(
        `INSERT INTO mv_rows (service_id, view_id, generation, row_key, value_json, row_version, source_suid)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      ).bind(serviceId, viewId, created.generation, row.key, JSON.stringify({ label: row.label }), row.sourceSuid).run();
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
    const unsafeView = `portable-unsafe-${crypto.randomUUID()}`;
    const unsafeInstance = await store.createActive({
      serviceId,
      viewId: unsafeView,
      definitionVersion: 1,
      updatedAt: 1_000,
      lastSuid: checkpoint,
    });
    const safeRows = [
      ["a", JSON.stringify({ label: "safe" }), lowSuid],
      ["b", JSON.stringify({ label: "bound" }), lowSuid],
      ["n", JSON.stringify({ label: "kept" }), lowSuid],
    ] as const;
    for (const [key, valueJson, sourceSuid] of safeRows) {
      await database.prepare(
        `INSERT INTO mv_rows (service_id, view_id, generation, row_key, value_json, row_version, source_suid)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      ).bind(serviceId, unsafeView, unsafeInstance.generation, key, valueJson, sourceSuid).run();
    }
    await database.prepare(
      `INSERT INTO mv_unsafe_rows (service_id, view_id, generation, row_key, value_json, row_version, source_suid, tombstone)
       VALUES (?, ?, ?, ?, ?, 1, ?, 0)`,
    ).bind(serviceId, unsafeView, unsafeInstance.generation, "a", JSON.stringify({ label: "override" }), highSuid).run();
    await database.prepare(
      `INSERT INTO mv_unsafe_rows (service_id, view_id, generation, row_key, value_json, row_version, source_suid, tombstone)
       VALUES (?, ?, ?, ?, ?, 1, ?, 1)`,
    ).bind(serviceId, unsafeView, unsafeInstance.generation, "n", JSON.stringify({ label: "gone" }), midSuid).run();
    const unsafe = await store.scanRows(serviceId, unsafeView, { consistency: "unsafe", limit: 10 });
    expect(unsafe.rows.map((row) => [row.rowKey, row.valueJson, row.sourceSuid])).toEqual([
      ["a", JSON.stringify({ label: "override" }), highSuid],
      ["b", JSON.stringify({ label: "bound" }), lowSuid],
    ]);
    expect(unsafe.readHead).toBe(highSuid);
    const boundedUnsafe = await store.scanRows(serviceId, unsafeView, { consistency: "unsafe", limit: 1 });
    expect(boundedUnsafe.rows.map((row) => row.rowKey)).toEqual(["a"]);
    const unsafePage = await executePortableQuery({
      definition: parityListDefinition(),
      params: {},
      maximum: 10,
      page: { pageNumber: 1, pageSize: 10, descending: false },
      scan: async (limit) => {
        const batch = await store.scanRows(serviceId, unsafeView, { consistency: "unsafe", limit });
        return { candidates: batch.rows, readHead: batch.readHead };
      },
      canonicalize: (value) => canonicalizeMaterializedCandidate(value, parityRowCodec().decode),
    });
    expect(unsafePage).toMatchObject({
      ok: true,
      items: [
        { key: "a", label: "override", sourceSuid: highSuid },
        { key: "b", label: "bound", sourceSuid: lowSuid },
      ],
      totalCount: 2,
      readHead: highSuid,
    });
    const idleView = new D1MaterializedViewStore(database);
    const viewFailure = await executePortableQuery({
      definition: scalarDefinition(),
      params: {},
      maximum: 10,
      scan: async () => {
        await idleView.scanRows(serviceId, viewId, { consistency: "safe", limit: 1 });
        return { candidates: [] };
      },
      canonicalize: (value) => canonicalizeMaterializedCandidate(value, rowCodec().decode),
    });
    expect(viewFailure).toMatchObject({ ok: false, kind: "projection-unavailable" });
    await assertBackingParity(
      async (limit) => {
        const batch = await store.scanRows(serviceId, viewId, { consistency: "safe", limit });
        return { candidates: batch.rows, readHead: batch.readHead };
      },
      (value) => canonicalizeMaterializedCandidate(value, parityRowCodec().decode),
      checkpoint,
    );
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
    const copyView = `portable-copy-${crypto.randomUUID()}`;
    const copyInstance = await store.createActive({
      serviceId,
      viewId: copyView,
      definitionVersion: 1,
      updatedAt: 1_000,
      lastSuid: checkpoint,
    });
    const copyRows = {
      a: JSON.stringify({ at: "2020-01-01T00:00:00.000Z", tags: [["k", "v"]], ids: ["a"] }),
      n: JSON.stringify({ at: "2020-06-01T00:00:00.000Z", tags: [["m", "n"]], ids: ["b"] }),
    };
    for (const key of ["n", "a"] as const) {
      await database.prepare(
        `INSERT INTO mv_rows (service_id, view_id, generation, row_key, value_json, row_version, source_suid)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      ).bind(serviceId, copyView, copyInstance.generation, key, copyRows[key], `copy-${key}`).run();
    }
    const checkpointCopy = await copiedItems(async () => ({
      candidates: [candidate("a", copyRows.a), candidate("n", copyRows.n)],
    }), "checkpoint");
    const viewCopy = await copiedItems(async (limit) => {
      const batch = await store.scanRows(serviceId, copyView, { consistency: "safe", limit });
      return { candidates: batch.rows, readHead: batch.readHead };
    }, "materialized");
    expect(JSON.parse(viewCopy).items).toEqual(JSON.parse(checkpointCopy).items);
    expect(JSON.parse(viewCopy).readHead).toBe(checkpoint);
  });
});
