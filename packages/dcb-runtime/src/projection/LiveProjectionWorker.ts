import type { PipelineClock } from "../downstream/types";
import { systemPipelineClock } from "../downstream/types";
import type { StoreProvider } from "../store/provider";
import type { PipelineStore } from "../store/types";
import {
  DEPLOYED_PROJECTOR_REGISTRY,
  tagStateIdentityFrom,
  type ProjectorRegistry,
} from "./ProjectorRegistry";
import { projectionIdFor, ProjectionRuntime, safeWindowMs, validatedClosedPrefixSuid, type CatchUpResult } from "./ProjectionRuntime";
import { scopeIdFor } from "../scope/ScopeName";
import { envServiceIdentity, requireServiceIdentity, type ServiceIdentityProvider } from "../service/ServiceIdentityProvider";
import type { ClosedPrefixCertificate } from "../allocator/types";

export interface LiveProjectionEnv {
  POSTGRES_URL?: string;
  HYPERDRIVE?: Hyperdrive;
  /** Optional explicit D1 provider binding; Postgres remains the default. */
  D1?: D1Database;
  /** Non-secret service identity configured per deployment. */
  SDT_SERVICE_ID?: string;
  BOOTSTRAP?: DurableObjectNamespace;
  /** Allocator authority used by every safe advancement request. */
  ALLOCATOR?: DurableObjectNamespace;
}

export const LIVE_PROJECTION_POLL_OUTCOMES = [
  "never-invoked",
  "invoked-and-threw",
  "invoked-but-no-work",
  "explicitly-gated",
  "advanced",
] as const;

export type LiveProjectionPollOutcome = (typeof LIVE_PROJECTION_POLL_OUTCOMES)[number];

export interface LiveProjectionPollObservation {
  readonly serviceId: string;
  readonly projectorId: string;
  readonly attemptedAt: number;
  readonly outcome: LiveProjectionPollOutcome;
  readonly reason: string | null;
  readonly advancedSourceEvents: number;
}

