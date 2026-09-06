import type { ExecuteResult } from "@sekiban/dcb-client";
import {
  createRuntimeWorker,
  AllocatorDurableObject,
  JournalDurableObject,
  TagDurableObject,
  TagStateDurableObject,
  type Env as RuntimeEnv,
} from "@sekiban/dcb-runtime";
import { executeMeetingRoomCommand, globalAdmissionStatusFromResult } from "./transport";
import {
  meetingRoomDomain,
  meetingRoomRuntimeConfig,
  reservationTag,
  roomTag,
} from "./domain";

export { AllocatorDurableObject, JournalDurableObject, TagDurableObject, TagStateDurableObject };

export interface MeetingRoomEnv extends RuntimeEnv {
  readonly ASSETS?: Fetcher;
  readonly RUNTIME?: Fetcher;
  readonly CONFORMANCE_TOKEN?: string;
}

export interface MeetingRoomRuntimeHandler {
  fetch?: (request: Request, env: MeetingRoomEnv, ctx: ExecutionContext) => Response | Promise<Response>;
  queue?: (batch: MessageBatch<unknown>, env: MeetingRoomEnv, ctx: ExecutionContext) => Promise<void>;
  scheduled?: (controller: ScheduledController, env: MeetingRoomEnv, ctx: ExecutionContext) => Promise<void>;
}

export interface MeetingRoomWorkerOptions {
  readonly runtime?: MeetingRoomRuntimeHandler;
  readonly afterScheduled?: (env: MeetingRoomEnv) => Promise<void>;
}

const runtime = createRuntimeWorker({ domain: meetingRoomDomain, config: meetingRoomRuntimeConfig });

function invokeRuntime(
  request: Request,
  env: MeetingRoomEnv,
  ctx: ExecutionContext,
  runtimeHandler: MeetingRoomRuntimeHandler,
): Promise<Response> {
  const handler = runtimeHandler.fetch as unknown as (request: Request, env: MeetingRoomEnv, ctx: ExecutionContext) => Promise<Response>;
  return handler(request, env, ctx);
}

interface RuntimeFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

function runtimeFetcher(env: MeetingRoomEnv, ctx: ExecutionContext, runtimeHandler: MeetingRoomRuntimeHandler): RuntimeFetcher {
  return env.RUNTIME ?? {
    fetch: (inputValue: RequestInfo | URL, init?: RequestInit) => {
      const inner = inputValue instanceof Request ? inputValue : new Request(inputValue, init);
      return invokeRuntime(inner, env, ctx, runtimeHandler);
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function resultBody(result: ExecuteResult): Record<string, unknown> {
  const body = { ...result } as Record<string, unknown>;
  delete body.cause;
  return body;
}

function resultResponse(result: ExecuteResult): Response {
  const body = resultBody(result);
  const admission = globalAdmissionStatusFromResult(result);
  let response: Response;
  switch (result.kind) {
    case "committed":
    case "noop":
      response = json(body, 200);
      break;
    case "rejected":
    case "invalid":
    case "conflict":
      response = json({ error: result.error ?? "Command was rejected", code: result.code ?? result.kind, ...body }, result.kind === "conflict" ? 409 : 400);
      break;
    case "partial":
      response = json({ error: result.error ?? "Commit was partial", code: result.code ?? "partial_write", ...body }, 500);
      break;
    case "timeout":
      response = json({ error: result.error ?? "Command outcome is undetermined", code: result.code ?? "timeout", ...body }, 504);
      break;
    case "unavailable":
      response = json({ error: result.error ?? "Projection is unavailable", code: result.code ?? "projection_unavailable", ...body }, 503);
      break;
    case "transport":
      response = json({ error: result.error ?? "Command transport failed", code: result.code ?? "transport", ...body }, 502);
      break;
  }
  response.headers.set("x-sdt-global-admission", admission === "admitted" || admission === "not-admitted" || admission === "unknown" ? admission : "unknown");
  return response;
}

function decodeProjectionPayload(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return value;
  }
}

async function readApplicationProjection(
  request: Request,
  env: MeetingRoomEnv,
  ctx: ExecutionContext,
  runtimeHandler: MeetingRoomRuntimeHandler,
): Promise<Response> {
  if (request.method !== "GET") return json({ error: "Projection routes require GET", code: "validation_error" }, 400);
  const url = new URL(request.url);
  const isRoom = url.pathname === "/api/read/room";
  const isReservation = url.pathname === "/api/read/reservation";
  if (!isRoom && !isReservation) return json({ error: "Projection route was not found", code: "not_found" }, 404);
  const parameter = isRoom ? "roomId" : "reservationId";
  const value = url.searchParams.get(parameter);
  if (value === null || value.length === 0) return json({ error: `${parameter} is required`, code: "validation_error" }, 400);

  const tag = isRoom ? roomTag(value) : reservationTag(value);
  const tagProjector = isRoom ? "RoomProjector" : "ReservationProjector";
  const response = await runtimeFetcher(env, ctx, runtimeHandler).fetch("https://runtime.internal/api/sekiban/serialized/tag-state", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ tagStateId: `${tag.id}:${tagProjector}` }),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return json({ error: `Projection read returned HTTP ${response.status}`, code: "transport" }, 502);
  }
  if (response.status < 200 || response.status >= 300) return json(body, response.status);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ error: "Projection read returned an invalid body", code: "transport" }, 502);
  }
  const record = body as Record<string, unknown>;
  if (typeof record.lastSortedUniqueId !== "string") {
    return json({ error: "Projection read omitted lastSortedUniqueId", code: "transport" }, 502);
  }
  return json({
    projection: isRoom ? "room" : "reservation",
    [parameter]: value,
    tagStateId: `${tag.id}:${tagProjector}`,
    state: decodeProjectionPayload(record.payload),
    version: record.version,
    lastSortedUniqueId: record.lastSortedUniqueId,
  });
}

