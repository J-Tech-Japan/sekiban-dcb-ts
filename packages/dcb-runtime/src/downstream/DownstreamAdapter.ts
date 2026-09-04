import { BindingExclusionLedgerClient } from "./ExclusionLookup";
import { InconsistencyDetector } from "./InconsistencyDetector";
import {
  processDeliveryCore,
  type DeliveryCoreOptions,
  type DeliveryCoreResult,
} from "./DeliveryCore";
import {
  isDownstreamOutboxMessage,
  systemPipelineClock,
  type DownstreamOutboxMessage,
  type PipelineClock,
} from "./types";
import type { StoreProvider } from "../store/provider";
import type { PipelineStore } from "../store/types";
import { GlobalCompletenessReconciler, globalReceiptAcknowledgement } from "../completeness/GlobalCompletenessReconciler";
import { scopeIdFor } from "../scope/ScopeName";
import { envServiceIdentity, requireServiceIdentity, type ServiceIdentityProvider } from "../service/ServiceIdentityProvider";

export interface DownstreamAdapterEnv {
  POSTGRES_URL?: string;
  HYPERDRIVE?: Hyperdrive;
  /** Optional explicit D1 provider binding; Postgres remains the default. */
  D1?: D1Database;
  REPAIR_EXCLUSION_LOOKUP?: Fetcher;
  BOOTSTRAP?: DurableObjectNamespace;
  /** Present on the primary/receiver runtime so G44 can acknowledge source. */
  TAG?: DurableObjectNamespace;
  /** A receiver service-binding entrypoint must never silently skip admission. */
  G38_DOORBELL_DELIVERY_ROLE?: string;
  SDT_SERVICE_ID?: string;
}

export type AdapterOptions = DeliveryCoreOptions;

function sourceAcknowledgementOptions(env: DownstreamAdapterEnv, options: AdapterOptions): AdapterOptions {
  // D1 itself is the G44 global-array authority. Do not add a rollout flag:
  // this is an in-place development schema, not a mixed-version protocol.
  const hasG44Authority = env.D1 !== undefined && env.TAG !== undefined;
  const sourceAcknowledgement = options.afterGlobalReceipt !== undefined || !hasG44Authority
    ? options.afterGlobalReceipt
    : async ({ message, receipt, arrivedAt }: Parameters<NonNullable<AdapterOptions["afterGlobalReceipt"]>>[0]) => {
      const tag = env.TAG!.get(scopeIdFor(env.TAG!, {
        serviceId: message.serviceId,
        doClass: "tag",
        identity: message.tag,
      }));
      const url = new URL("https://downstream.internal/outbox/mark-delivered");
      url.searchParams.set("__tag", message.tag);
      url.searchParams.set("__serviceId", message.serviceId);
      const response = await tag.fetch(new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(globalReceiptAcknowledgement(message, receipt.receivedAt || arrivedAt)),
      }));
      if (!response.ok) throw new Error(`source_outbox_receipt_ack_failed:${response.status}`);
    };
  const coverage = hasG44Authority
    ? async ({ message, event, arrivedAt, source }: Parameters<NonNullable<AdapterOptions["beforeViews"]>>[0]) => {
      await options.beforeViews?.({ message, event, arrivedAt, source });
      const decision = await new GlobalCompletenessReconciler(env.D1!, env.TAG!).coverageForObligation(
        message.serviceId,
        message.tag,
        message.completeness.obligationSequence,
        arrivedAt,
      );
      if (decision.kind !== "SETTLED") {
        throw new Error(`global_completeness_${decision.kind}:${decision.health.status}`);
      }
    }
    : options.beforeViews;
  const detectorFailure = hasG44Authority
    ? async ({ message, arrivedAt, error, source }: Parameters<NonNullable<AdapterOptions["onDetectorFailure"]>>[0]) => {
      await options.onDetectorFailure?.({ message, arrivedAt, error, source });
      await new GlobalCompletenessReconciler(env.D1!, env.TAG!).recordDetectorFailure(message.serviceId, error, arrivedAt);
    }
    : options.onDetectorFailure;
  if (sourceAcknowledgement === options.afterGlobalReceipt && coverage === options.beforeViews && detectorFailure === options.onDetectorFailure) return options;
  return {
    ...options,
    ...(sourceAcknowledgement === undefined ? {} : { afterGlobalReceipt: sourceAcknowledgement }),
    ...(coverage === undefined ? {} : { beforeViews: coverage }),
    ...(detectorFailure === undefined ? {} : { onDetectorFailure: detectorFailure }),
  };
}

function sharedStore(env: DownstreamAdapterEnv, provider: StoreProvider): PipelineStore {
  // The provider creates a request-scoped client. Never retain a client across
  // Queue or scheduled invocations, or a later handler can attempt I/O on a
  // stream owned by an earlier request.
  return provider.create(env);
}

async function admitBootstrapRoute(env: DownstreamAdapterEnv, serviceId: string, route: string): Promise<void> {
  if (env.BOOTSTRAP === undefined) {
    if (env.G38_DOORBELL_DELIVERY_ROLE === "receiver") {
      const error = new Error(`bootstrap_route_binding_missing:${route}`);
      error.name = "BootstrapRouteBindingMissingError";
      throw error;
    }
    return;
  }
  const url = new URL("https://downstream.internal/route/check");
  url.searchParams.set("__serviceId", serviceId);
  const admitted = await env.BOOTSTRAP.get(scopeIdFor(env.BOOTSTRAP, {
    serviceId,
    doClass: "bootstrap",
    identity: "coordinator",
  })).fetch(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ route }),
  }));
  if (!admitted.ok) throw new Error(`bootstrap_route_rejected:${route}`);
}

