import type { MaterializedViewRowMaterializer } from "@sekiban/dcb-core";
import { safeWindowCeilingExceeded, safeWindowMs } from "../projection/ProjectionRuntime";
import type { ProjectionStore, StoredEvent } from "../store/types";
import {
  MaterializedViewCasError,
  MaterializedViewStoreError,
  type MaterializedViewApplyResult,
  type MaterializedViewInstance,
} from "./MaterializedViewStore";
import type { D1MaterializedViewStore } from "./MaterializedViewStore";

const MAX_CAS_RETRIES = 8;

export interface MaterializedViewCatchUpResult {
  readonly instance: MaterializedViewInstance;
  readonly dynamicLagBoundMs: number;
  readonly safeWindowMs: number;
  readonly advancedSourceEvents: number;
  readonly appliedEvents: number;
  readonly indeterminate: boolean;
}

export interface MaterializedViewCatchUpHooks {
  /** Test-only crash boundary; never part of production persistence. */
  readonly beforeApply?: (event: StoredEvent) => Promise<void> | void;
  /** Test-only crash boundary after the atomic MV call. */
  readonly afterApply?: (event: StoredEvent, result: MaterializedViewApplyResult) => Promise<void> | void;
}

/**
 * SafeWindow-aware row materializer runtime.  It keeps the memory projection
 * runtime untouched while allowing the same event source to feed a separate
 * D1 MV database.
 */
export class MaterializedViewCatchUpRuntime {
  constructor(
    private readonly source: ProjectionStore,
    private readonly materializedViews: D1MaterializedViewStore,
  ) {}

  async build<TEvent = StoredEvent>(
    serviceId: string,
    materializer: MaterializedViewRowMaterializer<TEvent>,
    nowMs: number,
    hooks: MaterializedViewCatchUpHooks = {},
  ): Promise<MaterializedViewCatchUpResult> {
    const existing = await this.materializedViews.readActive(serviceId, materializer.id);
    if (existing !== undefined) {
      throw new MaterializedViewStoreError("create-active", "MV_INSTANCE_EXISTS", "Active materialized view already exists");
    }
    await this.materializedViews.createActive({
      serviceId,
      viewId: materializer.id,
      generation: 0,
      definitionVersion: materializer.version,
      updatedAt: nowMs,
    });
    return this.follow(serviceId, materializer, nowMs, hooks);
  }

  async follow<TEvent = StoredEvent>(
    serviceId: string,
    materializer: MaterializedViewRowMaterializer<TEvent>,
    nowMs: number,
    hooks: MaterializedViewCatchUpHooks = {},
  ): Promise<MaterializedViewCatchUpResult> {
    const active = await this.materializedViews.readActive(serviceId, materializer.id);
    if (active === undefined) {
      throw new MaterializedViewStoreError("apply", "MV_INSTANCE_MISSING", "Materialized-view must be built before follow");
    }
    return this.followGeneration(serviceId, materializer, active.generation, nowMs, "apply", hooks);
  }

  async rebuild<TEvent = StoredEvent>(
    serviceId: string,
    materializer: MaterializedViewRowMaterializer<TEvent>,
    nowMs: number,
    rebuildId?: string,
    hooks: MaterializedViewCatchUpHooks = {},
  ): Promise<MaterializedViewCatchUpResult & { readonly candidateGeneration: number; readonly rebuildId?: string }> {
    const candidate = await this.materializedViews.beginRebuild({
      serviceId,
      viewId: materializer.id,
      definitionVersion: materializer.version,
      updatedAt: nowMs,
    });
    const result = await this.followGeneration(serviceId, materializer, candidate.generation, nowMs, "apply", hooks);
    return { ...result, candidateGeneration: candidate.generation, rebuildId };
  }

  async promote(
    serviceId: string,
    materializer: MaterializedViewRowMaterializer,
    candidateGeneration: number,
    nowMs: number,
  ): Promise<MaterializedViewInstance> {
    const active = await this.materializedViews.readActive(serviceId, materializer.id);
    return this.materializedViews.promoteGeneration({
      serviceId,
      viewId: materializer.id,
      candidateGeneration,
      expectedActiveGeneration: active?.generation ?? null,
      updatedAt: nowMs,
    });
  }

  async read(serviceId: string, materializer: MaterializedViewRowMaterializer): Promise<{
    readonly instance: MaterializedViewInstance;
    readonly rows: Awaited<ReturnType<D1MaterializedViewStore["readRows"]>>;
  } | undefined> {
    const instance = await this.materializedViews.readActive(serviceId, materializer.id);
    if (instance === undefined) return undefined;
    return { instance, rows: await this.materializedViews.readRows(serviceId, materializer.id, instance.generation) };
  }

