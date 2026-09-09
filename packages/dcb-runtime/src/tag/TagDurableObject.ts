import {
  PARTIAL_WRITE_FENCE_REASON,
  RESERVATION_WINDOW_MS,
  SEGMENT_ROTATION_FENCE_REASON,
  type TagConsistencyEntry,
  type TagEpoch,
  type TagEvent,
  type G43TagStateIncrementalPage,
  type G43TagStateIncrementalRequest,
  type TagFence,
  type TagHeadFacts,
  type TagOutboxDelivery,
  type TagOutboxRow,
  type TagRecord,
  type TagBootstrapAdmission,
  type TagReservation,
  type RepairAudit,
  type RepairBranch,
  type RepairFacts,
  type RepairResolution,
  type RepairScopeItem,
} from "./types";
import type { DownstreamOutboxMessage } from "../downstream/types";
import type { SourceObligationPage } from "../completeness/types";
import {
  downstreamEnvelopeBytes,
  classifyDirectDoorbellFailure,
  readDomainDeliveryClass,
  preflightDirectDoorbell,
  readDirectDoorbellConfig,
  type DownstreamDoorbellBinding,
} from "../downstream/Doorbell";
import { deliveryCorrelationId } from "../downstream/DeliveryCore";
import { assertCanonicalEventType } from "../eventIdentity";
import { assertSortableUniqueId, compareSortableUniqueId } from "../allocator/SortableUniqueId";
import { CANONICAL_UTC_TIMESTAMP_PATTERN, isRfc4122Uuid, isUuidV7, serializedEventMetadata } from "../eventRecord";
import {
  DurableObjectActivation,
  enterNativeActorHandleSpan,
  noOpNativeTracing,
  type DurableObjectActivationObservation,
  type NativeTracing,
} from "../trace/CommitTrace";
import {
  beginDurableObjectHandlerObservation,
  type DurableObjectHandlerObservation,
} from "../trace/ObservationStream";
import { canonicalDeclaredTagSet, eventDigestBytes, eventDigestHex } from "./EventDigest";
import {
  hasTagSqlStorage,
  initializeTagSqlSchema,
  TAG_READ_AFTER_SQL,
  TAG_READ_AFTER_THROUGH_SQL,
} from "./TagSqlSchema";
import { G43SqlMeasurement, type G43SqlMeasurementSnapshot } from "./TagSqlMeasurement";
import { recordDurableHop, type G60DurableHopObservation } from "../diagnostics/G60DurableHop";
import { recordG65AdmissionAttempt, type G65AdmissionOutcome } from "../diagnostics/G65Admission";
import { D1EventStore } from "../store/D1EventStore";

const REPAIR_FACTS_KEY = "repair-facts";
/**
 * Only the deliberately SQL-less direct-test seam uses this legacy-shaped
 * delivery clock fixture. Deployed Tag DOs always use tag_outbox_obligation;
 * this is never a second persisted event-record authority.
 */
const OUTBOX_DELIVERIES_KEY = "outbox-deliveries";
const MAX_EPOCH = Number.MAX_SAFE_INTEGER;
const DEFAULT_REPAIR_LEASE_MS = 30_000;
const MAX_REPAIR_LEASE_MS = 5 * 60_000;
const OBLIGATION_RETRY_MS = 1_000;
const OBLIGATION_MAX_ATTEMPTS = 3;
const OBLIGATION_ALARM_BATCH_LIMIT = 32;
/**
 * G65 bounds derived writes, not the durable Tag commit.  The value is short
 * enough to keep the commit root near the G52 baseline while still allowing a
 * healthy same-colo D1/doorbell attempt to complete before the response.
 */
export const G65_DERIVED_WRITE_BUDGET_MS = 300;
export const G65_SOURCE_REGISTRATION_MAX_ATTEMPTS = 3;
export const G65_SOURCE_REGISTRATION_RETRY_DELAY_MS = 25;
export const G65_GLOBAL_ADMISSION_HEADER = "x-sdt-global-admission";
type GlobalAdmissionStatus = "admitted" | "not-admitted" | "unknown";
/** Schema identity is immutable for the lifetime of a Worker isolate. */
const g44GlobalArrayAuthorityByD1 = new WeakMap<D1Database, Promise<boolean>>();
const g44GlobalArrayAuthorityResultByD1 = new WeakMap<D1Database, boolean>();

type JsonObject = Record<string, unknown>;
type SqlRow = Record<string, SqlStorageValue>;

interface EpochInput {
  attemptId: string;
  epoch: number;
}

interface AcquireInput extends EpochInput {
  eventTags: string[];
  consistencyTags: TagConsistencyEntry[];
  expectedHead: string | null;
}

interface ReservationInput extends EpochInput {
  reservationToken?: string;
  /** Internal recovery-only cancel barrier. Never part of the V1 wire. */
  forceTombstone?: boolean;
  /** G70-only allocator recovery may establish a fence before first append. */
  createMissingTombstone?: boolean;
}

interface AppendCandidate {
  eventId: string;
  suid: string;
  payload: string;
  eventTags: string[];
  allocatorLineageId: string;
  eventType: string;
  provenance: "g32";
  timestamp: string;
}

interface AppendInput extends ReservationInput {
  candidates: AppendCandidate[];
  faultInjection?: "after-append-before-confirm";
}

interface BootstrapAppendInput {
  importId: string;
  leaseEpoch: number;
  manifestDigest: string;
  targetServiceId: string;
  candidates: AppendCandidate[];
}

interface FenceInput extends EpochInput {
  reason: string;
}

interface RepairAcquireInput {
  owner: string;
  leaseMs: number;
  scope: RepairScopeItem[];
}

interface RepairLeaseInput {
  owner: string;
  epoch: number;
}

interface RepairScopeUnionInput extends RepairLeaseInput {
  scope: RepairScopeItem[];
}

interface RepairApplyInput extends RepairLeaseInput {
  item: RepairScopeItem;
}

interface RepairAuditInput extends RepairApplyInput {
  actor: string;
}

interface RepairClearInput extends RepairLeaseInput {
  attemptId: string;
  scopeVersion: number;
}

interface OutboxPendingInput {
  nowMs: number;
  limit?: number;
  /**
   * An explicit drain is an immediate handoff attempt, not an alarm wake.
   * `next_attempt_at` still remains the durable scheduler deadline.
   */
  force?: boolean;
}

interface OutboxMarkInput {
  deliveries: Array<Pick<DownstreamOutboxMessage, "attemptId" | "eventId" | "suid" | "payload" | "enqueuedAt" | "eventType" | "provenance" | "timestamp" | "allocatorLineageId" | "completeness">>;
  nowMs: number;
}

interface G44SourceScanInput {
  serviceId: string;
  tag: string;
  upperBoundSequence: number;
  afterSequence: number;
  limit: number;
}

interface TagDurableObjectEnv {
  /** Global D1 receipt authority used only to verify a source acknowledgement. */
  D1?: D1Database;
  DOWNSTREAM_QUEUE?: Queue<DownstreamOutboxMessage>;
  DOWNSTREAM_DOORBELL?: DownstreamDoorbellBinding;
  AUTO_DRAIN_OUTBOX?: string;
  DOMAIN_DELIVERY_CLASS?: string;
  DIRECT_DOORBELL?: string;
  DIRECT_DOORBELL_ALLOWED_VIEWS?: string;
  DIRECT_DOORBELL_MAX_INVOCATIONS?: string;
  DIRECT_DOORBELL_DEGRADATION?: string;
  DIRECT_DOORBELL_RECEIVER_MODE?: string;
  DIRECT_DOORBELL_SELF_BINDING_PROOF?: string;
}

interface OperationResult {
  status: number;
  body: unknown;
  /** G60 facts captured inside the committed SQL transaction. */
  hopFacts?: readonly AppendHopFact[];
}

interface AppendHopFact {
  readonly eventId: string;
  readonly suid: string;
  readonly attemptId: string;
  readonly tag: string;
  readonly tagAppendCommittedAt: number;
  readonly obligationWrittenAt: number;
}

interface ExpiryResult {
  record: TagRecord;
  expired: boolean;
}

interface FenceGateObservation {
  checked: true;
  activeFenceCount: number;
}

class AppendTransactionFault extends Error {}

class PartitionRegistrationUnavailableError extends Error {
  constructor(cause: unknown) {
    super("partition_registration_unavailable");
    this.name = "PartitionRegistrationUnavailableError";
    this.cause = cause;
  }

  readonly cause: unknown;
}