export interface LiveProjectionPollObserver {
  /** Called before bootstrap admission/store initialization is attempted. */
  readonly onAttempt?: (input: {
    readonly env: LiveProjectionEnv;
    readonly serviceId: string;
    readonly projectorIds: readonly string[];
    readonly attemptedAt: number;
  }) => Promise<void> | void;
  /** Called once per registered projector after a poll returns or throws. */
  readonly onOutcome?: (input: LiveProjectionPollObservation & { readonly env: LiveProjectionEnv }) => Promise<void> | void;
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
  /**
   * Optional G44-proven high-water mark for a scheduled poll. `null` keeps
   * the poll observable but permits no source advancement on BLOCK/UNSETTLED;
   * `undefined` retains the unbounded FULL/on-demand behavior.
   */
  maximumSuid?: string | null;
  /** Allocator-issued closed-prefix certificate; null is fail-closed. */
  closedPrefixSuid?: string | null;
  /** Full allocator certificate; callers supplying it must use its lineage-bound value. */
  closedPrefixCertificate?: ClosedPrefixCertificate;
  serviceIdentityProvider?: ServiceIdentityProvider;
  /** Observation-only lifecycle sink; it cannot alter projection decisions. */
  observer?: LiveProjectionPollObserver;
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

function boundedErrorReason(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.length > 256 ? `${value.slice(0, 253)}...` : value;
}

async function notifyObserver(
  observer: LiveProjectionPollObserver | undefined,
  callback: "onAttempt" | "onOutcome",
  input: Parameters<NonNullable<LiveProjectionPollObserver[typeof callback]>>[0],
): Promise<void> {
  // Health persistence is deliberately ancillary: a D1 diagnostic outage must
  // never change commit/projection semantics or turn a successful poll into a
  // failed scheduled invocation.
  try {
    if (callback === "onAttempt") {
      await observer?.onAttempt?.(input as Parameters<NonNullable<LiveProjectionPollObserver["onAttempt"]>>[0]);
    } else {
      await observer?.onOutcome?.(input as Parameters<NonNullable<LiveProjectionPollObserver["onOutcome"]>>[0]);
    }
  } catch {
    // The next health read will retain the last durable observation and its
    // reason; projection advancement remains governed by the existing fences.
  }
}

async function notifyOutcomes(
  observer: LiveProjectionPollObserver | undefined,
  serviceId: string,
  projectorIds: readonly string[],
  attemptedAt: number,
  results: readonly CatchUpResult[],
  maximumSuid: string | null | undefined,
  env: LiveProjectionEnv,
  error?: unknown,
): Promise<void> {
  if (observer?.onOutcome === undefined) return;
  const byProjector = new Map<string, CatchUpResult[]>();
  for (const result of results) {
    const values = byProjector.get(result.projectorId) ?? [];
    values.push(result);
    byProjector.set(result.projectorId, values);
  }
  for (const projectorId of projectorIds) {
    const projectorResults = byProjector.get(projectorId) ?? [];
    let outcome: LiveProjectionPollOutcome = "invoked-but-no-work";
    let reason: string | null = null;
    let advancedSourceEvents = 0;
    if (error !== undefined) {
      outcome = "invoked-and-threw";
      reason = boundedErrorReason(error);
    } else {
      advancedSourceEvents = projectorResults.reduce((total, result) => total + result.advancedSourceEvents, 0);
      if (advancedSourceEvents > 0) {
        outcome = "advanced";
      } else if (projectorResults.some((result) => result.indeterminate)) {
        outcome = "explicitly-gated";
        reason = "safe_window_ceiling_exceeded";
      } else if (maximumSuid !== undefined) {
        outcome = "explicitly-gated";
        reason = maximumSuid === null ? "retained_frontier_unproven" : "retained_frontier_fence";
      }
    }
    await notifyObserver(observer, "onOutcome", {
      serviceId,
      projectorId,
      attemptedAt,
      outcome,
      reason,
      advancedSourceEvents,
      env,
    });
  }
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
  const registry = options.registry ?? DEPLOYED_PROJECTOR_REGISTRY;
  const projectorIds = registry.registered().map((projector) => projector.id);
  const closedPrefixSuid = validatedClosedPrefixSuid(options);
  if (env.ALLOCATOR !== undefined && options.closedPrefixCertificate?.status !== "ready") {
    throw new Error("ordering_certificate_unavailable");
  }
  const attemptedAt = (options.clock ?? systemPipelineClock).now();
  await notifyObserver(options.observer, "onAttempt", { env, serviceId, projectorIds, attemptedAt });
  try {
    await admitBootstrapRoute(env, serviceId);
    const store = options.store ?? sharedStore(env, options.storeProvider!);
    await store.initialize();
    const runtime = new ProjectionRuntime(store, registry);
    if (options.tag !== undefined) {
      const results: CatchUpResult[] = [];
      for (const projector of registry.registered()) {
        const identity = tagStateIdentityFrom(`${options.tag}:${projector.id}`, registry);
        if (identity.value !== undefined) {
          results.push(await runtime.catchUp(
            serviceId,
            identity.value,
            attemptedAt,
            {},
            {
              maximumSuid: options.maximumSuid,
              closedPrefixSuid,
              closedPrefixCertificate: options.closedPrefixCertificate,
            },
          ));
        }
      }
      await notifyOutcomes(options.observer, serviceId, projectorIds, attemptedAt, results, options.maximumSuid, env);
      return results;
    }
    const results = await runtime.pollRegistered(
      serviceId,
      attemptedAt,
      options.maximumSuid,
      closedPrefixSuid,
      options.closedPrefixCertificate,
    );
    await notifyOutcomes(options.observer, serviceId, projectorIds, attemptedAt, results, options.maximumSuid, env);
    return results;
  } catch (error) {
    await notifyOutcomes(options.observer, serviceId, projectorIds, attemptedAt, [], options.maximumSuid, env, error);
    throw error;
  }
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
    if (pollRequested) {
      // This public diagnostic endpoint may report lag, but it must not make
      // a remote allocator read part of a public safe-read request. Only the
      // background safe pass receives the cached, validated certificate; an
      // on-demand poll without that authority is explicitly fail-closed.
      return error(503, "ordering_certificate_unavailable", "Safe advancement is available only from a validated background certificate pass");
    }
    const store = sharedStore(env, storeProvider);
    await store.initialize();
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
