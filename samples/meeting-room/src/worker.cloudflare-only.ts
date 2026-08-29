import type { ExecuteResult } from "@sekiban/dcb-client";
import {
  createCloudflareOnlyRuntimeWorker,
  AllocatorDurableObject,
  BootstrapCoordinatorDurableObject,
  cleanupG42JournalProbeTrial,
  GlobalCompletenessReconciler,
  G42_JOURNAL_PROBE_PATH,
  inventoryG42JournalProbeTrial,
  JournalDurableObject,
  measureG42JournalProbeTrial,
  parseG42JournalProbeRequest,
  prepareG42JournalProbeTrial,
  readDirectDoorbellConfig,
  runG42JournalProbeTrial,
  TagDurableObject,
  TagStateDurableObject,
  type G42JournalProbeRequest,
} from "@sekiban/dcb-runtime/cloudflare";
import { D1EventStore, D1MaterializedViewStore } from "@sekiban/dcb-runtime/d1";
import { executeMeetingRoomCommand } from "./transport";
import { meetingRoomDeliveryPolicy, meetingRoomDomain, meetingRoomRuntimeConfig, reservationTag, roomTag } from "./domain";
import { catchUpMeetingRoomMaterializedViews, drainMeetingRoomUnsafeKicks, meetingRoomDeliveryViews } from "./d1-mv";
import { rejectUnlessPrimaryComponent } from "./worker.g38-component-guard";
import { assertFinalCutoverFenceIfConfigured } from "./worker.cloudflare-receiver-support";
import type { MeetingRoomCloudflareEnv } from "./worker.cloudflare-env";

export { MeetingRoomDownstreamDoorbell } from "./worker.g38-receiver";
export type { MeetingRoomCloudflareEnv } from "./worker.cloudflare-env";

export { AllocatorDurableObject, BootstrapCoordinatorDurableObject, JournalDurableObject, TagDurableObject, TagStateDurableObject };


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

/**
 * Safe MV convergence is the first scheduled duty.  Generic downstream and
 * tag-state polling may be expensive on a historical service, but must never
 * starve the receipt-GC path that proves a stored target through safe head.
 */