/** A mismatched immutable tag identity is a typed 409, not an internal error. */
export class TagIdentityConflict extends Error {
  constructor() {
    super("Tag Durable Object identity changed");
    this.name = "TagIdentityConflict";
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function error(status: number, code: string, message: string, retryable = false): Response {
  return json(retryable ? { error: message, code, retryable: true } : { error: message, code }, status);
}

function withGlobalAdmission(response: Response, status: GlobalAdmissionStatus): Response {
  // `json()` creates this Response locally, so its Headers are mutable. Keep
  // the original object so the existing G60 response-order guard remains a
  // direct assertion over the same response returned by the Tag DO.
  response.headers.set(G65_GLOBAL_ADMISSION_HEADER, status);
  return response;
}

function rejected(reason: string, status = 409): OperationResult {
  return {
    status,
    body: { code: "tag_operation_rejected", error: reason, reason },
  };
}

const ASSERT_EMPTY_CONFLICT_REASON = "consistency_head_mismatch_assert_empty";

function repairRejected(reason: string, status = 409): OperationResult {
  return {
    status,
    body: { code: "repair_operation_rejected", error: reason, reason },
  };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}

function sqlString(value: SqlStorageValue | undefined, column: string): string {
  if (typeof value !== "string") throw new Error(`Tag SQL column ${column} is not a string`);
  return value;
}

function sqlNumber(value: SqlStorageValue | undefined, column: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Tag SQL column ${column} is not a safe integer`);
  }
  return value;
}

function sqlNullableNumber(value: SqlStorageValue | undefined, column: string): number | null {
  return value === null || value === undefined ? null : sqlNumber(value, column);
}

function sqlNullableString(value: SqlStorageValue | undefined, column: string): string | null {
  return value === null || value === undefined ? null : sqlString(value, column);
}

function sqlArrayBuffer(value: SqlStorageValue | undefined, column: string): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  throw new Error(`Tag SQL column ${column} is not binary`);
}

function sqlJson<T>(value: SqlStorageValue | undefined, column: string): T {
  try {
    return JSON.parse(sqlString(value, column)) as T;
  } catch {
    throw new Error(`Tag SQL column ${column} is not valid JSON`);
  }
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** JSON envelope form of the exact G43 digest preimage stored as a BLOB. */
function arrayBufferBase64(value: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function nowIso(): string {
  return new Date().toISOString();
}

function epochFrom(value: unknown): { value?: EpochInput; error?: string } {
  if (!isObject(value) || !isNonEmptyString(value.attemptId) || !isEpoch(value.epoch)) {
    return { error: "attemptId and a non-negative safe-integer epoch are required" };
  }
  return { value: { attemptId: value.attemptId, epoch: value.epoch } };
}

function stringArrayFrom(value: unknown, name: string): { value?: string[]; error?: string } {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    return { error: `${name} must be an array of non-empty strings` };
  }
  if (new Set(value).size !== value.length) {
    return { error: `${name} values must be unique` };
  }
  return { value: [...value] };
}

function consistencyTagsFrom(value: unknown): { value?: TagConsistencyEntry[]; error?: string } {
  if (!Array.isArray(value)) {
    return { error: "consistencyTags must be an array" };
  }

  const entries: TagConsistencyEntry[] = [];
  for (const rawEntry of value) {
    if (!isObject(rawEntry) || !isNonEmptyString(rawEntry.tag)) {
      return { error: "each consistency tag needs a non-empty tag" };
    }
    if (!("lastSortableUniqueId" in rawEntry)) {
      return { error: "each consistency tag needs lastSortableUniqueId" };
    }
    if (rawEntry.lastSortableUniqueId === null) {
      return { error: "lastSortableUniqueId must not be null" };
    }
    if (typeof rawEntry.lastSortableUniqueId !== "string") {
      return { error: "lastSortableUniqueId must be a string" };
    }
    if (rawEntry.lastSortableUniqueId !== "") {
      try {
        assertSortableUniqueId(rawEntry.lastSortableUniqueId);
      } catch {
        return { error: "lastSortableUniqueId must be a 30-digit SortableUniqueId" };
      }
    }
    entries.push({ tag: rawEntry.tag, lastSortableUniqueId: rawEntry.lastSortableUniqueId });
  }
  if (new Set(entries.map((entry) => entry.tag)).size !== entries.length) {
    return { error: "consistency tag values must be unique" };
  }
  return { value: entries };
}

function acquireFrom(value: unknown, tag: string): { value?: AcquireInput; error?: string } {
  const epoch = epochFrom(value);
  if (epoch.value === undefined || !isObject(value)) {
    return { error: epoch.error ?? "Invalid acquire request" };
  }
  const eventTags = stringArrayFrom(value.eventTags, "eventTags");
  const consistencyTags = consistencyTagsFrom(value.consistencyTags);
  if (eventTags.value === undefined || consistencyTags.value === undefined) {
    return { error: eventTags.error ?? consistencyTags.error ?? "Invalid acquire request" };
  }

  const matchingEntry = consistencyTags.value.find((entry) => entry.tag === tag);
  if (matchingEntry !== undefined && !eventTags.value.includes(tag)) {
    return { error: "a consistency tag must also be an event tag" };
  }
  return {
    value: {
      ...epoch.value,
      eventTags: eventTags.value,
      consistencyTags: consistencyTags.value,
      expectedHead: matchingEntry?.lastSortableUniqueId ?? null,
    },
  };
}

function reservationFrom(value: unknown): { value?: ReservationInput; error?: string } {
  const epoch = epochFrom(value);
  if (epoch.value === undefined || !isObject(value)) {
    return { error: epoch.error ?? "Invalid reservation request" };
  }
  if (value.reservationToken !== undefined && !isNonEmptyString(value.reservationToken)) {
    return { error: "reservationToken must be a non-empty string when present" };
  }
  if (value.forceTombstone !== undefined && typeof value.forceTombstone !== "boolean") {
    return { error: "forceTombstone must be a boolean when present" };
  }
  if (value.createMissingTombstone !== undefined && typeof value.createMissingTombstone !== "boolean") {
    return { error: "createMissingTombstone must be a boolean when present" };
  }
  return {
    value: {
      ...epoch.value,
      reservationToken: value.reservationToken,
      forceTombstone: value.forceTombstone,
      createMissingTombstone: value.createMissingTombstone,
    },
  };
}

function appendFrom(value: unknown, tag: string): { value?: AppendInput; error?: string } {
  const reservation = reservationFrom(value);
  if (reservation.value === undefined || !isObject(value) || !Array.isArray(value.candidates)) {
    return { error: reservation.error ?? "candidates must be an array" };
  }
  if (value.candidates.length === 0) {
    return { error: "an append requires at least one candidate" };
  }

  const candidates: AppendCandidate[] = [];
  for (const rawCandidate of value.candidates) {
    if (
      !isObject(rawCandidate) ||
      !isNonEmptyString(rawCandidate.eventId) ||
      !isNonEmptyString(rawCandidate.suid) ||
      typeof rawCandidate.payload !== "string"
    ) {
      return { error: "each candidate needs eventId, suid, and payload" };
    }
    const eventTags = stringArrayFrom(rawCandidate.eventTags, "candidate eventTags");
    if (eventTags.value === undefined || !eventTags.value.includes(tag)) {
      return { error: eventTags.error ?? "each candidate must include this event tag" };
    }
    let eventType: string;
    try {
      if (!isNonEmptyString(rawCandidate.eventType)) return { error: "candidate eventType is required" };
      eventType = assertCanonicalEventType(rawCandidate.eventType).key;
      assertSortableUniqueId(rawCandidate.suid);
      if (!isUuidV7(rawCandidate.eventId)) return { error: "candidate eventId must be a UUID v7" };
      JSON.parse(rawCandidate.payload);
    } catch (error) {
      return { error: error instanceof Error ? error.message : "candidate identity or payload is invalid" };
    }
    if (rawCandidate.provenance !== "g32") return { error: "candidate provenance must be g32" };
    if (!isNonEmptyString(rawCandidate.allocatorLineageId)) return { error: "candidate allocatorLineageId is required" };
    if (!isNonEmptyString(rawCandidate.timestamp) || !CANONICAL_UTC_TIMESTAMP_PATTERN.test(rawCandidate.timestamp)) {
      return { error: "candidate timestamp must be canonical UTC" };
    }
    candidates.push({
      eventId: rawCandidate.eventId,
      suid: rawCandidate.suid,
      payload: rawCandidate.payload,
      eventTags: eventTags.value,
      allocatorLineageId: rawCandidate.allocatorLineageId,
      eventType,
      provenance: "g32",
      timestamp: rawCandidate.timestamp,
    });
  }
  if (new Set(candidates.map((candidate) => candidate.eventId)).size !== candidates.length) {
    return { error: "candidate eventId values must be unique" };
  }

  const ordered = [...candidates].sort((left, right) =>
    left.suid < right.suid ? -1 : left.suid > right.suid ? 1 : 0,
  );
  if (ordered.some((candidate, index) => index > 0 && ordered[index - 1]!.suid === candidate.suid)) {
    return { error: "candidate SUID values must be unique" };
  }
  const faultInjection = value.faultInjection;
  if (faultInjection !== undefined && faultInjection !== "after-append-before-confirm") {
    return { error: "unsupported faultInjection" };
  }

  return { value: { ...reservation.value, candidates: ordered, faultInjection } };
}

function bootstrapAppendFrom(value: unknown, tag: string): { value?: BootstrapAppendInput; error?: string } {
  if (!isObject(value) || !isNonEmptyString(value.importId) || !isEpoch(value.leaseEpoch) || !isNonEmptyString(value.manifestDigest) || !isNonEmptyString(value.targetServiceId) || !Array.isArray(value.candidates) || value.candidates.length === 0) return { error: "bootstrap identity and candidates are required" };
  const candidates: AppendCandidate[] = [];
  for (const candidate of value.candidates) {
    if (!isObject(candidate) || !isNonEmptyString(candidate.eventId) || !isNonEmptyString(candidate.suid) || typeof candidate.payload !== "string") return { error: "bootstrap candidate is invalid" };
    const tags = stringArrayFrom(candidate.eventTags, "bootstrap candidate eventTags");
    if (tags.value === undefined || !tags.value.includes(tag) || !isNonEmptyString(candidate.allocatorLineageId)) return { error: "bootstrap candidate must include this tag and lineage" };
    let eventType: string;
    try {
      if (!isNonEmptyString(candidate.eventType)) return { error: "bootstrap candidate eventType is required" };
      eventType = assertCanonicalEventType(candidate.eventType).key;
      assertSortableUniqueId(candidate.suid);
      // C# import records can predate UUID v7. This is confined to the
      // coordinator-only bootstrap route; normal /append remains UUID v7.
      if (!isRfc4122Uuid(candidate.eventId)) return { error: "bootstrap candidate eventId must be an RFC 4122 UUID" };
      JSON.parse(candidate.payload);
    } catch (error) {
      return { error: error instanceof Error ? error.message : "bootstrap candidate identity or payload is invalid" };
    }
    if (candidate.provenance !== "g32") return { error: "bootstrap candidate provenance must be g32" };
    if (!isNonEmptyString(candidate.timestamp) || !CANONICAL_UTC_TIMESTAMP_PATTERN.test(candidate.timestamp)) return { error: "bootstrap candidate timestamp must be canonical UTC" };
    candidates.push({ eventId: candidate.eventId, suid: candidate.suid, payload: candidate.payload, eventTags: tags.value, allocatorLineageId: candidate.allocatorLineageId, eventType, provenance: "g32", timestamp: candidate.timestamp });
  }
  const ordered = [...candidates].sort((a, b) => a.suid < b.suid ? -1 : a.suid > b.suid ? 1 : 0);
  if (ordered.some((candidate, index) => index > 0 && ordered[index - 1]!.suid === candidate.suid)) return { error: "bootstrap SUID values must be unique" };
  return { value: { importId: value.importId, leaseEpoch: value.leaseEpoch, manifestDigest: value.manifestDigest, targetServiceId: value.targetServiceId, candidates: ordered } };
}

function fenceFrom(value: unknown): { value?: FenceInput; error?: string } {
  const epoch = epochFrom(value);
  if (epoch.value === undefined || !isObject(value) || !isNonEmptyString(value.reason)) {
    return { error: epoch.error ?? "reason is required" };
  }
  return { value: { ...epoch.value, reason: value.reason } };
}

function repairScopeItemFrom(value: unknown, tag: string): { value?: RepairScopeItem; error?: string } {
  if (
    !isObject(value) ||
    !isNonEmptyString(value.attemptId) ||
    !isNonEmptyString(value.eventId) ||
    !isNonEmptyString(value.suid) ||
    typeof value.payload !== "string" ||
    !isNonEmptyString(value.allocatorLineageId) ||
    !isNonEmptyString(value.eventType) ||
    value.provenance !== "g32" ||
    !isNonEmptyString(value.timestamp)
  ) {
    return { error: "each repair scope item needs attemptId, eventId, suid, and payload" };
  }
  const eventTags = stringArrayFrom(value.eventTags, "repair eventTags");
  if (eventTags.value === undefined || !eventTags.value.includes(tag)) {
    return { error: eventTags.error ?? "each repair scope item must include this tag" };
  }
  try {
    assertSortableUniqueId(value.suid);
    if (!isUuidV7(value.eventId)) throw new Error("event id");
    assertCanonicalEventType(value.eventType);
    JSON.parse(value.payload);
  } catch {
    return { error: "repair scope item has invalid G32 event identity" };
  }
  return {
    value: {
      attemptId: value.attemptId,
      eventId: value.eventId,
      suid: value.suid,
      payload: value.payload,
      eventTags: eventTags.value,
      allocatorLineageId: value.allocatorLineageId,
      eventType: value.eventType,
      provenance: "g32",
      timestamp: value.timestamp,
    },
  };
}

function repairScopeFrom(value: unknown, tag: string): { value?: RepairScopeItem[]; error?: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: "repair scope must be a non-empty array" };
  }
  const scope: RepairScopeItem[] = [];
  for (const raw of value) {
    const parsed = repairScopeItemFrom(raw, tag);
    if (parsed.value === undefined) {
      return { error: parsed.error };
    }
    scope.push(parsed.value);
  }
  const keys = scope.map(repairScopeKey);
  if (new Set(keys).size !== keys.length) {
    return { error: "repair scope items must be unique" };
  }
  return { value: sortRepairScope(scope) };
}

function repairLeaseFrom(value: unknown): { value?: RepairLeaseInput; error?: string } {
  if (!isObject(value) || !isNonEmptyString(value.owner) || !isEpoch(value.epoch)) {
    return { error: "repair owner and non-negative safe-integer epoch are required" };
  }
  return { value: { owner: value.owner, epoch: value.epoch } };
}

function repairAcquireFrom(value: unknown, tag: string): { value?: RepairAcquireInput; error?: string } {
  if (!isObject(value) || !isNonEmptyString(value.owner)) {
    return { error: "repair owner is required" };
  }
  const leaseMs = value.leaseMs ?? DEFAULT_REPAIR_LEASE_MS;
  if (!isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > MAX_REPAIR_LEASE_MS) {
    return { error: `leaseMs must be a positive safe integer no greater than ${MAX_REPAIR_LEASE_MS}` };
  }
  const scope = repairScopeFrom(value.scope, tag);
  return scope.value === undefined
    ? { error: scope.error }
    : { value: { owner: value.owner, leaseMs, scope: scope.value } };
}

function repairScopeUnionFrom(value: unknown, tag: string): { value?: RepairScopeUnionInput; error?: string } {
  const lease = repairLeaseFrom(value);
  if (lease.value === undefined || !isObject(value)) {
    return { error: lease.error };
  }
  const scope = repairScopeFrom(value.scope, tag);
  return scope.value === undefined ? { error: scope.error } : { value: { ...lease.value, scope: scope.value } };
}

function repairApplyFrom(value: unknown, tag: string): { value?: RepairApplyInput; error?: string } {
  const lease = repairLeaseFrom(value);
  if (lease.value === undefined || !isObject(value)) {
    return { error: lease.error };
  }
  const item = repairScopeItemFrom(value.item, tag);
  return item.value === undefined ? { error: item.error } : { value: { ...lease.value, item: item.value } };
}

function repairAuditFrom(value: unknown, tag: string): { value?: RepairAuditInput; error?: string } {
  const apply = repairApplyFrom(value, tag);
  if (apply.value === undefined || !isObject(value) || !isNonEmptyString(value.actor)) {
    return { error: apply.error ?? "audit actor is required" };
  }
  return { value: { ...apply.value, actor: value.actor } };
}

function repairClearFrom(value: unknown): { value?: RepairClearInput; error?: string } {
  const lease = repairLeaseFrom(value);
  if (
    lease.value === undefined ||
    !isObject(value) ||
    !isNonEmptyString(value.attemptId) ||
    !isNonNegativeInteger(value.scopeVersion)
  ) {
    return { error: lease.error ?? "attemptId and scopeVersion are required" };
  }
  return { value: { ...lease.value, attemptId: value.attemptId, scopeVersion: value.scopeVersion } };
}

function outboxPendingFrom(value: unknown): { value?: OutboxPendingInput; error?: string } {
  if (!isObject(value)) {
    return { error: "outbox pending request must be an object" };
  }
  const nowMs = value.nowMs ?? Date.now();
  if (!isSafeInteger(nowMs)) {
    return { error: "nowMs must be a safe integer when present" };
  }
  const limit = value.limit;
  if (limit !== undefined && (!isNonNegativeInteger(limit) || limit < 1 || limit > OBLIGATION_ALARM_BATCH_LIMIT)) {
    return { error: `limit must be an integer in [1, ${OBLIGATION_ALARM_BATCH_LIMIT}] when present` };
  }
  const force = value.force;
  if (force !== undefined && typeof force !== "boolean") {
    return { error: "force must be boolean when present" };
  }
  return { value: { nowMs, limit, force } };
}

function outboxMarkFrom(value: unknown): { value?: OutboxMarkInput; error?: string } {
  if (!isObject(value) || !Array.isArray(value.deliveries) || value.deliveries.length === 0) {
    return { error: "deliveries must be a non-empty array" };
  }
  const deliveries: OutboxMarkInput["deliveries"] = [];
  for (const raw of value.deliveries) {
    if (
      !isObject(raw) ||
      !isNonEmptyString(raw.attemptId) ||
      !isNonEmptyString(raw.eventId) ||
      !isNonEmptyString(raw.suid) ||
      typeof raw.payload !== "string" ||
      !isSafeInteger(raw.enqueuedAt)
    ) {
      return { error: "each delivery needs attemptId, eventId, suid, payload, and enqueuedAt" };
    }
    if (!isNonEmptyString(raw.eventType) || raw.provenance !== "g32" || !isNonEmptyString(raw.timestamp) || !isNonEmptyString(raw.allocatorLineageId)) return { error: "delivery must carry the complete G32 identity" };
    if (!isObject(raw.completeness)) {
      return { error: "delivery must carry a readable global receipt/membership join proof" };
    }
    const completeness = raw.completeness;
    const obligationSequence = completeness.obligationSequence;
    const memberships = completeness.localCommittedMembership;
    if (!isNonEmptyString(completeness.eventDigest) || !isSafeInteger(obligationSequence) || obligationSequence < 1 ||
      !Array.isArray(memberships) || memberships.length !== 1 || !isObject(memberships[0]) ||
      memberships[0].eventId !== raw.eventId || typeof memberships[0].tag !== "string") {
      return { error: "delivery must carry a readable global receipt/membership join proof" };
    }
    const membership = memberships[0];
    const membershipTag = membership.tag;
    if (typeof membershipTag !== "string") return { error: "delivery must carry a readable global receipt/membership join proof" };
    deliveries.push({
      attemptId: raw.attemptId,
      eventId: raw.eventId,
      suid: raw.suid,
      payload: raw.payload,
      enqueuedAt: raw.enqueuedAt,
      eventType: raw.eventType,
      provenance: "g32",
      timestamp: raw.timestamp,
      allocatorLineageId: raw.allocatorLineageId,
      completeness: {
        eventDigest: completeness.eventDigest,
        obligationSequence,
        canonicalBytesBase64: typeof completeness.canonicalBytesBase64 === "string" ? completeness.canonicalBytesBase64 : "",
        declaredTagSet: Array.isArray(completeness.declaredTagSet)
          ? completeness.declaredTagSet.filter((tag): tag is string => typeof tag === "string")
          : [],
        localCommittedMembership: [{
          serviceId: typeof membership.serviceId === "string" ? membership.serviceId : "",
          eventId: raw.eventId,
          tag: membershipTag,
        }],
      },
    });
  }
  if (new Set(deliveries.map(outboxRowKey)).size !== deliveries.length) {
    return { error: "deliveries must be unique" };
  }
  const nowMs = value.nowMs ?? Date.now();
  if (!isSafeInteger(nowMs)) {
    return { error: "nowMs must be a safe integer when present" };
  }
  return { value: { deliveries, nowMs } };
}

function g44SourceScanFrom(value: unknown): { value?: G44SourceScanInput; error?: string } {
  if (!isObject(value) ||
    !isNonEmptyString(value.serviceId) || !isNonEmptyString(value.tag) ||
    !isSafeInteger(value.upperBoundSequence) || value.upperBoundSequence < 0 ||
    !isSafeInteger(value.afterSequence) || value.afterSequence < 0 ||
    !isSafeInteger(value.limit) || value.limit < 1 || value.limit > 256) {
    return { error: "source scan needs serviceId, tag, and a bounded compound cursor" };
  }
  return {
    value: {
      serviceId: value.serviceId,
      tag: value.tag,
      upperBoundSequence: value.upperBoundSequence,
      afterSequence: value.afterSequence,
      limit: value.limit,
    },
  };
}

function g46TagStateSourceFrom(value: unknown): { value?: G43TagStateIncrementalRequest; error?: string } {
  if (!isObject(value) || !isNonEmptyString(value.tag) || typeof value.cursor !== "string" ||
    !isSafeInteger(value.limit) || value.limit < 1 || value.limit > 256 ||
    (value.through !== undefined && typeof value.through !== "string")) {
    return { error: "G46 source read needs tag, cursor, optional through, and a bounded limit" };
  }
  try {
    if (value.cursor !== "") assertSortableUniqueId(value.cursor);
    if (value.through !== undefined && value.through !== "") assertSortableUniqueId(value.through);
  } catch {
    return { error: "G46 source cursor and frontier must be SortableUniqueIds" };
  }
  return {
    value: {
      tag: value.tag,
      cursor: value.cursor,
      limit: value.limit,
      ...(value.through === undefined ? {} : { through: value.through }),
    },
  };
}

function epochFor(entries: TagEpoch[], attemptId: string): number | undefined {
  return entries.find((entry) => entry.attemptId === attemptId)?.epoch;
}

function withMaxEpoch(entries: TagEpoch[], attemptId: string, epoch: number): TagEpoch[] {
  const existing = epochFor(entries, attemptId);
  if (existing === undefined) {
    return [...entries, { attemptId, epoch }];
  }
  if (existing >= epoch) {
    return entries;
  }
  return entries.map((entry) => (entry.attemptId === attemptId ? { ...entry, epoch } : entry));
}

function fenceFor(entries: TagFence[], reason: string, attemptId: string): TagFence | undefined {
  return entries.find((entry) => entry.reason === reason && entry.attemptId === attemptId);
}

function withFence(entries: TagFence[], fence: TagFence): TagFence[] {
  const existing = fenceFor(entries, fence.reason, fence.attemptId);
  if (existing === undefined) {
    return [...entries, fence];
  }
  return entries.map((entry) =>
    entry.reason === fence.reason && entry.attemptId === fence.attemptId ? fence : entry,
  );
}

function withoutFence(entries: TagFence[], reason: string, attemptId: string): TagFence[] {
  return entries.filter((entry) => entry.reason !== reason || entry.attemptId !== attemptId);
}

function outboxRowKey(row: Pick<TagOutboxRow, "attemptId" | "eventId" | "suid" | "payload" | "eventType" | "provenance" | "timestamp" | "allocatorLineageId">): string {
  return `${row.attemptId}\u0000${row.eventId}\u0000${row.suid}\u0000${row.payload}\u0000${row.eventType}\u0000${row.provenance}\u0000${row.timestamp}\u0000${row.allocatorLineageId}`;
}

function repairScopeKey(item: RepairScopeItem): string {
  return `${item.attemptId}\u0000${item.eventId}\u0000${item.suid}`;
}

function sortRepairScope(scope: RepairScopeItem[]): RepairScopeItem[] {
  return [...scope].sort((left, right) => {
    if (left.suid !== right.suid) {
      return left.suid < right.suid ? -1 : 1;
    }
    const leftKey = repairScopeKey(left);
    const rightKey = repairScopeKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function unionRepairScope(existing: RepairScopeItem[], incoming: RepairScopeItem[]): RepairScopeItem[] {
  const byKey = new Map(existing.map((item) => [repairScopeKey(item), item]));
  for (const item of incoming) {
    const key = repairScopeKey(item);
    const previous = byKey.get(key);
    if (previous !== undefined && (
      previous.payload !== item.payload ||
      previous.eventTags.join("\u0000") !== item.eventTags.join("\u0000")
    )) {
      // A scope cannot silently change the durable candidate it authorizes.
      throw new Error("Repair scope candidate identity conflict");
    }
    byKey.set(key, item);
  }
  return sortRepairScope([...byKey.values()]);
}

function repairScopeContains(scope: RepairScopeItem[], item: RepairScopeItem): boolean {
  return scope.some((candidate) =>
    repairScopeKey(candidate) === repairScopeKey(item) &&
    candidate.payload === item.payload &&
    candidate.eventTags.join("\u0000") === item.eventTags.join("\u0000"),
  );
}

function repairFactsDefault(): RepairFacts {
  return { resolutions: [], audits: [] };
}

function repairResolutionFor(
  facts: RepairFacts,
  item: RepairScopeItem,
): RepairResolution | undefined {
  return facts.resolutions.find((resolution) =>
    resolution.attemptId === item.attemptId &&
    resolution.eventId === item.eventId &&
    resolution.suid === item.suid,
  );
}

function repairAuditFor(facts: RepairFacts, item: RepairScopeItem): RepairAudit | undefined {
  return facts.audits.find((audit) =>
    audit.attemptId === item.attemptId && audit.eventId === item.eventId && audit.suid === item.suid,
  );
}

function hasSegmentRotationFence(record: TagRecord): boolean {
  return record.fences.some((fence) => fence.reason === SEGMENT_ROTATION_FENCE_REASON);
}

function repairLeaseRejection(record: TagRecord, owner: string, epoch: number): string | undefined {
  if (hasSegmentRotationFence(record)) {
    return "segment_rotation_fence_held";
  }
  if (record.repairOwner !== owner) {
    return "repair_owner_mismatch";
  }
  if (record.highestRepairEpoch !== epoch) {
    return epoch < record.highestRepairEpoch ? "stale_repair_epoch" : "repair_epoch_mismatch";
  }
  if (record.repairLeaseUntil === null || logicalNow(record) >= record.repairLeaseUntil) {
    return "repair_lease_expired";
  }
  return undefined;
}

function latestFenceEpoch(record: TagRecord, reason: string, attemptId: string): number | undefined {
  const epochs = [
    fenceFor(record.fences, reason, attemptId)?.epoch,
    fenceFor(record.clearedFences, reason, attemptId)?.epoch,
  ].filter((epoch): epoch is number => epoch !== undefined);
  return epochs.length === 0 ? undefined : Math.max(...epochs);
}

function fenceEpochRejection(record: TagRecord, reason: string, attemptId: string, epoch: number): string | undefined {
  const latest = latestFenceEpoch(record, reason, attemptId);
  return latest !== undefined && epoch < latest ? "stale_epoch" : undefined;
}

function newRecord(tag: string): TagRecord {
  const timestamp = nowIso();
  return {
    schemaVersion: 3,
    tag,
    head: "",
    activeReservation: null,
    alarmDueAt: null,
    events: [],
    outbox: [],
    highestEpoch: [],
    sealedEpoch: [],
    tombstones: [],
    confirmations: [],
    fences: [],
    clearedFences: [],
    bootstrapAdmission: null,
    repairOwner: null,
    repairLeaseUntil: null,
    highestRepairEpoch: 0,
    repairScope: [],
    repairScopeVersion: 0,
    clockOffsetMs: 0,
    clockNowMs: null,
    version: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** No pre-G32 Tag state is migrated or interpreted after the cutover. */
function requireG32TagRecord(record: TagRecord): TagRecord {
  if (record.schemaVersion !== 3) {
    throw new Error("G32 Tag Durable Object requires a fresh cutover namespace");
  }
  for (const event of record.events) {
    assertSortableUniqueId(event.suid);
    if (!isRfc4122Uuid(event.eventId) || event.provenance !== "g32") {
      throw new Error("G32 Tag Durable Object refuses a legacy durable event");
    }
  }
  return record;
}

function changed(record: TagRecord, updates: Partial<TagRecord>): TagRecord {
  return {
    ...record,
    ...updates,
    version: record.version + 1,
    updatedAt: nowIso(),
  };
}

function logicalNow(record: TagRecord): number {
  return record.clockNowMs ?? Date.now() + record.clockOffsetMs;
}

function expireReservation(record: TagRecord): ExpiryResult {
  const active = record.activeReservation;
  if (active === null || active.expiresAt > logicalNow(record)) {
    return { record, expired: false };
  }
  return {
    record: { ...record, activeReservation: null, alarmDueAt: null },
    expired: true,
  };
}

function advanceEpoch(record: TagRecord, attemptId: string, epoch: number): TagRecord {
  return {
    ...record,
    highestEpoch: withMaxEpoch(record.highestEpoch, attemptId, epoch),
  };
}

function basicEpochRejection(record: TagRecord, attemptId: string, epoch: number): string | undefined {
  const highest = epochFor(record.highestEpoch, attemptId);
  return highest !== undefined && epoch < highest ? "stale_epoch" : undefined;
}

function operationEpochRejection(record: TagRecord, attemptId: string, epoch: number): string | undefined {
  const stale = basicEpochRejection(record, attemptId, epoch);
  if (stale !== undefined) {
    return stale;
  }
  const tombstone = epochFor(record.tombstones, attemptId);
  if (tombstone !== undefined && epoch <= tombstone) {
    return "tombstoned_epoch";
  }
  const sealed = epochFor(record.sealedEpoch, attemptId);
  if (sealed !== undefined && epoch <= sealed) {
    return "sealed_epoch";
  }
  return undefined;
}

function candidateIsExactDuplicate(record: TagRecord, attemptId: string, candidate: AppendCandidate): boolean {
  return record.events.some(
    (event) =>
      event.attemptId === attemptId &&
      event.eventId === candidate.eventId &&
      event.suid === candidate.suid &&
      event.payload === candidate.payload &&
      event.eventType === candidate.eventType &&
      event.provenance === candidate.provenance &&
      event.timestamp === candidate.timestamp,
  );
}

function batchIsExactDuplicate(record: TagRecord, input: AppendInput): boolean {
  return input.candidates.every((candidate) => candidateIsExactDuplicate(record, input.attemptId, candidate));
}

function hasEventConflict(record: TagRecord, candidates: AppendCandidate[]): boolean {
  return candidates.some((candidate) => record.events.some((event) =>
    event.eventId === candidate.eventId && !(
      event.suid === candidate.suid &&
      event.payload === candidate.payload &&
      event.eventType === candidate.eventType &&
      event.provenance === candidate.provenance &&
      event.timestamp === candidate.timestamp
    ),
  ));
}

function monotonicityViolation(head: string, candidates: AppendCandidate[]): boolean {
  let previous = head;
  for (const candidate of candidates) {
    if (candidate.suid <= previous) {
      return true;
    }
    previous = candidate.suid;
  }
  return false;
}

/** Retained control-plane observability from G3; it never substitutes for the gate. */
function inspectFenceGate(record: TagRecord, attemptId: string): FenceGateObservation {
  return {
    checked: true,
    activeFenceCount: record.fences.filter((fence) => fence.attemptId === attemptId).length,
  };
}

/** The gate is closed by any durable fence, regardless of its owner. */
function isFenceGateClosed(record: TagRecord): boolean {
  return record.fences.length > 0;
}

function fenceGateRejected(): OperationResult {
  return {
    status: 500,
    body: {
      error: "Tag writes are unavailable while a durable repair fence is held",
      code: "internal_error",
    },
  };
}

/**
 * Rotation is intentionally only a fence-level interface in SDT-G5. A
 * partial repair cannot jump an earlier rotation fence, and a held partial
 * repair lease prevents a new rotation start. SDT-G6 owns rotation itself.
 */
function overlappingFenceReason(record: TagRecord, reason: string): string | undefined {
  if (reason === PARTIAL_WRITE_FENCE_REASON && record.fences.some((fence) =>
    fence.reason === SEGMENT_ROTATION_FENCE_REASON,
  )) {
    return SEGMENT_ROTATION_FENCE_REASON;
  }
  if (reason === SEGMENT_ROTATION_FENCE_REASON && record.fences.some((fence) =>
    fence.reason === PARTIAL_WRITE_FENCE_REASON,
  )) {
    return PARTIAL_WRITE_FENCE_REASON;
  }
  return undefined;
}

export class TagDurableObject implements DurableObject {
  /** Constructor-scoped observation only; never persisted or used for control. */
  private readonly activation = new DurableObjectActivation();
  /**
   * Direct unit seams intentionally omit `storage.sql`. They exercise
   * transport behavior only; deployed and Miniflare Tag DOs always use the
   * normalized SQL path. Keeping this ephemeral fallback out of durable KV
   * prevents a TAG_KEY record from remaining a second source of truth.
   */
  private fallbackRecord: TagRecord | undefined;
  private fallbackOutboxDeliveries: TagOutboxDelivery[] = [];
  /** Ephemeral test/evidence seam; never exposed as an HTTP route or stored. */
  private g43SqlMeasurement: G43SqlMeasurement | undefined;
  /** Exercises alarm crash boundaries without adding a production control path. */
  private g43SchedulerFault: "before-rearm" | "after-rearm" | undefined;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: TagDurableObjectEnv,
    private readonly nativeTracing: NativeTracing = noOpNativeTracing,
  ) {
    const sql = this.sqlStorage();
    if (sql !== undefined) initializeTagSqlSchema(sql);
  }

  async fetch(request: Request): Promise<Response> {
    // Flip before this handler performs its first await.
    const activation = this.activation.beginHandler();
    const observation = beginDurableObjectHandlerObservation("TAG", activation);
    const url = new URL(request.url);
    const tag = url.searchParams.get("__tag");
    if (!isNonEmptyString(tag)) {
      return error(400, "tag_identity_required", "Tag identity is required");
    }
    const serviceId = url.searchParams.get("__serviceId");
    if (request.method === "GET" && url.pathname === "/head-facts") {
      return this.traceCommitReadActor(request, tag, serviceId, activation, observation, async () => {
        observation.markFirstStorageRead();
        try {
          const facts = this.readHeadFacts(tag);
          return facts === undefined
            ? error(404, "tag_not_found", "Tag has no durable state yet")
            : json(facts);
        } catch (caught) {
          if (caught instanceof TagIdentityConflict) {
            return error(409, "tag_identity_conflict", "Tag Durable Object identity changed");
          }
          throw caught;
        }
      });
    }
    if (request.method === "GET" && url.pathname === "/state") {
      return this.traceCommitReadActor(request, tag, serviceId, activation, observation, async () => {
        observation.markFirstStorageRead();
        const record = this.readStoredRecord(tag);
        if (record === undefined) {
          return error(404, "tag_not_found", "Tag has no durable state yet");
        }
        return record.tag === tag
          ? json(requireG32TagRecord(record))
          : error(409, "tag_identity_conflict", "Tag Durable Object identity changed");
      });
    }
    if (request.method === "GET" && url.pathname === "/repair/facts") {
      return this.repairFacts(tag);
    }
    if (request.method === "POST" && url.pathname === "/debug/alarm") {
      const record = await this.runAlarm();
      return record === undefined ? error(404, "tag_not_found", "Tag has no durable state yet") : json(record);
    }

    if (request.method === "POST" && url.pathname === "/acquire") {
      return this.traceCommitActor(request, tag, serviceId, activation, observation, (body) => this.acquire(tag, body, observation));
    }
    if (request.method === "POST" && url.pathname === "/cancel") {
      return this.traceCommitActor(request, tag, serviceId, activation, observation, (body) => this.cancel(tag, body, observation));
    }
    if (request.method === "POST" && url.pathname === "/seal") {
      return this.traceCommitActor(request, tag, serviceId, activation, observation, (body) => this.seal(tag, body, observation));
    }
    if (request.method === "POST" && url.pathname === "/append") {
      return this.traceCommitActor(
        request,
        tag,
        serviceId,
        activation,
        observation,
        (body) => this.append(tag, body, serviceId, url.searchParams.get("__domainDeliveryClass") ?? undefined, observation),
      );
    }

    const body = await this.jsonBody(request);
    if (body === undefined) {
      return error(400, "malformed_tag_request", "Request body must be JSON");
    }
    if (request.method === "POST" && url.pathname === "/__internal/g70/issuance-status") {
      if (request.headers.get("x-sdt-g70-recovery") !== "1") {
        return error(403, "g70_recovery_forbidden", "G70 recovery requires the allocator seam");
      }
      return this.issuanceStatus(tag, serviceId, body);
    }
    // The portable runtime cannot rely on the Cloudflare native-RPC class
    // brand, so TagStateDO reaches this *direct DO* adapter by stub.fetch.
    // It is deliberately not routed from the Worker and calls the one G43
    // bounded source method below; /state and the linear rebuild stay out of
    // the TagState call universe.
    if (request.method === "POST" && url.pathname === "/__internal/g46/tag-state-incremental") {
      if (request.headers.get("x-sdt-g46-source-read") !== "1") {
        return error(403, "g46_source_read_forbidden", "G46 source reads require the TagState adapter");
      }
      const parsed = g46TagStateSourceFrom(body);
      if (parsed.value === undefined || parsed.value.tag !== tag) {
        return error(400, "g46_source_read_invalid", parsed.error ?? "G46 source read is invalid");
      }
      try {
        return json(await this.g43TagStateIncrementalCatchUp(parsed.value));
      } catch (caught) {
        if (caught instanceof TagIdentityConflict) {
          return error(409, "tag_identity_conflict", "Tag Durable Object identity changed");
        }
        return error(503, "g46_source_read_unavailable", caught instanceof Error ? caught.message : "G46 source read is unavailable");
      }
    }
    // This is an internal Tag-to-scanner seam, not a Worker route or a
    // role-facing API. The scanner fixes its vector cursor from D1 before
    // calling it; Queue state and public delivery endpoints never enter it.
    if (request.method === "POST" && url.pathname === "/__internal/g44/source-obligations") {
      if (request.headers.get("x-sdt-g44-source-scan") !== "1") {
        return error(403, "g44_source_scan_forbidden", "G44 source scan requires the internal scanner seam");
      }
      const parsed = g44SourceScanFrom(body);
      if (parsed.value === undefined || parsed.value.tag !== tag || parsed.value.serviceId !== serviceId) {
        return error(400, "g44_source_scan_invalid", parsed.error ?? "G44 source scan identity is invalid");
      }
      try {
        return json(await this.g44ReadSourceObligations(parsed.value));
      } catch (failure) {
        return error(503, "g44_source_scan_unavailable", failure instanceof Error ? failure.message : "G44 source scan is unavailable");
      }
    }
    if (request.method === "POST" && url.pathname === "/bootstrap/admit") {
      return this.bootstrapAppend(tag, body, url.searchParams.get("__serviceId"));
    }
    if (request.method === "POST" && url.pathname === "/bootstrap/close") {
      return this.closeBootstrap(tag, body);
    }
    if (request.method === "POST" && url.pathname === "/outbox/pending") {
      return this.pendingOutbox(tag, url.searchParams.get("__serviceId"), body);
    }
    if (request.method === "POST" && url.pathname === "/outbox/mark-delivered") {
      return this.markOutboxDelivered(tag, body);
    }
    if (request.method === "POST" && url.pathname === "/confirm") {
      return this.confirm(tag, body);
    }
    if (request.method === "POST" && url.pathname === "/fence/install") {
      return this.installFence(tag, body);
    }
    if (request.method === "POST" && url.pathname === "/fence/clear") {
      return this.clearFence(tag, body);
    }
    if (request.method === "POST" && url.pathname === "/repair/acquire") {
      return this.acquireRepairLease(tag, body);
    }
    if (request.method === "POST" && url.pathname === "/repair/renew") {
      return this.renewRepairLease(tag, body);
    }
    if (request.method === "POST" && url.pathname === "/repair/scope-union") {
      return this.unionRepairScope(tag, body);
    }
    if (request.method === "POST" && url.pathname === "/repair/apply") {
      return this.applyRepair(tag, body);
    }
    if (request.method === "POST" && url.pathname === "/repair/audit") {
      return this.auditRepair(tag, body);
    }
    if (request.method === "POST" && url.pathname === "/repair/clear") {
      return this.clearRepairFence(tag, body);
    }
    if (request.method === "POST" && url.pathname === "/debug/clock") {
      return this.setClockOffset(tag, body);
    }
    return error(404, "tag_route_not_found", "Tag route was not found");
  }

  async alarm(): Promise<void> {
    this.activation.beginHandler();
    await this.runAlarm();
  }

  /**
   * Structural-measurement seam used around a real handler request. The
   * production wire cannot start it, and it neither changes control flow nor
   * persists instrumentation. Completion is intentionally separate so the
   * caller can first consume the response body (the specified boundary).
   */
  beginG43SqlMeasurement(): void {
    if (this.g43SqlMeasurement !== undefined) throw new Error("G43 SQL measurement is already active");
    this.g43SqlMeasurement = new G43SqlMeasurement();
  }

  completeG43SqlMeasurement(): G43SqlMeasurementSnapshot {
    const measurement = this.g43SqlMeasurement;
    if (measurement === undefined) throw new Error("G43 SQL measurement is not active");
    this.g43SqlMeasurement = undefined;
    return measurement.complete();
  }

  /** Test-only fault seam for AC6's transactional re-arm crash boundaries. */
  setG43SchedulerFaultForTest(fault: "before-rearm" | "after-rearm" | undefined): void {
    this.g43SchedulerFault = fault;
  }

  /**
   * Bounded source seam for the normal incremental TagState source read. Its
   * direct-DO adapter above is transport-only; this method remains the one
   * authority for cursor range reads and frozen-frontier completion.
   */
  async g43ReadAfter(sortableUniqueId: string, limit: number, through?: string): Promise<TagEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("G43 readAfter limit must be a positive safe integer");
    if (sortableUniqueId !== "") assertSortableUniqueId(sortableUniqueId);
    if (through !== undefined && through !== "") assertSortableUniqueId(through);
    if (through !== undefined && sortableUniqueId !== "" && through !== "" && compareSortableUniqueId(sortableUniqueId, through) > 0) {
      throw new Error("G43 readAfter cursor cannot exceed its frozen frontier");
    }
    const sql = this.sqlStorage();
    if (sql === undefined) return [];
    if (through === "") return [];
    return sql.exec<SqlRow>(through === undefined ? TAG_READ_AFTER_SQL : TAG_READ_AFTER_THROUGH_SQL,
      ...(through === undefined ? [sortableUniqueId, limit] : [sortableUniqueId, through, limit]))
      .toArray()
      .map((row) => sqlJson<TagEvent>(row.event_json, "tag_event.event_json"));
  }

  /**
   * The bounded normal projection source operation: it reads only events
   * newer than the supplied checkpoint and folds the fixed result window in
   * memory. No existing history is reread.
   */
  async g43TagStateIncrementalCatchUp(input: G43TagStateIncrementalRequest): Promise<G43TagStateIncrementalPage> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new Error("G43 TagState incremental limit must be a positive safe integer");
    }
    if (input.cursor !== "") assertSortableUniqueId(input.cursor);
    if (input.through !== undefined && input.through !== "") assertSortableUniqueId(input.through);

    // Always read scalar head facts at this boundary. The first page uses the
    // checked head as its immutable frontier; later pages keep checking the
    // same identity/control/head invariant without moving that frontier as
    // concurrent appends advance the current Tag head.
    const facts = this.readHeadFacts(input.tag);
    if (facts === undefined && input.through !== undefined && input.through !== "") {
      throw new Error("G43 TagState source disappeared before its frozen frontier completed");
    }
    const through = input.through ?? facts?.head ?? "";
    if (facts !== undefined && through !== "" && facts.head !== "" && compareSortableUniqueId(facts.head, through) < 0) {
      throw new Error("G43 TagState frozen frontier is ahead of Tag head facts");
    }
    if (through !== "" && input.cursor !== "" && compareSortableUniqueId(input.cursor, through) > 0) {
      throw new Error("G43 TagState cursor cannot exceed its frozen frontier");
    }
    const events = await this.g43ReadAfter(input.cursor, input.limit, through);
    let lastSortableUniqueId = input.cursor;
    for (const event of events) lastSortableUniqueId = event.suid;
    const complete = events.length < input.limit || lastSortableUniqueId === through;
    return {
      events,
      lastSortableUniqueId,
      through,
      completeThrough: complete ? through : null,
    };
  }

  /** Full replay remains intentionally linear and is measurement-only info. */
  async g43TagStateRebuild(): Promise<readonly TagEvent[]> {
    const sql = this.sqlStorage();
    if (sql === undefined) return [];
    return sql.exec<SqlRow>("SELECT event_json FROM tag_event ORDER BY suid ASC")
      .toArray()
      .map((row) => sqlJson<TagEvent>(row.event_json, "tag_event.event_json"));
  }

  /**
   * Internal source-authority scanner for the G43 obligation seam.  This is
   * intentionally a DO RPC surface rather than a Worker route: it adds no
   * role-facing HTTP API, and it does not share Queue/doorbell failure paths.
   */
  async g43ScanSourceObligations(tag: string, nowMs: number): Promise<unknown> {
    if (!isSafeInteger(nowMs)) throw new Error("G43 source scan time must be a safe integer");
    const response = await this.scanOutboxObligations(tag, nowMs);
    if (!response.ok) throw new Error(`G43 source scan failed with ${response.status}`);
    return response.json();
  }

  /**
   * G44's private source scanner RPC. It exposes only the normalized source
   * obligation table, never Queue state or a role-facing Worker route. The
   * caller fixes `upperBoundSequence` from the source partition registry
   * before paging, so later commits cannot move a scan frontier mid-pass.
   */
  async g44ReadSourceObligations(input: Readonly<{
    serviceId: string;
    tag: string;
    upperBoundSequence: number;
    afterSequence: number;
    limit: number;
  }>): Promise<SourceObligationPage> {
    if (!isNonEmptyString(input.serviceId) || !isNonEmptyString(input.tag) ||
      !isSafeInteger(input.upperBoundSequence) || input.upperBoundSequence < 0 ||
      !isSafeInteger(input.afterSequence) || input.afterSequence < 0 ||
      !isSafeInteger(input.limit) || input.limit < 1 || input.limit > 256) {
      throw new Error("g44_source_scan_invalid_cursor");
    }
    const sql = this.sqlStorage();
    if (sql === undefined) throw new Error("g44_source_scan_sql_unavailable");
    const identity = sql.exec<SqlRow>("SELECT tag FROM tag_identity WHERE singleton = 1").toArray()[0];
    if (identity === undefined || sqlString(identity.tag, "tag_identity.tag") !== input.tag) {
      throw new Error("g44_source_scan_partition_unreadable");
    }
    const maxRow = sql.exec<SqlRow>(
      "SELECT MAX(obligation_sequence) AS sequence FROM tag_outbox_obligation WHERE service_id = ?",
      input.serviceId,
    ).toArray()[0];
    const observedMaxSequence = maxRow === undefined || maxRow.sequence === null
      ? 0
      : sqlNumber(maxRow.sequence, "tag_outbox_obligation.max_sequence");
    if (observedMaxSequence < input.upperBoundSequence) {
      throw new Error("g44_source_scan_snapshot_unreadable");
    }
    const rawRows = sql.exec<SqlRow>(`
      SELECT obligation_sequence, event_id, event_digest, canonical_bytes,
             declared_tag_set_json, local_committed_membership_json, status
        FROM tag_outbox_obligation
       WHERE service_id = ?
         AND obligation_sequence > ?
         AND obligation_sequence <= ?
       ORDER BY obligation_sequence ASC
       LIMIT ?
    `, input.serviceId, input.afterSequence, input.upperBoundSequence, input.limit + 1).toArray();
    const hasMore = rawRows.length > input.limit;
    const rows = rawRows.slice(0, input.limit).map((row) => ({
      obligationSequence: sqlNumber(row.obligation_sequence, "tag_outbox_obligation.obligation_sequence"),
      eventId: sqlString(row.event_id, "tag_outbox_obligation.event_id"),
      eventDigest: sqlString(row.event_digest, "tag_outbox_obligation.event_digest"),
      canonicalBytesBase64: arrayBufferBase64(sqlArrayBuffer(row.canonical_bytes, "tag_outbox_obligation.canonical_bytes")),
      declaredTagSet: sqlJson<string[]>(row.declared_tag_set_json, "tag_outbox_obligation.declared_tag_set_json"),
      localCommittedMembership: sqlJson<Array<{ serviceId: string; eventId: string; tag: string }>>(
        row.local_committed_membership_json,
        "tag_outbox_obligation.local_committed_membership_json",
      ),
      status: sqlString(row.status, "tag_outbox_obligation.status") as "pending" | "acknowledged" | "poison",
    }));
    return {
      serviceId: input.serviceId,
      tag: input.tag,
      upperBoundSequence: input.upperBoundSequence,
      observedMaxSequence,
      afterSequence: input.afterSequence,
      rows,
      hasMore,
    };
  }

  /**
   * G44's source acknowledgement guard. A transport success or an unjoined
   * receipt is deliberately insufficient: the global event, local membership
   * and exact source-obligation receipt must all be readable together.
   */
  private async globalReceiptMatches(delivery: OutboxMarkInput["deliveries"][number]): Promise<boolean> {
    // The generic runtime's SQLite test harness is not a global D1 event
    // array at all.  Every actual G32/G44 source has the `dcb_events` shape;
    // only that authority may turn a source mark into an acknowledgement.
    // A partially migrated G32 array still throws from this probe and is
    // therefore fail-closed in the caller below.
    if (!(await this.hasG44GlobalArrayAuthority())) return true;
    const database = this.env.D1;
    if (database === undefined) return false;
    const membership = delivery.completeness.localCommittedMembership[0];
    if (membership === undefined) return false;
    const row = await database.prepare(
      `SELECT 1 AS joined
         FROM serialized_dcb_global_receipts AS receipt
         JOIN serialized_dcb_global_memberships AS membership
           ON membership.service_id = receipt.service_id
          AND membership.event_id = receipt.event_id
          AND membership.partition_tag = receipt.membership_tag
          AND membership.event_digest = receipt.event_digest
         JOIN dcb_events AS event
           ON event."ServiceId" = receipt.service_id
          AND event."Id" = receipt.event_id
          AND event."EventDigest" = receipt.event_digest
        WHERE receipt.service_id = ?
          AND receipt.partition_tag = ?
          AND receipt.obligation_sequence = ?
          AND receipt.event_id = ?
          AND receipt.event_digest = ?
          AND receipt.membership_tag = ?
          AND membership.partition_tag = ?`,
    ).bind(
      membership.serviceId,
      membership.tag,
      delivery.completeness.obligationSequence,
      delivery.eventId,
      delivery.completeness.eventDigest,
      membership.tag,
      membership.tag,
    ).first<{ joined?: unknown }>();
    return row !== null && row !== undefined && row.joined === 1;
  }

  /**
   * The first append on a Tag must make its source partition enumerable before
   * the local event transaction starts. Once the local marker is registered,
   * later appends never consult or await D1 for this fact; Queue admission is
   * responsible for advancing the registered obligation sequence.
   */
  private async ensureSourcePartitionBeforeFirstAppend(
    tag: string,
    serviceId: string,
  ): Promise<"existing" | "newly-registered" | "unconfigured"> {
    if (this.sourcePartitionRegistrationStatus(tag, serviceId) === "registered") return "existing";
    // A generic/local composition can use the SQL-backed Tag without wiring
    // the G44 completeness store. That is the pre-G65 path: there is no
    // registration work to wait for, and the durable local append remains
    // authoritative. Only a binding that proves the G44 global-array schema
    // is present enters the first-partition refusal contract below.
    if (this.env.D1 === undefined) return "unconfigured";
    if (g44GlobalArrayAuthorityResultByD1.get(this.env.D1) === false) return "unconfigured";
    const attempt = await this.boundedDerivedWrite(() => this.registerSourcePartition(tag, serviceId, 0));
    if (attempt.status !== "completed") {
      throw new PartitionRegistrationUnavailableError(
        attempt.status === "timeout" ? "timeout" : attempt.error,
      );
    }
    if (!attempt.value) return "unconfigured";
    await this.markSourcePartitionRegistration(tag, serviceId, "registered", undefined, undefined, 0);
    return "newly-registered";
  }

  private sourcePartitionRegistrationStatus(tag: string, serviceId: string): string | undefined {
    const sql = this.sqlStorage();
    if (sql === undefined) return undefined;
    const row = sql.exec<SqlRow>(`
      SELECT status
        FROM tag_source_partition_registration
       WHERE service_id = ? AND partition_tag = ?
    `, serviceId, tag).toArray()[0];
    return row === undefined ? undefined : sqlString(row.status, "tag_source_partition_registration.status");
  }

  /**
   * Refreshes the already-authorized source row with the committed local
   * obligation sequence without putting D1 back on the response path. The
   * first-append authority check above is the only registration operation that
   * may refuse a commit; this post-append watermark is Queue/retry recovery
   * work and is deliberately handed to waitUntil.
   */
  private scheduleSourcePartitionWatermark(tag: string, serviceId: string): void {
    const refresh = this.retrySourcePartitionRegistration(tag, serviceId, true).catch((failure) => {
      console.warn("source_partition_registration", {
        status: "degraded",
        reason: "source_partition_registration_exhausted",
        attempts: G65_SOURCE_REGISTRATION_MAX_ATTEMPTS,
        error: String(failure),
      });
    });
    this.ctx.waitUntil(refresh);
  }

  private async retrySourcePartitionRegistration(tag: string, serviceId: string, preserveRegistered = false): Promise<void> {
    let lastFailure: string | undefined;
    for (let attempt = 1; attempt <= G65_SOURCE_REGISTRATION_MAX_ATTEMPTS; attempt += 1) {
      const result = await this.boundedDerivedWrite(() => this.registerSourcePartition(tag, serviceId));
      if (result.status === "completed") {
        // A D1 binding without the G44 global-array schema is an explicitly
        // unconfigured completeness store, not a failed registration. Do not
        // create pending retry state for that composition. The local marker is
        // still recorded after the durable append so the scheduler retains its
        // pre-G65 source bookkeeping; it is not a D1 registration or a
        // response-path wait.
        if (!result.value) {
          await this.markSourcePartitionRegistration(tag, serviceId, "registered");
          return;
        }
        await this.markSourcePartitionRegistration(tag, serviceId, "registered");
        return;
      }
      lastFailure = result.status === "timeout" ? "timeout" : String(result.error);
      if (attempt < G65_SOURCE_REGISTRATION_MAX_ATTEMPTS) {
        await new Promise<void>((resolve) => setTimeout(resolve, G65_SOURCE_REGISTRATION_RETRY_DELAY_MS * attempt));
      }
    }
    if (!preserveRegistered || this.sourcePartitionRegistrationStatus(tag, serviceId) !== "registered") {
      await this.markSourcePartitionRegistration(
        tag,
        serviceId,
        "pending",
        lastFailure ?? "unknown",
        Date.now() + G65_SOURCE_REGISTRATION_RETRY_DELAY_MS * G65_SOURCE_REGISTRATION_MAX_ATTEMPTS,
      );
    }
    throw new Error(`source_partition_registration_failed:${lastFailure ?? "unknown"}`);
  }

  private async markSourcePartitionRegistration(
    tag: string,
    serviceId: string,
    status: "pending" | "registered",
    lastError?: string,
    nextAttemptAt?: number,
    lastObligationSequence = 0,
  ): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const sql = this.sqlStorage();
      if (sql === undefined) return;
      sql.exec(`
        INSERT INTO tag_source_partition_registration
          (service_id, partition_tag, last_obligation_sequence, status, next_attempt_at, attempt_count, last_error)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (service_id, partition_tag) DO UPDATE SET
          last_obligation_sequence = MAX(
            tag_source_partition_registration.last_obligation_sequence,
            excluded.last_obligation_sequence
          ),
          status = excluded.status,
          next_attempt_at = excluded.next_attempt_at,
          attempt_count = excluded.attempt_count,
          last_error = excluded.last_error
      `, serviceId, tag, lastObligationSequence, status,
      status === "pending" ? (nextAttemptAt ?? Date.now()) : null,
      status === "pending" ? 1 : 0,
      status === "pending" ? (lastError ?? null) : null);
      const dueAt = this.nextSqlAlarmDue();
      if (dueAt === null) await txn.deleteAlarm();
      else await txn.setAlarm(dueAt);
    });
  }

  private async registerSourcePartition(
    tag: string,
    serviceId: string,
    requestedSequence?: number,
  ): Promise<boolean> {
    // G44 is the D1 global-array implementation, not a rollout or
    // mixed-version mode. A non-G32 D1 harness has no global `dcb_events`
    // array at all; every actual G32/G44 D1-backed Tag commit registers its
    // partition, and a partially migrated G32 array fails closed below.
    const database = this.env.D1;
    if (database === undefined) return false;
    if (!(await this.hasG44GlobalArrayAuthority())) return false;
    const sql = this.sqlStorage();
    if (sql === undefined) {
      throw new Error("g44_source_partition_registry_requires_sql_tag");
    }
    const max = requestedSequence === undefined
      ? sql.exec<SqlRow>(
        "SELECT MAX(obligation_sequence) AS sequence FROM tag_outbox_obligation WHERE service_id = ?",
        serviceId,
      ).toArray()[0]
      : undefined;
    const sequence = requestedSequence ??
      (max === undefined || max.sequence === null ? undefined : sqlNumber(max.sequence, "tag_outbox_obligation.max_sequence"));
    if (sequence === undefined) return true;
    await database.prepare(
      `INSERT INTO serialized_dcb_source_partitions
         (service_id, partition_tag, last_obligation_sequence, registered_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (service_id, partition_tag) DO UPDATE
         SET last_obligation_sequence = MAX(
               serialized_dcb_source_partitions.last_obligation_sequence,
               excluded.last_obligation_sequence
             ),
             registered_at = excluded.registered_at`,
    ).bind(serviceId, tag, sequence, Date.now()).run();
    return true;
  }

  private async hasG44GlobalArrayAuthority(): Promise<boolean> {
    const database = this.env.D1;
    if (database === undefined) return false;
    // The generic root Worker has a pre-G32 local D1 harness. It is not the
    // `dcb_events` global array. Cache this immutable schema probe by binding,
    // rather than repeating it once for every independent Tag DO.
    let authority = g44GlobalArrayAuthorityByD1.get(database);
    if (authority === undefined) {
      authority = this.readG44GlobalArrayAuthority(database);
      g44GlobalArrayAuthorityByD1.set(database, authority);
    }
    try {
      const result = await authority;
      g44GlobalArrayAuthorityResultByD1.set(database, result);
      return result;
    } catch (error) {
      if (g44GlobalArrayAuthorityByD1.get(database) === authority) {
        g44GlobalArrayAuthorityByD1.delete(database);
      }
      throw error;
    }
  }

  private async readG44GlobalArrayAuthority(database: D1Database): Promise<boolean> {
    try {
      // `dcb_events.EventDigest` is introduced by G44's ordinary migration.
      // The root unit-test Worker has a distinct pre-G32 D1 schema and no
      // global-array completeness store; it is not a configured source
      // registry. A missing table or column therefore selects the unchanged
      // local-append path. Any other error, including a configured store that
      // hangs or fails, is deliberately surfaced to the bounded first-write
      // refusal path.
      await database.prepare('SELECT "EventDigest" FROM dcb_events WHERE 1 = 0').all();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no such (?:table|column):\s*(?:dcb_events|EventDigest)/i.test(message)) return false;
      throw error;
    }
  }

  private async traceCommitActor(
    request: Request,
    tag: string,
    serviceId: string | null,
    activation: DurableObjectActivationObservation,
    observation: DurableObjectHandlerObservation,
    callback: (body: unknown) => Promise<Response>,
  ): Promise<Response> {
    // S16 identity and the mutation use one parsed body. Reading a clone for
    // attribution and the original for behavior creates a second DO request
    // stream that can race response teardown in a parallel workerd pool.
    let body: unknown | undefined;
    return enterNativeActorHandleSpan(
      this.nativeTracing,
      { actorClass: "TAG", actorKey: `tag:${serviceId}:${tag}`, activation, observation },
      async () => {
        body = await this.jsonBody(request);
        const attemptId = isObject(body) && isNonEmptyString(body.attemptId) ? body.attemptId : undefined;
        return attemptId === undefined || !isNonEmptyString(serviceId)
          ? undefined
          : { attemptId, serviceId };
      },
      async () => body === undefined
        ? error(400, "malformed_tag_request", "Request body must be JSON")
        : callback(body),
    );
  }

  /**
   * Internal Tag reads keep their Cloudflare parent solely from active async
   * context; G30 does not add a correlation header or alter either /state or
   * /head-facts just to label telemetry.
   */
  private async traceCommitReadActor(
    request: Request,
    tag: string,
    serviceId: string | null,
    activation: DurableObjectActivationObservation,
    observation: DurableObjectHandlerObservation,
    callback: () => Promise<Response>,
  ): Promise<Response> {
    return enterNativeActorHandleSpan(
      this.nativeTracing,
      { actorClass: "TAG", actorKey: `tag:${serviceId}:${tag}`, activation, observation },
      async () => undefined,
      callback,
    );
  }

  private async jsonBody(request: Pick<Request, "json">): Promise<unknown | undefined> {
    try {
      return await request.json<unknown>();
    } catch {
      return undefined;
    }
  }

  private sqlStorage(): SqlStorage | undefined {
    const sql = hasTagSqlStorage(this.ctx.storage) ? this.ctx.storage.sql : undefined;
    return sql === undefined ? undefined : this.g43SqlMeasurement?.instrument(sql) ?? sql;
  }

  /**
   * Rehydrate the legacy response shape only at a state/read boundary.  The
   * append path below deliberately does not call this method: it reads the
   * head and candidate identities by index instead of deserializing history.
   */
  private readStoredRecord(tag: string): TagRecord | undefined {
    const sql = this.sqlStorage();
    if (sql === undefined) {
      if (this.fallbackRecord !== undefined && this.fallbackRecord.tag !== tag) {
        throw new Error("Tag Durable Object identity changed");
      }
      return this.fallbackRecord;
    }

    const identity = sql.exec<SqlRow>("SELECT tag, created_at FROM tag_identity WHERE singleton = 1").toArray()[0];
    if (identity === undefined) return undefined;
    if (sqlString(identity.tag, "tag_identity.tag") !== tag) {
      throw new Error("Tag Durable Object identity changed");
    }
    const control = sql.exec<SqlRow>("SELECT * FROM tag_control WHERE singleton = 1").toArray()[0];
    if (control === undefined) throw new Error("Tag SQL identity exists without control state");

    const head = sql.exec<SqlRow>("SELECT head_suid FROM tag_head WHERE singleton = 1").toArray()[0];
    if (head !== undefined && sqlString(head.head_suid, "tag_head.head_suid") !== sqlString(control.head_suid, "tag_control.head_suid")) {
      throw new Error("Tag SQL head/control mismatch");
    }

    const reservationRow = sql.exec<SqlRow>("SELECT * FROM tag_reservation WHERE singleton = 1").toArray()[0];
    const activeReservation: TagReservation | null = reservationRow === undefined
      ? null
      : {
        attemptId: sqlString(reservationRow.attempt_id, "tag_reservation.attempt_id"),
        epoch: sqlNumber(reservationRow.epoch, "tag_reservation.epoch"),
        token: sqlString(reservationRow.reservation_token, "tag_reservation.reservation_token"),
        expectedHead: sqlString(reservationRow.expected_head, "tag_reservation.expected_head"),
        expiresAt: sqlNumber(reservationRow.expires_at, "tag_reservation.expires_at"),
        alarmDueAt: sqlNumber(reservationRow.alarm_due_at, "tag_reservation.alarm_due_at"),
      };

    const events = sql.exec<SqlRow>("SELECT event_json FROM tag_event ORDER BY suid ASC").toArray().map((row) => sqlJson<TagEvent>(row.event_json, "tag_event.event_json"));
    const outbox = sql.exec<SqlRow>(`
      SELECT attempt_id, event_id, suid, payload, allocator_lineage_id, event_type, provenance, timestamp
      FROM tag_outbox_obligation
      ORDER BY obligation_sequence ASC
    `).toArray().map((row): TagOutboxRow => ({
      attemptId: sqlString(row.attempt_id, "tag_outbox_obligation.attempt_id"),
      eventId: sqlString(row.event_id, "tag_outbox_obligation.event_id"),
      suid: sqlString(row.suid, "tag_outbox_obligation.suid"),
      payload: sqlString(row.payload, "tag_outbox_obligation.payload"),
      allocatorLineageId: sqlString(row.allocator_lineage_id, "tag_outbox_obligation.allocator_lineage_id"),
      eventType: sqlString(row.event_type, "tag_outbox_obligation.event_type"),
      provenance: sqlString(row.provenance, "tag_outbox_obligation.provenance") as "g32",
      timestamp: sqlString(row.timestamp, "tag_outbox_obligation.timestamp"),
    }));

    const epochRows = sql.exec<SqlRow>("SELECT * FROM tag_epoch ORDER BY attempt_id ASC").toArray();
    const highestEpoch: TagEpoch[] = epochRows.map((row) => ({
      attemptId: sqlString(row.attempt_id, "tag_epoch.attempt_id"),
      epoch: sqlNumber(row.highest_epoch, "tag_epoch.highest_epoch"),
    }));
    const sealedEpoch: TagEpoch[] = epochRows.flatMap((row) => {
      const epoch = sqlNullableNumber(row.sealed_epoch, "tag_epoch.sealed_epoch");
      return epoch === null ? [] : [{ attemptId: sqlString(row.attempt_id, "tag_epoch.attempt_id"), epoch }];
    });
    const confirmations = sql.exec<SqlRow>(`
      SELECT attempt_id, epoch FROM tag_commit_receipt
      WHERE reservation_confirmed = 1
      ORDER BY attempt_id ASC
    `).toArray().map((row) => ({
      attemptId: sqlString(row.attempt_id, "tag_commit_receipt.attempt_id"),
      epoch: sqlNumber(row.epoch, "tag_commit_receipt.epoch"),
    }));
    const tombstones = sql.exec<SqlRow>("SELECT attempt_id, epoch FROM tag_tombstone ORDER BY attempt_id ASC").toArray().map((row) => ({
      attemptId: sqlString(row.attempt_id, "tag_tombstone.attempt_id"),
      epoch: sqlNumber(row.epoch, "tag_tombstone.epoch"),
    }));
    const fences = sql.exec<SqlRow>("SELECT reason, attempt_id, epoch FROM tag_fence ORDER BY reason, attempt_id").toArray().map((row): TagFence => ({
      reason: sqlString(row.reason, "tag_fence.reason"),
      attemptId: sqlString(row.attempt_id, "tag_fence.attempt_id"),
      epoch: sqlNumber(row.epoch, "tag_fence.epoch"),
    }));
    const clearedFences = sql.exec<SqlRow>("SELECT reason, attempt_id, epoch FROM tag_cleared_fence ORDER BY reason, attempt_id").toArray().map((row): TagFence => ({
      reason: sqlString(row.reason, "tag_cleared_fence.reason"),
      attemptId: sqlString(row.attempt_id, "tag_cleared_fence.attempt_id"),
      epoch: sqlNumber(row.epoch, "tag_cleared_fence.epoch"),
    }));
    const bootstrap = sql.exec<SqlRow>("SELECT * FROM tag_bootstrap_admission WHERE singleton = 1").toArray()[0];
    const bootstrapAdmission: TagBootstrapAdmission | null = bootstrap === undefined ? null : {
      importId: sqlString(bootstrap.import_id, "tag_bootstrap_admission.import_id"),
      leaseEpoch: sqlNumber(bootstrap.lease_epoch, "tag_bootstrap_admission.lease_epoch"),
      manifestDigest: sqlString(bootstrap.manifest_digest, "tag_bootstrap_admission.manifest_digest"),
      targetServiceId: sqlString(bootstrap.target_service_id, "tag_bootstrap_admission.target_service_id"),
      closed: sqlNumber(bootstrap.closed, "tag_bootstrap_admission.closed") === 1,
    };
    // The in-memory scope is canonicalized by SUID, then the identity key.
    // The SQL representation stores the full item as JSON, so reproduce that
    // order rather than substituting the table's composite-key order.
    const repairScope = sql.exec<SqlRow>(`
      SELECT item_json FROM tag_repair_scope
      ORDER BY json_extract(item_json, '$.suid') ASC, attempt_id ASC, event_id ASC
    `).toArray()
      .map((row) => sqlJson<RepairScopeItem>(row.item_json, "tag_repair_scope.item_json"));
    return {
      schemaVersion: sqlNumber(control.schema_version, "tag_control.schema_version") as 3,
      tag,
      head: sqlString(control.head_suid, "tag_control.head_suid"),
      activeReservation,
      // `alarmDueAt` is retained as the reservation response/state fact. The
      // actual durable alarm is the scheduler minimum and is intentionally
      // inspected through the scheduler seam rather than this legacy shape.
      alarmDueAt: activeReservation?.alarmDueAt ?? null,
      events,
      outbox,
      highestEpoch,
      sealedEpoch,
      tombstones,
      confirmations,
      fences,
      clearedFences,
      bootstrapAdmission,
      repairOwner: sqlNullableString(control.repair_owner, "tag_control.repair_owner"),
      repairLeaseUntil: sqlNullableNumber(control.repair_lease_until, "tag_control.repair_lease_until"),
      highestRepairEpoch: sqlNumber(control.highest_repair_epoch, "tag_control.highest_repair_epoch"),
      repairScope,
      repairScopeVersion: sqlNumber(control.repair_scope_version, "tag_control.repair_scope_version"),
      clockOffsetMs: sqlNumber(control.clock_offset_ms, "tag_control.clock_offset_ms"),
      clockNowMs: sqlNullableNumber(control.clock_now_ms, "tag_control.clock_now_ms"),
      version: sqlNumber(control.version, "tag_control.version"),
      createdAt: sqlString(control.created_at, "tag_control.created_at"),
      updatedAt: sqlString(control.updated_at, "tag_control.updated_at"),
    };
  }

  /**
   * Reads the scalar commit-response facts without rehydrating `tag_event`.
   * Keep the identity and control/head consistency checks at this boundary:
   * an internal caller is not allowed to turn an identity change into a
   * plausible but stale response.
   */
  private readHeadFacts(tag: string): TagHeadFacts | undefined {
    const sql = this.sqlStorage();
    if (sql === undefined) {
      if (this.fallbackRecord !== undefined && this.fallbackRecord.tag !== tag) {
        throw new TagIdentityConflict();
      }
      return this.fallbackRecord === undefined
        ? undefined
        : {
          head: this.fallbackRecord.head,
          version: this.fallbackRecord.version,
          updatedAt: this.fallbackRecord.updatedAt,
        };
    }

    const identity = sql.exec<SqlRow>("SELECT tag FROM tag_identity WHERE singleton = 1").toArray()[0];
    if (identity === undefined) return undefined;
    if (sqlString(identity.tag, "tag_identity.tag") !== tag) throw new TagIdentityConflict();

    const control = sql.exec<SqlRow>(`
      SELECT head_suid, version, updated_at
      FROM tag_control
      WHERE singleton = 1
    `).toArray()[0];
    if (control === undefined) throw new Error("Tag SQL identity exists without control state");

    const head = sql.exec<SqlRow>("SELECT head_suid FROM tag_head WHERE singleton = 1").toArray()[0];
    const controlHead = sqlString(control.head_suid, "tag_control.head_suid");
    if (head !== undefined && sqlString(head.head_suid, "tag_head.head_suid") !== controlHead) {
      throw new Error("Tag SQL head/control mismatch");
    }

    return {
      head: controlHead,
      version: sqlNumber(control.version, "tag_control.version"),
      updatedAt: sqlString(control.updated_at, "tag_control.updated_at"),
    };
  }

  private async obligationArtifact(
    event: TagEvent,
    serviceId: string,
    tag: string,
  ): Promise<{ canonicalBytes: ArrayBuffer; eventDigest: string; declaredTagSet: string; localMembership: string }> {
    const declaredTagSet = canonicalDeclaredTagSet(event.eventTags);
    const payloadBytes = new TextEncoder().encode(event.payload);
    const digestInput = {
      serviceId,
      eventId: event.eventId,
      sortableUniqueId: event.suid,
      eventType: event.eventType,
      timestamp: event.timestamp,
      allocatorLineageId: event.allocatorLineageId,
      attemptId: event.attemptId,
      declaredTagSet,
      // TagEvent.payload is the exact persisted UTF-8 JSON text in the
      // current G32 record. The digest encoder accepts this byte view rather
      // than decoding/re-serializing it, which keeps the raw-byte rule at the
      // boundary where persisted text becomes an obligation artifact.
      payload: payloadBytes,
    } as const;
    return {
      canonicalBytes: copyArrayBuffer(eventDigestBytes(digestInput)),
      eventDigest: await eventDigestHex(digestInput),
      declaredTagSet: JSON.stringify(declaredTagSet),
      localMembership: JSON.stringify([{ serviceId, eventId: event.eventId, tag }]),
    };
  }

  private ensureSqlTag(tag: string): void {
    const sql = this.sqlStorage();
    if (sql === undefined) throw new Error("Tag SQL storage is unavailable");
    const existing = sql.exec<SqlRow>("SELECT tag FROM tag_identity WHERE singleton = 1").toArray()[0];
    if (existing !== undefined) {
      if (sqlString(existing.tag, "tag_identity.tag") !== tag) throw new Error("Tag Durable Object identity changed");
      return;
    }
    const record = newRecord(tag);
    sql.exec("INSERT INTO tag_identity (singleton, tag, created_at) VALUES (1, ?, ?)", tag, record.createdAt);
    sql.exec(`
      INSERT INTO tag_control (
        singleton, schema_version, head_suid, clock_offset_ms, clock_now_ms,
        version, repair_owner, repair_lease_until, highest_repair_epoch,
        repair_scope_version, created_at, updated_at
      ) VALUES (1, 3, '', 0, NULL, 0, NULL, NULL, 0, 0, ?, ?)
    `, record.createdAt, record.updatedAt);
    sql.exec("INSERT INTO tag_head (singleton, service_id, head_suid) VALUES (1, '', '')");
  }

  private writeCommittedSqlEvent(sql: SqlStorage, serviceId: string, event: TagEvent): void {
    sql.exec(`
      INSERT INTO tag_event (
        service_id, event_id, attempt_id, suid, payload, event_tags_json,
        allocator_lineage_id, event_type, provenance, timestamp, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, serviceId, event.eventId, event.attemptId, event.suid, event.payload,
    JSON.stringify(event.eventTags), event.allocatorLineageId, event.eventType,
    event.provenance, event.timestamp, JSON.stringify(event));
  }

  private writeCommittedSqlMembership(sql: SqlStorage, serviceId: string, eventId: string, tag: string, committedAt: string): void {
    sql.exec(`
      INSERT INTO tag_committed_membership (service_id, event_id, tag, committed_at)
      VALUES (?, ?, ?, ?)
    `, serviceId, eventId, tag, committedAt);
  }

  private writeCommittedSqlObligation(
    sql: SqlStorage,
    serviceId: string,
    tag: string,
    event: TagEvent,
    artifact: { canonicalBytes: ArrayBuffer; eventDigest: string; declaredTagSet: string; localMembership: string },
    trackSourcePartitionRegistration = true,
  ): void {
    sql.exec(`
      INSERT INTO tag_outbox_obligation (
        service_id, event_id, attempt_id, suid, payload, allocator_lineage_id,
        event_type, provenance, timestamp, canonical_bytes, event_digest,
        declared_tag_set_json, local_committed_membership_json, status,
        next_attempt_at, attempt_count, enqueued_at, acknowledged_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, NULL, NULL, NULL)
    `, serviceId, event.eventId, event.attemptId, event.suid, event.payload,
    event.allocatorLineageId, event.eventType, event.provenance, event.timestamp,
    artifact.canonicalBytes, artifact.eventDigest, artifact.declaredTagSet,
    artifact.localMembership, Date.now());
    if (trackSourcePartitionRegistration) {
      this.upsertSourcePartitionRegistration(sql, serviceId, tag, event.eventId);
    }
  }

  private upsertSourcePartitionRegistration(
    sql: SqlStorage,
    serviceId: string,
    tag: string,
    eventId: string,
  ): void {
    const obligation = sql.exec<SqlRow>(`
      SELECT obligation_sequence
        FROM tag_outbox_obligation
       WHERE service_id = ? AND event_id = ?
       ORDER BY obligation_sequence DESC
       LIMIT 1
    `, serviceId, eventId).one();
    const sequence = sqlNumber(obligation.obligation_sequence, "tag_outbox_obligation.obligation_sequence");
    sql.exec(`
      INSERT INTO tag_source_partition_registration
        (service_id, partition_tag, last_obligation_sequence, status, next_attempt_at, attempt_count, last_error)
      VALUES (?, ?, ?, 'pending', ?, 0, NULL)
      ON CONFLICT (service_id, partition_tag) DO UPDATE SET
        last_obligation_sequence = MAX(
          tag_source_partition_registration.last_obligation_sequence,
          excluded.last_obligation_sequence
        ),
        status = CASE
          WHEN tag_source_partition_registration.status = 'registered' THEN 'registered'
          ELSE 'pending'
        END,
        next_attempt_at = CASE
          WHEN tag_source_partition_registration.status = 'registered' THEN NULL
          ELSE excluded.next_attempt_at
        END,
        attempt_count = CASE
          WHEN tag_source_partition_registration.status = 'registered' THEN 0
          ELSE 0
        END,
        last_error = CASE
          WHEN tag_source_partition_registration.status = 'registered' THEN NULL
          ELSE NULL
        END
    `, serviceId, tag, sequence, Date.now());
  }

  private writeCommittedSqlHead(sql: SqlStorage, serviceId: string, head: string, version: number, committedAt: string): void {
    sql.exec("UPDATE tag_control SET head_suid = ?, version = ?, updated_at = ? WHERE singleton = 1", head, version, committedAt);
    sql.exec("UPDATE tag_head SET service_id = ?, head_suid = ? WHERE singleton = 1", serviceId, head);
  }

  private writeCommittedSqlReceipt(
    sql: SqlStorage,
    input: AppendInput,
    committedAt: string,
    eventCount: number,
    head: string,
    confirmsReservation: boolean,
  ): void {
    sql.exec(`
      INSERT INTO tag_commit_receipt
        (attempt_id, epoch, committed_at, committed_event_count, head_suid, reservation_confirmed)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(attempt_id, epoch) DO UPDATE SET
        committed_at = excluded.committed_at,
        committed_event_count = excluded.committed_event_count,
        head_suid = excluded.head_suid,
        reservation_confirmed = excluded.reservation_confirmed
    `, input.attemptId, input.epoch, committedAt, eventCount, head, confirmsReservation ? 1 : 0);
  }

  /**
   * The normal append path deliberately probes only the indexed rows it needs
   * (identity/control, this attempt, this reservation, and these candidates).
   * It never calls `readStoredRecord`, so history size cannot turn append into
   * a whole-array deserialize/copy/serialize operation.
   */
  private async appendSql(
    tag: string,
    input: AppendInput,
    suppliedServiceId: string | null,
    trackSourcePartitionRegistration: boolean,
  ): Promise<OperationResult> {
    const serviceId = suppliedServiceId ?? "";
    const events: TagEvent[] = input.candidates.map((candidate) => ({
      attemptId: input.attemptId,
      eventId: candidate.eventId,
      suid: candidate.suid,
      payload: candidate.payload,
      eventTags: candidate.eventTags,
      allocatorLineageId: candidate.allocatorLineageId,
      eventType: candidate.eventType,
      provenance: candidate.provenance,
      timestamp: candidate.timestamp,
    }));
    const artifacts = await Promise.all(events.map((event) => this.obligationArtifact(event, serviceId, tag)));
    const result = await this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
      const sql = this.sqlStorage();
      if (sql === undefined) throw new Error("Tag SQL storage is unavailable");
      this.ensureSqlTag(tag);
      const control = sql.exec<SqlRow>("SELECT * FROM tag_control WHERE singleton = 1").one();
      let head = sqlString(control.head_suid, "tag_control.head_suid");
      let version = sqlNumber(control.version, "tag_control.version");

      const existingCandidates = input.candidates.map((candidate, index) => {
        const event = sql.exec<SqlRow>(`
          SELECT attempt_id, event_id, suid, payload, event_type, provenance, timestamp
          FROM tag_event WHERE service_id = ? AND event_id = ?
        `, serviceId, candidate.eventId).toArray()[0];
        const obligation = event === undefined ? undefined : sql.exec<SqlRow>(`
          SELECT event_digest FROM tag_outbox_obligation
          WHERE service_id = ? AND event_id = ? ORDER BY obligation_sequence ASC LIMIT 1
        `, serviceId, candidate.eventId).toArray()[0];
        const exact = event !== undefined &&
          sqlString(event.attempt_id, "tag_event.attempt_id") === input.attemptId &&
          sqlString(event.event_id, "tag_event.event_id") === candidate.eventId &&
          sqlString(event.suid, "tag_event.suid") === candidate.suid &&
          sqlString(event.payload, "tag_event.payload") === candidate.payload &&
          sqlString(event.event_type, "tag_event.event_type") === candidate.eventType &&
          sqlString(event.provenance, "tag_event.provenance") === candidate.provenance &&
          sqlString(event.timestamp, "tag_event.timestamp") === candidate.timestamp &&
          (obligation === undefined || sqlString(obligation.event_digest, "tag_outbox_obligation.event_digest") === artifacts[index]!.eventDigest);
        return { event, obligation, exact };
      });
      // Exact duplicate replay precedes all epoch/token checks by contract.
      if (existingCandidates.every(({ exact }) => exact)) {
        return { status: 200, body: { status: "duplicate", version } };
      }

      const active: SqlRow | undefined = sql.exec<SqlRow>("SELECT * FROM tag_reservation WHERE singleton = 1").toArray()[0];
      const now = sqlNullableNumber(control.clock_now_ms, "tag_control.clock_now_ms") ??
        Date.now() + sqlNumber(control.clock_offset_ms, "tag_control.clock_offset_ms");
      let reservation: SqlRow | undefined = active;
      if (reservation !== undefined && sqlNumber(reservation.expires_at, "tag_reservation.expires_at") <= now) {
        sql.exec("DELETE FROM tag_reservation WHERE singleton = 1");
        version += 1;
        sql.exec("UPDATE tag_control SET version = ?, updated_at = ? WHERE singleton = 1", version, nowIso());
        reservation = undefined;
      }

      const epoch = sql.exec<SqlRow>("SELECT highest_epoch, sealed_epoch FROM tag_epoch WHERE attempt_id = ?", input.attemptId).toArray()[0];
      const highest = epoch === undefined ? undefined : sqlNumber(epoch.highest_epoch, "tag_epoch.highest_epoch");
      const sealed = epoch === undefined ? null : sqlNullableNumber(epoch.sealed_epoch, "tag_epoch.sealed_epoch");
      const tombstone = sql.exec<SqlRow>("SELECT epoch FROM tag_tombstone WHERE attempt_id = ?", input.attemptId).toArray()[0];
      const tombstoneEpoch = tombstone === undefined ? undefined : sqlNumber(tombstone.epoch, "tag_tombstone.epoch");
      const epochError = highest !== undefined && input.epoch < highest
        ? "stale_epoch"
        : tombstoneEpoch !== undefined && input.epoch <= tombstoneEpoch
          ? "tombstoned_epoch"
          : sealed !== null && input.epoch <= sealed
            ? "sealed_epoch"
            : undefined;
      if (epochError !== undefined) {
        await this.rearmScheduler(txn);
        return { ...rejected(epochError), body: { ...rejected(epochError).body as JsonObject, version } };
      }

      const fenceCount = sql.exec<SqlRow>("SELECT COUNT(*) AS count FROM tag_fence").one();
      if (sqlNumber(fenceCount.count, "tag_fence.count") > 0) {
        await this.rearmScheduler(txn);
        return fenceGateRejected();
      }
      const confirmsReservation = reservation !== undefined &&
        sqlString(reservation.attempt_id, "tag_reservation.attempt_id") === input.attemptId &&
        sqlNumber(reservation.epoch, "tag_reservation.epoch") === input.epoch &&
        sqlString(reservation.reservation_token, "tag_reservation.reservation_token") === input.reservationToken;
      if (reservation !== undefined && !confirmsReservation) {
        await this.rearmScheduler(txn);
        return {
          ...rejected("reservation_token_required"),
          body: { ...rejected("reservation_token_required").body as JsonObject, version },
        };
      }
      if (
        confirmsReservation && reservation !== undefined &&
        sqlString(reservation.expected_head, "tag_reservation.expected_head") !== head
      ) {
        await this.rearmScheduler(txn);
        return {
          ...rejected("consistency_head_mismatch"),
          body: { ...rejected("consistency_head_mismatch").body as JsonObject, version },
        };
      }
      if (existingCandidates.some(({ event, obligation }, index) =>
        event !== undefined && obligation !== undefined &&
        sqlString(obligation.event_digest, "tag_outbox_obligation.event_digest") !== artifacts[index]!.eventDigest,
      )) {
        await this.rearmScheduler(txn);
        return {
          ...rejected("event_digest_conflict"),
          body: { ...rejected("event_digest_conflict").body as JsonObject, version },
        };
      }
      if (existingCandidates.some(({ event }) => event !== undefined)) {
        await this.rearmScheduler(txn);
        return {
          ...rejected("event_conflict"),
          body: { ...rejected("event_conflict").body as JsonObject, version },
        };
      }
      for (const candidate of input.candidates) {
        if (candidate.suid <= head) {
          await this.rearmScheduler(txn);
          return {
            ...rejected("non_monotonic_suid"),
            body: { ...rejected("non_monotonic_suid").body as JsonObject, version },
          };
        }
        head = candidate.suid;
      }

      const nextHighest = Math.max(highest ?? input.epoch, input.epoch);
      sql.exec(`
        INSERT INTO tag_epoch (attempt_id, highest_epoch, sealed_epoch, confirmation_epoch)
        VALUES (?, ?, NULL, NULL)
        ON CONFLICT(attempt_id) DO UPDATE SET highest_epoch = MAX(highest_epoch, excluded.highest_epoch)
      `, input.attemptId, nextHighest);
      const committedAt = nowIso();
      const hopFacts: AppendHopFact[] = [];
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index]!;
        const artifact = artifacts[index]!;
        this.writeCommittedSqlEvent(sql, serviceId, event);
        this.writeCommittedSqlMembership(sql, serviceId, event.eventId, tag, committedAt);
        const obligationWrittenAt = Date.now();
        this.writeCommittedSqlObligation(sql, serviceId, tag, event, artifact, trackSourcePartitionRegistration);
        hopFacts.push({
          eventId: event.eventId,
          suid: event.suid,
          attemptId: event.attemptId,
          tag,
          // This is the existing durable tag_commit_receipt clock fact,
          // shared by membership/head/receipt writes in this transaction.
          tagAppendCommittedAt: Date.parse(committedAt),
          obligationWrittenAt,
        });
      }
      this.writeCommittedSqlHead(sql, serviceId, head, version + 1, committedAt);
      if (input.faultInjection === "after-append-before-confirm") {
        throw new AppendTransactionFault("Simulated interruption before atomic commit receipt");
      }
      this.writeCommittedSqlReceipt(sql, input, committedAt, events.length, head, confirmsReservation);
      if (confirmsReservation) sql.exec("DELETE FROM tag_reservation WHERE singleton = 1");
      await this.rearmScheduler(txn);
      return {
        status: 201,
        body: {
          status: "appended",
          fenceGate: { checked: true, activeFenceCount: 0 },
          version: version + 1,
        },
        hopFacts,
      };
    });
    return result;
  }

  /**
   * SQL-native reservation transition. This deliberately reads only the
   * control, epoch, tombstone, fence and reservation rows that participate in
   * the transition; it never rehydrates tag_event history just to reserve.
   */
  private async acquireSql(tag: string, input: AcquireInput): Promise<OperationResult> {
    return this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
      const sql = this.sqlStorage();
      if (sql === undefined) throw new Error("Tag SQL storage is unavailable");
      this.ensureSqlTag(tag);
      const control = sql.exec<SqlRow>("SELECT * FROM tag_control WHERE singleton = 1").one();
      let version = sqlNumber(control.version, "tag_control.version");
      const now = sqlNullableNumber(control.clock_now_ms, "tag_control.clock_now_ms") ??
        Date.now() + sqlNumber(control.clock_offset_ms, "tag_control.clock_offset_ms");
      let reservation: SqlRow | undefined = sql.exec<SqlRow>("SELECT * FROM tag_reservation WHERE singleton = 1").toArray()[0];
      const epoch = sql.exec<SqlRow>("SELECT highest_epoch, sealed_epoch FROM tag_epoch WHERE attempt_id = ?", input.attemptId).toArray()[0];
      const tombstone = sql.exec<SqlRow>("SELECT epoch FROM tag_tombstone WHERE attempt_id = ?", input.attemptId).toArray()[0];
      const highest = epoch === undefined ? undefined : sqlNumber(epoch.highest_epoch, "tag_epoch.highest_epoch");
      const sealed = epoch === undefined ? null : sqlNullableNumber(epoch.sealed_epoch, "tag_epoch.sealed_epoch");
      const tombstoneEpoch = tombstone === undefined ? undefined : sqlNumber(tombstone.epoch, "tag_tombstone.epoch");
      const epochError = highest !== undefined && input.epoch < highest
        ? "stale_epoch"
        : tombstoneEpoch !== undefined && input.epoch <= tombstoneEpoch
          ? "tombstoned_epoch"
          : sealed !== null && input.epoch <= sealed
            ? "sealed_epoch"
            : undefined;
      if (epochError !== undefined) {
        await this.rearmScheduler(txn);
        return { ...rejected(epochError), body: { ...rejected(epochError).body as JsonObject, version } };
      }

      // Preserve the established ordering: an expired reservation is cleaned
      // after its epoch has been validated, before head/fence/reservation use.
      if (reservation !== undefined && sqlNumber(reservation.expires_at, "tag_reservation.expires_at") <= now) {
        sql.exec("DELETE FROM tag_reservation WHERE singleton = 1");
        version += 1;
        sql.exec("UPDATE tag_control SET version = ?, updated_at = ? WHERE singleton = 1", version, nowIso());
        reservation = undefined;
      }

      const observed = input.expectedHead !== null;
      const isEventTag = input.eventTags.includes(tag);
      if (!observed || !isEventTag) {
        await this.rearmScheduler(txn);
        return { status: 200, body: { status: "omitted", reservation: null, fenceGateChecked: false, version } };
      }

      const fence = sql.exec<SqlRow>("SELECT COUNT(*) AS count FROM tag_fence").one();
      if (sqlNumber(fence.count, "tag_fence.count") > 0) {
        await this.rearmScheduler(txn);
        return fenceGateRejected();
      }
      const head = sqlString(control.head_suid, "tag_control.head_suid");
      const assertedEmpty = input.expectedHead === "";
      if (assertedEmpty) {
        const eventCount = sql.exec<SqlRow>("SELECT COUNT(*) AS count FROM tag_event").one();
        if (sqlNumber(eventCount.count, "tag_event.count") > 0 || head !== "") {
          await this.rearmScheduler(txn);
          return {
            ...rejected(ASSERT_EMPTY_CONFLICT_REASON),
            body: { ...rejected(ASSERT_EMPTY_CONFLICT_REASON).body as JsonObject, version },
          };
        }
      }
      if (head !== input.expectedHead) {
        await this.rearmScheduler(txn);
        return {
          ...rejected("consistency_head_mismatch"),
          body: { ...rejected("consistency_head_mismatch").body as JsonObject, version },
        };
      }
      if (reservation !== undefined) {
        if (
          sqlString(reservation.attempt_id, "tag_reservation.attempt_id") === input.attemptId &&
          sqlNumber(reservation.epoch, "tag_reservation.epoch") === input.epoch
        ) {
          const activeFenceCount = sqlNumber(sql.exec<SqlRow>(
            "SELECT COUNT(*) AS count FROM tag_fence WHERE attempt_id = ?",
            input.attemptId,
          ).one().count, "tag_fence.attempt_count");
          await this.rearmScheduler(txn);
          return {
            status: 200,
            body: {
              status: "reserved",
              reservation: {
                attemptId: input.attemptId,
                epoch: input.epoch,
                token: sqlString(reservation.reservation_token, "tag_reservation.reservation_token"),
                expectedHead: sqlString(reservation.expected_head, "tag_reservation.expected_head"),
                expiresAt: sqlNumber(reservation.expires_at, "tag_reservation.expires_at"),
                alarmDueAt: sqlNumber(reservation.alarm_due_at, "tag_reservation.alarm_due_at"),
              },
              fenceGate: { checked: true, activeFenceCount },
              version,
            },
          };
        }
        await this.rearmScheduler(txn);
        return {
          ...rejected(assertedEmpty ? ASSERT_EMPTY_CONFLICT_REASON : "active_reservation_conflict"),
          body: {
            ...rejected(assertedEmpty ? ASSERT_EMPTY_CONFLICT_REASON : "active_reservation_conflict").body as JsonObject,
            version,
          },
        };
      }

      const reservationToken = crypto.randomUUID();
      const reservationFact: TagReservation = {
        attemptId: input.attemptId,
        epoch: input.epoch,
        token: reservationToken,
        expectedHead: input.expectedHead,
        expiresAt: now + RESERVATION_WINDOW_MS,
        alarmDueAt: Date.now() + RESERVATION_WINDOW_MS,
      };
      sql.exec(`
        INSERT INTO tag_epoch (attempt_id, highest_epoch, sealed_epoch, confirmation_epoch)
        VALUES (?, ?, NULL, NULL)
        ON CONFLICT(attempt_id) DO UPDATE SET highest_epoch = MAX(highest_epoch, excluded.highest_epoch)
      `, input.attemptId, input.epoch);
      if (assertedEmpty) {
        // An asserted-empty reservation is the prepare step of the ordinary
        // first write. It must not manufacture a version before the first
        // committed event; append therefore returns version 1 just like the
        // unobserved first-write path.
        sql.exec("UPDATE tag_control SET updated_at = ? WHERE singleton = 1", nowIso());
      } else {
        version += 1;
        sql.exec("UPDATE tag_control SET version = ?, updated_at = ? WHERE singleton = 1", version, nowIso());
      }
      sql.exec(`
        INSERT INTO tag_reservation
          (singleton, attempt_id, epoch, reservation_token, expected_head, expires_at, alarm_due_at)
        VALUES (1, ?, ?, ?, ?, ?, ?)
      `, reservationFact.attemptId, reservationFact.epoch, reservationFact.token, reservationFact.expectedHead,
      reservationFact.expiresAt, reservationFact.alarmDueAt);
      await this.rearmScheduler(txn);
      return {
        status: 201,
        body: { status: "reserved", reservation: reservationFact, fenceGate: { checked: true, activeFenceCount: 0 }, version },
      };
    });
  }

  /**
   * SQL-native cancel transition. It only mutates reservation/epoch/tombstone
   * control rows, so a cancellation cannot hide a committed event, membership
   * or obligation and does not rewrite event history.
   */
  private async cancelSql(tag: string, input: ReservationInput): Promise<OperationResult> {
    return this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
      const sql = this.sqlStorage();
      if (sql === undefined) throw new Error("Tag SQL storage is unavailable");
      let identity = sql.exec<SqlRow>("SELECT tag FROM tag_identity WHERE singleton = 1").toArray()[0];
      if (identity === undefined && input.forceTombstone === true && input.createMissingTombstone === true) {
        this.ensureSqlTag(tag);
        identity = sql.exec<SqlRow>("SELECT tag FROM tag_identity WHERE singleton = 1").toArray()[0];
      }
      if (identity === undefined) {
        return { ...rejected("reservation_token_required"), body: { ...rejected("reservation_token_required").body as JsonObject, version: 0 } };
      }
      if (sqlString(identity.tag, "tag_identity.tag") !== tag) throw new Error("Tag Durable Object identity changed");
      const control = sql.exec<SqlRow>("SELECT * FROM tag_control WHERE singleton = 1").one();
      let version = sqlNumber(control.version, "tag_control.version");
      const now = sqlNullableNumber(control.clock_now_ms, "tag_control.clock_now_ms") ??
        Date.now() + sqlNumber(control.clock_offset_ms, "tag_control.clock_offset_ms");
      let reservation: SqlRow | undefined = sql.exec<SqlRow>("SELECT * FROM tag_reservation WHERE singleton = 1").toArray()[0];
      if (reservation !== undefined && sqlNumber(reservation.expires_at, "tag_reservation.expires_at") <= now) {
        sql.exec("DELETE FROM tag_reservation WHERE singleton = 1");
        version += 1;
        sql.exec("UPDATE tag_control SET version = ?, updated_at = ? WHERE singleton = 1", version, nowIso());
        reservation = undefined;
      }
      const tombstone = sql.exec<SqlRow>("SELECT epoch FROM tag_tombstone WHERE attempt_id = ?", input.attemptId).toArray()[0];
      const tombstoneEpoch = tombstone === undefined ? undefined : sqlNumber(tombstone.epoch, "tag_tombstone.epoch");
      const holdsReservation = reservation !== undefined &&
        sqlString(reservation.attempt_id, "tag_reservation.attempt_id") === input.attemptId &&
        sqlNumber(reservation.epoch, "tag_reservation.epoch") === input.epoch;

      if (input.forceTombstone === true) {
        if (!holdsReservation && tombstoneEpoch !== undefined && tombstoneEpoch >= input.epoch) {
          await this.rearmScheduler(txn);
          return { status: 200, body: { status: "cancelled", idempotent: true, version } };
        }
        sql.exec(`
          INSERT INTO tag_epoch (attempt_id, highest_epoch, sealed_epoch, confirmation_epoch)
          VALUES (?, ?, NULL, NULL)
          ON CONFLICT(attempt_id) DO UPDATE SET highest_epoch = MAX(highest_epoch, excluded.highest_epoch)
        `, input.attemptId, input.epoch);
        sql.exec(`
          INSERT INTO tag_tombstone (attempt_id, epoch) VALUES (?, ?)
          ON CONFLICT(attempt_id) DO UPDATE SET epoch = MAX(epoch, excluded.epoch)
        `, input.attemptId, input.epoch);
        if (holdsReservation) sql.exec("DELETE FROM tag_reservation WHERE singleton = 1");
        version += 1;
        sql.exec("UPDATE tag_control SET version = ?, updated_at = ? WHERE singleton = 1", version, nowIso());
        await this.rearmScheduler(txn);
        return { status: 200, body: { status: "cancelled", idempotent: false, fenceConfirmed: true, version } };
      }

      if (!holdsReservation && tombstoneEpoch === input.epoch) {
        await this.rearmScheduler(txn);
        return { status: 200, body: { status: "cancelled", idempotent: true, version } };
      }
      const epoch = sql.exec<SqlRow>("SELECT highest_epoch, sealed_epoch FROM tag_epoch WHERE attempt_id = ?", input.attemptId).toArray()[0];
      const highest = epoch === undefined ? undefined : sqlNumber(epoch.highest_epoch, "tag_epoch.highest_epoch");
      const sealed = epoch === undefined ? null : sqlNullableNumber(epoch.sealed_epoch, "tag_epoch.sealed_epoch");
      const epochError = highest !== undefined && input.epoch < highest
        ? "stale_epoch"
        : tombstoneEpoch !== undefined && input.epoch <= tombstoneEpoch
          ? "tombstoned_epoch"
          : sealed !== null && input.epoch <= sealed
            ? "sealed_epoch"
            : undefined;
      if (epochError !== undefined) {
        await this.rearmScheduler(txn);
        return { ...rejected(epochError), body: { ...rejected(epochError).body as JsonObject, version } };
      }
      if (!holdsReservation || reservation === undefined) {
        await this.rearmScheduler(txn);
        return {
          ...rejected("reservation_token_required"),
          body: { ...rejected("reservation_token_required").body as JsonObject, version },
        };
      }
      if (sqlString(reservation.reservation_token, "tag_reservation.reservation_token") !== input.reservationToken) {
        await this.rearmScheduler(txn);
        return {
          ...rejected("reservation_token_required"),
          body: { ...rejected("reservation_token_required").body as JsonObject, version },
        };
      }
      sql.exec(`
        INSERT INTO tag_epoch (attempt_id, highest_epoch, sealed_epoch, confirmation_epoch)
        VALUES (?, ?, NULL, NULL)
        ON CONFLICT(attempt_id) DO UPDATE SET highest_epoch = MAX(highest_epoch, excluded.highest_epoch)
      `, input.attemptId, input.epoch);
      sql.exec(`
        INSERT INTO tag_tombstone (attempt_id, epoch) VALUES (?, ?)
        ON CONFLICT(attempt_id) DO UPDATE SET epoch = MAX(epoch, excluded.epoch)
      `, input.attemptId, input.epoch);
      sql.exec("DELETE FROM tag_reservation WHERE singleton = 1");
      version += 1;
      sql.exec("UPDATE tag_control SET version = ?, updated_at = ? WHERE singleton = 1", version, nowIso());
      await this.rearmScheduler(txn);
      return { status: 200, body: { status: "cancelled", idempotent: false, fenceConfirmed: true, version } };
    });
  }

  private async writeSqlRecord(record: TagRecord, requestedServiceId = ""): Promise<void> {
    const sql = this.sqlStorage();
    if (sql === undefined) throw new Error("Tag SQL storage is unavailable");
    const existingIdentity = sql.exec<SqlRow>("SELECT tag FROM tag_identity WHERE singleton = 1").toArray()[0];
    if (existingIdentity === undefined) {
      sql.exec("INSERT INTO tag_identity (singleton, tag, created_at) VALUES (1, ?, ?)", record.tag, record.createdAt);
    } else if (sqlString(existingIdentity.tag, "tag_identity.tag") !== record.tag) {
      throw new Error("Tag Durable Object identity changed");
    }

    sql.exec(`
      INSERT INTO tag_control (
        singleton, schema_version, head_suid, clock_offset_ms, clock_now_ms,
        version, repair_owner, repair_lease_until, highest_repair_epoch,
        repair_scope_version, created_at, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        schema_version = excluded.schema_version,
        head_suid = excluded.head_suid,
        clock_offset_ms = excluded.clock_offset_ms,
        clock_now_ms = excluded.clock_now_ms,
        version = excluded.version,
        repair_owner = excluded.repair_owner,
        repair_lease_until = excluded.repair_lease_until,
        highest_repair_epoch = excluded.highest_repair_epoch,
        repair_scope_version = excluded.repair_scope_version,
        updated_at = excluded.updated_at
    `,
    record.schemaVersion, record.head, record.clockOffsetMs, record.clockNowMs,
    record.version, record.repairOwner, record.repairLeaseUntil, record.highestRepairEpoch,
    record.repairScopeVersion, record.createdAt, record.updatedAt);

    const existingHead = sql.exec<SqlRow>("SELECT service_id FROM tag_head WHERE singleton = 1").toArray()[0];
    const serviceId = requestedServiceId || (existingHead === undefined ? "" : sqlString(existingHead.service_id, "tag_head.service_id")) || record.bootstrapAdmission?.targetServiceId || "";
    sql.exec(`
      INSERT INTO tag_head (singleton, service_id, head_suid) VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET service_id = excluded.service_id, head_suid = excluded.head_suid
    `, serviceId, record.head);

    sql.exec("DELETE FROM tag_reservation WHERE singleton = 1");
    if (record.activeReservation !== null) {
      const reservation = record.activeReservation;
      sql.exec(`
        INSERT INTO tag_reservation
          (singleton, attempt_id, epoch, reservation_token, expected_head, expires_at, alarm_due_at)
        VALUES (1, ?, ?, ?, ?, ?, ?)
      `, reservation.attemptId, reservation.epoch, reservation.token, reservation.expectedHead, reservation.expiresAt, reservation.alarmDueAt);
    }

    sql.exec("DELETE FROM tag_epoch");
    const epochs = new Map<string, { highest: number; sealed: number | null; confirmation: number | null }>();
    for (const entry of record.highestEpoch) epochs.set(entry.attemptId, { highest: entry.epoch, sealed: null, confirmation: null });
    for (const entry of record.sealedEpoch) {
      const prior = epochs.get(entry.attemptId) ?? { highest: entry.epoch, sealed: null, confirmation: null };
      prior.highest = Math.max(prior.highest, entry.epoch); prior.sealed = entry.epoch; epochs.set(entry.attemptId, prior);
    }
    for (const entry of record.confirmations) {
      const prior = epochs.get(entry.attemptId) ?? { highest: entry.epoch, sealed: null, confirmation: null };
      prior.highest = Math.max(prior.highest, entry.epoch); prior.confirmation = entry.epoch; epochs.set(entry.attemptId, prior);
    }
    for (const [attemptId, epoch] of epochs) {
      sql.exec("INSERT INTO tag_epoch (attempt_id, highest_epoch, sealed_epoch, confirmation_epoch) VALUES (?, ?, ?, ?)", attemptId, epoch.highest, epoch.sealed, epoch.confirmation);
    }

    sql.exec("DELETE FROM tag_tombstone");
    for (const tombstone of record.tombstones) {
      sql.exec("INSERT INTO tag_tombstone (attempt_id, epoch) VALUES (?, ?)", tombstone.attemptId, tombstone.epoch);
    }
    sql.exec("DELETE FROM tag_fence");
    for (const fence of record.fences) sql.exec("INSERT INTO tag_fence (reason, attempt_id, epoch) VALUES (?, ?, ?)", fence.reason, fence.attemptId, fence.epoch);
    sql.exec("DELETE FROM tag_cleared_fence");
    for (const fence of record.clearedFences) sql.exec("INSERT INTO tag_cleared_fence (reason, attempt_id, epoch) VALUES (?, ?, ?)", fence.reason, fence.attemptId, fence.epoch);

    sql.exec("DELETE FROM tag_bootstrap_admission WHERE singleton = 1");
    if (record.bootstrapAdmission !== null) {
      const admission = record.bootstrapAdmission;
      sql.exec(`
        INSERT INTO tag_bootstrap_admission
          (singleton, import_id, lease_epoch, manifest_digest, target_service_id, closed)
        VALUES (1, ?, ?, ?, ?, ?)
      `, admission.importId, admission.leaseEpoch, admission.manifestDigest, admission.targetServiceId, admission.closed ? 1 : 0);
    }
    sql.exec("DELETE FROM tag_repair_scope");
    for (const item of record.repairScope) {
      sql.exec("INSERT INTO tag_repair_scope (attempt_id, event_id, item_json) VALUES (?, ?, ?)", item.attemptId, item.eventId, JSON.stringify(item));
    }

    const knownEvents = new Map(sql.exec<SqlRow>("SELECT service_id, event_id FROM tag_event").toArray().map((row) => [
      sqlString(row.event_id, "tag_event.event_id"),
      sqlString(row.service_id, "tag_event.service_id"),
    ]));
    const eventByOutboxIdentity = new Map(record.events.map((event) => [
      outboxRowKey(event),
      event,
    ]));
    for (const event of record.events) {
      const eventServiceId = knownEvents.get(event.eventId) ?? serviceId;
      if (!knownEvents.has(event.eventId)) {
        sql.exec(`
          INSERT INTO tag_event (
            service_id, event_id, attempt_id, suid, payload, event_tags_json,
            allocator_lineage_id, event_type, provenance, timestamp, event_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, eventServiceId, event.eventId, event.attemptId, event.suid, event.payload,
        JSON.stringify(event.eventTags), event.allocatorLineageId, event.eventType,
        event.provenance, event.timestamp, JSON.stringify(event));
      }
      sql.exec(`
        INSERT OR IGNORE INTO tag_committed_membership (service_id, event_id, tag, committed_at)
        VALUES (?, ?, ?, ?)
      `, eventServiceId, event.eventId, record.tag, record.updatedAt);
    }
    for (const outbox of record.outbox) {
      const event = eventByOutboxIdentity.get(outboxRowKey(outbox));
      if (event === undefined) continue;
      const eventServiceId = knownEvents.get(event.eventId) ?? serviceId;
      const artifact = await this.obligationArtifact(event, eventServiceId, record.tag);
      sql.exec(`
        INSERT OR IGNORE INTO tag_outbox_obligation (
          service_id, event_id, attempt_id, suid, payload, allocator_lineage_id,
          event_type, provenance, timestamp, canonical_bytes, event_digest,
          declared_tag_set_json, local_committed_membership_json, status,
          next_attempt_at, attempt_count, enqueued_at, acknowledged_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, NULL, NULL, NULL)
      `, eventServiceId, outbox.eventId, outbox.attemptId, outbox.suid, outbox.payload,
      outbox.allocatorLineageId, outbox.eventType, outbox.provenance, outbox.timestamp,
      artifact.canonicalBytes, artifact.eventDigest, artifact.declaredTagSet,
      artifact.localMembership, Date.now());
      this.upsertSourcePartitionRegistration(sql, eventServiceId, record.tag, outbox.eventId);
    }
    for (const confirmation of record.confirmations) {
      sql.exec(`
        INSERT OR IGNORE INTO tag_commit_receipt
          (attempt_id, epoch, committed_at, committed_event_count, head_suid, reservation_confirmed)
        VALUES (?, ?, ?, ?, ?, 1)
      `, confirmation.attemptId, confirmation.epoch, record.updatedAt,
      record.events.filter((event) => event.attemptId === confirmation.attemptId).length,
      record.head);
    }
  }

  private nextSqlAlarmDue(): number | null {
    const sql = this.sqlStorage();
    if (sql === undefined) return this.fallbackRecord?.alarmDueAt ?? null;
    const row = sql.exec<SqlRow>(`
      SELECT MIN(due_at) AS due_at FROM (
        SELECT alarm_due_at AS due_at FROM tag_reservation
        UNION ALL
        SELECT next_attempt_at AS due_at FROM tag_outbox_obligation
        WHERE status = 'pending'
        UNION ALL
        SELECT next_attempt_at AS due_at FROM tag_source_partition_registration
        WHERE status = 'pending'
      )
    `).toArray()[0];
    return row === undefined ? null : sqlNullableNumber(row.due_at, "due_at");
  }

  private async recordFor(
    txn: DurableObjectTransaction,
    tag: string,
  ): Promise<{ record: TagRecord; exists: boolean }> {
    void txn;
    const existing = this.readStoredRecord(tag);
    return { record: existing === undefined ? newRecord(tag) : requireG32TagRecord(existing), exists: existing !== undefined };
  }

  private async write(txn: DurableObjectTransaction, record: TagRecord, serviceId = ""): Promise<void> {
    if (this.sqlStorage() === undefined) {
      this.fallbackRecord = record;
    } else {
      await this.writeSqlRecord(record, serviceId);
    }
    const dueAt = this.nextSqlAlarmDue();
    if (dueAt === null) {
      await txn.deleteAlarm();
    } else {
      await txn.setAlarm(dueAt);
    }
  }

  private async commit(
    txn: DurableObjectTransaction,
    record: TagRecord,
    updates: Partial<TagRecord>,
    serviceId = "",
  ): Promise<TagRecord> {
    const updated = changed(record, updates);
    await this.write(txn, updated, serviceId);
    return updated;
  }

  private async commitExpiryIfNeeded(
    txn: DurableObjectTransaction,
    expiry: ExpiryResult,
  ): Promise<TagRecord> {
    return expiry.expired ? this.commit(txn, expiry.record, {}) : expiry.record;
  }

  private async acquire(tag: string, body: unknown, observation?: DurableObjectHandlerObservation): Promise<Response> {
    const parsed = acquireFrom(body, tag);
    if (parsed.value === undefined) {
      return error(400, "invalid_tag_acquire", parsed.error ?? "Invalid acquire request");
    }
    const input = parsed.value;
    observation?.markFirstStorageRead();
    if (this.sqlStorage() !== undefined) {
      const result = await this.acquireSql(tag, input);
      return json(result.body, result.status);
    }
    const result = await this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
      const loaded = await this.recordFor(txn, tag);
      let record = loaded.record;

      const observed = input.expectedHead !== null;
      const isEventTag = input.eventTags.includes(tag);
      const epochError = operationEpochRejection(record, input.attemptId, input.epoch);
      if (epochError !== undefined) {
        return { ...rejected(epochError), body: { ...rejected(epochError).body as JsonObject, version: record.version } };
      }

      // Acquire ordering is deliberate: epoch, expired cleanup, fence, then
      // authoritative head comparison/reservation creation.
      const expiry = expireReservation(record);
      record = await this.commitExpiryIfNeeded(txn, expiry);
      if (!observed || !isEventTag) {
        return {
          status: 200,
          body: { status: "omitted", reservation: null, fenceGateChecked: false, version: record.version },
        };
      }

      if (isFenceGateClosed(record)) {
        return fenceGateRejected();
      }
      const assertedEmpty = input.expectedHead === "";
      if (assertedEmpty && (record.events.length > 0 || record.head !== "")) {
        return {
          ...rejected(ASSERT_EMPTY_CONFLICT_REASON),
          body: { ...rejected(ASSERT_EMPTY_CONFLICT_REASON).body as JsonObject, version: record.version },
        };
      }
      if (record.head !== input.expectedHead) {
        return {
          ...rejected("consistency_head_mismatch"),
          body: { ...rejected("consistency_head_mismatch").body as JsonObject, version: record.version },
        };
      }

      const active = record.activeReservation;
      if (active !== null) {
        if (active.attemptId === input.attemptId && active.epoch === input.epoch) {
          return {
            status: 200,
            body: {
              status: "reserved",
              reservation: record.activeReservation,
              fenceGate: inspectFenceGate(record, input.attemptId),
              version: record.version,
            },
          };
        }
        return {
          ...rejected(assertedEmpty ? ASSERT_EMPTY_CONFLICT_REASON : "active_reservation_conflict"),
          body: {
            ...rejected(assertedEmpty ? ASSERT_EMPTY_CONFLICT_REASON : "active_reservation_conflict").body as JsonObject,
            version: record.version,
          },
        };
      }

      const fenceGate = inspectFenceGate(record, input.attemptId);
      record = advanceEpoch(record, input.attemptId, input.epoch);
      const now = logicalNow(record);
      const reservation: TagReservation = {
        attemptId: input.attemptId,
        epoch: input.epoch,
        token: crypto.randomUUID(),
        expectedHead: input.expectedHead,
        expiresAt: now + RESERVATION_WINDOW_MS,
        alarmDueAt: Date.now() + RESERVATION_WINDOW_MS,
      };
      const updated = assertedEmpty
        ? {
          ...record,
          activeReservation: reservation,
          alarmDueAt: reservation.alarmDueAt,
          updatedAt: nowIso(),
        }
        : await this.commit(txn, record, {
        activeReservation: reservation,
        alarmDueAt: reservation.alarmDueAt,
      });
      if (assertedEmpty) await this.write(txn, updated, "");
      return {
        status: 201,
        body: { status: "reserved", reservation, fenceGate, version: updated.version },
      };
    });
    return json(result.body, result.status);
  }

  private async cancel(tag: string, body: unknown, observation?: DurableObjectHandlerObservation): Promise<Response> {
    const parsed = reservationFrom(body);
    if (parsed.value === undefined) {
      return error(400, "invalid_tag_cancel", parsed.error ?? "Invalid cancel request");
    }
    const input = parsed.value;
    observation?.markFirstStorageRead();
    if (this.sqlStorage() !== undefined) {
      const result = await this.cancelSql(tag, input);
      return json(result.body, result.status);
    }
    const result = await this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
      const loaded = await this.recordFor(txn, tag);
      if (!loaded.exists && input.forceTombstone === true && input.createMissingTombstone !== true) {
        return { ...rejected("reservation_token_required"), body: { ...rejected("reservation_token_required").body as JsonObject, version: 0 } };
      }
      const expiry = expireReservation(loaded.record);
      let record = expiry.record;
      const tombstone = epochFor(record.tombstones, input.attemptId);
      const holdsReservation =
        record.activeReservation?.attemptId === input.attemptId &&
        record.activeReservation?.epoch === input.epoch;
      if (input.forceTombstone === true) {
        if (!holdsReservation && tombstone !== undefined && tombstone >= input.epoch) {
          record = await this.commitExpiryIfNeeded(txn, expiry);
          return { status: 200, body: { status: "cancelled", idempotent: true, version: record.version } };
        }

        // The cancel barrier owns only its (attemptId, epoch) tuple. An
        // unrelated active reservation must survive a delayed cancellation.
        record = advanceEpoch(record, input.attemptId, input.epoch);
        const updated = await this.commit(txn, record, {
          activeReservation: holdsReservation ? null : record.activeReservation,
          alarmDueAt: holdsReservation ? null : record.alarmDueAt,
          tombstones: withMaxEpoch(record.tombstones, input.attemptId, input.epoch),
        });
        return { status: 200, body: { status: "cancelled", idempotent: false, fenceConfirmed: true, version: updated.version } };
      }
      if (!holdsReservation && tombstone === input.epoch) {
        record = await this.commitExpiryIfNeeded(txn, expiry);
        return { status: 200, body: { status: "cancelled", idempotent: true, version: record.version } };
      }

      const epochError = operationEpochRejection(record, input.attemptId, input.epoch);
      if (epochError !== undefined) {
        record = await this.commitExpiryIfNeeded(txn, expiry);
        return { ...rejected(epochError), body: { ...rejected(epochError).body as JsonObject, version: record.version } };
      }
      const active = record.activeReservation;
      if (
        active === null ||
        active.attemptId !== input.attemptId ||
        active.epoch !== input.epoch ||
        active.token !== input.reservationToken
      ) {
        record = await this.commitExpiryIfNeeded(txn, expiry);
        return {
          ...rejected("reservation_token_required"),
          body: { ...rejected("reservation_token_required").body as JsonObject, version: record.version },
        };
      }

      record = advanceEpoch(record, input.attemptId, input.epoch);
      const updated = await this.commit(txn, record, {
        activeReservation: null,
        alarmDueAt: null,
        tombstones: withMaxEpoch(record.tombstones, input.attemptId, input.epoch),
      });
      return { status: 200, body: { status: "cancelled", idempotent: false, version: updated.version } };
    });
    return json(result.body, result.status);
  }

  private async seal(tag: string, body: unknown, observation?: DurableObjectHandlerObservation): Promise<Response> {
    const parsed = epochFrom(body);
    if (parsed.value === undefined) {
      return error(400, "invalid_tag_seal", parsed.error ?? "Invalid seal request");
    }
    const input = parsed.value;
    observation?.markFirstStorageRead();
    const result = await this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
      const loaded = await this.recordFor(txn, tag);
      const expiry = expireReservation(loaded.record);
      let record = expiry.record;
      const highest = epochFor(record.highestEpoch, input.attemptId);
      if (highest !== undefined && input.epoch < highest) {
        record = await this.commitExpiryIfNeeded(txn, expiry);
        return { status: 200, body: { status: "seal-ignored", highestEpoch: highest, version: record.version } };
      }

      const previouslySealed = epochFor(record.sealedEpoch, input.attemptId);
      record = advanceEpoch(record, input.attemptId, input.epoch);
      let activeReservation = record.activeReservation;
      let tombstones = record.tombstones;
      if (
        activeReservation !== null &&
        activeReservation.attemptId === input.attemptId &&
        activeReservation.epoch <= input.epoch
      ) {
        activeReservation = null;
        tombstones = withMaxEpoch(tombstones, input.attemptId, input.epoch);
      }
      const sealedEpoch = withMaxEpoch(record.sealedEpoch, input.attemptId, input.epoch);
      const changedBySeal =
        previouslySealed === undefined || previouslySealed < input.epoch || activeReservation !== record.activeReservation;
      if (!changedBySeal) {
        record = await this.commitExpiryIfNeeded(txn, expiry);
        return { status: 200, body: { status: "sealed", highestEpoch: input.epoch, version: record.version } };
      }
      const updated = await this.commit(txn, record, {
        sealedEpoch,
        tombstones,
        activeReservation,
        alarmDueAt: activeReservation === null ? null : activeReservation.alarmDueAt,
      });
      return { status: 200, body: { status: "sealed", highestEpoch: input.epoch, version: updated.version } };
    });
    return json(result.body, result.status);
  }

  /**
   * Coordinator-only import admission.  This is deliberately not a flag on
   * /append: it never creates an outbox row, never accepts a reservation, and
   * closes permanently once the coordinator reaches READY.
   */
  private async bootstrapAppend(tag: string, body: unknown, serviceId: string | null): Promise<Response> {
    const parsed = bootstrapAppendFrom(body, tag);
    if (parsed.value === undefined) return error(400, "invalid_bootstrap_admission", parsed.error ?? "Invalid bootstrap admission");
    if (serviceId !== parsed.value.targetServiceId) return error(409, "bootstrap_service_scope_mismatch", "Bootstrap target service does not match tag scope");
    const input = parsed.value;
    const result = await this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
      const loaded = await this.recordFor(txn, tag); const record = loaded.record;
      if (record.bootstrapAdmission?.closed) return rejected("bootstrap_closed_permanently");
      if (record.activeReservation !== null || record.fences.length > 0 || record.outbox.length > 0) return rejected("bootstrap_requires_empty_tag");
      const admission: TagBootstrapAdmission = record.bootstrapAdmission ?? { importId: input.importId, leaseEpoch: input.leaseEpoch, manifestDigest: input.manifestDigest, targetServiceId: input.targetServiceId, closed: false };
      if (admission.importId !== input.importId || admission.leaseEpoch !== input.leaseEpoch || admission.manifestDigest !== input.manifestDigest || admission.targetServiceId !== input.targetServiceId) return rejected("bootstrap_fencing_or_manifest_mismatch");
      const exact = input.candidates.every((candidate) => record.events.some((event) => event.eventId === candidate.eventId && event.suid === candidate.suid && event.payload === candidate.payload && event.eventTags.join("\u0000") === candidate.eventTags.join("\u0000") && event.eventType === candidate.eventType && event.provenance === candidate.provenance && event.timestamp === candidate.timestamp));
      if (exact) return { status: 200, body: { status: "duplicate", version: record.version } };
      // A coordinator may send several bounded chunks for one tag.  The
      // admission identity is fixed above; only duplicate replay, conflicting
      // identity, or non-monotonic continuation can be rejected here.
      if (hasEventConflict(record, input.candidates) || monotonicityViolation(record.head, input.candidates)) return rejected("bootstrap_identity_or_order_conflict");
      const events: TagEvent[] = input.candidates.map((candidate) => ({ attemptId: `bootstrap:${input.importId}`, eventId: candidate.eventId, suid: candidate.suid, payload: candidate.payload, eventTags: candidate.eventTags, allocatorLineageId: candidate.allocatorLineageId, eventType: candidate.eventType, provenance: candidate.provenance, timestamp: candidate.timestamp }));
      const updated = await this.commit(
        txn,
        record,
        { bootstrapAdmission: admission, head: input.candidates.at(-1)!.suid, events: [...record.events, ...events] },
        input.targetServiceId,
      );
      return { status: 201, body: { status: "bootstrap_admitted", version: updated.version } };
    });
    return json(result.body, result.status);
  }

  private async closeBootstrap(tag: string, body: unknown): Promise<Response> {
    if (!isObject(body) || !isNonEmptyString(body.importId) || !isEpoch(body.leaseEpoch)) return error(400, "invalid_bootstrap_close", "bootstrap importId and leaseEpoch are required");
    const result = await this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
      const loaded = await this.recordFor(txn, tag); const record = loaded.record; const admission = record.bootstrapAdmission;
      if (admission === null || admission.importId !== body.importId || admission.leaseEpoch !== body.leaseEpoch) return rejected("bootstrap_fencing_or_manifest_mismatch");
      if (admission.closed) return { status: 200, body: { status: "closed", version: record.version } };
      const updated = await this.commit(txn, record, { bootstrapAdmission: { ...admission, closed: true } });
      return { status: 200, body: { status: "closed", version: updated.version } };
    });
    return json(result.body, result.status);
  }

  private directDoorbellPreflight(domainDeliveryClass?: string): ReturnType<typeof preflightDirectDoorbell> {
    const domainClass = domainDeliveryClass === undefined
      ? undefined
      : readDomainDeliveryClass({ DOMAIN_DELIVERY_CLASS: domainDeliveryClass });
    const config = readDirectDoorbellConfig(this.env as unknown as Record<string, unknown>, domainClass);
    const preflight = preflightDirectDoorbell(config, config.allowedViews.length);
    if (preflight.status === "fail-fast") {
      throw new Error(`direct_doorbell_preflight_failed:${preflight.reason}`);
    }
    if (
      config.deliveryClass === "immediate-preferred" &&
      config.enabled &&
      this.env.DOWNSTREAM_DOORBELL === undefined
    ) {
      if (config.degradation === "fail-fast") {
        throw new Error("direct_doorbell_capability_missing");
      }
    }
    return preflight;
  }

  private async append(
    tag: string,
    body: unknown,
    serviceId: string | null,
    domainDeliveryClass?: string,
    observation?: DurableObjectHandlerObservation,
  ): Promise<Response> {
    const parsed = appendFrom(body, tag);
    if (parsed.value === undefined) {
      return error(400, "invalid_tag_append", parsed.error ?? "Invalid append request");
    }
    const input = parsed.value;
    try {
      const doorbellPreflight = this.directDoorbellPreflight(domainDeliveryClass);
      observation?.markFirstStorageRead();
      // A real SQLite-backed DO takes the indexed transaction below. The
      // fallback only exists for deliberately minimal transport seams that do
      // not provide `storage.sql`; it is never a second persisted record
      // format in a deployed Tag DO.
      if (this.sqlStorage() !== undefined) {
        const sourcePartitionWasRegistered = serviceId !== null && serviceId.length > 0 &&
          this.sourcePartitionRegistrationStatus(tag, serviceId) === "registered";
        const sourcePartitionRegistration = serviceId !== null && serviceId.length > 0
          ? await this.ensureSourcePartitionBeforeFirstAppend(tag, serviceId)
          : "unconfigured" as const;
        const result = await this.appendSql(
          tag,
          input,
          serviceId,
          sourcePartitionRegistration !== "unconfigured",
        );
        for (const fact of result.hopFacts ?? []) {
          this.scheduleDurableHop({
            stage: "tag-append-committed",
            serviceId: serviceId ?? "",
            eventId: fact.eventId,
            suid: fact.suid,
            attemptId: fact.attemptId,
            partitionTag: fact.tag,
            observedAt: fact.tagAppendCommittedAt,
          });
          this.scheduleDurableHop({
            stage: "outbox-obligation-written",
            serviceId: serviceId ?? "",
            eventId: fact.eventId,
            suid: fact.suid,
            attemptId: fact.attemptId,
            partitionTag: fact.tag,
            observedAt: fact.obligationWrittenAt,
          });
        }
        if (
          (result.status === 201 || result.status === 200) &&
          serviceId !== null && serviceId.length > 0 &&
          sourcePartitionRegistration !== "unconfigured"
        ) {
          this.scheduleSourcePartitionWatermark(tag, serviceId);
        }
        const response = json(result.body, result.status);
        if (
          result.status === 201 &&
          serviceId !== null && serviceId.length > 0 &&
          this.env.AUTO_DRAIN_OUTBOX === "true" &&
          (this.env.DOWNSTREAM_QUEUE !== undefined ||
            (doorbellPreflight.status === "ready" && this.env.DOWNSTREAM_DOORBELL !== undefined))
        ) {
          const directRows = doorbellPreflight.status === "ready" && this.env.DOWNSTREAM_DOORBELL !== undefined
            ? await this.directDeliveryBeforeResponse(tag, serviceId)
            : undefined;
          // An explicitly unconfigured completeness store is the pre-G65
          // local composition: it has no global-admission authority to
          // consult. Keep the committed response and the ordinary Queue
          // fallback on that path without introducing a synchronous D1
          // attempt merely because a non-authoritative local D1 binding is
          // present. Configured G44 stores retain the bounded admission
          // attempt and header contract above.
          if (sourcePartitionRegistration !== "unconfigured" || sourcePartitionWasRegistered) {
            withGlobalAdmission(
              response,
              await this.globalAdmissionBeforeResponse(tag, serviceId, directRows),
            );
          }
          this.startAutoDrainBeforeResponse(tag, serviceId, domainDeliveryClass, directRows);
        }
        return response;
      }
      const result = await this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
        const loaded = await this.recordFor(txn, tag);
        let record = loaded.record;

        // Required order begins here: exact duplicate is before any epoch or token check.
        if (batchIsExactDuplicate(record, input)) {
          return { status: 200, body: { status: "duplicate", version: record.version } };
        }

        const expiry = expireReservation(record);
        record = expiry.record;
        const epochError = operationEpochRejection(record, input.attemptId, input.epoch);
        if (epochError !== undefined) {
          record = await this.commitExpiryIfNeeded(txn, expiry);
          return { ...rejected(epochError), body: { ...rejected(epochError).body as JsonObject, version: record.version } };
        }

        // Exact duplicates are intentionally above the epoch check. Every
        // non-duplicate append checks the set gate before ownership/token or
        // content guards, so a fence cannot be bypassed by a stale caller.
        if (isFenceGateClosed(record)) {
          await this.commitExpiryIfNeeded(txn, expiry);
          return fenceGateRejected();
        }

        const active = record.activeReservation;
        const confirmsReservation =
          active !== null &&
          active.attemptId === input.attemptId &&
          active.epoch === input.epoch &&
          active.token === input.reservationToken;
        if (
          active !== null &&
          (active.attemptId !== input.attemptId ||
            active.epoch !== input.epoch ||
            active.token !== input.reservationToken)
        ) {
          record = await this.commitExpiryIfNeeded(txn, expiry);
          return {
            ...rejected("reservation_token_required"),
            body: { ...rejected("reservation_token_required").body as JsonObject, version: record.version },
          };
        }
        if (hasEventConflict(record, input.candidates)) {
          record = await this.commitExpiryIfNeeded(txn, expiry);
          return {
            ...rejected("event_conflict"),
            body: { ...rejected("event_conflict").body as JsonObject, version: record.version },
          };
        }
        if (monotonicityViolation(record.head, input.candidates)) {
          record = await this.commitExpiryIfNeeded(txn, expiry);
          return {
            ...rejected("non_monotonic_suid"),
            body: { ...rejected("non_monotonic_suid").body as JsonObject, version: record.version },
          };
        }

        const fenceGate = inspectFenceGate(record, input.attemptId);
        record = advanceEpoch(record, input.attemptId, input.epoch);
        const appendedEvents: TagEvent[] = input.candidates.map((candidate) => ({
          attemptId: input.attemptId,
          eventId: candidate.eventId,
          suid: candidate.suid,
          payload: candidate.payload,
          eventTags: candidate.eventTags,
          allocatorLineageId: candidate.allocatorLineageId,
          eventType: candidate.eventType,
          provenance: candidate.provenance,
          timestamp: candidate.timestamp,
        }));
        const outboxRows: TagOutboxRow[] = input.candidates.map((candidate) => ({
          attemptId: input.attemptId,
          eventId: candidate.eventId,
          suid: candidate.suid,
          payload: candidate.payload,
          allocatorLineageId: candidate.allocatorLineageId,
          eventType: candidate.eventType,
          provenance: candidate.provenance,
          timestamp: candidate.timestamp,
        }));
        const head = input.candidates[input.candidates.length - 1]!.suid;
        const appendedOnly = changed(record, {
          head,
          events: [...record.events, ...appendedEvents],
          outbox: [...record.outbox, ...outboxRows],
        });
        await this.write(txn, appendedOnly, serviceId ?? "");
        if (input.faultInjection === "after-append-before-confirm") {
          throw new AppendTransactionFault("Simulated interruption before reservation confirmation");
        }

        const updated = changed(record, {
          head,
          events: [...record.events, ...appendedEvents],
          outbox: [...record.outbox, ...outboxRows],
          activeReservation: null,
          alarmDueAt: null,
          confirmations: confirmsReservation
            ? withMaxEpoch(record.confirmations, input.attemptId, input.epoch)
            : record.confirmations,
        });
        await this.write(txn, updated, serviceId ?? "");
        return {
          status: 201,
          body: { status: "appended", fenceGate, version: updated.version },
        };
      });
      const response = json(result.body, result.status);
      if (
        result.status === 201 &&
        serviceId !== null && serviceId.length > 0 &&
        this.env.AUTO_DRAIN_OUTBOX === "true" &&
        (this.env.DOWNSTREAM_QUEUE !== undefined ||
          (doorbellPreflight.status === "ready" && this.env.DOWNSTREAM_DOORBELL !== undefined))
      ) {
        const directRows = doorbellPreflight.status === "ready" && this.env.DOWNSTREAM_DOORBELL !== undefined
          ? await this.directDeliveryBeforeResponse(tag, serviceId)
          : undefined;
        withGlobalAdmission(
          response,
          await this.globalAdmissionBeforeResponse(tag, serviceId, directRows),
        );
        this.startAutoDrainBeforeResponse(tag, serviceId, domainDeliveryClass, directRows);
      }
      return response;
    } catch (failure) {
      if (failure instanceof PartitionRegistrationUnavailableError) {
        return error(503, "partition_registration_unavailable", "Source partition registration is unavailable; retry the commit.", true);
      }
      if (failure instanceof AppendTransactionFault) {
        return error(
          503,
          "simulated_append_crash",
          "Simulated interruption before atomic append and confirmation commit",
        );
      }
      return error(500, "tag_append_failure", "Tag append could not be persisted");
    }
  }

  /**
   * Claim and run the opted-in direct unsafe path after the append transaction
   * has committed, but before the 201 response is returned. The rows are
   * handed to the Queue drain afterwards so the durable Queue remains the
   * owner of global admission, ordering, retries, and DLQ recovery.
   *
   * A pending-row read can fail independently of the already committed
   * append. In that case the caller falls back to the ordinary Queue drain;
   * it never turns a durable acceptance into a response failure.
   */
  private async directDeliveryBeforeResponse(
    tag: string,
    serviceId: string,
  ): Promise<readonly DownstreamOutboxMessage[] | undefined> {
    let rows: readonly DownstreamOutboxMessage[] | undefined;
    const attempt = await this.boundedDerivedWrite(async () => {
      const pending = await this.pendingOutbox(tag, serviceId, { nowMs: Date.now(), force: true });
      if (!pending.ok) throw new Error(`direct outbox pending read failed with ${pending.status}`);
      const body = await pending.json<{ rows?: DownstreamOutboxMessage[] }>();
      rows = body.rows ?? [];
      await this.deliverDirectRows(rows);
    });
    if (attempt.status === "timeout") {
      // Rows already claimed by pendingOutbox are handed to the Queue without
      // another direct attempt.  If the pending read itself hung, rows stays
      // undefined and the unchanged scheduler-backed drain rereads it later.
      console.warn("direct_doorbell_before_response", {
        status: "queued-degraded",
        reason: "direct_doorbell_before_response_timeout",
        budgetMs: G65_DERIVED_WRITE_BUDGET_MS,
      });
      return rows;
    }
    if (attempt.status === "failed") {
      console.warn("direct_doorbell_before_response", {
        status: "queued-degraded",
        reason: "direct_doorbell_before_response_failed",
        error: String(attempt.error),
      });
      return rows;
    }
    return rows;
  }

  /**
   * Attempt the same idempotent D1 admission used by the Queue consumer.
   * This is a derived write only: the Tag event, outbox obligation, and local
   * receipt are already durable, and the Queue remains the guarantee.
   */
  private async globalAdmissionBeforeResponse(
    tag: string,
    serviceId: string,
    preloadedRows?: readonly DownstreamOutboxMessage[],
  ): Promise<GlobalAdmissionStatus> {
    let rows = preloadedRows;
    const admissionStartedAt = Date.now();
    const completedAtByEventId = new Map<string, number>();
    const attempt = await this.boundedDerivedWrite(async () => {
      if (rows === undefined) {
        const pending = await this.pendingOutbox(tag, serviceId, { nowMs: Date.now(), force: true });
        if (!pending.ok) throw new Error(`global admission pending read failed with ${pending.status}`);
        const body = await pending.json<{ rows?: DownstreamOutboxMessage[] }>();
        rows = body.rows ?? [];
      }
      if (rows.length === 0) return;
      if (this.env.D1 === undefined) throw new Error("global admission D1 binding is unavailable");
      const store = new D1EventStore(this.env.D1);
      await store.initialize();
      for (const row of rows) {
        const outcome = await store.recordDelivery(row, Date.now(), "fast");
        if (outcome.outcome !== "stored") {
          throw new Error(`global admission rejected:${outcome.outcome}`);
        }
        completedAtByEventId.set(row.eventId, Date.now());
      }
    });
    const admissionFinishedAt = Date.now();
    const admissionOutcome: G65AdmissionOutcome = attempt.status === "timeout"
      ? "unknown"
      : attempt.status === "failed"
        ? "not-admitted"
        : "admitted";
    for (const row of rows ?? []) {
      this.scheduleG65AdmissionAttempt({
        serviceId: row.serviceId,
        eventId: row.eventId,
        suid: row.suid,
        attemptId: row.attemptId,
        partitionTag: row.tag,
        deliverySource: "fast",
        admissionStartedAt,
        admissionFinishedAt,
        outcome: completedAtByEventId.has(row.eventId) ? "admitted" : admissionOutcome,
        globalCompletionObservedAt: completedAtByEventId.get(row.eventId) ?? null,
      });
    }
    if (attempt.status === "timeout") {
      console.warn("global_admission_before_response", {
        status: "unknown",
        reason: "global_admission_before_response_timeout",
        budgetMs: G65_DERIVED_WRITE_BUDGET_MS,
      });
      return "unknown";
    }
    if (attempt.status === "failed") {
      console.warn("global_admission_before_response", {
        status: "not-admitted",
        reason: "global_admission_before_response_failed",
        error: String(attempt.error),
      });
      return "not-admitted";
    }
    return "admitted";
  }

  private scheduleG65AdmissionAttempt(input: Parameters<typeof recordG65AdmissionAttempt>[1]): void {
    const database = this.env.D1;
    if (database === undefined) return;
    this.ctx.waitUntil(recordG65AdmissionAttempt(database, input).catch(() => undefined));
  }

  /**
   * Bound a derived attempt without cancelling or making its eventual result
   * part of commit semantics.  The rejection branch is attached immediately
   * so a late D1/doorbell failure cannot become an unhandled rejection.
   */
  private async boundedDerivedWrite<T>(operation: () => Promise<T>): Promise<
    | { readonly status: "completed"; readonly value: T }
    | { readonly status: "failed"; readonly error: unknown }
    | { readonly status: "timeout" }
  > {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operationResult = Promise.resolve()
      .then(operation)
      .then(
        (value): { readonly status: "completed"; readonly value: T } => ({ status: "completed", value }),
        (error): { readonly status: "failed"; readonly error: unknown } => ({ status: "failed", error }),
      );
    const timeout = new Promise<{ readonly status: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ status: "timeout" }), G65_DERIVED_WRITE_BUDGET_MS);
    });
    try {
      return await Promise.race([operationResult, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * The append transaction has durably committed the Tag event, outbox
   * obligation, and receipt before this handoff is started. A direct delivery
   * has already run when `preclaimedRows` is present; the retained promise
   * then performs only the unchanged Queue submission for those same bytes.
   * With no preclaimed rows this remains the existing waitUntil-backed drain,
   * including its direct-before-Queue behavior for alarms and fallback paths.
   */
  private startAutoDrainBeforeResponse(
    tag: string,
    serviceId: string,
    domainDeliveryClass?: string,
    preclaimedRows?: readonly DownstreamOutboxMessage[],
  ): void {
    const drain = this.autoDrainOutbox(
      tag,
      serviceId,
      domainDeliveryClass,
      undefined,
      preclaimedRows,
      preclaimedRows !== undefined,
    ).catch(() => undefined);
    this.ctx.waitUntil(drain);
  }

  private async deliverDirectRows(rows: readonly DownstreamOutboxMessage[]): Promise<void> {
    for (const row of rows) {
      // `row` is the object created by pendingOutbox. The bytes are captured
      // once for correlation/equality evidence and the exact same envelope is
      // handed to both transports; no reduced TagOutboxRow is reconstructed.
      const envelopeBytes = downstreamEnvelopeBytes(row);
      const correlationId = deliveryCorrelationId(row, "fast");
      try {
        const delivered = await this.env.DOWNSTREAM_DOORBELL!.deliver(row);
        const resultCorrelationId =
          typeof delivered === "object" && delivered !== null &&
          "correlationId" in delivered &&
          typeof (delivered as { correlationId?: unknown }).correlationId === "string"
            ? (delivered as { correlationId: string }).correlationId
            : correlationId;
        if (
          typeof delivered === "object" && delivered !== null &&
          "fastDisposition" in delivered &&
          (delivered as { fastDisposition?: unknown }).fastDisposition === "failed"
        ) {
          console.warn("direct_doorbell_status", {
            status: "failed",
            reason: "receiver_delivery_failed",
            correlationId: resultCorrelationId,
            envelopeBytes,
          });
          throw new Error("doorbell_receiver_delivery_failed");
        }
        console.log("direct_doorbell_delivery", {
          correlationId: resultCorrelationId,
          envelopeBytes,
          status: "success",
        });
      } catch (error) {
        // A direct failure is explicit and the durable Queue is the backstop.
        // Replaying the same envelope is safe because the core is
        // receipt-idempotent; this is not a silent capability downgrade.
        console.warn("direct_doorbell_status", {
          status: "queued-degraded",
          reason: "direct_doorbell_delivery_failed",
          correlationId,
          envelopeBytes,
          failureKind: classifyDirectDoorbellFailure(error),
          error: String(error),
        });
      }
    }
  }

  private async autoDrainOutbox(
    tag: string,
    serviceId: string,
    domainDeliveryClass?: string,
    limit?: number,
    preclaimedRows?: readonly DownstreamOutboxMessage[],
    skipDirect = false,
  ): Promise<void> {
    const domainClass = domainDeliveryClass === undefined
      ? undefined
      : readDomainDeliveryClass({ DOMAIN_DELIVERY_CLASS: domainDeliveryClass });
    const config = readDirectDoorbellConfig(this.env as unknown as Record<string, unknown>, domainClass);
    const preflight = preflightDirectDoorbell(config, config.allowedViews.length);
    if (preflight.status === "fail-fast") {
      throw new Error(`direct_doorbell_preflight_failed:${preflight.reason}`);
    }
    const rows = preclaimedRows ?? await (async () => {
      const pending = await this.pendingOutbox(tag, serviceId, { nowMs: Date.now(), limit });
      if (!pending.ok) {
        throw new Error(`automatic outbox pending read failed with ${pending.status}`);
      }
      const body = await pending.json<{ rows?: DownstreamOutboxMessage[] }>();
      return body.rows ?? [];
    })();
    const directReady =
      preflight.status === "ready" &&
      config.deliveryClass === "immediate-preferred" &&
      config.enabled &&
      this.env.DOWNSTREAM_DOORBELL !== undefined;
    const queue = this.env.DOWNSTREAM_QUEUE;
    for (const row of rows) {
      // `row` is the object created by pendingOutbox. The bytes are captured
      // once for correlation/equality evidence and the exact same envelope is
      // handed to both transports; no reduced TagOutboxRow is reconstructed.
      const envelopeBytes = downstreamEnvelopeBytes(row);
      const correlationId = deliveryCorrelationId(row, "fast");
      if (directReady && !skipDirect) await this.deliverDirectRows([row]);
      if (!directReady && config.deliveryClass === "immediate-preferred" && config.enabled) {
        console.warn("direct_doorbell_status", {
          status: "queued-degraded",
          reason: "direct_doorbell_not_ready",
          correlationId,
          envelopeBytes,
        });
      }
      if (queue !== undefined) {
        try {
          await queue.send(row, { contentType: "json" });
          this.scheduleDurableHop({
            stage: "queue-send-returned",
            serviceId,
            eventId: row.eventId,
            suid: row.suid,
            attemptId: row.attemptId,
            partitionTag: tag,
            transport: "queue",
            observedAt: Date.now(),
          });
        } catch (failure) {
          // A failed source-to-sink handoff is itself source state.  Do not
          // let one poison row skip a later due row or suppress re-arming.
          await this.recordOutboxFailure(tag, row, failure);
        }
      }
    }
  }

  /** G60 writes are observation-only and stay outside the append/drain result. */
  private scheduleDurableHop(input: G60DurableHopObservation): void {
    if (this.env.D1 === undefined) return;
    this.ctx.waitUntil(recordDurableHop(this.env.D1, input).catch(() => undefined));
  }

  private async confirm(tag: string, body: unknown): Promise<Response> {
    const parsed = reservationFrom(body);
    if (parsed.value === undefined) {
      return error(400, "invalid_tag_confirm", parsed.error ?? "Invalid confirm request");
    }
    const input = parsed.value;
    const result = await this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
      const loaded = await this.recordFor(txn, tag);
      const expiry = expireReservation(loaded.record);
      let record = expiry.record;
      if (epochFor(record.confirmations, input.attemptId) === input.epoch) {
        record = await this.commitExpiryIfNeeded(txn, expiry);
        return { status: 200, body: { status: "confirmed", idempotent: true, version: record.version } };
      }
      const epochError = operationEpochRejection(record, input.attemptId, input.epoch);
      if (epochError !== undefined) {
        record = await this.commitExpiryIfNeeded(txn, expiry);
        return { ...rejected(epochError), body: { ...rejected(epochError).body as JsonObject, version: record.version } };
      }
      const active = record.activeReservation;
      if (
        active !== null &&
        active.attemptId === input.attemptId &&
        active.epoch === input.epoch &&
        active.token === input.reservationToken
      ) {
        record = await this.commitExpiryIfNeeded(txn, expiry);
        return {
          ...rejected("append_required_for_confirmation"),
          body: { ...rejected("append_required_for_confirmation").body as JsonObject, version: record.version },
        };
      }
      record = await this.commitExpiryIfNeeded(txn, expiry);
      return {
        ...rejected("confirmation_not_found"),
        body: { ...rejected("confirmation_not_found").body as JsonObject, version: record.version },
      };
    });
    return json(result.body, result.status);
  }

  private async installFence(tag: string, body: unknown): Promise<Response> {
    const parsed = fenceFrom(body);
    if (parsed.value === undefined) {
      return error(400, "invalid_tag_fence", parsed.error ?? "Invalid fence request");
    }
    const input = parsed.value;
    const result = await this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
      const loaded = await this.recordFor(txn, tag);
      const expiry = expireReservation(loaded.record);
      let record = expiry.record;
      const existing = fenceFor(record.fences, input.reason, input.attemptId);
      if (existing?.epoch === input.epoch) {
        record = await this.commitExpiryIfNeeded(txn, expiry);
        return { status: 200, body: { status: "fence-installed", idempotent: true, durable: true, version: record.version } };
      }
      const epochError = fenceEpochRejection(record, input.reason, input.attemptId, input.epoch);
      if (epochError !== undefined) {
        record = await this.commitExpiryIfNeeded(txn, expiry);
        return { ...rejected(epochError), body: { ...rejected(epochError).body as JsonObject, version: record.version } };
      }
      const overlap = overlappingFenceReason(record, input.reason);
      if (overlap !== undefined) {
        record = await this.commitExpiryIfNeeded(txn, expiry);
        return {
          ...rejected("fence_overlap_blocked"),
          body: {
            ...rejected("fence_overlap_blocked").body as JsonObject,
            error: `Fence authorization is blocked by ${overlap}`,
            version: record.version,
          },
        };
      }
      record = advanceEpoch(record, input.attemptId, input.epoch);
      const fence: TagFence = { reason: input.reason, attemptId: input.attemptId, epoch: input.epoch };
      const updated = await this.commit(txn, record, {
        fences: withFence(record.fences, fence),
        clearedFences: withoutFence(record.clearedFences, input.reason, input.attemptId),
      });
      return { status: 201, body: { status: "fence-installed", idempotent: false, durable: true, version: updated.version } };
    });
    return json(result.body, result.status);
  }

  /**
   * Allocator-owned recovery reads only durable Tag facts. It is an internal
   * DO-to-DO route: no public caller can turn it into a write or safe-read
   * bypass. Absence remains unknown and is retried by the allocator alarm.
   */
  private async issuanceStatus(tag: string, serviceId: string | null, body: unknown): Promise<Response> {
    if (!isObject(body) || !isNonEmptyString(serviceId) || !isNonEmptyString(body.attemptId) ||
        !isNonEmptyString(body.eventId) || !isNonEmptyString(body.suid) || !isNonEmptyString(body.allocatorLineageId)) {
      return error(400, "g70_recovery_invalid", "G70 recovery identity is incomplete");
    }
    const sql = this.sqlStorage();
    if (sql !== undefined) {
      const event = sql.exec<SqlRow>(
        `SELECT event_id FROM tag_outbox_obligation
          WHERE service_id = ? AND event_id = ? AND attempt_id = ? AND suid = ? AND allocator_lineage_id = ?
          LIMIT 1`,
        serviceId,
        body.eventId,
        body.attemptId,
        body.suid,
        body.allocatorLineageId,
      ).toArray()[0];
      if (event !== undefined) return json({ disposition: "installed", eventId: body.eventId, suid: body.suid });
      const fenced = sql.exec<SqlRow>(
        `SELECT attempt_id FROM tag_tombstone WHERE attempt_id = ?
         UNION ALL SELECT attempt_id FROM tag_fence WHERE attempt_id = ? LIMIT 1`,
        body.attemptId,
        body.attemptId,
      ).toArray()[0];
      if (fenced !== undefined) return json({ disposition: "fenced", fenceConfirmed: true, eventId: body.eventId, suid: body.suid });
      return json({ disposition: "unknown", eventId: body.eventId, suid: body.suid });
    }
    const record = this.readStoredRecord(tag);
    if (record === undefined) return json({ disposition: "unknown", eventId: body.eventId, suid: body.suid });
    if (record.events.some((event) => event.eventId === body.eventId && event.attemptId === body.attemptId && event.suid === body.suid && event.allocatorLineageId === body.allocatorLineageId)) {
      return json({ disposition: "installed", eventId: body.eventId, suid: body.suid });
    }
    if (record.tombstones.some((entry) => entry.attemptId === body.attemptId) || record.fences.some((entry) => entry.attemptId === body.attemptId)) {
      return json({ disposition: "fenced", fenceConfirmed: true, eventId: body.eventId, suid: body.suid });
    }
    return json({ disposition: "unknown", eventId: body.eventId, suid: body.suid });
  }

  private async clearFence(tag: string, body: unknown): Promise<Response> {
    const parsed = fenceFrom(body);
    if (parsed.value === undefined) {
      return error(400, "invalid_tag_fence", parsed.error ?? "Invalid fence request");
    }
    const input = parsed.value;
    const result = await this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
      const loaded = await this.recordFor(txn, tag);
      const expiry = expireReservation(loaded.record);
      let record = expiry.record;
      const existing = fenceFor(record.fences, input.reason, input.attemptId);
      const alreadyCleared = fenceFor(record.clearedFences, input.reason, input.attemptId);
      if (alreadyCleared !== undefined && alreadyCleared.epoch >= input.epoch) {
        record = await this.commitExpiryIfNeeded(txn, expiry);
        return { status: 200, body: { status: "fence-cleared", idempotent: true, version: record.version } };
      }
      const epochError = existing !== undefined && input.epoch < existing.epoch
        ? "stale_epoch"
        : fenceEpochRejection(record, input.reason, input.attemptId, input.epoch);
      if (epochError !== undefined) {
        record = await this.commitExpiryIfNeeded(txn, expiry);
        return { ...rejected(epochError), body: { ...rejected(epochError).body as JsonObject, version: record.version } };
      }
      record = advanceEpoch(record, input.attemptId, input.epoch);
      const fence: TagFence = { reason: input.reason, attemptId: input.attemptId, epoch: input.epoch };
      const updated = await this.commit(txn, record, {
        fences: withoutFence(record.fences, input.reason, input.attemptId),
        clearedFences: withFence(record.clearedFences, fence),
      });
      return { status: 200, body: { status: "fence-cleared", idempotent: false, version: updated.version } };
    });
    return json(result.body, result.status);
  }

  /**
   * Returns Tag-side repair facts only.  Journal observations are deliberately
   * absent: they are progress telemetry and can never grant repair authority.
   */
  private async repairFacts(tag: string): Promise<Response> {
    const result = await this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
      const record = this.readStoredRecord(tag);
      if (record === undefined) {
        return { status: 404, body: { error: "Tag has no durable state yet", code: "tag_not_found" } };
      }
      const normalized = requireG32TagRecord(record);
      if (normalized.tag !== tag) {
        return { status: 409, body: { error: "Tag Durable Object identity changed", code: "tag_identity_conflict" } };
      }
      const facts = (await txn.get<RepairFacts>(REPAIR_FACTS_KEY)) ?? repairFactsDefault();
      return {
        status: 200,
        body: {
          tag: normalized.tag,
          head: normalized.head,
          version: normalized.version,
          events: normalized.events,
          outbox: normalized.outbox,
          fences: normalized.fences,
          clearedFences: normalized.clearedFences,
          repairOwner: normalized.repairOwner,
          repairLeaseUntil: normalized.repairLeaseUntil,
          highestRepairEpoch: normalized.highestRepairEpoch,
          repairScope: normalized.repairScope,
          repairScopeVersion: normalized.repairScopeVersion,
          facts,
        },
      };
    });
    return json(result.body, result.status);
  }

  /**
   * Internal outbox handoff: enqueuedAt is persisted before any Queue send so
   * a crash after send but before delivered marking replays the same clock
   * fact. It never changes the immutable event/outbox row.
   */
  private async pendingOutbox(tag: string, serviceId: string | null, body: unknown): Promise<Response> {
    const parsed = outboxPendingFrom(body);
    if (parsed.value === undefined) {
      return error(400, "invalid_outbox_pending", parsed.error ?? "Invalid outbox pending request");
    }
    if (!isNonEmptyString(serviceId)) {
      return error(400, "outbox_service_identity_required", "Outbox delivery requires a service identity");
    }
    const input = parsed.value;
    const result = await this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
      if (this.sqlStorage() !== undefined) {
        return this.pendingSqlOutbox(txn, tag, serviceId, input.nowMs, input.limit, input.force === true);
      }
      const record = this.readStoredRecord(tag);
      if (record === undefined) {
        return { status: 404, body: { error: "Tag has no durable state yet", code: "tag_not_found" } };
      }
      if (record.tag !== tag) {
        return { status: 409, body: { error: "Tag Durable Object identity changed", code: "tag_identity_conflict" } };
      }
      const deliveries = (await txn.get<TagOutboxDelivery[]>(OUTBOX_DELIVERIES_KEY)) ?? this.fallbackOutboxDeliveries;
      const byRow = new Map(deliveries.map((delivery) => [outboxRowKey(delivery), delivery]));
      let changedDeliveries = deliveries;
      const rows: Array<{
        version: 1;
        serviceId: string;
        tag: string;
        attemptId: string;
        eventId: string;
        suid: string;
        payload: string;
        allocatorLineageId: string;
        eventTags: string[];
        eventType: string;
        provenance: "g32";
        timestamp: string;
        causationId: string;
        correlationId: string;
        executedUser: string;
        enqueuedAt: number;
        completeness: DownstreamOutboxMessage["completeness"];
      }> = [];
      for (const row of record.outbox) {
        if (input.limit !== undefined && rows.length >= input.limit) break;
        const key = outboxRowKey(row);
        let delivery = byRow.get(key);
        if (delivery === undefined) {
          delivery = { ...row, enqueuedAt: input.nowMs, deliveredAt: null };
          changedDeliveries = [...changedDeliveries, delivery];
          byRow.set(key, delivery);
        }
        if (delivery.deliveredAt !== null) {
          continue;
        }
        const event = record.events.find((candidate) =>
          candidate.attemptId === row.attemptId &&
          candidate.eventId === row.eventId &&
          candidate.suid === row.suid &&
          candidate.payload === row.payload &&
          candidate.eventType === row.eventType &&
          candidate.provenance === row.provenance &&
          candidate.timestamp === row.timestamp,
        );
        if (event === undefined) {
          return {
            status: 409,
            body: { error: "Outbox row has no matching durable event", code: "outbox_event_missing" },
          };
        }
        const metadata = serializedEventMetadata(row.eventId);
        const artifact = await this.obligationArtifact(event, serviceId, tag);
        rows.push({
          version: 1,
          serviceId,
          tag,
          attemptId: row.attemptId,
          eventId: row.eventId,
          suid: row.suid,
          payload: row.payload,
          allocatorLineageId: row.allocatorLineageId,
          eventTags: event.eventTags,
          eventType: event.eventType,
          provenance: "g32",
          timestamp: event.timestamp,
          causationId: metadata.causationId,
          correlationId: metadata.correlationId,
          executedUser: metadata.executedUser,
          enqueuedAt: delivery.enqueuedAt,
          completeness: {
            canonicalBytesBase64: arrayBufferBase64(artifact.canonicalBytes),
            eventDigest: artifact.eventDigest,
            declaredTagSet: JSON.parse(artifact.declaredTagSet) as string[],
            localCommittedMembership: JSON.parse(artifact.localMembership) as Array<{ serviceId: string; eventId: string; tag: string }>,
            // The non-SQL fallback is a transport-only test seam. Its local
            // ordinal is still explicit so it cannot masquerade as a global
            // sequence during receipt verification.
            obligationSequence: record.outbox.findIndex((candidate) => outboxRowKey(candidate) === outboxRowKey(row)) + 1,
          },
        });
      }
      if (changedDeliveries !== deliveries) {
        this.fallbackOutboxDeliveries = changedDeliveries;
        await txn.put(OUTBOX_DELIVERIES_KEY, changedDeliveries);
      }
      return { status: 200, body: { rows } };
    });
    return json(result.body, result.status);
  }

  /**
   * Source-side obligation scanner.  It deliberately does not call the Queue,
   * the doorbell, `pendingOutbox`, or any detector.  An obligation therefore
   * remains visible when delivery is disabled, throws, or has not started.
   */
  private async scanOutboxObligations(tag: string, nowMs: number): Promise<Response> {
    const result = await this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
      const sql = this.sqlStorage();
      if (sql === undefined) {
        const record = this.readStoredRecord(tag);
        if (record === undefined) {
          return { status: 404, body: { error: "Tag has no durable state yet", code: "tag_not_found" } };
        }
        const deliveries = (await txn.get<TagOutboxDelivery[]>(OUTBOX_DELIVERIES_KEY)) ?? this.fallbackOutboxDeliveries;
        const delivered = new Set(deliveries
          .filter((delivery) => delivery.deliveredAt !== null)
          .map((delivery) => outboxRowKey(delivery)));
        const findings = record.outbox
          .filter((row) => !delivered.has(outboxRowKey(row)))
          .map((row, index) => ({
            code: "tag_outbox_obligation_unacknowledged",
            obligationSequence: index + 1,
            attemptId: row.attemptId,
            eventId: row.eventId,
            status: "pending",
            nextAttemptAt: nowMs,
            source: "tag_outbox_obligation",
          }));
        return {
          status: 200,
          body: {
            status: "scan-complete",
            source: "tag_outbox_obligation",
            scannedAt: nowMs,
            pendingCount: findings.length,
            findings,
          },
        };
      }
      const identity = sql.exec<SqlRow>("SELECT tag FROM tag_identity WHERE singleton = 1").toArray()[0];
      if (identity === undefined) {
        return { status: 404, body: { error: "Tag has no durable state yet", code: "tag_not_found" } };
      }
      if (sqlString(identity.tag, "tag_identity.tag") !== tag) {
        return { status: 409, body: { error: "Tag Durable Object identity changed", code: "tag_identity_conflict" } };
      }
      const findings = sql.exec<SqlRow>(`
        SELECT obligation_sequence, attempt_id, event_id, status, next_attempt_at, attempt_count
        FROM tag_outbox_obligation
        WHERE status <> 'acknowledged'
        ORDER BY obligation_sequence ASC
      `).toArray().map((row) => ({
        code: "tag_outbox_obligation_unacknowledged",
        obligationSequence: sqlNumber(row.obligation_sequence, "tag_outbox_obligation.obligation_sequence"),
        attemptId: sqlString(row.attempt_id, "tag_outbox_obligation.attempt_id"),
        eventId: sqlString(row.event_id, "tag_outbox_obligation.event_id"),
        status: sqlString(row.status, "tag_outbox_obligation.status"),
        nextAttemptAt: sqlNumber(row.next_attempt_at, "tag_outbox_obligation.next_attempt_at"),
        attemptCount: sqlNumber(row.attempt_count, "tag_outbox_obligation.attempt_count"),
        source: "tag_outbox_obligation",
      }));
      return {
        status: 200,
        body: {
          status: "scan-complete",
          source: "tag_outbox_obligation",
          scannedAt: nowMs,
          pendingCount: findings.length,
          findings,
        },
      };
    });
    return json(result.body, result.status);
  }

  /** Record a retry or terminal poison disposition without changing the source event. */
  private async recordOutboxFailure(tag: string, delivery: DownstreamOutboxMessage, failure: unknown): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const sql = this.sqlStorage();
      if (sql === undefined) {
        // Minimal direct seams have no persistent SQL store.  They intentionally
        // remain transport-only and cannot become a durable obligation source.
        return;
      }
      const identity = sql.exec<SqlRow>("SELECT tag FROM tag_identity WHERE singleton = 1").toArray()[0];
      if (identity === undefined || sqlString(identity.tag, "tag_identity.tag") !== tag) {
        throw new Error("Cannot record an outbox failure for a different tag identity");
      }
      const obligation = sql.exec<SqlRow>(`
        SELECT obligation_sequence, attempt_count, status
        FROM tag_outbox_obligation
        WHERE attempt_id = ? AND event_id = ? AND suid = ? AND payload = ?
          AND allocator_lineage_id = ? AND event_type = ? AND provenance = ? AND timestamp = ?
      `, delivery.attemptId, delivery.eventId, delivery.suid, delivery.payload,
      delivery.allocatorLineageId, delivery.eventType, delivery.provenance, delivery.timestamp).toArray()[0];
      if (obligation === undefined || sqlString(obligation.status, "tag_outbox_obligation.status") === "acknowledged") {
        await this.rearmScheduler(txn);
        return;
      }
      const attempts = sqlNumber(obligation.attempt_count, "tag_outbox_obligation.attempt_count");
      const status = attempts >= OBLIGATION_MAX_ATTEMPTS ? "poison" : "pending";
      const message = String(failure).slice(0, 256);
      sql.exec(`
        UPDATE tag_outbox_obligation
        SET status = ?, next_attempt_at = ?, last_error = ?
        WHERE obligation_sequence = ?
      `, status, Date.now() + OBLIGATION_RETRY_MS, message,
      sqlNumber(obligation.obligation_sequence, "tag_outbox_obligation.obligation_sequence"));
      await this.rearmScheduler(txn);
    });
  }

  /** Marks only a previously enqueued row; repeating a mark is harmless. */
  private async markOutboxDelivered(tag: string, body: unknown): Promise<Response> {
    const parsed = outboxMarkFrom(body);
    if (parsed.value === undefined) {
      return error(400, "invalid_outbox_delivery_mark", parsed.error ?? "Invalid outbox delivery mark");
    }
    const input = parsed.value;
    try {
      const joined = await Promise.all(input.deliveries.map((delivery) => this.globalReceiptMatches(delivery)));
      if (joined.some((value) => !value)) {
        return error(409, "outbox_global_receipt_unverified", "Global receipt and membership must be read back before source acknowledgement");
      }
    } catch {
      // Do not turn an unavailable/partial global read into an acknowledgement.
      return error(503, "outbox_global_receipt_unavailable", "Global receipt verification is unavailable");
    }
    const result = await this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
      if (this.sqlStorage() !== undefined) {
        return this.markSqlOutboxDelivered(txn, tag, input);
      }
      const record = this.readStoredRecord(tag);
      if (record === undefined) {
        return { status: 404, body: { error: "Tag has no durable state yet", code: "tag_not_found" } };
      }
      if (record.tag !== tag) {
        return { status: 409, body: { error: "Tag Durable Object identity changed", code: "tag_identity_conflict" } };
      }
      const deliveries = (await txn.get<TagOutboxDelivery[]>(OUTBOX_DELIVERIES_KEY)) ?? this.fallbackOutboxDeliveries;
      const requested = new Map(input.deliveries.map((delivery) => [outboxRowKey(delivery), delivery]));
      for (const [key, delivery] of requested) {
        if (!record.outbox.some((row) => outboxRowKey(row) === key)) {
          return { status: 409, body: { error: "Outbox row is not durable", code: "outbox_row_not_found" } };
        }
        const persisted = deliveries.find((candidate) => outboxRowKey(candidate) === key);
        if (persisted === undefined || persisted.enqueuedAt !== delivery.enqueuedAt) {
          return { status: 409, body: { error: "Outbox row was not enqueued", code: "outbox_delivery_not_enqueued" } };
        }
      }
      let marked = 0;
      const updated = deliveries.map((delivery) => {
        const requestedDelivery = requested.get(outboxRowKey(delivery));
        if (requestedDelivery === undefined || delivery.deliveredAt !== null) {
          return delivery;
        }
        marked += 1;
        return { ...delivery, deliveredAt: input.nowMs };
      });
      if (marked > 0) {
        this.fallbackOutboxDeliveries = updated;
        await txn.put(OUTBOX_DELIVERIES_KEY, updated);
      }
      return { status: 200, body: { marked, idempotent: marked === 0 } };
    });
    return json(result.body, result.status);
  }

  /**
   * The delivery handoff reads its universe from `tag_outbox_obligation`.
   * It does not consult the Queue, a sink receipt, or a runner's expected
   * count.  Reserving the retry timestamp before the external handoff lets the
   * single durable scheduler retry a crash/throw without treating delivery as
   * the authority for obligation existence.
   */
  private async pendingSqlOutbox(
    txn: DurableObjectTransaction,
    tag: string,
    serviceId: string,
    nowMs: number,
    limit?: number,
    force = false,
  ): Promise<OperationResult> {
    const sql = this.sqlStorage();
    if (sql === undefined) throw new Error("Tag SQL storage is unavailable");
    const identity = sql.exec<SqlRow>("SELECT tag FROM tag_identity WHERE singleton = 1").toArray()[0];
    if (identity === undefined) return { status: 404, body: { error: "Tag has no durable state yet", code: "tag_not_found" } };
    if (sqlString(identity.tag, "tag_identity.tag") !== tag) {
      return { status: 409, body: { error: "Tag Durable Object identity changed", code: "tag_identity_conflict" } };
    }
    const pending = sql.exec<SqlRow>(`
      SELECT
        o.obligation_sequence, o.service_id, o.event_id, o.attempt_id, o.suid,
        o.payload, o.allocator_lineage_id, o.event_type, o.provenance,
        o.timestamp, o.enqueued_at, o.canonical_bytes, o.event_digest,
        o.declared_tag_set_json, o.local_committed_membership_json,
        e.event_tags_json
      FROM tag_outbox_obligation AS o
      JOIN tag_event AS e ON e.service_id = o.service_id AND e.event_id = o.event_id
      WHERE o.status = 'pending' AND (? = 1 OR o.next_attempt_at <= ?)
      ORDER BY o.obligation_sequence ASC
      LIMIT ?
    `, force ? 1 : 0, nowMs, limit ?? Number.MAX_SAFE_INTEGER).toArray();
    const rows: DownstreamOutboxMessage[] = [];
    for (const obligation of pending) {
      const storedServiceId = sqlString(obligation.service_id, "tag_outbox_obligation.service_id");
      if (storedServiceId !== serviceId) {
        return { status: 409, body: { error: "Outbox service identity changed", code: "outbox_service_identity_conflict" } };
      }
      const sequence = sqlNumber(obligation.obligation_sequence, "tag_outbox_obligation.obligation_sequence");
      const enqueuedAt = sqlNullableNumber(obligation.enqueued_at, "tag_outbox_obligation.enqueued_at") ?? nowMs;
      sql.exec(`
        UPDATE tag_outbox_obligation
        SET enqueued_at = ?, attempt_count = attempt_count + 1, next_attempt_at = ?
        WHERE obligation_sequence = ? AND status = 'pending'
      `, enqueuedAt, nowMs + OBLIGATION_RETRY_MS, sequence);
      const eventId = sqlString(obligation.event_id, "tag_outbox_obligation.event_id");
      const metadata = serializedEventMetadata(eventId);
      rows.push({
        version: 1,
        serviceId,
        tag,
        attemptId: sqlString(obligation.attempt_id, "tag_outbox_obligation.attempt_id"),
        eventId,
        suid: sqlString(obligation.suid, "tag_outbox_obligation.suid"),
        payload: sqlString(obligation.payload, "tag_outbox_obligation.payload"),
        allocatorLineageId: sqlString(obligation.allocator_lineage_id, "tag_outbox_obligation.allocator_lineage_id"),
        eventTags: sqlJson<string[]>(obligation.event_tags_json, "tag_event.event_tags_json"),
        eventType: sqlString(obligation.event_type, "tag_outbox_obligation.event_type"),
        provenance: sqlString(obligation.provenance, "tag_outbox_obligation.provenance") as "g32",
        timestamp: sqlString(obligation.timestamp, "tag_outbox_obligation.timestamp"),
        causationId: metadata.causationId,
        correlationId: metadata.correlationId,
        executedUser: metadata.executedUser,
        enqueuedAt,
        completeness: {
          canonicalBytesBase64: arrayBufferBase64(sqlArrayBuffer(obligation.canonical_bytes, "tag_outbox_obligation.canonical_bytes")),
          eventDigest: sqlString(obligation.event_digest, "tag_outbox_obligation.event_digest"),
          declaredTagSet: sqlJson<string[]>(obligation.declared_tag_set_json, "tag_outbox_obligation.declared_tag_set_json"),
          localCommittedMembership: sqlJson<Array<{ serviceId: string; eventId: string; tag: string }>>(
            obligation.local_committed_membership_json,
            "tag_outbox_obligation.local_committed_membership_json",
          ),
          obligationSequence: sequence,
        },
      });
    }
    await this.rearmScheduler(txn);
    return { status: 200, body: { rows } };
  }

  private async markSqlOutboxDelivered(
    txn: DurableObjectTransaction,
    tag: string,
    input: OutboxMarkInput,
  ): Promise<OperationResult> {
    const sql = this.sqlStorage();
    if (sql === undefined) throw new Error("Tag SQL storage is unavailable");
    const identity = sql.exec<SqlRow>("SELECT tag FROM tag_identity WHERE singleton = 1").toArray()[0];
    if (identity === undefined) return { status: 404, body: { error: "Tag has no durable state yet", code: "tag_not_found" } };
    if (sqlString(identity.tag, "tag_identity.tag") !== tag) {
      return { status: 409, body: { error: "Tag Durable Object identity changed", code: "tag_identity_conflict" } };
    }
    let marked = 0;
    for (const delivery of input.deliveries) {
      const obligation = sql.exec<SqlRow>(`
        SELECT obligation_sequence, enqueued_at, status, canonical_bytes, event_digest,
               declared_tag_set_json, local_committed_membership_json
        FROM tag_outbox_obligation
        WHERE attempt_id = ? AND event_id = ? AND suid = ? AND payload = ?
          AND allocator_lineage_id = ? AND event_type = ? AND provenance = ? AND timestamp = ?
      `, delivery.attemptId, delivery.eventId, delivery.suid, delivery.payload,
      delivery.allocatorLineageId, delivery.eventType, delivery.provenance, delivery.timestamp).toArray()[0];
      if (obligation === undefined) {
        return { status: 409, body: { error: "Outbox row is not durable", code: "outbox_row_not_found" } };
      }
      if (sqlNullableNumber(obligation.enqueued_at, "tag_outbox_obligation.enqueued_at") !== delivery.enqueuedAt) {
        return { status: 409, body: { error: "Outbox row was not enqueued", code: "outbox_delivery_not_enqueued" } };
      }
      const localMembership = sqlJson<Array<{ serviceId: string; eventId: string; tag: string }>>(
        obligation.local_committed_membership_json,
        "tag_outbox_obligation.local_committed_membership_json",
      );
      const sourceFactsMatch =
        sqlString(obligation.event_digest, "tag_outbox_obligation.event_digest") === delivery.completeness.eventDigest &&
        arrayBufferBase64(sqlArrayBuffer(obligation.canonical_bytes, "tag_outbox_obligation.canonical_bytes")) === delivery.completeness.canonicalBytesBase64 &&
        JSON.stringify(sqlJson<string[]>(obligation.declared_tag_set_json, "tag_outbox_obligation.declared_tag_set_json")) === JSON.stringify(delivery.completeness.declaredTagSet) &&
        JSON.stringify(localMembership) === JSON.stringify(delivery.completeness.localCommittedMembership) &&
        sqlNumber(obligation.obligation_sequence, "tag_outbox_obligation.obligation_sequence") === delivery.completeness.obligationSequence;
      if (!sourceFactsMatch) {
        return { status: 409, body: { error: "Outbox source facts do not match the durable obligation", code: "outbox_receipt_join_mismatch" } };
      }
      if (sqlString(obligation.status, "tag_outbox_obligation.status") === "acknowledged") continue;
      sql.exec(`
        UPDATE tag_outbox_obligation
        SET status = 'acknowledged', acknowledged_at = ?, last_error = NULL
        WHERE obligation_sequence = ?
      `, input.nowMs, sqlNumber(obligation.obligation_sequence, "tag_outbox_obligation.obligation_sequence"));
      marked += 1;
    }
    await this.rearmScheduler(txn);
    return { status: 200, body: { marked, idempotent: marked === 0 } };
  }

  private async rearmScheduler(txn: DurableObjectTransaction): Promise<void> {
    if (this.g43SchedulerFault === "before-rearm") throw new Error("G43 scheduler crash before re-arm");
    const dueAt = this.nextSqlAlarmDue();
    if (dueAt === null) await txn.deleteAlarm();
    else await txn.setAlarm(dueAt);
    if (this.g43SchedulerFault === "after-rearm") throw new Error("G43 scheduler crash after re-arm");
  }

  private async acquireRepairLease(tag: string, body: unknown): Promise<Response> {
    const parsed = repairAcquireFrom(body, tag);
    if (parsed.value === undefined) {
      return error(400, "invalid_repair_acquire", parsed.error ?? "Invalid repair acquire request");
    }
    const input = parsed.value;
    const result = await this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
      const loaded = await this.recordFor(txn, tag);
      const record = loaded.record;
      if (hasSegmentRotationFence(record)) {
        return repairRejected("segment_rotation_fence_held");
      }
      if (input.scope.some((item) =>
        fenceFor(record.fences, PARTIAL_WRITE_FENCE_REASON, item.attemptId) === undefined,
      )) {
        return repairRejected("partial_write_fence_required");
      }
      const leaseIsLive =
        record.repairOwner !== null &&
        record.repairLeaseUntil !== null &&
        logicalNow(record) < record.repairLeaseUntil;
      if (leaseIsLive) {
        return repairRejected("repair_lease_live");
      }
      if (record.highestRepairEpoch >= MAX_EPOCH) {
        return repairRejected("repair_epoch_exhausted", 422);
      }
      let scope: RepairScopeItem[];
      try {
        scope = unionRepairScope(record.repairScope, input.scope);
      } catch {
        return repairRejected("repair_scope_identity_conflict");
      }
      const epoch = record.highestRepairEpoch + 1;
      const updated = await this.commit(txn, record, {
        repairOwner: input.owner,
        repairLeaseUntil: logicalNow(record) + input.leaseMs,
        highestRepairEpoch: epoch,
        repairScope: scope,
        repairScopeVersion: record.repairScopeVersion + 1,
      });
      return {
        status: 201,
        body: {
          status: "repair-lease-acquired",
          owner: updated.repairOwner,
          epoch: updated.highestRepairEpoch,
          leaseUntil: updated.repairLeaseUntil,
          scopeVersion: updated.repairScopeVersion,
        },
      };
    });
    return json(result.body, result.status);
  }

  private async renewRepairLease(tag: string, body: unknown): Promise<Response> {
    const parsed = repairLeaseFrom(body);
    if (parsed.value === undefined) {
      return error(400, "invalid_repair_renew", parsed.error ?? "Invalid repair renew request");
    }
    const input = parsed.value;
    const result = await this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
      const loaded = await this.recordFor(txn, tag);
      const record = loaded.record;
      const leaseError = repairLeaseRejection(record, input.owner, input.epoch);
      if (leaseError !== undefined) {
        return repairRejected(leaseError);
      }
      const updated = await this.commit(txn, record, {
        repairLeaseUntil: logicalNow(record) + DEFAULT_REPAIR_LEASE_MS,
      });
      return {
        status: 200,
        body: {
          status: "repair-lease-renewed",
          owner: updated.repairOwner,
          epoch: updated.highestRepairEpoch,
          leaseUntil: updated.repairLeaseUntil,
          scopeVersion: updated.repairScopeVersion,
        },
      };
    });
    return json(result.body, result.status);
  }

  private async unionRepairScope(tag: string, body: unknown): Promise<Response> {
    const parsed = repairScopeUnionFrom(body, tag);
    if (parsed.value === undefined) {
      return error(400, "invalid_repair_scope_union", parsed.error ?? "Invalid repair scope union request");
    }
    const input = parsed.value;
    const result = await this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
      const loaded = await this.recordFor(txn, tag);
      const record = loaded.record;
      const leaseError = repairLeaseRejection(record, input.owner, input.epoch);
      if (leaseError !== undefined) {
        return repairRejected(leaseError);
      }
      if (input.scope.some((item) =>
        fenceFor(record.fences, PARTIAL_WRITE_FENCE_REASON, item.attemptId) === undefined,
      )) {
        return repairRejected("partial_write_fence_required");
      }
      let scope: RepairScopeItem[];
      try {
        scope = unionRepairScope(record.repairScope, input.scope);
      } catch {
        return repairRejected("repair_scope_identity_conflict");
      }
      if (scope.length === record.repairScope.length) {
        return {
          status: 200,
          body: { status: "repair-scope-unchanged", scopeVersion: record.repairScopeVersion },
        };
      }
      const updated = await this.commit(txn, record, {
        repairScope: scope,
        repairScopeVersion: record.repairScopeVersion + 1,
      });
      return {
        status: 200,
        body: { status: "repair-scope-unioned", scopeVersion: updated.repairScopeVersion, scope: updated.repairScope },
      };
    });
    return json(result.body, result.status);
  }

  private async applyRepair(tag: string, body: unknown): Promise<Response> {
    const parsed = repairApplyFrom(body, tag);
    if (parsed.value === undefined) {
      return error(400, "invalid_repair_apply", parsed.error ?? "Invalid repair apply request");
    }
    const input = parsed.value;
    const result = await this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
      const loaded = await this.recordFor(txn, tag);
      const record = loaded.record;
      const leaseError = repairLeaseRejection(record, input.owner, input.epoch);
      if (leaseError !== undefined) {
        return repairRejected(leaseError);
      }
      if (!repairScopeContains(record.repairScope, input.item)) {
        return repairRejected("repair_scope_required");
      }
      if (fenceFor(record.fences, PARTIAL_WRITE_FENCE_REASON, input.item.attemptId) === undefined) {
        return repairRejected("partial_write_fence_required");
      }

      const facts = (await txn.get<RepairFacts>(REPAIR_FACTS_KEY)) ?? repairFactsDefault();
      const prior = repairResolutionFor(facts, input.item);
      if (prior !== undefined) {
        return {
          status: 200,
          body: { status: prior.branch, idempotent: true, head: record.head, version: record.version },
        };
      }

      const existing = record.events.find((event) => event.eventId === input.item.eventId);
      let branch: RepairBranch;
      let updatedRecord: TagRecord | undefined;
      if (existing !== undefined) {
        branch = existing.payload === input.item.payload && existing.suid === input.item.suid
          ? "ROLLED_FORWARD"
          : "FAILED_CLOSED";
      } else if (record.head < input.item.suid) {
        branch = "ROLLED_FORWARD";
        updatedRecord = changed(record, {
          head: input.item.suid,
          events: [...record.events, {
            attemptId: input.item.attemptId,
            eventId: input.item.eventId,
            suid: input.item.suid,
            payload: input.item.payload,
            eventTags: input.item.eventTags,
            allocatorLineageId: input.item.allocatorLineageId,
            eventType: input.item.eventType,
            provenance: input.item.provenance,
            timestamp: input.item.timestamp,
          }],
          outbox: [...record.outbox, {
            attemptId: input.item.attemptId,
            eventId: input.item.eventId,
            suid: input.item.suid,
            payload: input.item.payload,
            allocatorLineageId: input.item.allocatorLineageId,
            eventType: input.item.eventType,
            provenance: input.item.provenance,
            timestamp: input.item.timestamp,
          }],
        });
      } else if (record.head > input.item.suid) {
        // The exclusion audit is stored separately so Branch B cannot advance
        // head or version merely by recording its durable decision.
        branch = "EXCLUDED_AUDITED";
      } else {
        branch = "FAILED_CLOSED";
      }

      const resolution: RepairResolution = {
        attemptId: input.item.attemptId,
        eventId: input.item.eventId,
        suid: input.item.suid,
        branch,
        epoch: input.epoch,
        owner: input.owner,
        recordedAt: nowIso(),
      };
      await txn.put(REPAIR_FACTS_KEY, {
        ...facts,
        resolutions: [...facts.resolutions, resolution],
      } satisfies RepairFacts);
      if (updatedRecord !== undefined) {
        await this.write(txn, updatedRecord);
      }
      return {
        status: 200,
        body: { status: branch, idempotent: false, head: (updatedRecord ?? record).head, version: (updatedRecord ?? record).version },
      };
    });
    return json(result.body, result.status);
  }

  private async auditRepair(tag: string, body: unknown): Promise<Response> {
    const parsed = repairAuditFrom(body, tag);
    if (parsed.value === undefined) {
      return error(400, "invalid_repair_audit", parsed.error ?? "Invalid repair audit request");
    }
    const input = parsed.value;
    const result = await this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
      const loaded = await this.recordFor(txn, tag);
      const record = loaded.record;
      const leaseError = repairLeaseRejection(record, input.owner, input.epoch);
      if (leaseError !== undefined) {
        return repairRejected(leaseError);
      }
      const facts = (await txn.get<RepairFacts>(REPAIR_FACTS_KEY)) ?? repairFactsDefault();
      const resolution = repairResolutionFor(facts, input.item);
      if (resolution === undefined || resolution.branch === "FAILED_CLOSED") {
        return repairRejected("repair_resolution_not_auditable");
      }
      if (resolution.branch === "ROLLED_FORWARD" && !record.outbox.some((row) =>
        row.attemptId === input.item.attemptId &&
        row.eventId === input.item.eventId &&
        row.suid === input.item.suid &&
        row.payload === input.item.payload,
      )) {
        return repairRejected("durable_outbox_required");
      }
      const prior = repairAuditFor(facts, input.item);
      if (prior !== undefined) {
        return { status: 200, body: { status: "repair-audited", idempotent: true, branch: prior.branch } };
      }
      const audit: RepairAudit = {
        attemptId: input.item.attemptId,
        eventId: input.item.eventId,
        suid: input.item.suid,
        branch: resolution.branch,
        actor: input.actor,
        epoch: input.epoch,
        owner: input.owner,
        recordedAt: nowIso(),
      };
      await txn.put(REPAIR_FACTS_KEY, { ...facts, audits: [...facts.audits, audit] } satisfies RepairFacts);
      return { status: 200, body: { status: "repair-audited", idempotent: false, branch: audit.branch } };
    });
    return json(result.body, result.status);
  }

  private async clearRepairFence(tag: string, body: unknown): Promise<Response> {
    const parsed = repairClearFrom(body);
    if (parsed.value === undefined) {
      return error(400, "invalid_repair_clear", parsed.error ?? "Invalid repair clear request");
    }
    const input = parsed.value;
    const result = await this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
      const loaded = await this.recordFor(txn, tag);
      const record = loaded.record;
      const leaseError = repairLeaseRejection(record, input.owner, input.epoch);
      if (leaseError !== undefined) {
        return repairRejected(leaseError);
      }
      if (record.repairScopeVersion !== input.scopeVersion) {
        return repairRejected("repair_scope_snapshot_changed");
      }
      const exactFence = fenceFor(record.fences, PARTIAL_WRITE_FENCE_REASON, input.attemptId);
      if (exactFence === undefined) {
        return { status: 200, body: { status: "repair-fence-cleared", idempotent: true, version: record.version } };
      }
      const facts = (await txn.get<RepairFacts>(REPAIR_FACTS_KEY)) ?? repairFactsDefault();
      const attemptScope = record.repairScope.filter((item) => item.attemptId === input.attemptId);
      if (attemptScope.length === 0 || attemptScope.some((item) => {
        const resolution = repairResolutionFor(facts, item);
        return resolution === undefined || resolution.branch === "FAILED_CLOSED" || repairAuditFor(facts, item) === undefined;
      })) {
        return repairRejected("repair_scope_not_durably_resolved");
      }
      const updated = await this.commit(txn, record, {
        fences: withoutFence(record.fences, PARTIAL_WRITE_FENCE_REASON, input.attemptId),
        clearedFences: withFence(record.clearedFences, exactFence),
      });
      return { status: 200, body: { status: "repair-fence-cleared", idempotent: false, version: updated.version } };
    });
    return json(result.body, result.status);
  }

  private async setClockOffset(tag: string, body: unknown): Promise<Response> {
    if (!isObject(body)) {
      return error(400, "invalid_tag_clock", "offsetMs or nowMs must be a safe integer");
    }
    const nowMs = body.nowMs;
    const offsetMs = body.offsetMs;
    if (!isSafeInteger(nowMs) && !isSafeInteger(offsetMs)) {
      return error(400, "invalid_tag_clock", "offsetMs or nowMs must be a safe integer");
    }
    const result = await this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
      const loaded = await this.recordFor(txn, tag);
      const updated = await this.commit(txn, loaded.record, {
        clockOffsetMs: isSafeInteger(offsetMs) ? offsetMs : loaded.record.clockOffsetMs,
        clockNowMs: isSafeInteger(nowMs) ? nowMs : loaded.record.clockNowMs,
      });
      return {
        status: 200,
        body: {
          status: "clock-set",
          offsetMs: updated.clockOffsetMs,
          nowMs: updated.clockNowMs,
          version: updated.version,
        },
      };
    });
    return json(result.body, result.status);
  }

  private async runAlarm(): Promise<TagRecord | undefined> {
    const due = await this.ctx.storage.transaction(async (txn): Promise<{
      record: TagRecord | undefined;
      tag?: string;
      serviceId?: string;
      retryDue: boolean;
      sourceRegistrationDue?: { readonly tag: string; readonly serviceId: string };
    }> => {
      const sql = this.sqlStorage();
      if (sql === undefined) {
        const storedTag = this.fallbackRecord?.tag;
        if (storedTag === undefined) return { record: undefined, retryDue: false };
        const record = this.readStoredRecord(storedTag);
        if (record === undefined) return { record: undefined, retryDue: false };
        const expiry = expireReservation(record);
        return {
          record: expiry.expired ? await this.commit(txn, expiry.record, {}) : record,
          retryDue: false,
        };
      }

      const identity = sql.exec<SqlRow>("SELECT tag FROM tag_identity WHERE singleton = 1").toArray()[0];
      if (identity === undefined) return { record: undefined, retryDue: false };
      const tag = sqlString(identity.tag, "tag_identity.tag");
      const control = sql.exec<SqlRow>("SELECT * FROM tag_control WHERE singleton = 1").one();
      const now = sqlNullableNumber(control.clock_now_ms, "tag_control.clock_now_ms") ??
        Date.now() + sqlNumber(control.clock_offset_ms, "tag_control.clock_offset_ms");
      const reservation = sql.exec<SqlRow>("SELECT expires_at FROM tag_reservation WHERE singleton = 1").toArray()[0];
      if (reservation !== undefined && sqlNumber(reservation.expires_at, "tag_reservation.expires_at") <= now) {
        sql.exec("DELETE FROM tag_reservation WHERE singleton = 1");
        sql.exec(
          "UPDATE tag_control SET version = ?, updated_at = ? WHERE singleton = 1",
          sqlNumber(control.version, "tag_control.version") + 1,
          nowIso(),
        );
      }
      const service = sql.exec<SqlRow>("SELECT service_id FROM tag_head WHERE singleton = 1").toArray()[0];
      const retryDue = sqlNumber(sql.exec<SqlRow>(`
        SELECT COUNT(*) AS count FROM tag_outbox_obligation
        WHERE status = 'pending' AND next_attempt_at <= ?
      `, Date.now()).one().count, "tag_outbox_obligation.count") > 0;
      const sourceRegistration = sql.exec<SqlRow>(`
        SELECT service_id, partition_tag
          FROM tag_source_partition_registration
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC, service_id COLLATE BINARY ASC, partition_tag COLLATE BINARY ASC
         LIMIT 1
      `, Date.now()).toArray()[0];
      await this.rearmScheduler(txn);
      return {
        record: this.readStoredRecord(tag),
        tag,
        serviceId: service === undefined ? undefined : sqlString(service.service_id, "tag_head.service_id"),
        retryDue,
        sourceRegistrationDue: sourceRegistration === undefined ? undefined : {
          serviceId: sqlString(sourceRegistration.service_id, "tag_source_partition_registration.service_id"),
          tag: sqlString(sourceRegistration.partition_tag, "tag_source_partition_registration.partition_tag"),
        },
      };
    });
    if (due.sourceRegistrationDue !== undefined) {
      await this.retrySourcePartitionRegistration(
        due.sourceRegistrationDue.tag,
        due.sourceRegistrationDue.serviceId,
      ).catch(() => undefined);
    }
    if (
      due.retryDue &&
      this.env.AUTO_DRAIN_OUTBOX === "true" &&
      due.tag !== undefined &&
      isNonEmptyString(due.serviceId)
    ) {
      // Delivery is outside the storage transaction. Each selected obligation
      // already has a retry timestamp, and per-row failures cannot starve
      // sibling rows or reservation expiry.
      await this.autoDrainOutbox(due.tag, due.serviceId, undefined, OBLIGATION_ALARM_BATCH_LIMIT).catch(() => undefined);
    }
    return due.record;
  }
}

export { MAX_EPOCH };
