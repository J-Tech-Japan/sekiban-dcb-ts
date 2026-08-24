/**
 * Separate Workers Logs observation stream for SDT-G30.
 *
 * This deliberately is not a CommitTrace span and never adds an attribute to
 * the sealed sdt.commit/v1 matrix. Structured console events carry provider
 * request metadata but Workers Logs does not expose a trace id for them. The
 * exporter joins existing post-admission/attempt correlation to S00 and fails
 * closed when that chain or the client-ledger identity is absent.
 *
 * The stream is observation-only: it does not write Durable Object storage,
 * decide a control branch, or contribute to a public response.
 */

import {
  correlationIdForAttempt,
  type CommitTraceActorClass,
  type DurableObjectActivationObservation,
} from "./CommitTrace";

export const OBSERVATION_SCHEMA = "sdt.observe/v1" as const;

export type ObservationActorClass = "WORKER" | Exclude<CommitTraceActorClass, "ROOT" | "REPAIR">;

export type ObservationEvent =
  | Readonly<{
    schema: typeof OBSERVATION_SCHEMA;
    event: "worker.invocation";
    emittedAtMs: number;
    /** Provider-owned ingress ray retained only in the observation stream. */
    requestId: string;
    /** Existing post-admission trace correlation; not a new wire field. */
    correlationId: string;
    actorClass: "WORKER";
    isolateInstanceId: string;
    activationFirst: boolean;
    /** Overlaps S00 and is cross-checked by the exported evidence contract. */
    scriptVersion?: string;
    /** Overlaps S00 and is cross-checked by the exported evidence contract. */
    colo?: string;
    storageWrites: 0;
    usedForControl: false;
    exposedInPublicResponse: false;
  }>
  | Readonly<{
    schema: typeof OBSERVATION_SCHEMA;
    event: "do.handler";
    emittedAtMs: number;
    /** Existing attempt-derived trace correlation when actor identity exists. */
    correlationId?: string;
    actorClass: Exclude<ObservationActorClass, "WORKER">;
    activationId: string;
    activationFirst: boolean;
    constructorToHandlerMs: number;
    firstStorageReadMs: number | null;
    subrequestWallMs: number | null;
    storageWrites: 0;
    usedForControl: false;
    exposedInPublicResponse: false;
  }>
  | Readonly<{
    schema: typeof OBSERVATION_SCHEMA;
    event: "fault.barrier";
    emittedAtMs: number;
    /** Existing downstream-attempt correlation when the test seam has one. */
    correlationId?: string;
    barrierId: string;
    stage: "started" | "ended" | "drained";
    boundedWindowMs: number;
    storageWrites: 0;
    usedForControl: false;
    exposedInPublicResponse: false;
  }>;

export interface ObservationLogSink {
  emit(event: ObservationEvent): void;
}

const consoleSink: ObservationLogSink = Object.freeze({
  emit(event: ObservationEvent): void {
    // Workers Logs indexes object members directly.  The platform supplies
    // the request/trace metadata; application code has no public trace-id API
    // and must not introduce a propagation header just for attribution.
    console.log(event);
  },
});

function now(): number {
  return Date.now();
}

function nonNegativeElapsed(startedAtMs: number): number {
  return Math.max(0, now() - startedAtMs);
}

/** A log transport failure is itself non-semantic. */
export function emitObservation(event: ObservationEvent, sink: ObservationLogSink = consoleSink): void {
  try {
    sink.emit(event);
  } catch {
    // G30 observes an existing commit; logging can never replace its result.
  }
}

export function observeWorkerInvocation(input: Readonly<{
  isolateInstanceId: string;
  firstInvocation: boolean;
  requestId: string;
  correlationId: string;
  scriptVersion?: string;
  colo?: string;
}>, sink?: ObservationLogSink): void {
  // A missing ingress identity cannot affect a commit. The B0 exporter fails
  // closed later if an accepted request does not have this observation.
  if (input.requestId.length === 0 || input.correlationId.length === 0) return;
  emitObservation(Object.freeze({
    schema: OBSERVATION_SCHEMA,
    event: "worker.invocation",
    emittedAtMs: now(),
    requestId: input.requestId,
    correlationId: input.correlationId,
    actorClass: "WORKER",
    isolateInstanceId: input.isolateInstanceId,
    activationFirst: input.firstInvocation,
    ...(typeof input.scriptVersion === "string" && input.scriptVersion.length > 0 ? { scriptVersion: input.scriptVersion } : {}),
    ...(typeof input.colo === "string" && input.colo.length > 0 ? { colo: input.colo } : {}),
    storageWrites: 0,
    usedForControl: false,
    exposedInPublicResponse: false,
  }), sink);
}

