import postgres from "postgres";

import type { DownstreamOutboxMessage } from "../downstream/types";
import type {
  DeliveryLagRecord,
  DetectorStore,
  EventStore,
  InconsistencyClassification,
  InconsistencyFinding,
  PendingArrivalRecord,
  ProjectionCheckpoint,
  ProjectionCheckpointAdvance,
  ProjectionLag,
  ProjectionStore,
  StoredEvent,
} from "./types";

type DbRow = Record<string, unknown>;
type SqlParameter = string | number;
type SqlClient = ReturnType<typeof postgres>;

/** Coordinates first-use DDL across independently scheduled Worker isolates. */
const SCHEMA_BOOTSTRAP_LOCK = 84_736_291;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS serialized_dcb_events (
  service_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  suid TEXT NOT NULL,
  payload TEXT NOT NULL,
  event_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  first_arrived_at BIGINT NOT NULL,
  last_arrived_at BIGINT NOT NULL,
  max_delivery_lag_ms BIGINT NOT NULL,
  PRIMARY KEY (service_id, event_id)
);
ALTER TABLE serialized_dcb_events
  ADD COLUMN IF NOT EXISTS event_tags JSONB NOT NULL DEFAULT '[]'::jsonb;
UPDATE serialized_dcb_events
   SET event_tags = (event_tags #>> '{}')::jsonb
 WHERE jsonb_typeof(event_tags) = 'string';
CREATE INDEX IF NOT EXISTS serialized_dcb_events_service_suid_idx
  ON serialized_dcb_events (service_id, suid, event_id);

CREATE TABLE IF NOT EXISTS serialized_dcb_event_arrivals (
  service_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  enqueued_at BIGINT NOT NULL,
  arrived_at BIGINT NOT NULL,
  lag_ms BIGINT NOT NULL,
  PRIMARY KEY (service_id, event_id, tag),
  FOREIGN KEY (service_id, event_id)
    REFERENCES serialized_dcb_events (service_id, event_id)
    ON DELETE CASCADE
);
UPDATE serialized_dcb_events AS event
   SET event_tags = COALESCE((
     SELECT jsonb_agg(arrival.tag ORDER BY arrival.tag)
       FROM serialized_dcb_event_arrivals AS arrival
      WHERE arrival.service_id = event.service_id AND arrival.event_id = event.event_id
   ), '[]'::jsonb)
 WHERE event.event_tags = '[]'::jsonb;

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
  return sortedUnique(decoded);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function pendingFrom(row: DbRow): PendingArrivalRecord {
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

  async recordDelivery(message: DownstreamOutboxMessage, arrivedAt: number): Promise<StoredEvent> {
    const lagMs = Math.max(0, arrivedAt - message.enqueuedAt);
    const eventTags = sortedUnique(message.eventTags);
    const sql = this.requireSql();
    await sql.begin(async (transaction) => {
      const existing = (await transaction.unsafe(
        `SELECT suid, payload, event_tags
           FROM serialized_dcb_events
          WHERE service_id = $1 AND event_id = $2
          FOR UPDATE`,
        [message.serviceId, message.eventId],
      ) as unknown as DbRow[])[0];
      if (existing === undefined) {
        await transaction.unsafe(
          `INSERT INTO serialized_dcb_events
             (service_id, event_id, suid, payload, event_tags, first_arrived_at, last_arrived_at, max_delivery_lag_ms)
           VALUES ($1, $2, $3, $4, ($5::text)::jsonb, $6, $6, $7)`,
          [message.serviceId, message.eventId, message.suid, message.payload, JSON.stringify(eventTags), arrivedAt, lagMs],
        );
      } else {
        if (asString(existing.suid, "suid") !== message.suid || asString(existing.payload, "payload") !== message.payload) {
          throw new Error(`EventId ${message.eventId} conflicts with its durable PostgreSQL row`);
        }
        const storedTags = asStringArray(existing.event_tags, "event_tags");
        if (storedTags.length === 0) {
          // Backfill G7 rows lazily on their first replay. Event tags are
          // non-empty in the outbox envelope, so [] can only be the migration
          // default rather than a valid historical membership set.
          await transaction.unsafe(
            `UPDATE serialized_dcb_events
                SET event_tags = ($3::text)::jsonb
              WHERE service_id = $1 AND event_id = $2`,
            [message.serviceId, message.eventId, JSON.stringify(eventTags)],
          );
        } else if (JSON.stringify(storedTags) !== JSON.stringify(eventTags)) {
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
        `UPDATE serialized_dcb_events
            SET first_arrived_at = LEAST(first_arrived_at, $3),
                last_arrived_at = GREATEST(last_arrived_at, $3),
                max_delivery_lag_ms = GREATEST(max_delivery_lag_ms, $4)
          WHERE service_id = $1 AND event_id = $2`,
        [message.serviceId, message.eventId, arrivedAt, lagMs],
      );
    });
    const stored = await this.eventById(message.serviceId, message.eventId);
    if (stored === undefined) {
      throw new Error("PostgreSQL event upsert did not produce a durable row");
    }
    return stored;
  }

  async readAllEvents(serviceId: string, since: string): Promise<StoredEvent[]> {
    const rows = await this.query(
      `SELECT service_id, event_id, suid, payload, event_tags, first_arrived_at, last_arrived_at, max_delivery_lag_ms
         FROM serialized_dcb_events
        WHERE service_id = $1 AND suid > $2
        ORDER BY suid ASC, event_id ASC`,
      [serviceId, since],
    );
    const events: StoredEvent[] = [];
    for (const row of rows) {
      events.push(await this.eventFromRow(row));
    }
    return events;
  }

  async currentLagBound(serviceId: string): Promise<number> {
    const rows = await this.query(
      `SELECT COALESCE(MAX(lag_ms), 0) AS lag_bound_ms
         FROM serialized_dcb_event_arrivals
        WHERE service_id = $1`,
      [serviceId],
    );
    return asNumber(rows[0]?.lag_bound_ms ?? 0, "lag_bound_ms");
  }

  async listProjectionTags(serviceId: string): Promise<string[]> {
    const rows = await this.query(
      `SELECT DISTINCT memberships.tag AS tag
         FROM serialized_dcb_events
         CROSS JOIN LATERAL jsonb_array_elements_text(event_tags) AS memberships(tag)
        WHERE service_id = $1
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
      `SELECT COALESCE(MAX(suid), '') AS head_suid,
              COUNT(*) FILTER (WHERE suid > $3) AS behind_events
         FROM serialized_dcb_events
        WHERE service_id = $1 AND event_tags ? $2`,
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
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)`,
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
              SET expected_paths = $3::jsonb,
                  observed_paths = $4::jsonb,
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
      `SELECT service_id, event_id, suid, payload, event_tags, first_arrived_at, last_arrived_at, max_delivery_lag_ms
         FROM serialized_dcb_events
        WHERE service_id = $1 AND event_id = $2`,
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
      eventId,
      suid: asString(row.suid, "suid"),
      payload: asString(row.payload, "payload"),
      eventTags: asStringArray(row.event_tags, "event_tags"),
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
