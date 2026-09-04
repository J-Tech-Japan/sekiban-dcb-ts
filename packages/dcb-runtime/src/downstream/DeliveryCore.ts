import { BindingExclusionLedgerClient } from "./ExclusionLookup";
import { InconsistencyDetector } from "./InconsistencyDetector";
import { resolveDeliveryIdentity } from "../eventIdentity";
import type { DeliverySource, DownstreamOutboxMessage, PipelineClock } from "./types";
import { systemPipelineClock } from "./types";
import type { StoreProvider } from "../store/provider";
import type { StoreProviderEnvironment } from "../store/provider";
import type { GlobalReceiptJoin, PipelineStore, StoredEvent } from "../store/types";
import { observeG60PostAdmission, type G60DurableHopObserver } from "../diagnostics/G60DurableHop";

export type DeliveryViewFailureClass =
  | "retryable-transient"
  | "duplicate-race"
  | "nonretryable-definition-poison";

export type DeliveryViewApplyResult = "applied" | "duplicate-race" | void;

export interface DeliveryViewInput {
  readonly message: DownstreamOutboxMessage;
  readonly event: StoredEvent;
  readonly arrivedAt: number;
  readonly source: DeliverySource;
}

/**
 * A view handler owns one view's unsafe observation and atomic apply.  The
 * delivery core deliberately knows nothing about D1 rows, receipts, or kicks;
 * this boundary is what lets the Queue and doorbell share exactly one order
 * of operations.
 */
export interface DeliveryViewHandler {
  readonly id: string;
  /**
   * The exceptional unsafe lane is independent of G44 completeness. It may
   * only be used by a handler whose mutation never advances a safe
   * checkpoint; omitted means the ordinary completeness-gated lane.
   */
  readonly admission?: "independent-unsafe";
  readonly apply: (input: DeliveryViewInput) => Promise<DeliveryViewApplyResult>;
  readonly classifyError?: (error: unknown) => DeliveryViewFailureClass;
}

export interface DeliveryViewResult {
  readonly id: string;
  readonly status: "applied" | "duplicate-race" | "failed";
  readonly failureClass?: DeliveryViewFailureClass;
  readonly error?: string;
  readonly durationMs: number;
}

export interface DeliveryCoreFailure {
  readonly phase: "recordDelivery" | "detector" | "completeness" | "view" | "drain";
  readonly class: DeliveryViewFailureClass | "retryable-transient";
  readonly viewId?: string;
  readonly error: string;
}

export interface DeliveryCoreResult {
  readonly source: DeliverySource;
  readonly correlationId: string;
  readonly outcome: "stored" | "suid-collision" | "lineage-mismatch";
  readonly arrivedAt: number;
  readonly detectorApplied: boolean;
  readonly views: readonly DeliveryViewResult[];
  readonly failures: readonly DeliveryCoreFailure[];
  readonly coreDurationMs: number;
  /** The queue wrapper is the only caller that turns this into ack/retry. */
  readonly queueDisposition: "ack" | "retry-once" | "retry-to-dlq";
  /** A durable poison finding must reach bounded Queue/DLQ remediation. */
  readonly queueDispositionReason: "none" | "duplicate-race-retry" | "retryable-transient" | "definition-poison-dlq";
  /** The fast wrapper never retries or changes outbox state. */
  readonly fastDisposition: "completed" | "failed";
}

