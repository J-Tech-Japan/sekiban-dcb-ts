import { assertSortableUniqueId } from "../allocator/SortableUniqueId";
import type { MaterializedViewStatusFacts } from "./MaterializedViewStore";
import {
  PROJECTION_STATUS_PHASES,
  type ProjectionStatusHeartbeat,
  type ProjectionStatusPhase,
  type ProjectionStore,
} from "../store/types";

export const PROJECTION_STATUS_PATH = "/api/sekiban/serialized/projection-status";
export const PROJECTION_STATUS_CLUSTER_ID = "cloudflare";
export const PROJECTION_STATUS_ACTIVATION_ID = "scheduled";
export const PROJECTION_STATUS_FRESHNESS_MS = 120_000;
export const PROJECTION_STATUS_CONSISTENCY = "bestEffort" as const;
export const PROJECTION_STATUS_FAULT_MESSAGE = "materialized view catch-up faulted";

export const PROJECTION_STATUS_V1_MEMBERS = [
  "projectorName",
  "projectorVersion",
  "clusterId",
  "activationId",
  "sequence",
  "appliedEventCount",
  "lastAppliedSortableUniqueId",
  "lastTraversedSortableUniqueId",
  "totalEventCount",
  "remainingEventCount",
  "sampledAtUtc",
  "consistency",
  "isCaughtUp",
  "hasConflict",
  "conflictingActivationIds",
  "phase",
  "leaseExpiresAtUtc",
  "isFaulted",
  "faultMessage",
  "isFresh",
] as const;

const REQUEST_KEYS = new Set(["version", "serviceId", "projectorName", "projectorVersion"]);

export interface ProjectionStatusRequestV1 {
  readonly serviceId: string | null;
  readonly projectorName: string | null;
  readonly projectorVersion: string | null;
}

export interface ProjectionStatusSnapshotV1 {
  readonly projectorName: string;
  readonly projectorVersion: string;
  readonly clusterId: string;
  readonly activationId: string;
  readonly sequence: number;
  readonly appliedEventCount: number;
  readonly lastAppliedSortableUniqueId: string | null;
  readonly lastTraversedSortableUniqueId: string | null;
  readonly totalEventCount: number;
  readonly remainingEventCount: number;
  readonly sampledAtUtc: string;
  readonly consistency: typeof PROJECTION_STATUS_CONSISTENCY;
  readonly isCaughtUp: boolean;
  readonly hasConflict: boolean;
  readonly conflictingActivationIds: readonly string[];
  readonly phase: ProjectionStatusPhase;
  readonly leaseExpiresAtUtc: string | null;
  readonly isFaulted: boolean;
  readonly faultMessage: string | null;
  readonly isFresh: boolean;
  readonly switchKind?: string | null;
  readonly switchReason?: string | null;
  readonly switchedAtUtc?: string | null;
}

export interface MaterializedViewStatusObservation {
  readonly facts: MaterializedViewStatusFacts | undefined;
  readonly indeterminate: boolean;
  readonly stopReason: "safe_window_fence" | "safe_window_ceiling" | "frontier_fence" | null;
  readonly typedFault: boolean;
  readonly rebuildRecovery: boolean;
  readonly knownSourceCount: boolean;
  readonly sourceEventCount: number | null;
  readonly appliedEventCount: number | null;
}

export interface ProjectionStatusRouteDependencies {
  readonly serverServiceId: string;
  readonly createStore: () => ProjectionStatusReadStore;
  readonly nowMs?: () => number;
}

interface ProjectionStatusReadStore extends ProjectionStore {
  initialize(): Promise<void>;
  close?(): Promise<void>;
}

type RequestDecision =
  | { readonly ok: true; readonly request: ProjectionStatusRequestV1 }
  | { readonly ok: false; readonly status: 400; readonly code: "projection_status_invalid_request" | "projection_status_unsupported_version" };

