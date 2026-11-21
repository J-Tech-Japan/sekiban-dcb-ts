/**
 * Authenticated materialized-view actions.
 *
 * Seven operator routes under `/operator/materialized-views` map one request
 * to one existing catch-up runtime operation (build/follow/rebuild/promote/
 * break-glass force-reverse) or to a read of existing status/wait facts. The module is provider neutral at
 * import time: each worker composition supplies lazy source, target, and
 * request-identity factories, and none of them is invoked before the
 * operator bearer has been accepted.
 */
import type { MaterializedViewRowMaterializer } from "@sekiban/dcb-core";
import { assertSortableUniqueId } from "../allocator/SortableUniqueId";
import { authenticateOperatorRepair } from "../cli/OperatorRepairCli";
import { compareSuid, type WaitForTargetLookup, type WaitForTargetSourcePort } from "../query/ProjectionQueryStore";
import { scopeIdentityMissingResponse } from "../scope/ControlRouteScope";
import type { ProjectionStore } from "../store/types";
import {
  MaterializedViewCatchUpRuntime,
  MaterializedViewDefinitionVersionMismatchError,
} from "./MaterializedViewCatchUp";
import {
  D1MaterializedViewStore,
  MaterializedViewStoreError,
  normalizeMaterializedViewForceReverseReason,
  type MaterializedViewInstance,
  type MaterializedViewSwitchKind,
} from "./MaterializedViewStore";
import {
  PROJECTION_STATUS_CLUSTER_ID,
  PROJECTION_STATUS_FAULT_MESSAGE,
  formatProjectionStatusUtc,
  mvProjectionStatusIdentity,
  readProjectionStatusEnvelope,
  statusCapability,
} from "./ProjectionStatus";

export const MATERIALIZED_VIEW_ACTIONS_PREFIX = "/operator/materialized-views";

const MAX_ACTION_BODY_BYTES = 4_096;
const MAX_REBUILD_ID_BYTES = 128;

export type MaterializedViewActionName =
  | "ensure-started"
  | "refresh"
  | "prepare"
  | "switch"
  | "force-reverse"
  | "status"
  | "received";

const ACTION_METHODS: Readonly<Record<MaterializedViewActionName, "GET" | "POST">> = Object.freeze({
  "ensure-started": "POST",
  refresh: "POST",
  prepare: "POST",
  switch: "POST",
  "force-reverse": "POST",
  status: "GET",
  received: "GET",
});

/**
 * Grain-shaped runtime status. Members without a Worker equivalent keep a
 * fixed zero/false/null value; generation evidence comes from the target's
 * active instance and the heartbeat is best-effort observation only.
 */
export interface MaterializedViewRuntimeStatus {
  readonly serviceId: string;
  readonly viewName: string;
  readonly viewVersion: number | null;
  readonly started: boolean;
  readonly catchUpInProgress: boolean;
  readonly isCatchUpActive: boolean;
  readonly subscriptionActive: false;
  readonly bufferedEventCount: 0;
  readonly currentPosition: string | null;
  readonly lastReceivedSortableUniqueId: string | null;
  readonly lastError: string | null;
  readonly lastCatchUpStartedAt: null;
  readonly lastCatchUpCompletedAt: string | null;
  readonly lastCatchUpAttemptAt: string | null;
  readonly consecutiveEmptyBatches: 0;
  readonly lastProgressSortableUniqueId: string | null;
  readonly needsImmediateCatchUp: boolean;
  readonly catchUpBatchSkipCount: 0;
  readonly catchUpHalted: boolean;
  readonly generation: number | null;
  readonly generationStatus: MaterializedViewInstance["status"] | null;
  readonly rebuildRequired: boolean;
  readonly isFresh: boolean;
  /** How the active pointer last moved; `legacy` predates migration 0010; null when not started. */
  readonly switchKind: MaterializedViewSwitchKind | null;
  readonly switchReason: string | null;
  readonly switchedAt: string | null;
  /** An open ordering quarantine remains on a non-active generation of this view. */
  readonly leavingGenerationQuarantineOpen: boolean;
}

