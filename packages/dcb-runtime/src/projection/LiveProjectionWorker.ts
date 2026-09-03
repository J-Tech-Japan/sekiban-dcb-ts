import type { PipelineClock } from "../downstream/types";
import { systemPipelineClock } from "../downstream/types";
import type { StoreProvider } from "../store/provider";
import type { PipelineStore } from "../store/types";
import {
  DEPLOYED_PROJECTOR_REGISTRY,
  tagStateIdentityFrom,
  type ProjectorRegistry,
} from "./ProjectorRegistry";
import { projectionIdFor, ProjectionRuntime, safeWindowMs, type CatchUpResult } from "./ProjectionRuntime";
import { scopeIdFor } from "../scope/ScopeName";
import { envServiceIdentity, requireServiceIdentity, type ServiceIdentityProvider } from "../service/ServiceIdentityProvider";

export interface LiveProjectionEnv {
  POSTGRES_URL?: string;
  HYPERDRIVE?: Hyperdrive;
  /** Optional explicit D1 provider binding; Postgres remains the default. */
  D1?: D1Database;
  /** Non-secret service identity configured per deployment. */
  SDT_SERVICE_ID?: string;
  BOOTSTRAP?: DurableObjectNamespace;
}

export interface ProjectionPollOptions {
  clock?: PipelineClock;
  store?: PipelineStore;
  storeProvider?: StoreProvider;
  registry?: ProjectorRegistry;
  /** Test-only service isolation; scheduled production polls require SDT_SERVICE_ID. */
  serviceId?: string;
  /** Optional single tag scope for queue/HTTP operator catch-up. */
  tag?: string;
  serviceIdentityProvider?: ServiceIdentityProvider;
}

function sharedStore(env: LiveProjectionEnv, provider: StoreProvider): PipelineStore {
  // Provider clients are request-scoped in workerd; a retained client can
  // otherwise be used by a later cron/Queue request.
  return provider.create(env);
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

async function admitBootstrapRoute(env: LiveProjectionEnv, serviceId: string): Promise<void> {
  if (env.BOOTSTRAP === undefined) return;
  const url = new URL("https://projection.internal/route/check"); url.searchParams.set("__serviceId", serviceId);
  const admitted = await env.BOOTSTRAP.get(scopeIdFor(env.BOOTSTRAP, {
    serviceId,
    doClass: "bootstrap",
    identity: "coordinator",
  })).fetch(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ route: "projection-rebuild" }) }));
  if (!admitted.ok) throw new Error("bootstrap_route_rejected:projection-rebuild");
}

/**
 * Scheduled polling entry point. It discovers durable tag memberships and
 * advances every deploy-time registered projector only through SafeWindow.
 */
export async function pollLiveProjections(
  env: LiveProjectionEnv,
  options: ProjectionPollOptions = {},
): Promise<CatchUpResult[]> {
  if (options.store === undefined && options.storeProvider === undefined) {
    throw new Error("A projection store provider is not configured");
  }
  const serviceId = options.serviceId ?? requireServiceIdentity(options.serviceIdentityProvider ?? envServiceIdentity(env));
  await admitBootstrapRoute(env, serviceId);
  const store = options.store ?? sharedStore(env, options.storeProvider!);
  await store.initialize();
  const runtime = new ProjectionRuntime(store, options.registry ?? DEPLOYED_PROJECTOR_REGISTRY);
  if (options.tag !== undefined) {
    const registry = options.registry ?? DEPLOYED_PROJECTOR_REGISTRY;
    const results: CatchUpResult[] = [];
    for (const projector of registry.registered()) {
      const identity = tagStateIdentityFrom(`${options.tag}:${projector.id}`, registry);
      if (identity.value !== undefined) {
        results.push(await runtime.catchUp(
          serviceId,
          identity.value,
          (options.clock ?? systemPipelineClock).now(),
        ));
      }
    }
    return results;
  }
  return runtime.pollRegistered(serviceId, (options.clock ?? systemPipelineClock).now());
}

/**
 * Internal operational surface; it is deliberately outside the five V1
 * endpoints and does not advance a projection or write event data.
 */
export async function handleProjectionLag(
  request: Request,
  env: LiveProjectionEnv,
  registry: ProjectorRegistry = DEPLOYED_PROJECTOR_REGISTRY,
  storeProvider?: StoreProvider,
  serviceIdentityProvider?: ServiceIdentityProvider,
): Promise<Response> {
  if (request.method !== "GET") {
    return error(405, "validation_error", "Projection lag requires GET");
  }
  const query = new URL(request.url).searchParams;
  const tagStateId = query.get("tagStateId");
  const serviceId = query.get("serviceId") || requireServiceIdentity(serviceIdentityProvider ?? envServiceIdentity(env));
  const pollRequested = query.get("poll") === "1";
  if (tagStateId === null || tagStateId.length === 0) {
    return error(400, "validation_error", "tagStateId is required");
  }
  const parsed = tagStateIdentityFrom(tagStateId, registry);
  if (parsed.value === undefined) {
    return error(400, "validation_error", parsed.error ?? "Invalid tagStateId");
  }
  try {
    if (storeProvider === undefined) {
      return error(503, "projection_unavailable", "A projection store provider is not configured");
    }
    const store = sharedStore(env, storeProvider);
    await store.initialize();
    if (pollRequested) {
      // The operator probe names one tag-state. Catch up only that identity;
      // polling every registered tag here can exceed an HTTP request lifetime
      // on a large service-scoped conformance run.
      const runtime = new ProjectionRuntime(store, registry);
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
