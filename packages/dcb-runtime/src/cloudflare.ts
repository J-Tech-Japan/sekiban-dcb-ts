/**
 * Cloudflare-only runtime composition.
 *
 * This entrypoint is deliberately separate from the default runtime entrypoint:
 * it imports the D1 provider directly and never imports the Postgres/Cosmos
 * provider graph. A Worker using this surface therefore has an auditable
 * zero-external-database bundle while the ordinary entrypoint remains the
 * unchanged Postgres composition.
 */
import type { DomainDefinition } from "@sekiban/dcb-core";
import { AllocatorDurableObject as RuntimeAllocatorDurableObject, readClosedPrefixCertificate as readRuntimeClosedPrefixCertificate } from "./allocator/AllocatorDurableObject";
import { BootstrapCoordinatorDurableObject as RuntimeBootstrapCoordinatorDurableObject } from "./bootstrap/BootstrapCoordinatorDurableObject";
import { handleOperatorBootstrap } from "./bootstrap/OperatorBootstrap";
import { handleOperatorRepair } from "./cli/OperatorRepairCli";
import { handleSerializedCommit } from "./commit/CommitWorker";
import {
  handleDownstreamQueue,
  stabilizeDownstream,
} from "./downstream/DownstreamAdapter";
import type { DeliveryCoreResult, DeliveryViewHandler } from "./downstream/DeliveryCore";
import type { DownstreamDoorbellBinding } from "./downstream/Doorbell";
import { handleOutboxDrainRequest } from "./downstream/OutboxDrain";
import type { DownstreamOutboxMessage } from "./downstream/types";
import { JournalDurableObject as RuntimeJournalDurableObject } from "./journal/JournalDurableObject";
import { composeRuntime, registeredEventParsers, type RuntimeDomainLike, type RuntimeWorkerConfig } from "./composition";
import { createD1StoreProvider } from "./d1";
import { handleProjectionLag, pollLiveProjections, type LiveProjectionPollObserver } from "./projection/LiveProjectionWorker";
import { handleSerializedQuery } from "./http/SerializedQueryWorker";
import { handleSerializedRead } from "./read/SerializedReadWorker";
import { TagDurableObject as RuntimeTagDurableObject } from "./tag/TagDurableObject";
import {
  TagStateDurableObject as RuntimeTagStateDurableObject,
  configureTagStateProjectorRegistry,
} from "./tagstate/TagStateDurableObject";
import { GlobalCompletenessReconciler } from "./completeness/GlobalCompletenessReconciler";
import type { GlobalCompletenessScanResult } from "./completeness/types";
import type { StoredEvent } from "./store/types";
import { cloudflareTracing } from "./trace/CloudflareTracing";
import { createCommitTraceConsoleSink } from "./trace/CommitTraceConsoleSink";
import { createG60DurableHopObserver, recordFirstUnsafeVisibleRead } from "./diagnostics/G60DurableHop";
import { enforceControlRouteScope, scopeIdentityMissingResponse } from "./scope/ControlRouteScope";
import { scopeIdFor } from "./scope/ScopeName";
import {
  envServiceIdentity,
  requireServiceIdentity,
  type ServiceIdentityProvider,
} from "./service/ServiceIdentityProvider";
export {
  readRuntimeClosedPrefixCertificate as readClosedPrefixCertificate,
};
export type {
  ClosedPrefixCertificate,
  IssuanceObligation,
  IssuanceObligationDisposition,
} from "./allocator/types";
export {
  createG60DurableHopObserver,
  observeG60UnsafeWriter,
  recordDurableHop,
  recordDurableHopSubstep,
  recordDurableUnsafeWriterBoundary,
  recordFirstUnsafeVisibleRead,
} from "./diagnostics/G60DurableHop";
export {
  G60_POST_ADMISSION_STAGES,
  G60_UNSAFE_WRITER_PATHS,
} from "./diagnostics/G60DurableHop";
export {
  G65_DIRECT_RING_BUDGET_MS,
  G65_DIRECT_RING_CLOCK_ORIGIN,
  recordG65DirectRing,
  readG65DirectRing,
  markG65DirectApplyStarted,
  markG65DirectApplyFinished,
} from "./diagnostics/G65DirectRing";
export type {
  G65DirectApplyOutcome,
  G65DirectRingOutcome,
  G65DirectRingRecord,
} from "./diagnostics/G65DirectRing";
export type {
  G60DurableUnsafeWriterObservation,
  G60DurablePostAdmissionObservation,
  G60DurableHopObservation,
  G60DurableHopObserver,
  G60PostAdmissionBoundary,
  G60PostAdmissionStage,
  G60UnsafeWriterBoundary,
  G60UnsafeWriterPath,
  G60UnsafeWriterTransport,
  G60HopStage,
  G60HopTransport,
} from "./diagnostics/G60DurableHop";
export {
  buildScopeName,
  DURABLE_OBJECT_SCOPE_CLASSES,
  isScopeServiceId,
  parseScopeName,
  scopeIdFor,
  ScopeNameError,
  tagStateScopeIdentity,
} from "./scope/ScopeName";
export type { DurableObjectScope, DurableObjectScopeClass, ScopeNameNamespace } from "./scope/ScopeName";
export {
  envServiceIdentity,
  G11_SERVICE_ID_HEADER,
  injectableServiceIdentity,
  requestServiceIdentity,
  requireServiceIdentity,
  ServiceIdentityMissingError,
  TEST_SERVICE_ID_HEADER,
} from "./service/ServiceIdentityProvider";
export type {
  ServiceIdentityBehavior,
  ServiceIdentityEnvironment,
  ServiceIdentityProvider,
  ServiceIdentityRequestOptions,
  ServiceIdentityResolution,
} from "./service/ServiceIdentityProvider";

