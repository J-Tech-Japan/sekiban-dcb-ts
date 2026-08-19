import { BindingExclusionLedgerClient } from "./ExclusionLookup";
import { InconsistencyDetector } from "./InconsistencyDetector";
import { isDownstreamOutboxMessage, systemPipelineClock, type PipelineClock } from "./types";
import { POSTGRES_STORE_PROVIDER, type StoreProvider } from "../store/provider";
import type { PipelineStore } from "../store/types";

export interface DownstreamAdapterEnv {
  POSTGRES_URL?: string;
  HYPERDRIVE?: Hyperdrive;
  REPAIR_EXCLUSION_LOOKUP?: Fetcher;
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

async function withStore<T>(
  env: DownstreamAdapterEnv,
  options: AdapterOptions,
  operation: (store: PipelineStore, clock: PipelineClock) => Promise<T>,
): Promise<T> {
  const store = options.store ?? sharedStore(env, options.storeProvider ?? POSTGRES_STORE_PROVIDER);
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
  await withStore(env, options, async (store, clock) => {
    const arrivedAt = clock.now();
    await store.recordDelivery(message, arrivedAt);
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
        const arrivedAt = clock.now();
        await store.recordDelivery(queued.body, arrivedAt);
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
  await withStore(env, options, async (store, clock) => {
    const detector = new InconsistencyDetector(store, new BindingExclusionLedgerClient(env.REPAIR_EXCLUSION_LOOKUP));
    await detector.stabilize(clock, serviceId);
  });
}