export interface DeliveryCoreOptions {
  readonly clock?: PipelineClock;
  readonly store?: PipelineStore;
  readonly storeProvider?: StoreProvider;
  readonly views?: readonly DeliveryViewHandler[];
  /** Internal G60 hop observation; it is never a delivery decision input. */
  readonly durableHopObserver?: G60DurableHopObserver;
  /** Compatibility hook for callers that have not adopted a view handler yet. */
  readonly onStored?: (input: {
    readonly message: DownstreamOutboxMessage;
    readonly event: StoredEvent;
    readonly arrivedAt: number;
    readonly source: DeliverySource;
  }) => Promise<void>;
  readonly afterDelivery?: (input: {
    readonly message: DownstreamOutboxMessage;
    readonly event: StoredEvent;
    readonly arrivedAt: number;
    readonly source: DeliverySource;
    readonly result: DeliveryCoreResult;
  }) => Promise<void>;
  /**
   * Source acknowledgement is allowed only after D1 has read back an exact
   * event + committed-membership + receipt join. Queue/doorbell handoff is
   * intentionally not an acknowledgement authority.
   */
  readonly afterGlobalReceipt?: (input: {
    readonly message: DownstreamOutboxMessage;
    readonly receipt: GlobalReceiptJoin;
    readonly arrivedAt: number;
    readonly source: DeliverySource;
  }) => Promise<void>;
  /**
   * G44's one internal coverage gate.  The receipt remains durable, but a
   * materialized/live view cannot advance while global completeness is not
   * proven by a FULL source scan.
   */
  readonly beforeViews?: (input: {
    readonly message: DownstreamOutboxMessage;
    readonly event: StoredEvent;
    readonly arrivedAt: number;
    readonly source: DeliverySource;
  }) => Promise<void>;
  /**
   * G44 records a detector fault before returning. The core still fails
   * closed even when this observation authority itself is unavailable.
   */
  readonly onDetectorFailure?: (input: {
    readonly message: DownstreamOutboxMessage;
    readonly arrivedAt: number;
    readonly source: DeliverySource;
    readonly error: unknown;
  }) => Promise<void>;
  readonly correlationId?: string;
}

export interface DeliveryCoreEnvironment extends StoreProviderEnvironment {
  readonly REPAIR_EXCLUSION_LOOKUP?: Fetcher;
}

export type { DeliverySource };

function observePostAdmission(
  observer: G60DurableHopObserver | undefined,
  message: DownstreamOutboxMessage,
  source: DeliverySource,
  input: Readonly<{
    stage: "post-record-delivery-global-receipt-readback" | "completeness-coverage" | "detector" | "unsafe-view-apply";
    boundary: "start" | "end";
    outcome: string;
    viewId?: string;
  }>,
): void {
  observeG60PostAdmission(observer, {
    ...input,
    serviceId: message.serviceId,
    eventId: message.eventId,
    suid: message.suid,
    attemptId: message.attemptId,
    partitionTag: message.tag,
    transport: source,
    observedAt: Date.now(),
  });
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}

export function deliveryCorrelationId(message: DownstreamOutboxMessage, source: DeliverySource, supplied?: string): string {
  return supplied ?? `${source}:${message.serviceId}:${message.eventId}:${message.attemptId}`;
}

function defaultFailureClass(error: unknown): DeliveryViewFailureClass {
  const candidate = error as { readonly code?: unknown; readonly retryable?: unknown; readonly failureClass?: unknown };
  if (candidate.failureClass === "duplicate-race") return "duplicate-race";
  if (candidate.failureClass === "nonretryable-definition-poison") return "nonretryable-definition-poison";
  if (candidate.failureClass === "retryable-transient") return "retryable-transient";
  if (candidate.code === "UNSAFE_DUPLICATE_RACE") return "duplicate-race";
  if (candidate.retryable === false) return "nonretryable-definition-poison";
  return "retryable-transient";
}

function disposition(
  failures: readonly DeliveryCoreFailure[],
  source: DeliverySource,
): Pick<DeliveryCoreResult, "queueDisposition" | "queueDispositionReason" | "fastDisposition"> {
  // A duplicate race is a blocking Queue outcome: the loser must be delivered
  // once more so the receipt guard can turn the replay into a durable no-op.
  // The fast path remains silent-fallback, so its disposition is calculated
  // from the non-duplicate failures separately below.
  const blocking = failures.length > 0;
  const duplicateRaceOnly = blocking && failures.every((failure) => failure.class === "duplicate-race");
  const poisonOnly = blocking && failures.every((failure) => failure.class === "nonretryable-definition-poison");
  const fastBlocking = failures.some((failure) => failure.class !== "duplicate-race");
  return {
    queueDisposition: !blocking ? "ack" : duplicateRaceOnly ? "retry-once" : "retry-to-dlq",
    queueDispositionReason: !blocking ? "none" : duplicateRaceOnly ? "duplicate-race-retry" : poisonOnly ? "definition-poison-dlq" : "retryable-transient",
    fastDisposition: source === "fast" && fastBlocking ? "failed" : "completed",
  };
}