export interface CloudflareOnlyEnv {
  ALLOCATOR: DurableObjectNamespace;
  BOOTSTRAP: DurableObjectNamespace;
  JOURNAL: DurableObjectNamespace;
  TAG: DurableObjectNamespace;
  TAG_STATE: DurableObjectNamespace;
  DOWNSTREAM_QUEUE: Queue<DownstreamOutboxMessage>;
  DOWNSTREAM_DOORBELL?: DownstreamDoorbellBinding;
  D1: D1Database;
  D1_MV: D1Database;
  AUTO_DRAIN_OUTBOX?: string;
  REPAIR_OPERATOR_TOKEN: string;
  REPAIR_EXCLUSION_LOOKUP?: Fetcher;
  G11_VERIFICATION_ENABLED?: string;
  SDT_SERVICE_ID?: string;
  DOMAIN_DELIVERY_CLASS?: string;
  DIRECT_DOORBELL?: string;
  DIRECT_DOORBELL_ALLOWED_VIEWS?: string;
  DIRECT_DOORBELL_MAX_INVOCATIONS?: string;
  DIRECT_DOORBELL_DEGRADATION?: string;
  DIRECT_DOORBELL_RECEIVER_MODE?: string;
  DIRECT_DOORBELL_SELF_BINDING_PROOF?: string;
  G26_VIEW_COUNT?: string;
  /** Bound from Cloudflare Worker Version metadata; observation-only. */
  WORKER_VERSION?: Readonly<{ id?: unknown }>;
}

function cloudflareCommitTraceProvider(request: Request, env: CloudflareOnlyEnv): Readonly<{
  scriptVersion?: string;
  colo?: string;
}> {
  // These provider facts are optional schema attributes, never protocol
  // inputs. They let sdt.observe/v1 cross-check the platform log metadata
  // against S00 without adding a request header or response field.
  const versionId = env.WORKER_VERSION?.id;
  const cf = request.cf as unknown as { colo?: unknown } | undefined;
  return Object.freeze({
    ...(typeof versionId === "string" && versionId.length > 0 ? { scriptVersion: versionId } : {}),
    ...(typeof cf?.colo === "string" && cf.colo.length > 0 ? { colo: cf.colo } : {}),
  });
}

