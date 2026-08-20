import { BindingExclusionLedgerClient } from "./ExclusionLookup";
import { InconsistencyDetector } from "./InconsistencyDetector";
import { isDownstreamOutboxMessage, systemPipelineClock, type PipelineClock } from "./types";
import type { StoreProvider } from "../store/provider";
import type { PipelineStore } from "../store/types";
import { requireConfiguredServiceId } from "../http/testServiceId";

export interface DownstreamAdapterEnv {
  POSTGRES_URL?: string;
  HYPERDRIVE?: Hyperdrive;
  /** Optional explicit D1 provider binding; Postgres remains the default. */
  D1?: D1Database;
  REPAIR_EXCLUSION_LOOKUP?: Fetcher;
  BOOTSTRAP?: DurableObjectNamespace;
  SDT_SERVICE_ID?: string;
}

export interface AdapterOptions {
  clock?: PipelineClock;
  store?: PipelineStore;
  storeProvider?: StoreProvider;
}

function sharedStore(env: DownstreamAdapterEnv, provider: StoreProvider): PipelineStore {
  // The provider creates a request-scoped client. Never retain a client across
  // Queue or scheduled invocations, or a later handler can attempt I/O on a
  // stream owned by an earlier request.
  return provider.create(env);
}

async function admitBootstrapRoute(env: DownstreamAdapterEnv, serviceId: string, route: string): Promise<void> {
  if (env.BOOTSTRAP === undefined) return;
  const url = new URL("https://downstream.internal/route/check"); url.searchParams.set("__serviceId", serviceId);
  const admitted = await env.BOOTSTRAP.get(env.BOOTSTRAP.idFromName(serviceId)).fetch(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ route }) }));
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

/** Processes one at-least-once Queue delivery with idempotent EventId storage. */
export async function processDownstreamDelivery(
  message: unknown,
  env: DownstreamAdapterEnv,
  options: AdapterOptions = {},
): Promise<void> {
  if (!isDownstreamOutboxMessage(message)) {
    throw new Error("Downstream Queue contained an invalid outbox message");
  }
  await admitBootstrapRoute(env, message.serviceId, "queue");
  await withStore(env, options, async (store, clock) => {
    const arrivedAt = clock.now();
    const outcome = await store.recordDelivery(message, arrivedAt);
    if (outcome.outcome !== "stored") {
      // A durable Cosmos incident is enough to acknowledge the poison row;
      // projection is retried here when the provider exposes that seam.
      await store.projectDeliveryIncidents?.(message.serviceId);
      return;
    }
    const lagBound = await store.currentLagBound(message.serviceId, arrivedAt);
    const detector = new InconsistencyDetector(store, new BindingExclusionLedgerClient(env.REPAIR_EXCLUSION_LOOKUP));
    await detector.observe(message, arrivedAt, lagBound);
  });
}

/**
 * Queue failures are retried per message. A duplicate after a successful
 * database transaction is safe because the adapter is keyed by EventId and
 * arrival path.
 */
export async function handleDownstreamQueue(
  batch: MessageBatch<unknown>,
  env: DownstreamAdapterEnv,
  options: AdapterOptions = {},
): Promise<void> {
  await withStore(env, options, async (store, clock) => {
    const detector = new InconsistencyDetector(store, new BindingExclusionLedgerClient(env.REPAIR_EXCLUSION_LOOKUP));
    for (const queued of batch.messages) {
      try {
        if (!isDownstreamOutboxMessage(queued.body)) {
          throw new Error("Downstream Queue contained an invalid outbox message");
        }
        await admitBootstrapRoute(env, queued.body.serviceId, "queue");
        const arrivedAt = clock.now();
        const outcome = await store.recordDelivery(queued.body, arrivedAt);
        if (outcome.outcome !== "stored") {
          await store.projectDeliveryIncidents?.(queued.body.serviceId);
          queued.ack();
          continue;
        }
        const lagBound = await store.currentLagBound(queued.body.serviceId, arrivedAt);
        await detector.observe(queued.body, arrivedAt, lagBound);
        queued.ack();
      } catch {
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
): Promise<void> {
  await admitBootstrapRoute(env, serviceId ?? requireConfiguredServiceId(env.SDT_SERVICE_ID), "scheduled");
  await withStore(env, options, async (store, clock) => {
    const detector = new InconsistencyDetector(store, new BindingExclusionLedgerClient(env.REPAIR_EXCLUSION_LOOKUP));
    await detector.stabilize(clock, serviceId);
  });
}
