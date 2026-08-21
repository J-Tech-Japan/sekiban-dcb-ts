import { decayedLagEstimateMs } from "../safeWindow";
import type { DeliverySource, DownstreamOutboxMessage } from "../downstream/types";
import { resolveDeliveryIdentity } from "../eventIdentity";
import {
  CanonicalEventIdentityConflictError,
  type DeliveryIncident,
  type DeliveryIncidentClassification,
  type DeliveryLagRecord,
  type DeliveryOutcome,
  type DetectorStore,
  type EventStore,
  type InconsistencyClassification,
  type InconsistencyFinding,
  type PendingArrivalRecord,
  type ProjectionCheckpoint,
  type ProjectionCheckpointAdvance,
  type ProjectionLag,
  type ProjectionStore,
  type StoredEvent,
} from "./types";
type D1Row = Record<string, unknown>;

/** Write batches exposed only as a test fault-injection seam. */
export type D1BatchOperation = "recordDelivery" | "upsertPending";
/** Single-statement write boundaries exposed only to fault tests. */
export type D1WriteOperation = "advanceProjectionCheckpoint" | "appendFinding" | "appendDeliveryIncident";

export interface D1StoreOptions {
  /**
   * Test-only hook. It may append a failing prepared statement to prove that
   * D1 rolls the predeclared batch back atomically. Production composition
   * leaves this unset.
   */
  readonly beforeBatch?: (
    operation: D1BatchOperation,
    statements: readonly D1PreparedStatement[],
    database: D1Database,
  ) => readonly D1PreparedStatement[] | Promise<readonly D1PreparedStatement[]>;
  /**
   * Test-only replacement for a single durable statement. Production leaves
   * this unset; each such statement is already atomic in D1.
   */
  readonly beforeWrite?: (
    operation: D1WriteOperation,
    statement: D1PreparedStatement,
    database: D1Database,
  ) => D1PreparedStatement;
}

/** A contradictory EventId identity is a typed fail-closed outcome. */
export class D1IdentityConflictError extends CanonicalEventIdentityConflictError {
  constructor(message: string) {
    super("d1", "", message);
    this.name = "D1IdentityConflictError";
  }
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`D1 ${name} was not a string`);
  return value;
}

function asNumber(value: unknown, name: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`D1 ${name} was not a safe integer`);
  return number;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => binaryCompare(left, right));
}

/** V1 SUIDs and path names are opaque bytewise ordinals, never locale/numeric values. */
export function binaryCompare(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const shared = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function asStringArray(value: unknown, name: string): string[] {
  const decoded = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(decoded) || !decoded.every((entry) => typeof entry === "string")) {
    throw new Error(`D1 ${name} was not a string array`);
  }
  return sortedUnique(decoded);
}

function eventFrom(row: D1Row, arrivals: readonly D1Row[]): StoredEvent {
  const serviceId = asString(row.service_id, "service_id");
  const eventId = asString(row.event_id, "event_id");
  return {
    serviceId,
    eventId,
    suid: asString(row.suid, "suid"),
    payload: asString(row.payload, "payload"),
    eventTags: asStringArray(row.event_tags, "event_tags"),
    ...(row.event_type === null || row.event_type === undefined ? {} : { eventType: asString(row.event_type, "event_type") }),
    provenance: row.event_provenance === "g27" ? "g27" : "pre-g27",
    firstArrivedAt: asNumber(row.first_arrived_at, "first_arrived_at"),
    lastArrivedAt: asNumber(row.last_arrived_at, "last_arrived_at"),
    maxDeliveryLagMs: asNumber(row.max_delivery_lag_ms, "max_delivery_lag_ms"),
    arrivals: arrivals.map((arrival): DeliveryLagRecord => ({
      serviceId: asString(arrival.service_id, "arrival.service_id"),
      eventId: asString(arrival.event_id, "arrival.event_id"),
      tag: asString(arrival.tag, "arrival.tag"),
      enqueuedAt: asNumber(arrival.enqueued_at, "arrival.enqueued_at"),
      arrivedAt: asNumber(arrival.arrived_at, "arrival.arrived_at"),
      lagMs: asNumber(arrival.lag_ms, "arrival.lag_ms"),
    })),
  };
}