export interface CloudflareOnlyWorkerOptions {
  readonly domain?: DomainDefinition | RuntimeDomainLike;
  readonly config?: RuntimeWorkerConfig;
  /** Host seam; deployed composition defaults to envServiceIdentity. */
  readonly serviceIdentityProvider?: ServiceIdentityProvider;
  /** Optional deployment read-model rebuild that must finish before READY. */
  readonly afterBootstrapVerify?: (input: { readonly serviceId: string; readonly env: CloudflareOnlyEnv }) => Promise<void>;
  /**
   * Runs after the fresh G44 reconciliation and before the scheduled
   * live-projection poll. A sample can use the resulting persisted coverage
   * for its SafeWindow-fenced materialized-view pass in this same tick.
   */
  readonly beforeLiveProjectionPoll?: (input: {
    readonly env: CloudflareOnlyEnv;
    readonly serviceId: string;
    readonly scan: GlobalCompletenessScanResult;
    readonly ctx: ExecutionContext;
  }) => Promise<BeforeLiveProjectionPollResult | void>;
  /** Persists the observation-only lifecycle of each scheduled live poll. */
  readonly liveProjectionPollObserver?: LiveProjectionPollObserver;
  /** Factories are evaluated per invocation; Queue and receiver can select views independently. */
  readonly deliveryViews?: (input: {
    readonly env: CloudflareOnlyEnv;
    readonly ctx: ExecutionContext;
  }) => readonly DeliveryViewHandler[];
  /** Runs after all selected views have completed and before the drain trigger returns. */
  readonly afterStoredDownstreamDelivery?: (input: {
    readonly message: DownstreamOutboxMessage;
    readonly event: StoredEvent;
    readonly arrivedAt: number;
    readonly env: CloudflareOnlyEnv;
    readonly ctx: ExecutionContext;
    readonly source?: "queue" | "fast" | "import";
    readonly result?: DeliveryCoreResult;
  }) => Promise<void>;
  /**
   * Runs after a Queue message has durably recorded its event, including when
   * G44 keeps ordinary views fail-closed. The callback must only register
   * non-blocking work with the active ExecutionContext and return.
   */
  readonly afterStoredQueueDelivery?: (input: {
    readonly message: DownstreamOutboxMessage;
    readonly result: DeliveryCoreResult;
    readonly env: CloudflareOnlyEnv;
    readonly ctx: ExecutionContext;
  }) => void;
}

/**
 * Result returned by the sample's retained-frontier safe-lane hook. The
 * scanner result itself intentionally has no mutable frontier: on BLOCK the
 * hook reads the last proven FULL cursor from the persisted health authority.
 */
export interface BeforeLiveProjectionPollResult {
  readonly frontierSuid?: string | null;
}

/**
 * Translate a scheduled scanner outcome and the hook's retained frontier into
 * the live-poll fence. A FULL scan keeps the established unbounded behavior;
 * every other outcome invokes the poll but is bounded by the last proven
 * frontier (or by `null` when none exists).
 */
export function scheduledLiveProjectionMaximumSuid(
  scan: Pick<GlobalCompletenessScanResult, "kind">,
  retainedFrontierSuid: string | null | undefined,
): string | null | undefined {
  return scan.kind === "FULL" ? undefined : retainedFrontierSuid ?? null;
}

/**
 * Keep the portable runtime free of a `cloudflare:workers` runtime import.
 * These entrypoint-owned wrappers inject the active Cloudflare custom-span
 * API into every Durable Object constructor used by the deployed Worker.
 */
export class AllocatorDurableObject extends RuntimeAllocatorDurableObject {
  constructor(ctx: DurableObjectState, env: CloudflareOnlyEnv) {
    super(ctx, env, undefined, cloudflareTracing());
  }
}

