/**
 * SDT-G65 admission observations.
 *
 * This table is diagnostic only.  It is written through waitUntil after the
 * bounded derived attempt and is never consulted by commit, Queue, safe-lane,
 * or projection code.
 */

export const G65_ADMISSION_CLOCK_ORIGIN = "Date.now epoch ms" as const;
export const G65_ADMISSION_OUTCOMES = ["admitted", "not-admitted", "unknown"] as const;
export type G65AdmissionOutcome = typeof G65_ADMISSION_OUTCOMES[number];

export interface G65AdmissionAttemptObservation {
  readonly serviceId: string;
  readonly eventId: string;
  readonly suid: string;
  readonly attemptId: string;
  readonly partitionTag: string;
  readonly deliverySource: "fast";
  readonly admissionStartedAt: number;
  readonly admissionFinishedAt: number;
  readonly outcome: G65AdmissionOutcome;
  readonly globalCompletionObservedAt: number | null;
}

function nonEmpty(value: string, field: string): void {
  if (value.length === 0) throw new Error(`G65 admission ${field} must be non-empty`);
}

function validate(input: G65AdmissionAttemptObservation): void {
  nonEmpty(input.serviceId, "serviceId");
  nonEmpty(input.eventId, "eventId");
  nonEmpty(input.suid, "suid");
  nonEmpty(input.attemptId, "attemptId");
  nonEmpty(input.partitionTag, "partitionTag");
  if (!Number.isSafeInteger(input.admissionStartedAt) || input.admissionStartedAt < 0) {
    throw new Error("G65 admission start must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(input.admissionFinishedAt) || input.admissionFinishedAt < input.admissionStartedAt) {
    throw new Error("G65 admission finish must be after start");
  }
  if (!G65_ADMISSION_OUTCOMES.includes(input.outcome)) {
    throw new Error(`G65 admission outcome is invalid: ${input.outcome}`);
  }
  if (input.globalCompletionObservedAt !== null &&
    (!Number.isSafeInteger(input.globalCompletionObservedAt) || input.globalCompletionObservedAt < input.admissionStartedAt)) {
    throw new Error("G65 global completion observation is invalid");
  }
}

export async function recordG65AdmissionAttempt(
  database: D1Database,
  input: G65AdmissionAttemptObservation,
): Promise<void> {
  validate(input);
  await database.prepare(`
    INSERT OR IGNORE INTO serialized_dcb_g65_admission_attempts
      (service_id, event_id, suid, attempt_id, partition_tag, delivery_source,
       admission_started_at, admission_finished_at, outcome,
       global_completion_observed_at, clock_origin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    input.serviceId,
    input.eventId,
    input.suid,
    input.attemptId,
    input.partitionTag,
    input.deliverySource,
    input.admissionStartedAt,
    input.admissionFinishedAt,
    input.outcome,
    input.globalCompletionObservedAt,
    G65_ADMISSION_CLOCK_ORIGIN,
  ).run();
}