/** Immutable server registry keyed by exact materializer id. */
export interface MaterializedViewActionRegistry {
  readonly size: number;
  lookup(viewId: string): MaterializedViewRowMaterializer | undefined;
}

/** A source opened for one action request. */
export type MaterializedViewActionSource = ProjectionStore & Partial<WaitForTargetSourcePort> & {
  initialize?(): Promise<void>;
  openProjectionStatusConnection?(): Promise<void>;
  close?(): Promise<void>;
};

export interface MaterializedViewActionDependencies {
  readonly registry: MaterializedViewActionRegistry;
  /** The REPAIR_OPERATOR_TOKEN binding value; checked before anything else. */
  readonly operatorToken: unknown;
  /** Lazy server identity; never invoked before authentication. */
  readonly resolveServiceId: () => string;
  /** Lazy request-owned source factory. */
  readonly createSource: () => MaterializedViewActionSource;
  /** Lazy D1_MV binding lookup. */
  readonly materializedViewDatabase: () => D1Database | undefined;
  /** Defaults to true: the handler closes the source it created. */
  readonly ownsSource?: boolean;
  readonly nowMs?: () => number;
}

/** Copy and index the configured materializers once per worker composition. */
export function createMaterializedViewActionRegistry(
  materializers: readonly MaterializedViewRowMaterializer[] | undefined,
): MaterializedViewActionRegistry {
  if (materializers !== undefined && !Array.isArray(materializers)) {
    throw new Error("materializedViewActions must be an array of row materializers");
  }
  const byId = new Map<string, MaterializedViewRowMaterializer>();
  for (const materializer of [...(materializers ?? [])]) {
    if (
      materializer === null
      || typeof materializer !== "object"
      || typeof materializer.id !== "string"
      || materializer.id.length === 0
      || !Number.isSafeInteger(materializer.version)
      || materializer.version < 0
      || typeof materializer.plan !== "function"
    ) {
      throw new Error("materializedViewActions contains an invalid row materializer");
    }
    if (byId.has(materializer.id)) {
      throw new Error("materializedViewActions contains a duplicate materializer id");
    }
    byId.set(materializer.id, materializer);
  }
  return Object.freeze({
    size: byId.size,
    lookup: (viewId: string) => byId.get(viewId),
  });
}

/** Raw pathname boundary match for the reserved operator prefix. */
export function isMaterializedViewActionPath(pathname: string): boolean {
  return pathname === MATERIALIZED_VIEW_ACTIONS_PREFIX || pathname.startsWith(`${MATERIALIZED_VIEW_ACTIONS_PREFIX}/`);
}

type ParsedInput =
  | { readonly action: "ensure-started" | "refresh" | "status" }
  | { readonly action: "prepare"; readonly rebuildId: string | undefined }
  | { readonly action: "switch"; readonly candidateGeneration: number; readonly expectedActiveGeneration: number | null }
  | {
    readonly action: "force-reverse";
    readonly retainedGeneration: number;
    readonly expectedActiveGeneration: number;
    readonly reason: string;
  }
  | { readonly action: "received"; readonly sortableUniqueId: string };

class InvalidActionRequest extends Error {}

/**
 * Authenticated dispatcher. Authentication is the first statement; the view
 * segment, query, body, identity, and every factory are evaluated only after
 * the exact operator bearer has been accepted.
 */
