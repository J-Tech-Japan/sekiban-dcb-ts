import type { DomainDefinition } from "@sekiban/dcb-core";
import { AllocatorDurableObject } from "./allocator/AllocatorDurableObject";
import { BootstrapCoordinatorDurableObject } from "./bootstrap/BootstrapCoordinatorDurableObject";
import { handleOperatorBootstrap } from "./bootstrap/OperatorBootstrap";
import { handleOperatorRepair } from "./cli/OperatorRepairCli";
import { handleSerializedCommit } from "./commit/CommitWorker";
import { handleDownstreamQueue, stabilizeDownstream } from "./downstream/DownstreamAdapter";
import { handleOutboxDrainRequest } from "./downstream/OutboxDrain";
import type { DownstreamOutboxMessage } from "./downstream/types";
import type { DownstreamDoorbellBinding } from "./downstream/Doorbell";
import { JournalDurableObject } from "./journal/JournalDurableObject";
import { composeRuntime, registeredEventParsers, type RuntimeDomainLike, type RuntimeWorkerConfig } from "./composition";
import { handleProjectionLag, pollLiveProjections } from "./projection/LiveProjectionWorker";
import { handleSerializedQuery } from "./http/SerializedQueryWorker";
import { handleSerializedRead } from "./read/SerializedReadWorker";
import { handleIncidentMaintenance, isIncidentMaintenancePath } from "./http/IncidentMaintenance";
import { TagDurableObject } from "./tag/TagDurableObject";
import { TagStateDurableObject, configureTagStateProjectorRegistry } from "./tagstate/TagStateDurableObject";
import { POSTGRES_STORE_PROVIDER, type StoreProvider } from "./store/provider";
import type { MaterializedViewQueryPort, QueryBacking } from "./query/ProjectionQueryStore";
import { nativeTracingFromContext } from "./trace/CommitTrace";
import { createCommitTraceConsoleSink } from "./trace/CommitTraceConsoleSink";
import { enforceControlRouteScope, scopeIdentityMissingResponse } from "./scope/ControlRouteScope";
import { scopeIdFor } from "./scope/ScopeName";
import {
  envServiceIdentity,
  requireServiceIdentity,
  type ServiceIdentityProvider,
} from "./service/ServiceIdentityProvider";
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
export {
  D1MaterializedViewStore,
  MaterializedViewCasError,
  MaterializedViewPatchError,
  MaterializedViewPromotionCasError,
  MaterializedViewStoreError,
} from "./mv/MaterializedViewStore";
export type {
  MaterializedViewApplyInput,
  MaterializedViewApplyResult,
  MaterializedViewCandidateInput,
  MaterializedViewCreateInput,
  MaterializedViewIndexEntry,
  MaterializedViewInstance,
  MaterializedViewOrderingQuarantine,
  MaterializedViewOrderingQuarantineClassification,
  MaterializedViewListConsistency,
  MaterializedViewListOptions,
  MaterializedViewListPage,
  MaterializedViewPromoteInput,
  MaterializedViewQueryOptions,
  MaterializedViewRow,
  MaterializedViewWaitForState,
  MaterializedViewStore,
  MaterializedViewStoreErrorCode,
  MaterializedViewStoreOperation,
} from "./mv/MaterializedViewStore";
export { UnsafeWindowMaterializedViewError, UnsafeWindowMaterializedViewStore } from "./mv/UnsafeWindowMaterializedView";
export type { UnsafeComposedPage, UnsafeGcInput, UnsafeKickLease, UnsafeOutcome, UnsafeReadMeta, UnsafeWindowApplyInput, UnsafeWindowApplyResult, UnsafeWindowErrorCode, UnsafeWindowMaterializedViewStoreOptions } from "./mv/UnsafeWindowMaterializedView";