export class BootstrapCoordinatorDurableObject extends RuntimeBootstrapCoordinatorDurableObject {
  constructor(ctx: DurableObjectState, env: CloudflareOnlyEnv) {
    super(ctx, env, cloudflareTracing());
  }
}

export class JournalDurableObject extends RuntimeJournalDurableObject {
  constructor(ctx: DurableObjectState, env: CloudflareOnlyEnv) {
    super(ctx, env, cloudflareTracing());
  }
}

export class TagDurableObject extends RuntimeTagDurableObject {
  constructor(ctx: DurableObjectState, env: CloudflareOnlyEnv) {
    super(ctx, env, cloudflareTracing());
  }
}

/** The dedicated (service, tag, projector) cache/replay Durable Object. */
export class TagStateDurableObject extends RuntimeTagStateDurableObject {}

/** Compose the named two-D1 Cloudflare-only Worker. */
export function createCloudflareOnlyRuntimeWorker(
  options: CloudflareOnlyWorkerOptions = {},
): ExportedHandler<CloudflareOnlyEnv> {
  const composition = composeRuntime(options.domain, options.config);
  configureTagStateProjectorRegistry(composition.projectors);
  const storeProvider = createD1StoreProvider();
  return {
    async fetch(request, env, ctx): Promise<Response> {
      const serviceIdentity = options.serviceIdentityProvider ?? envServiceIdentity(env);
      const requestIdentityOptions = { allowG11Verification: env.G11_VERIFICATION_ENABLED === "true" };
      let requestServiceId: string;
      try {
        requestServiceId = serviceIdentity.forRequest(request, requestIdentityOptions).serviceId;
      } catch {
        return scopeIdentityMissingResponse();
      }
      const durableHopObserver = createG60DurableHopObserver(env.D1, (promise) => ctx.waitUntil(promise));
      const url = new URL(request.url);
      if (url.pathname === "/api/sekiban/serialized/commit") {
        return handleSerializedCommit(request, env, {
          domainDeliveryClass: options.config?.deliveryClass,
          registeredEventParsers: registeredEventParsers(options.domain),
          // The meeting-room app reaches this handler through an in-isolate
          // runtime call. Bind the documented module-form tracer at this
          // active CommitWorker callback, matching the Durable Object entry
          // points, rather than retaining the outer handler's context object.
          // This is observation-only: it cannot affect the commit request,
          // ordering, reservations, fences, or response.
          nativeTracing: cloudflareTracing(),
          commitTraceProvider: cloudflareCommitTraceProvider(request, env),
          // The sink receives the immutable in-process snapshot only after
          // the commit handler settles. CF-Ray is ingress identity for the
          // retained-log -> client-ledger join; it is not a protocol input.
          commitTraceSink: createCommitTraceConsoleSink({
            platformRequestId: request.headers.get("cf-ray") ?? undefined,
          }),
          durableHopObserver,
          issuanceResolutionWaitUntil: (promise) => ctx.waitUntil(promise),
          serviceIdentityProvider: serviceIdentity,
        });
      }
      if (
        url.pathname === "/api/sekiban/serialized/query" ||
        url.pathname === "/api/sekiban/serialized/list-query"
      ) {
        return handleSerializedQuery(request, env, {
          registry: composition.queries,
          projectors: composition.projectors,
          storeProvider,
          queryBacking: "d1-mv",
          afterUnsafeRead: ({ serviceId, viewId, entries, observedAt }) => {
            for (const entry of entries) {
              const write = recordFirstUnsafeVisibleRead(env.D1, env.D1_MV, {
                serviceId,
                viewId,
                suid: entry.suid,
                eventIdHint: entry.eventId,
                observedAt,
              }).catch(() => false);
              ctx.waitUntil(write);
            }
          },
          serviceIdentityProvider: serviceIdentity,
        });
      }
      if (url.pathname === "/operator/repair") {
        return handleOperatorRepair(request, env, cloudflareTracing(ctx), serviceIdentity);
      }
      if (url.pathname.startsWith("/operator/bootstrap/")) {
        return handleOperatorBootstrap(request, env, storeProvider, {
          afterVerifyBeforeReady: options.afterBootstrapVerify === undefined
            ? undefined
            : ({ serviceId }) => options.afterBootstrapVerify!({ serviceId, env }),
        });
      }
      if (url.pathname === "/internal/downstream/drain" && request.method === "POST") {
        if (durableHopObserver === undefined) {
          return handleOutboxDrainRequest(request, env, { acknowledgement: "global-receipt" });
        }
        return handleOutboxDrainRequest(request, env, { acknowledgement: "global-receipt", durableHopObserver });
      }
      if (url.pathname === "/internal/projection/lag") {
        return handleProjectionLag(request, env, composition.projectors, storeProvider, serviceIdentity);
      }
      if (
        url.pathname === "/api/sekiban/serialized/tag-latest-sortable" ||
        url.pathname === "/api/sekiban/serialized/tag-state"
      ) {
        return handleSerializedRead(request, env, composition.projectors, storeProvider, serviceIdentity);
      }
      if (url.pathname === "/allocator" || url.pathname.startsWith("/allocator/")) {
        url.pathname = url.pathname.slice("/allocator".length) || "/state";
        const allocator = env.ALLOCATOR.get(scopeIdFor(env.ALLOCATOR, {
          serviceId: requestServiceId,
          doClass: "allocator",
          identity: "allocator",
        }));
        return allocator.fetch(new Request(url.toString(), request));
      }

      const bootstrapMatch = url.pathname.match(/^\/bootstrap\/([^/]+)(\/.*)?$/);
      if (bootstrapMatch !== null) {
        let pathServiceId: string;
        try { pathServiceId = decodeURIComponent(bootstrapMatch[1]); } catch { return new Response("Bootstrap serviceId must be URI encoded", { status: 400 }); }
        if (pathServiceId.length === 0) return new Response("Bootstrap serviceId is required", { status: 400 });
        const scope = enforceControlRouteScope({
          request,
          provider: serviceIdentity,
          pathServiceId,
          route: "bootstrap",
          requestOptions: requestIdentityOptions,
        });
        if ("response" in scope) return scope.response;
        const serviceId = scope.serviceId;
        url.pathname = bootstrapMatch[2] ?? "/state"; url.searchParams.set("__serviceId", serviceId);
        return env.BOOTSTRAP.get(scopeIdFor(env.BOOTSTRAP, {
          serviceId,
          doClass: "bootstrap",
          identity: "coordinator",
        })).fetch(new Request(url.toString(), request));
      }

      const tagMatch = url.pathname.match(/^\/tags\/([^/]+)\/([^/]+)(\/.*)?$/);
      if (tagMatch !== null) {
        // Keep G46's source adapter private to the direct TagStateDO -> Tag
        // DO transport. Header spoofing must not make it a public tag route.
        if (tagMatch[3]?.startsWith("/__internal/g46/")) {
          return new Response("Tag internal route not found", { status: 404 });
        }
        let pathServiceId: string;
        let tag: string;
        try {
          pathServiceId = decodeURIComponent(tagMatch[1]);
          tag = decodeURIComponent(tagMatch[2]);
        } catch {
          return new Response("Tag serviceId and tag must be URI encoded", { status: 400 });
        }
        if (pathServiceId.length === 0 || tag.length === 0) {
          return new Response("Tag serviceId and tag are required", { status: 400 });
        }
        const scope = enforceControlRouteScope({
          request,
          provider: serviceIdentity,
          pathServiceId,
          route: "tag",
          requestOptions: requestIdentityOptions,
        });
        if ("response" in scope) return scope.response;
        const serviceId = scope.serviceId;
        url.pathname = tagMatch[3] ?? "/state";
        url.searchParams.set("__tag", tag);
        url.searchParams.set("__serviceId", serviceId);
        const tagObject = env.TAG.get(scopeIdFor(env.TAG, {
          serviceId,
          doClass: "tag",
          identity: tag,
        }));
        return tagObject.fetch(new Request(url.toString(), request));
      }

      const match = url.pathname.match(/^\/journals\/([^/]+)(\/.*)?$/);
      if (match === null) {
        return new Response("Journal control route not found", { status: 404 });
      }
      const attemptId = decodeURIComponent(match[1]);
      if (attemptId.length === 0) {
        return new Response("Journal attempt id is required", { status: 400 });
      }
      url.pathname = match[2] ?? "/state";
      const journal = env.JOURNAL.get(scopeIdFor(env.JOURNAL, {
        serviceId: requestServiceId,
        doClass: "journal",
        identity: attemptId,
      }));
      return journal.fetch(new Request(url.toString(), request));
    },

    async queue(batch, env, ctx): Promise<void> {
      const serviceIdentity = options.serviceIdentityProvider ?? envServiceIdentity(env);
      requireServiceIdentity(serviceIdentity);
      // The receiver-only G25 fixture intentionally omits TAG and is not a
      // complete G44 source topology. Keep its transport-only seam free of
      // G60 source-hop observations; deployed primary Queue consumers always
      // bind TAG and use the durable ledger.
      const durableHopObserver = env.TAG === undefined
        ? undefined
        : createG60DurableHopObserver(env.D1, (promise) => ctx.waitUntil(promise));
      await handleDownstreamQueue(batch, env, {
        storeProvider,
        views: options.deliveryViews?.({ env, ctx }) ?? [],
        durableHopObserver,
        g69AdmissionAttemptWaitUntil: (promise) => ctx.waitUntil(promise),
        afterDelivery: options.afterStoredDownstreamDelivery === undefined
          ? undefined
          : ({ message, event, arrivedAt, source, result }) => options.afterStoredDownstreamDelivery!({ message, event, arrivedAt, env, ctx, source, result }),
        afterStoredQueueDelivery: options.afterStoredQueueDelivery === undefined
          ? undefined
          : ({ message, result }) => options.afterStoredQueueDelivery!({ message, result, env, ctx }),
      });
    },

    async scheduled(_controller, env, ctx): Promise<void> {
      const serviceIdentity = options.serviceIdentityProvider ?? envServiceIdentity(env);
      const serviceId = requireServiceIdentity(serviceIdentity);
      await stabilizeDownstream(env, { storeProvider }, undefined, serviceIdentity);
      // This scan is source-driven and independent from Queue arrival. Its
      // health/finding tables are the only G44 interim BLOCK/UNSETTLED path.
      const scan = await new GlobalCompletenessReconciler(env.D1, env.TAG).reconcile(serviceId, Date.now());
      // A source gap, page failure, or stale/unknown scan can never advance
      // a live projection past the last proven frontier. The source receipt
      // remains retryable, but the poll still runs so retained safe work and
      // projection liveness are not starved on a BLOCK tick.
      const safeLane = await options.beforeLiveProjectionPoll?.({ env, serviceId, scan, ctx });
      const allocator = env.ALLOCATOR.get(scopeIdFor(env.ALLOCATOR, {
        serviceId,
        doClass: "allocator",
        identity: "allocator",
      }));
      const closedPrefixCertificate = await readRuntimeClosedPrefixCertificate(allocator);
      await pollLiveProjections(env, {
        registry: composition.projectors,
        storeProvider,
        serviceIdentityProvider: serviceIdentity,
        maximumSuid: scheduledLiveProjectionMaximumSuid(scan, safeLane?.frontierSuid),
        closedPrefixSuid: closedPrefixCertificate?.status === "ready" ? closedPrefixCertificate.closedPrefixSuid : null,
        closedPrefixCertificate,
        observer: options.liveProjectionPollObserver,
      });
    },
  };
}

