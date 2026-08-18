import {
  DEPLOYED_PROJECTOR_REGISTRY,
  type ProjectorRegistry,
} from "../projection/ProjectorRegistry";
import { safeWindowCeilingExceeded, safeWindowMs } from "../projection/ProjectionRuntime";
import {
  projectionHasObserved,
  readProjectedEntries,
  type ProjectedQueryEntry,
  type QueryProjectionStore,
} from "../query/ProjectionQueryStore";
import {
  DEPLOYED_QUERY_REGISTRY,
  type QueryDefinition,
  type QueryEndpoint,
  type QueryRegistry,
} from "../query/QueryRegistry";
import { PostgresEventStore } from "../store/PostgresEventStore";
import { serviceIdForRequest } from "./testServiceId";

export interface QueryWorkerEnv {
  POSTGRES_URL?: string;
  HYPERDRIVE?: Hyperdrive;
}

export interface QueryExecutionOptions {
  /** A read-only fake store keeps wait and paging tests deterministic. */
  store?: QueryProjectionStore;
  registry?: QueryRegistry;
  projectors?: ProjectorRegistry;
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

function connectionStringFrom(env: QueryWorkerEnv): string {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.POSTGRES_URL;
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error("A Hyperdrive binding or POSTGRES_URL is required for serialized queries");
  }
  return connectionString;
}

function requestStore(env: QueryWorkerEnv): PostgresEventStore {
  // A postgres client is a request-scoped I/O object in workerd. Retaining it
  // across fetch handlers turns a later list-query into a cross-request I/O
  // violation, so the read-only query path intentionally creates one per HTTP
  // request rather than sharing the projection worker's scheduled-poll store.
  return new PostgresEventStore(connectionStringFrom(env));
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
  if (
    typeof currentPage !== "number" || !Number.isSafeInteger(currentPage) || currentPage < 1 ||
    typeof pageSize !== "number" || !Number.isSafeInteger(pageSize) || pageSize < 1
  ) {
    return { error: "PageNumber and PageSize must be positive integers" };
  }
  return { value: { currentPage, pageSize } };
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

function resultResponse(endpoint: QueryEndpoint, entries: readonly ProjectedQueryEntry[], pagination?: Pagination): Response {
  if (endpoint === "query") {
    return json({ resultJson: JSON.stringify({ count: entries.length }) });
  }
  const page = pagination!;
  const offset = (page.currentPage - 1) * page.pageSize;
  const items = entries.slice(offset, offset + page.pageSize).map(decodePayload);
  return json({
    itemsJson: JSON.stringify(items),
    totalCount: entries.length,
    totalPages: entries.length === 0 ? 0 : Math.ceil(entries.length / page.pageSize),
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
  const endpoint = endpointFromPath(new URL(request.url).pathname);
  const serviceId = serviceIdForRequest(request);
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
    const store = options.store ?? requestStore(env);
    if (options.store === undefined) {
      await (store as PostgresEventStore).initialize();
    }
    if (
      parsed.value.waitForSortableUniqueId !== undefined &&
      !(await waitForProjection(store, serviceId, definition, parsed.value.waitForSortableUniqueId, options))
    ) {
      return error(
        504,
        "timeout",
        "Outcome is undetermined: reread tag heads and event/query state before retrying; blind retry may create duplicate events",
      );
    }
    return resultResponse(endpoint, await readProjectedEntries(store, serviceId, definition), pagination.value);
  } catch {
    return error(503, "projection_unavailable", "The mapped query projection is unavailable");
  }
}