function pendingFrom(row: D1Row): PendingArrivalRecord {
  return {
    serviceId: asString(row.service_id, "service_id"),
    eventId: asString(row.event_id, "event_id"),
    attemptId: asString(row.attempt_id, "attempt_id"),
    suid: asString(row.suid, "suid"),
    expectedPaths: asStringArray(row.expected_paths, "expected_paths"),
    observedPaths: asStringArray(row.observed_paths, "observed_paths"),
    firstObservedAt: asNumber(row.first_observed_at, "first_observed_at"),
    lagBoundMs: asNumber(row.lag_bound_ms, "lag_bound_ms"),
  };
}

function findingFrom(row: D1Row): InconsistencyFinding {
  const classification = asString(row.classification, "classification");
  if (classification !== "MISSING_STABLE" && classification !== "EXCLUDED_AUDITED" && classification !== "RESOLVED_LATE") {
    throw new Error("D1 finding classification was invalid");
  }
  return {
    serviceId: asString(row.service_id, "service_id"),
    eventId: asString(row.event_id, "event_id"),
    path: asString(row.path, "path"),
    classification,
    firstObservedAt: asNumber(row.first_observed_at, "first_observed_at"),
    lagBoundMs: asNumber(row.lag_bound_ms, "lag_bound_ms"),
    observedAt: asNumber(row.observed_at, "observed_at"),
  };
}

function incidentClassification(value: unknown): DeliveryIncidentClassification {
  const classification = asString(value, "classification");
  if (classification !== "SUID_COLLISION" && classification !== "ORDER_VIOLATION" && classification !== "LINEAGE_MISMATCH") {
    throw new Error("D1 delivery incident classification was invalid");
  }
  return classification;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return asString(value, name);
}

function incidentFrom(row: D1Row): DeliveryIncident {
  return {
    serviceId: asString(row.service_id, "service_id"),
    identityKey: asString(row.identity_key, "identity_key"),
    classification: incidentClassification(row.classification),
    suid: optionalString(row.suid, "suid"),
    existingEventId: optionalString(row.existing_event_id, "existing_event_id"),
    incomingEventId: optionalString(row.incoming_event_id, "incoming_event_id"),
    eventId: optionalString(row.event_id, "event_id"),
    boundLineageId: optionalString(row.bound_lineage_id, "bound_lineage_id"),
    incomingLineageId: optionalString(row.incoming_lineage_id, "incoming_lineage_id"),
    observedAt: asNumber(row.observed_at, "observed_at"),
  };
}

function checkpointFrom(row: D1Row): ProjectionCheckpoint {
  return {
    serviceId: asString(row.service_id, "service_id"),
    projectionId: asString(row.projection_id, "projection_id"),
    lastSuid: asString(row.last_suid, "last_suid"),
    stateJson: asString(row.state_json, "state_json"),
    version: asNumber(row.version, "version"),
    updatedAt: asNumber(row.updated_at, "updated_at"),
  };
}

function collisionIdentity(serviceId: string, suid: string, existingEventId: string, incomingEventId: string): string {
  const [first, second] = [existingEventId, incomingEventId].sort(binaryCompare);
  return `SUID_COLLISION|${serviceId}|${suid}|${first}|${second}`;
}

function lineageIdentity(serviceId: string, boundLineageId: string, incomingLineageId: string): string {
  return `LINEAGE_MISMATCH|${serviceId}|${boundLineageId}|${incomingLineageId}`;
}

function jsonArray(values: readonly string[]): string {
  return JSON.stringify(sortedUnique(values));
}

/**
 * Cloudflare D1 PipelineStore implementation.
 *
 * All schema changes live in migrations/d1. Writes that span several tables
 * are one predeclared D1 batch; there is no interactive transaction or
 * TypeScript read/branch between statements in the durable mutation.
 */
export class D1EventStore implements EventStore, DetectorStore, ProjectionStore {
  private initialized = false;

  constructor(
    private readonly database: D1Database,
    private readonly options: D1StoreOptions = {},
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    // A read verifies the binding without attempting runtime DDL. The
    // versioned migration is the only schema authority.
    await this.database.prepare("SELECT 1 AS migration_binding").all();
    this.initialized = true;
  }