export { processDownstreamDoorbell } from "./downstream/DownstreamAdapter";
export {
  LIVE_PROJECTION_POLL_OUTCOMES,
  pollLiveProjections,
} from "./projection/LiveProjectionWorker";
export type {
  LiveProjectionEnv,
  LiveProjectionPollObservation,
  LiveProjectionPollObserver,
  LiveProjectionPollOutcome,
  ProjectionPollOptions,
} from "./projection/LiveProjectionWorker";
export {
  downstreamEnvelopeBytes,
  classifyDirectDoorbellFailure,
  preflightDirectDoorbell,
  readDomainDeliveryClass,
  readDirectDoorbellConfig,
  selectDirectDoorbellViews,
  MAX_SERVICE_BINDING_INVOCATIONS_PER_REQUEST,
} from "./downstream/Doorbell";
export { deliveryCorrelationId } from "./downstream/DeliveryCore";
export { GlobalCompletenessReconciler } from "./completeness/GlobalCompletenessReconciler";
export {
  G44_HEALTH_STALE_AFTER_MS,
  G44_SCANNER_VERSION,
  GLOBAL_COMPLETENESS_INTERIM_DISPOSITION,
} from "./completeness/types";
export type {
  GlobalCompletenessHealth,
  GlobalCompletenessCoverage,
  GlobalCompletenessHealthRecord,
  GlobalCompletenessScanResult,
  SourceObligationFact,
  SourceObligationPage,
  SourcePartitionSnapshot,
} from "./completeness/types";
export { observeFaultBarrier } from "./trace/ObservationStream";
export {
  G42_JOURNAL_PROBE_ALARM_KEY,
  G42_JOURNAL_PROBE_IDENTITY_PREFIX,
  G42_JOURNAL_PROBE_INDEX_KEY,
  G42_JOURNAL_PROBE_INTERNAL_PREFIX,
  G42_JOURNAL_PROBE_LOGICAL_KEY_PREFIX,
  G42_JOURNAL_PROBE_PATH,
  G42_JOURNAL_PROBE_SCHEMA,
  G42_JOURNAL_PROBE_STORAGE_PREFIX,
  cleanupG42JournalProbeTrial,
  g42ProbeStorageKey,
  inventoryG42JournalProbeTrial,
  isG42ProbeIdentity,
  isG42ProbeLogicalKey,
  parseG42JournalProbeRequest,
  prepareG42JournalProbeTrial,
  measureG42JournalProbeTrial,
  runG42JournalProbeTrial,
} from "./journal/JournalFirstTouchProbe";
export type {
  G42JournalProbeCleanup,
  G42JournalProbeCleanupReceipt,
  G42JournalProbeInventory,
  G42JournalProbeInventoryReceipt,
  G42JournalProbeMeasurement,
  G42JournalProbeMeasurementReceipt,
  G42JournalProbePreparation,
  G42JournalProbePreparationReceipt,
  G42JournalProbeRequest,
  G42JournalProbeTrial,
  G42JournalProbeTrialReceipt,
  G42ProbeActivationFact,
  G42ProbeAlarmMode,
  G42ProbeCell,
  G42ProbeMediator,
  G42ProbeOperationResult,
} from "./journal/JournalFirstTouchProbe";
export type {
  DeliveryClass,
  DownstreamDoorbellBinding,
  DirectDoorbellDegradation,
  DirectDoorbellDeploymentConfig,
  DirectDoorbellPreflightResult,
  DirectDoorbellReceiverMode,
  DirectDoorbellFailureKind,
} from "./downstream/Doorbell";
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
} from "./downstream/DeliveryCore";

const cloudflareOnlyRuntime = createCloudflareOnlyRuntimeWorker();
export default cloudflareOnlyRuntime;
