import type {
  AllocatedCandidate,
  AllocationCandidate,
  AllocationVector,
  AllocatorState,
  ClosedPrefixCertificate,
  IssuanceObligation,
  IssuanceObligationDisposition,
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
const CLOSED_PREFIX_META_KEY = "closed-prefix-meta";
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
}

interface ReconcileCutInput {
  readonly allocatorLineageId: string;
  readonly proofId: string;
  readonly obligations: Array<Pick<IssuanceObligation, "attemptId" | "candidateIndex" | "eventId" | "suid" | "targetTags">>;
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

function currentState(allocatorLineageId: string): AllocatorState {
  return { schemaVersion: 5, allocatorLineageId, allocatedWatermark: null, bootstrapSeed: null, lastRollbackWarningFingerprint: null };
}

function currentClosedPrefixMeta(allocatorLineageId: string): ClosedPrefixMeta {
  return { version: 1, allocatorLineageId, migrationStatus: "new", migrationProofId: null };
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

  const bootstrap = isNonEmptyString(value.serviceId) && isNonEmptyString(value.bootstrapCommandId) && isNonNegativeInteger(value.bootstrapEpoch)
    ? { serviceId: value.serviceId, bootstrapCommandId: value.bootstrapCommandId, bootstrapEpoch: value.bootstrapEpoch }
    : {};
  return { value: { attemptId: value.attemptId, candidates: ordered, faultInjection, ...bootstrap } };
}

function parseResolution(value: unknown): { value?: ResolveObligationInput; error?: string } {
  if (!isObject(value) || !isNonEmptyString(value.attemptId) || !isNonNegativeInteger(value.candidateIndex) ||
      !isNonEmptyString(value.eventId) || !isNonEmptyString(value.suid) || !isNonEmptyString(value.allocatorLineageId) ||
      !isNonEmptyString(value.tag) || (value.disposition !== "installed" && value.disposition !== "fenced")) {
    return { error: "attemptId, candidateIndex, eventId, suid, allocatorLineageId, tag, and disposition are required" };
  }
  try { assertSortableUniqueId(value.suid); } catch { return { error: "suid must be a valid allocator SUID" }; }
  return { value: {
    attemptId: value.attemptId,
    candidateIndex: value.candidateIndex,
    eventId: value.eventId,
    suid: value.suid,
    allocatorLineageId: value.allocatorLineageId,
    tag: value.tag,
    disposition: value.disposition,
  } };
}

function parseReconcileCut(value: unknown): { value?: ReconcileCutInput; error?: string } {
  if (!isObject(value) || !isNonEmptyString(value.allocatorLineageId) || !isNonEmptyString(value.proofId) || !Array.isArray(value.obligations)) {
    return { error: "allocatorLineageId, proofId, and obligations are required" };
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
  return { value: { allocatorLineageId: value.allocatorLineageId, proofId: value.proofId, obligations } };
}

function closedPrefixCertificate(
  state: AllocatorState,
  meta: ClosedPrefixMeta | undefined,
  obligations: IssuanceObligation[],
): ClosedPrefixCertificate {
  if (meta === undefined || meta.allocatorLineageId !== state.allocatorLineageId) {
    return {
      certificateVersion: 1,
      status: "unreconciled",
      allocatorLineageId: state.allocatorLineageId,
      closedPrefixSuid: null,
      unresolvedCount: obligations.filter((obligation) => obligation.status !== "resolved").length,
      generatedAt: Date.now(),
      migrationProofId: null,
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
    status: "ready",
    allocatorLineageId: state.allocatorLineageId,
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
    private readonly env?: { BOOTSTRAP?: DurableObjectNamespace },
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
      return json(await this.ctx.storage.get<IssuanceObligation[]>(ISSUANCE_OBLIGATIONS_KEY) ?? []);
    }
    if (request.method === "POST" && url.pathname === "/obligations/resolve") {
      return this.resolveObligation(request);
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
    if (input.serviceId !== undefined && this.env?.BOOTSTRAP !== undefined) {
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
        if (persistedMeta === undefined && persistedState?.allocatedWatermark !== null && persistedState?.allocatedWatermark !== undefined && hasG70TargetMembership) {
          throw new SortableUniqueIdError("SUID_INVALID", "allocator requires a reconciliation cut before new allocation");
        }
        // Direct legacy allocator callers do not have source membership and
        // therefore cannot establish a G70 certificate. Keep their vector
        // compatibility, but leave the namespace unreconciled for the safe
        // lane instead of minting a fiat certificate.
        const closedPrefixMeta = persistedMeta ?? (hasG70TargetMembership ? currentClosedPrefixMeta(lineage) : undefined);
        const previousObligations = await txn.get<IssuanceObligation[]>(ISSUANCE_OBLIGATIONS_KEY) ?? [];
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
          lastRollbackWarningFingerprint: shouldWarn ? warningFingerprint : state.lastRollbackWarningFingerprint ?? null,
        };
        const obligations: IssuanceObligation[] = [
          ...previousObligations,
          ...candidates.map((candidate) => ({
            attemptId: input.attemptId,
            candidateIndex: candidate.candidateIndex,
            eventId: candidate.eventId,
            suid: candidate.suid,
            allocatorLineageId: lineage,
            targetTags: [...new Set(candidate.targetTags ?? [])],
            installedTags: [],
            fencedTags: [],
            // An allocation with no source participants is already closed by
            // the vacuous participant rule. Public CommitWorker allocations
            // always carry their concrete Tag set; this keeps the allocator's
            // older direct callers compatible without inventing a participant.
            status: (candidate.targetTags?.length === 0 ? "resolved" : "unresolved") as "resolved" | "unresolved",
          })),
        ];

        await txn.put(attemptKey(input.attemptId), vector);
        if (input.faultInjection === "between-vector-and-watermark") {
          throw new AllocationTransactionFault("Simulated interruption before transaction commit");
        }
        await txn.put(STATE_KEY, updatedState);
        await txn.put(ISSUANCE_OBLIGATIONS_KEY, obligations);
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
      this.closedPrefixCache = undefined;
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
    const result = await this.ctx.storage.transaction(async (txn): Promise<ClosedPrefixCertificate> => {
      let state = await txn.get<AllocatorState>(STATE_KEY);
      if (state === undefined) {
        state = currentState(newAllocatorLineageId());
        await txn.put(STATE_KEY, state);
      }
      assertG32State(state);
      let meta = await txn.get<ClosedPrefixMeta>(CLOSED_PREFIX_META_KEY);
      const obligations = await txn.get<IssuanceObligation[]>(ISSUANCE_OBLIGATIONS_KEY) ?? [];
      // A non-empty legacy allocator has vectors but no G70 obligation index.
      // It is deliberately unreconciled rather than silently treated as closed.
      if (meta === undefined && state.allocatedWatermark !== null) {
        return closedPrefixCertificate(state, undefined, obligations);
      }
      if (meta?.migrationStatus === "new" && state.bootstrapSeed !== null) {
        return {
          certificateVersion: 1,
          status: "unreconciled",
          allocatorLineageId: state.allocatorLineageId,
          closedPrefixSuid: null,
          unresolvedCount: obligations.filter((obligation) => obligation.status !== "resolved").length,
          generatedAt: Date.now(),
          migrationProofId: null,
        };
      }
      if (meta === undefined) {
        meta = currentClosedPrefixMeta(state.allocatorLineageId);
        await txn.put(CLOSED_PREFIX_META_KEY, meta);
      }
      return closedPrefixCertificate(state, meta, obligations);
    });
    this.closedPrefixCache = result;
    return json(result);
  }

  private async resolveObligation(request: Request): Promise<Response> {
    let body: unknown;
    try { body = await request.json<unknown>(); } catch { return error(400, "invalid_issuance_resolution", "Request body must be JSON"); }
    const parsed = parseResolution(body);
    if (parsed.value === undefined) return error(400, "invalid_issuance_resolution", parsed.error ?? "Invalid issuance resolution");
    const input = parsed.value;
    const result = await this.ctx.storage.transaction(async (txn): Promise<{ status: number; body: unknown; changed?: boolean }> => {
      const state = await txn.get<AllocatorState>(STATE_KEY);
      if (state === undefined || state.allocatorLineageId !== input.allocatorLineageId) return { status: 409, body: { code: "issuance_lineage_mismatch", error: "Issuance lineage is not current" } };
      const obligations = await txn.get<IssuanceObligation[]>(ISSUANCE_OBLIGATIONS_KEY) ?? [];
      const index = obligations.findIndex((obligation) => obligation.attemptId === input.attemptId && obligation.candidateIndex === input.candidateIndex);
      if (index < 0) return { status: 404, body: { code: "issuance_obligation_not_found", error: "Issuance obligation was not found" } };
      const obligation = obligations[index]!;
      if (obligation.eventId !== input.eventId || obligation.suid !== input.suid) return { status: 409, body: { code: "issuance_identity_mismatch", error: "Issuance identity does not match the durable obligation" } };
      if (!obligation.targetTags.includes(input.tag)) return { status: 409, body: { code: "issuance_tag_mismatch", error: "Tag is not a required issuance participant" } };
      const installedTags = input.disposition === "installed" && !obligation.installedTags.includes(input.tag)
        ? [...obligation.installedTags, input.tag]
        : obligation.installedTags;
      const fencedTags = input.disposition === "fenced" && !obligation.fencedTags.includes(input.tag)
        ? [...obligation.fencedTags, input.tag]
        : obligation.fencedTags;
      const resolved = obligation.targetTags.every((tag) => installedTags.includes(tag) || fencedTags.includes(tag));
      const updated: IssuanceObligation = { ...obligation, installedTags, fencedTags, status: resolved ? "resolved" : "unresolved" };
      if (JSON.stringify(updated) !== JSON.stringify(obligation)) {
        const next = [...obligations]; next[index] = updated;
        await txn.put(ISSUANCE_OBLIGATIONS_KEY, next);
      }
      return { status: 200, body: updated, changed: JSON.stringify(updated) !== JSON.stringify(obligation) };
    });
    if (result.status === 200 && result.changed === true) this.closedPrefixCache = undefined;
    return json(result.body, result.status);
  }

  private async reconcileCut(request: Request): Promise<Response> {
    let body: unknown;
    try { body = await request.json<unknown>(); } catch { return error(400, "invalid_reconciliation_cut", "Request body must be JSON"); }
    const parsed = parseReconcileCut(body);
    if (parsed.value === undefined) return error(400, "invalid_reconciliation_cut", parsed.error ?? "Invalid reconciliation cut");
    const input = parsed.value;
    const result = await this.ctx.storage.transaction(async (txn): Promise<{ status: number; body: unknown }> => {
      const state = await txn.get<AllocatorState>(STATE_KEY);
      if (state === undefined || state.allocatorLineageId !== input.allocatorLineageId) return { status: 409, body: { code: "issuance_lineage_mismatch", error: "Reconciliation lineage is not current" } };
      const existingMeta = await txn.get<ClosedPrefixMeta>(CLOSED_PREFIX_META_KEY);
      const existingObligations = await txn.get<IssuanceObligation[]>(ISSUANCE_OBLIGATIONS_KEY) ?? [];
      const legacyCutRequired = state.bootstrapSeed !== null ||
        (state.allocatedWatermark !== null && (existingMeta === undefined || existingObligations.length === 0));
      if (!legacyCutRequired) return { status: 409, body: { code: "reconciliation_not_required", error: "Current allocator has no legacy cut" } };
      const current = existingObligations;
      const imported: IssuanceObligation[] = input.obligations.map((obligation) => ({
        ...obligation,
        targetTags: [...new Set(obligation.targetTags)],
        installedTags: [],
        fencedTags: [],
        allocatorLineageId: input.allocatorLineageId,
        status: "unresolved" as const,
      }));
      const all = current.length === 0 ? imported : current;
      await txn.put(ISSUANCE_OBLIGATIONS_KEY, all);
      const meta: ClosedPrefixMeta = { version: 1, allocatorLineageId: input.allocatorLineageId, migrationStatus: "reconciled", migrationProofId: input.proofId };
      await txn.put(CLOSED_PREFIX_META_KEY, meta);
      return { status: 201, body: meta };
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
): Promise<ClosedPrefixCertificate | undefined> {
  try {
    const response = await allocator.fetch(new Request("https://allocator.internal/closed-prefix"));
    if (!response.ok) return undefined;
    return await response.json<ClosedPrefixCertificate>();
  } catch {
    return undefined;
  }
}