  async recordDelivery(message: DownstreamOutboxMessage, arrivedAt: number, deliverySource: DeliverySource = "queue"): Promise<DeliveryOutcome> {
    this.ready();
    const identity = resolveDeliveryIdentity(message, deliverySource);
    const storedBefore = await this.eventById(message.serviceId, message.eventId);
    const incomingEventType = identity.legacy ? undefined : identity.key;
    const incomingProvenance = identity.legacy ? "pre-g27" : "g27";
    if (storedBefore !== undefined && (storedBefore.eventType ?? undefined) !== incomingEventType) {
      throw new D1IdentityConflictError(`EventId ${message.eventId} conflicts with its canonical event identity`);
    }
    const eventTags = sortedUnique(message.eventTags);
    const tagsJson = jsonArray(eventTags);
    const lagMs = Math.max(0, arrivedAt - message.enqueuedAt);
    const statements: D1PreparedStatement[] = [
      this.database.prepare(
        `INSERT INTO serialized_dcb_allocator_bindings (service_id, allocator_lineage_id, bound_at)
         VALUES (?, ?, ?)
         ON CONFLICT (service_id) DO NOTHING`,
      ).bind(message.serviceId, message.allocatorLineageId, arrivedAt),
      // Binding mismatch is recorded in the same batch before any event path.
      this.database.prepare(
        `INSERT INTO serialized_dcb_delivery_incidents
           (service_id, identity_key, classification, bound_lineage_id, incoming_lineage_id, observed_at)
         SELECT service_id,
                'LINEAGE_MISMATCH|' || service_id || '|' || allocator_lineage_id || '|' || ?,
                'LINEAGE_MISMATCH', allocator_lineage_id, ?, ?
           FROM serialized_dcb_allocator_bindings
          WHERE service_id = ? AND allocator_lineage_id <> ?
         ON CONFLICT (service_id, identity_key) DO NOTHING`,
      ).bind(
        message.allocatorLineageId,
        message.allocatorLineageId,
        arrivedAt,
        message.serviceId,
        message.allocatorLineageId,
      ),
      // SUID collision is a typed incident rather than a UNIQUE exception.
      this.database.prepare(
        `INSERT INTO serialized_dcb_delivery_incidents
           (service_id, identity_key, classification, suid, existing_event_id, incoming_event_id, observed_at)
         SELECT service_id,
                'SUID_COLLISION|' || service_id || '|' || suid || '|' ||
                  CASE WHEN event_id < ? THEN event_id ELSE ? END || '|' ||
                  CASE WHEN event_id < ? THEN ? ELSE event_id END,
                'SUID_COLLISION', suid, event_id, ?, ?
          FROM serialized_dcb_events
          WHERE service_id = ? AND suid COLLATE BINARY = ? COLLATE BINARY AND event_id <> ?
            AND NOT EXISTS (
              SELECT 1 FROM serialized_dcb_allocator_bindings
               WHERE service_id = ? AND allocator_lineage_id <> ?
            )
          LIMIT 1
         ON CONFLICT (service_id, identity_key) DO NOTHING`,
      ).bind(
        message.eventId,
        message.eventId,
        message.eventId,
        message.eventId,
        message.eventId,
        arrivedAt,
        message.serviceId,
        message.suid,
        message.eventId,
        message.serviceId,
        message.allocatorLineageId,
      ),
      this.database.prepare(
        `INSERT INTO serialized_dcb_events
           (service_id, event_id, suid, payload, allocator_lineage_id, event_type, event_provenance, event_tags,
            first_arrived_at, last_arrived_at, max_delivery_lag_ms)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM serialized_dcb_allocator_bindings
             WHERE service_id = ? AND allocator_lineage_id <> ?
          )
            AND NOT EXISTS (
              SELECT 1 FROM serialized_dcb_events
               WHERE service_id = ? AND suid COLLATE BINARY = ? COLLATE BINARY AND event_id <> ?
            )
         ON CONFLICT (service_id, event_id) DO NOTHING`,
      ).bind(
        message.serviceId,
        message.eventId,
        message.suid,
        message.payload,
        message.allocatorLineageId,
        incomingEventType ?? null,
        incomingProvenance,
        tagsJson,
        arrivedAt,
        arrivedAt,
        lagMs,
        message.serviceId,
        message.allocatorLineageId,
        message.serviceId,
        message.suid,
        message.eventId,
      ),
      this.database.prepare(
        `UPDATE serialized_dcb_events
            SET event_tags = CASE WHEN event_tags = '[]' THEN ? ELSE event_tags END,
                first_arrived_at = MIN(first_arrived_at, ?),
                last_arrived_at = MAX(last_arrived_at, ?),
                max_delivery_lag_ms = MAX(max_delivery_lag_ms, ?)
          WHERE service_id = ? AND event_id = ?
            AND suid COLLATE BINARY = ? COLLATE BINARY AND payload = ?
            AND event_type IS ? AND event_provenance = ?
            AND (event_tags = ? OR event_tags = '[]')
            AND NOT EXISTS (
              SELECT 1 FROM serialized_dcb_allocator_bindings
               WHERE service_id = ? AND allocator_lineage_id <> ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM serialized_dcb_events collision
               WHERE collision.service_id = ? AND collision.suid COLLATE BINARY = ? COLLATE BINARY
                 AND collision.event_id <> ?
            )`,
      ).bind(
        tagsJson,
        arrivedAt,
        arrivedAt,
        lagMs,
        message.serviceId,
        message.eventId,
        message.suid,
        message.payload,
        incomingEventType ?? null,
        incomingProvenance,
        tagsJson,
        message.serviceId,
        message.allocatorLineageId,
        message.serviceId,
        message.suid,
        message.eventId,
      ),
      this.database.prepare(
        `INSERT INTO serialized_dcb_event_arrivals
           (service_id, event_id, tag, enqueued_at, arrived_at, lag_ms)
         SELECT ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM serialized_dcb_events
             WHERE service_id = ? AND event_id = ? AND suid COLLATE BINARY = ? COLLATE BINARY
               AND payload = ? AND event_type IS ? AND event_provenance = ? AND (event_tags = ? OR event_tags = '[]')
          )
            AND NOT EXISTS (
              SELECT 1 FROM serialized_dcb_allocator_bindings
               WHERE service_id = ? AND allocator_lineage_id <> ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM serialized_dcb_events collision
               WHERE collision.service_id = ? AND collision.suid COLLATE BINARY = ? COLLATE BINARY
                 AND collision.event_id <> ?
            )
         ON CONFLICT (service_id, event_id, tag) DO UPDATE
           SET enqueued_at = MIN(serialized_dcb_event_arrivals.enqueued_at, excluded.enqueued_at),
               arrived_at = MAX(serialized_dcb_event_arrivals.arrived_at, excluded.arrived_at),
               lag_ms = MAX(serialized_dcb_event_arrivals.lag_ms, excluded.lag_ms)`,
      ).bind(
        message.serviceId,
        message.eventId,
        message.tag,
        message.enqueuedAt,
        arrivedAt,
        lagMs,
        message.serviceId,
        message.eventId,
        message.suid,
        message.payload,
        incomingEventType ?? null,
        incomingProvenance,
        tagsJson,
        message.serviceId,
        message.allocatorLineageId,
        message.serviceId,
        message.suid,
        message.eventId,
      ),
      this.database.prepare(
        `INSERT INTO serialized_dcb_lag_estimates (service_id, estimate_ms, observed_at)
         SELECT ?, ?, ?
          WHERE ? = 'queue'
            AND NOT EXISTS (
            SELECT 1 FROM serialized_dcb_allocator_bindings
             WHERE service_id = ? AND allocator_lineage_id <> ?
          )
            AND NOT EXISTS (
              SELECT 1 FROM serialized_dcb_events collision
               WHERE collision.service_id = ? AND collision.suid COLLATE BINARY = ? COLLATE BINARY
                 AND collision.event_id <> ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM serialized_dcb_events contradictory
               WHERE contradictory.service_id = ? AND contradictory.event_id = ?
                 AND (contradictory.suid COLLATE BINARY <> ? COLLATE BINARY
                   OR contradictory.payload <> ? OR contradictory.event_type IS NOT ?
                   OR contradictory.event_provenance <> ? OR contradictory.event_tags <> ?)
            )
            AND NOT EXISTS (
              SELECT 1 FROM serialized_dcb_events prior
               WHERE prior.service_id = ? AND prior.suid COLLATE BINARY > ? COLLATE BINARY
            )
         ON CONFLICT (service_id) DO UPDATE
            SET estimate_ms = MAX(
              MAX(serialized_dcb_lag_estimates.estimate_ms -
                  MAX(0, excluded.observed_at - serialized_dcb_lag_estimates.observed_at), 0),
              excluded.estimate_ms
            ),
                observed_at = excluded.observed_at`,
      ).bind(
        message.serviceId,
        lagMs,
        arrivedAt,
        deliverySource,
        message.serviceId,
        message.allocatorLineageId,
        message.serviceId,
        message.suid,
        message.eventId,
        message.serviceId,
        message.eventId,
        message.suid,
        message.payload,
        incomingEventType ?? null,
        incomingProvenance,
        tagsJson,
        message.serviceId,
        message.suid,
      ),
    ];
    await this.batch("recordDelivery", statements);

    const binding = await this.lineageBinding(message.serviceId);
    if (binding !== undefined && binding !== message.allocatorLineageId) {
      const incident = await this.incidentByIdentity(
        message.serviceId,
        lineageIdentity(message.serviceId, binding, message.allocatorLineageId),
      );
      if (incident === undefined) throw new Error("D1 lineage incident was not durable");
      return { outcome: "lineage-mismatch", kind: "lineage-mismatch", incident };
    }
    const collision = await this.collisionEvent(message.serviceId, message.suid, message.eventId);
    if (collision !== undefined) {
      const identity = collisionIdentity(message.serviceId, message.suid, collision, message.eventId);
      const incident = await this.incidentByIdentity(message.serviceId, identity);
      if (incident === undefined) throw new Error("D1 SUID collision incident was not durable");
      return { outcome: "suid-collision", kind: "suid-collision", incident };
    }
    const stored = await this.eventById(message.serviceId, message.eventId);
    if (stored === undefined) throw new Error("D1 event delivery did not produce a durable row");
    if (
      stored.suid !== message.suid ||
      stored.payload !== message.payload ||
      JSON.stringify(stored.eventTags) !== tagsJson ||
      (stored.eventType ?? undefined) !== incomingEventType
    ) {
      throw new D1IdentityConflictError(`EventId ${message.eventId} conflicts with its durable D1 identity`);
    }
    return { outcome: "stored", kind: "stored", event: stored };
  }

