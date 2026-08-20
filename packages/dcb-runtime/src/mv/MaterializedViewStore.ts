import {
  assertJsonValue,
  type JsonValue,
  type MaterializedViewIndexValueType,
  type MaterializedViewMutationPlan,
} from "@sekiban/dcb-core";
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
    this.initialized = true;
  }

  async createActive(input: MaterializedViewCreateInput): Promise<MaterializedViewInstance> {
    this.ready("create-active");
    const generation = input.generation ?? 0;
    this.validateGeneration(generation, "create-active");
    const lastSuid = input.lastSuid ?? "";
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
      const values: (string | number)[] = [serviceId, viewId, selected];
      if (limit !== null) values.push(limit, offset);
      const result = await this.database.prepare(
        `SELECT service_id, view_id, generation, row_key, value_json, row_version, source_suid
           FROM mv_rows
          WHERE service_id = ? AND view_id = ? AND generation = ?
          ORDER BY row_key COLLATE BINARY ASC${limitClause}`,
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
        ORDER BY ${orderColumn} COLLATE BINARY ASC, row.row_key COLLATE BINARY ASC${limitClause}`,
    ).bind(...values).all<D1Row>();
    return result.results.map((row) => this.rowFrom(row));
  }

  /** SDT-G23 composed server page; count and page rows share one statement. */
  async queryRowsWithTotal(serviceId: string, viewId: string, options: MaterializedViewQueryOptions = {}): Promise<UnsafeComposedPage> {
    this.ready("initialize");
    const selected = options.generation ?? (await this.readActive(serviceId, viewId))?.generation;
    if (selected === undefined) return { rows: [], totalCount: 0 };
    const limit = options.limit === undefined ? 100 : options.limit;
    const offset = options.offset ?? 0;
    if (limit === null || !Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new MaterializedViewStoreError("initialize", "MV_VALUE_INVALID", "MV composed query needs non-negative limit/offset");
    }
    return this.unsafe.queryComposedPage(serviceId, viewId, selected, limit, offset);
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

  /** Idempotent operational fact: a stored Queue event needs unsafe retry/DLQ attention. */
  async recordUnsafeFailureFinding(input: {
    readonly serviceId: string;
    readonly viewId: string;
    readonly eventId: string;
    readonly suid: string;
    readonly observedAt: number;
  }): Promise<void> {
    this.ready("apply");
    await this.database.prepare(
      `INSERT INTO mv_unsafe_failure_findings
         (service_id, view_id, event_id, suid, classification, observed_at)
       VALUES (?, ?, ?, ?, 'UNSAFE_APPLY_RETRY', ?)
       ON CONFLICT (service_id, view_id, event_id, suid, classification) DO NOTHING`,
    ).bind(input.serviceId, input.viewId, input.eventId, input.suid, input.observedAt).run();
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

  /**
   * Apply rows/index entries and advance one generation checkpoint atomically.
   * The guard row intentionally uses a NOT NULL failure to abort a stale CAS.
   */
  async applyMutationsAndAdvanceCheckpoint(input: MaterializedViewApplyInput): Promise<MaterializedViewApplyResult> {
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
  | "hasTargetReceipt"
  | "recordCheckpointAhead"
  | "hasCheckpointAheadFinding"
  | "applyMutationsAndAdvanceCheckpoint"
  | "promoteGeneration"
>;
