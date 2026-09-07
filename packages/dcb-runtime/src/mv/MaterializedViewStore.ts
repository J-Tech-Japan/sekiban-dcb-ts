import {
  assertJsonValue,
  type JsonValue,
  type MaterializedViewIndexValueType,
  type MaterializedViewMutationPlan,
} from "@sekiban/dcb-core";
import { assertSortableUniqueId } from "../allocator/SortableUniqueId";
import { UnsafeWindowMaterializedViewStore, type UnsafeComposedPage } from "./UnsafeWindowMaterializedView";

type D1Row = Record<string, unknown>;

export type MaterializedViewStoreOperation =
  | "initialize"
  | "create-active"
  | "create-candidate"
  | "apply"
  | "promote";

export type MaterializedViewStoreErrorCode =
  | "MV_STORE_NOT_INITIALIZED"
  | "MV_INSTANCE_EXISTS"
  | "MV_INSTANCE_MISSING"
  | "MV_CAS_MISMATCH"
  | "MV_PROMOTION_CAS_MISMATCH"
  | "MV_GENERATION_INVALID"
  | "MV_PATCH_ROW_MISSING"
  | "MV_VALUE_INVALID"
  | "MV_ORDERING_QUARANTINED"
  | "MV_STORE_OPERATION_FAILED";

export class MaterializedViewStoreError extends Error {
  constructor(
    readonly operation: MaterializedViewStoreOperation,
    readonly code: MaterializedViewStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MaterializedViewStoreError";
  }
}

/** A stale MV checkpoint is a failed atomic call, never a successful no-op. */
export class MaterializedViewCasError extends MaterializedViewStoreError {
  constructor(message = "Materialized-view checkpoint CAS did not match") {
    super("apply", "MV_CAS_MISMATCH", message);
    this.name = "MaterializedViewCasError";
  }
}

export class MaterializedViewPromotionCasError extends MaterializedViewStoreError {
  constructor(message = "Materialized-view active-generation CAS did not match") {
    super("promote", "MV_PROMOTION_CAS_MISMATCH", message);
    this.name = "MaterializedViewPromotionCasError";
  }
}

export class MaterializedViewPatchError extends MaterializedViewStoreError {
  constructor(message = "Materialized-view JSON patch target row does not exist") {
    super("apply", "MV_PATCH_ROW_MISSING", message);
    this.name = "MaterializedViewPatchError";
  }
}

export interface MaterializedViewInstance {
  readonly serviceId: string;
  readonly viewId: string;
  readonly generation: number;
  readonly status: "active" | "candidate" | "retired";
  readonly lastSuid: string;
  readonly definitionVersion: number;
  readonly updatedAt: number;
}

export interface MaterializedViewRow {
  readonly serviceId: string;
  readonly viewId: string;
  readonly generation: number;
  readonly rowKey: string;
  readonly value: JsonValue;
  readonly rowVersion: number;
  readonly sourceSuid: string;
}

export interface MaterializedViewIndexEntry {
  readonly serviceId: string;
  readonly viewId: string;
  readonly generation: number;
  readonly indexId: string;
  readonly valueType: MaterializedViewIndexValueType;
  readonly value: string | number;
  readonly rowKey: string;
}

export interface MaterializedViewCreateInput {
  readonly serviceId: string;
  readonly viewId: string;
  readonly generation?: number;
  readonly definitionVersion: number;
  readonly updatedAt: number;
  readonly lastSuid?: string;
}

export interface MaterializedViewCandidateInput extends MaterializedViewCreateInput {
  readonly generation: number;
}

export interface MaterializedViewApplyInput {
  readonly serviceId: string;
  readonly viewId: string;
  readonly generation: number;
  readonly expectedLastSuid: string | null;
  readonly lastSuid: string;
  readonly definitionVersion: number;
  readonly updatedAt: number;
  readonly mutations: MaterializedViewMutationPlan;
}

export interface MaterializedViewApplyResult {
  readonly instance: MaterializedViewInstance;
  readonly rowUpserts: number;
  readonly rowDeletes: number;
  readonly rowPatches: number;
  readonly indexEntries: number;
}

export interface MaterializedViewPromoteInput {
  readonly serviceId: string;
  readonly viewId: string;
  readonly candidateGeneration: number;
  readonly expectedActiveGeneration: number | null;
  readonly updatedAt: number;
}

export interface MaterializedViewQueryOptions {
  readonly generation?: number;
  readonly indexId?: string;
  readonly valueType?: MaterializedViewIndexValueType;
  /** `null` means unbounded; omitted retains the port's 100-row default. */
  readonly limit?: number | null;
  readonly offset?: number;
  /** Fixed boolean order selector; request data never becomes a SQL fragment. */
  readonly descending?: boolean;
}

/** The list surface must choose whether it can see the exceptional unsafe lane. */
export type MaterializedViewListConsistency = "safe" | "unsafe";

export interface MaterializedViewListOptions extends MaterializedViewQueryOptions {
  /** Omitted is deliberately safe; unsafe visibility is never an accidental fallback. */
  readonly consistency?: MaterializedViewListConsistency;
}

/** A server-paged list response and the watermark that actually backs that response. */
export interface MaterializedViewListPage {
  readonly rows: readonly MaterializedViewRow[];
  readonly totalCount: number;
  readonly readHead: string;
}

/**
 * One active-generation snapshot used by the SDT-G31 d1-mv waitFor path.
 * `targetReceipt` is deliberately separate from `safeContiguousHead`: the
 * latter can only complete a wait after the source target has been proved
 * unique by the paired PipelineStore point lookup.
 */
export interface MaterializedViewWaitForState {
  readonly activeGeneration: number | undefined;
  readonly activeDefinitionVersion: number | undefined;
  readonly safeContiguousHead: string;
  readonly targetReceipt: boolean;
  readonly checkpointAhead: boolean;
  readonly rebuildRequired: boolean;
  readonly poison: boolean;
}

export type MaterializedViewOrderingQuarantineClassification = "LATE_LOWER_SUID" | "ORDER_VIOLATION";

