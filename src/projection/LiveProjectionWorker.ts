import type { PipelineClock } from "../downstream/types";
import { systemPipelineClock } from "../downstream/types";
import { PostgresEventStore } from "../store/PostgresEventStore";
import {
  DEPLOYED_PROJECTOR_REGISTRY,
  tagStateIdentityFrom,
  type ProjectorRegistry,
} from "./ProjectorRegistry";
import { projectionIdFor, ProjectionRuntime, safeWindowMs, type CatchUpResult } from "./ProjectionRuntime";
import { SERIALIZED_DCB_SERVICE_ID } from "../http/testServiceId";

const SERVICE_ID = SERIALIZED_DCB_SERVICE_ID;

export interface LiveProjectionEnv {
  POSTGRES_URL?: string;
  HYPERDRIVE?: Hyperdrive;
}

export interface ProjectionPollOptions {
  clock?: PipelineClock;
  store?: PostgresEventStore;
  registry?: ProjectorRegistry;
  /** Test-only service isolation; production scheduled polls use the V1 default. */
  serviceId?: string;
  /** Optional single tag scope for queue/HTTP operator catch-up. */
  tag?: string;
}

function connectionStringFrom(env: LiveProjectionEnv): string {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.POSTGRES_URL;
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error("A Hyperdrive binding or POSTGRES_URL is required for live projections");
  }
  return connectionString;
}

function sharedStore(env: LiveProjectionEnv): PostgresEventStore {
  const connectionString = connectionStringFrom(env);
  // Hyperdrive/Postgres sockets are request-scoped in workerd. A retained
  // client can otherwise be used by a later cron/Queue request.
  return new PostgresEventStore(connectionString);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function error(status: number, code: string, message: string): Response {
  return json({ error: message, code }, status);
}

/**
 * Scheduled polling entry point. It discovers durable tag memberships and
 * advances every deploy-time registered projector only through SafeWindow.
 */
export async function pollLiveProjections(
  env: LiveProjectionEnv,
  options: ProjectionPollOptions = {},
): Promise<CatchUpResult[]> {
  const store = options.store ?? sharedStore(env);
  await store.initialize();
  const runtime = new ProjectionRuntime(store, options.registry ?? DEPLOYED_PROJECTOR_REGISTRY);
  if (options.tag !== undefined) {
    const registry = options.registry ?? DEPLOYED_PROJECTOR_REGISTRY;
    const results: CatchUpResult[] = [];
    for (const projector of registry.registered()) {
      const identity = tagStateIdentityFrom(`${options.tag}:${projector.id}`, registry);
      if (identity.value !== undefined) {
        results.push(await runtime.catchUp(
          options.serviceId ?? SERVICE_ID,
          identity.value,
          (options.clock ?? systemPipelineClock).now(),
        ));
      }
    }
    return results;
  }
  return runtime.pollRegistered(options.serviceId ?? SERVICE_ID, (options.clock ?? systemPipelineClock).now());
}

/**
 * Internal operational surface; it is deliberately outside the five V1
 * endpoints and does not advance a projection or write event data.
 */
export async function handleProjectionLag(request: Request, env: LiveProjectionEnv): Promise<Response> {
  if (request.method !== "GET") {
    return error(405, "validation_error", "Projection lag requires GET");
  }
  const query = new URL(request.url).searchParams;
  const tagStateId = query.get("tagStateId");
  const serviceId = query.get("serviceId") || SERVICE_ID;
  const pollRequested = query.get("poll") === "1";
  if (tagStateId === null || tagStateId.length === 0) {
    return error(400, "validation_error", "tagStateId is required");
  }
  const parsed = tagStateIdentityFrom(tagStateId);
  if (parsed.value === undefined) {
    return error(400, "validation_error", parsed.error ?? "Invalid tagStateId");
  }
  try {
    const store = sharedStore(env);
    await store.initialize();
    if (pollRequested) {
      // The operator probe names one tag-state. Catch up only that identity;
      // polling every registered tag here can exceed an HTTP request lifetime
      // on a large service-scoped conformance run.
      const runtime = new ProjectionRuntime(store);
      await runtime.catchUp(serviceId, parsed.value, Date.now());
    }
    const projectionId = projectionIdFor(parsed.value);
    const [lag, dynamicLagBoundMs] = await Promise.all([
      store.projectionLag(serviceId, projectionId, parsed.value.tag),
      store.currentLagBound(serviceId, Date.now()),
    ]);
    return json({
      tagStateId,
      checkpointSuid: lag.checkpointSuid,
      headSuid: lag.headSuid,
      behindEvents: lag.behindEvents,
      dynamicLagBoundMs,
      safeWindowMs: safeWindowMs(dynamicLagBoundMs),
    });
  } catch {
    return error(503, "projection_unavailable", "Projection lag storage is unavailable");
  }
}
