import type { ExecuteResult } from "@sekiban/dcb-client";
import {
  createCloudflareOnlyRuntimeWorker,
  AllocatorDurableObject,
  BootstrapCoordinatorDurableObject,
  cleanupG42JournalProbeTrial,
  envServiceIdentity,
  GlobalCompletenessReconciler,
  G42_JOURNAL_PROBE_PATH,
  inventoryG42JournalProbeTrial,
  JournalDurableObject,
  measureG42JournalProbeTrial,
  parseG42JournalProbeRequest,
  prepareG42JournalProbeTrial,
  readDirectDoorbellConfig,
  requireServiceIdentity,
  runG42JournalProbeTrial,
  TagDurableObject,
  TagStateDurableObject,
  type G42JournalProbeRequest,
  type GlobalCompletenessCoverage,
} from "@sekiban/dcb-runtime/cloudflare";
import { D1EventStore, D1MaterializedViewStore } from "@sekiban/dcb-runtime/d1";
import { executeMeetingRoomCommand } from "./transport";
import { meetingRoomDeliveryPolicy, meetingRoomDomain, meetingRoomRuntimeConfig, reservationTag, roomTag } from "./domain";
import {
  catchUpMeetingRoomMaterializedViews,
  drainMeetingRoomUnsafeKicks,
  meetingRoomDeliveryViews,
  readMeetingRoomHealth,
  recordMeetingRoomSafeLaneCoverage,
  type MeetingRoomSafeLaneCoverage,
} from "./d1-mv";
import { rejectUnlessPrimaryComponent } from "./worker.g38-component-guard";
import { assertFinalCutoverFenceIfConfigured } from "./worker.cloudflare-receiver-support";
import type { MeetingRoomCloudflareEnv } from "./worker.cloudflare-env";
import { runtimeRequestWithIngressRay } from "./ingress-observation";

export { MeetingRoomDownstreamDoorbell } from "./worker.g38-receiver";
export type { MeetingRoomCloudflareEnv } from "./worker.cloudflare-env";

export { AllocatorDurableObject, BootstrapCoordinatorDurableObject, JournalDurableObject, TagDurableObject, TagStateDurableObject };


const runtime = createCloudflareOnlyRuntimeWorker({
  domain: meetingRoomDomain,
  config: meetingRoomRuntimeConfig,
  afterBootstrapVerify: async ({ serviceId, env }) => catchUpMeetingRoomMaterializedViews(env, serviceId),
  deliveryViews: ({ env }) => meetingRoomDeliveryViews(env),
  beforeLiveProjectionPoll: async ({ env, serviceId }) => {
    // Unit-only D1 fixtures intentionally omit the Tag authority. Preserve
    // their original unrestricted local catch-up seam; deployed primaries
    // always bind TAG and take the fresh-reconcile path below.
    if (env.TAG === undefined) {
      await runMeetingRoomScheduledMaintenance({
        catchUp: (frontierSuid) => catchUpMeetingRoomMaterializedViews(env, serviceId, frontierSuid),
        drainUnsafeKicks: (frontierSuid) => drainMeetingRoomUnsafeKicks(env, Date.now(), frontierSuid),
        runGenericScheduledWork: async () => {},
      });
      return { frontierSuid: undefined };
    }
    const coverage = await new GlobalCompletenessReconciler(env.D1, env.TAG).coverage(serviceId, Date.now());
    await runMeetingRoomScheduledMaintenance({
      freshCoverage: async () => coverage,
      catchUp: (frontierSuid) => catchUpMeetingRoomMaterializedViews(env, serviceId, frontierSuid),
      drainUnsafeKicks: (frontierSuid) => drainMeetingRoomUnsafeKicks(env, Date.now(), frontierSuid),
      // The runtime invokes pollLiveProjections immediately after this hook;
      // no second generic scanner or poll is started by the safe-lane pass.
      runGenericScheduledWork: async () => {},
      recordCoverage: async (safeLaneCoverage) => recordMeetingRoomSafeLaneCoverage(env, serviceId, safeLaneCoverage),
    });
    return { frontierSuid: coverage.frontierSuid };
  },
});
const runtimeFetch = runtime.fetch as unknown as (request: Request, env: MeetingRoomCloudflareEnv, ctx: ExecutionContext) => Promise<Response>;