export async function handleMaterializedViewAction(
  request: Request,
  dependencies: MaterializedViewActionDependencies,
): Promise<Response> {
  const denied = await authenticateOperatorRepair(request, dependencies.operatorToken);
  if (denied !== undefined) return denied;

  const url = new URL(request.url);
  const rest = url.pathname.slice(MATERIALIZED_VIEW_ACTIONS_PREFIX.length);
  const segments = rest.startsWith("/") ? rest.slice(1).split("/") : [];
  if (segments.length !== 2) return notFound();
  const [encodedViewId, actionSegment] = segments as [string, string];
  if (!Object.hasOwn(ACTION_METHODS, actionSegment)) return notFound();
  const action = actionSegment as MaterializedViewActionName;
  if (request.method !== ACTION_METHODS[action]) return notFound();

  let viewId: string;
  try {
    viewId = decodeURIComponent(encodedViewId);
  } catch {
    return invalidRequest();
  }
  if (viewId.length === 0 || viewId.includes("/")) return invalidRequest();
  const materializer = dependencies.registry.lookup(viewId);
  if (materializer === undefined) return notFound();

  let input: ParsedInput;
  try {
    input = await parseActionInput(action, url, request);
  } catch {
    return invalidRequest();
  }

  let serviceId: string;
  try {
    serviceId = dependencies.resolveServiceId();
  } catch {
    return scopeIdentityMissingResponse();
  }

  let source: MaterializedViewActionSource;
  try {
    source = dependencies.createSource();
  } catch {
    return unavailable();
  }
  try {
    if (input.action === "status" && statusCapability(source) === undefined) return unsupported();
    if (input.action === "received" && typeof source.readWaitForTarget !== "function") return unsupported();
    let target: D1MaterializedViewStore;
    try {
      await openSource(source);
      const database = dependencies.materializedViewDatabase();
      if (database === undefined) return unavailable();
      target = new D1MaterializedViewStore(database);
      await target.initialize();
    } catch {
      return unavailable();
    }
    const nowMs = dependencies.nowMs?.() ?? Date.now();
    switch (input.action) {
      case "status":
        return await statusResponse(source, target, serviceId, materializer, nowMs);
      case "received":
        return await receivedResponse(source as MaterializedViewActionSource & WaitForTargetSourcePort, target, serviceId, materializer.id, input.sortableUniqueId);
      default:
        return await actionResponse(input, source, target, serviceId, materializer, nowMs);
    }
  } finally {
    if (dependencies.ownsSource !== false) await closeSource(source);
  }
}

async function parseActionInput(action: MaterializedViewActionName, url: URL, request: Request): Promise<ParsedInput> {
  if (action === "received") {
    const entries: Array<[string, string]> = [];
    url.searchParams.forEach((value, key) => entries.push([key, value]));
    if (entries.length !== 1 || entries[0]![0] !== "sortableUniqueId") throw new InvalidActionRequest();
    const sortableUniqueId = entries[0]![1];
    assertSortableUniqueId(sortableUniqueId);
    await requireEmptyBody(request);
    return { action, sortableUniqueId };
  }
  if (url.search.length > 0) throw new InvalidActionRequest();
  if (action === "status") {
    await requireEmptyBody(request);
    return { action };
  }
  const body = await readBoundedBody(request);
  if (action === "ensure-started" || action === "refresh") {
    if (body.length > 0) {
      const value = parseObject(body);
      if (Object.keys(value).length !== 0) throw new InvalidActionRequest();
    }
    return { action };
  }
  if (action === "prepare") {
    if (body.length === 0) return { action, rebuildId: undefined };
    const value = parseObject(body);
    for (const key of Object.keys(value)) if (key !== "rebuildId") throw new InvalidActionRequest();
    if (!Object.hasOwn(value, "rebuildId")) return { action, rebuildId: undefined };
    const rebuildId = value.rebuildId;
    if (
      typeof rebuildId !== "string"
      || rebuildId.length === 0
      || new TextEncoder().encode(rebuildId).length > MAX_REBUILD_ID_BYTES
    ) {
      throw new InvalidActionRequest();
    }
    return { action, rebuildId };
  }
  if (action === "force-reverse") return parseForceReverse(parseObject(body));
  // switch
  const value = parseObject(body);
  const keys = Object.keys(value);
  if (
    keys.length !== 2
    || !Object.hasOwn(value, "candidateGeneration")
    || !Object.hasOwn(value, "expectedActiveGeneration")
  ) {
    throw new InvalidActionRequest();
  }
  const candidateGeneration = value.candidateGeneration;
  const expectedActiveGeneration = value.expectedActiveGeneration;
  if (!isGeneration(candidateGeneration)) throw new InvalidActionRequest();
  if (expectedActiveGeneration !== null && !isGeneration(expectedActiveGeneration)) throw new InvalidActionRequest();
  return { action: "switch", candidateGeneration, expectedActiveGeneration };
}

