import {
  DEPLOYED_PROJECTOR_REGISTRY,
  type ProjectorRegistry,
} from "../projection/ProjectorRegistry";
import { safeWindowCeilingExceeded, safeWindowMs } from "../projection/ProjectionRuntime";
import {
  projectionHasObserved,
  readProjectionHead,
  readRowsPageFromBacking,
  selectQueryBacking,
  compareSuid,
  type ProjectedQueryEntry,
  type QueryBacking,
  type QueryBackingSelection,
  type MaterializedViewQueryPort,
  type QueryProjectionStore,
  type WaitForTargetLookup,
  type WaitForTargetSourcePort,
} from "../query/ProjectionQueryStore";
import { D1MaterializedViewStore } from "../mv/MaterializedViewStore";
import {
  DEPLOYED_QUERY_REGISTRY,
  type QueryDefinition,
  type QueryEndpoint,
  type QueryRegistry,
} from "../query/QueryRegistry";
import type { StoreProvider } from "../store/provider";
import type { PipelineStore } from "../store/types";
import { assertSortableUniqueId } from "../allocator/SortableUniqueId";
import {
  envServiceIdentity,
  requestServiceIdentity,
  type ServiceIdentityProvider,
} from "../service/ServiceIdentityProvider";

export interface QueryWorkerEnv {
  POSTGRES_URL?: string;
  HYPERDRIVE?: Hyperdrive;
  /** Optional explicit D1 provider binding; Postgres remains the default. */
  D1?: D1Database;
  /** Set only by an authenticated deployment-verification lane. */
  G11_VERIFICATION_ENABLED?: string;
  /** Non-secret service identity configured per deployment. */
  SDT_SERVICE_ID?: string;
  /** Separate D1 binding for row-backed materialized-view queries. */
  D1_MV?: D1Database;
}

export interface QueryExecutionOptions {
  /** A read-only fake store keeps wait and paging tests deterministic. */
  store?: QueryProjectionStore;
  storeProvider?: StoreProvider;
  registry?: QueryRegistry;
  projectors?: ProjectorRegistry;
  /** Deploy-time query backing; request data can never select this value. */
  queryBacking?: QueryBacking;
  /** Optional injected port for tests or an explicitly composed runtime. */
  materializedViewQueryPort?: MaterializedViewQueryPort;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  /** Internal observation only; invoked without awaiting or changing the V1 response. */
  afterUnsafeRead?: (input: {
    readonly serviceId: string;
    readonly viewId: string;
    readonly entries: readonly ProjectedQueryEntry[];
    readonly observedAt: number;
  }) => void;
  /** Host/deployment identity seam; defaults to envServiceIdentity. */
  serviceIdentityProvider?: ServiceIdentityProvider;
}

interface QueryRequest {
  queryType: string;
  queryParams: unknown;
  waitForSortableUniqueId?: string;
}