function positiveInteger(value: string | null, name: string, fallback: number): number | Response {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return json({ error: `${name} must be a positive integer`, code: "validation_error" }, 400);
  }
  return parsed;
}

async function relayRuntimeJson(response: Response): Promise<Response> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return json({ error: `Query read returned HTTP ${response.status}`, code: "transport" }, 502);
  }
  return json(body, response.status);
}

async function readApplicationQuery(
  request: Request,
  env: MeetingRoomEnv,
  ctx: ExecutionContext,
  runtimeHandler: MeetingRoomRuntimeHandler,
): Promise<Response> {
  if (request.method !== "GET") return json({ error: "Query routes require GET", code: "validation_error" }, 400);
  const url = new URL(request.url);
  const isReservations = url.pathname === "/api/read/reservations";
  const isRoomQuery = url.pathname === "/api/read/room-query";
  if (!isReservations && !isRoomQuery) return json({ error: "Query route was not found", code: "not_found" }, 404);

  let queryParams: Record<string, unknown>;
  let waitForSortableUniqueId: string | undefined;
  if (isReservations) {
    const pageNumber = positiveInteger(url.searchParams.get("pageNumber"), "pageNumber", 1);
    if (pageNumber instanceof Response) return pageNumber;
    const pageSize = positiveInteger(url.searchParams.get("pageSize"), "pageSize", 20);
    if (pageSize instanceof Response) return pageSize;
    const newestFirst = url.searchParams.get("newestFirst");
    if (newestFirst !== null && newestFirst !== "true" && newestFirst !== "false") {
      return json({ error: "newestFirst must be true or false", code: "validation_error" }, 400);
    }
    const requestedWait = url.searchParams.get("waitForSortableUniqueId");
    if (requestedWait !== null && requestedWait.length === 0) {
      return json({ error: "waitForSortableUniqueId must be non-empty", code: "validation_error" }, 400);
    }
    waitForSortableUniqueId = requestedWait ?? undefined;
    // Match the deployed app route: list reads opt in to the immediate lane,
    // while raw runtime callers continue to default to safe-only results.
    queryParams = { PageNumber: pageNumber, PageSize: pageSize, consistency: "unsafe", ...(newestFirst === "true" ? { NewestFirst: true } : {}) };
  } else {
    const roomId = url.searchParams.get("roomId");
    queryParams = roomId === null || roomId.length === 0 ? {} : { roomId };
  }

  const queryType = isReservations ? "GetReservationListQuery" : "GetRoomStateQuery";
  // Construct a fresh internal request. In particular, never copy incoming
  // headers: namespace selectors and conformance credentials are client input.
  const response = await runtimeFetcher(env, ctx, runtimeHandler).fetch("https://runtime.internal/api/sekiban/serialized/" + (isReservations ? "list-query" : "query"), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      queryType,
      queryParamsJson: JSON.stringify(queryParams),
      ...(waitForSortableUniqueId === undefined ? {} : { waitForSortableUniqueId }),
    }),
  });
  return relayRuntimeJson(response);
}

