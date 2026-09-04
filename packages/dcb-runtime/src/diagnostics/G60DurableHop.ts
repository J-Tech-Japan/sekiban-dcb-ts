/**
 * SDT-G60 AC1 operational hop ledger.
 *
 * This is deliberately separate from sdt.commit/v1 and from every public
 * response.  The ledger records immutable observations against the stable
 * event/SUID/attempt identity; it is never consulted by admission, Queue
 * acknowledgement, projection fencing, or a read response.
 */

export const G60_HOP_STAGES = [
  "command-receipt",
  "tag-append-committed",
  "outbox-obligation-written",
  "queue-send-returned",
  "consumer-invocation-started",
  "record-delivery-batch-committed",
  "first-unsafe-visible-read",
] as const;

export type G60HopStage = typeof G60_HOP_STAGES[number];
export type G60HopTransport = "" | "queue" | "fast" | "import" | "public-read";

/** Observation-only boundaries inside the interval after recordDelivery. */
export const G60_POST_ADMISSION_STAGES = [
  "post-record-delivery-global-receipt-readback",
  "source-tag-acknowledgement",
  "completeness-coverage",
  "detector",
  "unsafe-view-apply",
] as const;

export type G60PostAdmissionStage = typeof G60_POST_ADMISSION_STAGES[number];
export type G60PostAdmissionBoundary = "start" | "end";

/** Concrete observation paths for an unsafe materialized-view row write. */
export const G60_UNSAFE_WRITER_PATHS = ["inline-delivery", "scheduled-drain"] as const;
export type G60UnsafeWriterPath = typeof G60_UNSAFE_WRITER_PATHS[number];
export type G60UnsafeWriterBoundary = "start" | "end";
export type G60UnsafeWriterTransport = "" | "queue" | "fast" | "import" | "scheduled";

export interface G60DurableHopObservation {
  readonly stage: G60HopStage;
  readonly serviceId: string;
  readonly eventId: string;
  readonly suid: string;
  readonly attemptId: string;
  readonly observedAt: number;
  readonly partitionTag?: string;
  readonly viewId?: string;
  readonly transport?: G60HopTransport;
}

export interface G60DurableHopObserver {
  observe(input: G60DurableHopObservation): void;
  observeSubstep?(input: G60DurablePostAdmissionObservation): void;
  observeUnsafeWriter?(input: G60DurableUnsafeWriterObservation): void;
}

export interface G60DurablePostAdmissionObservation {
  readonly stage: G60PostAdmissionStage;
  readonly boundary: G60PostAdmissionBoundary;
  readonly outcome: string;
  readonly serviceId: string;
  readonly eventId: string;
  readonly suid: string;
  readonly attemptId: string;
  readonly observedAt: number;
  readonly partitionTag?: string;
  readonly viewId?: string;
  readonly transport?: G60HopTransport;
}

/**
 * Observation-only boundary at the concrete unsafe MV writer. This table is
 * separate from the older seven-hop and post-admission tables so the writer
 * path remains explicit without changing either deployed schema contract.
 */
export interface G60DurableUnsafeWriterObservation {
  readonly writerPath: G60UnsafeWriterPath;
  readonly boundary: G60UnsafeWriterBoundary;
  readonly outcome: string;
  readonly serviceId: string;
  readonly eventId: string;
  readonly suid: string;
  readonly attemptId: string;
  readonly viewId: string;
  readonly observedAt: number;
  readonly transport?: G60UnsafeWriterTransport;
}

interface D1HopRow {
  readonly event_id?: unknown;
  readonly suid?: unknown;
  readonly attempt_id?: unknown;
}

function nonEmpty(value: string, field: string): void {
  if (value.length === 0) throw new Error(`G60 ${field} must be non-empty`);
}

function validate(input: G60DurableHopObservation): Required<Pick<G60DurableHopObservation, "partitionTag" | "viewId" | "transport">> {
  nonEmpty(input.serviceId, "serviceId");
  nonEmpty(input.eventId, "eventId");
  nonEmpty(input.suid, "suid");
  nonEmpty(input.attemptId, "attemptId");
  if (!Number.isSafeInteger(input.observedAt) || input.observedAt < 0) {
    throw new Error("G60 observedAt must be a non-negative safe integer");
  }
  const partitionTag = input.partitionTag ?? "";
  const viewId = input.viewId ?? "";
  const transport = input.transport ?? "";
  if ((input.stage === "tag-append-committed" || input.stage === "outbox-obligation-written" || input.stage === "queue-send-returned" || input.stage === "consumer-invocation-started") && partitionTag.length === 0) {
    throw new Error(`G60 ${input.stage} requires partitionTag`);
  }
  if (input.stage === "first-unsafe-visible-read" && viewId.length === 0) {
    throw new Error("G60 first-unsafe-visible-read requires viewId");
  }
  if ((input.stage === "queue-send-returned" || input.stage === "consumer-invocation-started" || input.stage === "record-delivery-batch-committed") && transport === "") {
    throw new Error(`G60 ${input.stage} requires transport`);
  }
  return { partitionTag, viewId, transport };
}

