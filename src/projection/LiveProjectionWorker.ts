import type { PipelineClock } from "../downstream/types";
import { systemPipelineClock } from "../downstream/types";
import { PostgresEventStore } from "../store/PostgresEventStore";
import {
  DEPLOYED_PROJECTOR_REGISTRY,
  tagStateIdentityFrom,
  type ProjectorRegistry,
} from "./ProjectorRegistry";
import { projectionIdFor, ProjectionRuntime, safeWindowMs, type CatchUpResult } from "./ProjectionRuntime";

const SERVICE_ID = "serialized-dcb-v1";

export interface LiveProjectionEnv {
  POSTGRES_URL?: string;
  HYPERDRIVE?: Hyperdrive;
}

export interface ProjectionPollOptions {
  clock?: PipelineClock;
  store?: PostgresEventStore;
  registry?: ProjectorRegistry;
}

/** One Worker isolate retains its own Postgres socket between scheduled polls. */
const sharedStores = new Map<string, PostgresEventStore>();

function connectionStringFrom(env: LiveProjectionEnv): string {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.POSTGRES_URL;
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error("A Hyperdrive binding or POSTGRES_URL is required for live projections");
  }
  return connectionString;
}

function sharedStore(env: LiveProjectionEnv): PostgresEventStore {
  const connectionString = connectionStringFrom(env);
  let store = sharedStores.get(connectionString);
  if (store === undefined) {
    store = new PostgresEventStore(connectionString);
    sharedStores.set(connectionString, store);
  }
  return store;
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
  return runtime.pollRegistered(SERVICE_ID, (options.clock ?? systemPipelineClock).now());
}

/**
 * Internal operational surface; it is deliberately outside the five V1
 * endpoints and does not advance a projection or write event data.
 */
export async function handleProjectionLag(request: Request, env: LiveProjectionEnv): Promise<Response> {
  if (request.method !== "GET") {
    return error(405, "validation_error", "Projection lag requires GET");
  }
  const tagStateId = new URL(request.url).searchParams.get("tagStateId");
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
    const projectionId = projectionIdFor(parsed.value);
    const [lag, dynamicLagBoundMs] = await Promise.all([
      store.projectionLag(SERVICE_ID, projectionId, parsed.value.tag),
      store.currentLagBound(SERVICE_ID),
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
