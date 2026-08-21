import { assertJsonValue, type MaterializedViewIndexEntryMutation, type MaterializedViewMutationPlan } from "@sekiban/dcb-core";
import type { MaterializedViewRow } from "./MaterializedViewStore";

type D1Row = Record<string, unknown>;

export type UnsafeOutcome = "applied" | "older" | "patch-not-found" | "delete-without-row" | "no-change";
export type UnsafeWindowErrorCode =
  | "UNSAFE_ROW_CAS_MISMATCH"
  | "UNSAFE_DUPLICATE_RACE"
  | "UNSAFE_SUID_CONTRADICTION"
  | "UNSAFE_SAFE_AHEAD"
  | "UNSAFE_BEHIND_FRONTIER"
  | "UNSAFE_KICK_LEASE_HELD"
  | "UNSAFE_GC_GUARD_FAILED";

/** Typed failures are intentionally retryable only for the expected row CAS. */
export class UnsafeWindowMaterializedViewError extends Error {
  constructor(
    readonly code: UnsafeWindowErrorCode,
    readonly retryable: boolean,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UnsafeWindowMaterializedViewError";
  }
}

export interface UnsafeWindowApplyInput {
  readonly serviceId: string;
  readonly viewId: string;
  readonly generation: number;
  readonly eventId: string;
  readonly suid: string;
  readonly safeHead: string;
  readonly expectedRowVersion?: number | null;
  readonly updatedAt: number;
  /**
   * The generic unsafe apply API deliberately does not imply an arrival
   * observation; G23 keeps that receipt guard independent. Materializer
   * adapters that fold the observation into their upsert batch opt in.
   */
  readonly recordArrival?: boolean;
  /** A plan is already the materializer's stored outcome: this port never folds in TypeScript. */
  readonly mutations: MaterializedViewMutationPlan;
  readonly targetSuid?: string;
}

export interface UnsafeWindowApplyResult {
  readonly outcome: UnsafeOutcome;
  readonly duplicate: boolean;
}

export interface UnsafeWindowMaterializedViewStoreOptions {
  /** Test-only barrier used by the SDT-G26 duplicate-race oracle. */
  readonly beforeApplyBatch?: (
    input: UnsafeWindowApplyInput,
    statements?: readonly D1PreparedStatement[],
  ) => Promise<void>;
  /** Test-only post-commit seam for receipt-boundary fault oracles. */
  readonly afterApplyBatch?: (
    input: UnsafeWindowApplyInput,
    result: UnsafeWindowApplyResult,
  ) => Promise<void>;
}

export interface UnsafeReadMeta {
  readonly safeContiguousHead: string;
  readonly unsafeObservedMaxSuid: string;
  readonly rebuildRequired: boolean;
}

export interface UnsafeKickLease {
  readonly targetSuid: string;
  readonly dirty: boolean;
}

export interface UnsafeComposedPage {
  readonly rows: readonly MaterializedViewRow[];
  readonly totalCount: number;
}

export interface UnsafeGcInput {
  readonly serviceId: string;
  readonly viewId: string;
  readonly generation: number;
  readonly definitionVersion: number;
  readonly rowKey: string;
  readonly expectedRowVersion: number;
  readonly expectedSourceSuid: string;
  readonly safeHead: string;
}

interface UnsafeGcCandidate {
  readonly rowKey: string;
  readonly rowVersion: number;
  readonly sourceSuid: string;
}

