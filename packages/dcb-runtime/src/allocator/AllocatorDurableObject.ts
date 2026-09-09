import type {
  AllocatedCandidate,
  AllocationCandidate,
  AllocationVector,
  AllocatorState,
  ClosedPrefixCertificate,
  ClosedPrefixIndex,
  IssuanceObligation,
  IssuanceObligationDisposition,
  IssuanceRecoveryRecord,
} from "./types";
import {
  allocateOrderRange,
  diagnosticAllocatedAt,
  systemOrderClock,
  type OrderClock,
  OrderClockReadError,
} from "./OrderClock";
import { assertSortableUniqueId, SortableUniqueIdError } from "./SortableUniqueId";
import {
  correlationIdForAttempt,
  DurableObjectActivation,
  enterNativeActorHandleSpan,
  enterNativeCommitSpan,
  type DurableObjectActivationObservation,
  noOpNativeTracing,
  type NativeTracing,
} from "../trace/CommitTrace";
import { scopeIdFor } from "../scope/ScopeName";
import { beginDurableObjectHandlerObservation, type DurableObjectHandlerObservation } from "../trace/ObservationStream";

const STATE_KEY = "allocator-state";
const ATTEMPT_KEY_PREFIX = "attempt:";
const ISSUANCE_OBLIGATIONS_KEY = "issuance-obligations";
const OBLIGATION_INDEX_KEY = "issuance-obligation-index";
const OBLIGATION_RECORD_PREFIX = "issuance-obligation:";
const OBLIGATION_ORDER_PREFIX = "issuance-obligation-order:";
const WRITER_AUTHORITY_PREFIX = "issuance-writer-authority:";
const RECOVERY_RECORD_PREFIX = "issuance-recovery:";
const RECOVERY_SCHEDULE_PREFIX = "issuance-recovery-schedule:";
const CLOSED_PREFIX_META_KEY = "closed-prefix-meta";
const LAST_ALLOCATION_COST_KEY = "allocator-last-persistence-cost-ms";
const RECOVERY_RETRY_MS = 1_000;
const RECOVERY_BATCH_LIMIT = 32;
const RECOVERY_VANISHED_WRITER_GRACE_MS = 3_000;
const CLOSED_PREFIX_ADVANCE_BATCH_LIMIT = 64;
const RECONCILIATION_BATCH_LIMIT = 256;
const ROLLBACK_WARNING_WINDOW_MS = 1_000n;

type JsonObject = Record<string, unknown>;

interface AllocateInput {
  attemptId: string;
  candidates: AllocationCandidate[];
  faultInjection?: "between-vector-and-watermark";
  serviceId?: string;
  bootstrapCommandId?: string;
  bootstrapEpoch?: number;
}
interface SeedInput { importId: string; leaseEpoch: number; highWatermark: string; }

interface ClosedPrefixMeta {
  readonly version: 1;
  readonly allocatorLineageId: string;
  readonly migrationStatus: "new" | "reconciled";
  readonly migrationProofId: string | null;
}

interface ResolveObligationInput {
  readonly attemptId: string;
  readonly candidateIndex: number;
  readonly eventId: string;
  readonly suid: string;
  readonly allocatorLineageId: string;
  readonly tag: string;
  readonly disposition: IssuanceObligationDisposition;
  /** Required when a Tag reports a durable force-tombstone fence. */
  readonly fenceConfirmed?: true;
  /** Required when the allocator, rather than a Tag, revokes a vanished writer. */
  readonly revocationConfirmed?: true;
}

interface ReconcileCutInput {
  readonly allocatorLineageId: string;
  readonly proofId: string;
  readonly obligations: Array<Pick<IssuanceObligation, "attemptId" | "candidateIndex" | "eventId" | "suid" | "targetTags">>;
  readonly historyComplete: boolean;
  readonly completeThroughSuid: string;
  readonly serviceId?: string;
  /** Operator/import lineage proof for old vectors that lacked targetTags. */
  readonly legacyMembershipProofId?: string;
}

interface AllocationSuccess {
  vector: AllocationVector;
  created: boolean;
  rollbackWarning?: { tick: string; watermark: string | null; serviceId: string; allocatorLineageId: string };
}

class AllocationTransactionFault extends Error {}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function error(status: number, code: string, message: string): Response {
  return json({ error: message, code }, status);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function attemptKey(attemptId: string): string {
  return `${ATTEMPT_KEY_PREFIX}${attemptId}`;
}

function obligationIdentity(attemptId: string, candidateIndex: number): string {
  return `${attemptId}:${candidateIndex}`;
}

function obligationKey(attemptId: string, candidateIndex: number): string {
  return `${OBLIGATION_RECORD_PREFIX}${encodeURIComponent(obligationIdentity(attemptId, candidateIndex))}`;
}

function writerAuthorityKey(eventId: string, allocatorLineageId: string): string {
  return `${WRITER_AUTHORITY_PREFIX}${encodeURIComponent(`${allocatorLineageId}:${eventId}`)}`;
}

function obligationOrderKey(sequence: number): string {
  return `${OBLIGATION_ORDER_PREFIX}${sequence.toString().padStart(12, "0")}`;
}

function recoveryKey(attemptId: string, candidateIndex: number): string {
  return `${RECOVERY_RECORD_PREFIX}${encodeURIComponent(obligationIdentity(attemptId, candidateIndex))}`;
}

function recoveryScheduleKey(nextAttemptAt: number, attemptId: string, candidateIndex: number): string {
  return `${RECOVERY_SCHEDULE_PREFIX}${nextAttemptAt.toString().padStart(16, "0")}:${encodeURIComponent(obligationIdentity(attemptId, candidateIndex))}`;
}

function emptyObligationIndex(lineage: string): ClosedPrefixIndex {
  return { version: 1, allocatorLineageId: lineage, nextSequence: 0, closedSequence: 0, closedPrefixSuid: null, unresolvedCount: 0, hasParticipantMembership: false };
}

function currentState(allocatorLineageId: string): AllocatorState {
  return { schemaVersion: 5, allocatorLineageId, allocatedWatermark: null, bootstrapSeed: null, serviceId: null, lastRollbackWarningFingerprint: null };
}

function currentClosedPrefixMeta(allocatorLineageId: string): ClosedPrefixMeta {
  return { version: 1, allocatorLineageId, migrationStatus: "new", migrationProofId: null };
}

async function scheduleEarlierAlarm(
  txn: DurableObjectStorage | DurableObjectTransaction,
  at: number,
): Promise<void> {
  const current = await txn.getAlarm();
  if (current === null || at < current) await txn.setAlarm(at);
}

/** G32 is a fresh allocator namespace; an old durable state is never upgraded. */
function assertG32State(state: AllocatorState | undefined): void {
  if (state === undefined) return;
  if (state.schemaVersion !== 5 || !isNonEmptyString(state.allocatorLineageId)) {
    throw new SortableUniqueIdError("SUID_INVALID", "G32 allocator requires a fresh 30-digit state namespace");
  }
  if (state.allocatedWatermark !== null) assertSortableUniqueId(state.allocatedWatermark);
  if (state.bootstrapSeed !== null) assertSortableUniqueId(state.bootstrapSeed.highWatermark);
}

function targetTagsFrom(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) return undefined;
  return [...new Set(value)];
}

function seedFrom(value: unknown): { value?: SeedInput; error?: string } {
  if (!isObject(value) || !isNonEmptyString(value.importId) || !isNonNegativeInteger(value.leaseEpoch) || !isNonEmptyString(value.highWatermark)) return { error: "importId, leaseEpoch, and highWatermark are required" };
  try { decodeSuid(value.highWatermark); } catch { return { error: "highWatermark must be an allocator SUID" }; }
  return { value: { importId: value.importId, leaseEpoch: value.leaseEpoch, highWatermark: value.highWatermark } };
}

function newAllocatorLineageId(): string {
  // A fresh token is generated when the allocator has no durable state, so a
  // namespace recreation cannot silently reuse the previous lineage.
  return crypto.randomUUID();
}

export function decodeSuid(suid: string): bigint {
  return assertSortableUniqueId(suid).ticks;
}

export function nextSuids(watermark: string | null, count: number, clockTick: bigint): string[] {
  return [...allocateOrderRange(watermark, count, clockTick).suids];
}