  async readAllEvents(serviceId: string, since: string): Promise<StoredEvent[]> {
    this.ready();
    const rows = await this.rows(
      `SELECT service_id, event_id, suid, payload, event_type, event_provenance, event_tags, first_arrived_at, last_arrived_at, max_delivery_lag_ms
         FROM serialized_dcb_events
        WHERE service_id = ? AND suid COLLATE BINARY > ? COLLATE BINARY
        ORDER BY suid COLLATE BINARY ASC, event_id COLLATE BINARY ASC`,
      serviceId,
      since,
    );
    return Promise.all(rows.map((row) => this.eventFromRow(row)));
  }

  async currentLagBound(serviceId: string, nowMs?: number): Promise<number> {
    this.ready();
    const rows = await this.rows(
      `SELECT estimate_ms, observed_at FROM serialized_dcb_lag_estimates WHERE service_id = ?`,
      serviceId,
    );
    const row = rows[0];
    if (row === undefined) return 0;
    const estimate = asNumber(row.estimate_ms, "estimate_ms");
    const observedAt = asNumber(row.observed_at, "observed_at");
    const decayNow = nowMs !== undefined && nowMs >= 100_000_000_000 && observedAt >= 100_000_000_000
      ? nowMs
      : observedAt;
    return decayedLagEstimateMs(estimate, observedAt, decayNow);
  }