interface Pagination {
  currentPage: number;
  pageSize: number;
  newestFirst: boolean;
  consistency: "safe" | "unsafe";
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function requestStore(env: QueryWorkerEnv, provider: StoreProvider): PipelineStore {
  // A postgres client is a request-scoped I/O object in workerd. Retaining it
  // across fetch handlers turns a later list-query into a cross-request I/O
  // violation, so the read-only query path intentionally creates one per HTTP
  // request rather than sharing the projection worker's scheduled-poll store.
  return provider.create(env);
}

function parseRequest(value: unknown): { value?: QueryRequest; error?: string } {
  if (!isObject(value) || !isNonEmptyString(value.queryType) || typeof value.queryParamsJson !== "string") {
    return { error: "queryType and queryParamsJson are required" };
  }
  let queryParams: unknown;
  try {
    queryParams = JSON.parse(value.queryParamsJson);
  } catch {
    return { error: "queryParamsJson must contain a JSON document" };
  }
  if (value.waitForSortableUniqueId !== undefined && !isNonEmptyString(value.waitForSortableUniqueId)) {
    return { error: "waitForSortableUniqueId must be a non-empty string when present" };
  }
  if (value.waitForSortableUniqueId !== undefined) {
    try {
      assertSortableUniqueId(value.waitForSortableUniqueId);
    } catch {
      return { error: "waitForSortableUniqueId must be a 30-digit SortableUniqueId" };
    }
  }
  return {
    value: {
      queryType: value.queryType,
      queryParams,
      waitForSortableUniqueId: value.waitForSortableUniqueId as string | undefined,
    },
  };
}

function paginationFrom(value: unknown): { value?: Pagination; error?: string } {
  if (!isObject(value)) {
    return { error: "list-query queryParamsJson must contain an object" };
  }
  const currentPage = value.PageNumber ?? 1;
  const pageSize = value.PageSize ?? 20;
  const newestFirst = value.NewestFirst ?? false;
  const consistency = value.consistency ?? "safe";
  if (
    typeof currentPage !== "number" || !Number.isSafeInteger(currentPage) || currentPage < 1 ||
    typeof pageSize !== "number" || !Number.isSafeInteger(pageSize) || pageSize < 1 ||
    typeof newestFirst !== "boolean" ||
    (consistency !== "safe" && consistency !== "unsafe")
  ) {
    return { error: "PageNumber and PageSize must be positive integers, NewestFirst must be a boolean, and consistency must be safe or unsafe" };
  }
  return { value: { currentPage, pageSize, newestFirst, consistency } };
}

function decodePayload(entry: ProjectedQueryEntry): unknown {
  try {
    // G32 projections carry the exact decoded JSON text from dcb_events.
    // Do not revive the historical atob path: it would reinterpret already
    // persisted bytes and hide a storage-format regression.
    return JSON.parse(entry.payload);
  } catch {
    // A projection value can still be a deliberately opaque string. The
    // commit admission boundary has already guaranteed event payload JSON.
    return entry.payload;
  }
}

function realSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * G31 reserves a final loop slot so a healthy pending 120s waiter does not
 * stop polling before its absolute deadline: 126 loop slots / at most 126
 * source+MV probes plus one final confirmation. Backoff is 25, 50, 100, 200,
 * 400, 800, then 1000ms. A normal pending waiter therefore makes 26 paired
 * probes at the 20s floor and 126 at the 120s ceiling; a mandatory
 * final-success recheck raises the global maximum to 127 paired probes / 254
 * point-read statements. The cap
 * also makes a stalled test clock deterministic instead of issuing unbounded
 * reads.
 */
export const D1_WAIT_MAX_ITERATIONS = 126;
export const D1_WAIT_MAX_POINT_READS = 254;
const D1_WAIT_MAX_PROBES = D1_WAIT_MAX_POINT_READS / 2;
const D1_WAIT_INITIAL_BACKOFF_MS = 25;
const D1_WAIT_MAX_BACKOFF_MS = 1_000;

type D1WaitResult = "visible" | "timeout" | "unavailable";

interface D1WaitFacts {
  readonly target: WaitForTargetLookup;
  readonly unavailable: boolean;
  readonly targetReceipt: boolean;
  readonly safeContiguousHead: string;
  readonly activeGeneration: number | undefined;
}

function isWaitForTargetSourcePort(value: QueryProjectionStore): value is QueryProjectionStore & WaitForTargetSourcePort {
  return typeof (value as Partial<WaitForTargetSourcePort>).readWaitForTarget === "function";
}

function d1WaitSucceeded(facts: D1WaitFacts): boolean {
  if (facts.unavailable || facts.target.kind !== "stored") return false;
  // Receipt and safe-head are separate success branches. In particular, a
  // head without a unique source target can never satisfy this condition.
  return facts.targetReceipt || (
    facts.activeGeneration !== undefined &&
    compareSuid(facts.safeContiguousHead, facts.target.suid) >= 0
  );
}

async function readD1WaitFacts(
  source: QueryProjectionStore & WaitForTargetSourcePort,
  materializedView: MaterializedViewQueryPort,
  serviceId: string,
  viewId: string,
  requestedSuid: string,
): Promise<D1WaitFacts> {
  const target = await source.readWaitForTarget(serviceId, requestedSuid);
  // SUID collision/lineage mismatch is an incident gate before any success
  // evaluation. A contradictory two-row source target is equivalently
  // unavailable, rather than a candidate for safe-head aliasing.
  if (target.kind === "unavailable") {
    return { target, unavailable: true, targetReceipt: false, safeContiguousHead: "", activeGeneration: undefined };
  }
  if (materializedView.readWaitForState === undefined) {
    throw new Error("D1 materialized-view waitFor state port is not configured");
  }
  const state = await materializedView.readWaitForState(serviceId, viewId, {
    ...(target.kind === "stored" ? { eventId: target.eventId } : {}),
    suid: requestedSuid,
  });
  const unavailable = state.checkpointAhead || state.rebuildRequired || state.poison;
  return {
    target,
    unavailable,
    targetReceipt: state.targetReceipt,
    safeContiguousHead: state.safeContiguousHead,
    activeGeneration: state.activeGeneration,
  };
}

function d1WaitBackoff(iteration: number): number {
  return Math.min(D1_WAIT_MAX_BACKOFF_MS, D1_WAIT_INITIAL_BACKOFF_MS * 2 ** Math.min(iteration, 6));
}

/**
 * A non-normal flapping success proof can exhaust the global read budget
 * before the deadline. Preserve the published deadline in that case without
 * issuing another point read. The progress check keeps an injected frozen
 * clock deterministic in the test seam.
 */
async function sleepToD1WaitDeadline(
  deadline: number,
  sleep: (milliseconds: number) => Promise<void>,
  now: () => number,
): Promise<void> {
  let observedAt = now();
  while (observedAt < deadline) {
    await sleep(Math.min(D1_WAIT_MAX_BACKOFF_MS, deadline - observedAt));
    const advancedAt = now();
    if (advancedAt <= observedAt) return;
    observedAt = advancedAt;
  }
}

async function waitForD1Projection(
  source: QueryProjectionStore & WaitForTargetSourcePort,
  materializedView: MaterializedViewQueryPort,
  serviceId: string,
  viewId: string,
  requestedSuid: string,
  requestStartedAt: number,
  options: QueryExecutionOptions,
): Promise<D1WaitResult> {
  const now = options.now ?? Date.now;
  // The lag estimate and deadline are both anchored at request start. Later
  // samples must not stretch a request's published SafeWindow.
  const dynamicLagBoundMs = await source.currentLagBound(serviceId, requestStartedAt);
  const deadline = requestStartedAt + safeWindowMs(dynamicLagBoundMs);
  const sleep = options.sleep ?? realSleep;
  let probes = 0;
  const probe = async (): Promise<D1WaitFacts | undefined> => {
    if (probes >= D1_WAIT_MAX_PROBES) return undefined;
    probes += 1;
    return readD1WaitFacts(source, materializedView, serviceId, viewId, requestedSuid);
  };

  for (let iteration = 0; iteration < D1_WAIT_MAX_ITERATIONS; iteration += 1) {
    // A sleep that resumes exactly at the boundary gets one final proof and,
    // when ready, its mandatory confirmation. A late resumption gets no
    // post-deadline probe, so sleep overhead cannot widen the SafeWindow.
    if (now() > deadline) return "timeout";
    const facts = await probe();
    if (facts === undefined) {
      await sleepToD1WaitDeadline(deadline, sleep, now);
      return "timeout";
    }
    if (facts.unavailable) return "unavailable";
    // An over-ceiling estimate remains indeterminate after (and only after)
    // the initial incident gate. It must not be bypassed by a ready receipt.
    if (safeWindowCeilingExceeded(dynamicLagBoundMs)) return "timeout";
    if (d1WaitSucceeded(facts)) {
      // A state can change between the first proof and response creation.
      // Re-read incident/rebuild/poison and the generation-bound receipt just
      // before success; this is deliberately not a cached boolean.
      const confirmed = await probe();
      if (confirmed === undefined) {
        await sleepToD1WaitDeadline(deadline, sleep, now);
        return "timeout";
      }
      if (confirmed.unavailable) return "unavailable";
      if (d1WaitSucceeded(confirmed)) return "visible";
    }
    if (now() >= deadline) {
      return "timeout";
    }
    if (probes >= D1_WAIT_MAX_PROBES || iteration + 1 >= D1_WAIT_MAX_ITERATIONS) {
      await sleepToD1WaitDeadline(deadline, sleep, now);
      return "timeout";
    }
    await sleep(Math.min(d1WaitBackoff(iteration), Math.max(1, deadline - now())));
  }
  return "timeout";
}

async function waitForProjection(
  store: QueryProjectionStore,
  serviceId: string,
  definition: QueryDefinition,
  requestedSuid: string,
  options: QueryExecutionOptions,
): Promise<boolean> {
  const now = options.now ?? Date.now;
  const dynamicLagBoundMs = await store.currentLagBound(serviceId, now());
  // A bound above the published ceiling is indeterminate. Do not turn that
  // state into an empty success by clamping it and waiting forever.
  if (safeWindowCeilingExceeded(dynamicLagBoundMs)) {
    return false;
  }
  const deadline = now() + safeWindowMs(dynamicLagBoundMs);
  const sleep = options.sleep ?? realSleep;
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 25);