function compareSuid(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function string(row: D1Row, key: string): string {
  if (typeof row[key] !== "string") throw new Error(`Unsafe MV ${key} was not a string`);
  return row[key] as string;
}

function integer(row: D1Row, key: string): number {
  const value = typeof row[key] === "number" ? row[key] : Number(row[key]);
  if (!Number.isSafeInteger(value)) throw new Error(`Unsafe MV ${key} was not an integer`);
  return value;
}

function operationId(): string {
  return `mv-unsafe-${crypto.randomUUID()}`;
}

function errorFrom(error: unknown): UnsafeWindowMaterializedViewError | undefined {
  const value = String(error);
  if (value.includes("mv_unsafe_receipts") && (value.includes("UNIQUE") || value.includes("constraint"))) {
    return new UnsafeWindowMaterializedViewError("UNSAFE_DUPLICATE_RACE", false, "Concurrent unsafe receipt was committed by another delivery", { cause: error });
  }
  if (value.includes("unsafe_row_cas")) return new UnsafeWindowMaterializedViewError("UNSAFE_ROW_CAS_MISMATCH", true, "Unsafe row version changed before atomic apply", { cause: error });
  if (value.includes("unsafe_suid_contradiction")) return new UnsafeWindowMaterializedViewError("UNSAFE_SUID_CONTRADICTION", false, "Unsafe same-SUID payload contradiction", { cause: error });
  if (value.includes("unsafe_safe_ahead")) return new UnsafeWindowMaterializedViewError("UNSAFE_SAFE_AHEAD", false, "Safe head already covers unsafe event", { cause: error });
  if (value.includes("unsafe_behind_frontier")) return new UnsafeWindowMaterializedViewError("UNSAFE_BEHIND_FRONTIER", false, "Unsafe reads are fail-closed pending rebuild", { cause: error });
  return undefined;
}

/**
 * Provider-neutral unsafe-window D1 port. All mutations that make an event
 * observable (row/index/receipt/marker/kick) are one D1 batch, with guard
 * inserts first. This avoids the G18 partial-commit bug of inspecting changes
 * after a batch has already committed other statements.
 */
export class UnsafeWindowMaterializedViewStore {
  constructor(
    private readonly database: D1Database,
    private readonly options: UnsafeWindowMaterializedViewStoreOptions = {},
  ) {}

  /**
   * The common row-materializer shape is one complete upsert. Keep its
   * duplicate/order guards and all observable mutations in one D1 batch. A
   * guard race falls back to apply(), which preserves the detailed older,
   * duplicate, and contradiction classifications; only the uncontended fast
   * path avoids the receipt/row pre-reads and separate arrival write.
   */
  private async applyUpsertFast(input: UnsafeWindowApplyInput): Promise<UnsafeWindowApplyResult | undefined> {
    const { rowUpserts, rowPatches, rowDeletes } = input.mutations;
    if (rowUpserts.length !== 1 || rowPatches.length !== 0 || rowDeletes.length !== 0) return undefined;
    const upsert = rowUpserts[0]!;
    if (upsert.sourceSuid !== input.suid) return undefined;
    const valueJson = JSON.stringify(assertJsonValue(upsert.value, "state-persistence"));
    const operation = operationId();
    const statements: D1PreparedStatement[] = [];
    const guard = (name: string, predicate: string, values: readonly (string | number | null)[]) => {
      statements.push(this.database.prepare(
        `INSERT INTO mv_atomic_guards (operation_id, checkpoint_match)
         SELECT ?, CASE WHEN (${predicate}) THEN 1 ELSE NULL END`,
      ).bind(`${operation}:${name}`, ...values));
    };
    guard(
      "receipt",
      "NOT EXISTS (SELECT 1 FROM mv_unsafe_receipts WHERE service_id = ? AND view_id = ? AND event_id = ?)",
      [input.serviceId, input.viewId, input.eventId],
    );
    guard("safe-head", "? = '' OR ? COLLATE BINARY < ? COLLATE BINARY", [input.safeHead, input.safeHead, input.suid]);
    guard(
      "row-order",
      "NOT EXISTS (SELECT 1 FROM mv_unsafe_rows WHERE service_id = ? AND view_id = ? AND generation = ? AND row_key = ? AND source_suid COLLATE BINARY > ? COLLATE BINARY)",
      [input.serviceId, input.viewId, input.generation, upsert.rowKey, input.suid],
    );
    guard(
      "same-suid",
      "NOT EXISTS (SELECT 1 FROM mv_unsafe_rows WHERE service_id = ? AND view_id = ? AND generation = ? AND row_key = ? AND source_suid COLLATE BINARY = ? COLLATE BINARY AND value_json <> ?)",
      [input.serviceId, input.viewId, input.generation, upsert.rowKey, input.suid, valueJson],
    );
    if (input.expectedRowVersion !== undefined && input.expectedRowVersion !== null) {
      guard(
        "row-cas",
        "NOT EXISTS (SELECT 1 FROM mv_unsafe_rows WHERE service_id = ? AND view_id = ? AND generation = ? AND row_key = ?) OR EXISTS (SELECT 1 FROM mv_unsafe_rows WHERE service_id = ? AND view_id = ? AND generation = ? AND row_key = ? AND row_version = ?)",
        [
          input.serviceId, input.viewId, input.generation, upsert.rowKey,
          input.serviceId, input.viewId, input.generation, upsert.rowKey, input.expectedRowVersion,
        ],
      );
    }

    if (input.recordArrival === true) {
      const behindFrontier = input.safeHead !== "" && compareSuid(input.suid, input.safeHead) <= 0;
      statements.push(this.database.prepare(
        `INSERT INTO mv_unsafe_arrivals
           (service_id, view_id, generation, safe_head, arrival_watermark, behind_frontier_event_id, behind_frontier_suid, rebuild_required)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (service_id, view_id, generation) DO UPDATE SET
           arrival_watermark = CASE WHEN excluded.arrival_watermark COLLATE BINARY > mv_unsafe_arrivals.arrival_watermark COLLATE BINARY THEN excluded.arrival_watermark ELSE mv_unsafe_arrivals.arrival_watermark END,
           behind_frontier_event_id = CASE WHEN mv_unsafe_arrivals.rebuild_required = 1 THEN mv_unsafe_arrivals.behind_frontier_event_id ELSE excluded.behind_frontier_event_id END,
           behind_frontier_suid = CASE WHEN mv_unsafe_arrivals.rebuild_required = 1 THEN mv_unsafe_arrivals.behind_frontier_suid ELSE excluded.behind_frontier_suid END,
           rebuild_required = MAX(mv_unsafe_arrivals.rebuild_required, excluded.rebuild_required)`,
      ).bind(
        input.serviceId,
        input.viewId,
        input.generation,
        input.safeHead,
        input.suid,
        behindFrontier ? input.eventId : null,
        behindFrontier ? input.suid : null,
        behindFrontier ? 1 : 0,
      ));
    }
    statements.push(this.database.prepare(
      `DELETE FROM mv_unsafe_index_entries WHERE service_id = ? AND view_id = ? AND generation = ? AND row_key = ?`,
    ).bind(input.serviceId, input.viewId, input.generation, upsert.rowKey));
    statements.push(this.database.prepare(
      `INSERT INTO mv_unsafe_rows (service_id, view_id, generation, row_key, value_json, row_version, source_suid, tombstone)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT (service_id, view_id, generation, row_key) DO UPDATE SET
         value_json = excluded.value_json, row_version = excluded.row_version, source_suid = excluded.source_suid, tombstone = 0`,
    ).bind(input.serviceId, input.viewId, input.generation, upsert.rowKey, valueJson, upsert.rowVersion, upsert.sourceSuid));
    for (const entry of input.mutations.indexEntries) this.addIndex(statements, "mv_unsafe_index_entries", input, entry);
    statements.push(this.database.prepare(
      `INSERT INTO mv_unsafe_receipts (service_id, view_id, event_id, suid, outcome, observed_at)
       VALUES (?, ?, ?, ?, 'applied', ?)`,
    ).bind(input.serviceId, input.viewId, input.eventId, input.suid, input.updatedAt));
    statements.push(this.database.prepare(
      `INSERT INTO mv_unsafe_kicks (service_id, view_id, target_suid, dirty)
       VALUES (?, ?, ?, 1)
       ON CONFLICT (service_id, view_id) DO UPDATE SET
         target_suid = CASE WHEN excluded.target_suid COLLATE BINARY > mv_unsafe_kicks.target_suid COLLATE BINARY THEN excluded.target_suid ELSE mv_unsafe_kicks.target_suid END,
         dirty = 1`,
    ).bind(input.serviceId, input.viewId, input.targetSuid ?? input.suid));
    statements.push(this.database.prepare("DELETE FROM mv_atomic_guards WHERE operation_id LIKE ?").bind(`${operation}:%`));
    await this.options.beforeApplyBatch?.(input, statements);
    try {
      await this.database.batch(statements);
    } catch (error) {
      // A NULL guard is the only expected fast-path miss. It has no durable
      // side effects because D1 batches are atomic; the complete path can now
      // classify the exact duplicate/older/contradiction outcome.
      const text = String(error);
      const guardFailure =
        text.includes("mv_atomic_guards") ||
        text.includes("checkpoint_match") ||
        (text.includes("mv_unsafe_receipts") && (text.includes("UNIQUE") || text.includes("constraint")));
      if (guardFailure) {
        const receipt = await this.database.prepare(
          `SELECT suid FROM mv_unsafe_receipts WHERE service_id = ? AND view_id = ? AND event_id = ? ORDER BY observed_at DESC LIMIT 1`,
        ).bind(input.serviceId, input.viewId, input.eventId).first<D1Row>();
        if (receipt !== null && receipt !== undefined) {
          if (string(receipt, "suid") !== input.suid) {
            throw new UnsafeWindowMaterializedViewError("UNSAFE_SUID_CONTRADICTION", false, "Duplicate event identity has a contradictory SUID", { cause: error });
          }
          if (this.options.beforeApplyBatch !== undefined) {
            throw new UnsafeWindowMaterializedViewError("UNSAFE_DUPLICATE_RACE", false, "Concurrent unsafe receipt was committed by another delivery", { cause: error });
          }
          return { outcome: "no-change", duplicate: true };
        }
        return this.apply(input, true);
      }
      throw error;
    }
    const result = { outcome: "applied", duplicate: false } as const;
    await this.options.afterApplyBatch?.(input, result);
    return result;
  }

  async apply(input: UnsafeWindowApplyInput, skipFastPath = false): Promise<UnsafeWindowApplyResult> {
    const fast = skipFastPath ? undefined : await this.applyUpsertFast(input);
    if (fast !== undefined) return fast;
    if (input.recordArrival === true) await this.observeArrival(input.serviceId, input.viewId, input.generation, input.eventId, input.suid);
    const receipt = await this.database.prepare(
      `SELECT suid FROM mv_unsafe_receipts WHERE service_id = ? AND view_id = ? AND event_id = ? ORDER BY observed_at DESC LIMIT 1`,
    ).bind(input.serviceId, input.viewId, input.eventId).first<D1Row>();
    if (receipt !== null && receipt !== undefined) {
      if (string(receipt, "suid") !== input.suid) {
        throw new UnsafeWindowMaterializedViewError("UNSAFE_SUID_CONTRADICTION", false, "Duplicate event identity has a contradictory SUID");
      }
      return { outcome: "no-change", duplicate: true };
    }

    const rowKeys = [...new Set([
      ...input.mutations.rowUpserts.map((row) => row.rowKey),
      ...input.mutations.rowPatches.map((row) => row.rowKey),
      ...input.mutations.rowDeletes.map((row) => row.rowKey),
    ])];
    const existing = new Map<string, D1Row>();
    for (const rowKey of rowKeys) {
      const row = await this.database.prepare(
        `SELECT row_key, value_json, row_version, source_suid FROM mv_unsafe_rows
          WHERE service_id = ? AND view_id = ? AND generation = ? AND row_key = ?`,
      ).bind(input.serviceId, input.viewId, input.generation, rowKey).first<D1Row>();
      if (row !== null && row !== undefined) existing.set(rowKey, row);
    }
    const older = [...existing.values()].some((row) => compareSuid(string(row, "source_suid"), input.suid) > 0);
    const noRowForPatch = input.mutations.rowPatches.some((patch) => !existing.has(patch.rowKey));
    const deleteWithoutRow = input.mutations.rowDeletes.some((row) => !existing.has(row.rowKey));
    const outcome: UnsafeOutcome = older ? "older" : noRowForPatch ? "patch-not-found" : deleteWithoutRow ? "delete-without-row" :
      (input.mutations.rowUpserts.length + input.mutations.rowPatches.length + input.mutations.rowDeletes.length === 0 ? "no-change" : "applied");
    const operation = operationId();
    const statements: D1PreparedStatement[] = [];
    const safeAhead = input.safeHead !== "" && compareSuid(input.safeHead, input.suid) >= 0;
    let rowCasMismatch = false;
    let sameSuidContradiction = false;
    const guard = (name: string, predicate: string, values: readonly (string | number | null)[]) => {
      statements.push(this.database.prepare(
        `INSERT INTO mv_atomic_guards (operation_id, checkpoint_match)
         SELECT ?, CASE WHEN (${predicate}) THEN 1 ELSE NULL END`,
      ).bind(`${operation}:${name}`, ...values));
    };
    // Safe-ahead, stale expected version, and same-SUID contradiction abort
    // before any row/index/receipt/marker/kick statement can execute.
    guard("unsafe_safe_ahead", "? = '' OR ? COLLATE BINARY < ? COLLATE BINARY", [input.safeHead, input.safeHead, input.suid]);
    for (const [rowKey, row] of existing) {
      if (input.expectedRowVersion !== undefined && input.expectedRowVersion !== null) {
        rowCasMismatch ||= integer(row, "row_version") !== input.expectedRowVersion;
        guard("unsafe_row_cas", "? = ?", [integer(row, "row_version"), input.expectedRowVersion]);
      }
      const upsert = input.mutations.rowUpserts.find((candidate) => candidate.rowKey === rowKey);
      if (upsert !== undefined && string(row, "source_suid") === input.suid && string(row, "value_json") !== JSON.stringify(assertJsonValue(upsert.value, "state-persistence"))) {
        sameSuidContradiction = true;
        guard("unsafe_suid_contradiction", "0", []);
      }
    }
    // The legal older path converges only receipt + marker. It never rewrites
    // the row, and is deliberately distinct from a CAS failure.
    if (!older && outcome === "applied") {
      for (const deletion of input.mutations.rowDeletes) {
        statements.push(this.database.prepare(`DELETE FROM mv_unsafe_index_entries WHERE service_id = ? AND view_id = ? AND generation = ? AND row_key = ?`).bind(input.serviceId, input.viewId, input.generation, deletion.rowKey));
        statements.push(this.database.prepare(`DELETE FROM mv_unsafe_rows WHERE service_id = ? AND view_id = ? AND generation = ? AND row_key = ?`).bind(input.serviceId, input.viewId, input.generation, deletion.rowKey));
      }
      for (const upsert of input.mutations.rowUpserts) {
        statements.push(this.database.prepare(`DELETE FROM mv_unsafe_index_entries WHERE service_id = ? AND view_id = ? AND generation = ? AND row_key = ?`).bind(input.serviceId, input.viewId, input.generation, upsert.rowKey));
        statements.push(this.database.prepare(
          `INSERT INTO mv_unsafe_rows (service_id, view_id, generation, row_key, value_json, row_version, source_suid, tombstone)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT (service_id, view_id, generation, row_key) DO UPDATE SET
             value_json = excluded.value_json, row_version = excluded.row_version, source_suid = excluded.source_suid, tombstone = 0`,
        ).bind(input.serviceId, input.viewId, input.generation, upsert.rowKey, JSON.stringify(assertJsonValue(upsert.value, "state-persistence")), upsert.rowVersion, upsert.sourceSuid));
      }
      for (const patch of input.mutations.rowPatches) {
        statements.push(this.database.prepare(
          `UPDATE mv_unsafe_rows SET value_json = json_patch(value_json, ?), row_version = ?, source_suid = ?, tombstone = 0
            WHERE service_id = ? AND view_id = ? AND generation = ? AND row_key = ?`,
        ).bind(JSON.stringify(assertJsonValue(patch.patch, "state-persistence")), patch.rowVersion, patch.sourceSuid, input.serviceId, input.viewId, input.generation, patch.rowKey));
      }
      for (const entry of input.mutations.indexEntries) this.addIndex(statements, "mv_unsafe_index_entries", input, entry);
      for (const patch of input.mutations.rowPatches) for (const entry of patch.indexEntries) this.addIndex(statements, "mv_unsafe_index_entries", input, entry);
    }
    const markerReason = outcome === "applied" ? undefined : outcome;
    if (markerReason !== undefined) {
      for (const rowKey of rowKeys.length === 0 ? [input.eventId] : rowKeys) {
        statements.push(this.database.prepare(
          `INSERT INTO mv_unsafe_markers (service_id, view_id, generation, row_key, event_id, suid, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        ).bind(input.serviceId, input.viewId, input.generation, rowKey, input.eventId, input.suid, markerReason));
      }
    }
    statements.push(this.database.prepare(
      `INSERT INTO mv_unsafe_receipts (service_id, view_id, event_id, suid, outcome, observed_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(input.serviceId, input.viewId, input.eventId, input.suid, outcome, input.updatedAt));
    statements.push(this.database.prepare(
      `INSERT INTO mv_unsafe_kicks (service_id, view_id, target_suid, dirty)
       VALUES (?, ?, ?, 1)
       ON CONFLICT (service_id, view_id) DO UPDATE SET
         target_suid = CASE WHEN excluded.target_suid COLLATE BINARY > mv_unsafe_kicks.target_suid COLLATE BINARY THEN excluded.target_suid ELSE mv_unsafe_kicks.target_suid END,
         dirty = 1`,
    ).bind(input.serviceId, input.viewId, input.targetSuid ?? input.suid));
    statements.push(this.database.prepare("DELETE FROM mv_atomic_guards WHERE operation_id LIKE ?").bind(`${operation}:%`));
    // The hook is test-only and is intentionally after the receipt pre-read,
    // which lets two invocations reach the same D1 batch barrier and prove
    // that the unique receipt loser is typed rather than a generic retry.
    await this.options.beforeApplyBatch?.(input, statements);
    try {
      await this.database.batch(statements);
    } catch (error) {
      if (sameSuidContradiction) throw new UnsafeWindowMaterializedViewError("UNSAFE_SUID_CONTRADICTION", false, "Unsafe same-SUID payload contradiction", { cause: error });
      if (rowCasMismatch) throw new UnsafeWindowMaterializedViewError("UNSAFE_ROW_CAS_MISMATCH", true, "Unsafe row version changed before atomic apply", { cause: error });
      if (safeAhead) throw new UnsafeWindowMaterializedViewError("UNSAFE_SAFE_AHEAD", false, "Safe head already covers unsafe event", { cause: error });
      const typed = errorFrom(error);
      if (typed !== undefined) throw typed;
      throw error;
    }
    const result = { outcome, duplicate: false } as const;
    await this.options.afterApplyBatch?.(input, result);
    return result;
  }

  /** Advance safe head and remove markers only if this transaction observed its exact receipt. */
  async observeSafeReceipt(serviceId: string, viewId: string, generation: number, eventId: string, suid: string): Promise<void> {
    const operation = operationId();
    await this.database.batch([
      this.database.prepare(
        `INSERT INTO mv_atomic_guards (operation_id, checkpoint_match)
         SELECT ?, CASE WHEN EXISTS (SELECT 1 FROM mv_unsafe_receipts WHERE service_id = ? AND view_id = ? AND event_id = ? AND suid = ?) THEN 1 ELSE NULL END`,
      ).bind(operation, serviceId, viewId, eventId, suid),
      this.database.prepare(
        `INSERT INTO mv_unsafe_arrivals (service_id, view_id, generation, safe_head, arrival_watermark)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (service_id, view_id, generation) DO UPDATE SET safe_head = excluded.safe_head`,
      ).bind(serviceId, viewId, generation, suid, suid),
      this.database.prepare(`DELETE FROM mv_unsafe_markers WHERE service_id = ? AND view_id = ? AND generation = ? AND event_id = ? AND suid = ?`).bind(serviceId, viewId, generation, eventId, suid),
      this.database.prepare("DELETE FROM mv_atomic_guards WHERE operation_id = ?").bind(operation),
    ]);
  }

  /** Detects late first-arrivals independently of SafeWindow and fail-closes reads. */
  async observeArrival(serviceId: string, viewId: string, generation: number, eventId: string, suid: string): Promise<boolean> {
    const existing = await this.database.prepare(
      `SELECT safe_head, arrival_watermark FROM mv_unsafe_arrivals WHERE service_id = ? AND view_id = ? AND generation = ?`,
    ).bind(serviceId, viewId, generation).first<D1Row>();
    const safeHead = existing === null || existing === undefined ? "" : string(existing, "safe_head");
    const behind = safeHead !== "" && compareSuid(suid, safeHead) <= 0;
    await this.database.prepare(
      `INSERT INTO mv_unsafe_arrivals (service_id, view_id, generation, safe_head, arrival_watermark, behind_frontier_event_id, behind_frontier_suid, rebuild_required)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (service_id, view_id, generation) DO UPDATE SET
         arrival_watermark = CASE WHEN excluded.arrival_watermark COLLATE BINARY > mv_unsafe_arrivals.arrival_watermark COLLATE BINARY THEN excluded.arrival_watermark ELSE mv_unsafe_arrivals.arrival_watermark END,
         behind_frontier_event_id = CASE WHEN mv_unsafe_arrivals.rebuild_required = 1 THEN mv_unsafe_arrivals.behind_frontier_event_id ELSE excluded.behind_frontier_event_id END,
         behind_frontier_suid = CASE WHEN mv_unsafe_arrivals.rebuild_required = 1 THEN mv_unsafe_arrivals.behind_frontier_suid ELSE excluded.behind_frontier_suid END,
         rebuild_required = MAX(mv_unsafe_arrivals.rebuild_required, excluded.rebuild_required)`,
    ).bind(serviceId, viewId, generation, safeHead, suid, behind ? eventId : null, behind ? suid : null, behind ? 1 : 0).run();
    return behind;
  }

  async readMeta(serviceId: string, viewId: string, generation: number): Promise<UnsafeReadMeta> {
    const arrival = await this.database.prepare(`SELECT safe_head, rebuild_required FROM mv_unsafe_arrivals WHERE service_id = ? AND view_id = ? AND generation = ?`).bind(serviceId, viewId, generation).first<D1Row>();
    const row = await this.database.prepare(`SELECT COALESCE(MAX(suid), '') AS max_suid FROM mv_unsafe_receipts WHERE service_id = ? AND view_id = ?`).bind(serviceId, viewId).first<D1Row>();
    return {
      safeContiguousHead: arrival === null || arrival === undefined ? "" : string(arrival, "safe_head"),
      unsafeObservedMaxSuid: row === null || row === undefined ? "" : string(row, "max_suid"),
      rebuildRequired: arrival !== null && arrival !== undefined && integer(arrival, "rebuild_required") === 1,
    };
  }

  async hasTargetReceipt(serviceId: string, viewId: string, eventId: string, suid: string): Promise<boolean> {
    const receipt = await this.database.prepare(`SELECT 1 FROM mv_unsafe_receipts WHERE service_id = ? AND view_id = ? AND event_id = ? AND suid = ?`).bind(serviceId, viewId, eventId, suid).first<D1Row>();
    return receipt !== null && receipt !== undefined;
  }

  async acquireKick(serviceId: string, viewId: string, owner: string, nowMs: number, leaseMs: number): Promise<UnsafeKickLease | undefined> {
    const operation = operationId();
    try {
      await this.database.batch([
        this.database.prepare(
          `INSERT INTO mv_atomic_guards (operation_id, checkpoint_match)
           SELECT ?, CASE WHEN EXISTS (SELECT 1 FROM mv_unsafe_kicks WHERE service_id = ? AND view_id = ? AND dirty = 1 AND (lease_owner IS NULL OR lease_until <= ? OR lease_owner = ?)) THEN 1 ELSE NULL END`,
        ).bind(operation, serviceId, viewId, nowMs, owner),
        this.database.prepare(`UPDATE mv_unsafe_kicks SET lease_owner = ?, lease_until = ?, dirty = 0 WHERE service_id = ? AND view_id = ?`).bind(owner, nowMs + leaseMs, serviceId, viewId),
        this.database.prepare("DELETE FROM mv_atomic_guards WHERE operation_id = ?").bind(operation),
      ]);
    } catch (error) {
      throw new UnsafeWindowMaterializedViewError("UNSAFE_KICK_LEASE_HELD", true, "Unsafe kick is held by another lease owner", { cause: error });
    }
    const row = await this.database.prepare(`SELECT target_suid, dirty FROM mv_unsafe_kicks WHERE service_id = ? AND view_id = ?`).bind(serviceId, viewId).first<D1Row>();
    return row === null || row === undefined ? undefined : { targetSuid: string(row, "target_suid"), dirty: integer(row, "dirty") === 1 };
  }

  async finishKick(serviceId: string, viewId: string, owner: string): Promise<boolean> {
    const result = await this.database.prepare(
      `UPDATE mv_unsafe_kicks SET lease_owner = NULL, lease_until = 0
        WHERE service_id = ? AND view_id = ? AND lease_owner = ? AND dirty = 0`,
    ).bind(serviceId, viewId, owner).run();
    return result.meta.changes === 1;
  }

  /**
   * Collect a repairable unsafe row only when every recovery predicate holds.
   * Every predicate is a constraint-promotion guard ahead of the deletes; a
   * rejected GC therefore cannot leak a partially removed index/receipt.
   */
  async garbageCollect(input: UnsafeGcInput): Promise<boolean> {
    const operation = operationId();
    const statements: D1PreparedStatement[] = [
      // safeHead >= row source, including the mandatory post-GC resurrection fence.
      this.database.prepare(`INSERT INTO mv_atomic_guards (operation_id, checkpoint_match) SELECT ?, CASE WHEN ? COLLATE BINARY >= ? COLLATE BINARY THEN 1 ELSE NULL END`).bind(`${operation}:safe-head`, input.safeHead, input.expectedSourceSuid),
      // Arrival receipt/watermark is a separate condition from the
      // fail-closed detector state; each has its own in-batch guard.
      this.database.prepare(
        `INSERT INTO mv_atomic_guards (operation_id, checkpoint_match)
         SELECT ?, CASE WHEN EXISTS (SELECT 1 FROM mv_unsafe_arrivals WHERE service_id = ? AND view_id = ? AND generation = ? AND arrival_watermark COLLATE BINARY >= ? COLLATE BINARY) THEN 1 ELSE NULL END`,
      ).bind(`${operation}:arrival`, input.serviceId, input.viewId, input.generation, input.expectedSourceSuid),
      this.database.prepare(
        `INSERT INTO mv_atomic_guards (operation_id, checkpoint_match)
         SELECT ?, CASE WHEN EXISTS (SELECT 1 FROM mv_unsafe_arrivals WHERE service_id = ? AND view_id = ? AND generation = ? AND rebuild_required = 0) THEN 1 ELSE NULL END`,
      ).bind(`${operation}:frontier`, input.serviceId, input.viewId, input.generation),
      // Candidate/retired generations and changed materializer definitions are
      // never GC targets.  These are intentionally separate guards so a
      // definition mutation cannot piggy-back on an active-generation check.
      this.database.prepare(
        `INSERT INTO mv_atomic_guards (operation_id, checkpoint_match)
         SELECT ?, CASE WHEN EXISTS (SELECT 1 FROM mv_active_generations WHERE service_id = ? AND view_id = ? AND generation = ?) THEN 1 ELSE NULL END`,
      ).bind(`${operation}:active-generation`, input.serviceId, input.viewId, input.generation),
      this.database.prepare(
        `INSERT INTO mv_atomic_guards (operation_id, checkpoint_match)
         SELECT ?, CASE WHEN EXISTS (SELECT 1 FROM mv_instances WHERE service_id = ? AND view_id = ? AND generation = ? AND definition_version = ?) THEN 1 ELSE NULL END`,
      ).bind(`${operation}:definition`, input.serviceId, input.viewId, input.generation, input.definitionVersion),
      // Compare-and-delete is revalidated inside the atomic batch, never on a
      // read-then-delete snapshot.
      this.database.prepare(
        `INSERT INTO mv_atomic_guards (operation_id, checkpoint_match)
         SELECT ?, CASE WHEN EXISTS (SELECT 1 FROM mv_unsafe_rows WHERE service_id = ? AND view_id = ? AND generation = ? AND row_key = ? AND row_version = ? AND source_suid COLLATE BINARY = ? COLLATE BINARY) THEN 1 ELSE NULL END`,
      ).bind(`${operation}:row`, input.serviceId, input.viewId, input.generation, input.rowKey, input.expectedRowVersion, input.expectedSourceSuid),
      this.database.prepare(`DELETE FROM mv_unsafe_index_entries WHERE service_id = ? AND view_id = ? AND generation = ? AND row_key = ?`).bind(input.serviceId, input.viewId, input.generation, input.rowKey),
      this.database.prepare(`DELETE FROM mv_unsafe_markers WHERE service_id = ? AND view_id = ? AND generation = ? AND row_key = ?`).bind(input.serviceId, input.viewId, input.generation, input.rowKey),
      this.database.prepare(`DELETE FROM mv_unsafe_receipts WHERE service_id = ? AND view_id = ? AND suid = ?`).bind(input.serviceId, input.viewId, input.expectedSourceSuid),
      this.database.prepare(`DELETE FROM mv_unsafe_rows WHERE service_id = ? AND view_id = ? AND generation = ? AND row_key = ? AND row_version = ? AND source_suid COLLATE BINARY = ? COLLATE BINARY`).bind(input.serviceId, input.viewId, input.generation, input.rowKey, input.expectedRowVersion, input.expectedSourceSuid),
      this.database.prepare("DELETE FROM mv_atomic_guards WHERE operation_id LIKE ?").bind(`${operation}:%`),
    ];
    try {
      await this.database.batch(statements);
      return true;
    } catch (error) {
      // Guard failure is an expected no-op for idle catch-up and never a
      // successful delete. Other D1 failures remain visible to the caller.
      if (String(error).includes("mv_atomic_guards") || String(error).includes("checkpoint_match")) return false;
      throw error;
    }
  }

  /**
   * Idle catch-up calls this after it has advanced (or observed) the safe
   * checkpoint.  Candidates are deliberately rechecked by garbageCollect;
   * this read is only work selection, never permission to delete.
   */
  async collectEligible(
    serviceId: string,
    viewId: string,
    generation: number,
    definitionVersion: number,
    safeHead: string,
  ): Promise<number> {
    if (safeHead === "") return 0;
    const candidates = await this.database.prepare(
      `SELECT row_key, row_version, source_suid FROM mv_unsafe_rows
        WHERE service_id = ? AND view_id = ? AND generation = ?
          AND source_suid COLLATE BINARY <= ? COLLATE BINARY
        ORDER BY source_suid COLLATE BINARY ASC, row_key COLLATE BINARY ASC`,
    ).bind(serviceId, viewId, generation, safeHead).all<D1Row>();
    let collected = 0;
    for (const row of candidates.results) {
      const candidate: UnsafeGcCandidate = {
        rowKey: string(row, "row_key"),
        rowVersion: integer(row, "row_version"),
        sourceSuid: string(row, "source_suid"),
      };
      if (await this.garbageCollect({
        serviceId,
        viewId,
        generation,
        definitionVersion,
        rowKey: candidate.rowKey,
        expectedRowVersion: candidate.rowVersion,
        expectedSourceSuid: candidate.sourceSuid,
        safeHead,
      })) collected += 1;
    }
    return collected;
  }

  async queryComposedPage(serviceId: string, viewId: string, generation: number, limit: number, offset: number): Promise<UnsafeComposedPage> {
    const meta = await this.readMeta(serviceId, viewId, generation);
    if (meta.rebuildRequired) throw new UnsafeWindowMaterializedViewError("UNSAFE_BEHIND_FRONTIER", false, "Unsafe window is rebuilding after a behind-frontier arrival");
    // One statement owns winner selection, tombstone exclusion, deterministic
    // ordering and COUNT OVER. No Worker full-table materialization is needed.
    const result = await this.database.prepare(
      `WITH candidates AS (
         SELECT row_key, value_json, row_version, source_suid, 0 AS tombstone, 0 AS unsafe_layer FROM mv_rows
          WHERE service_id = ? AND view_id = ? AND generation = ?
         UNION ALL
         SELECT row_key, value_json, row_version, source_suid, tombstone, 1 AS unsafe_layer FROM mv_unsafe_rows
          WHERE service_id = ? AND view_id = ? AND generation = ?
       ), ranked AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY row_key ORDER BY source_suid COLLATE BINARY DESC, unsafe_layer ASC) AS winner_rank FROM candidates
       ), live AS (
         SELECT *, COUNT(*) OVER() AS total_count FROM ranked WHERE winner_rank = 1 AND tombstone = 0
       )
       SELECT row_key, value_json, row_version, source_suid, total_count FROM live
       ORDER BY source_suid COLLATE BINARY ASC, row_key COLLATE BINARY ASC LIMIT ? OFFSET ?`,
    ).bind(serviceId, viewId, generation, serviceId, viewId, generation, limit, offset).all<D1Row>();
    const rows = result.results.map((row) => ({
      serviceId,
      viewId,
      generation,
      rowKey: string(row, "row_key"),
      value: assertJsonValue(JSON.parse(string(row, "value_json")), "state-persistence"),
      rowVersion: integer(row, "row_version"),
      sourceSuid: string(row, "source_suid"),
    }));
    return { rows, totalCount: result.results.length === 0 ? 0 : integer(result.results[0]!, "total_count") };
  }

  private addIndex(statements: D1PreparedStatement[], table: string, input: UnsafeWindowApplyInput, entry: MaterializedViewIndexEntryMutation): void {
    const typed = entry.valueType === "text" ? [entry.value, null, null] : entry.valueType === "integer" ? [null, entry.value, null] : [null, null, entry.value];
    statements.push(this.database.prepare(
      `INSERT INTO ${table} (service_id, view_id, generation, index_id, value_type, text_value, integer_value, real_value, row_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(input.serviceId, input.viewId, input.generation, entry.indexId, entry.valueType, ...typed, entry.rowKey));
  }
}