  async listProjectionTags(serviceId: string): Promise<string[]> {
    this.ready();
    const rows = await this.rows(
      `SELECT DISTINCT membership.value AS tag
         FROM serialized_dcb_events event, json_each(event.event_tags) membership
        WHERE event.service_id = ?
        ORDER BY tag COLLATE BINARY ASC`,
      serviceId,
    );
    return rows.map((row) => asString(row.tag, "tag"));
  }

  async readProjectionCheckpoint(serviceId: string, projectionId: string): Promise<ProjectionCheckpoint | undefined> {
    this.ready();
    const rows = await this.rows(
      `SELECT service_id, projection_id, last_suid, state_json, version, updated_at
         FROM serialized_dcb_projection_checkpoints
        WHERE service_id = ? AND projection_id = ?`,
      serviceId,
      projectionId,
    );
    return rows[0] === undefined ? undefined : checkpointFrom(rows[0]);
  }

  async advanceProjectionCheckpoint(input: ProjectionCheckpointAdvance): Promise<boolean> {
    this.ready();
    const statement = this.database.prepare(
      `INSERT INTO serialized_dcb_projection_checkpoints
         (service_id, projection_id, last_suid, state_json, version, updated_at)
       SELECT ?, ?, ?, ?, ?, ?
        WHERE ? IS NULL OR EXISTS (
          SELECT 1 FROM serialized_dcb_projection_checkpoints current
           WHERE current.service_id = ? AND current.projection_id = ?
             AND current.last_suid COLLATE BINARY = ? COLLATE BINARY
        )
       ON CONFLICT (service_id, projection_id) DO UPDATE
          SET last_suid = excluded.last_suid,
              state_json = excluded.state_json,
              version = excluded.version,
              updated_at = excluded.updated_at
        WHERE serialized_dcb_projection_checkpoints.last_suid COLLATE BINARY = ? COLLATE BINARY`,
    ).bind(
      input.serviceId,
      input.projectionId,
      input.lastSuid,
      input.stateJson,
      input.version,
      input.updatedAt,
      input.expectedLastSuid,
      input.serviceId,
      input.projectionId,
      input.expectedLastSuid,
      input.expectedLastSuid,
    );
    const result = await this.write("advanceProjectionCheckpoint", statement).run();
    // D1's meta.changes is the CAS oracle; no read-then-write race exists.
    return result.meta.changes === 1;
  }