  while (now() < deadline) {
    if (await projectionHasObserved(store, serviceId, definition, requestedSuid)) {
      return true;
    }
    await sleep(Math.min(pollIntervalMs, deadline - now()));
  }
  return false;
}

function endpointFromPath(path: string): QueryEndpoint | undefined {
  if (path === "/api/sekiban/serialized/query") {
    return "query";
  }
  if (path === "/api/sekiban/serialized/list-query") {
    return "list-query";
  }
  return undefined;
}

function resultResponse(
  endpoint: QueryEndpoint,
  entries: readonly ProjectedQueryEntry[],
  pagination?: Pagination,
  totalCount = entries.length,
  serverPaged = false,
  readHead?: string,
): Response {
  if (endpoint === "query") {
    return json({ resultJson: JSON.stringify({ count: entries.length }) });
  }
  const page = pagination!;
  const offset = (page.currentPage - 1) * page.pageSize;
  const items = (serverPaged ? entries : entries.slice(offset, offset + page.pageSize)).map(decodePayload);
  return json({
    itemsJson: JSON.stringify(items),
    totalCount,
    totalPages: totalCount === 0 ? 0 : Math.ceil(totalCount / page.pageSize),
    currentPage: page.currentPage,
    pageSize: page.pageSize,
    ...(readHead === undefined ? {} : { readHead }),
  });
}