export function assertProjectionStatusHeartbeat(heartbeat: ProjectionStatusHeartbeat, expectedSequence: number): void {
  boundedText(heartbeat.serviceId, 1, 64);
  boundedText(heartbeat.projectorName, 1, 256);
  boundedText(heartbeat.projectorVersion, 1, 128);
  boundedText(heartbeat.clusterId, 1, 256);
  boundedText(heartbeat.activationId, 1, 128);
  nonNegative(heartbeat.sequence);
  nonNegative(expectedSequence);
  nonNegative(heartbeat.appliedEventCount);
  nonNegative(heartbeat.recordedAt);
  optionalSuid(heartbeat.lastAppliedSortableUniqueId);
  optionalSuid(heartbeat.lastTraversedSortableUniqueId);
  if (!(PROJECTION_STATUS_PHASES as readonly string[]).includes(heartbeat.phase)) {
    throw new Error("projection status heartbeat is invalid");
  }
  if (heartbeat.leaseExpiresAt !== null) nonNegative(heartbeat.leaseExpiresAt);
  if (typeof heartbeat.isFaulted !== "boolean") throw new Error("projection status heartbeat is invalid");
  if (heartbeat.faultMessage !== null) boundedText(heartbeat.faultMessage, 0, 2048);
  if (heartbeat.switchKind !== null) boundedText(heartbeat.switchKind, 0, 32);
  if (heartbeat.switchReason !== null) boundedText(heartbeat.switchReason, 0, 1024);
  if (heartbeat.switchedAt !== null) nonNegative(heartbeat.switchedAt);
}

function boundedText(value: string, minimum: number, maximum: number): void {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new Error("projection status heartbeat is invalid");
  }
}

function nonNegative(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("projection status heartbeat is invalid");
}

function optionalSuid(value: string | null): void {
  if (value === null || value.length === 0) return;
  if (value.length > 100) throw new Error("projection status heartbeat is invalid");
  assertSortableUniqueId(value);
}

export function mvProjectionStatusIdentity(viewId: string, definitionVersion: number): {
  readonly projectorName: string;
  readonly projectorVersion: string;
} {
  if (viewId.length === 0 || !Number.isSafeInteger(definitionVersion) || definitionVersion < 0) {
    throw new Error("materialized view status identity is invalid");
  }
  const bytes = new TextEncoder().encode(viewId);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return {
    projectorName: `mv:${encoded}`,
    projectorVersion: `v:${definitionVersion}`,
  };
}

