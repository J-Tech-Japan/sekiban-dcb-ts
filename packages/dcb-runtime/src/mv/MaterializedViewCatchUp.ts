import type { MaterializedViewRowMaterializer } from "@sekiban/dcb-core";
import type { ClosedPrefixCertificate } from "../allocator/types";
import { safeWindowCeilingExceeded, safeWindowMs } from "../projection/ProjectionRuntime";
import type { ProjectionStore, StoredEvent } from "../store/types";
import { assertSortableUniqueId } from "../allocator/SortableUniqueId";
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
  /** Bounded late-lower detector query cost for this catch-up pass. */
  readonly lateLowerQueryDurationMs: number;
  readonly indeterminate: boolean;
  /** The first source event withheld by the current safe-lane boundary. */
  readonly deferredEventSuid: string | null;
  readonly deferredEventLastArrivedAt: number | null;
  readonly deferredDeadlineAt: number | null;
  readonly stopReason: "safe_window_fence" | "safe_window_ceiling" | "frontier_fence" | "issuance_fence" | null;
}

export interface MaterializedViewCatchUpHooks {
  /** Test-only crash boundary; never part of production persistence. */
  readonly beforeApply?: (event: StoredEvent) => Promise<void> | void;
  /** Test-only crash boundary after the atomic MV call. */
  readonly afterApply?: (event: StoredEvent, result: MaterializedViewApplyResult) => Promise<void> | void;
}

/**
 * An optional scanner-proven high-water mark for a safe-lane pass. `null`
 * means that no FULL snapshot exists yet, so this pass may perform GC but
 * cannot advance a source checkpoint. `undefined` retains the existing
 * ungated caller behaviour.
 */