  async projectionLag(serviceId: string, projectionId: string, tag: string): Promise<ProjectionLag> {
    this.ready();
    const checkpoint = await this.readProjectionCheckpoint(serviceId, projectionId);
    const checkpointSuid = checkpoint?.lastSuid ?? "";
    const rows = await this.rows(
      `SELECT
         COALESCE((SELECT event.suid
                     FROM serialized_dcb_events event, json_each(event.event_tags) membership
                    WHERE event.service_id = ? AND membership.value = ?
                    ORDER BY event.suid COLLATE BINARY DESC LIMIT 1), '') AS head_suid,
         (SELECT COUNT(*)
            FROM serialized_dcb_events event, json_each(event.event_tags) membership
           WHERE event.service_id = ? AND membership.value = ?
             AND event.suid COLLATE BINARY > ? COLLATE BINARY) AS behind_events`,
      serviceId,
      tag,
      serviceId,
      tag,
      checkpointSuid,
    );
    const row = rows[0] ?? {};
    return {
      serviceId,
      projectionId,
      tag,
      checkpointSuid,
      headSuid: asString(row.head_suid ?? "", "head_suid"),
      behindEvents: asNumber(row.behind_events ?? 0, "behind_events"),
    };
  }

  async upsertPending(message: DownstreamOutboxMessage, firstObservedAt: number, lagBoundMs: number): Promise<PendingArrivalRecord> {
    this.ready();
    const expectedJson = jsonArray(message.eventTags);
    const observedJson = jsonArray([message.tag]);
    const statements: D1PreparedStatement[] = [
      this.database.prepare(
        `INSERT INTO serialized_dcb_pending_arrivals
           (service_id, event_id, attempt_id, suid, expected_paths, observed_paths, first_observed_at, lag_bound_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (service_id, event_id) DO NOTHING`,
      ).bind(
        message.serviceId,
        message.eventId,
        message.attemptId,
        message.suid,
        expectedJson,
        observedJson,
        firstObservedAt,
        lagBoundMs,
      ),
      // JSON1 performs the set union inside the atomic UPDATE. There is no
      // TypeScript read/merge/write window under concurrent deliveries.
      this.database.prepare(
        `UPDATE serialized_dcb_pending_arrivals AS pending
            SET expected_paths = COALESCE((
                  SELECT json_group_array(value) FROM (
                    SELECT value FROM json_each(pending.expected_paths)
                    UNION
                    SELECT value FROM json_each(?)
                    ORDER BY value COLLATE BINARY
                  )
                ), '[]'),
                observed_paths = COALESCE((
                  SELECT json_group_array(value) FROM (
                    SELECT value FROM json_each(pending.observed_paths)
                    UNION
                    SELECT value FROM json_each(?)
                    ORDER BY value COLLATE BINARY
                  )
                ), '[]'),
                lag_bound_ms = MAX(lag_bound_ms, ?)
          WHERE service_id = ? AND event_id = ? AND attempt_id = ?
            AND suid COLLATE BINARY = ? COLLATE BINARY`,
      ).bind(
        expectedJson,
        observedJson,
        lagBoundMs,
        message.serviceId,
        message.eventId,
        message.attemptId,
        message.suid,
      ),
    ];
    await this.batch("upsertPending", statements);
    const pending = await this.pendingById(message.serviceId, message.eventId);
    if (pending === undefined) throw new Error("D1 pending arrival was not persisted");
    if (pending.attemptId !== message.attemptId || pending.suid !== message.suid) {
      throw new D1IdentityConflictError(`EventId ${message.eventId} has contradictory pending-arrival identity`);
    }
    return pending;
  }