export { AllocatorDurableObject, BootstrapCoordinatorDurableObject, JournalDurableObject, TagDurableObject, TagStateDurableObject };
export type { ClosedPrefixCertificate } from "./allocator/types";
export type { SafeViewCoverageContext } from "./projection/ProjectionRuntime";
export {
  CommitTrace,
  CommitTraceScope,
  DurableObjectActivation,
  IDLE_EXPERIMENT_SCHEDULE_MS,
  beginWorkerInvocationObservation,
  classifyReactivationCause,
  correlationIdForAttempt,
  createTraceCorrelationId,
  enterNativeActorHandleSpan,
  enterNativeCommitSpan,
  enterNativeReconcileRootSpan,
  nativeTracingFromContext,
  noOpNativeTracing,
  observedIdleGapLowerBoundMs,
  stableTraceHash,
  traceManifest,
} from "./trace/CommitTrace";
export {
  COMMIT_SNAPSHOT_LOG_BYTE_BUDGET,
  COMMIT_SNAPSHOT_LOG_EVENT,
  COMMIT_SNAPSHOT_LOG_SCHEMA,
  assertCommitSnapshotLogSize,
  commitSnapshotLogRecord,
  createCommitTraceConsoleSink,
  encodedCommitSnapshotLogBytes,
} from "./trace/CommitTraceConsoleSink";
export type { CommitSnapshotLogRecord, CommitSnapshotLogRow, CommitTraceConsoleSinkOptions } from "./trace/CommitTraceConsoleSink";
export type {
  CommitTraceActorClass,
  CommitTraceClock,
  CommitTraceFace,
  CommitTraceProviderAdapter,
  CommitTraceSchema,
  CommitTraceSink,
  CommitTraceSnapshot,
  CommitTraceSpan,
  NativeTracing,
  NativeActorHandleIdentity,
  NativeActorHandleInput,
  NativeReconcileRootIdentity,
  ReactivationCause,
  ReactivationEvidence,
} from "./trace/CommitTrace";
export {
  CommitTraceVerificationError,
  calculateUnattributedRatio,
  verifyCommitTrace,
} from "./trace/CommitTraceVerifier";
export type { CommitTraceVerificationOptions, UnattributedRatio } from "./trace/CommitTraceVerifier";
export { BootstrapManifestError, bootstrapDigest, parseBootstrapDump } from "./bootstrap/manifest";
export { BootstrapIdentityConflictError, BootstrapStoreAdapter, createBootstrapStoreAdapter } from "./bootstrap/BootstrapStoreAdapter";
export type { BootstrapExportCursor, BootstrapExportPage } from "./bootstrap/BootstrapStoreAdapter";
export type { BootstrapControlRecord, BootstrapDump, BootstrapEventRecord, BootstrapManifest, BootstrapStatus, BootstrapStoreAdmissionPort } from "./bootstrap/types";
export { handleDownstreamQueue, stabilizeDownstream } from "./downstream/DownstreamAdapter";
export { processDownstreamDoorbell, processDeliveryCore } from "./downstream/DownstreamAdapter";
export {
  downstreamEnvelopeBytes,
  classifyDirectDoorbellFailure,
  readDomainDeliveryClass,
  preflightDirectDoorbell,
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
export {
  IncidentLifecycle,
  IncidentLifecycleError,
} from "./completeness/IncidentLifecycle";
export type {
  IncidentDetailResult,
  IncidentFinding,
  IncidentListFilters,
  IncidentListItem,
  IncidentListResult,
  IncidentTransitionResult,
} from "./completeness/IncidentLifecycle";
export type {
  IncidentCloseResolution,
  IncidentCorrection,
  IncidentLifecycleProjection,
  IncidentLifecycleState,
  IncidentTransitionRecord,
  IncidentTransitionRequest,
} from "./completeness/types";
export type {
  GlobalCompletenessHealth,
  GlobalCompletenessHealthRecord,
  GlobalCompletenessScanResult,
  SourceObligationFact,
  SourceObligationPage,
  SourcePartitionSnapshot,
} from "./completeness/types";
export {
  assertCanonicalEventType,
  canonicalEventType,
  DeliveryIdentityError,
  MissingCanonicalEventIdentityError,
  resolveDeliveryIdentity,
} from "./eventIdentity";
export type { DeliveryProvenance, EventProvenance, ResolvedDeliveryIdentity } from "./eventIdentity";
export {
  allocateOrderRange,
  diagnosticAllocatedAt,
  decodeOrderOrdinal,
  encodeOrderOrdinal,
  OrderClockReadError,
  systemOrderClock,
} from "./allocator/OrderClock";
export type { OrderAllocationRange, OrderClock } from "./allocator/OrderClock";
export {
  DOTNET_MAX_TICKS,
  DOTNET_TICKS_PER_MILLISECOND,
  DOTNET_UNIX_EPOCH_TICKS,
  MAX_UNIX_MILLISECONDS,
  SORTABLE_UNIQUE_ID_DIGITS,
  SORTABLE_UNIQUE_ID_RANDOM_DIGITS,
  SORTABLE_UNIQUE_ID_TICKS_DIGITS,
  SortableUniqueIdError,
  assertDotNetTicks,
  assertSortableUniqueId,
  compareSortableUniqueId,
  cryptoRandomSortableUniqueIdSuffix,
  dotNetTicksToUnixMs,
  formatSortableUniqueId,
  isSortableUniqueId,
  observeLegacySortableUniqueIdDecision,
  unixMsToDotNetTicks,
} from "./allocator/SortableUniqueId";
export type { ParsedSortableUniqueId, SortableUniqueIdErrorCode } from "./allocator/SortableUniqueId";
export {
  admitActiveWrite,
  assertNoSilentLedgerMerge,
  assertStrictlyBefore,
  createRotationState,
  maxSortableUniqueId,
  recordLateArrival,
  refuseSafeWindowSeal,
  refuseSealedWrite,
  refuseSilentLedgerMerge,
  replaceSealedIdentity,
  rotateAppend,
  ShardRotationError,
} from "./shard/ShardRotation";
export type {
  LateArrival,
  SealedShard,
  ShardRotationDiagnostic,
  ShardRotationState,
} from "./shard/ShardRotation";
export {
  MAX_PUBLISHED_SAFE_WINDOW_MS,
  PUBLISHED_SAFE_WINDOW_MS,
  safeWindowCeilingExceeded,
  safeWindowCutoffSuid,
  safeWindowMs,
} from "./safeWindow";
export {
  SERIALIZED_COMMIT_CORRELATION_ID,
  SERIALIZED_SEKIBAN_EXECUTOR,
  createUuidV7,
  isRfc4122Uuid,
  isUuidV7,
  serializedEventMetadata,
  writeTimestampUtc,
} from "./eventRecord";
export type { SerializedEventMetadata } from "./eventRecord";
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
export type {
  DeliveryClass,
  DirectDoorbellDegradation,
  DirectDoorbellDeploymentConfig,
  DirectDoorbellPreflightResult,
  DirectDoorbellReceiverMode,
  DirectDoorbellFailureKind,
  DownstreamDoorbellBinding,
} from "./downstream/Doorbell";
export type { JsonValue, MaterializedViewRowPatch } from "@sekiban/dcb-core";
export {
  composeRuntime,
  createRuntimeCommitPort,
  registeredEventParsers,
  RuntimeCommandRegistry,
} from "./composition";
export type {
  RuntimeCommitAllocationLike,
  RuntimeCommitCandidateLike,
  RuntimeCommitPort,
  RuntimeCommitPortOptions,
  RuntimeCommitPortResult,
  RuntimeCommandLike,
  RuntimeDomainLike,
  RuntimeQueryDefinition,
  RuntimeWorkerConfig,
} from "./composition";
export { POSTGRES_STORE_PROVIDER, createPostgresBootstrapAdapter, createPostgresStoreProvider } from "./store/provider";
export type { StoreProvider, StoreProviderEnvironment } from "./store/provider";
export {
  chooseQueryBacking,
  selectQueryBacking,
} from "./query/ProjectionQueryStore";
export type {
  MaterializedViewQueryPort,
  QueryBacking,
  QueryBackingOptions,
  QueryBackingSelection,
} from "./query/ProjectionQueryStore";

export interface Env {
  ALLOCATOR: DurableObjectNamespace;
  BOOTSTRAP: DurableObjectNamespace;
  JOURNAL: DurableObjectNamespace;
  TAG: DurableObjectNamespace;
  TAG_STATE: DurableObjectNamespace;
  /** Secret binding; deployment must configure this rather than a public var. */
  REPAIR_OPERATOR_TOKEN: string;
  INCIDENT_MAINTAINER_TOKEN?: string;
  /** Queue producer/consumer for durable Tag outbox rows. */
  DOWNSTREAM_QUEUE: Queue<DownstreamOutboxMessage>;
  DOWNSTREAM_DOORBELL?: DownstreamDoorbellBinding;
  /** Deployment-only handoff; local tests retain explicit drain control. */
  AUTO_DRAIN_OUTBOX?: string;
  /** Local Docker/CI connection; deployed Workers normally use HYPERDRIVE. */
  POSTGRES_URL?: string;
  HYPERDRIVE?: Hyperdrive;
  REPAIR_EXCLUSION_LOOKUP?: Fetcher;
  /** Only an authenticated deployment-verification lane may set this. */
  G11_VERIFICATION_ENABLED?: string;
  /** Required non-secret service identity configured per deployment. */
  SDT_SERVICE_ID?: string;
  DOMAIN_DELIVERY_CLASS?: string;
  DIRECT_DOORBELL?: string;
  DIRECT_DOORBELL_ALLOWED_VIEWS?: string;
  DIRECT_DOORBELL_MAX_INVOCATIONS?: string;
  DIRECT_DOORBELL_DEGRADATION?: string;
  DIRECT_DOORBELL_RECEIVER_MODE?: string;
  DIRECT_DOORBELL_SELF_BINDING_PROOF?: string;
  /** Explicit opt-in D1 PipelineStore binding; default composition remains Postgres. */
  D1?: D1Database;
  /** Separate D1 binding for row-backed materialized views. */
  D1_MV?: D1Database;
}

export interface RuntimeWorkerOptions {
  readonly domain?: DomainDefinition | RuntimeDomainLike;
  readonly config?: RuntimeWorkerConfig;
  /** Explicitly opt into a non-Postgres provider; default is Postgres. */
  readonly storeProvider?: StoreProvider;
  /** Deploy-time query backing; defaults to the existing memory projection. */
  readonly queryBacking?: QueryBacking;
  /** Optional injected D1-MV query port for explicit composition/tests. */
  readonly materializedViewQueryPort?: MaterializedViewQueryPort;
  /** Host seam; default composition resolves identity from SDT_SERVICE_ID. */
  readonly serviceIdentityProvider?: ServiceIdentityProvider;
}

/**
 * Compose a Worker from dcb-core domain values. Projector/query registries are
 * intentionally private implementation details; callers only receive the
 * ordinary Worker handler and can therefore use the same public package
 * surface in consumer applications and local Miniflare tests.
 */
export function createRuntimeWorker(options: RuntimeWorkerOptions = {}): ExportedHandler<Env> {
  const composition = composeRuntime(options.domain, options.config);
  configureTagStateProjectorRegistry(composition.projectors);
  const storeProvider = options.storeProvider ?? POSTGRES_STORE_PROVIDER;
  return {
    async fetch(request, env, ctx): Promise<Response> {
      const url = new URL(request.url);
      if (isIncidentMaintenancePath(url.pathname)) {
        return handleIncidentMaintenance(request, env, options.serviceIdentityProvider ?? envServiceIdentity(env));
      }
      const serviceIdentity = options.serviceIdentityProvider ?? envServiceIdentity(env);
      const requestIdentityOptions = { allowG11Verification: env.G11_VERIFICATION_ENABLED === "true" };
      let requestServiceId: string;
      try {
        requestServiceId = serviceIdentity.forRequest(request, requestIdentityOptions).serviceId;
      } catch {
        return scopeIdentityMissingResponse();
      }
      if (url.pathname === "/api/sekiban/serialized/commit") {
        return handleSerializedCommit(request, env, {
          domainDeliveryClass: options.config?.deliveryClass,
          registeredEventParsers: registeredEventParsers(options.domain),
          nativeTracing: nativeTracingFromContext(ctx),
          commitTraceSink: createCommitTraceConsoleSink({
            platformRequestId: request.headers.get("cf-ray") ?? undefined,
          }),
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
          queryBacking: options.queryBacking,
          materializedViewQueryPort: options.materializedViewQueryPort,
          serviceIdentityProvider: serviceIdentity,
        });
      }
      if (url.pathname === "/operator/repair") {
        return handleOperatorRepair(request, env, nativeTracingFromContext(ctx), serviceIdentity);
      }
      if (url.pathname.startsWith("/operator/bootstrap/")) {
        return handleOperatorBootstrap(request, env, storeProvider);
      }
      if (url.pathname === "/internal/downstream/drain" && request.method === "POST") {
        return handleOutboxDrainRequest(request, env, { serviceIdentityProvider: serviceIdentity });
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
        // G46's bounded TagState source adapter is a direct DO-to-DO seam,
        // never a role-facing `/tags/*` route.  Do not let an arbitrary
        // client replay its header through the generic tag forwarder.
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

    async queue(batch, env): Promise<void> {
      requireServiceIdentity(options.serviceIdentityProvider ?? envServiceIdentity(env));
      await handleDownstreamQueue(batch, env, { storeProvider });
    },

    async scheduled(_controller, env): Promise<void> {
      const serviceIdentity = options.serviceIdentityProvider ?? envServiceIdentity(env);
      requireServiceIdentity(serviceIdentity);
      await stabilizeDownstream(env, { storeProvider }, undefined, serviceIdentity);
      await pollLiveProjections(env, { registry: composition.projectors, storeProvider, serviceIdentityProvider: serviceIdentity });
    },
  };
}

const worker = createRuntimeWorker();

export default worker;
