import { BindingExclusionLedgerClient } from "./ExclusionLookup";
import { InconsistencyDetector } from "./InconsistencyDetector";
import type { DeliverySource, DownstreamOutboxMessage, PipelineClock } from "./types";
import { systemPipelineClock } from "./types";
import type { StoreProvider } from "../store/provider";
import type { StoreProviderEnvironment } from "../store/provider";
import type { PipelineStore, StoredEvent } from "../store/types";

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
  readonly phase: "recordDelivery" | "detector" | "view" | "drain";
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
  readonly queueDisposition: "ack" | "retry-to-dlq";
  /** A durable poison finding must reach bounded Queue/DLQ remediation. */
  readonly queueDispositionReason: "none" | "retryable-transient" | "definition-poison-dlq";
  /** The fast wrapper never retries or changes outbox state. */
  readonly fastDisposition: "completed" | "failed";
}

export interface DeliveryCoreOptions {
  readonly clock?: PipelineClock;
  readonly store?: PipelineStore;
  readonly storeProvider?: StoreProvider;
  readonly views?: readonly DeliveryViewHandler[];
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
  readonly correlationId?: string;
}

export interface DeliveryCoreEnvironment extends StoreProviderEnvironment {
  readonly REPAIR_EXCLUSION_LOOKUP?: Fetcher;
}

export type { DeliverySource };

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
  const blockingFailures = failures.filter((failure) => failure.class !== "duplicate-race");
  const blocking = blockingFailures.length > 0;
  const poisonOnly = blocking && blockingFailures.every((failure) => failure.class === "nonretryable-definition-poison");
  return {
    queueDisposition: blocking ? "retry-to-dlq" : "ack",
    queueDispositionReason: !blocking ? "none" : poisonOnly ? "definition-poison-dlq" : "retryable-transient",
    fastDisposition: source === "fast" && blocking ? "failed" : "completed",
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
  const store = providerStore(env, options);
  await store.initialize();
  const clock = options.clock ?? systemPipelineClock;
  const arrivedAt = clock.now();
  let outcome;
  try {
    // Normative step 1: durable EventStore record before any detector or view.
    outcome = await store.recordDelivery(message, arrivedAt, source);
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

  const failures: DeliveryCoreFailure[] = [];
  // Normative step 3: detector only for a stored event.
  let detectorApplied = false;
  try {
    const lagBound = await store.currentLagBound(message.serviceId, arrivedAt);
    const detector = new InconsistencyDetector(store, new BindingExclusionLedgerClient(env.REPAIR_EXCLUSION_LOOKUP));
    await detector.observe(message, arrivedAt, lagBound);
    detectorApplied = true;
  } catch (error) {
    failures.push({ phase: "detector", class: "retryable-transient", error: errorText(error) });
  }

  const viewResults: DeliveryViewResult[] = [];
  const views = options.views ?? [];
  // Normative step 4: every view gets a turn, even when an earlier view is a
  // deterministic poison or a transient failure.
  for (const view of views) {
    const viewStartedAt = performance.now();
    try {
      const applied = await view.apply({ message, event: outcome.event, arrivedAt, source });
      const status = applied === "duplicate-race" ? "duplicate-race" : "applied";
      viewResults.push({ id: view.id, status, durationMs: Math.max(0, performance.now() - viewStartedAt) });
    } catch (error) {
      const failureClass = view.classifyError?.(error) ?? defaultFailureClass(error);
      const viewResult: DeliveryViewResult = {
        id: view.id,
        status: "failed",
        failureClass,
        error: errorText(error),
        durationMs: Math.max(0, performance.now() - viewStartedAt),
      };
      viewResults.push(viewResult);
      failures.push({ phase: "view", class: failureClass, viewId: view.id, error: errorText(error) });
    }
  }

  // Compatibility callers still receive their stored-only callback, but it
  // is after all explicit view branches and before the drain trigger.
  if (options.onStored !== undefined) {
    try {
      await options.onStored({ message, event: outcome.event, arrivedAt, source });
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
      await options.afterDelivery({ message, event: outcome.event, arrivedAt, source, result: preliminary });
    } catch (error) {
      failures.push({ phase: "drain", class: "retryable-transient", error: errorText(error) });
    }
  }
  return result(source, message, "stored", arrivedAt, detectorApplied, viewResults, failures, options.correlationId, startedAt);
}