async function commandRequest(request: Request, env: MeetingRoomEnv, ctx: ExecutionContext, runtimeHandler: MeetingRoomRuntimeHandler): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Command route requires POST", code: "validation_error" }, 400);
  const commandId = new URL(request.url).pathname.slice("/api/commands/".length);
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return json({ error: "Command request must be JSON", code: "validation_error" }, 400);
  }
  const runtime = runtimeFetcher(env, ctx, runtimeHandler);
  const commandRuntime: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> } = {
    fetch: async (inputValue, init) => runtime.fetch(inputValue, init),
  };
  const result = await executeMeetingRoomCommand(commandId, input, {
    RUNTIME: commandRuntime,
    localRuntime: commandRuntime,
  });
  return resultResponse(result);
}

async function conformanceRequest(request: Request, env: MeetingRoomEnv, ctx: ExecutionContext, runtimeHandler: MeetingRoomRuntimeHandler): Promise<Response> {
  const expected = env.CONFORMANCE_TOKEN;
  const supplied = request.headers.get("authorization");
  if (expected === undefined || supplied !== `Bearer ${expected}`) {
    return json({ error: "Conformance authentication required", code: "unauthorized" }, 403);
  }
  const url = new URL(request.url);
  url.pathname = url.pathname.slice("/conformance/v1".length) || "/";
  // Only this bearer-authenticated lane may enable deployment verification's
  // fresh g11-* namespace. Public app commands never receive this context.
  return invokeRuntime(new Request(url.toString(), request), {
    ...env,
    G11_VERIFICATION_ENABLED: "true",
  }, ctx, runtimeHandler);
}

/** The operator bearer is the only client header that crosses this boundary. */
async function bootstrapOperatorRequest(request: Request, env: MeetingRoomEnv, ctx: ExecutionContext, runtimeHandler: MeetingRoomRuntimeHandler): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers();
  const authorization = request.headers.get("authorization");
  if (authorization !== null) headers.set("authorization", authorization);
  if (request.method !== "GET") headers.set("content-type", "application/json");
  return runtimeFetcher(env, ctx, runtimeHandler).fetch(new Request(`https://runtime.internal${url.pathname}`, request.method === "GET" ? { method: "GET", headers } : { method: request.method, headers, body: await request.text() }));
}

export function createMeetingRoomWorker(options: MeetingRoomWorkerOptions = {}): ExportedHandler<MeetingRoomEnv> {
  const runtimeHandler = (options.runtime ?? runtime) as unknown as MeetingRoomRuntimeHandler;
  return {
    async fetch(request, env, ctx): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (path === "/conformance/v1" || path.startsWith("/conformance/v1/")) {
        return conformanceRequest(request, env, ctx, runtimeHandler);
      }
      if (path.startsWith("/operator/bootstrap/")) return bootstrapOperatorRequest(request, env, ctx, runtimeHandler);
      if (path === "/api/sekiban/serialized" || path.startsWith("/api/sekiban/serialized/")) {
        return json({ error: "Raw V1 routes are available only through the authenticated conformance lane", code: "not_found" }, 404);
      }
      if (path === "/api/read/room" || path === "/api/read/reservation") {
        return readApplicationProjection(request, env, ctx, runtimeHandler);
      }
      if (path === "/api/read/reservations" || path === "/api/read/room-query") {
        return readApplicationQuery(request, env, ctx, runtimeHandler);
      }
      if (path.startsWith("/api/commands/")) return commandRequest(request, env, ctx, runtimeHandler);
      if (env.ASSETS !== undefined) return env.ASSETS.fetch(request);
      if (path === "/" || path === "/index.html") return new Response("Meeting-room sample", { headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response("Not found", { status: 404 });
    },
    async queue(batch, env, ctx): Promise<void> {
      await runtimeHandler.queue?.(batch, env, ctx);
    },
    async scheduled(controller, env, ctx): Promise<void> {
      await runtimeHandler.scheduled?.(controller, env, ctx);
      await options.afterScheduled?.(env);
    },
  };
}

const worker = createMeetingRoomWorker();
export { runtime };
export default worker;
