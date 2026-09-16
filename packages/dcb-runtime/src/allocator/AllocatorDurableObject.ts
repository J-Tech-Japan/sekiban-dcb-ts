import type {
  AllocatedCandidate,
  AllocationCandidate,
  AllocationVector,
  AllocatorState,
  ClosedPrefixCertificate,
} from "./types";
import {
  IssuanceLedgerError,
  ISSUANCE_COUNT_KEY,
  ISSUANCE_MIGRATION_KEY,
  ISSUANCE_RECOVERY_KEY,
  applyTargetResolution,
  buildCertificateSnapshot,
  completeMigrationProofInTransaction,
  pageLegacyInventoryInTransaction,
  parseCandidateMembership,
  registerIssuanceInTransaction,
  registrationProbe,
  shouldArmIssuanceRecovery,
  type IssuanceMigrationState,
  type IssuanceRecoverySchedule,
  type TargetResolutionEvidence,
} from "./IssuanceLedger";
import { reconcileIssuanceBatch } from "./IssuanceReconciler";
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
const ROLLBACK_WARNING_WINDOW_MS = 1_000n;

type JsonObject = Record<string, unknown>;

interface AllocateInput {
  attemptId: string;
  candidates: AllocationCandidate[];
  candidateMembership: ReadonlyMap<number, { tags: readonly string[]; pinnedWriterEpoch: number }>;
  faultInjection?: "between-vector-and-watermark";
  serviceId?: string;
  bootstrapCommandId?: string;
  bootstrapEpoch?: number;
}
interface SeedInput { importId: string; leaseEpoch: number; highWatermark: string; }

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

