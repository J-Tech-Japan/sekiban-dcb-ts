import {
  PARTIAL_WRITE_FENCE_REASON,
  RESERVATION_WINDOW_MS,
  SEGMENT_ROTATION_FENCE_REASON,
  type TagConsistencyEntry,
  type TagEpoch,
  type TagEvent,
  type TagFence,
  type TagOutboxRow,
  type TagRecord,
  type TagReservation,
} from "./types";

const TAG_KEY = "tag";
const MAX_EPOCH = Number.MAX_SAFE_INTEGER;

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
}

interface AppendInput extends ReservationInput {
  candidates: AppendCandidate[];
  faultInjection?: "after-append-before-confirm";
}

interface FenceInput extends EpochInput {
  reason: string;
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

function fenceFrom(value: unknown): { value?: FenceInput; error?: string } {
  const epoch = epochFrom(value);
  if (epoch.value === undefined || !isObject(value) || !isNonEmptyString(value.reason)) {
    return { error: epoch.error ?? "reason is required" };
  }
  return { value: { ...epoch.value, reason: value.reason } };
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
    clockOffsetMs: 0,
    clockNowMs: null,
    version: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
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
  constructor(private readonly ctx: DurableObjectState) {}

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
        ? json(record)
        : error(409, "tag_identity_conflict", "Tag Durable Object identity changed");
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
      return this.append(tag, body);
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
    return { record: existing ?? newRecord(tag), exists: existing !== undefined };
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

  private async append(tag: string, body: unknown): Promise<Response> {
    const parsed = appendFrom(body, tag);
    if (parsed.value === undefined) {
      return error(400, "invalid_tag_append", parsed.error ?? "Invalid append request");
    }
    const input = parsed.value;
    try {
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
        }));
        const outboxRows: TagOutboxRow[] = input.candidates.map((candidate) => ({
          attemptId: input.attemptId,
          eventId: candidate.eventId,
          suid: candidate.suid,
          payload: candidate.payload,
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
      return json(result.body, result.status);
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