/** Exactly three members; reverse-only and reason rules are input errors (400). */
function parseForceReverse(value: Record<string, unknown>): ParsedInput {
  const keys = Object.keys(value);
  if (
    keys.length !== 3
    || !Object.hasOwn(value, "retainedGeneration")
    || !Object.hasOwn(value, "expectedActiveGeneration")
    || !Object.hasOwn(value, "reason")
  ) {
    throw new InvalidActionRequest();
  }
  const retainedGeneration = value.retainedGeneration;
  const expectedActiveGeneration = value.expectedActiveGeneration;
  if (!isGeneration(retainedGeneration) || !isGeneration(expectedActiveGeneration)) throw new InvalidActionRequest();
  if (retainedGeneration >= expectedActiveGeneration) throw new InvalidActionRequest();
  const reason = normalizeMaterializedViewForceReverseReason(value.reason);
  if (reason === undefined) throw new InvalidActionRequest();
  return { action: "force-reverse", retainedGeneration, expectedActiveGeneration, reason };
}

function isGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

async function requireEmptyBody(request: Request): Promise<void> {
  if (request.body === null) return;
  const body = await request.text();
  if (body.length !== 0) throw new InvalidActionRequest();
}

async function readBoundedBody(request: Request): Promise<string> {
  if (request.body === null) return "";
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_ACTION_BODY_BYTES) throw new InvalidActionRequest();
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function parseObject(body: string): Record<string, unknown> {
  const value: unknown = JSON.parse(body);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new InvalidActionRequest();
  return value as Record<string, unknown>;
}

async function openSource(source: MaterializedViewActionSource): Promise<void> {
  // PostgreSQL exposes a connection-only opener; its initialize() runs schema
  // DDL and is never selected here. D1 initialize() is a binding SELECT.
  if (typeof source.openProjectionStatusConnection === "function") {
    await source.openProjectionStatusConnection();
    return;
  }
  if (typeof source.initialize === "function") await source.initialize();
}

async function closeSource(source: MaterializedViewActionSource): Promise<void> {
  if (typeof source.close !== "function") return;
  try {
    await source.close();
  } catch {
    return;
  }
}

async function actionResponse(
  input: Exclude<ParsedInput, { readonly action: "status" | "received" }>,
  source: MaterializedViewActionSource,
  target: D1MaterializedViewStore,
  serviceId: string,
  materializer: MaterializedViewRowMaterializer,
  nowMs: number,
): Promise<Response> {
  const runtime = new MaterializedViewCatchUpRuntime(source, target, { publicationActivationId: "operator" });
  let result: unknown;
  try {
    switch (input.action) {
      case "ensure-started":
        result = await ensureStarted(runtime, target, serviceId, materializer, nowMs);
        break;
      case "refresh":
        result = await runtime.follow(serviceId, materializer, nowMs);
        break;
      case "prepare":
        result = await runtime.rebuild(serviceId, materializer, nowMs, input.rebuildId);
        break;
      case "switch":
        result = await runtime.promote(serviceId, materializer, input.candidateGeneration, nowMs, {
          expectedActiveGeneration: input.expectedActiveGeneration,
        });
        break;
      case "force-reverse":
        result = await runtime.forceReverse(
          serviceId,
          materializer,
          input.retainedGeneration,
          input.expectedActiveGeneration,
          input.reason,
          nowMs,
        );
        break;
    }
  } catch (error) {
    return actionError(error);
  }
  // Observation after a durable action is optional evidence. A failed read
  // must never turn the committed result into a failed action.
  let status: MaterializedViewRuntimeStatus | null;
  try {
    status = statusCapability(source) === undefined
      ? null
      : await readMaterializedViewRuntimeStatus(source, target, serviceId, materializer, nowMs);
  } catch {
    status = null;
  }
  return json(200, { result: result ?? null, status });
}

class EnsureStartedUnavailable extends Error {}

