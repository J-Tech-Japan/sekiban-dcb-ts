import { BindingExclusionLedgerClient } from "./ExclusionLookup";
import { InconsistencyDetector } from "./InconsistencyDetector";
import { isDownstreamOutboxMessage, systemPipelineClock, type PipelineClock } from "./types";
import { PostgresEventStore } from "../store/PostgresEventStore";
import type { PipelineStore } from "../store/types";
import { pollLiveProjections } from "../projection/LiveProjectionWorker";
import { safeWindowMs } from "../projection/ProjectionRuntime";

export interface DownstreamAdapterEnv {
  POSTGRES_URL?: string;
  HYPERDRIVE?: Hyperdrive;
  REPAIR_EXCLUSION_LOOKUP?: Fetcher;
}

export interface AdapterOptions {
  clock?: PipelineClock;
  store?: PipelineStore;
}

function connectionStringFrom(env: DownstreamAdapterEnv): string {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.POSTGRES_URL;
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error("A Hyperdrive binding or POSTGRES_URL is required for the downstream adapter");
  }
  return connectionString;
}

function sharedStore(env: DownstreamAdapterEnv): PostgresEventStore {
  const connectionString = connectionStringFrom(env);
  // Hyperdrive/Postgres sockets are request-scoped in workerd. Never retain a
  // client across Queue or scheduled invocations, or a later handler can
  // attempt I/O on a stream owned by an earlier request.
  return new PostgresEventStore(connectionString);
}

async function withStore<T>(
  env: DownstreamAdapterEnv,
  options: AdapterOptions,
  operation: (store: PipelineStore, clock: PipelineClock) => Promise<T>,
): Promise<T> {
  const store = options.store ?? sharedStore(env);
  await store.initialize();
  return operation(store, options.clock ?? systemPipelineClock);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
    const deliveredServices = new Set<string>();
    const deliveredTags = new Map<string, Set<string>>();
    for (const queued of batch.messages) {
      try {
        if (!isDownstreamOutboxMessage(queued.body)) {
          throw new Error("Downstream Queue contained an invalid outbox message");
        }
        const arrivedAt = clock.now();
        await store.recordDelivery(queued.body, arrivedAt);
        const lagBound = await store.currentLagBound(queued.body.serviceId, arrivedAt);
        await detector.observe(queued.body, arrivedAt, lagBound);
        deliveredServices.add(queued.body.serviceId);
        const tags = deliveredTags.get(queued.body.serviceId) ?? new Set<string>();
        tags.add(queued.body.tag);
        deliveredTags.set(queued.body.serviceId, tags);
        queued.ack();
      } catch {
        queued.retry();
      }
    }
    // Queue delivery is the first durable read-side fact. Poll with the same
    // request-scoped Postgres client so deployed query/tag-state reads
    // converge without a second cross-request I/O object. Unit tests that
    // inject a store keep explicit poll control.
    if (options.store === undefined && store instanceof PostgresEventStore) {
      for (const serviceId of deliveredServices) {
        // A queue delivery is the first durable arrival fact. Hold this
        // consumer until that fact is inside the current SafeWindow, then
        // poll the matching service scope so a fresh deployment-verification
        // serviceId converges without weakening the read-side boundary.
        const dynamicLagBoundMs = await store.currentLagBound(serviceId, Date.now());
        await sleep(safeWindowMs(dynamicLagBoundMs) + 25);
        for (const tag of deliveredTags.get(serviceId) ?? []) {
          await pollLiveProjections(env, { store, serviceId, tag });
        }
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