  private async followGeneration<TEvent>(
    serviceId: string,
    materializer: MaterializedViewRowMaterializer<TEvent>,
    generation: number,
    nowMs: number,
    _operation: "apply",
    hooks: MaterializedViewCatchUpHooks,
  ): Promise<MaterializedViewCatchUpResult> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
      const instance = await this.materializedViews.readInstance(serviceId, materializer.id, generation);
      if (instance === undefined) {
        throw new MaterializedViewStoreError("apply", "MV_INSTANCE_MISSING", "Materialized-view generation is missing");
      }
      // `readAllEvents(serviceId, checkpoint)` is empty both for a caught-up
      // source and for a reset source that is now behind the checkpoint. Read
      // the source head separately so the latter can never freeze silently.
      const sourceForHead = await this.source.readAllEvents(serviceId, "");
      const storeMaxSuid = sourceForHead.reduce(
        (maximum, event) => compareSuid(maximum, event.suid) >= 0 ? maximum : event.suid,
        "",
      );
      if (instance.lastSuid.length > 0 && compareSuid(storeMaxSuid, instance.lastSuid) < 0) {
        await this.materializedViews.recordCheckpointAhead({
          serviceId,
          viewId: materializer.id,
          generation,
          checkpointSuid: instance.lastSuid,
          storeMaxSuid,
          observedAt: nowMs,
        });
        throw new MaterializedViewStoreError(
          "apply",
          "MV_STORE_OPERATION_FAILED",
          "CHECKPOINT_AHEAD: materialized-view checkpoint is ahead of the source store; rebuild and promote a generation",
        );
      }
      const dynamicLagBoundMs = await this.source.currentLagBound(serviceId, nowMs);
      const windowMs = safeWindowMs(dynamicLagBoundMs);
      if (safeWindowCeilingExceeded(dynamicLagBoundMs)) {
        return {
          instance,
          dynamicLagBoundMs,
          safeWindowMs: windowMs,
          advancedSourceEvents: 0,
          appliedEvents: 0,
          indeterminate: true,
        };
      }
      const sourceEvents = await this.source.readAllEvents(serviceId, instance.lastSuid);
      await this.assertStrictOrder(serviceId, materializer.id, instance.lastSuid, sourceEvents);
      let current = instance;
      let advancedSourceEvents = 0;
      let appliedEvents = 0;
      let conflicted = false;
      for (const event of sourceEvents) {
        // Read-only SafeWindow rule: do not skip the first unsafe event or
        // process later events ahead of a late lower SUID.
        if (event.lastArrivedAt > nowMs - windowMs) {
          return {
            instance: current,
            dynamicLagBoundMs,
            safeWindowMs: windowMs,
            advancedSourceEvents,
            appliedEvents,
            indeterminate: false,
          };
        }
        await hooks.beforeApply?.(event);
        const mutations = materializer.plan(event as unknown as TEvent);
        let result: MaterializedViewApplyResult;
        try {
          result = await this.materializedViews.applyMutationsAndAdvanceCheckpoint({
            serviceId,
            viewId: materializer.id,
            generation,
            expectedLastSuid: current.lastSuid,
            lastSuid: event.suid,
            definitionVersion: materializer.version,
            updatedAt: nowMs,
            mutations,
          });
        } catch (error) {
          if (error instanceof MaterializedViewCasError) {
            conflicted = true;
            break;
          }
          throw error;
        }
        current = result.instance;
        advancedSourceEvents += 1;
        appliedEvents += 1;
        // A safe checkpoint alone cannot retire unsafe marker state.  The
        // exact matching receipt is observed in its own guarded transaction.
        const unsafe = this.materializedViews.unsafeWindow();
        if (await unsafe.hasTargetReceipt(serviceId, materializer.id, event.eventId, event.suid)) {
          await unsafe.observeSafeReceipt(serviceId, materializer.id, generation, event.eventId, event.suid);
        }
        await hooks.afterApply?.(event, result);
      }
      if (!conflicted) {
        // This runs even when sourceEvents is empty: a previous unsafe write
        // may only become collectable after the safe checkpoint is observed.
        await this.materializedViews.collectUnsafeGarbage(
          serviceId,
          materializer.id,
          generation,
          materializer.version,
          current.lastSuid,
        );
        return {
          instance: current,
          dynamicLagBoundMs,
          safeWindowMs: windowMs,
          advancedSourceEvents,
          appliedEvents,
          indeterminate: false,
        };
      }
    }
    throw new MaterializedViewStoreError("apply", "MV_CAS_MISMATCH", "Materialized-view catch-up did not converge after concurrent updates");
  }

  private async assertStrictOrder(serviceId: string, viewId: string, priorSuid: string, events: readonly StoredEvent[]): Promise<void> {
    let previous = priorSuid;
    for (const event of events) {
      if (compareSuid(previous, event.suid) >= 0) {
        const incident = {
          serviceId,
          identityKey: `ORDER_VIOLATION|${serviceId}|${viewId}|${previous}|${event.suid}|${event.eventId}`,
          classification: "ORDER_VIOLATION" as const,
          suid: event.suid,
          eventId: event.eventId,
          incomingEventId: event.eventId,
          observedAt: event.lastArrivedAt,
        };
        await this.source.appendDeliveryIncident(incident);
        throw new MaterializedViewStoreError("apply", "MV_STORE_OPERATION_FAILED", "Materialized-view source was not strictly SUID ordered");
      }
      previous = event.suid;
    }
  }
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