/** G32 is a fresh allocator namespace; an old durable state is never upgraded. */
function assertG32State(state: AllocatorState | undefined): void {
  if (state === undefined) return;
  if (state.schemaVersion !== 5 || !isNonEmptyString(state.allocatorLineageId)) {
    throw new SortableUniqueIdError("SUID_INVALID", "G32 allocator requires a fresh 30-digit state namespace");
  }
  if (state.allocatedWatermark !== null) assertSortableUniqueId(state.allocatedWatermark);
  if (state.bootstrapSeed !== null) assertSortableUniqueId(state.bootstrapSeed.highWatermark);
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
  const candidateMembership = new Map<number, { tags: readonly string[]; pinnedWriterEpoch: number }>();
  for (const rawCandidate of value.candidates) {
    if (
      !isObject(rawCandidate) ||
      !isNonNegativeInteger(rawCandidate.candidateIndex) ||
      !isNonEmptyString(rawCandidate.eventId)
    ) {
      return { error: "each candidate needs a non-negative candidateIndex and non-empty eventId" };
    }
    const membership = parseCandidateMembership(rawCandidate);
    if (membership !== undefined) {
      candidateMembership.set(rawCandidate.candidateIndex, membership);
    }
    candidates.push({
      candidateIndex: rawCandidate.candidateIndex,
      eventId: rawCandidate.eventId,
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

  const serviceId = isNonEmptyString(value.serviceId) ? value.serviceId : undefined;
  const bootstrapCommandId = isNonEmptyString(value.bootstrapCommandId) ? value.bootstrapCommandId : undefined;
  const bootstrapEpoch = isNonNegativeInteger(value.bootstrapEpoch) ? value.bootstrapEpoch : undefined;
  return {
    value: {
      attemptId: value.attemptId,
      candidates: ordered,
      candidateMembership,
      faultInjection,
      ...(serviceId !== undefined ? { serviceId } : {}),
      ...(bootstrapCommandId !== undefined ? { bootstrapCommandId } : {}),
      ...(bootstrapEpoch !== undefined ? { bootstrapEpoch } : {}),
    },
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

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env?: { BOOTSTRAP?: DurableObjectNamespace; TAG?: DurableObjectNamespace; ALLOCATOR?: DurableObjectNamespace },
    private readonly orderClock: OrderClock = systemOrderClock,
    private readonly nativeTracing: NativeTracing = noOpNativeTracing,
  ) {}

  async alarm(): Promise<void> {
    const serviceId = await this.serviceIdFromState();
    if (serviceId === undefined || this.env?.TAG === undefined) return;
    await reconcileIssuanceBatch(this.ctx.storage, { TAG: this.env.TAG }, serviceId, async (evidence) => {
      try {
        await this.ctx.storage.transaction(async (txn) => {
          await applyTargetResolution(txn, evidence);
        });
        return true;
      } catch {
        return false;
      }
    });
  }

  private async serviceIdFromState(): Promise<string | undefined> {
    const state = await this.ctx.storage.get<AllocatorState & { serviceId?: string }>(STATE_KEY);
    return state?.serviceId;
  }

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
    if (request.method === "GET" && url.pathname === "/__internal/g77/capabilities") {
      return json({
        issuanceLedger: true,
        certificateRoute: true,
        resolveRoute: true,
        reconcilerRoute: true,
        migrationCut: true,
        legacyInventoryRoute: true,
        migrationProofRoute: true,
        reconcileNowRoute: true,
      });
    }
    if (request.method === "GET" && url.pathname.startsWith("/__internal/g77/registration/")) {
      return this.registrationStatus(url.pathname);
    }
    if (request.method === "GET" && url.pathname === "/__internal/g77/certificate") {
      return this.certificateSnapshot(request);
    }
    if (request.method === "POST" && url.pathname === "/__internal/g77/resolve-target") {
      return this.resolveTarget(request);
    }
    if (request.method === "POST" && url.pathname === "/__internal/g77/migration-cut") {
      return this.installMigrationCut(request);
    }
    if (request.method === "POST" && url.pathname === "/__internal/g77/legacy-inventory-page") {
      return this.pageLegacyInventory(request);
    }
    if (request.method === "POST" && url.pathname === "/__internal/g77/migration-proof") {
      return this.completeMigrationProof(request);
    }
    if (request.method === "POST" && url.pathname === "/__internal/g77/reconcile-now") {
      return this.reconcileNow();
    }
    return error(404, "allocator_route_not_found", "Allocator route was not found");
  }

  private async registrationStatus(pathname: string): Promise<Response> {
    const parts = pathname.split("/");
    const candidateIndex = Number(parts.at(-1));
    const attemptId = decodeURIComponent(parts.at(-2) ?? "");
    if (!isNonEmptyString(attemptId) || !Number.isInteger(candidateIndex)) {
      return error(400, "invalid_registration_probe", "Invalid registration probe path");
    }
    const probe = await this.ctx.storage.transaction(async (txn) =>
      registrationProbe(txn, attemptId, candidateIndex));
    return json(probe);
  }

  private async certificateSnapshot(request: Request): Promise<Response> {
    const serviceId = new URL(request.url).searchParams.get("serviceId");
    if (!isNonEmptyString(serviceId)) {
      return error(400, "invalid_certificate_request", "serviceId is required");
    }
    try {
      const certificate = await this.ctx.storage.transaction(async (txn) => {
        const state = await txn.get<AllocatorState>(STATE_KEY);
        if (state === undefined) throw new IssuanceLedgerError("allocator state missing");
        return buildCertificateSnapshot(txn, txn, {
          serviceId,
          allocatorLineageId: state.allocatorLineageId,
          allocatedWatermark: state.allocatedWatermark,
          generatedAt: Date.now(),
        });
      });
      return json(certificate satisfies ClosedPrefixCertificate);
    } catch (failure) {
      if (failure instanceof IssuanceLedgerError) {
        return error(409, "certificate_unavailable", failure.message);
      }
      return error(500, "certificate_failure", "Certificate snapshot failed");
    }
  }

  private async resolveTarget(request: Request): Promise<Response> {
    let body: unknown;
    try { body = await request.json(); } catch { return error(400, "invalid_resolution", "JSON required"); }
    if (!isObject(body)) return error(400, "invalid_resolution", "Invalid resolution body");
    const evidence = body as unknown as TargetResolutionEvidence;
    try {
      const result = await this.ctx.storage.transaction(async (txn) =>
        applyTargetResolution(txn, evidence));
      return json(result);
    } catch (failure) {
      if (failure instanceof IssuanceLedgerError) {
        return error(409, "resolution_rejected", failure.message);
      }
      return error(500, "resolution_failure", "Target resolution failed");
    }
  }

  private async pageLegacyInventory(request: Request): Promise<Response> {
    let body: unknown;
    try { body = await request.json(); } catch { return error(400, "invalid_inventory_page", "JSON required"); }
    const pageSize = isObject(body) && typeof body.pageSize === "number" ? body.pageSize : 8;
    const faultInjection = isObject(body) && body.faultInjection === "after-cursor-persist"
      ? "after-cursor-persist" as const
      : undefined;
    try {
      const result = await this.ctx.storage.transaction(async (txn) =>
        pageLegacyInventoryInTransaction(txn, { pageSize, faultInjection }));
      return json(result);
    } catch (failure) {
      if (failure instanceof IssuanceLedgerError) {
        return error(503, "inventory_page_crash", failure.message);
      }
      return error(500, "inventory_page_failure", "Legacy inventory page failed");
    }
  }

  private async completeMigrationProof(request: Request): Promise<Response> {
    let body: unknown;
    try { body = await request.json(); } catch { return error(400, "invalid_migration_proof", "JSON required"); }
    if (!isObject(body) || !isNonEmptyString(body.migrationProofId)) {
      return error(400, "invalid_migration_proof", "migrationProofId is required");
    }
    const boundEvidence = isObject(body.boundEvidence) ? body.boundEvidence : {};
    try {
      await this.ctx.storage.transaction(async (txn) =>
        completeMigrationProofInTransaction(txn, {
          migrationProofId: body.migrationProofId as string,
          boundEvidence,
        }));
      return json({ completed: true, migrationProofId: body.migrationProofId });
    } catch (failure) {
      if (failure instanceof IssuanceLedgerError) {
        return error(409, "migration_proof_rejected", failure.message);
      }
      return error(500, "migration_proof_failure", "Migration proof completion failed");
    }
  }

  private async reconcileNow(): Promise<Response> {
    const serviceId = await this.serviceIdFromState();
    if (serviceId === undefined || this.env?.TAG === undefined) {
      return error(409, "reconcile_unavailable", "Reconciliation prerequisites are unavailable");
    }
    const result = await reconcileIssuanceBatch(this.ctx.storage, { TAG: this.env.TAG }, serviceId, async (evidence) => {
      try {
        await this.ctx.storage.transaction(async (txn) => {
          await applyTargetResolution(txn, evidence);
        });
        return true;
      } catch {
        return false;
      }
    });
    return json(result);
  }

  private async installMigrationCut(request: Request): Promise<Response> {
    let body: unknown;
    try { body = await request.json(); } catch { return error(400, "invalid_migration_cut", "JSON required"); }
    const cutAt = isObject(body) && typeof body.cutAt === "number" ? body.cutAt : Date.now();
    await this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<IssuanceMigrationState>(ISSUANCE_MIGRATION_KEY);
      if (existing !== undefined) return;
      await txn.put(ISSUANCE_MIGRATION_KEY, {
        cutInstalledAt: cutAt,
        legacyInventoryCursor: null,
        inventoryComplete: false,
        migrationProofId: null,
      } satisfies IssuanceMigrationState);
      const existingCount = await txn.get<number>(ISSUANCE_COUNT_KEY);
      if (existingCount === undefined || existingCount === null) {
        await txn.put(ISSUANCE_COUNT_KEY, 0);
      }
    });
    return json({ installed: true, cutAt });
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
    if (
      input.serviceId !== undefined &&
      input.bootstrapCommandId !== undefined &&
      input.bootstrapEpoch !== undefined &&
      this.env?.BOOTSTRAP !== undefined
    ) {
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
          candidates,
          // Diagnostic presentation only; ordering is the ordinal above.
          allocatedAt: diagnosticAllocatedAt(range.base),
        };
        const migration = await txn.get<IssuanceMigrationState>(ISSUANCE_MIGRATION_KEY);
        if (migration !== undefined && input.candidateMembership.size === 0) {
          throw new IssuanceLedgerError("post-cut allocation requires canonical target membership");
        }
        const updatedState: AllocatorState = {
          schemaVersion: 5,
          allocatorLineageId: lineage,
          allocatedWatermark: range.watermark,
          bootstrapSeed: state.bootstrapSeed ?? null,
          lastRollbackWarningFingerprint: shouldWarn ? warningFingerprint : state.lastRollbackWarningFingerprint ?? null,
          ...(input.serviceId !== undefined ? { serviceId: input.serviceId } : state.serviceId !== undefined ? { serviceId: state.serviceId } : {}),
        };

        await txn.put(attemptKey(input.attemptId), vector);
        if (input.candidateMembership.size > 0 && input.serviceId !== undefined) {
          await registerIssuanceInTransaction(txn, {
            serviceId: input.serviceId,
            allocatorLineageId: lineage,
            attemptId: input.attemptId,
            candidates,
            candidateMembership: input.candidateMembership,
            migration,
          });
        }
        if (input.faultInjection === "between-vector-and-watermark") {
          throw new AllocationTransactionFault("Simulated interruption before transaction commit");
        }
        await txn.put(STATE_KEY, updatedState);
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
      if (result.rollbackWarning !== undefined) {
        try {
          console.warn(JSON.stringify({ type: "allocator_clock_rollback", ...result.rollbackWarning }));
        } catch {
          // Warning transport is observational; it must never change the
          // already committed allocation result.
        }
      }
      if (result.created && input.candidateMembership.size > 0) {
        const schedule = await this.ctx.storage.get<IssuanceRecoverySchedule>(ISSUANCE_RECOVERY_KEY);
        const now = Date.now();
        if (shouldArmIssuanceRecovery(schedule, now)) {
          await this.ctx.storage.setAlarm(now);
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
      if (failure instanceof IssuanceLedgerError) {
        return error(400, "issuance_registration_rejected", failure.message);
      }
      return error(500, "allocator_failure", "Allocator could not persist the full allocation vector");
    }
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
      await txn.put(STATE_KEY, updated); return { status: 201, body: updated };
    });
    return json(result.body, result.status);
  }
}