  async listPending(serviceId?: string): Promise<PendingArrivalRecord[]> {
    this.ready();
    const rows = serviceId === undefined
      ? await this.rows(
        `SELECT service_id, event_id, attempt_id, suid, expected_paths, observed_paths, first_observed_at, lag_bound_ms
           FROM serialized_dcb_pending_arrivals
          ORDER BY service_id COLLATE BINARY ASC, event_id COLLATE BINARY ASC`,
      )
      : await this.rows(
        `SELECT service_id, event_id, attempt_id, suid, expected_paths, observed_paths, first_observed_at, lag_bound_ms
           FROM serialized_dcb_pending_arrivals
          WHERE service_id = ?
          ORDER BY event_id COLLATE BINARY ASC`,
        serviceId,
      );
    return rows.map(pendingFrom);
  }

  async appendFinding(finding: InconsistencyFinding): Promise<void> {
    this.ready();
    const statement = this.database.prepare(
      `INSERT INTO serialized_dcb_inconsistency_findings
         (service_id, event_id, path, classification, first_observed_at, lag_bound_ms, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (service_id, event_id, path, classification) DO NOTHING`,
    ).bind(
      finding.serviceId,
      finding.eventId,
      finding.path,
      finding.classification,
      finding.firstObservedAt,
      finding.lagBoundMs,
      finding.observedAt,
    );
    await this.write("appendFinding", statement).run();
  }

  async hasFinding(serviceId: string, eventId: string, path: string, classification: InconsistencyClassification): Promise<boolean> {
    this.ready();
    const rows = await this.rows(
      `SELECT 1 AS present FROM serialized_dcb_inconsistency_findings
        WHERE service_id = ? AND event_id = ? AND path = ? AND classification = ?`,
      serviceId,
      eventId,
      path,
      classification,
    );
    return rows.length !== 0;
  }

