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
  defineQueryView,
  domain,
  event,
  projector,
  tagFamily,
  toRuntimeDomain,
} from "@sekiban/dcb-domain";
import { createCloudflareOnlyRuntimeWorker, type CloudflareOnlyEnv } from "../packages/dcb-runtime/src/cloudflare";
import { handleSerializedQuery, type QueryExecutionOptions } from "../packages/dcb-runtime/src/http/SerializedQueryWorker";
import { TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/http/testServiceId";
import { createRuntimeWorker } from "../packages/dcb-runtime/src/index";
import { D1MaterializedViewStore } from "../packages/dcb-runtime/src/d1-mv";
import type { MaterializedViewRawScan } from "../packages/dcb-runtime/src/mv/MaterializedViewStore";
import type { MaterializedViewQueryPort } from "../packages/dcb-runtime/src/query/ProjectionQueryStore";
import { ProjectorRegistry, type TagStateProjector } from "../packages/dcb-runtime/src/projection/ProjectorRegistry";
import { QueryRegistry, RuntimeQueryDefinitionError, type QueryDefinition } from "../packages/dcb-runtime/src/query/QueryRegistry";
import {
  CosmosEventStore,
  type CosmosDocumentClient,
  type CosmosDocumentRecord,
} from "../packages/dcb-runtime/src/store/CosmosEventStore";
import { D1EventStore } from "../packages/dcb-runtime/src/store/D1EventStore";
import { PostgresEventStore } from "../packages/dcb-runtime/src/store/PostgresEventStore";
import type { PipelineStore } from "../packages/dcb-runtime/src/store/types";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";
import { g32Suid } from "./helpers/g32-fixtures";

const TAG_GROUP = "room";
const TAG_PROJECTOR = "board";
const PARITY = [
  { key: "a", label: "alpha", sourceSuid: "suid-a" },
  { key: "n", label: "north", sourceSuid: "suid-n" },
  { key: "é", label: "latin", sourceSuid: "suid-e" },
] as const;
const CHECKPOINT_HEAD = "suid-n";
const ASCENDING_PAGE = [
  { key: "a", label: "alpha" },
  { key: "é", label: "latin" },
];
const DESCENDING_PAGE = [
  { key: "n", label: "north" },
  { key: "é", label: "latin" },
];
const PAGE_TWO = [{ key: "n", label: "north" }];
const FILTERED = [{ key: "a", label: "alpha" }];
const ALL_ITEMS = [
  { key: "a", label: "alpha" },
  { key: "é", label: "latin" },
  { key: "n", label: "north" },
];

type JsonObject = Record<string, unknown>;
type Mode = "ok" | "throw" | "thenable" | "encode" | "mutate";

interface Probe {
  params: unknown[];
  decodes: number;
  scalar: number;
  filter: number;
  sort: number;
}

interface CheckpointWriter {
  advanceProjectionCheckpoint(input: {
    serviceId: string;
    projectionId: string;
    expectedLastSuid: string | null;
    lastSuid: string;
    stateJson: string;
    version: number;
    updatedAt: number;
  }): Promise<boolean>;
}

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
  const url = (env as unknown as { POSTGRES_URL?: string }).POSTGRES_URL;
  if (url === undefined || url.length === 0) throw new Error("POSTGRES_URL binding is required");
  return url;
}

function nextId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function checkpointId(content: string, projector = TAG_PROJECTOR): string {
  return `tag-state:${TAG_GROUP}:${content}:${projector}`;
}

function boardProjector(): TagStateProjector {
  return {
    id: TAG_PROJECTOR,
    tagPayloadName: "Board",
    projectorVersion: "1",
    initialState: () => ({}),
    apply: (state) => state,
    serializeState: () => "{}",
    deserializeState: () => ({}),
    payload: () => "{}",
    version: () => 1,
  };
}

function projectors(): ProjectorRegistry {
  return new ProjectorRegistry([boardProjector()]);
}