function result(
  source: DeliverySource,
  message: DownstreamOutboxMessage,
  outcome: DeliveryCoreResult["outcome"],
  arrivedAt: number,
  detectorApplied: boolean,
  views: readonly DeliveryViewResult[],
  failures: readonly DeliveryCoreFailure[],
  suppliedCorrelationId?: string,
  startedAt = performance.now(),
): DeliveryCoreResult {
  return {
    source,
    correlationId: deliveryCorrelationId(message, source, suppliedCorrelationId),
    outcome,
    arrivedAt,
    detectorApplied,
    views,
    failures,
    coreDurationMs: Math.max(0, performance.now() - startedAt),
    ...disposition(failures, source),
  };
}

function providerStore(env: DeliveryCoreEnvironment, options: DeliveryCoreOptions): PipelineStore {
  if (options.store !== undefined) return options.store;
  if (options.storeProvider === undefined) throw new Error("A downstream store provider is not configured");
  return options.storeProvider.create(env);
}

interface AppliedViewBatch {
  readonly results: readonly DeliveryViewResult[];
  readonly failures: readonly DeliveryCoreFailure[];
}

async function applyViewHandlers(
  views: readonly DeliveryViewHandler[],
  message: DownstreamOutboxMessage,
  storedEvent: StoredEvent,
  arrivedAt: number,
  source: DeliverySource,
  observer: G60DurableHopObserver | undefined,
): Promise<AppliedViewBatch> {
  // The branches are independent atomic batches, so starting them together
  // bounds fast-path latency by the slowest view while preserving the input
  // order in the returned oracle.
  const outcomes = await Promise.all(views.map(async (view) => {
    const viewStartedAt = performance.now();
    observePostAdmission(observer, message, source, {
      stage: "unsafe-view-apply",
      boundary: "start",
      outcome: "started",
      viewId: view.id,
    });
    try {
      const applied = await view.apply({ message, event: storedEvent, arrivedAt, source });
      const status = applied === "duplicate-race" ? "duplicate-race" : "applied";
      observePostAdmission(observer, message, source, {
        stage: "unsafe-view-apply",
        boundary: "end",
        outcome: status,
        viewId: view.id,
      });
      return {
        result: { id: view.id, status, durationMs: Math.max(0, performance.now() - viewStartedAt) } as DeliveryViewResult,
        failure: undefined,
      };
    } catch (error) {
      const failureClass = view.classifyError?.(error) ?? defaultFailureClass(error);
      observePostAdmission(observer, message, source, {
        stage: "unsafe-view-apply",
        boundary: "end",
        outcome: `failed:${failureClass}`,
        viewId: view.id,
      });
      return {
        result: {
          id: view.id,
          status: "failed",
          failureClass,
          error: errorText(error),
          durationMs: Math.max(0, performance.now() - viewStartedAt),
        } as DeliveryViewResult,
        failure: { phase: "view", class: failureClass, viewId: view.id, error: errorText(error) } as DeliveryCoreFailure,
      };
    }
  }));
  const results = outcomes.map((outcome) => outcome.result);
  const failures = outcomes
    .map((outcome) => outcome.failure)
    .filter((failure): failure is DeliveryCoreFailure => failure !== undefined);
  return { results, failures };
}

/**
 * Shared transport-neutral delivery order.  There are intentionally no Queue
 * message methods, outbox marks, or retry decisions in this function.
 */
