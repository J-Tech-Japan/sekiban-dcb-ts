import type { ExecuteResult } from "@sekiban/dcb-client";
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  createCloudflareOnlyRuntimeWorker,
  AllocatorDurableObject,
  BootstrapCoordinatorDurableObject,
  JournalDurableObject,
  processDownstreamDoorbell,
  readDirectDoorbellConfig,
  selectDirectDoorbellViews,
  TagDurableObject,
  type CloudflareOnlyEnv,
  type DeliveryCoreOptions,
} from "@sekiban/dcb-runtime/cloudflare";
import { createD1StoreProvider, D1EventStore, D1MaterializedViewStore } from "@sekiban/dcb-runtime/d1";
import { executeMeetingRoomCommand } from "./transport";
import { meetingRoomDeliveryPolicy, meetingRoomDomain, meetingRoomRuntimeConfig, reservationTag, roomTag } from "./domain";
import { catchUpMeetingRoomMaterializedViews, drainMeetingRoomUnsafeKicks, meetingRoomDeliveryViews } from "./d1-mv";

export { AllocatorDurableObject, BootstrapCoordinatorDurableObject, JournalDurableObject, TagDurableObject };

export interface MeetingRoomCloudflareEnv extends CloudflareOnlyEnv {
  readonly ASSETS?: Fetcher;
  readonly CONFORMANCE_TOKEN?: string;
  readonly G29_SOURCE_COMMIT?: string;
  /** Sealed SDT-G31 source identity exposed only to the authenticated witness. */
  readonly G31_SOURCE_COMMIT?: string;
  /** In-process integration seam; never configured by a deployed Worker. */
  readonly __G29_DOORBELL_TEST__?: Pick<DeliveryCoreOptions, "store" | "views" | "afterDelivery"> & {
    readonly deliveryPolicy?: Readonly<Record<string, "immediate-preferred" | "queued">>;
  };
}

/**
 * Separate non-public receiver entrypoint. It is deployed as the target of a
 * service binding; the primary Worker never exposes this method through fetch.
 */
export class MeetingRoomDownstreamDoorbell extends WorkerEntrypoint<MeetingRoomCloudflareEnv> {
  async deliver(message: unknown) {
    const testOverrides = this.env.__G29_DOORBELL_TEST__;
    const config = readDirectDoorbellConfig(this.env as unknown as Record<string, unknown>, meetingRoomRuntimeConfig.deliveryClass, testOverrides?.deliveryPolicy ?? meetingRoomDeliveryPolicy);
    const configuredViews = testOverrides?.views ?? meetingRoomDeliveryViews(this.env);
    const result = await processDownstreamDoorbell(message, this.env, {
      ...(testOverrides?.store === undefined ? { storeProvider: createD1StoreProvider() } : { store: testOverrides.store }),
      views: selectDirectDoorbellViews(configuredViews, config),
      afterDelivery: testOverrides?.afterDelivery ?? (async () => {
        this.ctx.waitUntil(drainMeetingRoomUnsafeKicks(this.env));
      }),
    });
    console.log("direct_doorbell_core", {
      correlationId: result.correlationId,
      coreDurationMs: result.coreDurationMs,
      viewDurationsMs: result.views.map((view) => ({ id: view.id, durationMs: view.durationMs, status: view.status })),
      disposition: result.fastDisposition,
    });
    return result;
  }
}

const runtime = createCloudflareOnlyRuntimeWorker({
  domain: meetingRoomDomain,
  config: meetingRoomRuntimeConfig,
  afterBootstrapVerify: async ({ serviceId, env }) => catchUpMeetingRoomMaterializedViews(env, serviceId),
  deliveryViews: ({ env }) => meetingRoomDeliveryViews(env),
  afterStoredDownstreamDelivery: async ({ env, ctx }) => {
    // The durable kick lease collapses many waitUntil calls to one owner.  A
    // drain failure is intentionally not allowed to turn the already-applied
    // Queue message into an acknowledgement decision.
    ctx.waitUntil(drainMeetingRoomUnsafeKicks(env));
  },
});
const runtimeFetch = runtime.fetch as unknown as (request: Request, env: MeetingRoomCloudflareEnv, ctx: ExecutionContext) => Promise<Response>;

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

function positiveInteger(value: string | null, name: string, fallback: number): number | Response {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return json({ error: `${name} must be a positive integer`, code: "validation_error" }, 400);
  return parsed;
}

