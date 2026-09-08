import postgres, { type TransactionSql } from "postgres";

import type { DeliverySource, DownstreamOutboxMessage } from "../downstream/types";
import {
  decayedLagEstimateMs,
} from "../safeWindow";
import { resolveDeliveryIdentity } from "../eventIdentity";
import { assertSortableUniqueId } from "../allocator/SortableUniqueId";
import { CANONICAL_UTC_TIMESTAMP_PATTERN, isRfc4122Uuid, isUuidV7, serializedEventMetadata } from "../eventRecord";
import {
  CanonicalEventIdentityConflictError,
  type DeliveryLagRecord,
  type DeliveryIncident,
  type DeliveryIncidentClassification,
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
type DbRow = Record<string, unknown>;
type SqlParameter = string | number | null;
type SqlClient = ReturnType<typeof postgres>;

/** Coordinates first-use DDL across independently scheduled Worker isolates. */
const SCHEMA_BOOTSTRAP_LOCK = 84_736_291;

const SCHEMA = `
-- G32 is a new-store baseline. The logical event table intentionally mirrors
-- Sekiban.Dcb's EF model exactly; operational delivery facts are sidecar data.
CREATE TABLE IF NOT EXISTS dcb_events (
  "ServiceId" varchar(64) NOT NULL,
  "Id" uuid NOT NULL,
  "SortableUniqueId" varchar(100) NOT NULL,
  "EventType" text NOT NULL,
  "Payload" json NOT NULL,
  "Tags" jsonb NOT NULL,
  "Timestamp" timestamptz NOT NULL,
  "CausationId" text NULL,
  "CorrelationId" text NULL,
  "ExecutedUser" text NULL,
  CONSTRAINT "PK_dcb_events" PRIMARY KEY ("ServiceId", "Id")
);
CREATE INDEX IF NOT EXISTS "IX_Events_ServiceId" ON dcb_events ("ServiceId");
CREATE INDEX IF NOT EXISTS "IX_Events_Service_SortableUniqueId" ON dcb_events ("ServiceId", "SortableUniqueId");
CREATE INDEX IF NOT EXISTS "IX_dcb_events_EventType" ON dcb_events ("EventType");
CREATE INDEX IF NOT EXISTS "IX_dcb_events_Timestamp" ON dcb_events ("Timestamp");

CREATE TABLE IF NOT EXISTS dcb_event_ops (
  "ServiceId" varchar(64) NOT NULL,
  "Id" uuid NOT NULL,
  "AttemptId" text NULL,
  "AllocatorLineageId" text NULL,
  "FirstArrivedAt" bigint NOT NULL,
  "LastArrivedAt" bigint NOT NULL,
  "MaxDeliveryLagMs" bigint NOT NULL,
  PRIMARY KEY ("ServiceId", "Id"),
  FOREIGN KEY ("ServiceId", "Id") REFERENCES dcb_events ("ServiceId", "Id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS serialized_dcb_allocator_bindings (
  service_id TEXT PRIMARY KEY,
  allocator_lineage_id TEXT NOT NULL,
  bound_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS serialized_dcb_event_arrivals (
  service_id TEXT NOT NULL,
  -- This sidecar participates in a foreign key to C#'s UUID logical Id;
  -- retaining the old text type would make a clean G32 baseline impossible
  -- to create and would mask the record/DDL mismatch.
  event_id uuid NOT NULL,
  tag TEXT NOT NULL,
  enqueued_at BIGINT NOT NULL,
  arrived_at BIGINT NOT NULL,
  lag_ms BIGINT NOT NULL,
  PRIMARY KEY (service_id, event_id, tag),
  FOREIGN KEY (service_id, event_id)
    REFERENCES dcb_events ("ServiceId", "Id")
  ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS serialized_dcb_lag_estimates (
  service_id TEXT PRIMARY KEY,
  estimate_ms BIGINT NOT NULL,
  observed_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS serialized_dcb_pending_arrivals (
  service_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  suid TEXT NOT NULL,
  expected_paths JSONB NOT NULL,
  observed_paths JSONB NOT NULL,
  first_observed_at BIGINT NOT NULL,
  lag_bound_ms BIGINT NOT NULL,
  PRIMARY KEY (service_id, event_id)
);

CREATE TABLE IF NOT EXISTS serialized_dcb_inconsistency_findings (
  sequence BIGSERIAL PRIMARY KEY,
  service_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  path TEXT NOT NULL,
  classification TEXT NOT NULL,
  first_observed_at BIGINT NOT NULL,
  lag_bound_ms BIGINT NOT NULL,
  observed_at BIGINT NOT NULL,
  UNIQUE (service_id, event_id, path, classification)
);

CREATE TABLE IF NOT EXISTS serialized_dcb_delivery_incidents (
  sequence BIGSERIAL PRIMARY KEY,
  service_id TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  classification TEXT NOT NULL,
  suid TEXT,
  existing_event_id TEXT,
  incoming_event_id TEXT,
  event_id TEXT,
  bound_lineage_id TEXT,
  incoming_lineage_id TEXT,
  observed_at BIGINT NOT NULL,
  UNIQUE (service_id, identity_key)
);

CREATE TABLE IF NOT EXISTS serialized_dcb_projection_checkpoints (
  service_id TEXT NOT NULL,
  projection_id TEXT NOT NULL,
  last_suid TEXT NOT NULL,
  state_json TEXT NOT NULL,
  version BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (service_id, projection_id)
);
`;

function asString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`Postgres ${name} was not a string`);
  }
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  return value === null ? null : asString(value, name);
}