function request(path: "query" | "list-query", serviceId: string, body: unknown): Request {
  return new Request(`https://query.test/api/sekiban/serialized/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: serviceId },
    body: JSON.stringify(body),
  });
}

async function call(
  path: "query" | "list-query",
  serviceId: string,
  body: unknown,
  options: QueryExecutionOptions,
): Promise<{ status: number; body: JsonObject }> {
  const response = await handleSerializedQuery(request(path, serviceId, body), {}, options);
  return { status: response.status, body: await response.json<JsonObject>() };
}

function expectFailure(
  response: { status: number; body: JsonObject },
  status: number,
  code: string,
  message: string,
  secret: string,
  label: string,
): void {
  expect(response.status, label).toBe(status);
  expect(response.body, label).toEqual({ error: message, code });
  expect(JSON.stringify(response.body), label).not.toContain(secret);
}

function probe(): Probe {
  return { params: [], decodes: 0, scalar: 0, filter: 0, sort: 0 };
}

function executableRegistry(state: Probe, mode: Mode, viewId = TAG_PROJECTOR): QueryRegistry {
  const rowCodec = {
    decode(value: unknown) {
      state.decodes += 1;
      if (typeof value !== "object" || value === null || typeof (value as { label?: unknown }).label !== "string") {
        throw new Error("row-secret-token");
      }
      return { label: (value as { label: string }).label };
    },
    encode(value: unknown) {
      return value;
    },
  };
  const paramsCodec = {
    decode(value: unknown) {
      state.params.push(value);
      if (typeof value !== "object" || value === null) throw new Error("params-secret-token");
      const record = value as JsonObject;
      for (const key of ["PageNumber", "PageSize", "NewestFirst", "consistency"]) {
        if (Object.prototype.hasOwnProperty.call(record, key)) throw new Error("control-secret-token");
      }
      if (typeof record.roomId !== "string") throw new Error("params-secret-token");
      return { roomId: record.roomId };
    },
    encode(value: unknown) {
      return value;
    },
  };
  const resultCodec = {
    decode(value: unknown) {
      return value;
    },
    encode(value: unknown) {
      if (mode === "encode") throw new Error("result-secret-token");
      return value;
    },
  };
  const itemCodec = {
    decode(value: unknown) {
      return value;
    },
    encode(value: unknown) {
      if (mode === "encode") throw new Error("item-secret-token");
      return value;
    },
  };
  const scalar = {
    queryType: "count",
    endpoint: "query" as const,
    tagGroup: TAG_GROUP,
    tagProjector: TAG_PROJECTOR,
    materializedViewId: viewId,
    enabled: true,
    version: 1,
    execution: {
      kind: "scalar" as const,
      rowCodec,
      paramsCodec,
      resultCodec,
      handleQuery(projection: { rows: { value: { label: string } }[]; readHead: string }, params: { roomId: string }) {
        state.scalar += 1;
        if (mode === "throw") throw new Error("handler-secret-token");
        if (mode === "thenable") return { count: () => 1 };
        const labels = projection.rows.map((row) => row.value.label);
        if (mode === "mutate" && projection.rows[0] !== undefined) projection.rows[0].value.label = "CHANGED";
        return {
          count: projection.rows.length,
          labels: labels.join(","),
          roomId: params.roomId,
          head: projection.readHead,
        };
      },
    },
  };
  const list = {
    queryType: "list",
    endpoint: "list-query" as const,
    tagGroup: TAG_GROUP,
    tagProjector: TAG_PROJECTOR,
    materializedViewId: viewId,
    enabled: true,
    version: 1,
    execution: {
      kind: "list" as const,
      rowCodec,
      paramsCodec,
      itemCodec,
      handleFilter(projection: { rows: { key: string; value: { label: string } }[] }, params: { roomId: string }) {
        state.filter += 1;
        return projection.rows
          .filter((row) => params.roomId === "room-1" || row.value.label === params.roomId)
          .map((row) => ({ key: row.key, label: row.value.label }));
      },
      handleSort(items: readonly { key: string; label: string }[]) {
        state.sort += 1;
        return [...items].sort((left, right) => left.label < right.label ? -1 : left.label > right.label ? 1 : 0);
      },
    },
  };
  return new QueryRegistry([scalar, list]);
}

function baseOptions(registry: QueryRegistry, extra: QueryExecutionOptions = {}): QueryExecutionOptions {
  return { registry, projectors: projectors(), ...extra };
}

class MemoryCheckpoints {
  readonly limits: number[] = [];
  fail = false;
  private readonly extra = new Map<string, { projectionId: string; lastSuid: string; stateJson: string }[]>();

  constructor(private readonly rows: readonly { projectionId: string; lastSuid: string; stateJson: string }[] = []) {}

  async initialize(): Promise<void> {}

  async advanceProjectionCheckpoint(input: {
    serviceId: string;
    projectionId: string;
    expectedLastSuid: string | null;
    lastSuid: string;
    stateJson: string;
    version: number;
    updatedAt: number;
  }): Promise<boolean> {
    const rows = this.extra.get(input.serviceId) ?? [];
    rows.push({ projectionId: input.projectionId, lastSuid: input.lastSuid, stateJson: input.stateJson });
    this.extra.set(input.serviceId, rows);
    return true;
  }

  private rowsFor(serviceId: string): readonly { projectionId: string; lastSuid: string; stateJson: string }[] {
    return this.extra.get(serviceId) ?? this.rows;
  }

  async listProjectionTags(serviceId: string): Promise<readonly string[]> {
    if (this.fail) throw new Error("provider-secret-token");
    return this.rowsFor(serviceId).map((row) => `${TAG_GROUP}:${row.projectionId.split(":")[2] ?? ""}`);
  }

  async readProjectionCheckpoint(serviceId: string, projectionId: string) {
    const found = this.rowsFor(serviceId).find((row) => row.projectionId === projectionId);
    return found === undefined ? undefined : { serviceId, ...found, version: 1, updatedAt: 1 };
  }

  async scanProjectionCheckpointCandidates(input: {
    serviceId: string;
    projectionIdPrefix: string;
    projectionIdSuffix: string;
    limit: number;
  }) {
    if (this.fail) throw new Error("provider-secret-token");
    this.limits.push(input.limit);
    return this.rowsFor(input.serviceId)
      .filter((row) => row.projectionId.startsWith(input.projectionIdPrefix) && row.projectionId.endsWith(input.projectionIdSuffix))
      .sort((left, right) => left.projectionId < right.projectionId ? -1 : left.projectionId > right.projectionId ? 1 : 0)
      .slice(0, input.limit);
  }
}

function parityRows(): { projectionId: string; lastSuid: string; stateJson: string }[] {
  return PARITY.map((row) => ({
    projectionId: checkpointId(row.key),
    lastSuid: row.sourceSuid,
    stateJson: JSON.stringify({ label: row.label }),
  }));
}

async function seedCheckpoints(store: CheckpointWriter, serviceId: string): Promise<void> {
  const order = ["é", "n", "a"];
  for (const [index, key] of order.entries()) {
    const row = PARITY.find((candidate) => candidate.key === key);
    if (row === undefined) throw new Error("missing parity row");
    expect(await store.advanceProjectionCheckpoint({
      serviceId,
      projectionId: checkpointId(row.key),
      expectedLastSuid: null,
      lastSuid: row.sourceSuid,
      stateJson: JSON.stringify({ label: row.label }),
      version: 1,
      updatedAt: 40_000 + index,
    }), serviceId).toBe(true);
  }
  expect(await store.advanceProjectionCheckpoint({
    serviceId,
    projectionId: checkpointId("000", "WRONG"),
    expectedLastSuid: null,
    lastSuid: "suid-decoy",
    stateJson: JSON.stringify({ label: "decoy" }),
    version: 1,
    updatedAt: 39_000,
  }), serviceId).toBe(true);
}

async function seedCorruptCheckpoint(store: CheckpointWriter, serviceId: string): Promise<void> {
  expect(await store.advanceProjectionCheckpoint({
    serviceId,
    projectionId: checkpointId("bad"),
    expectedLastSuid: null,
    lastSuid: "suid-bad",
    stateJson: "{",
    version: 1,
    updatedAt: 41_000,
  })).toBe(true);
}

class ActivationCosmosClient implements CosmosDocumentClient {
  private readonly rows = new Map<string, Record<string, unknown>>();
  fail = false;

  async initialize(): Promise<void> {}

  async read<T extends JsonObject>(container: string, id: string, partitionKey: string): Promise<CosmosDocumentRecord<T> | undefined> {
    const document = this.rows.get(`${container}\u0000${partitionKey}\u0000${id}`);
    return document === undefined ? undefined : { document: document as T, etag: "1" };
  }

  async create<T extends JsonObject>(container: string, document: T, partitionKey: string): Promise<CosmosDocumentRecord<T>> {
    this.rows.set(`${container}\u0000${partitionKey}\u0000${String(document.id)}`, document);
    return { document, etag: "1" };
  }

  async replace<T extends JsonObject>(container: string, document: T, partitionKey: string, etag?: string): Promise<boolean> {
    void container;
    void document;
    void partitionKey;
    void etag;
    return true;
  }

  async query<T extends JsonObject>(
    container: string,
    query: string,
    parameters: readonly { name: string; value: unknown }[],
    partitionKey?: string,
  ): Promise<CosmosDocumentRecord<T>[]> {
    if (this.fail) throw new Error("provider-secret-token");
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

function listBody(params: JsonObject): JsonObject {
  return { queryType: "list", queryParamsJson: JSON.stringify(params) };
}

function scalarBody(params: JsonObject): JsonObject {
  return { queryType: "count", queryParamsJson: JSON.stringify(params) };
}

function expectList(
  response: { status: number; body: JsonObject },
  items: readonly { key: string; label: string }[],
  page: { totalCount: number; totalPages: number; currentPage: number; pageSize: number },
  readHead: string,
  label: string,
): void {
  expect(response.status, label).toBe(200);
  expect(response.body, label).toEqual({
    itemsJson: JSON.stringify(items),
    totalCount: page.totalCount,
    totalPages: page.totalPages,
    currentPage: page.currentPage,
    pageSize: page.pageSize,
    readHead,
  });
}

async function exerciseCheckpoint(
  label: string,
  store: CheckpointWriter,
  optionsFor: (registry: QueryRegistry) => QueryExecutionOptions,
  failStore: () => QueryExecutionOptions,
): Promise<void> {
  const serviceId = nextId(label);
  await seedCheckpoints(store, serviceId);
  const state = probe();
  const registry = executableRegistry(state, "ok");
  const options = optionsFor(registry);
  const scalar = await call("query", serviceId, scalarBody({ roomId: "room-1" }), options);
  expect(scalar.status, label).toBe(200);
  expect(scalar.body, label).toEqual({
    resultJson: JSON.stringify({ count: 3, labels: "alpha,north,latin", roomId: "room-1", head: CHECKPOINT_HEAD }),
  });
  expect(Object.keys(scalar.body), label).toEqual(["resultJson"]);
  const controls = { PageNumber: 1, PageSize: 2, NewestFirst: false, consistency: "safe", roomId: "room-1" };
  expectList(
    await call("list-query", serviceId, listBody(controls), options),
    ASCENDING_PAGE,
    { totalCount: 3, totalPages: 2, currentPage: 1, pageSize: 2 },
    CHECKPOINT_HEAD,
    `${label} ascending`,
  );
  expectList(
    await call("list-query", serviceId, listBody({ ...controls, NewestFirst: true }), options),
    DESCENDING_PAGE,
    { totalCount: 3, totalPages: 2, currentPage: 1, pageSize: 2 },
    CHECKPOINT_HEAD,
    `${label} descending`,
  );
  expectList(
    await call("list-query", serviceId, listBody({ ...controls, PageNumber: 2 }), options),
    PAGE_TWO,
    { totalCount: 3, totalPages: 2, currentPage: 2, pageSize: 2 },
    CHECKPOINT_HEAD,
    `${label} page boundary`,
  );
  expectList(
    await call("list-query", serviceId, listBody({ roomId: "room-1" }), options),
    ALL_ITEMS,
    { totalCount: 3, totalPages: 1, currentPage: 1, pageSize: 20 },
    CHECKPOINT_HEAD,
    `${label} defaults`,
  );
  expectList(
    await call("list-query", serviceId, listBody({ PageNumber: 1, PageSize: 20, roomId: "alpha" }), options),
    FILTERED,
    { totalCount: 1, totalPages: 1, currentPage: 1, pageSize: 20 },
    CHECKPOINT_HEAD,
    `${label} filtered`,
  );
  expect(state.params.every((value) => typeof value === "object" && value !== null && !Object.prototype.hasOwnProperty.call(value, "PageNumber")), label).toBe(true);
  const bounded = probe();
  const boundedRegistry = executableRegistry(bounded, "ok");
  const overflow = await call("query", serviceId, scalarBody({ roomId: "room-1" }), {
    ...optionsFor(boundedRegistry),
    maxScanRows: 2,
  });
  expectFailure(overflow, 422, "query_scan_limit_exceeded", "The query scan limit was exceeded.", "alpha", `${label} max+1`);
  expect(bounded.scalar, label).toBe(0);
  expect(bounded.filter, label).toBe(0);
  expect(bounded.decodes, label).toBe(0);
  const corruptId = nextId(`${label}c`);
  await seedCorruptCheckpoint(store, corruptId);
  const corrupt = await call("query", corruptId, scalarBody({ roomId: "room-1" }), options);
  expectFailure(corrupt, 500, "query_row_invalid", "The query projection contains an invalid row.", "row-secret-token", `${label} corrupt`);
  const thrown = probe();
  const thrownResponse = await call("query", serviceId, scalarBody({ roomId: "room-1" }), optionsFor(executableRegistry(thrown, "throw")));
  expectFailure(thrownResponse, 500, "query_handler_failed", "The query handler failed.", "handler-secret-token", `${label} handler`);
  const invalid = await call("query", serviceId, scalarBody({ roomId: "room-1" }), optionsFor(executableRegistry(probe(), "thenable")));
  expectFailure(invalid, 500, "query_result_invalid", "The query handler returned an invalid result.", "result-secret-token", `${label} result`);
  const encoded = await call("list-query", serviceId, listBody(controls), optionsFor(executableRegistry(probe(), "encode")));
  expectFailure(encoded, 500, "query_result_invalid", "The query handler returned an invalid result.", "item-secret-token", `${label} encode`);
  const invalidParams = await call("query", serviceId, scalarBody({}), options);
  expectFailure(invalidParams, 400, "query_params_invalid", "The query parameters are invalid.", "params-secret-token", `${label} params`);
  expect(state.params.length, label).toBeGreaterThan(0);
  const provider = await call("query", serviceId, scalarBody({ roomId: "room-1" }), failStore());
  expectFailure(provider, 503, "projection_unavailable", "The mapped query projection is unavailable", "provider-secret-token", `${label} provider`);
  const firstMutate = probe();
  const first = await call("query", serviceId, scalarBody({ roomId: "room-1" }), optionsFor(executableRegistry(firstMutate, "mutate")));
  const secondMutate = probe();
  const second = await call("query", serviceId, scalarBody({ roomId: "room-1" }), optionsFor(executableRegistry(secondMutate, "mutate")));
  expect(JSON.parse(String(first.body.resultJson)), label).toMatchObject({ labels: "alpha,north,latin" });
  expect(JSON.parse(String(second.body.resultJson)), label).toMatchObject({ labels: "alpha,north,latin" });
  let unsafeObservations = 0;
  const unsafe = await call("list-query", serviceId, listBody({ ...controls, consistency: "unsafe" }), {
    ...options,
    afterUnsafeRead: () => { unsafeObservations += 1; },
  });
  expect(unsafe.status, `${label} unsafe`).toBe(200);
  expect(unsafe.body.readHead, `${label} unsafe head`).toBe(CHECKPOINT_HEAD);
  expect(unsafeObservations, label).toBe(1);
  let safeObservations = 0;
  await call("list-query", serviceId, listBody(controls), {
    ...options,
    afterUnsafeRead: () => { safeObservations += 1; },
  });
  expect(safeObservations, label).toBe(0);
}

function instrumentMaterialized(inner: D1MaterializedViewStore): MaterializedViewQueryPort & {
  readonly legacy: { readListPage: number; queryRowsWithTotal: number; queryRows: number; scanRows: number };
  fail: boolean;
  quarantineOnScan: boolean;
  rowsOnScan: MaterializedViewRawScan | undefined;
} {
  const legacy = { readListPage: 0, queryRowsWithTotal: 0, queryRows: 0, scanRows: 0 };
  const port = {
    legacy,
    fail: false,
    quarantineOnScan: false,
    rowsOnScan: undefined as MaterializedViewRawScan | undefined,
    initialize: () => inner.initialize(),
    readOrderingQuarantine: (serviceId: string, viewId: string) => inner.readOrderingQuarantine(serviceId, viewId),
    readActiveGeneration: (serviceId: string, viewId: string) => inner.readActiveGeneration(serviceId, viewId),
    hasCheckpointAheadFinding: (serviceId: string, viewId: string) => inner.hasCheckpointAheadFinding(serviceId, viewId),
    readListPage: async (...args: Parameters<D1MaterializedViewStore["readListPage"]>) => {
      legacy.readListPage += 1;
      return inner.readListPage(...args);
    },
    queryRowsWithTotal: async (...args: Parameters<D1MaterializedViewStore["queryRowsWithTotal"]>) => {
      legacy.queryRowsWithTotal += 1;
      return inner.queryRowsWithTotal(...args);
    },
    queryRows: async (...args: Parameters<D1MaterializedViewStore["queryRows"]>) => {
      legacy.queryRows += 1;
      return inner.queryRows(...args);
    },
    scanRows: async (serviceId: string, viewId: string, scan: Parameters<D1MaterializedViewStore["scanRows"]>[2]) => {
      legacy.scanRows += 1;
      if (port.quarantineOnScan) {
        await inner.recordOrderingQuarantine({
          serviceId,
          viewId,
          generation: 0,
          checkpointSuid: g32Suid("activation-checkpoint"),
          lateSuid: g32Suid("activation-late"),
          eventId: "activation-event",
          classification: "LATE_LOWER_SUID",
          observedAt: 1,
        });
      }
      if (port.fail) throw new Error("provider-secret-token");
      if (port.rowsOnScan !== undefined) return port.rowsOnScan;
      return inner.scanRows(serviceId, viewId, scan);
    },
  };
  return port;
}

let postgres: PostgresEventStore | undefined;
let d1: D1EventStore | undefined;
let materialized: D1MaterializedViewStore | undefined;

beforeAll(async () => {
  const database = d1Database();
  const existing = await database.prepare("SELECT name FROM sqlite_master WHERE name = 'dcb_events'").all();
  if (existing.results.length === 0) {
    await database.batch(statements(d1Migration as string).map((statement) => database.prepare(statement)));
    await applyG44D1Migration(database);
  }
  const views = mvDatabase();
  const viewTables = await views.prepare("SELECT name FROM sqlite_master WHERE name = 'mv_instances'").all();
  if (viewTables.results.length === 0) {
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
    await views.batch(mvSql.map((statement) => views.prepare(statement)));
  }
  d1 = new D1EventStore(database);
  await d1.initialize();
  materialized = new D1MaterializedViewStore(views);
  await materialized.initialize();
}, 60_000);

async function postgresStore(): Promise<PostgresEventStore> {
  if (postgres === undefined) {
    postgres = new PostgresEventStore(postgresUrl());
    await postgres.initialize();
  }
  return postgres;
}

describe("executable query activation", () => {
  it("executes the shared scalar and list contract on memory", async () => {
    const memory = new MemoryCheckpoints();
    const failing = new MemoryCheckpoints(parityRows());
    failing.fail = true;
    await exerciseCheckpoint(
      "memory",
      memory,
      (registry) => baseOptions(registry, { store: memory as unknown as PipelineStore }),
      () => baseOptions(executableRegistry(probe(), "ok"), { store: failing as unknown as PipelineStore }),
    );
    expect(memory.limits.every((limit) => limit > 0)).toBe(true);
  }, 60_000);

  it("executes the shared scalar and list contract on d1", async () => {
    const store = d1;
    if (store === undefined) throw new Error("D1 store was not initialized");
    const idle = new D1EventStore(d1Database());
    await exerciseCheckpoint(
      "d1",
      store,
      (registry) => baseOptions(registry, { store }),
      () => baseOptions(executableRegistry(probe(), "ok"), { store: idle }),
    );
  }, 60_000);

  it("executes the shared scalar and list contract on postgres", async () => {
    const store = await postgresStore();
    const failing = {
      async listProjectionTags(): Promise<readonly string[]> {
        throw new Error("provider-secret-token");
      },
      async readProjectionCheckpoint(): Promise<undefined> {
        throw new Error("provider-secret-token");
      },
    };
    await exerciseCheckpoint(
      "pg",
      store,
      (registry) => baseOptions(registry, { store }),
      () => baseOptions(executableRegistry(probe(), "ok"), { store: failing as unknown as PipelineStore }),
    );
  }, 60_000);

  it("executes the shared scalar and list contract on cosmos", async () => {
    const client = new ActivationCosmosClient();
    const store = new CosmosEventStore({ client });
    await store.initialize();
    const failingClient = new ActivationCosmosClient();
    const failing = new CosmosEventStore({ client: failingClient });
    await failing.initialize();
    failingClient.fail = true;
    await exerciseCheckpoint(
      "cosmos",
      store,
      (registry) => baseOptions(registry, { store }),
      () => baseOptions(executableRegistry(probe(), "ok"), { store: failing }),
    );
  }, 60_000);

  it("executes the shared scalar and list contract on d1-mv", async () => {
    const inner = materialized;
    if (inner === undefined) throw new Error("materialized view store was not initialized");
    const database = mvDatabase();
    const serviceId = nextId("mv");
    const viewId = nextId("view");
    const head = g32Suid("activation-head");
    const created = await inner.createActive({ serviceId, viewId, definitionVersion: 1, updatedAt: 1_000, lastSuid: head });
    for (const row of PARITY) {
      await database.prepare(
        `INSERT INTO mv_rows (service_id, view_id, generation, row_key, value_json, row_version, source_suid)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      ).bind(serviceId, viewId, created.generation, row.key, JSON.stringify({ label: row.label }), row.sourceSuid).run();
    }
    const port = instrumentMaterialized(inner);
    const state = probe();
    const registry = executableRegistry(state, "ok", viewId);
    const options = baseOptions(registry, { queryBacking: "d1-mv", materializedViewQueryPort: port });
    const scalar = await call("query", serviceId, scalarBody({ roomId: "room-1" }), options);
    expect(scalar.body).toEqual({
      resultJson: JSON.stringify({ count: 3, labels: "alpha,north,latin", roomId: "room-1", head }),
    });
    const controls = { PageNumber: 1, PageSize: 2, NewestFirst: false, consistency: "safe", roomId: "room-1" };
    expectList(await call("list-query", serviceId, listBody(controls), options), ASCENDING_PAGE, { totalCount: 3, totalPages: 2, currentPage: 1, pageSize: 2 }, head, "mv ascending");
    expectList(await call("list-query", serviceId, listBody({ ...controls, NewestFirst: true }), options), DESCENDING_PAGE, { totalCount: 3, totalPages: 2, currentPage: 1, pageSize: 2 }, head, "mv descending");
    expectList(await call("list-query", serviceId, listBody({ ...controls, PageNumber: 2 }), options), PAGE_TWO, { totalCount: 3, totalPages: 2, currentPage: 2, pageSize: 2 }, head, "mv page");
    expectList(await call("list-query", serviceId, listBody({ PageNumber: 1, PageSize: 20, roomId: "alpha" }), options), FILTERED, { totalCount: 1, totalPages: 1, currentPage: 1, pageSize: 20 }, head, "mv filter");
    const bounded = probe();
    const overflow = await call("query", serviceId, scalarBody({ roomId: "room-1" }), {
      ...baseOptions(executableRegistry(bounded, "ok", viewId), { queryBacking: "d1-mv", materializedViewQueryPort: port }),
      maxScanRows: 2,
    });
    expectFailure(overflow, 422, "query_scan_limit_exceeded", "The query scan limit was exceeded.", "alpha", "mv max+1");
    expect(bounded.decodes).toBe(0);
    expect(bounded.scalar).toBe(0);
    const corruptView = nextId("mvc");
    const corruptHead = g32Suid("activation-corrupt");
    const corruptInstance = await inner.createActive({ serviceId, viewId: corruptView, definitionVersion: 1, updatedAt: 1_000, lastSuid: corruptHead });
    await database.prepare(
      `INSERT INTO mv_rows (service_id, view_id, generation, row_key, value_json, row_version, source_suid)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    ).bind(serviceId, corruptView, corruptInstance.generation, "bad", "{", corruptHead).run();
    const corrupt = await call("query", serviceId, scalarBody({ roomId: "room-1" }), baseOptions(executableRegistry(probe(), "ok", corruptView), { queryBacking: "d1-mv", materializedViewQueryPort: port }));
    expectFailure(corrupt, 500, "query_row_invalid", "The query projection contains an invalid row.", "row-secret-token", "mv corrupt");
    const thrown = await call("query", serviceId, scalarBody({ roomId: "room-1" }), baseOptions(executableRegistry(probe(), "throw", viewId), { queryBacking: "d1-mv", materializedViewQueryPort: port }));
    expectFailure(thrown, 500, "query_handler_failed", "The query handler failed.", "handler-secret-token", "mv handler");
    const invalid = await call("query", serviceId, scalarBody({ roomId: "room-1" }), baseOptions(executableRegistry(probe(), "thenable", viewId), { queryBacking: "d1-mv", materializedViewQueryPort: port }));
    expectFailure(invalid, 500, "query_result_invalid", "The query handler returned an invalid result.", "thenable", "mv result");
    const encoded = await call("list-query", serviceId, listBody(controls), baseOptions(executableRegistry(probe(), "encode", viewId), { queryBacking: "d1-mv", materializedViewQueryPort: port }));
    expectFailure(encoded, 500, "query_result_invalid", "The query handler returned an invalid result.", "item-secret-token", "mv encode");
    const invalidParams = await call("query", serviceId, scalarBody({}), options);
    expectFailure(invalidParams, 400, "query_params_invalid", "The query parameters are invalid.", "params-secret-token", "mv params");
    port.fail = true;
    const provider = await call("query", serviceId, scalarBody({ roomId: "room-1" }), options);
    expectFailure(provider, 503, "projection_unavailable", "The mapped query projection is unavailable", "provider-secret-token", "mv provider");
    port.fail = false;
    expect(port.legacy.readListPage).toBe(0);
    expect(port.legacy.queryRows).toBe(0);
    expect(port.legacy.queryRowsWithTotal).toBe(0);
    expect(port.legacy.scanRows).toBeGreaterThan(0);
    const seen = probe();
    const first = await call("query", serviceId, scalarBody({ roomId: "room-1" }), baseOptions(executableRegistry(seen, "mutate", viewId), { queryBacking: "d1-mv", materializedViewQueryPort: port }));
    const again = await call("query", serviceId, scalarBody({ roomId: "room-1" }), baseOptions(executableRegistry(probe(), "mutate", viewId), { queryBacking: "d1-mv", materializedViewQueryPort: port }));
    expect(JSON.parse(String(first.body.resultJson)).labels).toBe("alpha,north,latin");
    expect(JSON.parse(String(again.body.resultJson)).labels).toBe("alpha,north,latin");
  }, 60_000);

  it("executable definitions do not fall back to the legacy parameter guard", async () => {
    const memory = new MemoryCheckpoints([]);
    const response = await call("query", nextId("legacy"), scalarBody({ roomId: "room-1" }), baseOptions(executableRegistry(probe(), "ok"), { store: memory as unknown as PipelineStore }));
    expect(response.status).toBe(200);
    expect(response.body.code).not.toBe("query_params_unsupported");
    expect(JSON.parse(String(response.body.resultJson))).toMatchObject({ count: 0, roomId: "room-1" });
  });

  it("list controls are removed before domain params are decoded", async () => {
    const state = probe();
    const response = await call(
      "list-query",
      nextId("controls"),
      listBody({ PageNumber: 1, PageSize: 2, NewestFirst: false, consistency: "safe", roomId: "room-1" }),
      baseOptions(executableRegistry(state, "ok"), { store: new MemoryCheckpoints([]) as unknown as PipelineStore }),
    );
    expect(response.status).toBe(200);
    expect(state.params).toEqual([{ roomId: "room-1" }]);
  });

  it("disabled projector wins over invalid list consistency", async () => {
    const state = probe();
    const resolved = executableRegistry(state, "ok").resolve("list");
    if (resolved === undefined || !("execution" in resolved) || resolved.execution === undefined) throw new Error("list definition missing");
    const registry = new QueryRegistry([{ ...resolved, enabled: false }]);
    const scans: number[] = [];
    const memory = new MemoryCheckpoints([]);
    const original = memory.scanProjectionCheckpointCandidates.bind(memory);
    memory.scanProjectionCheckpointCandidates = async (input) => {
      scans.push(input.limit);
      return original(input);
    };
    const denied = await call(
      "list-query",
      nextId("disabled"),
      listBody({ PageNumber: 1, PageSize: 2, consistency: "sideways", roomId: "room-1" }),
      baseOptions(registry, { store: memory as unknown as PipelineStore }),
    );
    expect(denied).toEqual({ status: 503, body: { error: "The mapped query projection is unavailable", code: "projection_unavailable" } });
    expect(state.params).toEqual([]);
    expect(scans).toEqual([]);
    const available = await call(
      "list-query",
      nextId("enabled"),
      listBody({ consistency: "sideways", roomId: "room-1" }),
      baseOptions(executableRegistry(probe(), "ok"), { store: memory as unknown as PipelineStore }),
    );
    expect(available).toEqual({
      status: 400,
      body: {
        error: "PageNumber and PageSize must be positive integers, NewestFirst must be a boolean, and consistency must be safe or unsafe",
        code: "validation_error",
      },
    });
  });

  it("safe materialized scan rejection repeats the quarantine probe", async () => {
    const inner = materialized;
    if (inner === undefined) throw new Error("materialized view store was not initialized");
    const serviceId = nextId("qscan");
    const viewId = nextId("qview");
    await inner.createActive({ serviceId, viewId, definitionVersion: 1, updatedAt: 1, lastSuid: g32Suid("qscan-head") });
    const port = instrumentMaterialized(inner);
    port.quarantineOnScan = true;
    port.fail = true;
    const response = await call(
      "query",
      serviceId,
      scalarBody({ roomId: "room-1" }),
      baseOptions(executableRegistry(probe(), "ok", viewId), { queryBacking: "d1-mv", materializedViewQueryPort: port }),
    );
    expect(response).toEqual({
      status: 503,
      body: {
        error: "The mapped query projection is quarantined for a source-ordering incident; rebuild and promote the affected generation",
        code: "projection_ordering_quarantined",
      },
    });
  });

  it("executable materialized scans do not use the legacy page ports", async () => {
    const inner = materialized;
    if (inner === undefined) throw new Error("materialized view store was not initialized");
    const serviceId = nextId("ports");
    const viewId = nextId("ports");
    const created = await inner.createActive({ serviceId, viewId, definitionVersion: 1, updatedAt: 1, lastSuid: g32Suid("ports-head") });
    await mvDatabase().prepare(
      `INSERT INTO mv_rows (service_id, view_id, generation, row_key, value_json, row_version, source_suid)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    ).bind(serviceId, viewId, created.generation, "a", JSON.stringify({ label: "alpha" }), "suid-a").run();
    const port = instrumentMaterialized(inner);
    const response = await call(
      "list-query",
      serviceId,
      listBody({ roomId: "room-1" }),
      baseOptions(executableRegistry(probe(), "ok", viewId), { queryBacking: "d1-mv", materializedViewQueryPort: port }),
    );
    expect(response.status).toBe(200);
    expect(port.legacy.scanRows).toBeGreaterThan(0);
    expect(port.legacy.readListPage).toBe(0);
    expect(port.legacy.queryRows).toBe(0);
    expect(port.legacy.queryRowsWithTotal).toBe(0);
  });

  it("configured maxScanRows bounds the executable scan", async () => {
    const memory = new MemoryCheckpoints(parityRows().slice(0, 2));
    const response = await call(
      "query",
      nextId("max"),
      scalarBody({ roomId: "room-1" }),
      baseOptions(executableRegistry(probe(), "ok"), { store: memory as unknown as PipelineStore, maxScanRows: 1 }),
    );
    expect(response.status).toBe(422);
    expect(response.body.code).toBe("query_scan_limit_exceeded");
  });

  it("maximum plus one refuses before handlers", async () => {
    const state = probe();
    const memory = new MemoryCheckpoints(parityRows().slice(0, 2));
    const response = await call(
      "query",
      nextId("plus"),
      scalarBody({ roomId: "room-1" }),
      baseOptions(executableRegistry(state, "ok"), { store: memory as unknown as PipelineStore, maxScanRows: 1 }),
    );
    expect(response.status).toBe(422);
    expect(response.body.code).toBe("query_scan_limit_exceeded");
    expect(state.scalar).toBe(0);
    expect(state.decodes).toBe(0);
    expect(memory.limits).toEqual([2]);
  });

  it("corrupt rows stay query_row_invalid", async () => {
    const memory = new MemoryCheckpoints([{ projectionId: checkpointId("bad"), lastSuid: "suid-bad", stateJson: "{" }]);
    const response = await call(
      "query",
      nextId("row"),
      scalarBody({ roomId: "room-1" }),
      baseOptions(executableRegistry(probe(), "ok"), { store: memory as unknown as PipelineStore }),
    );
    expect(response).toEqual({ status: 500, body: { error: "The query projection contains an invalid row.", code: "query_row_invalid" } });
  });

  it("thrown handlers stay query_handler_failed", async () => {
    const memory = new MemoryCheckpoints(parityRows().slice(0, 1));
    const response = await call(
      "query",
      nextId("throw"),
      scalarBody({ roomId: "room-1" }),
      baseOptions(executableRegistry(probe(), "throw"), { store: memory as unknown as PipelineStore }),
    );
    expect(response.body.code).toBe("query_handler_failed");
    expect(response.status).toBe(500);
  });

  it("handler failures use the fixed safe message", async () => {
    const memory = new MemoryCheckpoints(parityRows().slice(0, 1));
    const response = await call(
      "query",
      nextId("safe"),
      scalarBody({ roomId: "room-1" }),
      baseOptions(executableRegistry(probe(), "throw"), { store: memory as unknown as PipelineStore }),
    );
    expect(response.body).toEqual({ error: "The query handler failed.", code: "query_handler_failed" });
    expect(JSON.stringify(response.body)).not.toContain("handler-secret-token");
  });

  it("post-scan quarantine wins over overflow and corrupt rows", async () => {
    const inner = materialized;
    if (inner === undefined) throw new Error("materialized view store was not initialized");
    const serviceId = nextId("post");
    const viewId = nextId("post");
    const head = g32Suid("post-head");
    await inner.createActive({ serviceId, viewId, definitionVersion: 1, updatedAt: 1, lastSuid: head });
    const state = probe();
    const port = instrumentMaterialized(inner);
    port.quarantineOnScan = true;
    port.rowsOnScan = {
      rows: [
        { rowKey: "a", valueJson: JSON.stringify({ label: "alpha" }), sourceSuid: "suid-a" },
        { rowKey: "bad", valueJson: "{", sourceSuid: "suid-bad" },
      ],
      readHead: head,
    };
    const response = await call(
      "query",
      serviceId,
      scalarBody({ roomId: "room-1" }),
      baseOptions(executableRegistry(state, "ok", viewId), { queryBacking: "d1-mv", materializedViewQueryPort: port, maxScanRows: 1 }),
    );
    expect(response.body.code).toBe("projection_ordering_quarantined");
    expect(response.status).toBe(503);
    expect(state.decodes).toBe(0);
    expect(state.scalar).toBe(0);
  });

  it("rejects malformed runtime query definitions directly", () => {
    const codec = { encode: (value: unknown) => value, decode: (value: unknown) => value };
    const scalarExecution = { kind: "scalar", rowCodec: codec, paramsCodec: codec, resultCodec: codec, handleQuery: () => ({ count: 0 }) };
    const valid = {
      queryType: "count",
      endpoint: "query" as const,
      tagGroup: TAG_GROUP,
      tagProjector: TAG_PROJECTOR,
      enabled: true,
      version: 1,
      execution: scalarExecution,
    };
    const rejects = [
      { ...valid, execution: undefined },
      { ...valid, execution: { kind: "scalar" } },
      { ...valid, execution: { ...scalarExecution, paramsCodec: { encode: () => ({}) } } },
      { ...valid, execution: { ...scalarExecution, handleQuery: undefined } },
      { ...valid, endpoint: "list-query" },
      { ...valid, execution: { kind: "list", rowCodec: codec, paramsCodec: codec, itemCodec: codec, handleFilter: () => [], handleSort: (items: unknown) => items }, endpoint: "query" },
      { ...valid, execution: { ...scalarExecution, handleFilter: () => [] } },
      { ...valid, version: 0 },
      { ...valid, version: 1.5 },
      { ...valid, queryType: "" },
      { ...valid, tagGroup: "" },
      { ...valid, enabled: "true" },
      { ...valid, materializedViewId: "" },
      { ...valid, kind: "scalar" },
      { ...valid, contract: {} },
      { ...valid, handleQuery: () => ({}) },
    ];
    for (const definition of rejects) {
      expect(() => new QueryRegistry([definition as QueryDefinition]), JSON.stringify(Object.keys(definition))).toThrow(RuntimeQueryDefinitionError);
    }
    expect(() => new QueryRegistry([
      { queryType: "same", endpoint: "query", tagGroup: TAG_GROUP, tagProjector: TAG_PROJECTOR, enabled: true },
      { queryType: "same", endpoint: "query", tagGroup: TAG_GROUP, tagProjector: TAG_PROJECTOR, enabled: true },
    ])).toThrow(RuntimeQueryDefinitionError);
    const legacy = new QueryRegistry([{ queryType: "legacy", endpoint: "query", tagGroup: TAG_GROUP, tagProjector: TAG_PROJECTOR, enabled: true }]);
    expect(Object.prototype.hasOwnProperty.call(legacy.resolve("legacy") ?? {}, "execution")).toBe(false);
  });

  it("keeps metadata-only definitions on the legacy parameter guard", async () => {
    const registry = new QueryRegistry([{ queryType: "legacy", endpoint: "query", tagGroup: TAG_GROUP, tagProjector: TAG_PROJECTOR, enabled: true }]);
    const memory = new MemoryCheckpoints([]);
    const unsupported = await call(
      "query",
      nextId("meta"),
      { queryType: "legacy", queryParamsJson: JSON.stringify({ roomId: "room-1" }) },
      baseOptions(registry, { store: memory as unknown as PipelineStore }),
    );
    expect(unsupported).toEqual({ status: 400, body: { error: "The selected query does not support these parameters.", code: "query_params_unsupported" } });
    const empty = await call(
      "query",
      nextId("meta"),
      { queryType: "legacy", queryParamsJson: "{}" },
      baseOptions(registry, { store: memory as unknown as PipelineStore }),
    );
    expect(empty).toEqual({ status: 200, body: { resultJson: JSON.stringify({ count: 0 }) } });
  });

  it("keeps a malformed wire body on validation_error", async () => {
    const response = await call(
      "query",
      nextId("wire"),
      { queryType: "count", queryParamsJson: 1 },
      baseOptions(executableRegistry(probe(), "ok"), { store: new MemoryCheckpoints([]) as unknown as PipelineStore }),
    );
    expect(response).toEqual({ status: 400, body: { error: "queryType and queryParamsJson are required", code: "validation_error" } });
  });

  it("a request cannot raise the configured scan bound", async () => {
    const memory = new MemoryCheckpoints(parityRows().slice(0, 2));
    const state = probe();
    const registry = executableRegistry(state, "ok");
    const resolved = registry.resolve("count");
    if (resolved === undefined || resolved.endpoint !== "query" || resolved.execution === undefined || resolved.execution.kind !== "scalar") throw new Error("scalar definition missing");
    const accepting = {
      ...resolved.execution.paramsCodec,
      decode(value: unknown) {
        state.params.push(value);
        return { roomId: "room-1" };
      },
    };
    const rebound = new QueryRegistry([{
      ...resolved,
      execution: { ...resolved.execution, paramsCodec: accepting },
    }]);
    const response = await call(
      "query",
      nextId("bound"),
      scalarBody({ roomId: "room-1", maxScanRows: 10_000 }),
      baseOptions(rebound, { store: memory as unknown as PipelineStore, maxScanRows: 1 }),
    );
    expect(response.status).toBe(422);
    expect(memory.limits).toEqual([2]);
    expect(state.scalar).toBe(0);
  });

  it("preserves an own __proto__ key while removing list controls", async () => {
    const state = probe();
    const response = await call(
      "list-query",
      nextId("proto"),
      { queryType: "list", queryParamsJson: "{\"__proto__\":{\"polluted\":true},\"roomId\":\"room-1\",\"PageNumber\":1}" },
      baseOptions(executableRegistry(state, "ok"), { store: new MemoryCheckpoints([]) as unknown as PipelineStore }),
    );
    expect(response.status).toBe(200);
    const seen = state.params[0];
    expect(seen).toMatchObject({ roomId: "room-1" });
    expect(Object.prototype.hasOwnProperty.call(seen, "__proto__")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(seen, "PageNumber")).toBe(false);
    expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("passes configured maxScanRows through both worker factories", async () => {
    const room = tagFamily("room");
    const noted = event("RoomNoted", z.object({ roomId: z.string() }), { tags: (payload) => [room.of(payload.roomId)] });
    const board = projector({
      id: TAG_PROJECTOR,
      tag: room,
      events: [noted],
      initialState: { label: "" },
      handlers: { RoomNoted: (state) => state },
    });
    const view = defineQueryView({ id: "activation-view", version: 1, row: z.strictObject({ label: z.string() }) });
    const list = defineListQuery({
      id: "activation-list",
      version: 1,
      source: view,
      params: z.strictObject({ roomId: z.string() }),
      item: z.strictObject({ label: z.string() }),
      handleFilter: (projection) => projection.rows.map((row) => ({ label: row.value.label })),
      handleSort: (items) => items,
    });
    const runtime = toRuntimeDomain(domain({
      events: [noted],
      projectors: [board],
      views: [{ id: view.id, source: board.id }],
      queries: [list],
    }));
    const rows = [checkpointId("a"), checkpointId("n")].map((projectionId, index) => ({
      projectionId,
      lastSuid: index === 0 ? "suid-a" : "suid-n",
      stateJson: JSON.stringify({ label: index === 0 ? "alpha" : "north" }),
    }));
    const memory = new MemoryCheckpoints(rows);
    const provider = { name: "memory", create: () => memory as unknown as PipelineStore };
    const limited = createRuntimeWorker({ domain: runtime, config: { maxScanRows: 1 }, storeProvider: provider, queryBacking: "memory" });
    const open = createRuntimeWorker({ domain: runtime, storeProvider: provider, queryBacking: "memory" });
    const body = JSON.stringify({ queryType: "activation-list", queryParamsJson: JSON.stringify({ roomId: "room-1", PageSize: 20 }) });
    const serviceId = nextId("factory");
    const limitedFetch = limited.fetch as (request: Request, workerEnv: unknown, ctx: ExecutionContext) => Promise<Response>;
    const openFetch = open.fetch as (request: Request, workerEnv: unknown, ctx: ExecutionContext) => Promise<Response>;
    const ctx = { waitUntil() {} } as unknown as ExecutionContext;
    const limitedResponse = await limitedFetch(request("list-query", serviceId, JSON.parse(body)), env, ctx);
    expect(limitedResponse.status).toBe(422);
    expect(await limitedResponse.json()).toMatchObject({ code: "query_scan_limit_exceeded" });
    const openResponse = await openFetch(request("list-query", serviceId, JSON.parse(body)), env, ctx);
    expect(openResponse.status).toBe(200);
    const database = mvDatabase();
    const mvService = nextId("cf");
    const head = g32Suid("factory-head");
    const store = materialized;
    if (store === undefined) throw new Error("materialized view store was not initialized");
    const created = await store.createActive({ serviceId: mvService, viewId: "activation-view", definitionVersion: 1, updatedAt: 1, lastSuid: head });
    for (const row of [{ key: "a", label: "alpha" }, { key: "n", label: "north" }]) {
      await database.prepare(
        `INSERT INTO mv_rows (service_id, view_id, generation, row_key, value_json, row_version, source_suid) VALUES (?, ?, ?, ?, ?, 1, ?)`,
      ).bind(mvService, "activation-view", created.generation, row.key, JSON.stringify({ label: row.label }), `suid-${row.key}`).run();
    }
    const cloudflareLimited = createCloudflareOnlyRuntimeWorker({ domain: runtime, config: { maxScanRows: 1 } });
    const cloudflareOpen = createCloudflareOnlyRuntimeWorker({ domain: runtime });
    const cloudflareFetch = (worker: ReturnType<typeof createCloudflareOnlyRuntimeWorker>) =>
      worker.fetch as (request: Request, workerEnv: CloudflareOnlyEnv, ctx: ExecutionContext) => Promise<Response>;
    const workerEnv = { ...(env as unknown as CloudflareOnlyEnv), SDT_SERVICE_ID: mvService };
    const cloudflareDenied = await cloudflareFetch(cloudflareLimited)(request("list-query", mvService, JSON.parse(body)), workerEnv, ctx);
    expect(cloudflareDenied.status).toBe(422);
    const cloudflareAllowed = await cloudflareFetch(cloudflareOpen)(request("list-query", mvService, JSON.parse(body)), workerEnv, ctx);
    expect(cloudflareAllowed.status).toBe(200);
  }, 60_000);
});