export function formatProjectionStatusUtc(epochMs: number): string {
  if (!Number.isSafeInteger(epochMs) || epochMs < 0) throw new Error("projection status time was invalid");
  const date = new Date(epochMs);
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  const fraction = date.getUTCMilliseconds() === 0
    ? ""
    : `.${String(date.getUTCMilliseconds()).replace(/0+$/, "")}`;
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}T${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}${fraction}+00:00`;
}

export function mapMaterializedViewStatusPhase(observation: MaterializedViewStatusObservation): ProjectionStatusPhase {
  if (observation.facts === undefined) return "unknown";
  const facts = observation.facts;
  if (facts.checkpointAhead || facts.targetPoison || facts.openOrderingQuarantine || observation.typedFault) {
    return "faulted";
  }
  if (facts.status === "retired") return "stopped";
  if (facts.rebuildRequired) return "catchingUp";
  if (observation.indeterminate) return "unknown";
  const preCompletion = facts.lastSuid.length === 0 && observation.stopReason === null && !observation.knownSourceCount;
  if (preCompletion) return "starting";
  const knownZero = observation.knownSourceCount
    && observation.sourceEventCount !== null
    && observation.appliedEventCount !== null
    && observation.appliedEventCount === observation.sourceEventCount
    && observation.stopReason === null;
  const proofMissing = observation.rebuildRecovery && facts.rebuildVerifiedAt === null;
  const incomplete = observation.stopReason !== null || !observation.knownSourceCount || !knownZero || proofMissing;
  if (facts.status === "candidate" && incomplete) return "catchingUp";
  if (facts.status === "candidate" && knownZero && !proofMissing) return "caughtUp";
  if (facts.status === "active" && observation.stopReason !== null) return "catchingUp";
  if (facts.status === "active") return "active";
  return "unknown";
}

export function serializeProjectionStatusRequestV1(request: ProjectionStatusRequestV1): string {
  return JSON.stringify({
    version: 1,
    serviceId: request.serviceId,
    projectorName: request.projectorName,
    projectorVersion: request.projectorVersion,
  });
}

export function serializeProjectionStatusEnvelopeV1(
  serviceId: string,
  snapshots: readonly ProjectionStatusSnapshotV1[],
): string {
  return JSON.stringify({
    version: 1,
    serviceId,
    snapshots: snapshots.map(snapshotJson),
  });
}

export async function handleSerializedProjectionStatus(
  request: Request,
  dependencies: ProjectionStatusRouteDependencies,
): Promise<Response> {
  if (new URL(request.url).pathname !== PROJECTION_STATUS_PATH) {
    return statusError(404, "projection_status_route_not_found", "Projection status route was not found.");
  }
  if (request.method !== "POST") {
    return statusError(404, "projection_status_route_not_found", "Projection status route was not found.");
  }
  let body: string;
  try {
    body = await request.text();
  } catch {
    return statusError(400, "projection_status_invalid_request", "Projection status request is invalid.");
  }
  const parsed = parseProjectionStatusRequestV1(body);
  if (!parsed.ok) {
    const message = parsed.code === "projection_status_unsupported_version"
      ? "Projection status version is not supported."
      : "Projection status request is invalid.";
    return statusError(parsed.status, parsed.code, message);
  }
  if (parsed.request.serviceId !== null && parsed.request.serviceId !== dependencies.serverServiceId) {
    return statusError(400, "projection_status_invalid_request", "Projection status request is invalid.");
  }
  let store: ProjectionStatusReadStore | undefined;
  try {
    store = dependencies.createStore();
  } catch {
    return statusError(503, "projection_status_unavailable", "Projection status is unavailable.");
  }
  if (!hasStatusCapability(store)) {
    await closeStore(store);
    return statusError(501, "projection_status_unsupported", "Projection status is not supported by this provider.");
  }
  try {
    await store.initialize();
    const envelope = await readProjectionStatusEnvelope(store, dependencies.serverServiceId, parsed.request, dependencies.nowMs?.() ?? Date.now());
    return jsonResponse(envelope);
  } catch {
    return statusError(503, "projection_status_unavailable", "Projection status is unavailable.");
  } finally {
    await closeStore(store);
  }
}

export function parseProjectionStatusRequestV1(body: string): RequestDecision {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, status: 400, code: "projection_status_invalid_request" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, status: 400, code: "projection_status_invalid_request" };
  }
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, "version") || typeof record.version !== "number" || !Number.isInteger(record.version)) {
    return { ok: false, status: 400, code: "projection_status_invalid_request" };
  }
  if (record.version !== 1) {
    return { ok: false, status: 400, code: "projection_status_unsupported_version" };
  }
  for (const key of Object.keys(record)) {
    if (!REQUEST_KEYS.has(key)) return { ok: false, status: 400, code: "projection_status_invalid_request" };
  }
  const serviceId = optionalString(record, "serviceId");
  const projectorName = optionalString(record, "projectorName");
  const projectorVersion = optionalString(record, "projectorVersion");
  if (serviceId === false || projectorName === false || projectorVersion === false) {
    return { ok: false, status: 400, code: "projection_status_invalid_request" };
  }
  return {
    ok: true,
    request: {
      serviceId: serviceId === null || serviceId.length === 0 ? null : serviceId,
      projectorName,
      projectorVersion,
    },
  };
}

export async function readProjectionStatusEnvelope(
  store: ProjectionStore,
  serverServiceId: string,
  request: ProjectionStatusRequestV1,
  sampledAt: number,
): Promise<{ version: 1; serviceId: string; snapshots: ProjectionStatusSnapshotV1[] }> {
  if (typeof store.listProjectionStatusHeartbeats !== "function" || typeof store.readAllEvents !== "function") {
    throw new Error("projection status capability is missing");
  }
  const rows = await store.listProjectionStatusHeartbeats(
    serverServiceId,
    request.projectorName,
    request.projectorVersion,
  );
  const events = await store.readAllEvents(serverServiceId, "");
  const totalEventCount = events.length;
  const remainingByCursor = new Map<string, number>();
  for (const row of rows) {
    const cursor = row.lastTraversedSortableUniqueId;
    if (cursor === null || cursor.length === 0 || remainingByCursor.has(cursor)) continue;
    let remaining = 0;
    for (const event of events) {
      if (compareSuid(event.suid, cursor) > 0) remaining += 1;
    }
    remainingByCursor.set(cursor, remaining);
  }
  const freshSince = sampledAt - PROJECTION_STATUS_FRESHNESS_MS;
  const groups = new Map<string, ProjectionStatusHeartbeat[]>();
  for (const row of rows) {
    const key = `${row.projectorName}\u0000${row.projectorVersion}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }
  const conflicts = new Map<string, { readonly hasConflict: boolean; readonly activationIds: readonly string[] }>();
  for (const [key, group] of groups) {
    const fresh = group.filter((row) => heartbeatFresh(row, freshSince, sampledAt));
    const activationIds = [...new Set(fresh.map((row) => row.activationId))].sort(compareText);
    conflicts.set(key, { hasConflict: fresh.length > 1, activationIds });
  }
  const snapshots = rows.map((row): ProjectionStatusSnapshotV1 => {
    const cursor = row.lastTraversedSortableUniqueId;
    const remainingEventCount = cursor === null || cursor.length === 0
      ? totalEventCount
      : remainingByCursor.get(cursor);
    if (remainingEventCount === undefined || !(PROJECTION_STATUS_PHASES as readonly string[]).includes(row.phase)) {
      throw new Error("projection status remaining count is unknown");
    }
    const fresh = heartbeatFresh(row, freshSince, sampledAt);
    const conflict = conflicts.get(`${row.projectorName}\u0000${row.projectorVersion}`);
    const hasConflict = conflict?.hasConflict === true;
    const faulted = row.isFaulted || (row.faultMessage !== null && row.faultMessage.length > 0) || row.phase === "faulted";
    const lifecycleEligible = row.phase === "active" || row.phase === "caughtUp";
    const isCaughtUp = remainingEventCount === 0 && fresh && lifecycleEligible && !faulted && !hasConflict;
    return {
      projectorName: row.projectorName,
      projectorVersion: row.projectorVersion,
      clusterId: row.clusterId,
      activationId: row.activationId,
      sequence: row.sequence,
      appliedEventCount: row.appliedEventCount,
      lastAppliedSortableUniqueId: row.lastAppliedSortableUniqueId,
      lastTraversedSortableUniqueId: row.lastTraversedSortableUniqueId,
      totalEventCount,
      remainingEventCount,
      sampledAtUtc: formatProjectionStatusUtc(sampledAt),
      consistency: PROJECTION_STATUS_CONSISTENCY,
      isCaughtUp,
      hasConflict,
      conflictingActivationIds: hasConflict ? conflict.activationIds : [],
      phase: row.phase,
      leaseExpiresAtUtc: row.leaseExpiresAt === null ? null : formatProjectionStatusUtc(row.leaseExpiresAt),
      isFaulted: faulted,
      faultMessage: row.faultMessage,
      isFresh: fresh,
      switchKind: row.switchKind,
      switchReason: row.switchReason,
      switchedAtUtc: row.switchedAt === null ? null : formatProjectionStatusUtc(row.switchedAt),
    };
  }).sort((left, right) => compareText(left.projectorName, right.projectorName)
    || compareText(left.projectorVersion, right.projectorVersion)
    || compareText(left.clusterId, right.clusterId)
    || compareText(left.activationId, right.activationId));
  return { version: 1, serviceId: serverServiceId, snapshots };
}