function allocateFrom(value: unknown): { value?: AllocateInput; error?: string } {
  if (!isObject(value) || !isNonEmptyString(value.attemptId) || !Array.isArray(value.candidates)) {
    return { error: "attemptId and candidates are required" };
  }
  if (value.candidates.length === 0) {
    return { error: "an allocation requires at least one candidate" };
  }

  const candidates: AllocationCandidate[] = [];
  for (const rawCandidate of value.candidates) {
    if (
      !isObject(rawCandidate) ||
      !isNonNegativeInteger(rawCandidate.candidateIndex) ||
      !isNonEmptyString(rawCandidate.eventId)
    ) {
      return { error: "each candidate needs a non-negative candidateIndex and non-empty eventId" };
    }
    const targetTags = targetTagsFrom(rawCandidate.targetTags);
    if (targetTags === undefined) return { error: "targetTags must be an array of non-empty strings" };
    candidates.push({
      candidateIndex: rawCandidate.candidateIndex,
      eventId: rawCandidate.eventId,
      targetTags,
    });
  }

  const ordered = [...candidates].sort((left, right) => left.candidateIndex - right.candidateIndex);
  if (new Set(ordered.map((candidate) => candidate.candidateIndex)).size !== ordered.length) {
    return { error: "candidateIndex values must be unique" };
  }
  if (new Set(ordered.map((candidate) => candidate.eventId)).size !== ordered.length) {
    return { error: "eventId values must be unique within an attempt" };
  }
  if (!ordered.every((candidate, index) => candidate.candidateIndex === index)) {
    return { error: "candidateIndex values must form a complete zero-based sequence" };
  }

  const faultInjection = value.faultInjection;
  if (faultInjection !== undefined && faultInjection !== "between-vector-and-watermark") {
    return { error: "unsupported faultInjection" };
  }

  const service = isNonEmptyString(value.serviceId) ? { serviceId: value.serviceId } : {};
  const bootstrap = isNonEmptyString(value.serviceId) && isNonEmptyString(value.bootstrapCommandId) && isNonNegativeInteger(value.bootstrapEpoch)
    ? { serviceId: value.serviceId, bootstrapCommandId: value.bootstrapCommandId, bootstrapEpoch: value.bootstrapEpoch }
    : {};
  return { value: { attemptId: value.attemptId, candidates: ordered, faultInjection, ...service, ...bootstrap } };
}

function parseResolution(value: unknown): { value?: ResolveObligationInput; error?: string } {
  if (!isObject(value) || !isNonEmptyString(value.attemptId) || !isNonNegativeInteger(value.candidateIndex) ||
      !isNonEmptyString(value.eventId) || !isNonEmptyString(value.suid) || !isNonEmptyString(value.allocatorLineageId) ||
      !isNonEmptyString(value.tag) || (value.disposition !== "installed" && value.disposition !== "fenced" && value.disposition !== "revoked")) {
    return { error: "attemptId, candidateIndex, eventId, suid, allocatorLineageId, tag, and disposition are required" };
  }
  try { assertSortableUniqueId(value.suid); } catch { return { error: "suid must be a valid allocator SUID" }; }
  if (value.disposition === "fenced" && value.fenceConfirmed !== true) {
    return { error: "a fenced resolution requires an explicit durable fence confirmation" };
  }
  if (value.disposition === "revoked" && value.revocationConfirmed !== true) {
    return { error: "a revoked resolution requires an explicit durable writer-revocation confirmation" };
  }
  return { value: {
    attemptId: value.attemptId,
    candidateIndex: value.candidateIndex,
    eventId: value.eventId,
    suid: value.suid,
    allocatorLineageId: value.allocatorLineageId,
    tag: value.tag,
    disposition: value.disposition,
    ...(value.disposition === "fenced" ? { fenceConfirmed: true } : {}),
    ...(value.disposition === "revoked" ? { revocationConfirmed: true } : {}),
  } };
}

function parseReconcileCut(value: unknown): { value?: ReconcileCutInput; error?: string } {
  if (!isObject(value) || !isNonEmptyString(value.allocatorLineageId) || !isNonEmptyString(value.proofId) ||
      value.historyComplete !== true || !isNonEmptyString(value.completeThroughSuid) || !Array.isArray(value.obligations)) {
    return { error: "allocatorLineageId, proofId, historyComplete=true, completeThroughSuid, and obligations are required" };
  }
  const obligations: ReconcileCutInput["obligations"] = [];
  for (const raw of value.obligations) {
    if (!isObject(raw) || !isNonEmptyString(raw.attemptId) || !isNonNegativeInteger(raw.candidateIndex) ||
        !isNonEmptyString(raw.eventId) || !isNonEmptyString(raw.suid)) {
      return { error: "each reconciliation obligation needs attemptId, candidateIndex, eventId, and suid" };
    }
    const targetTags = targetTagsFrom(raw.targetTags);
    if (targetTags === undefined || targetTags.length === 0) return { error: "reconciliation obligations need targetTags" };
    try { assertSortableUniqueId(raw.suid); } catch { return { error: "reconciliation obligation suid is invalid" }; }
    obligations.push({ attemptId: raw.attemptId, candidateIndex: raw.candidateIndex, eventId: raw.eventId, suid: raw.suid, targetTags });
  }
  try { assertSortableUniqueId(value.completeThroughSuid); } catch { return { error: "completeThroughSuid must be a valid allocator SUID" }; }
  const identities = new Set(obligations.map((obligation) => `${obligation.attemptId}:${obligation.candidateIndex}`));
  if (identities.size !== obligations.length) return { error: "reconciliation obligations must not repeat an identity" };
  return { value: {
    allocatorLineageId: value.allocatorLineageId,
    proofId: value.proofId,
    obligations,
    historyComplete: true,
    completeThroughSuid: value.completeThroughSuid,
    ...(isNonEmptyString(value.serviceId) ? { serviceId: value.serviceId } : {}),
    ...(isNonEmptyString(value.legacyMembershipProofId) ? { legacyMembershipProofId: value.legacyMembershipProofId } : {}),
  } };
}

function closedPrefixCertificate(
  state: AllocatorState,
  meta: ClosedPrefixMeta | undefined,
  obligations: IssuanceObligation[],
  index?: ClosedPrefixIndex,
  durableWriteCostMs?: number,
): ClosedPrefixCertificate {
  if (meta === undefined || meta.allocatorLineageId !== state.allocatorLineageId) {
    return {
      certificateVersion: 1,
      authority: "allocator-transaction",
      status: "unreconciled",
      allocatorLineageId: state.allocatorLineageId,
      serviceId: state.serviceId ?? null,
      closedPrefixSuid: null,
      unresolvedCount: obligations.filter((obligation) => obligation.status !== "resolved").length,
      generatedAt: Date.now(),
      migrationProofId: null,
    };
  }
  if (meta.migrationStatus !== "reconciled") {
    return {
      certificateVersion: 1,
      authority: "allocator-transaction",
      status: "unreconciled",
      allocatorLineageId: state.allocatorLineageId,
      serviceId: state.serviceId ?? null,
      closedPrefixSuid: null,
      unresolvedCount: obligations.filter((obligation) => obligation.status !== "resolved").length,
      generatedAt: Date.now(),
      migrationProofId: meta.migrationProofId,
      durableWriteCostMs: durableWriteCostMs ?? state.lastAllocationPersistenceMs,
    };
  }
  if (index !== undefined && index.allocatorLineageId === state.allocatorLineageId) {
    return {
      certificateVersion: 1,
      authority: "allocator-transaction",
      status: "ready",
      allocatorLineageId: state.allocatorLineageId,
      serviceId: state.serviceId ?? null,
      closedPrefixSuid: index.closedPrefixSuid,
      unresolvedCount: index.unresolvedCount,
      generatedAt: Date.now(),
      migrationProofId: meta.migrationProofId,
      acquisitionCostMs: 0,
      durableWriteCostMs: durableWriteCostMs ?? state.lastAllocationPersistenceMs,
    };
  }
  const ordered = [...obligations].sort((left, right) => {
    const leftTicks = decodeSuid(left.suid);
    const rightTicks = decodeSuid(right.suid);
    return leftTicks < rightTicks ? -1 : leftTicks > rightTicks ? 1 : 0;
  });
  const firstUnresolved = ordered.findIndex((obligation) => obligation.status !== "resolved");
  const closed = firstUnresolved < 0 ? ordered : ordered.slice(0, firstUnresolved);
  return {
    certificateVersion: 1,
    authority: "allocator-transaction",
    status: "ready",
    allocatorLineageId: state.allocatorLineageId,
    serviceId: state.serviceId ?? null,
    closedPrefixSuid: closed.length === 0 ? null : closed[closed.length - 1]!.suid,
    unresolvedCount: ordered.filter((obligation) => obligation.status !== "resolved").length,
    generatedAt: Date.now(),
    migrationProofId: meta.migrationProofId,
  };
}

/**
 * A single service-wide allocator. Every allocation uses this one Durable
 * Object instance, so the transaction that writes an attempt vector and the
 * allocated watermark is serialized and atomic.
 */