/** Write one idempotent observation. Replays retain the earliest timestamp. */
export async function recordDurableHop(database: D1Database, input: G60DurableHopObservation): Promise<void> {
  const normalized = validate(input);
  await database.prepare(`
    INSERT INTO serialized_dcb_hop_measurements
      (service_id, event_id, suid, attempt_id, stage, partition_tag, view_id, transport, observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (service_id, event_id, stage, partition_tag, view_id, transport)
    DO UPDATE SET observed_at = MIN(serialized_dcb_hop_measurements.observed_at, excluded.observed_at)
      WHERE serialized_dcb_hop_measurements.suid = excluded.suid
        AND serialized_dcb_hop_measurements.attempt_id = excluded.attempt_id
  `).bind(
    input.serviceId,
    input.eventId,
    input.suid,
    input.attemptId,
    input.stage,
    normalized.partitionTag,
    normalized.viewId,
    normalized.transport,
    input.observedAt,
  ).run();
}

function validatePostAdmission(input: G60DurablePostAdmissionObservation): Required<Pick<G60DurablePostAdmissionObservation, "partitionTag" | "viewId" | "transport">> {
  nonEmpty(input.serviceId, "serviceId");
  nonEmpty(input.eventId, "eventId");
  nonEmpty(input.suid, "suid");
  nonEmpty(input.attemptId, "attemptId");
  nonEmpty(input.outcome, "outcome");
  if (!G60_POST_ADMISSION_STAGES.includes(input.stage)) {
    throw new Error(`G60 unknown post-admission stage: ${input.stage}`);
  }
  if (input.boundary !== "start" && input.boundary !== "end") {
    throw new Error(`G60 post-admission boundary must be start or end: ${input.boundary}`);
  }
  if (!Number.isSafeInteger(input.observedAt) || input.observedAt < 0) {
    throw new Error("G60 post-admission observedAt must be a non-negative safe integer");
  }
  const partitionTag = input.partitionTag ?? "";
  const viewId = input.viewId ?? "";
  const transport = input.transport ?? "";
  if (input.stage === "source-tag-acknowledgement" && partitionTag.length === 0) {
    throw new Error("G60 source-tag-acknowledgement requires partitionTag");
  }
  if (input.stage === "unsafe-view-apply" && viewId.length === 0) {
    throw new Error("G60 unsafe-view-apply requires viewId");
  }
  return { partitionTag, viewId, transport };
}