export function statusCapability(store: ProjectionStore): {
  readProjectionStatusHeartbeat: NonNullable<ProjectionStore["readProjectionStatusHeartbeat"]>;
  upsertProjectionStatusHeartbeat: NonNullable<ProjectionStore["upsertProjectionStatusHeartbeat"]>;
  listProjectionStatusHeartbeats: NonNullable<ProjectionStore["listProjectionStatusHeartbeats"]>;
} | undefined {
  if (!hasStatusCapability(store)) return undefined;
  return store;
}

function hasStatusCapability(store: ProjectionStore): store is ProjectionStore & {
  readProjectionStatusHeartbeat: NonNullable<ProjectionStore["readProjectionStatusHeartbeat"]>;
  upsertProjectionStatusHeartbeat: NonNullable<ProjectionStore["upsertProjectionStatusHeartbeat"]>;
  listProjectionStatusHeartbeats: NonNullable<ProjectionStore["listProjectionStatusHeartbeats"]>;
} {
  return typeof store.readProjectionStatusHeartbeat === "function"
    && typeof store.upsertProjectionStatusHeartbeat === "function"
    && typeof store.listProjectionStatusHeartbeats === "function";
}

function heartbeatFresh(row: ProjectionStatusHeartbeat, freshSince: number, sampledAt: number): boolean {
  return row.recordedAt >= freshSince && (row.leaseExpiresAt === null || row.leaseExpiresAt >= sampledAt);
}