  async listFindings(serviceId?: string, eventId?: string): Promise<InconsistencyFinding[]> {
    this.ready();
    const conditions: string[] = [];
    const values: string[] = [];
    if (serviceId !== undefined) {
      conditions.push("service_id = ?");
      values.push(serviceId);
    }
    if (eventId !== undefined) {
      conditions.push("event_id = ?");
      values.push(eventId);
    }
    const rows = await this.rows(
      `SELECT service_id, event_id, path, classification, first_observed_at, lag_bound_ms, observed_at
         FROM serialized_dcb_inconsistency_findings
        ${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`}
        ORDER BY sequence ASC`,
      ...values,
    );
    return rows.map(findingFrom);
  }

  async appendDeliveryIncident(incident: DeliveryIncident): Promise<void> {
    this.ready();
    const statement = this.database.prepare(
      `INSERT INTO serialized_dcb_delivery_incidents
         (service_id, identity_key, classification, suid, existing_event_id, incoming_event_id, event_id,
          bound_lineage_id, incoming_lineage_id, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (service_id, identity_key) DO NOTHING`,
    ).bind(
      incident.serviceId,
      incident.identityKey,
      incident.classification,
      incident.suid ?? null,
      incident.existingEventId ?? null,
      incident.incomingEventId ?? null,
      incident.eventId ?? null,
      incident.boundLineageId ?? null,
      incident.incomingLineageId ?? null,
      incident.observedAt,
    );
    await this.write("appendDeliveryIncident", statement).run();
  }

  async hasDeliveryIncident(serviceId: string, identityKey: string): Promise<boolean> {
    this.ready();
    return (await this.incidentByIdentity(serviceId, identityKey)) !== undefined;
  }

  async listDeliveryIncidents(serviceId?: string): Promise<DeliveryIncident[]> {
    this.ready();
    const rows = serviceId === undefined
      ? await this.rows(
        `SELECT service_id, identity_key, classification, suid, existing_event_id, incoming_event_id, event_id,
                bound_lineage_id, incoming_lineage_id, observed_at
           FROM serialized_dcb_delivery_incidents
          ORDER BY sequence ASC`,
      )
      : await this.rows(
        `SELECT service_id, identity_key, classification, suid, existing_event_id, incoming_event_id, event_id,
                bound_lineage_id, incoming_lineage_id, observed_at
           FROM serialized_dcb_delivery_incidents
          WHERE service_id = ?
          ORDER BY sequence ASC`,
        serviceId,
      );
    return rows.map(incidentFrom);
  }

  private async batch(operation: D1BatchOperation, statements: readonly D1PreparedStatement[]): Promise<void> {
    const transformed = await this.options.beforeBatch?.(operation, statements, this.database) ?? statements;
    await this.database.batch([...transformed]);
  }

  private write(operation: D1WriteOperation, statement: D1PreparedStatement): D1PreparedStatement {
    return this.options.beforeWrite?.(operation, statement, this.database) ?? statement;
  }

  private async rows(statement: string, ...values: unknown[]): Promise<D1Row[]> {
    const result = await this.database.prepare(statement).bind(...values).all<D1Row>();
    return result.results;
  }

  private async eventById(serviceId: string, eventId: string): Promise<StoredEvent | undefined> {
    const rows = await this.rows(
      `SELECT service_id, event_id, suid, payload, event_type, event_provenance, event_tags, first_arrived_at, last_arrived_at, max_delivery_lag_ms
         FROM serialized_dcb_events WHERE service_id = ? AND event_id = ?`,
      serviceId,
      eventId,
    );
    return rows[0] === undefined ? undefined : this.eventFromRow(rows[0]);
  }

  private async eventFromRow(row: D1Row): Promise<StoredEvent> {
    const arrivals = await this.rows(
      `SELECT service_id, event_id, tag, enqueued_at, arrived_at, lag_ms
         FROM serialized_dcb_event_arrivals
        WHERE service_id = ? AND event_id = ?
        ORDER BY tag COLLATE BINARY ASC`,
      asString(row.service_id, "service_id"),
      asString(row.event_id, "event_id"),
    );
    return eventFrom(row, arrivals);
  }

  private async pendingById(serviceId: string, eventId: string): Promise<PendingArrivalRecord | undefined> {
    const rows = await this.rows(
      `SELECT service_id, event_id, attempt_id, suid, expected_paths, observed_paths, first_observed_at, lag_bound_ms
         FROM serialized_dcb_pending_arrivals WHERE service_id = ? AND event_id = ?`,
      serviceId,
      eventId,
    );
    return rows[0] === undefined ? undefined : pendingFrom(rows[0]);
  }

  private async lineageBinding(serviceId: string): Promise<string | undefined> {
    const rows = await this.rows(
      `SELECT allocator_lineage_id FROM serialized_dcb_allocator_bindings WHERE service_id = ?`,
      serviceId,
    );
    return rows[0] === undefined ? undefined : asString(rows[0].allocator_lineage_id, "allocator_lineage_id");
  }

  private async collisionEvent(serviceId: string, suid: string, eventId: string): Promise<string | undefined> {
    const rows = await this.rows(
      `SELECT event_id FROM serialized_dcb_events
        WHERE service_id = ? AND suid COLLATE BINARY = ? COLLATE BINARY AND event_id <> ?
        ORDER BY event_id COLLATE BINARY ASC LIMIT 1`,
      serviceId,
      suid,
      eventId,
    );
    return rows[0] === undefined ? undefined : asString(rows[0].event_id, "event_id");
  }

  private async incidentByIdentity(serviceId: string, identityKey: string): Promise<DeliveryIncident | undefined> {
    const rows = await this.rows(
      `SELECT service_id, identity_key, classification, suid, existing_event_id, incoming_event_id, event_id,
              bound_lineage_id, incoming_lineage_id, observed_at
         FROM serialized_dcb_delivery_incidents
        WHERE service_id = ? AND identity_key = ?`,
      serviceId,
      identityKey,
    );
    return rows[0] === undefined ? undefined : incidentFrom(rows[0]);
  }

  private ready(): void {
    if (!this.initialized) throw new Error("D1EventStore.initialize() must complete before use");
  }
}