async function readProjection(request: Request, env: MeetingRoomCloudflareEnv, ctx: ExecutionContext): Promise<Response> {
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
  const response = await runtimeFetch(new Request("https://runtime.internal/api/sekiban/serialized/tag-state", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ tagStateId: `${tag.id}:${tagProjector}` }),
  }), env, ctx);
  let body: unknown;
  try { body = await response.json(); } catch { return json({ error: `Projection read returned HTTP ${response.status}`, code: "transport" }, 502); }
  if (response.status < 200 || response.status >= 300) return json(body, response.status);
  if (typeof body !== "object" || body === null || Array.isArray(body)) return json({ error: "Projection read returned an invalid body", code: "transport" }, 502);
  const record = body as Record<string, unknown>;
  if (typeof record.lastSortedUniqueId !== "string") return json({ error: "Projection read omitted lastSortedUniqueId", code: "transport" }, 502);
  return json({ projection: isRoom ? "room" : "reservation", [parameter]: value, tagStateId: `${tag.id}:${tagProjector}`, state: decodeProjectionPayload(record.payload), version: record.version, lastSortedUniqueId: record.lastSortedUniqueId });
}

async function readQuery(request: Request, env: MeetingRoomCloudflareEnv, ctx: ExecutionContext): Promise<Response> {
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
    if (newestFirst !== null && newestFirst !== "true" && newestFirst !== "false") return json({ error: "newestFirst must be true or false", code: "validation_error" }, 400);
    const requestedWait = url.searchParams.get("waitForSortableUniqueId");
    if (requestedWait !== null && requestedWait.length === 0) return json({ error: "waitForSortableUniqueId must be non-empty", code: "validation_error" }, 400);
    waitForSortableUniqueId = requestedWait ?? undefined;
    queryParams = { PageNumber: pageNumber, PageSize: pageSize, ...(newestFirst === "true" ? { NewestFirst: true } : {}) };
  } else {
    const roomId = url.searchParams.get("roomId");
    queryParams = roomId === null || roomId.length === 0 ? {} : { roomId };
  }
  const response = await runtimeFetch(new Request(`https://runtime.internal/api/sekiban/serialized/${isReservations ? "list-query" : "query"}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      queryType: isReservations ? "GetReservationListQuery" : "GetRoomStateQuery",
      queryParamsJson: JSON.stringify(queryParams),
      ...(waitForSortableUniqueId === undefined ? {} : { waitForSortableUniqueId }),
    }),
  }), env, ctx);
  let body: unknown;
  try { body = await response.json(); } catch { return json({ error: `Query read returned HTTP ${response.status}`, code: "transport" }, 502); }
  return json(body, response.status);
}

async function command(request: Request, env: MeetingRoomCloudflareEnv, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Command route requires POST", code: "validation_error" }, 400);
  const commandId = new URL(request.url).pathname.slice("/api/commands/".length);
  let input: unknown;
  try { input = await request.json(); } catch { return json({ error: "Command request must be JSON", code: "validation_error" }, 400); }
  const commandRuntime = { fetch: (inputValue: RequestInfo | URL, init?: RequestInit) => runtimeFetch(inputValue instanceof Request ? inputValue : new Request(inputValue, init), env, ctx) };
  const result = await executeMeetingRoomCommand(commandId, input, { RUNTIME: commandRuntime, localRuntime: commandRuntime });
  return resultResponse(result);
}

async function conformance(request: Request, env: MeetingRoomCloudflareEnv, ctx: ExecutionContext): Promise<Response> {
  const supplied = request.headers.get("authorization");
  if (env.CONFORMANCE_TOKEN === undefined || supplied !== `Bearer ${env.CONFORMANCE_TOKEN}`) return json({ error: "Conformance authentication required", code: "unauthorized" }, 403);
  const url = new URL(request.url);
  if (url.pathname === "/conformance/v1/g26-config") {
    const config = readDirectDoorbellConfig(env as unknown as Record<string, unknown>, meetingRoomRuntimeConfig.deliveryClass, meetingRoomDeliveryPolicy);
    return json({
      task: "SDT-G26",
      viewCount: Number(env.G26_VIEW_COUNT ?? "2"),
      allowedViews: config.allowedViews,
      domainDeliveryClass: meetingRoomRuntimeConfig.deliveryClass,
      resolvedDeliveryClass: config.deliveryClass,
      domainViewDeliveryClasses: config.domainViewDeliveryClasses,
      directDoorbell: config.enabled,
      receiverMode: config.receiverMode,
      degradation: config.degradation,
      maxServiceBindingInvocations: config.maxServiceBindingInvocations,
    });
  }
  if (url.pathname === "/conformance/v1/g29-config") {
    const config = readDirectDoorbellConfig(env as unknown as Record<string, unknown>, meetingRoomRuntimeConfig.deliveryClass, meetingRoomDeliveryPolicy);
    return json({
      task: "SDT-G29",
      worker: "sekiban-dcb-meeting-room-cloudflare-only",
      sourceCommit: env.G29_SOURCE_COMMIT ?? null,
      serviceId: env.SDT_SERVICE_ID,
      viewCount: Number(env.G26_VIEW_COUNT ?? "2"),
      allowedViews: config.allowedViews,
      domainDeliveryClass: meetingRoomRuntimeConfig.deliveryClass,
      domainViewDeliveryClasses: config.domainViewDeliveryClasses,
      resolvedDeliveryClass: config.deliveryClass,
      directDoorbell: config.enabled,
      receiverMode: config.receiverMode,
      degradation: config.degradation,
      maxServiceBindingInvocations: config.maxServiceBindingInvocations,
      pipelineDatabaseId: "3c3b1641-7969-4d72-97a9-2ea65085c9bb",
      materializedViewDatabaseId: "5db45136-f1dd-4f4d-bfe3-b6328193a1ac",
      queue: "sekiban-dcb-meeting-room-cloudflare-outbox",
      generation: "v2",
    });
  }
  if (url.pathname === "/conformance/v1/g31-config") {
    const config = readDirectDoorbellConfig(env as unknown as Record<string, unknown>, meetingRoomRuntimeConfig.deliveryClass, meetingRoomDeliveryPolicy);
    return json({
      task: "SDT-G31",
      worker: "sekiban-dcb-meeting-room-cloudflare-only",
      sourceCommit: env.G31_SOURCE_COMMIT ?? null,
      serviceId: env.SDT_SERVICE_ID,
      pipelineDatabaseId: "3c3b1641-7969-4d72-97a9-2ea65085c9bb",
      materializedViewDatabaseId: "5db45136-f1dd-4f4d-bfe3-b6328193a1ac",
      queue: "sekiban-dcb-meeting-room-cloudflare-outbox",
      generation: "v2",
      waitFor: {
        sourceTarget: "unique-indexed-point-read",
        activeReceipt: "generation-definition-bound",
        safeHead: "unique-source-required",
        maxPointReads: 254,
      },
      directDoorbell: config.enabled,
      allowedViews: config.allowedViews,
    });
  }
  if (url.pathname === "/conformance/v1/g31-wait-state") {
    const suid = url.searchParams.get("suid");
    if (suid === null || suid.length === 0) {
      return json({ error: "suid is required", code: "validation_error" }, 400);
    }
    if (env.D1 === undefined || env.D1_MV === undefined || env.SDT_SERVICE_ID === undefined) {
      return json({ error: "G31 wait-state bindings are unavailable", code: "projection_unavailable" }, 503);
    }
    // This authenticated diagnostic reads the same two point-lookup ports as
    // the list-query wait. It deliberately fixes the opted-in list view so a
    // witness cannot turn arbitrary request data into a storage selector.
    const source = new D1EventStore(env.D1);
    const views = new D1MaterializedViewStore(env.D1_MV);
    await Promise.all([source.initialize(), views.initialize()]);
    const target = await source.readWaitForTarget(env.SDT_SERVICE_ID, suid);
    const state = await views.readWaitForState(env.SDT_SERVICE_ID, "ReservationProjector", {
      ...(target.kind === "stored" ? { eventId: target.eventId } : {}),
      suid,
    });
    return json({
      task: "SDT-G31",
      serviceId: env.SDT_SERVICE_ID,
      viewId: "ReservationProjector",
      target,
      state,
    });
  }
  url.pathname = url.pathname.slice("/conformance/v1".length) || "/";
  return runtimeFetch(new Request(url.toString(), request), { ...env, G11_VERIFICATION_ENABLED: "true" }, ctx);
}

async function bootstrapOperator(request: Request, env: MeetingRoomCloudflareEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url); const headers = new Headers(); const authorization = request.headers.get("authorization");
  if (authorization !== null) headers.set("authorization", authorization);
  if (request.method !== "GET") headers.set("content-type", "application/json");
  return runtimeFetch(new Request(`https://runtime.internal${url.pathname}`, request.method === "GET" ? { method: "GET", headers } : { method: request.method, headers, body: await request.text() }), env, ctx);
}

const worker: ExportedHandler<MeetingRoomCloudflareEnv> = {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/conformance/v1" || path.startsWith("/conformance/v1/")) return conformance(request, env, ctx);
    if (path.startsWith("/operator/bootstrap/")) return bootstrapOperator(request, env, ctx);
    if (path === "/api/sekiban/serialized" || path.startsWith("/api/sekiban/serialized/")) return json({ error: "Raw V1 routes are available only through the authenticated conformance lane", code: "not_found" }, 404);
    if (path === "/api/read/room" || path === "/api/read/reservation") return readProjection(request, env, ctx);
    if (path === "/api/read/reservations" || path === "/api/read/room-query") return readQuery(request, env, ctx);
    if (path.startsWith("/api/commands/")) return command(request, env, ctx);
    if (env.ASSETS !== undefined) return env.ASSETS.fetch(request);
    if (path === "/" || path === "/index.html") return new Response("Meeting-room sample", { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response("Not found", { status: 404 });
  },
  async queue(batch, env, ctx) { await runtime.queue?.(batch, env, ctx); },
  async scheduled(controller, env, ctx) {
    await runtime.scheduled?.(controller, env, ctx);
    await catchUpMeetingRoomMaterializedViews(env);
    await drainMeetingRoomUnsafeKicks(env);
  },
};

export default worker;