async function withStore<T>(
  env: DownstreamAdapterEnv,
  options: AdapterOptions,
  operation: (store: PipelineStore, clock: PipelineClock) => Promise<T>,
): Promise<T> {
  if (options.store === undefined && options.storeProvider === undefined) {
    throw new Error("A downstream store provider is not configured");
  }
  const store = options.store ?? sharedStore(env, options.storeProvider!);
  await store.initialize();
  return operation(store, options.clock ?? systemPipelineClock);
}

/**
 * Processes one direct delivery through the shared core. The caller receives a
 * typed result; this function never acknowledges, retries, or marks an
 * outbox row.
 */
export async function processDownstreamDoorbell(
  message: unknown,
  env: DownstreamAdapterEnv,
  options: AdapterOptions = {},
): Promise<DeliveryCoreResult> {
  if (!isDownstreamOutboxMessage(message)) {
    throw new Error("Doorbell contained an invalid outbox message");
  }
  await admitBootstrapRoute(env, message.serviceId, "fast");
  return processDeliveryCore(message, "fast", env, sourceAcknowledgementOptions(env, options));
}

/** Processes one Queue delivery without exposing Queue state to the core. */
export async function processDownstreamDelivery(
  message: unknown,
  env: DownstreamAdapterEnv,
  options: AdapterOptions = {},
): Promise<void> {
  if (!isDownstreamOutboxMessage(message)) {
    throw new Error("Downstream Queue contained an invalid outbox message");
  }
  await admitBootstrapRoute(env, message.serviceId, "queue");
  const outcome = await processDeliveryCore(message, "queue", env, sourceAcknowledgementOptions(env, options));
  if (outcome.queueDisposition !== "ack") {
    throw new Error(`downstream_delivery_retry:${outcome.correlationId}`);
  }
}

/**
 * Queue policy is deliberately limited to the wrapper: the shared core
 * returns a disposition, and this is the only place that calls ack/retry.
 */
export async function handleDownstreamQueue(
  batch: MessageBatch<unknown>,
  env: DownstreamAdapterEnv,
  options: AdapterOptions = {},
): Promise<void> {
  // Validate each Queue ingress before acquiring a provider. In particular a
  // non-G32 SUID must not even initialize the downstream store; this keeps
  // the cutover's abort-before-write guarantee observable for Queue traffic.
  const valid: Array<Message<DownstreamOutboxMessage>> = [];
  for (const queued of batch.messages) {
    if (!isDownstreamOutboxMessage(queued.body)) {
      console.warn("downstream_queue_delivery", { disposition: "retry-to-dlq" });
      queued.retry();
      continue;
    }
    valid.push(queued as Message<DownstreamOutboxMessage>);
  }
  if (valid.length === 0) return;
  await withStore(env, options, async (store, clock) => {
    for (const queued of valid) {
      try {
        await admitBootstrapRoute(env, queued.body.serviceId, "queue");
        const outcome = await processDeliveryCore(queued.body, "queue", env, {
          ...sourceAcknowledgementOptions(env, options),
          store,
          clock,
        });
        console.log("downstream_queue_delivery", {
          correlationId: outcome.correlationId,
          coreDurationMs: outcome.coreDurationMs,
          viewDurationsMs: outcome.views.map((view) => ({ id: view.id, durationMs: view.durationMs, status: view.status })),
          disposition: outcome.queueDisposition,
          failures: outcome.failures.map((failure) => ({ phase: failure.phase, class: failure.class, viewId: failure.viewId, error: failure.error })),
        });
        if (outcome.queueDisposition === "ack") queued.ack();
        else if (outcome.queueDisposition === "retry-once") queued.retry();
        else queued.retry();
      } catch {
        console.warn("downstream_queue_delivery", { disposition: "retry-to-dlq" });
        queued.retry();
      }
    }
  });
}

/** A scheduled/operator invocation can evaluate a stable pending record without new traffic. */
export async function stabilizeDownstream(
  env: DownstreamAdapterEnv,
  options: AdapterOptions = {},
  serviceId?: string,
  serviceIdentityProvider?: ServiceIdentityProvider,
): Promise<void> {
  await admitBootstrapRoute(env, serviceId ?? requireServiceIdentity(serviceIdentityProvider ?? envServiceIdentity(env)), "scheduled");
  await withStore(env, options, async (store, clock) => {
    const detector = new InconsistencyDetector(store, new BindingExclusionLedgerClient(env.REPAIR_EXCLUSION_LOOKUP));
    await detector.stabilize(clock, serviceId);
  });
}

export { processDeliveryCore } from "./DeliveryCore";
export type {
  DeliveryCoreEnvironment,
  DeliveryCoreFailure,
  DeliveryCoreOptions,
  DeliveryCoreResult,
  DeliverySource,
  DeliveryViewApplyResult,
  DeliveryViewFailureClass,
  DeliveryViewHandler,
  DeliveryViewInput,
  DeliveryViewResult,
} from "./DeliveryCore";
