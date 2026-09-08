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
  /** Platform Queue wrapper identity; null when the transport did not expose one. */
  readonly queueMessageId: string | null;
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
  /** Timestamp of the diagnostic before-read, if it completed before core. */
  readonly beforeObservedAt: number | null;
  /** Timestamp captured immediately before the diagnostic after-read. */
  readonly afterObservedAt: number | null;
  /** Explicitly distinguishes a usable before-core observation from a late/missing read. */
  readonly observationConsistency:
    | "before-core"
    | "before-core-absent"
    | "before-read-after-core"
    | "before-read-failed"
    | "after-read-failed"
    | "unverified";
  readonly status: G69AdmissionAttemptStatus;
  readonly retryReason: string | null;
}

/** Best-effort because evidence availability cannot change delivery semantics. */
export async function appendG69AdmissionAttempt(
  database: D1Database,
  receipt: G69AdmissionAttemptReceipt,
): Promise<void> {
  const insert = database.prepare(
    `INSERT INTO serialized_dcb_g69_admission_attempts
       (service_id, event_id, suid, partition_tag, delivery_source,
        queue_message_id, attempt_id, allocator_lineage_id, obligation_sequence,
        enqueued_at, observed_at, arrived_at,
        first_arrived_at_before, last_arrived_at_before,
        first_arrived_at_after, last_arrived_at_after,
        before_observed_at, after_observed_at, observation_consistency,
        receipt_status, retry_reason, clock_origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    receipt.beforeObservedAt,
    receipt.afterObservedAt,
    receipt.observationConsistency,
    receipt.status,
    receipt.retryReason,
    "Date.now epoch ms",
  );
  // Keep diagnostic history bounded per service. The receipt is deliberately
  // outside core admission, so inability to retain it never changes Queue
  // disposition or the public commit/delivery result.
  const trim = database.prepare(
    `DELETE FROM serialized_dcb_g69_admission_attempts
      WHERE service_id = ?
        AND sequence NOT IN (
          SELECT sequence FROM serialized_dcb_g69_admission_attempts
           WHERE service_id = ? ORDER BY sequence DESC LIMIT 512
        )`,
  ).bind(receipt.serviceId, receipt.serviceId);
  await database.batch([insert, trim]);
}