async function ensureStarted(
  runtime: MaterializedViewCatchUpRuntime,
  target: D1MaterializedViewStore,
  serviceId: string,
  materializer: MaterializedViewRowMaterializer,
  nowMs: number,
): Promise<unknown> {
  const existing = await target.readActive(serviceId, materializer.id);
  if (existing !== undefined) return null;
  try {
    return await runtime.build(serviceId, materializer, nowMs);
  } catch (error) {
    if (!(error instanceof MaterializedViewStoreError) || error.code !== "MV_INSTANCE_EXISTS") throw error;
    // createActive reports every batch failure with this code. Success is
    // only an actually present active instance on one re-read.
    let reread: MaterializedViewInstance | undefined;
    try {
      reread = await target.readActive(serviceId, materializer.id);
    } catch {
      throw new EnsureStartedUnavailable();
    }
    if (reread === undefined) throw new EnsureStartedUnavailable();
    return null;
  }
}

function actionError(error: unknown): Response {
  if (error instanceof MaterializedViewDefinitionVersionMismatchError) {
    return errorResponse(409, "materialized_view_definition_version_mismatch", "The registered materialized-view definition version does not match the serving generation.");
  }
  if (error instanceof MaterializedViewStoreError) {
    switch (error.code) {
      case "MV_PROMOTION_CAS_MISMATCH":
        return errorResponse(409, "materialized_view_switch_conflict", "The materialized-view switch expectation did not match.");
      case "MV_FORCE_REVERSE_CAS_MISMATCH":
        return errorResponse(409, "materialized_view_force_reverse_conflict", "The materialized-view force-reverse expectation did not match.");
      case "MV_FORCE_REVERSE_REJECTED":
        return errorResponse(409, "materialized_view_force_reverse_rejected", "The retained materialized-view generation cannot be re-served.");
      case "MV_INSTANCE_MISSING":
        return errorResponse(409, "materialized_view_not_started", "The materialized view has no active generation.");
      case "MV_CAS_MISMATCH":
      case "MV_REBUILD_NOT_VERIFIED":
      case "MV_GENERATION_INVALID":
        return errorResponse(409, "materialized_view_action_conflict", "The materialized-view action conflicted with its current state.");
      default:
        return unavailable();
    }
  }
  return unavailable();
}

/**
 * Compose the grain-shaped DTO from the active target instance, its existing
 * status facts, and the event-source heartbeat for that definition version.
 */
export async function readMaterializedViewRuntimeStatus(
  source: ProjectionStore,
  target: D1MaterializedViewStore,
  serviceId: string,
  materializer: MaterializedViewRowMaterializer,
  sampledAt: number,
): Promise<MaterializedViewRuntimeStatus> {
  const capability = statusCapability(source);
  if (capability === undefined) throw new Error("materialized-view status capability is missing");
  const active = await target.readActive(serviceId, materializer.id);
  const facts = active === undefined
    ? undefined
    : await target.readStatusFacts(serviceId, materializer.id, active.generation);
  if (active !== undefined && (facts === undefined || !facts.activePointer || facts.generation !== active.generation)) {
    throw new Error("materialized-view status facts are unavailable");
  }
  const identity = mvProjectionStatusIdentity(materializer.id, active?.definitionVersion ?? materializer.version);
  const raw = await capability.readProjectionStatusHeartbeat(
    serviceId,
    identity.projectorName,
    identity.projectorVersion,
    PROJECTION_STATUS_CLUSTER_ID,
  );
  const envelope = await readProjectionStatusEnvelope(source, serviceId, {
    serviceId,
    projectorName: identity.projectorName,
    projectorVersion: identity.projectorVersion,
  }, sampledAt);
  const snapshot = envelope.snapshots.find((row) => row.clusterId === PROJECTION_STATUS_CLUSTER_ID);
  if ((raw === undefined) !== (snapshot === undefined)) {
    throw new Error("materialized-view heartbeat changed during observation");
  }
  if (raw !== undefined && snapshot !== undefined && (raw.sequence !== snapshot.sequence || raw.activationId !== snapshot.activationId)) {
    throw new Error("materialized-view heartbeat changed during observation");
  }
  const fresh = snapshot !== undefined && snapshot.isFresh && !snapshot.hasConflict;
  const faulted = snapshot?.isFaulted === true;
  const activity = fresh && !faulted && (snapshot.phase === "starting" || snapshot.phase === "catchingUp");
  const recordedAt = raw === undefined ? null : formatProjectionStatusUtc(raw.recordedAt);
  const hardFinding = facts !== undefined && (facts.checkpointAhead || facts.targetPoison || facts.openOrderingQuarantine);
  return {
    serviceId,
    viewName: materializer.id,
    viewVersion: active?.definitionVersion ?? null,
    started: active !== undefined,
    catchUpInProgress: activity,
    isCatchUpActive: activity,
    subscriptionActive: false,
    bufferedEventCount: 0,
    currentPosition: active === undefined || active.lastSuid.length === 0 ? null : active.lastSuid,
    lastReceivedSortableUniqueId: snapshot?.lastTraversedSortableUniqueId ?? null,
    lastError: faulted ? PROJECTION_STATUS_FAULT_MESSAGE : null,
    lastCatchUpStartedAt: null,
    lastCatchUpCompletedAt: recordedAt,
    lastCatchUpAttemptAt: recordedAt,
    consecutiveEmptyBatches: 0,
    lastProgressSortableUniqueId: snapshot?.lastAppliedSortableUniqueId ?? null,
    needsImmediateCatchUp: fresh && !faulted && !snapshot.isCaughtUp,
    catchUpBatchSkipCount: 0,
    catchUpHalted: faulted || hardFinding,
    generation: active?.generation ?? null,
    generationStatus: active?.status ?? null,
    rebuildRequired: facts?.rebuildRequired ?? false,
    isFresh: fresh,
    switchKind: active === undefined ? null : facts?.switchKind ?? null,
    switchReason: active === undefined ? null : facts?.switchReason ?? null,
    switchedAt: active === undefined || facts?.switchedAt === null || facts?.switchedAt === undefined
      ? null
      : formatProjectionStatusUtc(facts.switchedAt),
    leavingGenerationQuarantineOpen: facts?.nonActiveOpenOrderingQuarantine ?? false,
  };
}