// P1 is deliberately the smallest possible custom-span control: one span,
// one application attribute, at the public Worker fetch boundary. It is not a
// commit trace row and does not participate in any request or response data.
const G51_P1_PROBE_SPAN = "sdt.g51.probe.p1";
const G51_PROBE_ATTRIBUTE = "sdt.g51.probe";

/**
 * Safe MV convergence runs from an already-computed coverage decision. The
 * freshCoverage seam is used by the deployed Worker after the current G44
 * reconciliation; the older globalCoverage seam remains for unit-only callers
 * that supply a persisted decision directly.
 */
export async function runMeetingRoomScheduledMaintenance(input: {
  readonly catchUp: (frontierSuid?: string | null) => Promise<void>;
  readonly drainUnsafeKicks: (frontierSuid?: string | null) => Promise<void>;
  readonly runGenericScheduledWork: () => Promise<void>;
  /**
   * G44's one interim coverage decision.  It is intentionally an internal
   * gate rather than a new public query-response policy.
  */
  readonly globalCoverage?: () => Promise<"SETTLED" | "BLOCK/UNSETTLED" | GlobalCompletenessCoverage>;
  /** A fresh reconciliation result, computed before this safe-lane pass. */
  readonly freshCoverage?: () => Promise<GlobalCompletenessCoverage>;
  /** Records the decision that governed this scheduled safe-lane pass. */
  readonly recordCoverage?: (coverage: MeetingRoomSafeLaneCoverage) => Promise<void>;
}): Promise<void> {
  if (input.freshCoverage !== undefined) {
    const coverage = await input.freshCoverage();
    await input.recordCoverage?.({
      kind: coverage.kind,
      reason: coverage.reason,
      partitionTag: coverage.partitionTag,
      frontierSuid: coverage.frontierSuid,
      observedAt: coverage.observedAt,
    });
    // The caller has just completed this tick's scanner. A FULL/SETTLED
    // frontier is therefore immediately eligible; a BLOCK frontier is the
    // last proven cursor retained by the reconciler and remains fenced.
    await input.catchUp(coverage.frontierSuid);
    await input.drainUnsafeKicks(coverage.frontierSuid);
    await input.runGenericScheduledWork();
    return;
  }
  if (input.globalCoverage !== undefined) {
    const coverage = await input.globalCoverage();
    if (typeof coverage === "string") {
      // Compatibility for the original unit-only seam: a bare BLOCK decision
      // carries no durable FULL frontier, so it cannot safely advance any
      // source checkpoint. Deployed maintenance always supplies the richer
      // reconciler result below.
      if (coverage !== "SETTLED") {
        await input.runGenericScheduledWork();
        return;
      }
    } else {
      await input.recordCoverage?.({
        kind: coverage.kind,
        reason: coverage.reason,
        partitionTag: coverage.partitionTag,
        frontierSuid: coverage.frontierSuid,
        observedAt: coverage.observedAt,
      });
      // A BLOCK tick still drains work that a prior FULL scan proved
      // contiguous. `null` permits no source advancement; it is not an
      // unrestricted empty frontier.
      await input.catchUp(coverage.frontierSuid);
      await input.drainUnsafeKicks(coverage.frontierSuid);
      await input.runGenericScheduledWork();
      return;
    }
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

/** Every sample path resolves deployment identity through the runtime seam. */
function serviceIdentity(env: MeetingRoomCloudflareEnv): string {
  return requireServiceIdentity(envServiceIdentity(env));
}

function optionalServiceIdentity(env: MeetingRoomCloudflareEnv): string | null {
  try {
    return serviceIdentity(env);
  } catch {
    return null;
  }
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
    // The app list explicitly opts into the immediate read lane. Raw V1 list
    // callers remain safe by default and cannot inherit this route policy.
    queryParams = { PageNumber: pageNumber, PageSize: pageSize, consistency: "unsafe", ...(newestFirst === "true" ? { NewestFirst: true } : {}) };
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
  // `runtimeFetch` is an in-isolate call, so its synthetic Request does not
  // inherit the public ingress CF-Ray.  Preserve that provider-owned identity
  // only for observation: CommitWorker uses it to emit the existing
  // post-admission worker observation, which is the exact join from a public
  // command response to its custom-span root.  It is neither a protocol input
  // nor a response/header mutation.
  const ingressRay = request.headers.get("cf-ray");
  const commandRuntime = {
    fetch: (inputValue: RequestInfo | URL, init?: RequestInit) =>
      runtimeFetch(runtimeRequestWithIngressRay(inputValue, init, ingressRay), env, ctx),
  };
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
      const serviceId = serviceIdentity(env);
      if (g42.value.action === "trial") {
        return json(await runG42JournalProbeTrial(env.JOURNAL, serviceId, g42.value, callerColo(request)));
      }
      if (g42.value.action === "prepare") {
        return json(await prepareG42JournalProbeTrial(env.JOURNAL, serviceId, g42.value));
      }
      if (g42.value.action === "measure") {
        return json(await measureG42JournalProbeTrial(env.JOURNAL, serviceId, g42.value, callerColo(request)));
      }
      if (g42.value.action === "cleanup") {
        return json(await cleanupG42JournalProbeTrial(env.JOURNAL, serviceId, g42.value));
      }
      return json(await inventoryG42JournalProbeTrial(env.JOURNAL, serviceId, g42.value));
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
  if (url.pathname === "/conformance/v1/g53-scope-mismatch") {
    const configured = serviceIdentity(env);
    const mismatchedServiceId = configured === "g53-mismatch" ? "g53-other" : "g53-mismatch";
    return runtimeFetch(new Request(`https://runtime.internal/bootstrap/${encodeURIComponent(mismatchedServiceId)}/state`), env, ctx);
  }
  if (url.pathname === "/conformance/v1/read-health") {
    if (request.method !== "GET") {
      return json({ error: "Read health requires GET", code: "validation_error" }, 405);
    }
    const configured = optionalServiceIdentity(env);
    if (configured === null) {
      return json({ error: "Read health bindings are unavailable", code: "projection_unavailable" }, 503);
    }
    try {
      return json(await readMeetingRoomHealth(env, configured));
    } catch {
      return json({ error: "Read health storage is unavailable", code: "projection_unavailable" }, 503);
    }
  }
  if (url.pathname === "/conformance/v1/internal/projection/lag") {
    // Keep the existing internal projection-lag semantics and storage
    // authority, but make the deployed proof bearer-gated like the G58
    // health surface. This does not create a public query policy.
    const target = new URL("https://runtime.internal/internal/projection/lag");
    target.search = url.search;
    return runtimeFetch(new Request(target.toString(), request), env, ctx);
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
      serviceId: optionalServiceIdentity(env),
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
      serviceId: optionalServiceIdentity(env),
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
      serviceId: optionalServiceIdentity(env),
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
    if (env.D1 === undefined || env.D1_MV === undefined) {
      return json({ error: "G32 new-store bindings are unavailable", code: "g32_store_unavailable" }, 503);
    }
    const serviceId = optionalServiceIdentity(env);
    if (serviceId === null) {
      return json({ error: "G32 new-store bindings are unavailable", code: "g32_store_unavailable" }, 503);
    }
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
    if (env.D1 === undefined || env.D1_MV === undefined) {
      return json({ error: "G31 wait-state bindings are unavailable", code: "projection_unavailable" }, 503);
    }
    // This authenticated diagnostic reads the same two point-lookup ports as
    // the list-query wait. It deliberately fixes the opted-in list view so a
    // witness cannot turn arbitrary request data into a storage selector.
    const source = new D1EventStore(env.D1);
    const views = new D1MaterializedViewStore(env.D1_MV);
    await Promise.all([source.initialize(), views.initialize()]);
    const serviceId = optionalServiceIdentity(env);
    if (serviceId === null) {
      return json({ error: "G31 wait-state bindings are unavailable", code: "projection_unavailable" }, 503);
    }
    const target = await source.readWaitForTarget(serviceId, suid);
    const state = await views.readWaitForState(serviceId, "ReservationProjector", {
      ...(target.kind === "stored" ? { eventId: target.eventId } : {}),
      suid,
    });
    return json({
      task: "SDT-G31",
      serviceId,
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
    if (path.startsWith("/api/commands/")) {
      const componentReject = rejectUnlessPrimaryComponent(env, "command");
      if (componentReject !== undefined) return componentReject;
      return ctx.tracing.enterSpan(G51_P1_PROBE_SPAN, (span) => {
        span.setAttribute(G51_PROBE_ATTRIBUTE, "p1");
        return command(request, env, ctx);
      });
    }
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
    // The runtime reconciles G44 first, then invokes the sample's safe-lane
    // hook with that fresh coverage, and finally polls live projections in the
    // same scheduled tick. Keeping this call direct avoids an extra stale
    // frontier pass before the fresh reconciliation.
    await runtime.scheduled?.(controller, env, ctx);
  },
};

export default worker;