export class AllocatorDurableObject implements DurableObject {
  /** Observation-only; it is never serialized into Durable Object storage. */
  private readonly activation = new DurableObjectActivation();
  /** Invalidated by every obligation/state mutation; safe reads never call the allocator remotely. */
  private closedPrefixCache: ClosedPrefixCertificate | undefined;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env?: { BOOTSTRAP?: DurableObjectNamespace; TAG?: DurableObjectNamespace },
    private readonly orderClock: OrderClock = systemOrderClock,
    private readonly nativeTracing: NativeTracing = noOpNativeTracing,
  ) {}

  async fetch(request: Request): Promise<Response> {
    // Must run before the first await in every handler admission.
    const activation = this.activation.beginHandler();
    const observation = beginDurableObjectHandlerObservation("ALLOCATOR", activation);
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/allocate") {
      // The native actor wrapper needs the same request identity as the
      // allocation handler. Decode it once: teeing a DO request for tracing
      // and then reading the original leaves a second stream alive past the
      // response boundary under concurrent workerd test isolates.
      let body: unknown | undefined;
      return enterNativeActorHandleSpan(
        this.nativeTracing,
        { actorClass: "ALLOCATOR", actorKey: "allocator", activation, observation },
        async () => {
          try {
            body = await request.json<unknown>();
          } catch {
            return undefined;
          }
          const parsed = allocateFrom(body);
          return parsed.value?.serviceId === undefined
            ? undefined
            : { attemptId: parsed.value.attemptId, serviceId: parsed.value.serviceId };
        },
        () => body === undefined
          ? error(400, "invalid_allocation", "Request body must be JSON")
          : this.allocate(body, activation, observation),
      );
    }
    if (request.method === "GET" && url.pathname === "/state") {
      const state = await this.ctx.storage.transaction(async (txn) => {
        const stored = await txn.get<AllocatorState>(STATE_KEY);
        if (stored !== undefined) {
          assertG32State(stored);
          return { ...stored, bootstrapSeed: stored.bootstrapSeed ?? null, lastRollbackWarningFingerprint: stored.lastRollbackWarningFingerprint ?? null };
        }
        const initialized = currentState(newAllocatorLineageId());
        await txn.put(STATE_KEY, initialized);
        return initialized;
      });
      return json(state);
    }
    if (request.method === "GET" && url.pathname === "/closed-prefix") {
      return this.readClosedPrefix();
    }
    if (request.method === "GET" && url.pathname === "/obligations") {
      return json(await this.readObligations());
    }
    if (request.method === "POST" && url.pathname === "/obligations/resolve") {
      return this.resolveObligation(request);
    }
    if (request.method === "POST" && url.pathname === "/writer-authority") {
      if (request.headers.get("x-sdt-g70-writer-authority") !== "1") {
        return error(403, "writer_authority_forbidden", "Writer authority requires the Tag allocator seam");
      }
      return this.writerAuthority(request);
    }
    if (request.method === "POST" && url.pathname === "/reconcile-cut") {
      return this.reconcileCut(request);
    }
    if (request.method === "GET" && url.pathname.startsWith("/attempts/")) {
      return enterNativeActorHandleSpan(
        this.nativeTracing,
        { actorClass: "ALLOCATOR", actorKey: "allocator", activation, observation },
        async () => undefined,
        async () => {
          let attemptId: string;
          try {
            attemptId = decodeURIComponent(url.pathname.slice("/attempts/".length));
          } catch {
            return error(400, "invalid_attempt_id", "Attempt ID must be URI encoded");
          }
          if (attemptId.length === 0) {
            return error(400, "invalid_attempt_id", "Attempt ID is required");
          }
          observation.markFirstStorageRead();
          const vector = await this.ctx.storage.get<AllocationVector>(attemptKey(attemptId));
          if (vector === undefined) {
            return error(404, "allocation_not_found", "No durable allocation exists for this attempt");
          }
          if (vector.allocatorLineageId !== undefined && vector.allocatorLineageId.length > 0) {
            return json(vector);
          }
          const state = await this.ctx.storage.get<AllocatorState>(STATE_KEY);
          return json({ ...vector, allocatorLineageId: state?.allocatorLineageId || newAllocatorLineageId() });
        },
      );
    }
    if (request.method === "POST" && url.pathname === "/seed-after") return this.seedAfter(request);
    return error(404, "allocator_route_not_found", "Allocator route was not found");
  }

  async alarm(): Promise<void> {
    this.activation.beginHandler();
    const now = Date.now();
    let changed = false;
    // Recovery is driven by a due-time index, not by the first page of the
    // identity record namespace. Unknown or permanently failing writers can
    // therefore not monopolize a page while later writers wait forever.
    const dueEnd = `${RECOVERY_SCHEDULE_PREFIX}${(now + 1).toString().padStart(16, "0")}`;
    const scheduled = [...(await this.ctx.storage.list<string>({
      prefix: RECOVERY_SCHEDULE_PREFIX,
      end: dueEnd,
      limit: RECOVERY_BATCH_LIMIT,
    })).entries()];
    // Namespaces written by W176 predate the schedule index. Migrate only a
    // bounded page per wake; the due-time index is authoritative thereafter.
    const legacyRecords = await this.ctx.storage.list<IssuanceRecoveryRecord>({ prefix: RECOVERY_RECORD_PREFIX, limit: RECOVERY_BATCH_LIMIT });
    let migratedNextAt: number | undefined;
    for (const [key, record] of legacyRecords.entries()) {
      // W176 records have a retry time but no irrevocable-writer deadline.
      // Assign that deadline once, durably, instead of allowing an old
      // record to remain an unknown writer forever after the index migration.
      const normalizedRecord: IssuanceRecoveryRecord = record.revocationDueAt === undefined
        ? { ...record, revocationDueAt: now + RECOVERY_VANISHED_WRITER_GRACE_MS }
        : record;
      if (normalizedRecord !== record) await this.ctx.storage.put(key, normalizedRecord);
      const schedule = recoveryScheduleKey(normalizedRecord.nextAttemptAt, normalizedRecord.attemptId, normalizedRecord.candidateIndex);
      if (await this.ctx.storage.get<string>(schedule) === undefined) {
        await this.ctx.storage.put(schedule, key);
      }
      migratedNextAt = migratedNextAt === undefined ? normalizedRecord.nextAttemptAt : Math.min(migratedNextAt, normalizedRecord.nextAttemptAt);
    }

    let nextAt: number | undefined;
    const future = await this.ctx.storage.list<string>({ prefix: RECOVERY_SCHEDULE_PREFIX, limit: 1 });
    const firstFutureKey = future.keys().next().value as string | undefined;
    if (firstFutureKey !== undefined) {
      const match = firstFutureKey.slice(RECOVERY_SCHEDULE_PREFIX.length).match(/^([0-9]+):/);
      if (match !== null) nextAt = Number(match[1]);
    }
    if (migratedNextAt !== undefined) nextAt = nextAt === undefined ? migratedNextAt : Math.min(nextAt, migratedNextAt);

    for (const [scheduleKey, recoveryRecordKey] of scheduled) {
      const record = await this.ctx.storage.get<IssuanceRecoveryRecord>(recoveryRecordKey);
      if (record === undefined) {
        await this.ctx.storage.delete(scheduleKey);
        continue;
      }
      const dispositions = await this.readRecoveryDispositions(record);
      if (dispositions.length > 0) {
        for (const disposition of dispositions) {
          const response = await this.resolveObligationInput({
            attemptId: record.attemptId,
            candidateIndex: record.candidateIndex,
            eventId: record.eventId,
            suid: record.suid,
            allocatorLineageId: record.allocatorLineageId,
            tag: disposition.tag,
            disposition: disposition.disposition,
            fenceConfirmed: disposition.fenceConfirmed,
          });
          changed ||= response.changed === true;
          if (response.status !== 200) break;
        }
      }
      let remaining = await this.ctx.storage.get<IssuanceObligation>(obligationKey(record.attemptId, record.candidateIndex));
      // A writer that vanished after allocation is not closed by elapsed time
      // alone. Once the durable grace window expires, the allocator records a
      // per-tag irrevocable revocation. Tag append authority checks that fact,
      // so a delayed writer cannot reopen the exact identity after a repair
      // fence is cleared.
      if (remaining !== undefined && remaining.status !== "resolved" &&
          record.revocationDueAt !== undefined && now >= record.revocationDueAt) {
        const installed = new Set(remaining.installedTags);
        const fenced = new Set(remaining.fencedTags);
        const revoked = new Set(remaining.revokedTags ?? []);
        for (const tag of record.targetTags) {
          if (installed.has(tag) || fenced.has(tag) || revoked.has(tag)) continue;
          const response = await this.resolveObligationInput({
            attemptId: record.attemptId,
            candidateIndex: record.candidateIndex,
            eventId: record.eventId,
            suid: record.suid,
            allocatorLineageId: record.allocatorLineageId,
            tag,
            disposition: "revoked",
            revocationConfirmed: true,
          });
          changed ||= response.changed === true;
          if (response.status !== 200) break;
        }
        remaining = await this.ctx.storage.get<IssuanceObligation>(obligationKey(record.attemptId, record.candidateIndex));
      }
      if (remaining?.status === "resolved") {
        await this.ctx.storage.delete(recoveryRecordKey);
        await this.ctx.storage.delete(scheduleKey);
      } else {
        const retry: IssuanceRecoveryRecord = {
          ...record,
          attemptCount: record.attemptCount + 1,
          nextAttemptAt: now + RECOVERY_RETRY_MS,
        };
        await this.ctx.storage.delete(scheduleKey);
        await this.ctx.storage.put(recoveryRecordKey, retry);
        await this.ctx.storage.put(recoveryScheduleKey(retry.nextAttemptAt, retry.attemptId, retry.candidateIndex), recoveryRecordKey);
        nextAt = nextAt === undefined ? retry.nextAttemptAt : Math.min(nextAt, retry.nextAttemptAt);
      }
    }
    if (changed) this.closedPrefixCache = undefined;
    // A bounded page does not prove that the recovery index is exhausted.
    // Keep a continuation alarm whenever due work remains, while preserving a
    // pre-existing earlier alarm set by allocation or another alarm handler.
    if (scheduled.length >= RECOVERY_BATCH_LIMIT) {
      const continuationAt = now + 1;
      nextAt = nextAt === undefined ? continuationAt : Math.min(nextAt, continuationAt);
    }
    if (nextAt !== undefined) await scheduleEarlierAlarm(this.ctx.storage, nextAt);
  }

  private async readObligations(): Promise<IssuanceObligation[]> {
    const indexed = await this.ctx.storage.list<IssuanceObligation>({ prefix: OBLIGATION_RECORD_PREFIX });
    if (indexed.size > 0) {
      return [...indexed.values()].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
    }
    return await this.ctx.storage.get<IssuanceObligation[]>(ISSUANCE_OBLIGATIONS_KEY) ?? [];
  }

  /**
   * Exact writer-authority check used by Tag append before it creates state.
   * `unknown` is intentionally non-authoritative for old/direct Tag seams;
   * once this allocator has a matching G70 obligation, a revoked or fenced
   * participant is permanently denied while an unresolved participant remains
   * allowed to complete the same identity.
   */
  private async writerAuthority(request: Request): Promise<Response> {
    let body: unknown;
    try { body = await request.json<unknown>(); } catch { return error(400, "writer_authority_invalid", "Writer authority request must be JSON"); }
    if (!isObject(body) || !isNonEmptyString(body.serviceId) || !isNonEmptyString(body.tag) ||
        !isNonEmptyString(body.attemptId) ||
        !isNonEmptyString(body.eventId) || !isNonEmptyString(body.suid) || !isNonEmptyString(body.allocatorLineageId)) {
      return error(400, "writer_authority_invalid", "Writer authority identity is incomplete");
    }
    try { assertSortableUniqueId(body.suid); } catch { return error(400, "writer_authority_invalid", "Writer authority SUID is invalid"); }
    const authority = await this.ctx.storage.get<{ attemptId: string; candidateIndex: number }>(writerAuthorityKey(body.eventId, body.allocatorLineageId));
    const candidateIndex = isNonNegativeInteger(body.candidateIndex) ? body.candidateIndex : authority?.candidateIndex;
    if (candidateIndex === undefined || authority?.attemptId !== body.attemptId || authority.candidateIndex !== candidateIndex) {
      return json({ status: "unknown" });
    }
    const state = await this.ctx.storage.get<AllocatorState>(STATE_KEY);
    if (state === undefined) return json({ status: "unknown" });
    assertG32State(state);
    if (state.serviceId !== null && state.serviceId !== undefined && state.serviceId !== body.serviceId) {
      return json({ status: "revoked", reason: "service_authority_mismatch" }, 409);
    }
    if (state.allocatorLineageId !== body.allocatorLineageId) {
      return json({ status: "revoked", reason: "allocator_lineage_mismatch" }, 409);
    }
    const obligation = await this.ctx.storage.get<IssuanceObligation>(obligationKey(body.attemptId, candidateIndex));
    if (obligation === undefined || obligation.eventId !== body.eventId || obligation.suid !== body.suid || !obligation.targetTags.includes(body.tag)) {
      return json({ status: "unknown" });
    }
    if ((obligation.revokedTags ?? []).includes(body.tag) || obligation.fencedTags.includes(body.tag)) {
      return json({ status: "revoked", reason: "writer_revoked" }, 409);
    }
    if (obligation.installedTags.includes(body.tag)) return json({ status: "installed" });
    return json({ status: "allowed" });
  }

  private async readRecoveryDispositions(
    record: IssuanceRecoveryRecord,
  ): Promise<Array<{ readonly tag: string; readonly disposition: "installed" | "fenced"; readonly fenceConfirmed?: true }>> {
    if (this.env?.TAG === undefined) return [];
    const dispositions: Array<{ readonly tag: string; readonly disposition: "installed" | "fenced"; readonly fenceConfirmed?: true }> = [];
    await Promise.all(record.targetTags.map(async (tag) => {
      try {
        const stub = this.env!.TAG!.get(scopeIdFor(this.env!.TAG!, {
          serviceId: record.serviceId,
          doClass: "tag",
          identity: tag,
        }));
        const response = await stub.fetch(new Request(
          `https://allocator.internal/__internal/g70/issuance-status?__tag=${encodeURIComponent(tag)}&__serviceId=${encodeURIComponent(record.serviceId)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-sdt-g70-recovery": "1" },
            body: JSON.stringify({
              attemptId: record.attemptId,
              eventId: record.eventId,
              suid: record.suid,
              allocatorLineageId: record.allocatorLineageId,
            }),
          },
        ));
        if (!response.ok) return;
        const body = await response.json<{ disposition?: IssuanceObligationDisposition; fenceConfirmed?: true }>();
        if (body.disposition === "installed" || (body.disposition === "fenced" && body.fenceConfirmed === true)) {
          dispositions.push({
            tag,
            disposition: body.disposition,
            ...(body.disposition === "fenced" ? { fenceConfirmed: true } : {}),
          });
        }
      } catch {
        // Recovery remains unresolved; the next durable alarm retries the
        // identity-checked Tag read without depending on the original request.
      }
    }));
    return dispositions;
  }

  private async resolveObligationInput(
    input: ResolveObligationInput,
  ): Promise<{ status: number; body: unknown; changed?: boolean }> {
    return this.ctx.storage.transaction(async (txn): Promise<{ status: number; body: unknown; changed?: boolean }> => {
      const state = await txn.get<AllocatorState>(STATE_KEY);
      if (state === undefined || state.allocatorLineageId !== input.allocatorLineageId) {
        return { status: 409, body: { code: "issuance_lineage_mismatch", error: "Issuance lineage is not current" } };
      }
      const obligation = await txn.get<IssuanceObligation>(obligationKey(input.attemptId, input.candidateIndex));
      if (obligation === undefined) {
        return { status: 404, body: { code: "issuance_obligation_not_found", error: "Issuance obligation was not found" } };
      }
      if (obligation.eventId !== input.eventId || obligation.suid !== input.suid) {
        return { status: 409, body: { code: "issuance_identity_mismatch", error: "Issuance identity does not match the durable obligation" } };
      }
      if (!obligation.targetTags.includes(input.tag)) {
        return { status: 409, body: { code: "issuance_tag_mismatch", error: "Tag is not a required issuance participant" } };
      }
      if (input.disposition === "fenced" && input.fenceConfirmed !== true) {
        return { status: 409, body: { code: "issuance_fence_unconfirmed", error: "A Tag fence must be durably confirmed before it can close issuance" } };
      }
      if (input.disposition === "revoked" && input.revocationConfirmed !== true) {
        return { status: 409, body: { code: "issuance_revocation_unconfirmed", error: "A vanished writer must have an explicit durable revocation confirmation" } };
      }
      const installedTags = input.disposition === "installed" && !obligation.installedTags.includes(input.tag)
        ? [...obligation.installedTags, input.tag]
        : obligation.installedTags;
      const fencedTags = input.disposition === "fenced" && !obligation.fencedTags.includes(input.tag)
        ? [...obligation.fencedTags, input.tag]
        : obligation.fencedTags;
      const revokedTags = input.disposition === "revoked" && !(obligation.revokedTags ?? []).includes(input.tag)
        ? [...(obligation.revokedTags ?? []), input.tag]
        : obligation.revokedTags ?? [];
      const resolved = obligation.targetTags.every((tag) => installedTags.includes(tag) || fencedTags.includes(tag) || revokedTags.includes(tag));
      const updated: IssuanceObligation = { ...obligation, installedTags, fencedTags, revokedTags, status: resolved ? "resolved" : "unresolved" };
      const changed = JSON.stringify(updated) !== JSON.stringify(obligation);
      if (changed) {
        await txn.put(obligationKey(input.attemptId, input.candidateIndex), updated);
        const index = await txn.get<ClosedPrefixIndex>(OBLIGATION_INDEX_KEY);
        if (index !== undefined && index.allocatorLineageId === state.allocatorLineageId) {
          let nextIndex: ClosedPrefixIndex = {
            ...index,
            unresolvedCount: Math.max(0, index.unresolvedCount - (obligation.status === "unresolved" && updated.status === "resolved" ? 1 : 0)),
          };
          let advanced = 0;
          while (nextIndex.closedSequence < nextIndex.nextSequence && advanced < CLOSED_PREFIX_ADVANCE_BATCH_LIMIT) {
            const sequence = nextIndex.closedSequence + 1;
            const identity = await txn.get<string>(obligationOrderKey(sequence));
            if (identity === undefined) break;
            const nextObligation = await txn.get<IssuanceObligation>(identity);
            if (nextObligation === undefined || nextObligation.status !== "resolved") break;
            nextIndex = { ...nextIndex, closedSequence: sequence, closedPrefixSuid: nextObligation.suid };
            advanced += 1;
          }
          if (nextIndex.closedSequence < nextIndex.nextSequence && advanced >= CLOSED_PREFIX_ADVANCE_BATCH_LIMIT) {
            await scheduleEarlierAlarm(txn, Date.now() + 1);
          }
          await txn.put(OBLIGATION_INDEX_KEY, nextIndex);
        }
      }
      return { status: 200, body: updated, changed };
    });
  }

  private async allocate(
    body: unknown,
    activation: DurableObjectActivationObservation,
    observation?: DurableObjectHandlerObservation,
  ): Promise<Response> {
    const parsed = allocateFrom(body);
    if (parsed.value === undefined) {
      return error(400, "invalid_allocation", parsed.error ?? "Invalid allocation request");
    }
    const input = parsed.value;
    if (input.serviceId !== undefined && input.bootstrapCommandId !== undefined && input.bootstrapEpoch !== undefined && this.env?.BOOTSTRAP !== undefined) {
      const admitted = await enterNativeCommitSpan(
        this.nativeTracing,
        "allocator.bootstrap.finalize",
        {
          schema: "sdt.commit/v1",
          face: "accepted",
          rowId: "S09",
          correlationId: correlationIdForAttempt(input.attemptId),
          attemptId: input.attemptId,
          serviceId: input.serviceId,
          actorClass: "ALLOCATOR",
          actorKey: `allocator:${input.serviceId}`,
          activation,
          operation: "allocator.bootstrap.finalize",
          kind: "nested",
        },
        async () => {
          const url = new URL("https://allocator.internal/command/finalize");
          url.searchParams.set("__serviceId", input.serviceId!);
          const fetch = () => this.env!.BOOTSTRAP!.get(scopeIdFor(this.env!.BOOTSTRAP!, {
            serviceId: input.serviceId!,
            doClass: "bootstrap",
            identity: "coordinator",
          })).fetch(new Request(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ commandId: input.bootstrapCommandId, leaseEpoch: input.bootstrapEpoch }),
          }));
          return observation === undefined ? fetch() : observation.subrequest(fetch);
        },
      );
      if (!admitted.ok) return error(409, "bootstrap_command_rejected", "bootstrap fencing epoch rejects allocation");
    }

    try {
      observation?.markFirstStorageRead();
      const durableOperationStartedAt = Date.now();
      const result = await this.ctx.storage.transaction(async (txn): Promise<AllocationSuccess> => {
        const existing = await txn.get<AllocationVector>(attemptKey(input.attemptId));
        const persistedState = await txn.get<AllocatorState>(STATE_KEY);
        const persistedMeta = await txn.get<ClosedPrefixMeta>(CLOSED_PREFIX_META_KEY);
        assertG32State(persistedState);
        const lineage = persistedState?.allocatorLineageId || newAllocatorLineageId();
        if (existing !== undefined) {
          // Never upgrade an old attempt vector in place. The new and old
          // lexical domains cannot coexist and a replay must stay byte exact.
          for (const candidate of existing.candidates) assertSortableUniqueId(candidate.suid);
          if (persistedState?.allocatedWatermark !== null && persistedState?.allocatedWatermark !== undefined) {
            assertSortableUniqueId(persistedState.allocatedWatermark);
          }
          if (!isNonEmptyString(existing.allocatorLineageId)) {
            throw new SortableUniqueIdError("SUID_INVALID", "G32 allocator refuses a pre-cutover attempt vector");
          }
          return {
            vector: existing,
            created: false,
          };
        }

        const state = persistedState === undefined
          ? currentState(lineage)
          : { ...persistedState, allocatorLineageId: lineage, schemaVersion: 5 as const, bootstrapSeed: persistedState.bootstrapSeed ?? null, lastRollbackWarningFingerprint: persistedState.lastRollbackWarningFingerprint ?? null };
        if (persistedMeta !== undefined && persistedMeta.allocatorLineageId !== lineage) {
          throw new SortableUniqueIdError("SUID_INVALID", "allocator lineage changed before issuance reconciliation");
        }
        const hasG70TargetMembership = input.candidates.some((candidate) => (candidate.targetTags?.length ?? 0) > 0);
        const priorLegacyObligations = await txn.get<IssuanceObligation[]>(ISSUANCE_OBLIGATIONS_KEY) ?? [];
        const priorAttempts = await txn.list<AllocationVector>({ prefix: ATTEMPT_KEY_PREFIX, limit: 1 });
        const priorIndex = await txn.get<ClosedPrefixIndex>(OBLIGATION_INDEX_KEY);
        // Only an actually empty namespace may establish its first G70
        // membership cut during allocation. A pre-existing vector, watermark,
        // bootstrap seed, or legacy obligation must pass through the explicit
        // reconciliation route before it can issue a safe certificate.
        const freshNamespace = persistedState === undefined && persistedMeta === undefined &&
          priorLegacyObligations.length === 0 && priorAttempts.size === 0 && priorIndex === undefined;
        const closedPrefixMeta = persistedMeta ?? (freshNamespace && hasG70TargetMembership
          ? {
            version: 1 as const,
            allocatorLineageId: lineage,
            migrationStatus: "reconciled" as const,
            migrationProofId: `allocation:${lineage}`,
          }
          : undefined);
        let obligationIndex = await txn.get<ClosedPrefixIndex>(OBLIGATION_INDEX_KEY);
        if (obligationIndex === undefined) {
          const previousObligations = priorLegacyObligations;
          obligationIndex = emptyObligationIndex(lineage);
          // One-time migration only. Subsequent allocations and resolutions
          // use individual records plus this moving index, never a full
          // history array rewrite.
          const legacy = [...previousObligations].sort((left, right) => decodeSuid(left.suid) < decodeSuid(right.suid) ? -1 : 1);
          for (const obligation of legacy) {
            obligationIndex = { ...obligationIndex, nextSequence: obligationIndex.nextSequence + 1, unresolvedCount: obligationIndex.unresolvedCount + (obligation.status === "unresolved" ? 1 : 0), hasParticipantMembership: obligationIndex.hasParticipantMembership === true || obligation.targetTags.length > 0 };
            const migrated = { ...obligation, sequence: obligationIndex.nextSequence };
            const identityKey = obligationKey(obligation.attemptId, obligation.candidateIndex);
            await txn.put(identityKey, migrated);
            await txn.put(obligationOrderKey(obligationIndex.nextSequence), identityKey);
          }
          while (obligationIndex.closedSequence < obligationIndex.nextSequence) {
            const sequence: number = obligationIndex.closedSequence + 1;
            const identityKey = await txn.get<string>(obligationOrderKey(sequence));
            const migrated = identityKey === undefined ? undefined : await txn.get<IssuanceObligation>(identityKey);
            if (migrated === undefined || migrated.status !== "resolved") break;
            obligationIndex = { ...obligationIndex, closedSequence: sequence, closedPrefixSuid: migrated.suid };
          }
          await txn.put(OBLIGATION_INDEX_KEY, obligationIndex);
        }
        // This is intentionally before the first transaction write. A clock
        // failure therefore cannot leave a vector, watermark, or warning fact.
        let clockTick: bigint;
        try {
          clockTick = this.orderClock.tick();
        } catch (error) {
          throw error instanceof OrderClockReadError
            ? error
            : new OrderClockReadError("Order clock failed before allocation write", { cause: error });
        }
        const range = allocateOrderRange(state.allocatedWatermark, input.candidates.length, clockTick);
        const rollback = range.observedTicks !== null && range.physicalTicks < range.observedTicks;
        // The warning key is deliberately independent of the newly allocated
        // watermark.  A rollback observed repeatedly in one clock window is
        // one operational fact, not a new fact for every monotone allocation.
        const warningWindow = (clockTick / ROLLBACK_WARNING_WINDOW_MS).toString();
        const warningFingerprint = `rollback:${lineage}:${warningWindow}`;
        const shouldWarn = rollback && state.lastRollbackWarningFingerprint !== warningFingerprint;
        const candidates: AllocatedCandidate[] = input.candidates.map((candidate, index) => ({
          ...candidate,
          suid: range.suids[index]!,
        }));
        const vector: AllocationVector = {
          attemptId: input.attemptId,
          allocatorLineageId: lineage,
          issuanceObligationVersion: 1,
          candidates,
          // Diagnostic presentation only; ordering is the ordinal above.
          allocatedAt: diagnosticAllocatedAt(range.base),
        };
        const updatedState: AllocatorState = {
          schemaVersion: 5,
          allocatorLineageId: lineage,
          allocatedWatermark: range.watermark,
          bootstrapSeed: state.bootstrapSeed ?? null,
          serviceId: input.serviceId ?? state.serviceId ?? null,
          lastRollbackWarningFingerprint: shouldWarn ? warningFingerprint : state.lastRollbackWarningFingerprint ?? null,
        };
        await txn.put(attemptKey(input.attemptId), vector);
        if (input.faultInjection === "between-vector-and-watermark") {
          throw new AllocationTransactionFault("Simulated interruption before transaction commit");
        }
        for (const candidate of candidates) {
          const targetTags = [...new Set(candidate.targetTags ?? [])];
          const sequence: number = obligationIndex!.nextSequence + 1;
          const obligation: IssuanceObligation = {
            attemptId: input.attemptId,
            candidateIndex: candidate.candidateIndex,
            eventId: candidate.eventId,
            suid: candidate.suid,
            allocatorLineageId: lineage,
            targetTags,
            installedTags: [],
            fencedTags: [],
            revokedTags: [],
            status: targetTags.length === 0 ? "resolved" : "unresolved",
            sequence,
          };
          const identityKey = obligationKey(obligation.attemptId, obligation.candidateIndex);
          await txn.put(identityKey, obligation);
          await txn.put(obligationOrderKey(sequence), identityKey);
          await txn.put(writerAuthorityKey(obligation.eventId, obligation.allocatorLineageId), {
            attemptId: obligation.attemptId,
            candidateIndex: obligation.candidateIndex,
          });
          if (targetTags.length > 0 && input.serviceId !== undefined && input.serviceId.length > 0) {
            const recovery: IssuanceRecoveryRecord = {
              serviceId: input.serviceId,
              attemptId: input.attemptId,
              candidateIndex: candidate.candidateIndex,
              eventId: candidate.eventId,
              suid: candidate.suid,
              allocatorLineageId: lineage,
              targetTags,
              nextAttemptAt: Date.now() + RECOVERY_RETRY_MS,
              attemptCount: 0,
              revocationDueAt: Date.now() + RECOVERY_VANISHED_WRITER_GRACE_MS,
            };
            const recoveryRecordKey = recoveryKey(obligation.attemptId, obligation.candidateIndex);
            await txn.put(recoveryRecordKey, recovery);
            await txn.put(recoveryScheduleKey(recovery.nextAttemptAt, recovery.attemptId, recovery.candidateIndex), recoveryRecordKey);
          }
          obligationIndex = {
            ...obligationIndex!,
            nextSequence: sequence,
            unresolvedCount: obligationIndex!.unresolvedCount + (obligation.status === "unresolved" ? 1 : 0),
            hasParticipantMembership: obligationIndex!.hasParticipantMembership === true || targetTags.length > 0,
          };
        }
        let advanced = 0;
        while (obligationIndex!.closedSequence < obligationIndex!.nextSequence && advanced < CLOSED_PREFIX_ADVANCE_BATCH_LIMIT) {
          const sequence: number = obligationIndex!.closedSequence + 1;
          const identityKey = await txn.get<string>(obligationOrderKey(sequence));
          const obligation = identityKey === undefined ? undefined : await txn.get<IssuanceObligation>(identityKey);
          if (obligation === undefined || obligation.status !== "resolved") break;
          obligationIndex = { ...obligationIndex!, closedSequence: sequence, closedPrefixSuid: obligation.suid };
          advanced += 1;
        }
        if (advanced >= CLOSED_PREFIX_ADVANCE_BATCH_LIMIT && obligationIndex!.closedSequence < obligationIndex!.nextSequence) {
          await scheduleEarlierAlarm(txn, Date.now() + 1);
        }
        await txn.put(STATE_KEY, updatedState);
        await txn.put(OBLIGATION_INDEX_KEY, obligationIndex!);
        if (input.candidates.some((candidate) => (candidate.targetTags?.length ?? 0) > 0)) {
          // The recovery obligation and its first alarm share the allocation
          // transaction. A crash after commit and before the request-owned
          // waitUntil callback can therefore never strand resolution work.
          await scheduleEarlierAlarm(txn, Date.now() + RECOVERY_RETRY_MS);
        }
        if (closedPrefixMeta !== undefined) await txn.put(CLOSED_PREFIX_META_KEY, closedPrefixMeta);
        return {
          vector,
          created: true,
          ...(shouldWarn ? {
            rollbackWarning: {
              tick: range.physicalTicks.toString(),
              watermark: state.allocatedWatermark,
              serviceId: input.serviceId ?? "unknown-service",
              allocatorLineageId: lineage,
            },
          } : {}),
        };
      });
      // This measurement is taken only after the transaction promise has
      // resolved, so it represents a completed durable operation rather than
      // time spent before commit. It is diagnostic and cannot authorize a
      // prefix or alter allocation order.
      const completedDurableWriteMs = Math.max(0, Date.now() - durableOperationStartedAt);
      await this.ctx.storage.put(LAST_ALLOCATION_COST_KEY, completedDurableWriteMs);
      this.closedPrefixCache = undefined;
      if (result.created && result.vector.candidates.some((candidate) => (candidate.targetTags?.length ?? 0) > 0)) {
        await scheduleEarlierAlarm(this.ctx.storage, Date.now() + RECOVERY_RETRY_MS);
      }
      if (result.rollbackWarning !== undefined) {
        try {
          console.warn(JSON.stringify({ type: "allocator_clock_rollback", ...result.rollbackWarning }));
        } catch {
          // Warning transport is observational; it must never change the
          // already committed allocation result.
        }
      }
      return json(result.vector, result.created ? 201 : 200);
    } catch (failure) {
      if (failure instanceof AllocationTransactionFault) {
        return error(
          503,
          "simulated_allocation_crash",
          "Simulated interruption before durable allocation transaction commit",
        );
      }
      if (failure instanceof OrderClockReadError) {
        return error(503, "allocator_order_clock_failed", failure.message);
      }
      if (failure instanceof SortableUniqueIdError) {
        return error(409, "allocator_suid_invalid", failure.message);
      }
      return error(500, "allocator_failure", "Allocator could not persist the full allocation vector");
    }
  }

  private async readClosedPrefix(): Promise<Response> {
    if (this.closedPrefixCache !== undefined) return json(this.closedPrefixCache);
    const acquisitionStartedAt = Date.now();
    const result = await this.ctx.storage.transaction(async (txn): Promise<ClosedPrefixCertificate> => {
      let state = await txn.get<AllocatorState>(STATE_KEY);
      if (state === undefined) {
        state = currentState(newAllocatorLineageId());
        await txn.put(STATE_KEY, state);
      }
      assertG32State(state);
      const durableWriteCostMs = await txn.get<number>(LAST_ALLOCATION_COST_KEY);
      let meta = await txn.get<ClosedPrefixMeta>(CLOSED_PREFIX_META_KEY);
      const index = await txn.get<ClosedPrefixIndex>(OBLIGATION_INDEX_KEY);
      const obligations = index === undefined
        ? await txn.get<IssuanceObligation[]>(ISSUANCE_OBLIGATIONS_KEY) ?? []
        : [];
      if (meta === undefined) {
        meta = currentClosedPrefixMeta(state.allocatorLineageId);
        await txn.put(CLOSED_PREFIX_META_KEY, meta);
      }
      return closedPrefixCertificate(state, meta, obligations, index, durableWriteCostMs);
    });
    const measured: ClosedPrefixCertificate = {
      ...result,
      acquisitionCostMs: Math.max(0, Date.now() - acquisitionStartedAt),
    };
    this.closedPrefixCache = measured;
    return json(measured);
  }

  private async resolveObligation(request: Request): Promise<Response> {
    let body: unknown;
    try { body = await request.json<unknown>(); } catch { return error(400, "invalid_issuance_resolution", "Request body must be JSON"); }
    const parsed = parseResolution(body);
    if (parsed.value === undefined) return error(400, "invalid_issuance_resolution", parsed.error ?? "Invalid issuance resolution");
    const result = await this.resolveObligationInput(parsed.value);
    if (result.status === 200 && result.changed === true) this.closedPrefixCache = undefined;
    return json(result.body, result.status);
  }

  private async reconcileCut(request: Request): Promise<Response> {
    let body: unknown;
    try { body = await request.json<unknown>(); } catch { return error(400, "invalid_reconciliation_cut", "Request body must be JSON"); }
    const parsed = parseReconcileCut(body);
    if (parsed.value === undefined) return error(400, "invalid_reconciliation_cut", parsed.error ?? "Invalid reconciliation cut");
    const input = parsed.value;
    // A bootstrap/legacy namespace cannot establish a completeness cut from
    // an empty assertion. The caller must provide the externally enumerated
    // history; the transaction below then identity-checks every durable row
    // already known to this allocator before merging it with that proof.
    if (input.obligations.length === 0) {
      return error(409, "reconciliation_empty_history", "A reconciliation cut must enumerate the durable issuance history");
    }
    if (input.obligations.length > RECONCILIATION_BATCH_LIMIT) {
      return error(413, "reconciliation_batch_limit", `Reconciliation cut is bounded to ${RECONCILIATION_BATCH_LIMIT} obligations; continue from the same authoritative cut`);
    }
    if (input.obligations.some((obligation) => obligation.targetTags.length > 0) && input.serviceId === undefined) {
      return error(409, "reconciliation_service_required", "Participant-bearing reconciliation requires the owning serviceId");
    }
    const indexedSnapshot = await this.ctx.storage.list<IssuanceObligation>({ prefix: OBLIGATION_RECORD_PREFIX, limit: RECONCILIATION_BATCH_LIMIT + 1 });
    // Reconciliation is the exceptional recovery boundary. Unlike ordinary
    // allocation/resolution, it may enumerate the durable attempt vectors so
    // an operator-supplied cut cannot omit a lower allocation and certify a
    // newer prefix. The hot path never performs this scan.
    const allocationSnapshot = await this.ctx.storage.list<AllocationVector>({ prefix: ATTEMPT_KEY_PREFIX, limit: RECONCILIATION_BATCH_LIMIT + 1 });
    if (indexedSnapshot.size > RECONCILIATION_BATCH_LIMIT || allocationSnapshot.size > RECONCILIATION_BATCH_LIMIT) {
      return error(413, "reconciliation_durable_history_limit", `Durable reconciliation history exceeds the bounded ${RECONCILIATION_BATCH_LIMIT}-record cut`);
    }
    const result = await this.ctx.storage.transaction(async (txn): Promise<{ status: number; body: unknown }> => {
      const state = await txn.get<AllocatorState>(STATE_KEY);
      if (state === undefined || state.allocatorLineageId !== input.allocatorLineageId) return { status: 409, body: { code: "issuance_lineage_mismatch", error: "Reconciliation lineage is not current" } };
      if (state.allocatedWatermark !== input.completeThroughSuid) {
        return { status: 409, body: { code: "reconciliation_incomplete_cut", error: "Reconciliation cut must cover the allocator watermark" } };
      }
      const existingMeta = await txn.get<ClosedPrefixMeta>(CLOSED_PREFIX_META_KEY);
      const legacyObligations = await txn.get<IssuanceObligation[]>(ISSUANCE_OBLIGATIONS_KEY) ?? [];
      const existingObligations = [
        ...legacyObligations,
        ...[...indexedSnapshot.values()],
      ];
      const durableCandidates = [...allocationSnapshot.values()].flatMap((vector) => vector.candidates.map((candidate) => ({
        attemptId: vector.attemptId,
        candidateIndex: candidate.candidateIndex,
        eventId: candidate.eventId,
        suid: candidate.suid,
        targetTags: [...new Set(candidate.targetTags ?? [])],
      })));
      const legacyCutRequired = existingMeta?.migrationStatus !== "reconciled" &&
        (state.bootstrapSeed !== null || state.allocatedWatermark !== null);
      if (!legacyCutRequired) return { status: 409, body: { code: "reconciliation_not_required", error: "Current allocator has no legacy cut" } };
      const completeThrough = decodeSuid(input.completeThroughSuid);
      const importedIdentities = new Set<string>();
      const importedEventIds = new Set<string>();
      const importedSuids = new Set<string>();
      const imported: IssuanceObligation[] = [];
      let previousImportedSuid: bigint | undefined;
      for (const obligation of input.obligations) {
        const identity = obligationIdentity(obligation.attemptId, obligation.candidateIndex);
        if (importedIdentities.has(identity)) return { status: 409, body: { code: "reconciliation_invalid_history", error: "reconciliation identity repeated" } };
        importedIdentities.add(identity);
        if (importedEventIds.has(obligation.eventId)) return { status: 409, body: { code: "reconciliation_invalid_history", error: "reconciliation event identity repeated" } };
        importedEventIds.add(obligation.eventId);
        if (importedSuids.has(obligation.suid)) return { status: 409, body: { code: "reconciliation_invalid_history", error: "reconciliation SUID repeated" } };
        importedSuids.add(obligation.suid);
        const importedSuid = decodeSuid(obligation.suid);
        if (importedSuid > completeThrough) return { status: 409, body: { code: "reconciliation_incomplete_cut", error: "reconciliation obligation exceeds the completeness cut" } };
        if (previousImportedSuid !== undefined && importedSuid <= previousImportedSuid) return { status: 409, body: { code: "reconciliation_invalid_history", error: "reconciliation obligations must be strictly SUID ordered" } };
        previousImportedSuid = importedSuid;
        imported.push({
          ...obligation,
          targetTags: [...new Set(obligation.targetTags)],
          installedTags: [],
          fencedTags: [],
          allocatorLineageId: input.allocatorLineageId,
          status: "unresolved",
        });
      }
      for (const candidate of durableCandidates) {
        const identity = obligationIdentity(candidate.attemptId, candidate.candidateIndex);
        const importedObligation = imported.find((obligation) => obligationIdentity(obligation.attemptId, obligation.candidateIndex) === identity);
        const oldVectorMembershipRequiresProof = candidate.targetTags.length === 0 && importedObligation?.targetTags.length !== 0;
        const membershipMatches = importedObligation !== undefined && (
          JSON.stringify(importedObligation.targetTags) === JSON.stringify(candidate.targetTags) ||
          (oldVectorMembershipRequiresProof && input.legacyMembershipProofId !== undefined)
        );
        if (importedObligation === undefined || importedObligation.eventId !== candidate.eventId || importedObligation.suid !== candidate.suid || !membershipMatches) {
          return { status: 409, body: { code: "reconciliation_omits_durable_history", error: "reconciliation cut does not cover every durable allocation candidate" } };
        }
      }
      if (durableCandidates.length > 0 && imported.length !== durableCandidates.length) {
        return { status: 409, body: { code: "reconciliation_extra_history", error: "reconciliation cut contains history not present in the durable allocator vectors" } };
      }
      if (durableCandidates.length === 0 && state.bootstrapSeed === null) {
        return { status: 409, body: { code: "reconciliation_missing_authority", error: "reconciliation has no durable allocation history or bootstrap witness" } };
      }
      const currentByIdentity = new Map(existingObligations.map((obligation) => [obligationIdentity(obligation.attemptId, obligation.candidateIndex), obligation]));
      for (const obligation of imported) {
        const existing = currentByIdentity.get(obligationIdentity(obligation.attemptId, obligation.candidateIndex));
        const legacyMembershipMatch = existing?.targetTags.length === 0 && obligation.targetTags.length > 0 && input.legacyMembershipProofId !== undefined;
        if (existing !== undefined && (existing.eventId !== obligation.eventId || existing.suid !== obligation.suid ||
          (JSON.stringify(existing.targetTags) !== JSON.stringify(obligation.targetTags) && !legacyMembershipMatch))) {
          return { status: 409, body: { code: "reconciliation_identity_mismatch", error: "Reconciliation cut conflicts with durable history" } };
        }
      }
      if (existingObligations.some((obligation) => !importedIdentities.has(obligationIdentity(obligation.attemptId, obligation.candidateIndex)))) {
        return { status: 409, body: { code: "reconciliation_omits_durable_history", error: "Reconciliation cut omitted a known allocation" } };
      }
      const mergedByIdentity = new Map<string, IssuanceObligation>();
      for (const obligation of existingObligations) mergedByIdentity.set(obligationIdentity(obligation.attemptId, obligation.candidateIndex), obligation);
      for (const obligation of imported) {
        const identity = obligationIdentity(obligation.attemptId, obligation.candidateIndex);
        const existing = mergedByIdentity.get(identity);
        const legacyMembershipMatch = existing?.targetTags.length === 0 && obligation.targetTags.length > 0 && input.legacyMembershipProofId !== undefined;
        if (!mergedByIdentity.has(identity) || legacyMembershipMatch) mergedByIdentity.set(identity, obligation);
      }
      const merged = [...mergedByIdentity.values()].sort((left, right) => decodeSuid(left.suid) < decodeSuid(right.suid) ? -1 : 1);
      const index: ClosedPrefixIndex = {
        version: 1,
        allocatorLineageId: input.allocatorLineageId,
        nextSequence: merged.length,
        closedSequence: 0,
        closedPrefixSuid: null,
        unresolvedCount: merged.filter((obligation) => obligation.status !== "resolved").length,
        hasParticipantMembership: true,
      };
      for (const [sequence, obligation] of merged.entries()) {
        const existing = currentByIdentity.get(obligationIdentity(obligation.attemptId, obligation.candidateIndex));
        const legacyMembershipMatch = existing?.targetTags.length === 0 && obligation.targetTags.length > 0 && input.legacyMembershipProofId !== undefined;
        const persisted: IssuanceObligation = {
          ...obligation,
          sequence: sequence + 1,
          allocatorLineageId: input.allocatorLineageId,
          installedTags: legacyMembershipMatch ? [] : existing?.installedTags ?? obligation.installedTags,
          fencedTags: legacyMembershipMatch ? [] : existing?.fencedTags ?? obligation.fencedTags,
          revokedTags: legacyMembershipMatch ? [] : existing?.revokedTags ?? obligation.revokedTags ?? [],
          status: legacyMembershipMatch ? "unresolved" : existing?.status ?? obligation.status,
        };
        const identityKey = obligationKey(obligation.attemptId, obligation.candidateIndex);
        await txn.put(identityKey, persisted);
        await txn.put(obligationOrderKey(sequence + 1), identityKey);
        await txn.put(writerAuthorityKey(persisted.eventId, persisted.allocatorLineageId), {
          attemptId: persisted.attemptId,
          candidateIndex: persisted.candidateIndex,
        });
        if (obligation.targetTags.length > 0 && (input.serviceId !== undefined || existing !== undefined)) {
          const existingRecovery = await txn.get<IssuanceRecoveryRecord>(recoveryKey(obligation.attemptId, obligation.candidateIndex));
          if (existingRecovery === undefined) {
            const nextAttemptAt = Date.now() + RECOVERY_RETRY_MS;
            await txn.put(recoveryKey(obligation.attemptId, obligation.candidateIndex), {
              serviceId: input.serviceId ?? "",
              attemptId: obligation.attemptId,
              candidateIndex: obligation.candidateIndex,
              eventId: obligation.eventId,
              suid: obligation.suid,
              allocatorLineageId: input.allocatorLineageId,
              targetTags: obligation.targetTags,
              nextAttemptAt,
              attemptCount: 0,
              revocationDueAt: nextAttemptAt + RECOVERY_VANISHED_WRITER_GRACE_MS - RECOVERY_RETRY_MS,
            } satisfies IssuanceRecoveryRecord);
            const recoveryRecordKey = recoveryKey(obligation.attemptId, obligation.candidateIndex);
            await txn.put(recoveryScheduleKey(nextAttemptAt, obligation.attemptId, obligation.candidateIndex), recoveryRecordKey);
          } else if (existingRecovery.revocationDueAt === undefined) {
            // A pre-W181 recovery row must receive the same finite vanished
            // writer boundary as a newly reconciled row.  Otherwise a legacy
            // unknown writer could survive every alarm indefinitely.
            await txn.put(recoveryKey(obligation.attemptId, obligation.candidateIndex), {
              ...existingRecovery,
              revocationDueAt: Date.now() + RECOVERY_VANISHED_WRITER_GRACE_MS,
            });
          }
        }
      }
      let closed = { ...index };
      let advanced = 0;
      while (closed.closedSequence < closed.nextSequence && advanced < CLOSED_PREFIX_ADVANCE_BATCH_LIMIT) {
        const sequence = closed.closedSequence + 1;
        const identityKey = await txn.get<string>(obligationOrderKey(sequence));
        const obligation = identityKey === undefined ? undefined : await txn.get<IssuanceObligation>(identityKey);
        if (obligation === undefined || obligation.status !== "resolved") break;
        closed = { ...closed, closedSequence: sequence, closedPrefixSuid: obligation.suid };
        advanced += 1;
      }
      if (advanced >= CLOSED_PREFIX_ADVANCE_BATCH_LIMIT && closed.closedSequence < closed.nextSequence) {
        await scheduleEarlierAlarm(txn, Date.now() + 1);
      }
      await txn.put(OBLIGATION_INDEX_KEY, closed);
      await txn.delete(ISSUANCE_OBLIGATIONS_KEY);
      const meta: ClosedPrefixMeta = { version: 1, allocatorLineageId: input.allocatorLineageId, migrationStatus: "reconciled", migrationProofId: input.proofId };
      await txn.put(CLOSED_PREFIX_META_KEY, meta);
      await txn.put(STATE_KEY, { ...state, serviceId: input.serviceId ?? state.serviceId ?? null });
      if (merged.some((obligation) => obligation.targetTags.length > 0 && obligation.status !== "resolved")) {
        // Reconciliation is also a durable recovery boundary. Do not make the
        // caller responsible for keeping a finite request alive after the cut.
        await scheduleEarlierAlarm(txn, Date.now() + RECOVERY_RETRY_MS);
      }
      return { status: 201, body: { ...meta, historyComplete: input.historyComplete, completeThroughSuid: input.completeThroughSuid, importedObligationCount: merged.length } };
    });
    if (result.status === 201) this.closedPrefixCache = undefined;
    return json(result.body, result.status);
  }

  /** One transaction: only a never-used allocator can establish bootstrap successor state. */
  private async seedAfter(request: Request): Promise<Response> {
    let body: unknown; try { body = await request.json<unknown>(); } catch { return error(400, "invalid_bootstrap_seed", "Request body must be JSON"); }
    const parsed = seedFrom(body); if (parsed.value === undefined) return error(400, "invalid_bootstrap_seed", parsed.error ?? "Invalid bootstrap seed");
    const input = parsed.value;
    const result = await this.ctx.storage.transaction(async (txn): Promise<{ status: number; body: unknown }> => {
      const stored = await txn.get<AllocatorState>(STATE_KEY);
      assertG32State(stored);
      const state = stored === undefined ? currentState(newAllocatorLineageId()) : { ...stored, bootstrapSeed: stored.bootstrapSeed ?? null, lastRollbackWarningFingerprint: stored.lastRollbackWarningFingerprint ?? null };
      const seed = state.bootstrapSeed;
      if (seed !== null) {
        if (seed.importId === input.importId && seed.leaseEpoch === input.leaseEpoch && seed.highWatermark === input.highWatermark) return { status: 200, body: state };
        return { status: 409, body: { code: "allocator_seed_rejected", error: "allocator already seeded" } };
      }
      if (state.allocatedWatermark !== null) return { status: 409, body: { code: "allocator_seed_rejected", error: "allocator already allocating" } };
      const updated: AllocatorState = { ...state, allocatedWatermark: input.highWatermark, bootstrapSeed: input };
      await txn.put(STATE_KEY, updated);
      await txn.put(CLOSED_PREFIX_META_KEY, currentClosedPrefixMeta(state.allocatorLineageId));
      return { status: 201, body: updated };
    });
    if (result.status === 201) this.closedPrefixCache = undefined;
    return json(result.body, result.status);
  }
}

/** Read the background-safe-pass certificate through an already scoped stub. */
export async function readClosedPrefixCertificate(
  allocator: DurableObjectStub,
  expected?: { readonly serviceId?: string; readonly allocatorLineageId?: string },
): Promise<ClosedPrefixCertificate | undefined> {
  try {
    const response = await allocator.fetch(new Request("https://allocator.internal/closed-prefix"));
    if (!response.ok) return undefined;
    const value = await response.json<unknown>();
    if (!isObject(value) || value.certificateVersion !== 1 || value.authority !== "allocator-transaction" ||
        (value.status !== "ready" && value.status !== "unreconciled") ||
        !isNonEmptyString(value.allocatorLineageId) ||
        !(value.serviceId === undefined || value.serviceId === null || isNonEmptyString(value.serviceId)) ||
        !(value.closedPrefixSuid === null || isNonEmptyString(value.closedPrefixSuid)) ||
        !isNonNegativeInteger(value.unresolvedCount) ||
        typeof value.generatedAt !== "number" || !Number.isFinite(value.generatedAt) ||
        !(value.migrationProofId === null || isNonEmptyString(value.migrationProofId)) ||
        (value.acquisitionCostMs !== undefined && (!isNonNegativeInteger(value.acquisitionCostMs) || !Number.isFinite(value.acquisitionCostMs))) ||
        (value.durableWriteCostMs !== undefined && (!isNonNegativeInteger(value.durableWriteCostMs) || !Number.isFinite(value.durableWriteCostMs)))) {
      return undefined;
    }
    if (value.closedPrefixSuid !== null) assertSortableUniqueId(value.closedPrefixSuid);
    if (value.status === "unreconciled" && value.closedPrefixSuid !== null) return undefined;
    if (expected?.serviceId !== undefined && value.serviceId !== expected.serviceId) return undefined;
    if (expected?.allocatorLineageId !== undefined && value.allocatorLineageId !== expected.allocatorLineageId) return undefined;
    return value as unknown as ClosedPrefixCertificate;
  } catch {
    return undefined;
  }
}
