/**
 * SDT-G69 append-only delivery-attempt evidence.
 *
 * This ledger is diagnostic only. DeliveryCore, Queue disposition, G44
 * coverage, and the safe frontier must never read it. A row represents one
 * call to D1EventStore.recordDelivery, including an idempotent replay or a
 * typed delivery failure when the diagnostic table itself is available.
 */
import type { DeliverySource } from "../downstream/types";

export type G69AdmissionAttemptStatus =
  | "stored"
  | "duplicate"
  | "suid-collision"
  | "lineage-mismatch"
  | "failed";

export interface G69AdmissionAttemptReceipt {
  readonly serviceId: string;
  readonly eventId: string;
  readonly suid: string;
  readonly tag: string;
  readonly deliverySource: DeliverySource;
  /** The current envelope's attemptId is the durable Queue message identity. */
  readonly queueMessageId: string;
  readonly attemptId: string;
  readonly allocatorLineageId: string;
  readonly obligationSequence: number;
  readonly enqueuedAt: number;
  readonly observedAt: number;
  readonly arrivedAt: number;
  readonly firstArrivedAtBefore: number | null;
  readonly lastArrivedAtBefore: number | null;
  readonly firstArrivedAtAfter: number | null;
  readonly lastArrivedAtAfter: number | null;
  readonly status: G69AdmissionAttemptStatus;
  readonly retryReason: string | null;
}

/** Best-effort because evidence availability cannot change delivery semantics. */
export async function appendG69AdmissionAttempt(
  database: D1Database,
  receipt: G69AdmissionAttemptReceipt,
): Promise<void> {
  await database.prepare(
    `INSERT INTO serialized_dcb_g69_admission_attempts
       (service_id, event_id, suid, partition_tag, delivery_source,
        queue_message_id, attempt_id, allocator_lineage_id, obligation_sequence,
        enqueued_at, observed_at, arrived_at,
        first_arrived_at_before, last_arrived_at_before,
        first_arrived_at_after, last_arrived_at_after,
        receipt_status, retry_reason, clock_origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    receipt.serviceId,
    receipt.eventId,
    receipt.suid,
    receipt.tag,
    receipt.deliverySource,
    receipt.queueMessageId,
    receipt.attemptId,
    receipt.allocatorLineageId,
    receipt.obligationSequence,
    receipt.enqueuedAt,
    receipt.observedAt,
    receipt.arrivedAt,
    receipt.firstArrivedAtBefore,
    receipt.lastArrivedAtBefore,
    receipt.firstArrivedAtAfter,
    receipt.lastArrivedAtAfter,
    receipt.status,
    receipt.retryReason,
    "Date.now epoch ms",
  ).run();
}
