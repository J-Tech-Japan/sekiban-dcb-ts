import {
  PARTIAL_WRITE_FENCE_REASON,
  RESERVATION_WINDOW_MS,
  SEGMENT_ROTATION_FENCE_REASON,
  type TagConsistencyEntry,
  type TagEpoch,
  type TagEvent,
  type TagFence,
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
import { LEGACY_ALLOCATOR_LINEAGE_ID, type DownstreamOutboxMessage } from "../downstream/types";
import {
  downstreamEnvelopeBytes,
  classifyDirectDoorbellFailure,
  preflightDirectDoorbell,
  readDirectDoorbellConfig,
  type DownstreamDoorbellBinding,
} from "../downstream/Doorbell";

const TAG_KEY = "tag";
const REPAIR_FACTS_KEY = "repair-facts";
const OUTBOX_DELIVERIES_KEY = "outbox-deliveries";
const MAX_EPOCH = Number.MAX_SAFE_INTEGER;
const DEFAULT_REPAIR_LEASE_MS = 30_000;
const MAX_REPAIR_LEASE_MS = 5 * 60_000;

type JsonObject = Record<string, unknown>;

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
}

interface AppendCandidate {
  eventId: string;
  suid: string;
  payload: string;
  eventTags: string[];
  allocatorLineageId: string;
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
}

interface OutboxMarkInput {
  deliveries: Array<Pick<TagOutboxDelivery, "attemptId" | "eventId" | "suid" | "payload" | "enqueuedAt">>;
  nowMs: number;
}