export interface MaterializedViewOrderingQuarantine {
  readonly serviceId: string;
  readonly viewId: string;
  readonly generation: number;
  readonly checkpointSuid: string;
  readonly lateSuid: string;
  readonly eventId: string;
  readonly classification: MaterializedViewOrderingQuarantineClassification;
  readonly status: "open" | "resolved";
  readonly observedAt: number;
  readonly resolvedAt: number | null;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`MV ${name} was not a string`);
  return value;
}

function asInteger(value: unknown, name: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`MV ${name} was not a safe integer`);
  return number;
}

function asStatus(value: unknown): MaterializedViewInstance["status"] {
  if (value === "active" || value === "candidate" || value === "retired") return value;
  throw new Error("MV instance status was invalid");
}

/** V1 SUID comparison is bytewise ordinal, never locale-aware. */
function compareSuid(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function maxReflectedSuid(rows: readonly MaterializedViewRow[]): string {
  let maximum = "";
  for (const row of rows) {
    if (maximum === "" || compareSuid(row.sourceSuid, maximum) > 0) maximum = row.sourceSuid;
  }
  return maximum;
}

function instanceFrom(row: D1Row): MaterializedViewInstance {
  return {
    serviceId: asString(row.service_id, "service_id"),
    viewId: asString(row.view_id, "view_id"),
    generation: asInteger(row.generation, "generation"),
    status: asStatus(row.status),
    lastSuid: asString(row.last_suid, "last_suid"),
    definitionVersion: asInteger(row.definition_version, "definition_version"),
    updatedAt: asInteger(row.updated_at, "updated_at"),
  };
}

function valueType(value: unknown): MaterializedViewIndexValueType {
  if (value === "text" || value === "integer" || value === "real") return value;
  throw new Error("MV index value type was invalid");
}

function indexValue(row: D1Row, type: MaterializedViewIndexValueType): string | number {
  if (type === "text") return asString(row.text_value, "text_value");
  const number = typeof row[`${type}_value`] === "number" ? row[`${type}_value`] as number : Number(row[`${type}_value`]);
  if (!Number.isFinite(number) || (type === "integer" && !Number.isSafeInteger(number))) {
    throw new Error(`MV ${type}_value was invalid`);
  }
  return number;
}

function operationId(): string {
  return `mv-${crypto.randomUUID()}`;
}

function isCasFailure(error: unknown): boolean {
  const message = String(error);
  return message.includes("mv_atomic_guards.checkpoint_match") || message.includes("MV_CAS_MISMATCH");
}

function isPatchFailure(error: unknown): boolean {
  return String(error).includes("CHECK constraint failed: checkpoint_match");
}

/**
 * Production D1 persistence for row-backed materialized views.  Every apply
 * call is a single predeclared D1 batch.  The NOT NULL guard statement is
 * deliberately first: if the expected checkpoint is stale it aborts the
 * batch, so row/index/checkpoint regions cannot partially advance.
 */
export class D1MaterializedViewStore {
  private initialized = false;
  private readonly unsafe: UnsafeWindowMaterializedViewStore;

  constructor(private readonly database: D1Database) {
    this.unsafe = new UnsafeWindowMaterializedViewStore(database);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.database.prepare("SELECT 1 FROM mv_instances LIMIT 1").all();
    await this.database.prepare("SELECT 1 FROM mv_atomic_guards LIMIT 1").all();
    await this.database.prepare("SELECT 1 FROM mv_checkpoint_ahead_findings LIMIT 1").all();
    await this.database.prepare("SELECT 1 FROM mv_ordering_quarantines LIMIT 1").all();
    this.initialized = true;
  }

  async createActive(input: MaterializedViewCreateInput): Promise<MaterializedViewInstance> {
    this.ready("create-active");
    const generation = input.generation ?? 0;
    this.validateGeneration(generation, "create-active");
    const lastSuid = input.lastSuid ?? "";
    if (lastSuid.length > 0) assertSortableUniqueId(lastSuid);
    try {
      await this.database.batch([
        this.database.prepare(
          `INSERT INTO mv_instances
             (service_id, view_id, generation, status, last_suid, definition_version, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?)`,
        ).bind(input.serviceId, input.viewId, generation, lastSuid, input.definitionVersion, input.updatedAt),
        this.database.prepare(
          `INSERT INTO mv_active_generations (service_id, view_id, generation, updated_at)
           VALUES (?, ?, ?, ?)`,
        ).bind(input.serviceId, input.viewId, generation, input.updatedAt),
      ]);
    } catch (error) {
      throw new MaterializedViewStoreError("create-active", "MV_INSTANCE_EXISTS", `Active materialized view already exists: ${String(error)}`, { cause: error });
    }
    return this.readInstance(input.serviceId, input.viewId, generation) as Promise<MaterializedViewInstance>;
  }

  async createCandidate(input: MaterializedViewCandidateInput): Promise<MaterializedViewInstance> {
    this.ready("create-candidate");
    this.validateGeneration(input.generation, "create-candidate");
    if ((input.lastSuid ?? "").length > 0) assertSortableUniqueId(input.lastSuid!);
    try {
      await this.database.prepare(
        `INSERT INTO mv_instances
           (service_id, view_id, generation, status, last_suid, definition_version, updated_at)
         VALUES (?, ?, ?, 'candidate', ?, ?, ?)`,
      ).bind(
        input.serviceId,
        input.viewId,
        input.generation,
        input.lastSuid ?? "",
        input.definitionVersion,
        input.updatedAt,
      ).run();
    } catch (error) {
      throw new MaterializedViewStoreError("create-candidate", "MV_INSTANCE_EXISTS", `Candidate generation already exists: ${String(error)}`, { cause: error });
    }
    return this.readInstance(input.serviceId, input.viewId, input.generation) as Promise<MaterializedViewInstance>;
  }

  async beginRebuild(input: Omit<MaterializedViewCandidateInput, "generation"> & { readonly generation?: number }): Promise<MaterializedViewInstance> {
    this.ready("create-candidate");
    const generation = input.generation ?? await this.nextGeneration(input.serviceId, input.viewId);
    return this.createCandidate({ ...input, generation });
  }

  async nextGeneration(serviceId: string, viewId: string): Promise<number> {
    this.ready("create-candidate");
    const row = await this.database.prepare(
      `SELECT COALESCE(MAX(generation), -1) AS generation FROM mv_instances WHERE service_id = ? AND view_id = ?`,
    ).bind(serviceId, viewId).first<D1Row>();
    return asInteger(row?.generation ?? -1, "generation") + 1;
  }

  async readInstance(serviceId: string, viewId: string, generation: number): Promise<MaterializedViewInstance | undefined> {
    this.ready("initialize");
    const row = await this.database.prepare(
      `SELECT service_id, view_id, generation, status, last_suid, definition_version, updated_at
         FROM mv_instances WHERE service_id = ? AND view_id = ? AND generation = ?`,
    ).bind(serviceId, viewId, generation).first<D1Row>();
    return row === null || row === undefined ? undefined : instanceFrom(row);
  }

  async readActive(serviceId: string, viewId: string): Promise<MaterializedViewInstance | undefined> {
    this.ready("initialize");
    const row = await this.database.prepare(
      `SELECT instance.service_id, instance.view_id, instance.generation, instance.status,
              instance.last_suid, instance.definition_version, instance.updated_at
         FROM mv_active_generations pointer
         JOIN mv_instances instance
           ON instance.service_id = pointer.service_id
          AND instance.view_id = pointer.view_id
          AND instance.generation = pointer.generation
        WHERE pointer.service_id = ? AND pointer.view_id = ?`,
    ).bind(serviceId, viewId).first<D1Row>();
    return row === null || row === undefined ? undefined : instanceFrom(row);
  }

  async readRows(serviceId: string, viewId: string, generation?: number): Promise<MaterializedViewRow[]> {
    this.ready("initialize");
    const selected = generation ?? (await this.readActive(serviceId, viewId))?.generation;
    if (selected === undefined) return [];
    const result = await this.database.prepare(
      `SELECT service_id, view_id, generation, row_key, value_json, row_version, source_suid
         FROM mv_rows
        WHERE service_id = ? AND view_id = ? AND generation = ?
        ORDER BY row_key COLLATE BINARY ASC`,
    ).bind(serviceId, viewId, selected).all<D1Row>();
    return result.results.map((row) => this.rowFrom(row));
  }

  async readIndexEntries(serviceId: string, viewId: string, generation?: number): Promise<MaterializedViewIndexEntry[]> {
    this.ready("initialize");
    const selected = generation ?? (await this.readActive(serviceId, viewId))?.generation;
    if (selected === undefined) return [];
    const result = await this.database.prepare(
      `SELECT service_id, view_id, generation, index_id, value_type,
              text_value, integer_value, real_value, row_key
         FROM mv_index_entries
        WHERE service_id = ? AND view_id = ? AND generation = ?
        ORDER BY index_id COLLATE BINARY ASC, value_type COLLATE BINARY ASC,
                 COALESCE(text_value, CAST(integer_value AS TEXT), CAST(real_value AS TEXT)) COLLATE BINARY ASC,
                 row_key COLLATE BINARY ASC`,
    ).bind(serviceId, viewId, selected).all<D1Row>();
    return result.results.map((row) => this.indexFrom(row));
  }

  /** Read rows through a declared index without exposing SQL identifiers to callers. */
  async queryRows(serviceId: string, viewId: string, options: MaterializedViewQueryOptions = {}): Promise<MaterializedViewRow[]> {
    this.ready("initialize");
    const selected = options.generation ?? (await this.readActive(serviceId, viewId))?.generation;
    if (selected === undefined) return [];
    const limit = options.limit === undefined ? 100 : options.limit;
    const offset = options.offset ?? 0;
    if ((limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) || !Number.isSafeInteger(offset) || offset < 0) {
      throw new MaterializedViewStoreError("initialize", "MV_VALUE_INVALID", "MV query limit/offset must be non-negative integers");
    }
    if (options.indexId === undefined) {
      const limitClause = limit === null ? "" : " LIMIT ? OFFSET ?";
      const direction = options.descending === true ? "DESC" : "ASC";
      const values: (string | number)[] = [serviceId, viewId, selected];
      if (limit !== null) values.push(limit, offset);
      const result = await this.database.prepare(
        `SELECT service_id, view_id, generation, row_key, value_json, row_version, source_suid
           FROM mv_rows
          WHERE service_id = ? AND view_id = ? AND generation = ?
          ORDER BY row_key COLLATE BINARY ${direction}${limitClause}`,
      ).bind(...values).all<D1Row>();
      return result.results.map((row) => this.rowFrom(row));
    }
    const valueType = options.valueType;
    // COLLATE BINARY is meaningful for text and row-key tie breakers. SQLite
    // keeps integer/real columns numerically ordered; the closed expression
    // below remains static so request values never become SQL identifiers.
    const orderColumn = valueType === "text"
      ? "index_entry.text_value"
      : valueType === "integer"
        ? "index_entry.integer_value"
        : valueType === "real"
          ? "index_entry.real_value"
          : "index_entry.row_key";
    const direction = options.descending === true ? "DESC" : "ASC";
    const indexPredicate = options.indexId === undefined ? "" : " AND index_entry.index_id = ?";
    const typePredicate = valueType === undefined ? "" : " AND index_entry.value_type = ?";
    const values: (string | number)[] = [serviceId, viewId, selected];
    if (options.indexId !== undefined) values.push(options.indexId);
    if (valueType !== undefined) values.push(valueType);
    if (limit !== null) values.push(limit, offset);
    const limitClause = limit === null ? "" : " LIMIT ? OFFSET ?";
    const result = await this.database.prepare(
      `SELECT row.service_id, row.view_id, row.generation, row.row_key,
              row.value_json, row.row_version, row.source_suid
         FROM mv_index_entries index_entry
         JOIN mv_rows row
           ON row.service_id = index_entry.service_id
          AND row.view_id = index_entry.view_id
          AND row.generation = index_entry.generation
          AND row.row_key = index_entry.row_key
        WHERE row.service_id = ? AND row.view_id = ? AND row.generation = ?${indexPredicate}${typePredicate}
        ORDER BY ${orderColumn} COLLATE BINARY ${direction}, row.row_key COLLATE BINARY ${direction}${limitClause}`,
    ).bind(...values).all<D1Row>();
    return result.results.map((row) => this.rowFrom(row));
  }

  /** SDT-G23 composed server page; count and page rows share one statement. */
  async queryRowsWithTotal(serviceId: string, viewId: string, options: MaterializedViewQueryOptions = {}): Promise<UnsafeComposedPage> {
    this.ready("initialize");
    const selected = options.generation ?? (await this.readActive(serviceId, viewId))?.generation;
    if (selected === undefined) return { rows: [], totalCount: 0 };
    // Scalar V1 queries pass `limit: null` to retain their legacy unpaged
    // result. SQLite uses LIMIT -1 for that one-statement composed read.
    const limit: number = options.limit === null ? -1 : options.limit === undefined ? 100 : options.limit;
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < -1 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new MaterializedViewStoreError("initialize", "MV_VALUE_INVALID", "MV composed query needs limit -1 or a non-negative limit/offset");
    }
    return this.unsafe.queryComposedPage(serviceId, viewId, selected, limit, offset, options.descending === true);
  }

  /**
   * SDT-G55's explicit list-read port.  Existing composed reads intentionally
   * keep their G23 semantics; only this port can include unsafe rows, and it
   * can include only rows newer than the active safe checkpoint.
   */
  async readListPage(serviceId: string, viewId: string, options: MaterializedViewListOptions = {}): Promise<MaterializedViewListPage> {
    this.ready("initialize");
    const active = await this.readActive(serviceId, viewId);
    if (active === undefined) return { rows: [], totalCount: 0, readHead: "" };
    const selected = options.generation ?? active.generation;
    const limit = options.limit === null ? -1 : options.limit === undefined ? 100 : options.limit;
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < -1 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new MaterializedViewStoreError("initialize", "MV_VALUE_INVALID", "MV list query needs limit -1 or a non-negative limit/offset");
    }
    if (options.indexId !== undefined || options.valueType !== undefined) {
      throw new MaterializedViewStoreError("initialize", "MV_VALUE_INVALID", "MV list query does not support an index selector");
    }
    const direction = options.descending === true ? "DESC" : "ASC";
    const safeRows = `SELECT row_key, value_json, row_version, source_suid, 0 AS tombstone, 0 AS unsafe_layer FROM mv_rows
          WHERE service_id = ? AND view_id = ? AND generation = ?`;
    const result = options.consistency === "unsafe"
      ? await this.database.prepare(
        `WITH candidates AS (
           ${safeRows}
           UNION ALL
           SELECT row_key, value_json, row_version, source_suid, tombstone, 1 AS unsafe_layer FROM mv_unsafe_rows
            WHERE service_id = ? AND view_id = ? AND generation = ?
              AND source_suid COLLATE BINARY > ? COLLATE BINARY
         ), ranked AS (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY row_key ORDER BY source_suid COLLATE BINARY DESC, unsafe_layer ASC) AS winner_rank FROM candidates
         ), live AS (
           SELECT *, COUNT(*) OVER() AS total_count FROM ranked WHERE winner_rank = 1 AND tombstone = 0
         )
         SELECT row_key, value_json, row_version, source_suid, total_count FROM live
         ORDER BY source_suid COLLATE BINARY ${direction}, row_key COLLATE BINARY ${direction} LIMIT ? OFFSET ?`,
      ).bind(serviceId, viewId, selected, serviceId, viewId, selected, active.lastSuid, limit, offset).all<D1Row>()
      : await this.database.prepare(
        `WITH live AS (
           SELECT row_key, value_json, row_version, source_suid, COUNT(*) OVER() AS total_count FROM mv_rows
            WHERE service_id = ? AND view_id = ? AND generation = ?
         )
         SELECT row_key, value_json, row_version, source_suid, total_count FROM live
         ORDER BY source_suid COLLATE BINARY ${direction}, row_key COLLATE BINARY ${direction} LIMIT ? OFFSET ?`,
      ).bind(serviceId, viewId, selected, limit, offset).all<D1Row>();
    const rows = result.results.map((row) => ({
      serviceId,
      viewId,
      generation: selected,
      rowKey: asString(row.row_key, "row_key"),
      value: assertJsonValue(JSON.parse(asString(row.value_json, "value_json")), "state-persistence"),
      rowVersion: asInteger(row.row_version, "row_version"),
      sourceSuid: asString(row.source_suid, "source_suid"),
    }));
    return {
      rows,
      totalCount: result.results.length === 0 ? 0 : asInteger(result.results[0]!.total_count, "total_count"),
      // Safe reads report the active checkpoint even for an empty page. Unsafe
      // reads instead report only what this page actually reflected.
      readHead: options.consistency === "unsafe" ? maxReflectedSuid(rows) : active.lastSuid,
    };
  }

  /** Explicit unsafe port: callers must choose this exceptional immediate lane. */
  unsafeWindow(): UnsafeWindowMaterializedViewStore {
    this.ready("apply");
    return this.unsafe;
  }

  /** Runs repairable unsafe GC after an idle or advancing safe catch-up pass. */
  async collectUnsafeGarbage(serviceId: string, viewId: string, generation: number, definitionVersion: number, safeHead: string): Promise<number> {
    this.ready("apply");
    return this.unsafe.collectEligible(serviceId, viewId, generation, definitionVersion, safeHead);
  }

  async hasTargetReceipt(serviceId: string, viewId: string, eventId: string, suid: string): Promise<boolean> {
    this.ready("initialize");
    return this.unsafe.hasTargetReceipt(serviceId, viewId, eventId, suid);
  }

  /**
   * Read all G31 wait facts in one static D1 statement. Every table access is
   * keyed by service/view/active generation (and target identity where
   * applicable); no row or source-history scan is permitted on this path.
   */
  async readWaitForState(
    serviceId: string,
    viewId: string,
    target: { readonly eventId?: string; readonly suid: string },
  ): Promise<MaterializedViewWaitForState> {
    this.ready("initialize");
    const row = await this.database.prepare(
      `WITH active AS (
         SELECT instance.generation, instance.definition_version, instance.last_suid
           FROM mv_active_generations pointer
           JOIN mv_instances instance
             ON instance.service_id = pointer.service_id
            AND instance.view_id = pointer.view_id
            AND instance.generation = pointer.generation
          WHERE pointer.service_id = ? AND pointer.view_id = ?
       )
       SELECT
         (SELECT generation FROM active) AS active_generation,
         (SELECT definition_version FROM active) AS active_definition_version,
         COALESCE((SELECT last_suid FROM active), '') AS safe_contiguous_head,
         CASE WHEN EXISTS (
           SELECT 1
             FROM mv_wait_receipts receipt
             JOIN active
               ON active.generation = receipt.generation
              AND active.definition_version = receipt.definition_version
            WHERE receipt.service_id = ? AND receipt.view_id = ?
              AND receipt.event_id = ? AND receipt.suid = ?
         ) THEN 1 ELSE 0 END AS target_receipt,
         CASE WHEN EXISTS (
           SELECT 1
             FROM mv_checkpoint_ahead_findings finding
             JOIN active
               ON active.generation = finding.generation
            WHERE finding.service_id = ? AND finding.view_id = ?
         ) THEN 1 ELSE 0 END AS checkpoint_ahead,
         COALESCE((
           SELECT arrival.rebuild_required
             FROM mv_unsafe_arrivals arrival
             JOIN active
               ON active.generation = arrival.generation
            WHERE arrival.service_id = ? AND arrival.view_id = ?
         ), 0) AS rebuild_required,
         CASE WHEN EXISTS (
           SELECT 1
             FROM mv_wait_target_poison finding
             JOIN active
               ON active.generation = finding.generation
              AND active.definition_version = finding.definition_version
            WHERE finding.service_id = ? AND finding.view_id = ?
              AND finding.suid = ?
              AND (? IS NULL OR finding.event_id = ?)
         ) THEN 1 ELSE 0 END AS poison`,
    ).bind(
      serviceId,
      viewId,
      serviceId,
      viewId,
      target.eventId ?? "",
      target.suid,
      serviceId,
      viewId,
      serviceId,
      viewId,
      serviceId,
      viewId,
      target.suid,
      target.eventId ?? null,
      target.eventId ?? null,
    ).first<D1Row>();
    if (row === null || row === undefined) {
      throw new MaterializedViewStoreError("initialize", "MV_STORE_OPERATION_FAILED", "D1 wait-state query returned no row");
    }
    const generation = row.active_generation === null || row.active_generation === undefined
      ? undefined
      : asInteger(row.active_generation, "active_generation");
    const definitionVersion = row.active_definition_version === null || row.active_definition_version === undefined
      ? undefined
      : asInteger(row.active_definition_version, "active_definition_version");
    return {
      activeGeneration: generation,
      activeDefinitionVersion: definitionVersion,
      safeContiguousHead: asString(row.safe_contiguous_head, "safe_contiguous_head"),
      targetReceipt: asInteger(row.target_receipt, "target_receipt") === 1,
      checkpointAhead: asInteger(row.checkpoint_ahead, "checkpoint_ahead") === 1,
      rebuildRequired: asInteger(row.rebuild_required, "rebuild_required") === 1,
      poison: asInteger(row.poison, "poison") === 1,
    };
  }

  /** Idempotent operational fact: a stored Queue event needs unsafe retry/DLQ attention. */
  async recordUnsafeFailureFinding(input: {
    readonly serviceId: string;
    readonly viewId: string;
    /** The failed view generation when known; omitted binds the active one. */
    readonly generation?: number;
    readonly eventId: string;
    readonly suid: string;
    readonly observedAt: number;
  }): Promise<void> {
    this.ready("apply");
    const legacyFinding = this.database.prepare(
      `INSERT INTO mv_unsafe_failure_findings
         (service_id, view_id, event_id, suid, classification, observed_at)
       VALUES (?, ?, ?, ?, 'UNSAFE_APPLY_RETRY', ?)
       ON CONFLICT (service_id, view_id, event_id, suid, classification) DO NOTHING`,
    ).bind(input.serviceId, input.viewId, input.eventId, input.suid, input.observedAt);
    const targetPoison = input.generation === undefined
      ? this.database.prepare(
        `INSERT INTO mv_wait_target_poison
           (service_id, view_id, generation, definition_version, event_id, suid, classification, observed_at)
         SELECT instance.service_id, instance.view_id, instance.generation, instance.definition_version, ?, ?, 'UNSAFE_APPLY_RETRY', ?
           FROM mv_active_generations active
           JOIN mv_instances instance
             ON instance.service_id = active.service_id
            AND instance.view_id = active.view_id
            AND instance.generation = active.generation
          WHERE active.service_id = ? AND active.view_id = ?
         ON CONFLICT DO NOTHING`,
      ).bind(input.eventId, input.suid, input.observedAt, input.serviceId, input.viewId)
      : this.database.prepare(
        `INSERT INTO mv_wait_target_poison
           (service_id, view_id, generation, definition_version, event_id, suid, classification, observed_at)
         SELECT instance.service_id, instance.view_id, instance.generation, instance.definition_version, ?, ?, 'UNSAFE_APPLY_RETRY', ?
           FROM mv_instances instance
          WHERE instance.service_id = ? AND instance.view_id = ? AND instance.generation = ?
         ON CONFLICT DO NOTHING`,
      ).bind(input.eventId, input.suid, input.observedAt, input.serviceId, input.viewId, input.generation);
    await this.database.batch([legacyFinding, targetPoison]);
  }

  /**
   * Persist the source-reset observation exactly once for the affected
   * generation.  This deliberately never rewinds `mv_instances.last_suid`.
   */
  async recordCheckpointAhead(input: {
    readonly serviceId: string;
    readonly viewId: string;
    readonly generation: number;
    readonly checkpointSuid: string;
    readonly storeMaxSuid: string;
    readonly observedAt: number;
  }): Promise<void> {
    this.ready("apply");
    await this.database.prepare(
      `INSERT INTO mv_checkpoint_ahead_findings
         (service_id, view_id, generation, checkpoint_suid, store_max_suid, observed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (service_id, view_id, generation) DO NOTHING`,
    ).bind(
      input.serviceId,
      input.viewId,
      input.generation,
      input.checkpointSuid,
      input.storeMaxSuid,
      input.observedAt,
    ).run();
  }

  /** An open finding on the active generation fail-closes composed MV reads. */
  async hasCheckpointAheadFinding(serviceId: string, viewId: string): Promise<boolean> {
    this.ready("initialize");
    const result = await this.database.prepare(
      `SELECT 1 AS present
         FROM mv_checkpoint_ahead_findings finding
         JOIN mv_active_generations active
           ON active.service_id = finding.service_id
          AND active.view_id = finding.view_id
          AND active.generation = finding.generation
        WHERE finding.service_id = ? AND finding.view_id = ?
        LIMIT 1`,
    ).bind(serviceId, viewId).first<{ present: number }>();
    return result?.present === 1;
  }

  /** Open quarantine is keyed to the active generation; old generations are not a public read gate. */
  async readOrderingQuarantine(serviceId: string, viewId: string): Promise<MaterializedViewOrderingQuarantine | undefined> {
    this.ready("initialize");
    const row = await this.database.prepare(
      `SELECT quarantine.service_id, quarantine.view_id, quarantine.generation,
              quarantine.checkpoint_suid, quarantine.late_suid, quarantine.event_id,
              quarantine.classification, quarantine.status, quarantine.observed_at,
              quarantine.resolved_at
         FROM mv_ordering_quarantines quarantine
         JOIN mv_active_generations active
           ON active.service_id = quarantine.service_id
          AND active.view_id = quarantine.view_id
          AND active.generation = quarantine.generation
        WHERE quarantine.service_id = ? AND quarantine.view_id = ? AND quarantine.status = 'open'
        LIMIT 1`,
    ).bind(serviceId, viewId).first<D1Row>();
    if (row === null || row === undefined) return undefined;
    const classification = asString(row.classification, "ordering_quarantine.classification");
    if (classification !== "LATE_LOWER_SUID" && classification !== "ORDER_VIOLATION") {
      throw new MaterializedViewStoreError("initialize", "MV_STORE_OPERATION_FAILED", "Materialized-view ordering quarantine classification was invalid");
    }
    const status = asString(row.status, "ordering_quarantine.status");
    if (status !== "open" && status !== "resolved") {
      throw new MaterializedViewStoreError("initialize", "MV_STORE_OPERATION_FAILED", "Materialized-view ordering quarantine status was invalid");
    }
    return {
      serviceId: asString(row.service_id, "ordering_quarantine.service_id"),
      viewId: asString(row.view_id, "ordering_quarantine.view_id"),
      generation: asInteger(row.generation, "ordering_quarantine.generation"),
      checkpointSuid: asString(row.checkpoint_suid, "ordering_quarantine.checkpoint_suid"),
      lateSuid: asString(row.late_suid, "ordering_quarantine.late_suid"),
      eventId: asString(row.event_id, "ordering_quarantine.event_id"),
      classification,
      status,
      observedAt: asInteger(row.observed_at, "ordering_quarantine.observed_at"),
      resolvedAt: row.resolved_at === null || row.resolved_at === undefined
        ? null
        : asInteger(row.resolved_at, "ordering_quarantine.resolved_at"),
    };
  }

  /** Persist the detector result before stopping the safe pass. Repeated observations are idempotent. */
  async recordOrderingQuarantine(input: {
    readonly serviceId: string;
    readonly viewId: string;
    readonly generation: number;
    readonly checkpointSuid: string;
    readonly lateSuid: string;
    readonly eventId: string;
    readonly classification: MaterializedViewOrderingQuarantineClassification;
    readonly observedAt: number;
  }): Promise<void> {
    this.ready("apply");
    this.validateGeneration(input.generation, "apply");
    await this.database.prepare(
      `INSERT INTO mv_ordering_quarantines
         (service_id, view_id, generation, checkpoint_suid, late_suid, event_id, classification, status, observed_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL)
       ON CONFLICT (service_id, view_id, generation) DO UPDATE SET
         checkpoint_suid = excluded.checkpoint_suid,
         late_suid = excluded.late_suid,
         event_id = excluded.event_id,
         classification = excluded.classification,
         status = 'open',
         observed_at = MIN(mv_ordering_quarantines.observed_at, excluded.observed_at),
         resolved_at = NULL`,
    ).bind(
      input.serviceId,
      input.viewId,
      input.generation,
      input.checkpointSuid,
      input.lateSuid,
      input.eventId,
      input.classification,
      input.observedAt,
    ).run();
  }

  /**
   * Apply rows/index entries and advance one generation checkpoint atomically.
   * The guard row intentionally uses a NOT NULL failure to abort a stale CAS.
   */
  async applyMutationsAndAdvanceCheckpoint(input: MaterializedViewApplyInput): Promise<MaterializedViewApplyResult> {
    assertSortableUniqueId(input.lastSuid);
    if (input.expectedLastSuid !== null) assertSortableUniqueId(input.expectedLastSuid);
    for (const mutation of [...input.mutations.rowUpserts, ...input.mutations.rowPatches]) {
      assertSortableUniqueId(mutation.sourceSuid);
    }
    this.ready("apply");
    this.validateGeneration(input.generation, "apply");
    const operation = operationId();
    const statements: D1PreparedStatement[] = [
      this.database.prepare(
        `INSERT INTO mv_atomic_guards (operation_id, checkpoint_match)
         SELECT ?, CASE WHEN EXISTS (
           SELECT 1 FROM mv_instances
            WHERE service_id = ? AND view_id = ? AND generation = ?
              AND ((? IS NULL AND last_suid = '') OR last_suid COLLATE BINARY = ? COLLATE BINARY)
         ) THEN 1 ELSE NULL END`,
      ).bind(
        operation,
        input.serviceId,
        input.viewId,
        input.generation,
        input.expectedLastSuid,
        input.expectedLastSuid,
      ),
    ];
    // Patch guards are evaluated before any write. A missing target selects 0
    // and violates the CHECK constraint, aborting the entire D1 batch.
    for (const patch of input.mutations.rowPatches) {
      statements.push(this.database.prepare(
        `INSERT INTO mv_atomic_guards (operation_id, checkpoint_match)
         SELECT ?, CASE WHEN EXISTS (
           SELECT 1 FROM mv_rows
            WHERE service_id = ? AND view_id = ? AND generation = ? AND row_key COLLATE BINARY = ? COLLATE BINARY
         ) THEN 1 ELSE 0 END`,
      ).bind(
        `${operation}:patch:${patch.rowKey}`,
        input.serviceId,
        input.viewId,
        input.generation,
        patch.rowKey,
      ));
    }
    for (const deletion of input.mutations.rowDeletes) {
      statements.push(this.database.prepare(
        `DELETE FROM mv_index_entries WHERE service_id = ? AND view_id = ? AND generation = ? AND row_key = ?`,
      ).bind(input.serviceId, input.viewId, input.generation, deletion.rowKey));
      statements.push(this.database.prepare(
        `DELETE FROM mv_rows WHERE service_id = ? AND view_id = ? AND generation = ? AND row_key = ?`,
      ).bind(input.serviceId, input.viewId, input.generation, deletion.rowKey));
    }
    for (const upsert of input.mutations.rowUpserts) {
      // An upsert replaces all indexes for that row before inserting the
      // finite descriptor set below; stale index entries cannot survive.
      statements.push(this.database.prepare(
        `DELETE FROM mv_index_entries WHERE service_id = ? AND view_id = ? AND generation = ? AND row_key = ?`,
      ).bind(input.serviceId, input.viewId, input.generation, upsert.rowKey));
      statements.push(this.database.prepare(
        `INSERT INTO mv_rows
           (service_id, view_id, generation, row_key, value_json, row_version, source_suid)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (service_id, view_id, generation, row_key) DO UPDATE SET
           value_json = excluded.value_json,
           row_version = excluded.row_version,
           source_suid = excluded.source_suid`,
      ).bind(
        input.serviceId,
        input.viewId,
        input.generation,
        upsert.rowKey,
        JSON.stringify(assertJsonValue(upsert.value, "state-persistence")),
        upsert.rowVersion,
        upsert.sourceSuid,
      ));
    }
    for (const patch of input.mutations.rowPatches) {
      // A patch carrying index entries declares the complete replacement set
      // for this row. With no entries the prior index rows remain intact.
      if (patch.indexEntries.length > 0) {
        statements.push(this.database.prepare(
          `DELETE FROM mv_index_entries WHERE service_id = ? AND view_id = ? AND generation = ? AND row_key = ?`,
        ).bind(input.serviceId, input.viewId, input.generation, patch.rowKey));
      }
      // json_patch performs the partial merge in SQLite as one prepared
      // statement. No current row is read or merged by the runtime.
      statements.push(this.database.prepare(
        `UPDATE mv_rows
            SET value_json = json_patch(value_json, ?), row_version = ?, source_suid = ?
          WHERE service_id = ? AND view_id = ? AND generation = ? AND row_key COLLATE BINARY = ? COLLATE BINARY`,
      ).bind(
        JSON.stringify(assertJsonValue(patch.patch, "state-persistence")),
        patch.rowVersion,
        patch.sourceSuid,
        input.serviceId,
        input.viewId,
        input.generation,
        patch.rowKey,
      ));
    }
    for (const deletion of input.mutations.indexDeletes) {
      const indexPredicate = deletion.indexId === undefined ? "" : " AND index_id = ?";
      const values: (string | number)[] = [input.serviceId, input.viewId, input.generation, deletion.rowKey];
      if (deletion.indexId !== undefined) values.push(deletion.indexId);
      statements.push(this.database.prepare(
        `DELETE FROM mv_index_entries
          WHERE service_id = ? AND view_id = ? AND generation = ? AND row_key = ?${indexPredicate}`,
      ).bind(...values));
    }
    for (const entry of input.mutations.indexEntries) {
      const typed = entry.valueType === "text"
        ? [entry.value, null, null]
        : entry.valueType === "integer"
          ? [null, entry.value, null]
          : [null, null, entry.value];
      statements.push(this.database.prepare(
        `INSERT INTO mv_index_entries
           (service_id, view_id, generation, index_id, value_type, text_value, integer_value, real_value, row_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (service_id, view_id, generation, index_id, value_type, text_value, integer_value, real_value, row_key)
         DO NOTHING`,
      ).bind(
        input.serviceId,
        input.viewId,
        input.generation,
        entry.indexId,
        entry.valueType,
        ...typed,
        entry.rowKey,
      ));
    }
    for (const patch of input.mutations.rowPatches) {
      for (const entry of patch.indexEntries) {
        const typed = entry.valueType === "text"
          ? [entry.value, null, null]
          : entry.valueType === "integer"
            ? [null, entry.value, null]
            : [null, null, entry.value];
        statements.push(this.database.prepare(
          `INSERT INTO mv_index_entries
             (service_id, view_id, generation, index_id, value_type, text_value, integer_value, real_value, row_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (service_id, view_id, generation, index_id, value_type, text_value, integer_value, real_value, row_key)
           DO NOTHING`,
        ).bind(
          input.serviceId,
          input.viewId,
          input.generation,
          entry.indexId,
          entry.valueType,
          ...typed,
          entry.rowKey,
        ));
      }
    }
    statements.push(this.database.prepare(
      `UPDATE mv_instances
          SET last_suid = ?, definition_version = ?, updated_at = ?
        WHERE service_id = ? AND view_id = ? AND generation = ?`,
    ).bind(
      input.lastSuid,
      input.definitionVersion,
      input.updatedAt,
      input.serviceId,
      input.viewId,
      input.generation,
    ));
    statements.push(this.database.prepare(
      "DELETE FROM mv_atomic_guards WHERE operation_id = ? OR operation_id LIKE ?",
    ).bind(operation, `${operation}:%`));
    try {
      await this.database.batch(statements);
    } catch (error) {
      if (isPatchFailure(error)) throw new MaterializedViewPatchError();
      if (isCasFailure(error)) throw new MaterializedViewCasError();
      throw new MaterializedViewStoreError("apply", "MV_STORE_OPERATION_FAILED", `Materialized-view atomic apply failed: ${String(error)}`, { cause: error });
    }
    const instance = await this.readInstance(input.serviceId, input.viewId, input.generation);
    if (instance === undefined) throw new MaterializedViewStoreError("apply", "MV_INSTANCE_MISSING", "Materialized-view instance disappeared after apply");
    return {
      instance,
      rowUpserts: input.mutations.rowUpserts.length,
      rowDeletes: input.mutations.rowDeletes.length,
      rowPatches: input.mutations.rowPatches.length,
      indexEntries: input.mutations.indexEntries.length,
    };
  }

  async promoteGeneration(input: MaterializedViewPromoteInput): Promise<MaterializedViewInstance> {
    this.ready("promote");
    this.validateGeneration(input.candidateGeneration, "promote");
    const operation = operationId();
    const statements: D1PreparedStatement[] = [
      this.database.prepare(
        `INSERT INTO mv_atomic_guards (operation_id, checkpoint_match)
         SELECT ?, CASE WHEN EXISTS (
           SELECT 1 FROM mv_instances candidate
            WHERE candidate.service_id = ? AND candidate.view_id = ?
              AND candidate.generation = ? AND candidate.status = 'candidate'
         ) AND (
           (? IS NULL AND NOT EXISTS (
             SELECT 1 FROM mv_active_generations existing
              WHERE existing.service_id = ? AND existing.view_id = ?
           ))
           OR (? IS NOT NULL AND EXISTS (
             SELECT 1 FROM mv_active_generations pointer
              WHERE pointer.service_id = ? AND pointer.view_id = ?
                AND pointer.generation = ?
           ))
         ) THEN 1 ELSE NULL END`,
      ).bind(
        operation,
        input.serviceId,
        input.viewId,
        input.candidateGeneration,
        input.expectedActiveGeneration,
        input.serviceId,
        input.viewId,
        input.expectedActiveGeneration,
        input.serviceId,
        input.viewId,
        input.expectedActiveGeneration,
      ),
      this.database.prepare(
        `UPDATE mv_instances SET status = 'retired', updated_at = ?
          WHERE service_id = ? AND view_id = ? AND status = 'active'`,
      ).bind(input.updatedAt, input.serviceId, input.viewId),
      this.database.prepare(
        `UPDATE mv_instances SET status = 'active', updated_at = ?
          WHERE service_id = ? AND view_id = ? AND generation = ?`,
      ).bind(input.updatedAt, input.serviceId, input.viewId, input.candidateGeneration),
      this.database.prepare(
        `INSERT INTO mv_active_generations (service_id, view_id, generation, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (service_id, view_id) DO UPDATE SET generation = excluded.generation, updated_at = excluded.updated_at`,
      ).bind(input.serviceId, input.viewId, input.candidateGeneration, input.updatedAt),
      // A successful rebuild/promotion is the explicit recovery action for an
      // open ordering quarantine. The active-generation pointer changes in the
      // same batch, so a safe read never observes a cleared gate on the old
      // generation with the new generation still unproven.
      this.database.prepare(
        `UPDATE mv_ordering_quarantines
            SET status = 'resolved', resolved_at = ?
          WHERE service_id = ? AND view_id = ? AND status = 'open' AND generation <> ?`,
      ).bind(input.updatedAt, input.serviceId, input.viewId, input.candidateGeneration),
      this.database.prepare("DELETE FROM mv_atomic_guards WHERE operation_id = ?").bind(operation),
    ];
    try {
      await this.database.batch(statements);
    } catch (error) {
      if (isCasFailure(error)) throw new MaterializedViewPromotionCasError();
      throw new MaterializedViewStoreError("promote", "MV_STORE_OPERATION_FAILED", `Materialized-view promotion failed: ${String(error)}`, { cause: error });
    }
    const active = await this.readActive(input.serviceId, input.viewId);
    if (active === undefined) throw new MaterializedViewStoreError("promote", "MV_INSTANCE_MISSING", "Active generation disappeared after promotion");
    return active;
  }

  /** Short aliases make the port convenient for runtime composition and tests. */
  readonly apply = this.applyMutationsAndAdvanceCheckpoint.bind(this);
  readonly promote = this.promoteGeneration.bind(this);

  private rowFrom(row: D1Row): MaterializedViewRow {
    let value: JsonValue;
    try {
      value = assertJsonValue(JSON.parse(asString(row.value_json, "value_json")), "state-persistence");
    } catch (error) {
      throw new MaterializedViewStoreError("initialize", "MV_VALUE_INVALID", `Materialized-view row JSON was invalid: ${String(error)}`, { cause: error });
    }
    return {
      serviceId: asString(row.service_id, "service_id"),
      viewId: asString(row.view_id, "view_id"),
      generation: asInteger(row.generation, "generation"),
      rowKey: asString(row.row_key, "row_key"),
      value,
      rowVersion: asInteger(row.row_version, "row_version"),
      sourceSuid: asString(row.source_suid, "source_suid"),
    };
  }

  private indexFrom(row: D1Row): MaterializedViewIndexEntry {
    const type = valueType(row.value_type);
    return {
      serviceId: asString(row.service_id, "service_id"),
      viewId: asString(row.view_id, "view_id"),
      generation: asInteger(row.generation, "generation"),
      indexId: asString(row.index_id, "index_id"),
      valueType: type,
      value: indexValue(row, type),
      rowKey: asString(row.row_key, "row_key"),
    };
  }

  private validateGeneration(generation: number, operation: MaterializedViewStoreOperation): void {
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new MaterializedViewStoreError(operation, "MV_GENERATION_INVALID", "Materialized-view generation must be a non-negative integer");
    }
  }

  private ready(operation: MaterializedViewStoreOperation): void {
    if (!this.initialized) throw new MaterializedViewStoreError(operation, "MV_STORE_NOT_INITIALIZED", "D1MaterializedViewStore.initialize() must complete before use");
  }
}

export type MaterializedViewStore = Pick<
  D1MaterializedViewStore,
  | "initialize"
  | "createActive"
  | "createCandidate"
  | "beginRebuild"
  | "nextGeneration"
  | "readInstance"
  | "readActive"
  | "readRows"
  | "readIndexEntries"
  | "queryRows"
  | "queryRowsWithTotal"
  | "readListPage"
  | "hasTargetReceipt"
  | "readOrderingQuarantine"
  | "recordOrderingQuarantine"
  | "readWaitForState"
  | "recordCheckpointAhead"
  | "hasCheckpointAheadFinding"
  | "applyMutationsAndAdvanceCheckpoint"
  | "promoteGeneration"
>;