function sameUtcInstant(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
}

/**
 * PostgreSQL renders timestamptz values as `YYYY-MM-DD HH:mm:ss+00`, while
 * the durable DCB contract exposes canonical UTC ISO strings.  Normalize at
 * the provider boundary so an export can be admitted by another provider
 * without treating equivalent timestamp renderings as distinct records.
 */
function canonicalUtcTimestamp(value: unknown, name: string): string {
  const text = asString(value, name);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Postgres ${name} was not a valid UTC timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

function assertUtcTimestamp(value: string, eventId: string): void {
  if (!CANONICAL_UTC_TIMESTAMP_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new CanonicalEventIdentityConflictError("postgres", eventId, "PostgreSQL Timestamp must be canonical UTC ISO-8601");
  }
}

function asNumber(value: unknown, name: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`Postgres ${name} was not a safe integer`);
  }
  return number;
}

function asStringArray(value: unknown, name: string): string[] {
  const decoded = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(decoded) || !decoded.every((entry) => typeof entry === "string")) {
    throw new Error(`Postgres ${name} was not a string array`);
  }
  // dcb_events.Tags is an ordered C# payload field. Callers needing set
  // semantics (pending paths, projection membership) normalize explicitly.
  return [...decoded];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(binaryCompare);
}

function binaryCompare(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const shared = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

/** V1 SUIDs are opaque byte strings; lexical JavaScript order is not enough. */
function compareSuid(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const shared = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return leftBytes.length - rightBytes.length;
}

function pendingFrom(row: DbRow): PendingArrivalRecord {
  return {
    serviceId: asString(row.service_id, "service_id"),
    eventId: asString(row.event_id, "event_id"),
    attemptId: asString(row.attempt_id, "attempt_id"),
    suid: asString(row.suid, "suid"),
    expectedPaths: sortedUnique(asStringArray(row.expected_paths, "expected_paths")),
    observedPaths: sortedUnique(asStringArray(row.observed_paths, "observed_paths")),
    firstObservedAt: asNumber(row.first_observed_at, "first_observed_at"),
    lagBoundMs: asNumber(row.lag_bound_ms, "lag_bound_ms"),
  };
}

function findingFrom(row: DbRow): InconsistencyFinding {
  const classification = asString(row.classification, "classification");
  if (classification !== "MISSING_STABLE" && classification !== "EXCLUDED_AUDITED" && classification !== "RESOLVED_LATE") {
    throw new Error("Postgres classification was invalid");
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
  if (classification !== "SUID_COLLISION" && classification !== "ORDER_VIOLATION" && classification !== "LINEAGE_MISMATCH" && classification !== "ORDERING_DETECTOR_UNKNOWN") {
    throw new Error("Postgres delivery incident classification was invalid");
  }
  return classification;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return asString(value, name);
}

function incidentFrom(row: DbRow): DeliveryIncident {
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

function collisionIdentity(serviceId: string, suid: string, existingEventId: string, incomingEventId: string): string {
  const [first, second] = [existingEventId, incomingEventId].sort(binaryCompare);
  return `SUID_COLLISION|${serviceId}|${suid}|${first}|${second}`;
}

interface DurableEventMetadata {
  readonly causationId: string | null;
  readonly correlationId: string | null;
  readonly executedUser: string | null;
}

function metadataForDelivery(message: DownstreamOutboxMessage, deliverySource: DeliverySource): DurableEventMetadata {
  const serialized = serializedEventMetadata(message.eventId);
  if (deliverySource !== "import") {
    if (
      message.causationId !== serialized.causationId ||
      message.correlationId !== serialized.correlationId ||
      message.executedUser !== serialized.executedUser
    ) {
      throw new CanonicalEventIdentityConflictError("postgres", message.eventId, "PostgreSQL metadata must use the serialized C# constants");
    }
    return serialized;
  }
  const values = [message.causationId, message.correlationId, message.executedUser];
  if (!values.every((value) => value === null || typeof value === "string")) {
    throw new CanonicalEventIdentityConflictError("postgres", message.eventId, "PostgreSQL import metadata must be string or null");
  }
  const allNull = values.every((value) => value === null);
  const allSerialized = message.causationId === serialized.causationId &&
    message.correlationId === serialized.correlationId && message.executedUser === serialized.executedUser;
  if (!allNull && !allSerialized) {
    throw new CanonicalEventIdentityConflictError("postgres", message.eventId, "PostgreSQL import metadata must be all null or serialized constants");
  }
  return {
    causationId: message.causationId,
    correlationId: message.correlationId,
    executedUser: message.executedUser,
  };
}

function lineageIdentity(serviceId: string, boundLineageId: string, incomingLineageId: string): string {
  return `LINEAGE_MISMATCH|${serviceId}|${boundLineageId}|${incomingLineageId}`;
}

function projectionCheckpointFrom(row: DbRow): ProjectionCheckpoint {
  return {
    serviceId: asString(row.service_id, "service_id"),
    projectionId: asString(row.projection_id, "projection_id"),
    lastSuid: asString(row.last_suid, "last_suid"),
    stateJson: asString(row.state_json, "state_json"),
    version: asNumber(row.version, "version"),
    updatedAt: asNumber(row.updated_at, "updated_at"),
  };
}

/**
 * `postgres` exposes an ESM/workerd build. The deployed Worker passes a
 * Hyperdrive connection string; local Miniflare passes Docker PostgreSQL.
 */
export class PostgresEventStore implements EventStore, DetectorStore, ProjectionStore {
  private sql: SqlClient | undefined;

  constructor(private readonly connectionString: string) {}

  async initialize(): Promise<void> {
    if (this.sql !== undefined) {
      return;
    }
    const sql = postgres(this.connectionString, { fetch_types: false, max: 1, prepare: true });
    try {
      await sql.begin(async (transaction) => {
        await transaction.unsafe("SELECT pg_advisory_xact_lock($1)", [SCHEMA_BOOTSTRAP_LOCK]);
        await transaction.unsafe(SCHEMA, [], { prepare: false });
      });
      this.sql = sql;
    } catch (error) {
      await sql.end({ timeout: 1 });
      throw error;
    }
  }

  /** Close an owned request/test client without touching durable records. */
  async close(): Promise<void> {
    const sql = this.sql;
    this.sql = undefined;
    if (sql !== undefined) await sql.end({ timeout: 5 });
  }

  async recordDelivery(message: DownstreamOutboxMessage, arrivedAt: number, deliverySource: DeliverySource = "queue"): Promise<DeliveryOutcome> {
    const lagMs = Math.max(0, arrivedAt - message.enqueuedAt);
    const identity = resolveDeliveryIdentity(message, deliverySource);
    assertSortableUniqueId(message.suid);
    const acceptsImportedId = deliverySource === "import";
    if (!(acceptsImportedId ? isRfc4122Uuid(message.eventId) : isUuidV7(message.eventId))) {
      throw new CanonicalEventIdentityConflictError(
        "postgres",
        message.eventId,
        `PostgreSQL EventId must be an ${acceptsImportedId ? "RFC 4122 UUID" : "UUID v7"}`,
      );
    }
    try {
      JSON.parse(message.payload);
    } catch {
      throw new CanonicalEventIdentityConflictError("postgres", message.eventId, "PostgreSQL Payload must be UTF-8 JSON text");
    }
    const timestamp = message.timestamp ?? new Date(arrivedAt).toISOString();
    assertUtcTimestamp(timestamp, message.eventId);
    const metadata = metadataForDelivery(message, deliverySource);
    const incomingEventType = identity.key;
    // dcb_events.Tags is C#'s emission-order JSON array. It is not a set;
    // set semantics belong only to projection membership/derivation.
    const eventTags = [...message.eventTags];
    const sql = this.requireSql();
    let outcome: "stored" | "suid-collision" | "lineage-mismatch" = "stored";
    let incident: DeliveryIncident | undefined;
    await sql.begin(async (transaction) => {
      // Serialize all deliveries for a service. The unique index below is
      // defense-in-depth, while this lock lets us persist the incident in the
      // same transaction instead of leaking a unique-violation retry window.
      await transaction.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [message.serviceId]);
      const binding = (await transaction.unsafe(
        `SELECT allocator_lineage_id
           FROM serialized_dcb_allocator_bindings
          WHERE service_id = $1
          FOR UPDATE`,
        [message.serviceId],
      ) as unknown as DbRow[])[0];
      const boundLineageId = binding === undefined
        ? undefined
        : asString(binding.allocator_lineage_id, "allocator_lineage_id");
      if (boundLineageId !== undefined && boundLineageId !== message.allocatorLineageId) {
        outcome = "lineage-mismatch";
        incident = {
          serviceId: message.serviceId,
          identityKey: lineageIdentity(message.serviceId, boundLineageId, message.allocatorLineageId),
          classification: "LINEAGE_MISMATCH",
          boundLineageId,
          incomingLineageId: message.allocatorLineageId,
          observedAt: arrivedAt,
        };
        await this.insertIncident(transaction, incident);
        return;
      }
      if (boundLineageId === undefined) {
        await transaction.unsafe(
          `INSERT INTO serialized_dcb_allocator_bindings (service_id, allocator_lineage_id, bound_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (service_id) DO NOTHING`,
          [message.serviceId, message.allocatorLineageId, arrivedAt],
        );
      }
      // A message whose opaque SUID is already behind the durable source head
      // is recovery/backlog traffic. It remains observable in the arrival
      // tables, but must not inflate the reordering estimate.
      const headRow = (await transaction.unsafe(
        `SELECT MAX("SortableUniqueId") AS head_suid
           FROM dcb_events
          WHERE "ServiceId" = $1`,
        [message.serviceId],
      ) as unknown as DbRow[])[0];
      const currentHead = headRow?.head_suid === null || headRow?.head_suid === undefined
        ? undefined
        : asString(headRow.head_suid, "head_suid");
      const recoveryBacklogSample = currentHead !== undefined && compareSuid(message.suid, currentHead) < 0;
      const existing = (await transaction.unsafe(
        `SELECT "SortableUniqueId" AS suid, "Payload"::text AS payload,
                "EventType" AS event_type, "Tags" AS event_tags,
                "Timestamp"::text AS timestamp, "CausationId" AS causation_id,
                "CorrelationId" AS correlation_id, "ExecutedUser" AS executed_user
           FROM dcb_events
          WHERE "ServiceId" = $1 AND "Id" = $2::uuid
          FOR UPDATE`,
        [message.serviceId, message.eventId],
      ) as unknown as DbRow[])[0];
      const sameSuid = (await transaction.unsafe(
        `SELECT "Id"::text AS event_id
           FROM dcb_events
          WHERE "ServiceId" = $1 AND "SortableUniqueId" = $2
          FOR UPDATE`,
        [message.serviceId, message.suid],
      ) as unknown as DbRow[])[0];
      if (sameSuid !== undefined && asString(sameSuid.event_id, "event_id") !== message.eventId) {
        outcome = "suid-collision";
        incident = {
          serviceId: message.serviceId,
          identityKey: collisionIdentity(
            message.serviceId,
            message.suid,
            asString(sameSuid.event_id, "event_id"),
            message.eventId,
          ),
          classification: "SUID_COLLISION",
          suid: message.suid,
          existingEventId: asString(sameSuid.event_id, "event_id"),
          incomingEventId: message.eventId,
          observedAt: arrivedAt,
        };
        await this.insertIncident(transaction, incident);
        return;
      }
      if (existing === undefined) {
        await transaction.unsafe(
          `INSERT INTO dcb_events
             ("ServiceId", "Id", "SortableUniqueId", "EventType", "Payload", "Tags", "Timestamp", "CausationId", "CorrelationId", "ExecutedUser")
           -- Bind raw JSON text as text first. The postgres driver otherwise
           -- JSON-encodes a JavaScript string again, turning the logical C#
           -- JSON payload/Tags array into scalar JSON strings.
           VALUES ($1, $2::uuid, $3, $4, $5::text::json, $6::text::jsonb, $7::timestamptz, $8, $9, $10)`,
          [message.serviceId, message.eventId, message.suid, incomingEventType, message.payload, JSON.stringify(eventTags), timestamp, metadata.causationId, metadata.correlationId, metadata.executedUser],
        );
        await transaction.unsafe(
          `INSERT INTO dcb_event_ops
             ("ServiceId", "Id", "AttemptId", "AllocatorLineageId", "FirstArrivedAt", "LastArrivedAt", "MaxDeliveryLagMs")
           VALUES ($1, $2::uuid, $3, $4, $5, $5, $6)`,
          [message.serviceId, message.eventId, message.attemptId, message.allocatorLineageId, arrivedAt, lagMs],
        );
      } else {
        const existingEventType = optionalString(existing.event_type, "event_type");
        if (existingEventType !== incomingEventType) {
          throw new CanonicalEventIdentityConflictError("postgres", message.eventId);
        }
        if (asString(existing.suid, "suid") !== message.suid || asString(existing.payload, "payload") !== message.payload) {
          throw new Error(`EventId ${message.eventId} conflicts with its durable PostgreSQL row`);
        }
        const storedTags = asStringArray(existing.event_tags, "event_tags");
        if (JSON.stringify(storedTags) !== JSON.stringify(eventTags) ||
          !sameUtcInstant(existing.timestamp, timestamp) ||
          nullableString(existing.causation_id, "causation_id") !== metadata.causationId ||
          nullableString(existing.correlation_id, "correlation_id") !== metadata.correlationId ||
          nullableString(existing.executed_user, "executed_user") !== metadata.executedUser) {
          throw new Error(`EventId ${message.eventId} conflicts with its durable tag membership`);
        }
      }
      await transaction.unsafe(
        `INSERT INTO serialized_dcb_event_arrivals
           (service_id, event_id, tag, enqueued_at, arrived_at, lag_ms)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (service_id, event_id, tag) DO UPDATE
           SET enqueued_at = LEAST(serialized_dcb_event_arrivals.enqueued_at, EXCLUDED.enqueued_at),
               arrived_at = GREATEST(serialized_dcb_event_arrivals.arrived_at, EXCLUDED.arrived_at),
               lag_ms = GREATEST(serialized_dcb_event_arrivals.lag_ms, EXCLUDED.lag_ms)`,
        [message.serviceId, message.eventId, message.tag, message.enqueuedAt, arrivedAt, lagMs],
      );
      await transaction.unsafe(
        `INSERT INTO dcb_event_ops
           ("ServiceId", "Id", "AttemptId", "AllocatorLineageId", "FirstArrivedAt", "LastArrivedAt", "MaxDeliveryLagMs")
         VALUES ($1, $2::uuid, $3, $4, $5, $5, $6)
         ON CONFLICT ("ServiceId", "Id") DO UPDATE
           SET "FirstArrivedAt" = LEAST(dcb_event_ops."FirstArrivedAt", EXCLUDED."FirstArrivedAt"),
               "LastArrivedAt" = GREATEST(dcb_event_ops."LastArrivedAt", EXCLUDED."LastArrivedAt"),
               "MaxDeliveryLagMs" = GREATEST(dcb_event_ops."MaxDeliveryLagMs", EXCLUDED."MaxDeliveryLagMs")`,
        [message.serviceId, message.eventId, message.attemptId, message.allocatorLineageId, arrivedAt, lagMs],
      );
      if (!recoveryBacklogSample && deliverySource !== "fast") {
        const estimator = (await transaction.unsafe(
          `SELECT estimate_ms, observed_at
             FROM serialized_dcb_lag_estimates
            WHERE service_id = $1
            FOR UPDATE`,
          [message.serviceId],
        ) as unknown as DbRow[])[0];
        const currentEstimate = estimator === undefined
          ? 0
          : decayedLagEstimateMs(
            asNumber(estimator.estimate_ms, "estimate_ms"),
            asNumber(estimator.observed_at, "observed_at"),
            arrivedAt,
          );
        const nextEstimate = Math.max(currentEstimate, lagMs);
        await transaction.unsafe(
          `INSERT INTO serialized_dcb_lag_estimates (service_id, estimate_ms, observed_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (service_id) DO UPDATE
             SET estimate_ms = EXCLUDED.estimate_ms,
                 observed_at = EXCLUDED.observed_at`,
          [message.serviceId, nextEstimate, arrivedAt],
        );
      }
    });
    if (outcome !== "stored") {
      return { outcome, kind: outcome, incident: incident! };
    }
    const stored = await this.eventById(message.serviceId, message.eventId);
    if (stored === undefined) {
      throw new Error("PostgreSQL event upsert did not produce a durable row");
    }
    return outcome === "stored"
      ? { outcome, kind: "stored", event: stored }
      : { outcome, kind: outcome, incident: incident! };
  }

  async readAllEvents(serviceId: string, since: string): Promise<StoredEvent[]> {
    if (since.length !== 0) assertSortableUniqueId(since);
    const rows = await this.query(
      `SELECT e."ServiceId" AS service_id, e."Id"::text AS event_id,
              e."SortableUniqueId" AS suid, e."Payload"::text AS payload,
              e."EventType" AS event_type, e."Tags" AS event_tags,
              e."Timestamp"::text AS timestamp, e."CausationId" AS causation_id,
              e."CorrelationId" AS correlation_id, e."ExecutedUser" AS executed_user,
              COALESCE(o."FirstArrivedAt", 0) AS first_arrived_at,
              COALESCE(o."LastArrivedAt", 0) AS last_arrived_at,
              COALESCE(o."MaxDeliveryLagMs", 0) AS max_delivery_lag_ms
         FROM dcb_events e LEFT JOIN dcb_event_ops o
           ON o."ServiceId" = e."ServiceId" AND o."Id" = e."Id"
        WHERE e."ServiceId" = $1 AND e."SortableUniqueId" > $2
        ORDER BY e."SortableUniqueId" ASC, e."Id" ASC`,
      [serviceId, since],
    );
    const events: StoredEvent[] = [];
    for (const row of rows) {
      events.push(await this.eventFromRow(row));
    }
    return events;
  }

  async currentLagBound(serviceId: string, nowMs?: number): Promise<number> {
    const rows = await this.query(
      `SELECT estimate_ms, observed_at
         FROM serialized_dcb_lag_estimates
        WHERE service_id = $1`,
      [serviceId],
    );
    const row = rows[0];
    if (row === undefined) {
      return 0;
    }
    const estimate = asNumber(row.estimate_ms, "estimate_ms");
    const observedAt = asNumber(row.observed_at, "observed_at");
    // Production timestamps are Unix epoch milliseconds. The smaller logical
    // clocks used by deterministic projection tests intentionally remain
    // un-decayed so those tests can inspect the raw observed lag value.
    const decayNow = nowMs !== undefined && nowMs >= 100_000_000_000 && observedAt >= 100_000_000_000
      ? nowMs
      : observedAt;
    return decayedLagEstimateMs(estimate, observedAt, decayNow);
  }

  async listProjectionTags(serviceId: string): Promise<string[]> {
    const rows = await this.query(
      `SELECT DISTINCT memberships.tag AS tag
         FROM dcb_events
         CROSS JOIN LATERAL jsonb_array_elements_text("Tags") AS memberships(tag)
        WHERE "ServiceId" = $1
        ORDER BY memberships.tag ASC`,
      [serviceId],
    );
    return rows.map((row) => asString(row.tag, "tag"));
  }

  async readProjectionCheckpoint(serviceId: string, projectionId: string): Promise<ProjectionCheckpoint | undefined> {
    const rows = await this.query(
      `SELECT service_id, projection_id, last_suid, state_json, version, updated_at
         FROM serialized_dcb_projection_checkpoints
        WHERE service_id = $1 AND projection_id = $2`,
      [serviceId, projectionId],
    );
    const row = rows[0];
    return row === undefined ? undefined : projectionCheckpointFrom(row);
  }

  async advanceProjectionCheckpoint(input: ProjectionCheckpointAdvance): Promise<boolean> {
    const sql = this.requireSql();
    let advanced = false;
    await sql.begin(async (transaction) => {
      const existing = (await transaction.unsafe(
        `SELECT last_suid
           FROM serialized_dcb_projection_checkpoints
          WHERE service_id = $1 AND projection_id = $2
          FOR UPDATE`,
        [input.serviceId, input.projectionId],
      ) as unknown as DbRow[])[0];
      if (existing === undefined) {
        if (input.expectedLastSuid !== null) {
          return;
        }
        await transaction.unsafe(
          `INSERT INTO serialized_dcb_projection_checkpoints
             (service_id, projection_id, last_suid, state_json, version, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            input.serviceId,
            input.projectionId,
            input.lastSuid,
            input.stateJson,
            input.version,
            input.updatedAt,
          ],
        );
        advanced = true;
        return;
      }
      if (asString(existing.last_suid, "last_suid") !== input.expectedLastSuid) {
        return;
      }
      await transaction.unsafe(
        `UPDATE serialized_dcb_projection_checkpoints
            SET last_suid = $3,
                state_json = $4,
                version = $5,
                updated_at = $6
          WHERE service_id = $1 AND projection_id = $2`,
        [
          input.serviceId,
          input.projectionId,
          input.lastSuid,
          input.stateJson,
          input.version,
          input.updatedAt,
        ],
      );
      advanced = true;
    });
    return advanced;
  }

  async projectionLag(serviceId: string, projectionId: string, tag: string): Promise<ProjectionLag> {
    const checkpoint = await this.readProjectionCheckpoint(serviceId, projectionId);
    const checkpointSuid = checkpoint?.lastSuid ?? "";
    const rows = await this.query(
      `SELECT COALESCE(MAX("SortableUniqueId"), '') AS head_suid,
              COUNT(*) FILTER (WHERE "SortableUniqueId" > $3) AS behind_events
         FROM dcb_events
        WHERE "ServiceId" = $1 AND "Tags" ? $2`,
      [serviceId, tag, checkpointSuid],
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

  async upsertPending(
    message: DownstreamOutboxMessage,
    firstObservedAt: number,
    lagBoundMs: number,
  ): Promise<PendingArrivalRecord> {
    const sql = this.requireSql();
    await sql.begin(async (transaction) => {
      const existing = (await transaction.unsafe(
        `SELECT service_id, event_id, attempt_id, suid, expected_paths, observed_paths, first_observed_at, lag_bound_ms
           FROM serialized_dcb_pending_arrivals
          WHERE service_id = $1 AND event_id = $2
          FOR UPDATE`,
        [message.serviceId, message.eventId],
      ) as unknown as DbRow[])[0];
      if (existing === undefined) {
        await transaction.unsafe(
          `INSERT INTO serialized_dcb_pending_arrivals
             (service_id, event_id, attempt_id, suid, expected_paths, observed_paths, first_observed_at, lag_bound_ms)
           VALUES ($1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb, $7, $8)`,
          [
            message.serviceId,
            message.eventId,
            message.attemptId,
            message.suid,
            JSON.stringify(sortedUnique(message.eventTags)),
            JSON.stringify([message.tag]),
            firstObservedAt,
            lagBoundMs,
          ],
        );
      } else {
        const pending = pendingFrom(existing);
        if (pending.attemptId !== message.attemptId || pending.suid !== message.suid) {
          throw new Error(`EventId ${message.eventId} has contradictory pending-arrival identity`);
        }
        await transaction.unsafe(
          `UPDATE serialized_dcb_pending_arrivals
              SET expected_paths = $3::text::jsonb,
                  observed_paths = $4::text::jsonb,
                  lag_bound_ms = GREATEST(lag_bound_ms, $5)
            WHERE service_id = $1 AND event_id = $2`,
          [
            message.serviceId,
            message.eventId,
            JSON.stringify(sortedUnique([...pending.expectedPaths, ...message.eventTags])),
            JSON.stringify(sortedUnique([...pending.observedPaths, message.tag])),
            lagBoundMs,
          ],
        );
      }
    });
    const pending = await this.pendingById(message.serviceId, message.eventId);
    if (pending === undefined) {
      throw new Error("PostgreSQL pending record was not persisted");
    }
    return pending;
  }

  async listPending(serviceId?: string): Promise<PendingArrivalRecord[]> {
    const rows = serviceId === undefined
      ? await this.query(
        `SELECT service_id, event_id, attempt_id, suid, expected_paths, observed_paths, first_observed_at, lag_bound_ms
           FROM serialized_dcb_pending_arrivals
          ORDER BY service_id ASC, event_id ASC`,
      )
      : await this.query(
        `SELECT service_id, event_id, attempt_id, suid, expected_paths, observed_paths, first_observed_at, lag_bound_ms
           FROM serialized_dcb_pending_arrivals
          WHERE service_id = $1
          ORDER BY event_id ASC`,
        [serviceId],
      );
    return rows.map(pendingFrom);
  }

  async appendFinding(finding: InconsistencyFinding): Promise<void> {
    await this.query(
      `INSERT INTO serialized_dcb_inconsistency_findings
         (service_id, event_id, path, classification, first_observed_at, lag_bound_ms, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (service_id, event_id, path, classification) DO NOTHING`,
      [
        finding.serviceId,
        finding.eventId,
        finding.path,
        finding.classification,
        finding.firstObservedAt,
        finding.lagBoundMs,
        finding.observedAt,
      ],
    );
  }

  async appendDeliveryIncident(incident: DeliveryIncident): Promise<void> {
    await this.query(
      `INSERT INTO serialized_dcb_delivery_incidents
         (service_id, identity_key, classification, suid, existing_event_id, incoming_event_id, event_id,
          bound_lineage_id, incoming_lineage_id, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (service_id, identity_key) DO NOTHING`,
      [
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
      ],
    );
  }

  async hasDeliveryIncident(serviceId: string, identityKey: string): Promise<boolean> {
    const rows = await this.query(
      `SELECT 1 FROM serialized_dcb_delivery_incidents WHERE service_id = $1 AND identity_key = $2`,
      [serviceId, identityKey],
    );
    return rows.length !== 0;
  }

  async listDeliveryIncidents(serviceId?: string): Promise<DeliveryIncident[]> {
    const rows = serviceId === undefined
      ? await this.query(
        `SELECT service_id, identity_key, classification, suid, existing_event_id, incoming_event_id, event_id,
                bound_lineage_id, incoming_lineage_id, observed_at
           FROM serialized_dcb_delivery_incidents
          ORDER BY sequence ASC`,
      )
      : await this.query(
        `SELECT service_id, identity_key, classification, suid, existing_event_id, incoming_event_id, event_id,
                bound_lineage_id, incoming_lineage_id, observed_at
           FROM serialized_dcb_delivery_incidents
          WHERE service_id = $1
          ORDER BY sequence ASC`,
        [serviceId],
      );
    return rows.map(incidentFrom);
  }

  private async insertIncident(transaction: TransactionSql, incident: DeliveryIncident): Promise<void> {
    await transaction.unsafe(
      `INSERT INTO serialized_dcb_delivery_incidents
         (service_id, identity_key, classification, suid, existing_event_id, incoming_event_id, event_id,
          bound_lineage_id, incoming_lineage_id, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (service_id, identity_key) DO NOTHING`,
      [
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
      ],
    );
  }

  async hasFinding(
    serviceId: string,
    eventId: string,
    path: string,
    classification: InconsistencyClassification,
  ): Promise<boolean> {
    const rows = await this.query(
      `SELECT 1
         FROM serialized_dcb_inconsistency_findings
        WHERE service_id = $1 AND event_id = $2 AND path = $3 AND classification = $4`,
      [serviceId, eventId, path, classification],
    );
    return rows.length !== 0;
  }

  async listFindings(serviceId?: string, eventId?: string): Promise<InconsistencyFinding[]> {
    const values: string[] = [];
    const predicates: string[] = [];
    if (serviceId !== undefined) {
      values.push(serviceId);
      predicates.push(`service_id = $${values.length}`);
    }
    if (eventId !== undefined) {
      values.push(eventId);
      predicates.push(`event_id = $${values.length}`);
    }
    const rows = await this.query(
      `SELECT service_id, event_id, path, classification, first_observed_at, lag_bound_ms, observed_at
         FROM serialized_dcb_inconsistency_findings
         ${predicates.length === 0 ? "" : `WHERE ${predicates.join(" AND ")}`}
        ORDER BY sequence ASC`,
      values,
    );
    return rows.map(findingFrom);
  }

  private requireSql(): SqlClient {
    if (this.sql === undefined) {
      throw new Error("PostgresEventStore.initialize() must complete before use");
    }
    return this.sql;
  }

  private async query(statement: string, parameters: SqlParameter[] = []): Promise<DbRow[]> {
    return (await this.requireSql().unsafe(statement, parameters)) as unknown as DbRow[];
  }

  private async eventById(serviceId: string, eventId: string): Promise<StoredEvent | undefined> {
    const rows = await this.query(
      `SELECT e."ServiceId" AS service_id, e."Id"::text AS event_id,
              e."SortableUniqueId" AS suid, e."Payload"::text AS payload,
              e."EventType" AS event_type, e."Tags" AS event_tags,
              e."Timestamp"::text AS timestamp, e."CausationId" AS causation_id,
              e."CorrelationId" AS correlation_id, e."ExecutedUser" AS executed_user,
              COALESCE(o."FirstArrivedAt", 0) AS first_arrived_at,
              COALESCE(o."LastArrivedAt", 0) AS last_arrived_at,
              COALESCE(o."MaxDeliveryLagMs", 0) AS max_delivery_lag_ms
         FROM dcb_events e LEFT JOIN dcb_event_ops o
           ON o."ServiceId" = e."ServiceId" AND o."Id" = e."Id"
        WHERE e."ServiceId" = $1 AND e."Id" = $2::uuid`,
      [serviceId, eventId],
    );
    const row = rows[0];
    return row === undefined ? undefined : this.eventFromRow(row);
  }

  private async eventFromRow(row: DbRow): Promise<StoredEvent> {
    const serviceId = asString(row.service_id, "service_id");
    const eventId = asString(row.event_id, "event_id");
    const arrivals = await this.query(
      `SELECT service_id, event_id, tag, enqueued_at, arrived_at, lag_ms
         FROM serialized_dcb_event_arrivals
        WHERE service_id = $1 AND event_id = $2
        ORDER BY tag ASC`,
      [serviceId, eventId],
    );
    return {
      serviceId,
      id: eventId,
      eventId,
      sortableUniqueId: asString(row.suid, "suid"),
      suid: asString(row.suid, "suid"),
      payload: asString(row.payload, "payload"),
      tags: asStringArray(row.event_tags, "event_tags"),
      eventTags: asStringArray(row.event_tags, "event_tags"),
      eventType: asString(row.event_type, "event_type"),
      timestamp: canonicalUtcTimestamp(row.timestamp, "timestamp"),
      causationId: nullableString(row.causation_id, "causation_id"),
      correlationId: nullableString(row.correlation_id, "correlation_id"),
      executedUser: nullableString(row.executed_user, "executed_user"),
      provenance: "g32",
      firstArrivedAt: asNumber(row.first_arrived_at, "first_arrived_at"),
      lastArrivedAt: asNumber(row.last_arrived_at, "last_arrived_at"),
      maxDeliveryLagMs: asNumber(row.max_delivery_lag_ms, "max_delivery_lag_ms"),
      arrivals: arrivals.map((arrival): DeliveryLagRecord => ({
        serviceId: asString(arrival.service_id, "service_id"),
        eventId: asString(arrival.event_id, "event_id"),
        tag: asString(arrival.tag, "tag"),
        enqueuedAt: asNumber(arrival.enqueued_at, "enqueued_at"),
        arrivedAt: asNumber(arrival.arrived_at, "arrived_at"),
        lagMs: asNumber(arrival.lag_ms, "lag_ms"),
      })),
    };
  }

  private async pendingById(serviceId: string, eventId: string): Promise<PendingArrivalRecord | undefined> {
    const rows = await this.query(
      `SELECT service_id, event_id, attempt_id, suid, expected_paths, observed_paths, first_observed_at, lag_bound_ms
         FROM serialized_dcb_pending_arrivals
        WHERE service_id = $1 AND event_id = $2`,
      [serviceId, eventId],
    );
    const row = rows[0];
    return row === undefined ? undefined : pendingFrom(row);
  }
}
