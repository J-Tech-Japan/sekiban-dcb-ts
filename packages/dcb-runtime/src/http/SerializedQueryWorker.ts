import {
  DEPLOYED_PROJECTOR_REGISTRY,
  type ProjectorRegistry,
} from "../projection/ProjectorRegistry";
import { safeWindowCeilingExceeded, safeWindowMs } from "../projection/ProjectionRuntime";
import {
  projectionHasObserved,
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
import { serviceIdForRequest } from "./testServiceId";

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
  if (
    typeof currentPage !== "number" || !Number.isSafeInteger(currentPage) || currentPage < 1 ||
    typeof pageSize !== "number" || !Number.isSafeInteger(pageSize) || pageSize < 1 ||
    typeof newestFirst !== "boolean"
  ) {
    return { error: "PageNumber and PageSize must be positive integers and NewestFirst must be a boolean" };
  }
  return { value: { currentPage, pageSize, newestFirst } };
}

function decodePayload(entry: ProjectedQueryEntry): unknown {
  try {
    const binary = atob(entry.payload);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    // V1 transports arbitrary base64 payload bytes. A query result must remain
    // valid JSON even when a deployed event-history projector contains bytes
    // that are not themselves a JSON document.
    return entry.payload;
  }
}

function realSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * G31 bounds each d1-mv wait to 125 loop iterations / 126 source+MV probes.
 * Backoff is 25, 50, 100, 200, 400, 800, then at most 1000ms; over the 120s
 * SafeWindow that is at most 252 point-read statements including the
 * mandatory final success recheck. The cap also makes a stalled test clock
 * deterministic instead of issuing unbounded reads.
 */
export const D1_WAIT_MAX_ITERATIONS = 125;
export const D1_WAIT_MAX_POINT_READS = 252;
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
  return Math.min(D1_WAIT_MAX_BACKOFF_MS, D1_WAIT_INITIAL_BACKOFF_MS * 2 ** Math.min(iteration, 5));
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
    const facts = await probe();
    if (facts === undefined) return "timeout";
    if (facts.unavailable) return "unavailable";
    if (d1WaitSucceeded(facts)) {
      // A state can change between the first proof and response creation.
      // Re-read incident/rebuild/poison and the generation-bound receipt just
      // before success; this is deliberately not a cached boolean.
      const confirmed = await probe();
      if (confirmed === undefined) return "timeout";
      if (confirmed.unavailable) return "unavailable";
      if (d1WaitSucceeded(confirmed)) return "visible";
    }
    // An over-ceiling lag is a timeout only after the initial incident gate;
    // it never reclassifies a 503 operational finding as a 504.
    if (safeWindowCeilingExceeded(dynamicLagBoundMs) || now() >= deadline || iteration + 1 >= D1_WAIT_MAX_ITERATIONS) {
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

function resultResponse(endpoint: QueryEndpoint, entries: readonly ProjectedQueryEntry[], pagination?: Pagination, totalCount = entries.length, serverPaged = false): Response {
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
  });
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
  const serviceId = serviceIdForRequest(request, {
    allowG11Verification: env.G11_VERIFICATION_ENABLED === "true",
    configuredServiceId: env.SDT_SERVICE_ID,
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

  try {
    const backing = options.queryBacking ?? "memory";
    let requestStoreValue: PipelineStore | undefined;
    let waitStore: QueryProjectionStore | undefined = options.store;
    let selection: QueryBackingSelection;
    let d1MaterializedView: MaterializedViewQueryPort | undefined;
    if (backing === "d1-mv") {
      const materializedView = options.materializedViewQueryPort ??
        (env.D1_MV === undefined ? undefined : new D1MaterializedViewStore(env.D1_MV));
      if (materializedView === undefined) {
        return error(503, "projection_unavailable", "The D1 materialized-view query projection is unavailable");
      }
      d1MaterializedView = materializedView;
      await materializedView.initialize?.();
      selection = selectQueryBacking({ backing, materializedView });
      if (await materializedView.hasCheckpointAheadFinding?.(serviceId, definition.materializedViewId ?? definition.tagProjector)) {
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
        return error(503, "projection_unavailable", "The mapped query projection is unavailable");
      }
      if (waitResult !== "visible") {
        return error(
          504,
          "timeout",
          "Projection did not reach the requested sortableUniqueId within the published SafeWindow; refresh this read to inspect current state",
        );
      }
    }
    const requestedPage = pagination.value;
    const supportsServerPaging = selection.backing === "d1-mv" && selection.store.queryRowsWithTotal !== undefined;
    const page = await readRowsPageFromBacking(
      selection,
      serviceId,
      definition.materializedViewId ?? definition.tagProjector,
      definition,
      requestedPage === undefined || !supportsServerPaging
        ? { limit: null }
        : {
          limit: requestedPage.pageSize,
          offset: (requestedPage.currentPage - 1) * requestedPage.pageSize,
          ...(requestedPage.newestFirst ? { descending: true } : {}),
        },
    );
    return resultResponse(endpoint, page.entries, pagination.value, page.totalCount, page.serverPaged);
  } catch {
    return error(503, "projection_unavailable", "The mapped query projection is unavailable");
  }
}