interface TagDurableObjectEnv {
  DOWNSTREAM_QUEUE?: Queue<DownstreamOutboxMessage>;
  DOWNSTREAM_DOORBELL?: DownstreamDoorbellBinding;
  AUTO_DRAIN_OUTBOX?: string;
  DELIVERY_CLASS?: string;
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function error(status: number, code: string, message: string): Response {
  return json({ error: message, code }, status);
}

function rejected(reason: string, status = 409): OperationResult {
  return {
    status,
    body: { code: "tag_operation_rejected", error: reason, reason },
  };
}

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
  return {
    value: {
      ...epoch.value,
      reservationToken: value.reservationToken,
      forceTombstone: value.forceTombstone,
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
    candidates.push({
      eventId: rawCandidate.eventId,
      suid: rawCandidate.suid,
      payload: rawCandidate.payload,
      eventTags: eventTags.value,
      allocatorLineageId: isNonEmptyString(rawCandidate.allocatorLineageId)
        ? rawCandidate.allocatorLineageId
        : LEGACY_ALLOCATOR_LINEAGE_ID,
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
    candidates.push({ eventId: candidate.eventId, suid: candidate.suid, payload: candidate.payload, eventTags: tags.value, allocatorLineageId: candidate.allocatorLineageId });
  }
  const ordered = [...candidates].sort((a, b) => a.suid.localeCompare(b.suid));
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
    typeof value.payload !== "string"
  ) {
    return { error: "each repair scope item needs attemptId, eventId, suid, and payload" };
  }
  const eventTags = stringArrayFrom(value.eventTags, "repair eventTags");
  if (eventTags.value === undefined || !eventTags.value.includes(tag)) {
    return { error: eventTags.error ?? "each repair scope item must include this tag" };
  }
  return {
    value: {
      attemptId: value.attemptId,
      eventId: value.eventId,
      suid: value.suid,
      payload: value.payload,
      eventTags: eventTags.value,
      allocatorLineageId: isNonEmptyString(value.allocatorLineageId)
        ? value.allocatorLineageId
        : undefined,
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
  return { value: { nowMs } };
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
    deliveries.push({
      attemptId: raw.attemptId,
      eventId: raw.eventId,
      suid: raw.suid,
      payload: raw.payload,
      enqueuedAt: raw.enqueuedAt,
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

function outboxRowKey(row: TagOutboxRow): string {
  return `${row.attemptId}\u0000${row.eventId}\u0000${row.suid}\u0000${row.payload}`;
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
    schemaVersion: 1,
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

/** Older G5 records are normalized lazily without widening their public wire. */
function normalizeRepairRecord(record: TagRecord): TagRecord {
  return {
    ...record,
    repairOwner: record.repairOwner ?? null,
    repairLeaseUntil: record.repairLeaseUntil ?? null,
    highestRepairEpoch: record.highestRepairEpoch ?? 0,
    repairScope: record.repairScope ?? [],
    repairScopeVersion: record.repairScopeVersion ?? 0,
    bootstrapAdmission: record.bootstrapAdmission ?? null,
  };
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
      event.payload === candidate.payload,
  );
}

function batchIsExactDuplicate(record: TagRecord, input: AppendInput): boolean {
  return input.candidates.every((candidate) => candidateIsExactDuplicate(record, input.attemptId, candidate));
}

function hasEventConflict(record: TagRecord, candidates: AppendCandidate[]): boolean {
  return candidates.some((candidate) => record.events.some((event) => event.eventId === candidate.eventId));
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
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: TagDurableObjectEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const tag = url.searchParams.get("__tag");
    if (!isNonEmptyString(tag)) {
      return error(400, "tag_identity_required", "Tag identity is required");
    }
    if (request.method === "GET" && url.pathname === "/state") {
      const record = await this.ctx.storage.get<TagRecord>(TAG_KEY);
      if (record === undefined) {
        return error(404, "tag_not_found", "Tag has no durable state yet");
      }
      return record.tag === tag
        ? json(normalizeRepairRecord(record))
        : error(409, "tag_identity_conflict", "Tag Durable Object identity changed");
    }
    if (request.method === "GET" && url.pathname === "/repair/facts") {
      return this.repairFacts(tag);
    }
    if (request.method === "POST" && url.pathname === "/debug/alarm") {
      const record = await this.runAlarm();
      return record === undefined ? error(404, "tag_not_found", "Tag has no durable state yet") : json(record);
    }

    const body = await this.jsonBody(request);
    if (body === undefined) {
      return error(400, "malformed_tag_request", "Request body must be JSON");
    }
    if (request.method === "POST" && url.pathname === "/acquire") {
      return this.acquire(tag, body);
    }
    if (request.method === "POST" && url.pathname === "/cancel") {
      return this.cancel(tag, body);
    }
    if (request.method === "POST" && url.pathname === "/seal") {
      return this.seal(tag, body);
    }
    if (request.method === "POST" && url.pathname === "/append") {
      return this.append(tag, body, url.searchParams.get("__serviceId"));
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
    await this.runAlarm();
  }

  private async jsonBody(request: Request): Promise<unknown | undefined> {
    try {
      return await request.json<unknown>();
    } catch {
      return undefined;
    }
  }

  private async recordFor(
    txn: DurableObjectTransaction,
    tag: string,
  ): Promise<{ record: TagRecord; exists: boolean }> {
    const existing = await txn.get<TagRecord>(TAG_KEY);
    if (existing !== undefined && existing.tag !== tag) {
      throw new Error("Tag Durable Object identity changed");
    }
    return { record: normalizeRepairRecord(existing ?? newRecord(tag)), exists: existing !== undefined };
  }

  private async write(txn: DurableObjectTransaction, record: TagRecord): Promise<void> {
    await txn.put(TAG_KEY, record);
    if (record.alarmDueAt === null) {
      await txn.deleteAlarm();
    } else {
      await txn.setAlarm(record.alarmDueAt);
    }
  }

  private async commit(
    txn: DurableObjectTransaction,
    record: TagRecord,
    updates: Partial<TagRecord>,
  ): Promise<TagRecord> {
    const updated = changed(record, updates);
    await this.write(txn, updated);
    return updated;
  }

  private async commitExpiryIfNeeded(
    txn: DurableObjectTransaction,
    expiry: ExpiryResult,
  ): Promise<TagRecord> {
    return expiry.expired ? this.commit(txn, expiry.record, {}) : expiry.record;
  }

  private async acquire(tag: string, body: unknown): Promise<Response> {
    const parsed = acquireFrom(body, tag);
    if (parsed.value === undefined) {
      return error(400, "invalid_tag_acquire", parsed.error ?? "Invalid acquire request");
    }
    const input = parsed.value;
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
          ...rejected("active_reservation_conflict"),
          body: { ...rejected("active_reservation_conflict").body as JsonObject, version: record.version },
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
      const updated = await this.commit(txn, record, {
        activeReservation: reservation,
        alarmDueAt: reservation.alarmDueAt,
      });
      return {
        status: 201,
        body: { status: "reserved", reservation, fenceGate, version: updated.version },
      };
    });
    return json(result.body, result.status);
  }

  private async cancel(tag: string, body: unknown): Promise<Response> {
    const parsed = reservationFrom(body);
    if (parsed.value === undefined) {
      return error(400, "invalid_tag_cancel", parsed.error ?? "Invalid cancel request");
    }
    const input = parsed.value;
    const result = await this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
      const loaded = await this.recordFor(txn, tag);
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
        return { status: 200, body: { status: "cancelled", idempotent: false, version: updated.version } };
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

  private async seal(tag: string, body: unknown): Promise<Response> {
    const parsed = epochFrom(body);
    if (parsed.value === undefined) {
      return error(400, "invalid_tag_seal", parsed.error ?? "Invalid seal request");
    }
    const input = parsed.value;
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
      const exact = input.candidates.every((candidate) => record.events.some((event) => event.eventId === candidate.eventId && event.suid === candidate.suid && event.payload === candidate.payload && event.eventTags.join("\u0000") === candidate.eventTags.join("\u0000")));
      if (exact) return { status: 200, body: { status: "duplicate", version: record.version } };
      // A coordinator may send several bounded chunks for one tag.  The
      // admission identity is fixed above; only duplicate replay, conflicting
      // identity, or non-monotonic continuation can be rejected here.
      if (hasEventConflict(record, input.candidates) || monotonicityViolation(record.head, input.candidates)) return rejected("bootstrap_identity_or_order_conflict");
      const events: TagEvent[] = input.candidates.map((candidate) => ({ attemptId: `bootstrap:${input.importId}`, eventId: candidate.eventId, suid: candidate.suid, payload: candidate.payload, eventTags: candidate.eventTags, allocatorLineageId: candidate.allocatorLineageId }));
      const updated = await this.commit(txn, record, { bootstrapAdmission: admission, head: input.candidates.at(-1)!.suid, events: [...record.events, ...events] });
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

  private directDoorbellPreflight(): ReturnType<typeof preflightDirectDoorbell> {
    const config = readDirectDoorbellConfig(this.env as unknown as Record<string, unknown>);
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
      console.warn("direct_doorbell_status", {
        status: "queued-degraded",
        reason: "direct_doorbell_binding_missing",
      });
    }
    if (preflight.status === "queued-degraded") {
      console.warn("direct_doorbell_status", {
        status: "queued-degraded",
        reason: preflight.reason,
        estimatedInvocations: preflight.estimatedInvocations,
      });
    }
    return preflight;
  }

  private async append(tag: string, body: unknown, serviceId: string | null): Promise<Response> {
    const parsed = appendFrom(body, tag);
    if (parsed.value === undefined) {
      return error(400, "invalid_tag_append", parsed.error ?? "Invalid append request");
    }
    const input = parsed.value;
    try {
      const doorbellPreflight = this.directDoorbellPreflight();
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
        }));
        const outboxRows: TagOutboxRow[] = input.candidates.map((candidate) => ({
          attemptId: input.attemptId,
          eventId: candidate.eventId,
          suid: candidate.suid,
          payload: candidate.payload,
          allocatorLineageId: candidate.allocatorLineageId,
        }));
        const head = input.candidates[input.candidates.length - 1]!.suid;
        const appendedOnly = changed(record, {
          head,
          events: [...record.events, ...appendedEvents],
          outbox: [...record.outbox, ...outboxRows],
        });
        await txn.put(TAG_KEY, appendedOnly);
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
        await this.write(txn, updated);
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
        // The append transaction is already durable. Both transports consume
        // the full pending-outbox envelope after the response; this DO never
        // records delivery or applies a view. Keep the handoff off the
        // application response lifetime so transport backpressure cannot turn
        // a committed append into a Worker timeout.
        this.ctx.waitUntil(this.autoDrainOutbox(tag, serviceId).catch(() => undefined));
      }
      return response;
    } catch (failure) {
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

  private async autoDrainOutbox(tag: string, serviceId: string): Promise<void> {
    const config = readDirectDoorbellConfig(this.env as unknown as Record<string, unknown>);
    const preflight = preflightDirectDoorbell(config, config.allowedViews.length);
    if (preflight.status === "fail-fast") {
      throw new Error(`direct_doorbell_preflight_failed:${preflight.reason}`);
    }
    const pending = await this.pendingOutbox(tag, serviceId, { nowMs: Date.now() });
    if (!pending.ok) {
      throw new Error(`automatic outbox pending read failed with ${pending.status}`);
    }
    const body = await pending.json<{ rows?: DownstreamOutboxMessage[] }>();
    const rows = body.rows ?? [];
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
      if (directReady) {
        try {
          const delivered = await this.env.DOWNSTREAM_DOORBELL!.deliver(row);
          if (
            typeof delivered === "object" && delivered !== null &&
            "fastDisposition" in delivered &&
            (delivered as { fastDisposition?: unknown }).fastDisposition === "failed"
          ) {
            throw new Error("doorbell_receiver_delivery_failed");
          }
          console.log("direct_doorbell_delivery", {
            correlationId: `fast:${serviceId}:${row.eventId}`,
            bytes: envelopeBytes.length,
            status: "success",
          });
        } catch (error) {
          // A direct failure is explicit and the durable Queue is the
          // backstop. Replaying the same envelope is safe because the core is
          // receipt-idempotent; this is not a silent capability downgrade.
          console.warn("direct_doorbell_status", {
            status: "queued-degraded",
            reason: "direct_doorbell_delivery_failed",
            failureKind: classifyDirectDoorbellFailure(error),
            error: String(error),
          });
        }
      } else if (config.deliveryClass === "immediate-preferred" && config.enabled) {
        console.warn("direct_doorbell_status", {
          status: "queued-degraded",
          reason: "direct_doorbell_not_ready",
        });
      }
      if (queue !== undefined) {
        await queue.send(row, { contentType: "json" });
      }
    }
    if (rows.length === 0 || queue === undefined) {
      return;
    }
    const mark = await this.markOutboxDelivered(tag, {
      deliveries: rows.map(({ attemptId, eventId, suid, payload, enqueuedAt }) => ({
        attemptId,
        eventId,
        suid,
        payload,
        enqueuedAt,
      })),
      nowMs: Date.now(),
    });
    if (!mark.ok) {
      throw new Error(`automatic outbox delivery mark failed with ${mark.status}`);
    }
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
        return { status: 200, body: { status: "fence-installed", idempotent: true, version: record.version } };
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
      return { status: 201, body: { status: "fence-installed", idempotent: false, version: updated.version } };
    });
    return json(result.body, result.status);
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
      const record = await txn.get<TagRecord>(TAG_KEY);
      if (record === undefined) {
        return { status: 404, body: { error: "Tag has no durable state yet", code: "tag_not_found" } };
      }
      const normalized = normalizeRepairRecord(record);
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
      const record = await txn.get<TagRecord>(TAG_KEY);
      if (record === undefined) {
        return { status: 404, body: { error: "Tag has no durable state yet", code: "tag_not_found" } };
      }
      if (record.tag !== tag) {
        return { status: 409, body: { error: "Tag Durable Object identity changed", code: "tag_identity_conflict" } };
      }
      const deliveries = (await txn.get<TagOutboxDelivery[]>(OUTBOX_DELIVERIES_KEY)) ?? [];
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
        enqueuedAt: number;
      }> = [];
      for (const row of record.outbox) {
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
          candidate.payload === row.payload,
        );
        if (event === undefined) {
          return {
            status: 409,
            body: { error: "Outbox row has no matching durable event", code: "outbox_event_missing" },
          };
        }
        rows.push({
          version: 1,
          serviceId,
          tag,
          attemptId: row.attemptId,
          eventId: row.eventId,
          suid: row.suid,
          payload: row.payload,
          allocatorLineageId: row.allocatorLineageId ?? event.allocatorLineageId ?? LEGACY_ALLOCATOR_LINEAGE_ID,
          eventTags: event.eventTags,
          enqueuedAt: delivery.enqueuedAt,
        });
      }
      if (changedDeliveries !== deliveries) {
        await txn.put(OUTBOX_DELIVERIES_KEY, changedDeliveries);
      }
      return { status: 200, body: { rows } };
    });
    return json(result.body, result.status);
  }

  /** Marks only a previously enqueued row; repeating a mark is harmless. */
  private async markOutboxDelivered(tag: string, body: unknown): Promise<Response> {
    const parsed = outboxMarkFrom(body);
    if (parsed.value === undefined) {
      return error(400, "invalid_outbox_delivery_mark", parsed.error ?? "Invalid outbox delivery mark");
    }
    const input = parsed.value;
    const result = await this.ctx.storage.transaction(async (txn): Promise<OperationResult> => {
      const record = await txn.get<TagRecord>(TAG_KEY);
      if (record === undefined) {
        return { status: 404, body: { error: "Tag has no durable state yet", code: "tag_not_found" } };
      }
      if (record.tag !== tag) {
        return { status: 409, body: { error: "Tag Durable Object identity changed", code: "tag_identity_conflict" } };
      }
      const deliveries = (await txn.get<TagOutboxDelivery[]>(OUTBOX_DELIVERIES_KEY)) ?? [];
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
        await txn.put(OUTBOX_DELIVERIES_KEY, updated);
      }
      return { status: 200, body: { marked, idempotent: marked === 0 } };
    });
    return json(result.body, result.status);
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
          }],
          outbox: [...record.outbox, {
            attemptId: input.item.attemptId,
            eventId: input.item.eventId,
            suid: input.item.suid,
            payload: input.item.payload,
            allocatorLineageId: input.item.allocatorLineageId,
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
    return this.ctx.storage.transaction(async (txn): Promise<TagRecord | undefined> => {
      const record = await txn.get<TagRecord>(TAG_KEY);
      if (record === undefined) {
        return undefined;
      }
      const expiry = expireReservation(record);
      return expiry.expired ? this.commit(txn, expiry.record, {}) : record;
    });
  }
}

export { MAX_EPOCH };