async function statusResponse(
  source: MaterializedViewActionSource,
  target: D1MaterializedViewStore,
  serviceId: string,
  materializer: MaterializedViewRowMaterializer,
  nowMs: number,
): Promise<Response> {
  try {
    return json(200, await readMaterializedViewRuntimeStatus(source, target, serviceId, materializer, nowMs));
  } catch {
    return unavailable();
  }
}

/**
 * One-shot observation of the existing G31 wait facts: at most one source
 * point read and one target point read, with every hard gate evaluated before
 * either success branch. It never waits, retries, or starts catch-up.
 */
async function receivedResponse(
  source: MaterializedViewActionSource & WaitForTargetSourcePort,
  target: D1MaterializedViewStore,
  serviceId: string,
  viewId: string,
  sortableUniqueId: string,
): Promise<Response> {
  let lookup: WaitForTargetLookup;
  try {
    lookup = await source.readWaitForTarget(serviceId, sortableUniqueId);
  } catch {
    return unavailable();
  }
  if (lookup.kind === "unavailable") return unavailable();
  let state: Awaited<ReturnType<D1MaterializedViewStore["readWaitForState"]>>;
  try {
    state = await target.readWaitForState(serviceId, viewId, {
      ...(lookup.kind === "stored" ? { eventId: lookup.eventId } : {}),
      suid: sortableUniqueId,
    });
  } catch {
    return unavailable();
  }
  if (state.checkpointAhead || state.rebuildRequired || state.poison) return unavailable();
  if (lookup.kind !== "stored" || state.activeGeneration === undefined) return json(200, false);
  if (state.targetReceipt || compareSuid(state.safeContiguousHead, lookup.suid) >= 0) return json(200, true);
  return json(200, false);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json(status, { error: message, code });
}

function notFound(): Response {
  return errorResponse(404, "materialized_view_action_not_found", "Materialized-view action route was not found.");
}

function invalidRequest(): Response {
  return errorResponse(400, "materialized_view_action_invalid_request", "Materialized-view action request is invalid.");
}

function unsupported(): Response {
  return errorResponse(501, "materialized_view_action_unsupported", "Materialized-view action is not supported by this provider.");
}

function unavailable(): Response {
  return errorResponse(503, "materialized_view_action_unavailable", "Materialized-view action is unavailable.");
}