export async function runMeetingRoomScheduledMaintenance(input: {
  readonly catchUp: () => Promise<void>;
  readonly drainUnsafeKicks: () => Promise<void>;
  readonly runGenericScheduledWork: () => Promise<void>;
  /**
   * G44's one interim coverage decision.  It is intentionally an internal
   * gate rather than a new public query-response policy.
   */
  readonly globalCoverage?: () => Promise<"SETTLED" | "BLOCK/UNSETTLED">;
}): Promise<void> {
  if (input.globalCoverage !== undefined && await input.globalCoverage() !== "SETTLED") {
    // Keep generic scheduled work alive: it owns the independent source scan
    // and can establish a new FULL frontier. Its own live-poll path is gated
    // by that scan, while this materialized catch-up remains blocked here.
    await input.runGenericScheduledWork();
    return;
  }
  await input.catchUp();
  await input.drainUnsafeKicks();
  await input.runGenericScheduledWork();
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

function positiveInteger(value: string | null, name: string, fallback: number): number | Response {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return json({ error: `${name} must be a positive integer`, code: "validation_error" }, 400);
  return parsed;
}

type G42ProbeRouteInput =
  | Readonly<{ kind: "not-g42" }>
  | Readonly<{ kind: "invalid"; error: string }>
  | Readonly<{ kind: "valid"; value: G42JournalProbeRequest }>;

/**
 * This parser deliberately runs before the G32 fence only for G42's one
 * exact conformance endpoint.  It cannot touch a Durable Object; the fence
 * remains mandatory before a valid request is allowed to resolve JOURNAL.
 */
async function g42ProbeRouteInput(request: Request, url: URL): Promise<G42ProbeRouteInput> {
  if (url.pathname !== G42_JOURNAL_PROBE_PATH) return { kind: "not-g42" };
  if (request.method !== "POST") return { kind: "invalid", error: "G42 probe requires POST" };
  if (url.search.length !== 0) return { kind: "invalid", error: "G42 probe query must be empty" };
  if (request.headers.get("content-type") !== "application/json") {
    return { kind: "invalid", error: "G42 probe content-type must be application/json" };
  }
  let body: unknown;
  try {
    body = JSON.parse(await request.text()) as unknown;
  } catch {
    return { kind: "invalid", error: "G42 probe body must be JSON" };
  }
  const parsed = parseG42JournalProbeRequest(body);
  return "value" in parsed
    ? { kind: "valid", value: parsed.value }
    : { kind: "invalid", error: parsed.error };
}

function callerColo(request: Request): string | null {
  const cf = request.cf as unknown as { colo?: unknown } | undefined;
  return typeof cf?.colo === "string" && cf.colo.length > 0 ? cf.colo : null;
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
  const componentReject = rejectUnlessPrimaryComponent(env, "command");
  if (componentReject !== undefined) return componentReject;
  try {
    await assertFinalCutoverFenceIfConfigured(env);
  } catch {
    return json({ error: "G32 cutover fence is unavailable", code: "g32_cutover_fence_invalid" }, 503);
  }
  if (request.method !== "POST") return json({ error: "Command route requires POST", code: "validation_error" }, 400);
  const commandId = new URL(request.url).pathname.slice("/api/commands/".length);
  let input: unknown;
  try { input = await request.json(); } catch { return json({ error: "Command request must be JSON", code: "validation_error" }, 400); }
  const commandRuntime = { fetch: (inputValue: RequestInfo | URL, init?: RequestInit) => runtimeFetch(inputValue instanceof Request ? inputValue : new Request(inputValue, init), env, ctx) };
  const result = await executeMeetingRoomCommand(commandId, input, { RUNTIME: commandRuntime, localRuntime: commandRuntime });
  return resultResponse(result);
}

async function conformance(request: Request, env: MeetingRoomCloudflareEnv, ctx: ExecutionContext): Promise<Response> {
  const componentReject = rejectUnlessPrimaryComponent(env, "conformance");
  if (componentReject !== undefined) return componentReject;
  const supplied = request.headers.get("authorization");
  if (env.CONFORMANCE_TOKEN === undefined || supplied !== `Bearer ${env.CONFORMANCE_TOKEN}`) return json({ error: "Conformance authentication required", code: "unauthorized" }, 403);
  const url = new URL(request.url);
  const g42 = await g42ProbeRouteInput(request, url);
  if (g42.kind === "invalid") {
    // Exact method/path/query/content-type/schema validation deliberately
    // precedes both the cutover fence and Durable Object namespace lookup.
    return json({ error: g42.error, code: "g42_probe_validation_error" }, 400);
  }
  if (g42.kind === "valid") {
    try {
      await assertFinalCutoverFenceIfConfigured(env);
    } catch {
      return json({ error: "G32 cutover fence is unavailable", code: "g32_cutover_fence_invalid" }, 503);
    }
    try {
      if (g42.value.action === "trial") {
        return json(await runG42JournalProbeTrial(env.JOURNAL, g42.value, callerColo(request)));
      }
      if (g42.value.action === "prepare") {
        return json(await prepareG42JournalProbeTrial(env.JOURNAL, g42.value));
      }
      if (g42.value.action === "measure") {
        return json(await measureG42JournalProbeTrial(env.JOURNAL, g42.value, callerColo(request)));
      }
      if (g42.value.action === "cleanup") {
        return json(await cleanupG42JournalProbeTrial(env.JOURNAL, g42.value));
      }
      return json(await inventoryG42JournalProbeTrial(env.JOURNAL, g42.value));
    } catch {
      // Conformance authentication grants diagnostic access but does not make
      // internal Journal error text part of a public/protocol response.
      return json({ error: "G42 Journal probe could not complete", code: "g42_probe_unavailable" }, 503);
    }
  }
  try {
    await assertFinalCutoverFenceIfConfigured(env);
  } catch {
    return json({ error: "G32 cutover fence is unavailable", code: "g32_cutover_fence_invalid" }, 503);
  }
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
  if (url.pathname === "/conformance/v1/g32-config") {
    const config = readDirectDoorbellConfig(env as unknown as Record<string, unknown>, meetingRoomRuntimeConfig.deliveryClass, meetingRoomDeliveryPolicy);
    return json({
      task: "SDT-G32",
      phase: env.G32_CUTOVER_PHASE ?? null,
      sourceCommit: env.G32_SOURCE_COMMIT ?? null,
      worker: "sekiban-dcb-meeting-room-cloudflare-only",
      component: env.G32_COMPONENT ?? null,
      configDigest: env.G32_CONFIG_DIGEST ?? null,
      serviceId: env.SDT_SERVICE_ID ?? null,
      pipelineDatabaseId: env.G32_PIPELINE_DATABASE_ID ?? null,
      materializedViewDatabaseId: env.G32_MATERIALIZED_VIEW_DATABASE_ID ?? null,
      queue: env.G32_QUEUE_NAME ?? null,
      freezeRelease: env.G32_FREEZE_RELEASE ?? null,
      cutoverFenceFingerprint: env.G32_CUTOVER_FENCE_FINGERPRINT ?? null,
      sortableUniqueId: { digits: 30, format: "dotnet-ticks-19-plus-crypto-id-11", legacyUnsupported: true },
      eventRecord: { eventType: "eventPayloadName", payload: "utf8-json-byte-identical", id: "uuid-v7", tags: "family:value-emission-order" },
      directDoorbell: config.enabled,
      allowedViews: config.allowedViews,
      rawV1PublicStatus: 404,
    });
  }
  if (url.pathname === "/conformance/v1/g32-store-state") {
    if (env.D1 === undefined || env.D1_MV === undefined || env.SDT_SERVICE_ID === undefined) {
      return json({ error: "G32 new-store bindings are unavailable", code: "g32_store_unavailable" }, 503);
    }
    const serviceId = env.SDT_SERVICE_ID;
    const [events, ops, legacy, mvRows, mvReceipts] = await Promise.all([
      env.D1.prepare("SELECT COUNT(*) AS count FROM dcb_events WHERE \"ServiceId\" = ?").bind(serviceId).first<{ count: number }>(),
      env.D1.prepare("SELECT COUNT(*) AS count FROM dcb_event_ops WHERE \"ServiceId\" = ?").bind(serviceId).first<{ count: number }>(),
      env.D1.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'serialized_dcb_events'").first<{ name: string }>(),
      env.D1_MV.prepare("SELECT COUNT(*) AS count FROM mv_rows WHERE service_id = ?").bind(serviceId).first<{ count: number }>(),
      env.D1_MV.prepare("SELECT COUNT(*) AS count FROM mv_wait_receipts WHERE service_id = ?").bind(serviceId).first<{ count: number }>(),
    ]);
    return json({
      task: "SDT-G32",
      serviceId,
      eventCount: Number(events?.count ?? 0),
      eventOpsCount: Number(ops?.count ?? 0),
      materializedViewRowCount: Number(mvRows?.count ?? 0),
      materializedViewReceiptCount: Number(mvReceipts?.count ?? 0),
      legacySerializedEventTablePresent: legacy !== null,
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
  const allowedRuntimePaths = new Set([
    "/api/sekiban/serialized/commit",
    "/api/sekiban/serialized/tag-latest-sortable",
    "/api/sekiban/serialized/tag-state",
    "/api/sekiban/serialized/query",
    "/api/sekiban/serialized/list-query",
  ]);
  if (!allowedRuntimePaths.has(url.pathname)) {
    return json({ error: "Conformance route is not allowlisted", code: "conformance_route_not_allowed" }, 404);
  }
  return runtimeFetch(new Request(url.toString(), request), { ...env, G11_VERIFICATION_ENABLED: "true" }, ctx);
}

async function bootstrapOperator(request: Request, env: MeetingRoomCloudflareEnv, ctx: ExecutionContext): Promise<Response> {
  const componentReject = rejectUnlessPrimaryComponent(env, "bootstrap-operator");
  if (componentReject !== undefined) return componentReject;
  try {
    await assertFinalCutoverFenceIfConfigured(env);
  } catch {
    return json({ error: "G32 cutover fence is unavailable", code: "g32_cutover_fence_invalid" }, 503);
  }
  const url = new URL(request.url); const headers = new Headers(); const authorization = request.headers.get("authorization");
  if (authorization !== null) headers.set("authorization", authorization);
  if (request.method !== "GET") headers.set("content-type", "application/json");
  return runtimeFetch(new Request(`https://runtime.internal${url.pathname}`, request.method === "GET" ? { method: "GET", headers } : { method: request.method, headers, body: await request.text() }), env, ctx);
}

async function repairOperator(request: Request, env: MeetingRoomCloudflareEnv, ctx: ExecutionContext): Promise<Response> {
  const componentReject = rejectUnlessPrimaryComponent(env, "repair-operator");
  if (componentReject !== undefined) return componentReject;
  try {
    await assertFinalCutoverFenceIfConfigured(env);
  } catch {
    return json({ error: "G32 cutover fence is unavailable", code: "g32_cutover_fence_invalid" }, 503);
  }
  const headers = new Headers();
  const authorization = request.headers.get("authorization");
  if (authorization !== null) headers.set("authorization", authorization);
  if (request.method !== "GET") headers.set("content-type", "application/json");
  return runtimeFetch(new Request("https://runtime.internal/operator/repair", request.method === "GET" ? { method: "GET", headers } : { method: request.method, headers, body: await request.text() }), env, ctx);
}

const worker: ExportedHandler<MeetingRoomCloudflareEnv> = {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/conformance/v1" || path.startsWith("/conformance/v1/")) return conformance(request, env, ctx);
    if (path.startsWith("/operator/bootstrap/")) return bootstrapOperator(request, env, ctx);
    if (path === "/operator/repair") return repairOperator(request, env, ctx);
    if (path.startsWith("/api/commands/")) return command(request, env, ctx);
    try {
      await assertFinalCutoverFenceIfConfigured(env);
    } catch {
      return json({ error: "G32 cutover fence is unavailable", code: "g32_cutover_fence_invalid" }, 503);
    }
    if (path === "/api/sekiban/serialized" || path.startsWith("/api/sekiban/serialized/")) return json({ error: "Raw V1 routes are available only through the authenticated conformance lane", code: "not_found" }, 404);
    if (path === "/api/read/room" || path === "/api/read/reservation") return readProjection(request, env, ctx);
    if (path === "/api/read/reservations" || path === "/api/read/room-query") return readQuery(request, env, ctx);
    if (env.ASSETS !== undefined) return env.ASSETS.fetch(request);
    if (path === "/" || path === "/index.html") return new Response("Meeting-room sample", { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response("Not found", { status: 404 });
  },
  async queue(batch, env, ctx) {
    await assertFinalCutoverFenceIfConfigured(env);
    await runtime.queue?.(batch, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    await assertFinalCutoverFenceIfConfigured(env);
    await runMeetingRoomScheduledMaintenance({
      catchUp: () => catchUpMeetingRoomMaterializedViews(env),
      drainUnsafeKicks: () => drainMeetingRoomUnsafeKicks(env),
      // A D1-only receiver fixture has no Tag source authority to scan. The
      // deployed primary always binds both authorities; do not manufacture a
      // mixed-version feature switch just to alter that invariant in tests.
      globalCoverage: env.TAG === undefined
        ? undefined
        : async () => (await new GlobalCompletenessReconciler(env.D1, env.TAG).coverage(env.SDT_SERVICE_ID ?? "", Date.now())).kind,
      runGenericScheduledWork: async () => { await runtime.scheduled?.(controller, env, ctx); },
    });
  },
};

export default worker;