/**
 * One handler-local stopwatch.  It is created after the constructor-derived
 * activation fact and is passed explicitly; there is no module/global
 * request state and no durable persistence.
 */
export class DurableObjectHandlerObservation {
  private firstStorageReadMs: number | undefined;
  private subrequestWallMs = 0;
  private observedSubrequest = false;
  private finished = false;
  private correlationId: string | undefined;

  constructor(
    private readonly actorClass: Exclude<ObservationActorClass, "WORKER">,
    private readonly activation: DurableObjectActivationObservation,
    private readonly sink?: ObservationLogSink,
  ) {}

  /** Call immediately before the first durable read/transaction starts. */
  markFirstStorageRead(): void {
    if (this.firstStorageReadMs !== undefined) return;
    this.firstStorageReadMs = nonNegativeElapsed(this.activation.handlerStartedAtMs);
  }

  /** Measures an actual awaited subrequest, never a declared duration. */
  async subrequest<T>(callback: () => Promise<T>): Promise<T> {
    const startedAtMs = now();
    this.observedSubrequest = true;
    try {
      return await callback();
    } finally {
      this.subrequestWallMs += nonNegativeElapsed(startedAtMs);
    }
  }

  /**
   * Actor identity is decoded from the existing body before the callback.
   * Retaining its established trace correlation in the log avoids a new
   * propagation header, durable write, or public response field.
   */
  bindCorrelation(correlationId: string | undefined): void {
    if (typeof correlationId === "string" && correlationId.length > 0) this.correlationId = correlationId;
  }

  /** Emits at most once and only after the native actor callback settles. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    emitObservation(Object.freeze({
      schema: OBSERVATION_SCHEMA,
      event: "do.handler",
      emittedAtMs: now(),
      ...(this.correlationId === undefined ? {} : { correlationId: this.correlationId }),
      actorClass: this.actorClass,
      activationId: this.activation.activationId,
      activationFirst: this.activation.first,
      constructorToHandlerMs: this.activation.constructorToHandlerMs,
      firstStorageReadMs: this.firstStorageReadMs ?? null,
      subrequestWallMs: this.observedSubrequest ? this.subrequestWallMs : null,
      storageWrites: 0,
      usedForControl: false,
      exposedInPublicResponse: false,
    }), this.sink);
  }
}

export function beginDurableObjectHandlerObservation(
  actorClass: Exclude<ObservationActorClass, "WORKER">,
  activation: DurableObjectActivationObservation,
  sink?: ObservationLogSink,
): DurableObjectHandlerObservation {
  return new DurableObjectHandlerObservation(actorClass, activation, sink);
}

/** Test seams may record bounded fault lifecycle facts without a V1 extension. */
export function observeFaultBarrier(
  input: Readonly<{
    barrierId: string;
    stage: "started" | "ended" | "drained";
    boundedWindowMs: number;
    /** Existing downstream attempt identity available only to the test seam. */
    attemptId?: string;
  }>,
  sink?: ObservationLogSink,
): void {
  if (!Number.isFinite(input.boundedWindowMs) || input.boundedWindowMs < 0) return;
  emitObservation(Object.freeze({
    schema: OBSERVATION_SCHEMA,
    event: "fault.barrier",
    emittedAtMs: now(),
    ...(typeof input.attemptId === "string" && input.attemptId.length > 0
      ? { correlationId: correlationIdForAttempt(input.attemptId) }
      : {}),
    barrierId: input.barrierId,
    stage: input.stage,
    boundedWindowMs: input.boundedWindowMs,
    storageWrites: 0,
    usedForControl: false,
    exposedInPublicResponse: false,
  }), sink);
}
