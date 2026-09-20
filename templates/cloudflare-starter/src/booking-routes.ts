import { ClientError, createSekibanExecutor, type ExecuteResult } from "@sekiban/dcb-client";
import {
  createV1Transport,
  executeBookingCommand,
  parseBookingCommandRequest,
  type InternalRuntimeFetcher,
} from "./booking-transport";
import { reservationTag, roomTag } from "./booking-domain";

export interface StarterEnvironment {
  readonly ASSETS?: Fetcher;
  readonly SDT_SERVICE_ID: string;
}

export interface StarterRuntime {
  readonly fetch: (request: Request, env: StarterEnvironment, ctx: ExecutionContext) => Promise<Response>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function runtimeFetcher(runtime: StarterRuntime, env: StarterEnvironment, ctx: ExecutionContext): InternalRuntimeFetcher {
  return {
    fetch: (input, init) => runtime.fetch(new Request(input, init), env, ctx),
  };
}

function resultBody(result: ExecuteResult): Record<string, unknown> {
  const body = { ...result } as Record<string, unknown>;
  delete body.cause;
  return body;
}

function resultResponse(result: ExecuteResult): Response {
  const body = resultBody(result);
  switch (result.kind) {
    case "committed":
    case "noop":
      return json(body);
    case "conflict":
      return json({ error: result.error ?? "Command conflicted", code: result.code ?? result.kind, ...body }, 409);
    case "rejected":
    case "invalid":
      return json({ error: result.error ?? "Command was rejected", code: result.code ?? result.kind, ...body }, 400);
    case "partial":
      return json({ error: result.error ?? "Commit was partial", code: result.code ?? result.kind, ...body }, 500);
    case "timeout":
      return json({ error: result.error ?? "Command outcome is undetermined", code: result.code ?? result.kind, ...body }, 504);
    case "unavailable":
      return json({ error: result.error ?? "Projection is unavailable", code: result.code ?? result.kind, ...body }, 503);
    case "transport":
      return json({ error: result.error ?? "Command transport failed", code: result.code ?? result.kind, ...body }, 502);
  }
}

async function command(request: Request, env: StarterEnvironment, ctx: ExecutionContext, runtime: StarterRuntime): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Command route requires POST", code: "validation_error" }, 405);
  const commandId = new URL(request.url).pathname.slice("/api/commands/".length);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Command request must be JSON", code: "validation_error" }, 400);
  }
  try {
    const parsed = parseBookingCommandRequest(body);
    const result = await executeBookingCommand(commandId, parsed.input, {
      RUNTIME: runtimeFetcher(runtime, env, ctx),
      serviceId: env.SDT_SERVICE_ID,
    }, parsed.options);
    return resultResponse(result);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Command request was invalid", code: "validation_error" }, 400);
  }
}

function decodePayload(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    try { return JSON.parse(value); } catch { return value; }
  }
}

async function readProjection(request: Request, env: StarterEnvironment, ctx: ExecutionContext, runtime: StarterRuntime): Promise<Response> {
  if (request.method !== "GET") return json({ error: "Projection routes require GET", code: "validation_error" }, 405);
  const url = new URL(request.url);
  const isRoom = url.pathname === "/api/read/room";
  const isReservation = url.pathname === "/api/read/reservation";
  const parameter = isRoom ? "roomId" : "reservationId";
  const value = url.searchParams.get(parameter);
  if (!isRoom && !isReservation) return json({ error: "Projection route was not found", code: "not_found" }, 404);
  if (value === null || value.length === 0) return json({ error: `${parameter} is required`, code: "validation_error" }, 400);
  const tag = isRoom ? roomTag(value) : reservationTag(value);
  const projector = isRoom ? "RoomProjector" : "ReservationProjector";
  const response = await runtime.fetch(new Request("https://runtime.internal/api/sekiban/serialized/tag-state", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ tagStateId: `${tag.id}:${projector}` }),
  }), env, ctx);
  let body: unknown;
  try { body = await response.json(); } catch { return json({ error: "Projection read returned invalid JSON", code: "transport" }, 502); }
  if (!response.ok) return json(body, response.status);
  if (typeof body !== "object" || body === null || Array.isArray(body)) return json({ error: "Projection read returned an invalid body", code: "transport" }, 502);
  const record = body as Record<string, unknown>;
  return json({ projection: isRoom ? "room" : "reservation", [parameter]: value, tagStateId: `${tag.id}:${projector}`, state: decodePayload(record.payload), version: record.version, lastSortableUniqueId: record.lastSortableUniqueId });
}

function positiveInteger(value: string | null, fallback: number): number | Response {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return json({ error: "page values must be positive integers", code: "validation_error" }, 400);
  return parsed;
}

async function readQuery(request: Request, env: StarterEnvironment, ctx: ExecutionContext, runtime: StarterRuntime): Promise<Response> {
  if (request.method !== "GET") return json({ error: "Query routes require GET", code: "validation_error" }, 405);
  const url = new URL(request.url);
  const reservations = url.pathname === "/api/read/reservations";
  const rooms = url.pathname === "/api/read/room-query";
  if (!reservations && !rooms) return json({ error: "Query route was not found", code: "not_found" }, 404);
  const transport = createV1Transport(runtimeFetcher(runtime, env, ctx), env.SDT_SERVICE_ID);
  const executor = createSekibanExecutor(transport, { serviceId: env.SDT_SERVICE_ID });
  try {
    if (reservations) {
      const pageNumber = positiveInteger(url.searchParams.get("pageNumber"), 1);
      const pageSize = positiveInteger(url.searchParams.get("pageSize"), 20);
      if (pageNumber instanceof Response) return pageNumber;
      if (pageSize instanceof Response) return pageSize;
      const result = await executor.listQuery({
        queryType: "GetReservationListQuery",
        queryParamsJson: JSON.stringify({ PageNumber: pageNumber, PageSize: pageSize, NewestFirst: url.searchParams.get("newestFirst") === "true" }),
      }, { consistency: "unsafe" });
      return json(result);
    }
    const result = await executor.query({
      queryType: "GetRoomStateQuery",
      queryParamsJson: JSON.stringify({ roomId: url.searchParams.get("roomId") ?? undefined }),
    });
    return json(result);
  } catch (error) {
    if (error instanceof ClientError) return json({ error: error.message, code: error.code }, error.status ?? 502);
    return json({ error: "Query read failed", code: "transport" }, 502);
  }
}

export async function applicationFetch(request: Request, env: StarterEnvironment, ctx: ExecutionContext, runtime: StarterRuntime): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/api/commands/")) return command(request, env, ctx, runtime);
  if (path === "/api/read/room" || path === "/api/read/reservation") return readProjection(request, env, ctx, runtime);
  if (path === "/api/read/reservations" || path === "/api/read/room-query") return readQuery(request, env, ctx, runtime);
  if (env.ASSETS !== undefined) return env.ASSETS.fetch(request);
  if (path === "/" || path === "/index.html") return new Response("Booking starter", { headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response("Not found", { status: 404 });
}