export async function processDeliveryCore(
  message: DownstreamOutboxMessage,
  source: DeliverySource,
  env: DeliveryCoreEnvironment,
  options: DeliveryCoreOptions = {},
): Promise<DeliveryCoreResult> {
  const startedAt = performance.now();
  // Admission is deliberately before initialize/recordDelivery: a malformed
  // post-G27 envelope cannot create an incident, detector row, or view state.
  const resolvedIdentity = resolveDeliveryIdentity(message, source);
  const store = providerStore(env, options);
  await store.initialize();
  const clock = options.clock ?? systemPipelineClock;
  const arrivedAt = clock.now();
  let outcome;
  try {
    // Normative step 1: durable EventStore record before any detector or view.
    outcome = await store.recordDelivery(message, arrivedAt, source);
    options.durableHopObserver?.observe({
      stage: "record-delivery-batch-committed",
      serviceId: message.serviceId,
      eventId: message.eventId,
      suid: message.suid,
      attemptId: message.attemptId,
      partitionTag: message.tag,
      transport: source,
      // D1 recordDelivery returns only after its batch and read-back have
      // settled; this is the durable post-batch observation boundary.
      observedAt: Date.now(),
    });
  } catch (error) {
    const failures: DeliveryCoreFailure[] = [{ phase: "recordDelivery", class: "retryable-transient", error: errorText(error) }];
    return result(source, message, "stored", arrivedAt, false, [], failures, options.correlationId, startedAt);
  }

  // Normative step 2: typed non-stored outcome gate.  Only incident
  // projection is allowed beyond this point for a collision or lineage miss.
  if (outcome.outcome !== "stored") {
    try {
      await store.projectDeliveryIncidents?.(message.serviceId);
    } catch (error) {
      const failures: DeliveryCoreFailure[] = [{ phase: "detector", class: "retryable-transient", error: errorText(error) }];
      return result(source, message, outcome.outcome, arrivedAt, false, [], failures, options.correlationId, startedAt);
    }
    return result(source, message, outcome.outcome, arrivedAt, false, [], [], options.correlationId, startedAt);
  }

  const storedEvent: StoredEvent = resolvedIdentity.legacy && outcome.event.eventType === undefined
    ? outcome.event
    : {
      ...outcome.event,
      eventType: outcome.event.eventType ?? resolvedIdentity.key,
      provenance: outcome.event.provenance ?? resolvedIdentity.provenance,
    };
  const failures: DeliveryCoreFailure[] = [];
  const allViews = options.views ?? [];
  const unsafeViews = allViews.filter((view) => view.admission === "independent-unsafe");
  const gatedViews = allViews.filter((view) => view.admission !== "independent-unsafe");
  // G44: D1's atomic batch is followed by an independent join read-back
  // before a source Tag DO can mark its obligation acknowledged.
  if (store.readGlobalReceiptJoin !== undefined) {
    let receipt: GlobalReceiptJoin | undefined;
    observePostAdmission(options.durableHopObserver, message, source, {
      stage: "post-record-delivery-global-receipt-readback",
      boundary: "start",
      outcome: "started",
    });
    try {
      receipt = await store.readGlobalReceiptJoin(message);
      if (receipt === undefined) throw new Error("global receipt/membership join is absent");
      observePostAdmission(options.durableHopObserver, message, source, {
        stage: "post-record-delivery-global-receipt-readback",
        boundary: "end",
        outcome: "available",
      });
    } catch (error) {
      observePostAdmission(options.durableHopObserver, message, source, {
        stage: "post-record-delivery-global-receipt-readback",
        boundary: "end",
        outcome: "error",
      });
      failures.push({ phase: "recordDelivery", class: "retryable-transient", error: errorText(error) });
      return result(source, message, "stored", arrivedAt, false, [], failures, options.correlationId, startedAt);
    }
    if (options.afterGlobalReceipt !== undefined) {
      try {
        await options.afterGlobalReceipt({ message, receipt, arrivedAt, source });
      } catch (error) {
        failures.push({ phase: "drain", class: "retryable-transient", error: errorText(error) });
      }
    }
  }
  // G60's exceptional unsafe lane is deliberately after recordDelivery and
  // the exact global-receipt/source acknowledgement, but before the G44
  // completeness gate. It writes only unsafe-window rows and kicks; it never
  // advances a safe checkpoint. Ordinary views remain below the gate.
  const unsafeViewBatch = await applyViewHandlers(
    unsafeViews,
    message,
    storedEvent,
    arrivedAt,
    source,
    options.durableHopObserver,
  );
  const viewResults: DeliveryViewResult[] = [...unsafeViewBatch.results];
  failures.push(...unsafeViewBatch.failures);

  if (options.beforeViews !== undefined) {
    try {
      await options.beforeViews({ message, event: storedEvent, arrivedAt, source });
    } catch (error) {
      failures.push({ phase: "completeness", class: "retryable-transient", error: errorText(error) });
      return result(source, message, "stored", arrivedAt, false, viewResults, failures, options.correlationId, startedAt);
    }
  }
  // Normative step 3: detector only for a stored event.
  let detectorApplied = false;
  observePostAdmission(options.durableHopObserver, message, source, {
    stage: "detector",
    boundary: "start",
    outcome: "started",
  });
  try {
    const lagBound = await store.currentLagBound(message.serviceId, arrivedAt);
    const detector = new InconsistencyDetector(store, new BindingExclusionLedgerClient(env.REPAIR_EXCLUSION_LOOKUP));
    await detector.observe(message, arrivedAt, lagBound);
    detectorApplied = true;
    observePostAdmission(options.durableHopObserver, message, source, {
      stage: "detector",
      boundary: "end",
      outcome: "applied",
    });
  } catch (error) {
    observePostAdmission(options.durableHopObserver, message, source, {
      stage: "detector",
      boundary: "end",
      outcome: "error",
    });
    try {
      await options.onDetectorFailure?.({ message, arrivedAt, source, error });
    } catch (healthError) {
      failures.push({
        phase: "detector",
        class: "retryable-transient",
        error: `detector_health_record_failed:${errorText(healthError)}`,
      });
    }
    failures.push({ phase: "detector", class: "retryable-transient", error: errorText(error) });
    // A detector failure makes global completeness unknown. Do not apply a
    // view after that failure; an earlier version accumulated the error and
    // then silently continued into views.apply.
    return result(source, message, "stored", arrivedAt, false, [], failures, options.correlationId, startedAt);
  }

  const views = gatedViews;
  const gatedViewBatch = await applyViewHandlers(
    views,
    message,
    storedEvent,
    arrivedAt,
    source,
    options.durableHopObserver,
  );
  viewResults.push(...gatedViewBatch.results);
  failures.push(...gatedViewBatch.failures);

  // Compatibility callers still receive their stored-only callback, but it
  // is after all explicit view branches and before the drain trigger.
  if (options.onStored !== undefined) {
    try {
      await options.onStored({ message, event: storedEvent, arrivedAt, source });
    } catch (error) {
      failures.push({ phase: "view", class: "retryable-transient", viewId: "legacy-onStored", error: errorText(error) });
    }
  }

  const preliminary = result(source, message, "stored", arrivedAt, detectorApplied, viewResults, failures, options.correlationId, startedAt);
  // Normative step 5: the trigger is after all view branches.  The trigger is
  // not itself a kick-target mutation; that mutation belongs to each view's
  // single MV-D1 apply batch.
  if (options.afterDelivery !== undefined && failures.every((failure) => failure.class === "duplicate-race")) {
    try {
      await options.afterDelivery({ message, event: storedEvent, arrivedAt, source, result: preliminary });
    } catch (error) {
      failures.push({ phase: "drain", class: "retryable-transient", error: errorText(error) });
    }
  }
  return result(source, message, "stored", arrivedAt, detectorApplied, viewResults, failures, options.correlationId, startedAt);
}
