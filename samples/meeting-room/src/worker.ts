import type { ExecuteResult } from "@sekiban/dcb-client";
import {
  createRuntimeWorker,
  AllocatorDurableObject,
  JournalDurableObject,
  TagDurableObject,
  type Env as RuntimeEnv,
} from "@sekiban/dcb-runtime";
import { executeMeetingRoomCommand } from "./transport";
import {
  meetingRoomDomain,
  meetingRoomRuntimeConfig,
  reservationTag,
  roomTag,
} from "./domain";

export { AllocatorDurableObject, JournalDurableObject, TagDurableObject };

export interface MeetingRoomEnv extends RuntimeEnv {
  readonly ASSETS?: Fetcher;
  readonly RUNTIME?: Fetcher;
  readonly CONFORMANCE_TOKEN?: string;
}

const runtime = createRuntimeWorker({ domain: meetingRoomDomain, config: meetingRoomRuntimeConfig });

function invokeRuntime(request: Request, env: MeetingRoomEnv, ctx: ExecutionContext): Promise<Response> {
  const handler = runtime.fetch as unknown as (request: Request, env: MeetingRoomEnv, ctx: ExecutionContext) => Promise<Response>;
  return handler(request, env, ctx);
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
  switch (result.kind) {
    case "committed":
    case "noop":
      return json(body, 200);
    case "rejected":
    case "invalid":
    case "conflict":
      return json({ error: result.error ?? "Command was rejected", code: result.code ?? result.kind, ...body }, result.kind === "conflict" ? 409 : 400);
    case "partial":
      return json({ error: result.error ?? "Commit was partial", code: result.code ?? "partial_write", ...body }, 500);
    case "timeout":
      return json({ error: result.error ?? "Command outcome is undetermined", code: result.code ?? "timeout", ...body }, 504);
    case "unavailable":
      return json({ error: result.error ?? "Projection is unavailable", code: result.code ?? "projection_unavailable", ...body }, 503);
    case "transport":
      return json({ error: result.error ?? "Command transport failed", code: result.code ?? "transport", ...body }, 502);
  }
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
  const runtimeFetcher = env.RUNTIME ?? {
    fetch: (inputValue: RequestInfo | URL, init?: RequestInit) => {
      const inner = inputValue instanceof Request ? inputValue : new Request(inputValue, init);
      return invokeRuntime(inner, env, ctx);
    },
  };
  const response = await runtimeFetcher.fetch("https://runtime.internal/api/sekiban/serialized/tag-state", {
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

async function commandRequest(request: Request, env: MeetingRoomEnv, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Command route requires POST", code: "validation_error" }, 400);
  const commandId = new URL(request.url).pathname.slice("/api/commands/".length);
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return json({ error: "Command request must be JSON", code: "validation_error" }, 400);
  }
  const runtimeFetcher = env.RUNTIME ?? {
    fetch: (inputValue: RequestInfo | URL, init?: RequestInit) => {
      const inner = inputValue instanceof Request ? inputValue : new Request(inputValue, init);
      return invokeRuntime(inner, env, ctx);
    },
  };
  const commandRuntime: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> } = {
    fetch: async (inputValue, init) => runtimeFetcher.fetch(inputValue, init),
  };
  const result = await executeMeetingRoomCommand(commandId, input, {
    RUNTIME: commandRuntime,
    localRuntime: commandRuntime,
  });
  return resultResponse(result);
}

async function conformanceRequest(request: Request, env: MeetingRoomEnv, ctx: ExecutionContext): Promise<Response> {
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
  }, ctx);
}

export function createMeetingRoomWorker(): ExportedHandler<MeetingRoomEnv> {
  return {
    async fetch(request, env, ctx): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (path === "/conformance/v1" || path.startsWith("/conformance/v1/")) {
        return conformanceRequest(request, env, ctx);
      }
      if (path === "/api/sekiban/serialized" || path.startsWith("/api/sekiban/serialized/")) {
        return json({ error: "Raw V1 routes are available only through the authenticated conformance lane", code: "not_found" }, 404);
      }
      if (path === "/api/read/room" || path === "/api/read/reservation") {
        return readApplicationProjection(request, env, ctx);
      }
      if (path.startsWith("/api/commands/")) return commandRequest(request, env, ctx);
      if (env.ASSETS !== undefined) return env.ASSETS.fetch(request);
      if (path === "/" || path === "/index.html") return new Response("Meeting-room sample", { headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response("Not found", { status: 404 });
    },
    async queue(batch, env, ctx): Promise<void> {
      await runtime.queue?.(batch, env, ctx);
    },
    async scheduled(controller, env, ctx): Promise<void> {
      await runtime.scheduled?.(controller, env, ctx);
    },
  };
}

const worker = createMeetingRoomWorker();
export { runtime };
export default worker;