function pageReadHead(
  entries: readonly ProjectedQueryEntry[],
  page: Pagination,
  serverPaged: boolean,
  safeHead?: string,
): string | undefined {
  if (page.consistency === "safe") return safeHead;
  const offset = (page.currentPage - 1) * page.pageSize;
  const visible = serverPaged ? entries : entries.slice(offset, offset + page.pageSize);
  return visible.reduce((head, entry) => compareSuid(entry.suid, head) > 0 ? entry.suid : head, "");
}

/**
 * V1 §5.4/§5.5 HTTP surface. It never starts a projection catch-up or writes
 * a source/checkpoint row: the query sees only the durable read-side snapshot.
 */
export async function handleSerializedQuery(
  request: Request,
  env: QueryWorkerEnv,
  options: QueryExecutionOptions = {},
): Promise<Response> {
  const requestStartedAt = (options.now ?? Date.now)();
  const endpoint = endpointFromPath(new URL(request.url).pathname);
  const serviceId = requestServiceIdentity(request, options.serviceIdentityProvider ?? envServiceIdentity(env), {
    allowG11Verification: env.G11_VERIFICATION_ENABLED === "true",
  });
  if (endpoint === undefined || request.method !== "POST") {
    return error(404, "query_route_not_found", "Query routes require POST");
  }
  let rawBody: unknown;
  try {
    rawBody = await request.json<unknown>();
  } catch {
    return error(400, "validation_error", "Query request must be JSON");
  }
  const parsed = parseRequest(rawBody);
  if (parsed.value === undefined) {
    return error(400, "validation_error", parsed.error ?? "Invalid query request");
  }
  const registry = options.registry ?? DEPLOYED_QUERY_REGISTRY;
  const definition = registry.resolve(parsed.value.queryType);
  if (definition === undefined || definition.endpoint !== endpoint) {
    return error(400, "validation_error", "queryType is not mapped for this endpoint");
  }
  if (!definition.enabled || (options.projectors ?? DEPLOYED_PROJECTOR_REGISTRY).resolve(definition.tagProjector) === undefined) {
    return error(503, "projection_unavailable", "The mapped query projection is unavailable");
  }
  const pagination = endpoint === "list-query" ? paginationFrom(parsed.value.queryParams) : { value: undefined };
  if (pagination.value === undefined && pagination.error !== undefined) {
    return error(400, "validation_error", pagination.error);
  }

  let d1MaterializedView: MaterializedViewQueryPort | undefined;
  let d1SafeRead = false;
  const viewId = definition.materializedViewId ?? definition.tagProjector;
  try {
    const backing = options.queryBacking ?? "memory";
    let requestStoreValue: PipelineStore | undefined;
    let waitStore: QueryProjectionStore | undefined = options.store;
    let selection: QueryBackingSelection;
    let safeReadGeneration: number | undefined;
    if (backing === "d1-mv") {
      const materializedView = options.materializedViewQueryPort ??
        (env.D1_MV === undefined ? undefined : new D1MaterializedViewStore(env.D1_MV));
      if (materializedView === undefined) {
        return error(503, "projection_unavailable", "The D1 materialized-view query projection is unavailable");
      }
      d1MaterializedView = materializedView;
      await materializedView.initialize?.();
      selection = selectQueryBacking({ backing, materializedView });
      const orderingQuarantine = await materializedView.readOrderingQuarantine?.(serviceId, viewId);
      const safeRead = pagination.value?.consistency !== "unsafe";
      d1SafeRead = safeRead;
      if (safeRead && orderingQuarantine !== undefined) {
        return error(
          503,
          "projection_ordering_quarantined",
          "The mapped query projection is quarantined for a source-ordering incident; rebuild and promote the affected generation",
        );
      }
      if (safeRead) safeReadGeneration = await materializedView.readActiveGeneration?.(serviceId, viewId);
      if (await materializedView.hasCheckpointAheadFinding?.(serviceId, viewId)) {
        return error(503, "projection_unavailable", "The D1 materialized-view query projection is unavailable");
      }
      // Waiting still needs the durable source/checkpoint facts. Only create
      // the normal source store when the request actually asks to wait.
      if (parsed.value.waitForSortableUniqueId !== undefined && waitStore === undefined) {
        if (options.storeProvider === undefined) {
          return error(503, "projection_unavailable", "A query projection store is not configured");
        }
        requestStoreValue = requestStore(env, options.storeProvider);
        await requestStoreValue.initialize();
        waitStore = requestStoreValue;
      }
    } else {
      if (options.store === undefined && options.storeProvider === undefined) {
        return error(503, "projection_unavailable", "A query projection store is not configured");
      }
      requestStoreValue = options.store === undefined
        ? requestStore(env, options.storeProvider!)
        : undefined;
      waitStore = options.store ?? requestStoreValue!;
      if (requestStoreValue !== undefined) {
        await requestStoreValue.initialize();
      }
      selection = selectQueryBacking({ backing, memory: waitStore });
    }
    if (parsed.value.waitForSortableUniqueId !== undefined) {
      let waitResult: D1WaitResult | undefined;
      if (selection.backing === "d1-mv") {
        if (waitStore === undefined || d1MaterializedView === undefined || !isWaitForTargetSourcePort(waitStore)) {
          return error(503, "projection_unavailable", "The D1 materialized-view waitFor source is unavailable");
        }
        waitResult = await waitForD1Projection(
          waitStore,
          d1MaterializedView,
          serviceId,
          definition.materializedViewId ?? definition.tagProjector,
          parsed.value.waitForSortableUniqueId,
          requestStartedAt,
          options,
        );
      } else if (waitStore === undefined || !await waitForProjection(waitStore, serviceId, definition, parsed.value.waitForSortableUniqueId, options)) {
        waitResult = "timeout";
      } else {
        waitResult = "visible";
      }
      if (waitResult === "unavailable") {
        const waitQuarantine = d1SafeRead && d1MaterializedView !== undefined
          ? await d1MaterializedView.readOrderingQuarantine?.(serviceId, viewId)
          : undefined;
        if (waitQuarantine !== undefined) {
          return error(
            503,
            "projection_ordering_quarantined",
            "The mapped query projection is quarantined for a source-ordering incident; rebuild and promote the affected generation",
          );
        }
        return error(503, "projection_unavailable", "The mapped query projection is unavailable");
      }
      if (waitResult !== "visible") {
        const timeoutQuarantine = d1SafeRead && d1MaterializedView !== undefined
          ? await d1MaterializedView.readOrderingQuarantine?.(serviceId, viewId)
          : undefined;
        if (timeoutQuarantine !== undefined) {
          return error(
            503,
            "projection_ordering_quarantined",
            "The mapped query projection is quarantined for a source-ordering incident; rebuild and promote the affected generation",
          );
        }
        return error(
          504,
          "timeout",
          "Projection did not reach the requested sortableUniqueId within the published SafeWindow; refresh this read to inspect current state",
        );
      }
      // Quarantine can be created while waitFor is polling. Re-check the
      // active generation at the response boundary; an early check alone can
      // return a 200 after the ordering detector has already opened a gate.
      if (d1SafeRead && d1MaterializedView !== undefined) {
        const boundaryQuarantine = await d1MaterializedView.readOrderingQuarantine?.(serviceId, viewId);
        if (boundaryQuarantine !== undefined) {
          return error(
            503,
            "projection_ordering_quarantined",
            "The mapped query projection is quarantined for a source-ordering incident; rebuild and promote the affected generation",
          );
        }
        const boundaryGeneration = await d1MaterializedView.readActiveGeneration?.(serviceId, viewId);
        if (boundaryGeneration !== undefined && safeReadGeneration !== undefined && boundaryGeneration !== safeReadGeneration) {
          return error(503, "projection_unavailable", "The mapped query projection changed generation while the safe wait was running; retry the read");
        }
        safeReadGeneration = boundaryGeneration ?? safeReadGeneration;
      }
    }
    if (d1SafeRead && parsed.value.waitForSortableUniqueId === undefined && d1MaterializedView !== undefined) {
      const boundaryQuarantine = await d1MaterializedView.readOrderingQuarantine?.(serviceId, viewId);
      if (boundaryQuarantine !== undefined) {
        return error(
          503,
          "projection_ordering_quarantined",
          "The mapped query projection is quarantined for a source-ordering incident; rebuild and promote the affected generation",
        );
      }
      const boundaryGeneration = await d1MaterializedView.readActiveGeneration?.(serviceId, viewId);
      if (boundaryGeneration !== undefined && safeReadGeneration !== undefined && boundaryGeneration !== safeReadGeneration) {
        return error(503, "projection_unavailable", "The mapped query projection changed generation while the safe read was being prepared; retry the read");
      }
      safeReadGeneration = boundaryGeneration ?? safeReadGeneration;
    }
    const requestedPage = pagination.value;
      if (requestedPage !== undefined && selection.backing === "d1-mv" && selection.store.readListPage !== undefined) {
      const page = await selection.store.readListPage(serviceId, viewId, {
        ...(safeReadGeneration === undefined ? {} : { generation: safeReadGeneration }),
        limit: requestedPage.pageSize,
        offset: (requestedPage.currentPage - 1) * requestedPage.pageSize,
        ...(requestedPage.newestFirst ? { descending: true } : {}),
        consistency: requestedPage.consistency,
      });
      if (d1SafeRead && d1MaterializedView !== undefined) {
        const pageQuarantine = await d1MaterializedView.readOrderingQuarantine?.(serviceId, viewId);
        if (pageQuarantine !== undefined) {
          return error(
            503,
            "projection_ordering_quarantined",
            "The mapped query projection is quarantined for a source-ordering incident; rebuild and promote the affected generation",
          );
        }
        const pageGeneration = await d1MaterializedView.readActiveGeneration?.(serviceId, viewId);
        if (pageGeneration !== undefined && safeReadGeneration !== undefined && pageGeneration !== safeReadGeneration) {
          return error(503, "projection_unavailable", "The mapped query projection changed generation while the safe page was being read; retry the read");
        }
      }
      const entries = page.rows.map((row) => ({
        eventId: isObject(row.value) && typeof row.value.eventId === "string" && row.value.eventId.length > 0 ? row.value.eventId : row.rowKey,
        suid: row.sourceSuid,
        payload: JSON.stringify(row.value),
      }));
      if (requestedPage.consistency === "unsafe") {
        options.afterUnsafeRead?.({
          serviceId,
          viewId,
          entries,
          observedAt: Date.now(),
        });
      }
      return resultResponse(endpoint, entries, requestedPage, page.totalCount, true, page.readHead);
    }
    const supportsServerPaging = selection.backing === "d1-mv" && selection.store.queryRowsWithTotal !== undefined;
    const page = await readRowsPageFromBacking(
      selection,
      serviceId,
      viewId,
      definition,
      requestedPage === undefined || !supportsServerPaging
        ? { limit: null, ...(safeReadGeneration === undefined ? {} : { generation: safeReadGeneration }) }
        : {
          ...(safeReadGeneration === undefined ? {} : { generation: safeReadGeneration }),
          limit: requestedPage.pageSize,
          offset: (requestedPage.currentPage - 1) * requestedPage.pageSize,
          ...(requestedPage.newestFirst ? { descending: true } : {}),
      },
    );
    if (d1SafeRead && d1MaterializedView !== undefined) {
      const pageQuarantine = await d1MaterializedView.readOrderingQuarantine?.(serviceId, viewId);
      if (pageQuarantine !== undefined) {
        return error(
          503,
          "projection_ordering_quarantined",
          "The mapped query projection is quarantined for a source-ordering incident; rebuild and promote the affected generation",
        );
      }
      const pageGeneration = await d1MaterializedView.readActiveGeneration?.(serviceId, viewId);
      if (pageGeneration !== undefined && safeReadGeneration !== undefined && pageGeneration !== safeReadGeneration) {
        return error(503, "projection_unavailable", "The mapped query projection changed generation while the safe page was being read; retry the read");
      }
    }
    if (requestedPage?.consistency === "unsafe") {
      options.afterUnsafeRead?.({
        serviceId,
        viewId,
        entries: page.entries,
        observedAt: Date.now(),
      });
    }
    const memorySafeHead = requestedPage?.consistency === "safe" && selection.backing === "memory"
      ? await readProjectionHead(selection.store, serviceId, definition)
      : undefined;
    return resultResponse(
      endpoint,
      page.entries,
      pagination.value,
      page.totalCount,
      page.serverPaged,
      requestedPage === undefined ? undefined : pageReadHead(page.entries, requestedPage, page.serverPaged, memorySafeHead),
    );
  } catch {
    // A wait/read can race the detector or a generation transition. If the
    // ordering quarantine is already durable, preserve its typed public
    // contract instead of collapsing the race into generic unavailability.
    if (d1SafeRead && d1MaterializedView !== undefined) {
      try {
        const caughtQuarantine = await d1MaterializedView.readOrderingQuarantine?.(serviceId, viewId);
        if (caughtQuarantine !== undefined) {
          return error(
            503,
            "projection_ordering_quarantined",
            "The mapped query projection is quarantined for a source-ordering incident; rebuild and promote the affected generation",
          );
        }
      } catch {
        // Preserve the existing generic unavailable response if the
        // quarantine probe itself is unavailable.
      }
    }
    return error(503, "projection_unavailable", "The mapped query projection is unavailable");
  }
}