/** Append one observation-only post-admission boundary; replays are ignored. */
export async function recordDurableHopSubstep(database: D1Database, input: G60DurablePostAdmissionObservation): Promise<void> {
  const normalized = validatePostAdmission(input);
  await database.prepare(`
    INSERT OR IGNORE INTO serialized_dcb_hop_submeasurements
      (service_id, event_id, suid, attempt_id, stage, boundary, outcome,
       partition_tag, view_id, transport, observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    input.serviceId,
    input.eventId,
    input.suid,
    input.attemptId,
    input.stage,
    input.boundary,
    input.outcome,
    normalized.partitionTag,
    normalized.viewId,
    normalized.transport,
    input.observedAt,
  ).run();
}

function validateUnsafeWriter(
  input: G60DurableUnsafeWriterObservation,
): Required<Pick<G60DurableUnsafeWriterObservation, "transport">> {
  nonEmpty(input.serviceId, "serviceId");
  nonEmpty(input.eventId, "eventId");
  nonEmpty(input.suid, "suid");
  nonEmpty(input.attemptId, "attemptId");
  nonEmpty(input.viewId, "viewId");
  nonEmpty(input.outcome, "outcome");
  if (!G60_UNSAFE_WRITER_PATHS.includes(input.writerPath)) {
    throw new Error(`G60 unknown unsafe writer path: ${input.writerPath}`);
  }
  if (input.boundary !== "start" && input.boundary !== "end") {
    throw new Error(`G60 unsafe writer boundary must be start or end: ${input.boundary}`);
  }
  if (!Number.isSafeInteger(input.observedAt) || input.observedAt < 0) {
    throw new Error("G60 unsafe writer observedAt must be a non-negative safe integer");
  }
  const transport = input.transport ?? "";
  if (!["", "queue", "fast", "import", "scheduled"].includes(transport)) {
    throw new Error(`G60 unsafe writer transport is invalid: ${transport}`);
  }
  return { transport };
}

/** Append one exact unsafe-row writer boundary; replays retain the first row. */
export async function recordDurableUnsafeWriterBoundary(
  database: D1Database,
  input: G60DurableUnsafeWriterObservation,
): Promise<void> {
  const normalized = validateUnsafeWriter(input);
  await database.prepare(`
    INSERT OR IGNORE INTO serialized_dcb_unsafe_writer_boundaries
      (service_id, event_id, suid, attempt_id, writer_path, boundary,
       outcome, view_id, transport, observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    input.serviceId,
    input.eventId,
    input.suid,
    input.attemptId,
    input.writerPath,
    input.boundary,
    input.outcome,
    input.viewId,
    normalized.transport,
    input.observedAt,
  ).run();
}

/**
 * Deliver one post-admission observation to the active waitUntil-backed
 * observer. A diagnostic observer is never allowed to change protocol flow.
 */
export function observeG60PostAdmission(
  observer: G60DurableHopObserver | undefined,
  input: G60DurablePostAdmissionObservation,
): void {
  try {
    observer?.observeSubstep?.(input);
  } catch {
    // Observation is never allowed to affect admission, delivery, or reads.
  }
}

/** Deliver a concrete writer observation without allowing it to affect flow. */
export function observeG60UnsafeWriter(
  observer: G60DurableHopObserver | undefined,
  input: G60DurableUnsafeWriterObservation,
): void {
  try {
    observer?.observeUnsafeWriter?.(input);
  } catch {
    // Observation is never allowed to affect the unsafe apply or its caller.
  }
}

/**
 * Schedule an observation without extending the application response or
 * transport loop. The timestamp is captured by the caller at the hop; only
 * the operational D1 write is deferred to the active Worker invocation.
 */
export function createG60DurableHopObserver(
  database: D1Database | undefined,
  waitUntil: (promise: Promise<unknown>) => void,
): G60DurableHopObserver | undefined {
  if (database === undefined) return undefined;
  return Object.freeze({
    observe(input: G60DurableHopObservation): void {
      const write = recordDurableHop(database, input).catch(() => undefined);
      waitUntil(write);
    },
    observeSubstep(input: G60DurablePostAdmissionObservation): void {
      const write = recordDurableHopSubstep(database, input).catch(() => undefined);
      waitUntil(write);
    },
    observeUnsafeWriter(input: G60DurableUnsafeWriterObservation): void {
      const write = recordDurableUnsafeWriterBoundary(database, input).catch(() => undefined);
      waitUntil(write);
    },
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resolve a public MV row back to the exact source EventId. Prefer the
 * generation's durable unsafe receipt; if it has already been retired, use
 * the source D1 point only when the SUID is unambiguous. G32 intentionally
 * permits SUID collisions, so an ambiguous fallback is censored rather than
 * attributed to the wrong event.
 */
export async function recordFirstUnsafeVisibleRead(
  pipelineDatabase: D1Database,
  materializedViewDatabase: D1Database,
  input: Readonly<{
    serviceId: string;
    viewId: string;
    suid: string;
    eventIdHint?: string;
    observedAt: number;
  }>,
): Promise<boolean> {
  if (input.suid.length === 0 || input.viewId.length === 0) return false;
  const receiptRows = await materializedViewDatabase.prepare(`
    SELECT event_id, suid
      FROM mv_unsafe_receipts
     WHERE service_id = ? AND view_id = ? AND suid COLLATE BINARY = ? COLLATE BINARY
     ORDER BY observed_at ASC, event_id COLLATE BINARY ASC
  `).bind(input.serviceId, input.viewId, input.suid).all<D1HopRow>();
  let eventId: string | undefined;
  let suid = input.suid;
  if (input.eventIdHint !== undefined && receiptRows.results.some((row) => row.event_id === input.eventIdHint)) {
    eventId = input.eventIdHint;
  } else if (receiptRows.results.length === 1) {
    eventId = asString(receiptRows.results[0]?.event_id);
    suid = asString(receiptRows.results[0]?.suid) ?? input.suid;
  }

  let attemptId: string | undefined;
  if (eventId === undefined) {
    const sourceRows = await pipelineDatabase.prepare(`
      SELECT event."Id" AS event_id, event."SortableUniqueId" AS suid, ops."AttemptId" AS attempt_id
        FROM dcb_events AS event
        JOIN dcb_event_ops AS ops
          ON ops."ServiceId" = event."ServiceId" AND ops."Id" = event."Id"
       WHERE event."ServiceId" = ?
         AND event."SortableUniqueId" COLLATE BINARY = ? COLLATE BINARY
       ORDER BY event."Id" COLLATE BINARY ASC
    `).bind(input.serviceId, input.suid).all<D1HopRow>();
    if (sourceRows.results.length !== 1) return false;
    const source = sourceRows.results[0];
    eventId = asString(source?.event_id);
    suid = asString(source?.suid) ?? input.suid;
    attemptId = asString(source?.attempt_id);
  }
  if (eventId === undefined) return false;
  if (attemptId === undefined) {
    const source = await pipelineDatabase.prepare(`
      SELECT "AttemptId" AS attempt_id
        FROM dcb_event_ops
       WHERE "ServiceId" = ? AND "Id" = ?
    `).bind(input.serviceId, eventId).first<D1HopRow>();
    attemptId = asString(source?.attempt_id);
  }
  if (attemptId === undefined) return false;
  await recordDurableHop(pipelineDatabase, {
    stage: "first-unsafe-visible-read",
    serviceId: input.serviceId,
    eventId,
    suid,
    attemptId,
    viewId: input.viewId,
    transport: "public-read",
    observedAt: input.observedAt,
  });
  return true;
}