export interface MaterializedViewCatchUpOptions {
  readonly maximumSuid?: string | null;
  /** Allocator-issued closed-prefix certificate; null is fail-closed. */
  readonly closedPrefixSuid?: string | null;
  /** The complete certificate that authorizes the supplied closedPrefixSuid. */
  readonly closedPrefixCertificate?: ClosedPrefixCertificate;
  /** Run the bounded late-lower detector only from scheduled maintenance. */
  readonly runOrderingDetector?: boolean;
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
    options: MaterializedViewCatchUpOptions = {},
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
    return this.follow(serviceId, materializer, nowMs, hooks, options);
  }

  async follow<TEvent = StoredEvent>(
    serviceId: string,
    materializer: MaterializedViewRowMaterializer<TEvent>,
    nowMs: number,
    hooks: MaterializedViewCatchUpHooks = {},
    options: MaterializedViewCatchUpOptions = {},
  ): Promise<MaterializedViewCatchUpResult> {
    const active = await this.materializedViews.readActive(serviceId, materializer.id);
    if (active === undefined) {
      throw new MaterializedViewStoreError("apply", "MV_INSTANCE_MISSING", "Materialized-view must be built before follow");
    }
    return this.followGeneration(serviceId, materializer, active.generation, nowMs, "apply", hooks, options);
  }

  async rebuild<TEvent = StoredEvent>(
    serviceId: string,
    materializer: MaterializedViewRowMaterializer<TEvent>,
    nowMs: number,
    rebuildId?: string,
    hooks: MaterializedViewCatchUpHooks = {},
    options: MaterializedViewCatchUpOptions = {},
  ): Promise<MaterializedViewCatchUpResult & { readonly candidateGeneration: number; readonly rebuildId?: string }> {
    const effectiveRebuildId = rebuildId ?? `g69-rebuild-${crypto.randomUUID()}`;
    const sourceBefore = await this.source.readAllEvents(serviceId, "");
    const sourceBeforeProof = await sourceHistoryProof(sourceBefore);
    const candidate = await this.materializedViews.beginRebuild({
      serviceId,
      viewId: materializer.id,
      definitionVersion: materializer.version,
      updatedAt: nowMs,
    });
    const result = await this.followGeneration(serviceId, materializer, candidate.generation, nowMs, "apply", hooks, options);
    const sourceAfter = await this.source.readAllEvents(serviceId, "");
    const sourceAfterProof = await sourceHistoryProof(sourceAfter);
    if (
      result.stopReason === null &&
      !result.indeterminate &&
      result.advancedSourceEvents === sourceBefore.length &&
      sourceBeforeProof.digest === sourceAfterProof.digest
    ) {
      await this.materializedViews.markGenerationRebuilt({
        serviceId,
        viewId: materializer.id,
        generation: candidate.generation,
        verifiedAt: nowMs,
        rebuildId: effectiveRebuildId,
        sourceEventCount: sourceBeforeProof.eventIds.length,
        sourceEventIds: sourceBeforeProof.eventIds,
        sourceSuids: sourceBeforeProof.suids,
        sourceMaxSuid: sourceBeforeProof.maxSuid,
        sourceHistoryDigest: sourceBeforeProof.digest,
      });
    }
    return { ...result, candidateGeneration: candidate.generation, rebuildId: effectiveRebuildId };
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
    options: MaterializedViewCatchUpOptions,
  ): Promise<MaterializedViewCatchUpResult> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
      const certifiedClosedPrefixSuid = options.closedPrefixCertificate === undefined
        ? options.closedPrefixSuid
        : options.closedPrefixCertificate.status === "ready"
          ? options.closedPrefixCertificate.closedPrefixSuid
          : null;
      if (
        options.closedPrefixCertificate !== undefined &&
        options.closedPrefixSuid !== undefined &&
        options.closedPrefixSuid !== certifiedClosedPrefixSuid
      ) {
        throw new MaterializedViewStoreError("apply", "MV_STORE_OPERATION_FAILED", "ordering_certificate_mismatch");
      }
      const instance = await this.materializedViews.readInstance(serviceId, materializer.id, generation);
      if (instance === undefined) {
        throw new MaterializedViewStoreError("apply", "MV_INSTANCE_MISSING", "Materialized-view generation is missing");
      }
      // `readAllEvents(serviceId, checkpoint)` is empty both for a caught-up
      // source and for a reset source that is now behind the checkpoint. Read
      // the source head separately so the latter can never freeze silently.
      const sourceForHead = await this.source.readAllEvents(serviceId, "");
      for (const event of sourceForHead) assertSortableUniqueId(event.suid);
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
          lateLowerQueryDurationMs: 0,
          indeterminate: true,
          deferredEventSuid: null,
          deferredEventLastArrivedAt: null,
          deferredDeadlineAt: null,
          stopReason: "safe_window_ceiling",
        };
      }
      const sourceEvents = await this.source.readAllEvents(serviceId, instance.lastSuid);
      await this.assertSourceBatchOrder(
        serviceId,
        materializer.id,
        generation,
        instance.lastSuid,
        sourceEvents,
      );
      let lateLowerQueryDurationMs = 0;
      if (options.runOrderingDetector === true) {
        lateLowerQueryDurationMs = await this.detectLateLowerSuid(
          serviceId,
          materializer.id,
          generation,
          instance.lastSuid,
          instance.updatedAt,
        );
      }
      let current = instance;
      let advancedSourceEvents = 0;
      let appliedEvents = 0;
      let conflicted = false;
      for (const event of sourceEvents) {
        if (certifiedClosedPrefixSuid === null || (
          certifiedClosedPrefixSuid !== undefined && compareSuid(event.suid, certifiedClosedPrefixSuid) > 0
        )) {
          return {
            instance: current,
            dynamicLagBoundMs,
            safeWindowMs: windowMs,
            advancedSourceEvents,
            appliedEvents,
            lateLowerQueryDurationMs,
            indeterminate: false,
            deferredEventSuid: event.suid,
            deferredEventLastArrivedAt: event.lastArrivedAt,
            deferredDeadlineAt: null,
            stopReason: "issuance_fence",
          };
        }
        // A G44 BLOCK tick may drain only through the last FULL snapshot's
        // high-water mark.  Do not skip an earlier row or treat a later one
        // as a new safe frontier; either would violate the source ordering
        // proof that protects the materialized safe lane.
        if (options.maximumSuid === null || (
          options.maximumSuid !== undefined && compareSuid(event.suid, options.maximumSuid) > 0
        )) {
          return {
            instance: current,
            dynamicLagBoundMs,
            safeWindowMs: windowMs,
            advancedSourceEvents,
            appliedEvents,
            lateLowerQueryDurationMs,
            indeterminate: false,
            deferredEventSuid: event.suid,
            deferredEventLastArrivedAt: event.lastArrivedAt,
            deferredDeadlineAt: null,
            stopReason: "frontier_fence",
          };
        }
        // Read-only SafeWindow rule: do not skip the first unsafe event or
        // process later events ahead of a late lower SUID.
        if (event.lastArrivedAt > nowMs - windowMs) {
          return {
            instance: current,
            dynamicLagBoundMs,
            safeWindowMs: windowMs,
            advancedSourceEvents,
            appliedEvents,
            lateLowerQueryDurationMs,
            indeterminate: false,
            deferredEventSuid: event.suid,
            deferredEventLastArrivedAt: event.lastArrivedAt,
            deferredDeadlineAt: event.lastArrivedAt + windowMs,
            stopReason: "safe_window_fence",
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
            // The durable schema represents an unadvanced checkpoint as an
            // empty string, while the atomic apply port reserves `null` for
            // that state so all non-null ingress values are full G32 SUIDs.
            expectedLastSuid: current.lastSuid.length === 0 ? null : current.lastSuid,
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
          lateLowerQueryDurationMs,
          indeterminate: false,
          deferredEventSuid: null,
          deferredEventLastArrivedAt: null,
          deferredDeadlineAt: null,
          stopReason: null,
        };
      }
    }
    throw new MaterializedViewStoreError("apply", "MV_CAS_MISMATCH", "Materialized-view catch-up did not converge after concurrent updates");
  }

  private async detectLateLowerSuid(
    serviceId: string,
    viewId: string,
    generation: number,
    priorSuid: string,
    checkpointUpdatedAt: number,
  ): Promise<number> {
    let lateLowerQueryDurationMs = 0;
    if (priorSuid.length > 0) {
      const detectorStartedAt = Date.now();
      const evidence = this.source.findLateLowerSuidEvidence === undefined
        ? undefined
        : await this.source.findLateLowerSuidEvidence(serviceId, priorSuid, checkpointUpdatedAt, generation);
      const lateLower = evidence === undefined
        ? await this.source.findLateLowerSuid?.(serviceId, priorSuid, checkpointUpdatedAt)
        : evidence.kind === "late-lower-suid" ? evidence.event : undefined;
      lateLowerQueryDurationMs = evidence?.durationMs ?? Math.max(0, Date.now() - detectorStartedAt);
      if (evidence?.kind === "unknown") {
        const incident = {
          serviceId,
          identityKey: `ORDERING_DETECTOR_UNKNOWN|${serviceId}|${viewId}|${generation}|${priorSuid}|${checkpointUpdatedAt}`,
          classification: "ORDERING_DETECTOR_UNKNOWN" as const,
          suid: priorSuid,
          observedAt: checkpointUpdatedAt,
        };
        // The detector has not proved a bounded refusal condition. Persist an
        // alarm-only incident and continue the existing safe-lane path; an
        // unknown clock/provenance observation must never be promoted to a
        // fabricated ordering violation or a guessed quarantine.
        await this.source.appendDeliveryIncident(incident);
        console.error("SDT-G69_ORDERING_DETECTOR_UNKNOWN", JSON.stringify({
          ...incident,
          reason: evidence.reason ?? "unknown",
        }));
      }
      if (lateLower !== undefined) {
        const incident = {
          serviceId,
          identityKey: `LATE_LOWER_SUID|${serviceId}|${viewId}|${priorSuid}|${lateLower.suid}|${lateLower.eventId}`,
          classification: "ORDER_VIOLATION" as const,
          suid: lateLower.suid,
          eventId: lateLower.eventId,
          incomingEventId: lateLower.eventId,
          observedAt: lateLower.lastArrivedAt,
        };
        await this.source.appendDeliveryIncident(incident);
        await this.materializedViews.recordOrderingQuarantine({
          serviceId,
          viewId,
          generation,
          checkpointSuid: priorSuid,
          lateSuid: lateLower.suid,
          eventId: lateLower.eventId,
          classification: "LATE_LOWER_SUID",
          observedAt: lateLower.lastArrivedAt,
        });
        console.error("SDT-G69_ORDERING_QUARANTINE", JSON.stringify({
          serviceId,
          viewId,
          generation,
          checkpointSuid: priorSuid,
          lateSuid: lateLower.suid,
          eventId: lateLower.eventId,
          classification: "LATE_LOWER_SUID",
        }));
        throw new MaterializedViewStoreError(
          "apply",
          "MV_ORDERING_QUARANTINED",
          "Materialized-view safe lane is quarantined for an ordering violation; rebuild and promote a generation",
        );
      }
    }
    return lateLowerQueryDurationMs;
  }

  private async assertSourceBatchOrder(
    serviceId: string,
    viewId: string,
    generation: number,
    priorSuid: string,
    events: readonly StoredEvent[],
  ): Promise<void> {
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
        await this.materializedViews.recordOrderingQuarantine({
          serviceId,
          viewId,
          generation,
          checkpointSuid: previous,
          lateSuid: event.suid,
          eventId: event.eventId,
          classification: "ORDER_VIOLATION",
          observedAt: event.lastArrivedAt,
        });
        console.error("SDT-G69_ORDERING_QUARANTINE", JSON.stringify({
          serviceId,
          viewId,
          generation,
          checkpointSuid: previous,
          lateSuid: event.suid,
          eventId: event.eventId,
          classification: "ORDER_VIOLATION",
        }));
        throw new MaterializedViewStoreError(
          "apply",
          "MV_ORDERING_QUARANTINED",
          "Materialized-view safe lane is quarantined for an ordering violation; rebuild and promote a generation",
        );
      }
      previous = event.suid;
    }
  }
}

async function sourceHistoryProof(events: readonly StoredEvent[]): Promise<{
  readonly eventIds: string[];
  readonly suids: string[];
  readonly maxSuid: string;
  readonly digest: string;
}> {
  const eventIds = events.map((event) => event.eventId);
  const suids = events.map((event) => event.suid);
  const maxSuid = events.reduce(
    (maximum, event) => maximum === "" || compareSuid(event.suid, maximum) > 0 ? event.suid : maximum,
    "",
  );
  const canonical = events.map((event) => `${event.eventId}\u0000${event.suid}`).join("\n");
  const digestBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const digest = [...new Uint8Array(digestBytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
  return { eventIds, suids, maxSuid, digest };
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