function snapshotJson(snapshot: ProjectionStatusSnapshotV1): Record<string, unknown> {
  const body: Record<string, unknown> = {
    projectorName: snapshot.projectorName,
    projectorVersion: snapshot.projectorVersion,
    clusterId: snapshot.clusterId,
    activationId: snapshot.activationId,
    sequence: snapshot.sequence,
    appliedEventCount: snapshot.appliedEventCount,
    lastAppliedSortableUniqueId: snapshot.lastAppliedSortableUniqueId,
    lastTraversedSortableUniqueId: snapshot.lastTraversedSortableUniqueId,
    totalEventCount: snapshot.totalEventCount,
    remainingEventCount: snapshot.remainingEventCount,
    sampledAtUtc: snapshot.sampledAtUtc,
    consistency: snapshot.consistency,
    isCaughtUp: snapshot.isCaughtUp,
    hasConflict: snapshot.hasConflict,
    conflictingActivationIds: [...snapshot.conflictingActivationIds],
    phase: snapshot.phase,
    leaseExpiresAtUtc: snapshot.leaseExpiresAtUtc,
    isFaulted: snapshot.isFaulted,
    faultMessage: snapshot.faultMessage,
    isFresh: snapshot.isFresh,
  };
  if (snapshot.switchKind !== null && snapshot.switchKind !== undefined) body.switchKind = snapshot.switchKind;
  if (snapshot.switchReason !== null && snapshot.switchReason !== undefined) body.switchReason = snapshot.switchReason;
  if (snapshot.switchedAtUtc !== null && snapshot.switchedAtUtc !== undefined) body.switchedAtUtc = snapshot.switchedAtUtc;
  return body;
}

function optionalString(record: Record<string, unknown>, key: string): string | null | false {
  if (!Object.hasOwn(record, key) || record[key] === null) return null;
  return typeof record[key] === "string" ? record[key] : false;
}

function jsonResponse(body: { version: 1; serviceId: string; snapshots: readonly ProjectionStatusSnapshotV1[] }): Response {
  return new Response(serializeProjectionStatusEnvelopeV1(body.serviceId, body.snapshots), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function statusError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: message, code }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function closeStore(store: ProjectionStatusReadStore | undefined): Promise<void> {
  if (store?.close === undefined) return;
  try {
    await store.close();
  } catch {
    return;
  }
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareSuid(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const shared = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}
