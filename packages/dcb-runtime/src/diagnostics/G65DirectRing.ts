/**
 * SDT-G65 AC0 direct-doorbell RING/APPLY ledger.
 *
 * A ring is a durable receiver acceptance of the immutable Queue envelope.
 * Only the ring insert is on the caller's RPC path.  The receiver reads the
 * retained bytes in its own execution context and runs the existing delivery
 * core asynchronously; this ledger is never an admission, retry, projection,
 * or public-response decision.
 */

import type { DownstreamOutboxMessage } from "../downstream/types";

export const G65_DIRECT_RING_BUDGET_MS = 100;
export const G65_DIRECT_RING_CLOCK_ORIGIN = "Date.now epoch ms" as const;

export type G65DirectRingOutcome = "rung" | "duplicate";
export type G65DirectApplyOutcome = "applied" | "duplicate" | "failed";

export interface G65DirectRingRecord {
  readonly serviceId: string;
  readonly eventId: string;
  readonly suid: string;
  readonly attemptId: string;
  readonly partitionTag: string;
  readonly messageJson: string;
  readonly ringStartedAt: number;
  readonly ringFinishedAt: number;
  readonly ringOutcome: G65DirectRingOutcome;
}

function nonEmpty(value: string, field: string): void {
  if (value.length === 0) throw new Error(`G65 direct ring ${field} must be non-empty`);
}

function validateMessage(message: DownstreamOutboxMessage): void {
  nonEmpty(message.serviceId, "serviceId");
  nonEmpty(message.eventId, "eventId");
  nonEmpty(message.suid, "suid");
  nonEmpty(message.attemptId, "attemptId");
  nonEmpty(message.tag, "partitionTag");
}

function validateTimestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`G65 direct ring ${field} must be a non-negative safe integer`);
}

/** Persist the exact immutable envelope before returning the receiver RPC. */
export async function recordG65DirectRing(
  database: D1Database,
  message: DownstreamOutboxMessage,
  ringStartedAt: number,
): Promise<G65DirectRingOutcome> {
  validateMessage(message);
  validateTimestamp(ringStartedAt, "ring start");
  const result = await database.prepare(`
    INSERT OR IGNORE INTO serialized_dcb_g65_direct_rings
      (service_id, event_id, suid, attempt_id, partition_tag, message_json,
       ring_started_at, ring_finished_at, ring_outcome, apply_outcome)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rung', NULL)
  `).bind(
    message.serviceId,
    message.eventId,
    message.suid,
    message.attemptId,
    message.tag,
    JSON.stringify(message),
    ringStartedAt,
    ringStartedAt,
  ).run();
  const changes = typeof result.meta?.changes === "number" ? result.meta.changes : undefined;
  if (changes === 0) return "duplicate";
  const ringFinishedAt = Date.now();
  validateTimestamp(ringFinishedAt, "ring finish");
  if (ringFinishedAt < ringStartedAt) throw new Error("G65 direct ring finish precedes start");
  await database.prepare(`
    UPDATE serialized_dcb_g65_direct_rings
       SET ring_finished_at = ?
     WHERE service_id = ? AND event_id = ? AND attempt_id = ?
  `).bind(ringFinishedAt, message.serviceId, message.eventId, message.attemptId).run();
  return "rung";
}

/** Read the exact bytes retained by the receiver ring. */
export async function readG65DirectRing(
  database: D1Database,
  message: Pick<DownstreamOutboxMessage, "serviceId" | "eventId" | "attemptId">,
): Promise<DownstreamOutboxMessage | undefined> {
  const row = await database.prepare(`
    SELECT message_json
      FROM serialized_dcb_g65_direct_rings
     WHERE service_id = ? AND event_id = ? AND attempt_id = ?
  `).bind(message.serviceId, message.eventId, message.attemptId).first<{ message_json?: unknown }>();
  if (typeof row?.message_json !== "string") return undefined;
  const parsed = JSON.parse(row.message_json) as DownstreamOutboxMessage;
  validateMessage(parsed);
  return parsed;
}

/** Set the first apply start boundary; duplicate apply attempts do not rewrite it. */
export async function markG65DirectApplyStarted(
  database: D1Database,
  message: Pick<DownstreamOutboxMessage, "serviceId" | "eventId" | "attemptId">,
  observedAt: number,
): Promise<void> {
  validateTimestamp(observedAt, "apply start");
  await database.prepare(`
    UPDATE serialized_dcb_g65_direct_rings
       SET apply_started_at = COALESCE(apply_started_at, ?)
     WHERE service_id = ? AND event_id = ? AND attempt_id = ?
  `).bind(observedAt, message.serviceId, message.eventId, message.attemptId).run();
}

/** Set the first terminal apply outcome and timing. */
export async function markG65DirectApplyFinished(
  database: D1Database,
  message: Pick<DownstreamOutboxMessage, "serviceId" | "eventId" | "attemptId">,
  observedAt: number,
  outcome: G65DirectApplyOutcome,
  error?: string,
): Promise<void> {
  validateTimestamp(observedAt, "apply finish");
  if (outcome.length === 0) throw new Error("G65 direct apply outcome must be non-empty");
  await database.prepare(`
    UPDATE serialized_dcb_g65_direct_rings
       SET apply_finished_at = COALESCE(apply_finished_at, ?),
           apply_outcome = COALESCE(apply_outcome, ?),
           apply_error = COALESCE(apply_error, ?)
     WHERE service_id = ? AND event_id = ? AND attempt_id = ?
  `).bind(
    observedAt,
    outcome,
    error ?? null,
    message.serviceId,
    message.eventId,
    message.attemptId,
  ).run();
}
