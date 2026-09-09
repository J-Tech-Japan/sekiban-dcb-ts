import type { TagEvent } from "../tag/types";
import type { ClosedPrefixCertificate } from "../allocator/types";
import type { DeliveryIncident, ProjectionCheckpoint, ProjectionStore, StoredEvent } from "../store/types";
import {
  DEPLOYED_PROJECTOR_REGISTRY,
  type ProjectionEvent,
  projectionEventFromTagEvent,
  type ProjectorRegistry,
  type TagStateIdentity,
  type TagStateProjector,
} from "./ProjectorRegistry";
import {
  decayedLagEstimateMs,
  MAX_PUBLISHED_SAFE_WINDOW_MS,
  PUBLISHED_SAFE_WINDOW_MS,
  safeWindowCeilingExceeded,
  safeWindowCutoffSuid,
  isSortableUniqueIdSafeAt,
  safeWindowMs,
} from "../safeWindow";
import { assertSortableUniqueId } from "../allocator/SortableUniqueId";

/** Published V1 read-side SafeWindow. It never authorizes a commit. */
export {
  MAX_PUBLISHED_SAFE_WINDOW_MS,
  PUBLISHED_SAFE_WINDOW_MS,
  safeWindowCeilingExceeded,
  safeWindowCutoffSuid,
  safeWindowMs,
};

const MAX_CHECKPOINT_CAS_RETRIES = 8;
/**
 * Live projection identities have independent checkpoints. A bounded worker
 * pool prevents a large retained tag set from monopolizing one cron
 * invocation while keeping D1/CAS pressure finite and deterministic.
 */
export const MAX_LIVE_PROJECTION_CONCURRENCY = 8;

export interface ProjectedTagState {
  payload: string;
  version: number;
  stateJson: string;
}

export interface CatchUpHooks {
  /** Test-only crash boundary before the state/checkpoint transaction. */
  beforeCheckpoint?(event: StoredEvent, checkpoint: ProjectionCheckpoint): Promise<void> | void;
  /** Test-only crash boundary after the state/checkpoint transaction. */
  afterCheckpoint?(event: StoredEvent, checkpoint: ProjectionCheckpoint): Promise<void> | void;
}

/**
 * Optional scanner-proven high-water mark for a scheduled live-projection
 * pass. `null` means that no settled frontier exists, so the pass may run
 * and observe projection state but cannot advance a source checkpoint.
 * `undefined` retains the ordinary unbounded caller behaviour used by a
 * proven FULL scan and by on-demand operator reads.
 */
export interface ProjectionCatchUpOptions {
  readonly maximumSuid?: string | null;
  /** Allocator-issued closed-prefix certificate; null is fail-closed. */
  readonly closedPrefixSuid?: string | null;
  /** The complete certificate that authorizes the supplied closedPrefixSuid. */
  readonly closedPrefixCertificate?: ClosedPrefixCertificate;
}

export interface CatchUpResult {
  /** Registered projector and tag identity for scheduled-poll diagnostics. */
  readonly projectorId: string;
  readonly tag: string;
  checkpoint: ProjectionCheckpoint | undefined;
  dynamicLagBoundMs: number;
  safeWindowMs: number;
  /** True means the published 120s ceiling was exceeded; no source event was advanced. */
  indeterminate: boolean;
  advancedSourceEvents: number;
  appliedEvents: number;
}

function compareSuid(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const shared = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return leftBytes.length - rightBytes.length;
}

function orderViolationIncident(serviceId: string, event: StoredEvent, previousSuid: string): DeliveryIncident {
  return {
    serviceId,
    identityKey: `ORDER_VIOLATION|${serviceId}|${previousSuid}|${event.suid}|${event.eventId}`,
    classification: "ORDER_VIOLATION",
    suid: event.suid,
    eventId: event.eventId,
    observedAt: event.lastArrivedAt,
  };
}

function stateFromCheckpoint(projector: TagStateProjector, checkpoint: ProjectionCheckpoint | undefined): unknown {
  return checkpoint === undefined ? projector.initialState() : projector.deserializeState(checkpoint.stateJson);
}

function projectionEventFromStored(event: StoredEvent): ProjectionEvent {
  assertSortableUniqueId(event.suid);
  return {
    eventId: event.eventId,
    suid: event.suid,
    payload: event.payload,
    eventTags: event.eventTags,
    eventType: event.eventType,
    provenance: "g32",
  };
}

function checkpointFor(
  serviceId: string,
  projectionId: string,
  event: StoredEvent,
  state: unknown,
  projector: TagStateProjector,
  updatedAt: number,
): ProjectionCheckpoint {
  return {
    serviceId,
    projectionId,
    lastSuid: event.suid,
    stateJson: projector.serializeState(state),
    version: projector.version(state),
    updatedAt,
  };
}

export function projectionIdFor(identity: TagStateIdentity): string {
  return `tag-state:${identity.tagGroup}:${identity.tagContent}:${identity.tagProjector}`;
}

export { decayedLagEstimateMs };

/**
 * Deterministically rebuilds one tag-state from the Tag DO's authoritative
 * durable event list. This is the on-demand §5.3 catch-up path; it does not
 * mutate the read-side SafeWindow checkpoint.
 */
export function catchUpDurableTagState(projector: TagStateProjector, events: readonly TagEvent[]): ProjectedTagState {
  const ordered = events.map(projectionEventFromTagEvent).sort((left, right) => compareSuid(left.suid, right.suid));
  let state = projector.initialState();
  let previousSuid: string | undefined;
  for (const event of ordered) {
    if (previousSuid !== undefined && compareSuid(previousSuid, event.suid) >= 0) {
      throw new Error("Durable tag event history was not strictly SUID ordered");
    }
    state = projector.apply(state, event);
    previousSuid = event.suid;
  }
  return {
    payload: projector.payload(state),
    version: projector.version(state),
    stateJson: projector.serializeState(state),
  };
}

/**
 * Polls a global SUID source for one tag/projector. Every source event advances
 * the durable checkpoint, while the registered reducer changes state only for
 * events whose complete durable tag membership includes the target tag.
 */
export class ProjectionRuntime {
  constructor(
    private readonly store: ProjectionStore,
    private readonly registry: ProjectorRegistry = DEPLOYED_PROJECTOR_REGISTRY,
  ) {}

  async catchUp(
    serviceId: string,
    identity: TagStateIdentity,
    nowMs: number,
    hooks: CatchUpHooks = {},
    options: ProjectionCatchUpOptions = {},
  ): Promise<CatchUpResult> {
    const projector = this.registry.resolve(identity.tagProjector);
    if (projector === undefined) {
      throw new Error(`Projector ${identity.tagProjector} is not registered`);
    }
    const dynamicLagBoundMs = await this.store.currentLagBound(serviceId, nowMs);
    const windowMs = safeWindowMs(dynamicLagBoundMs);
    if (safeWindowCeilingExceeded(dynamicLagBoundMs)) {
      const projectionId = projectionIdFor(identity);
      return {
        projectorId: identity.tagProjector,
        tag: identity.tag,
        checkpoint: await this.store.readProjectionCheckpoint(serviceId, projectionId),
        dynamicLagBoundMs,
        safeWindowMs: windowMs,
        indeterminate: true,
        advancedSourceEvents: 0,
        appliedEvents: 0,
      };
    }
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
      throw new Error("ordering_certificate_mismatch");
    }
    const projectionId = projectionIdFor(identity);

    for (let retry = 0; retry < MAX_CHECKPOINT_CAS_RETRIES; retry += 1) {
      let checkpoint = await this.store.readProjectionCheckpoint(serviceId, projectionId);
      let state = stateFromCheckpoint(projector, checkpoint);
      const sourceEvents = await this.store.readAllEvents(serviceId, checkpoint?.lastSuid ?? "");
      let advancedSourceEvents = 0;
      let appliedEvents = 0;
      let casConflict = false;
      let previousSuid = checkpoint?.lastSuid;

      for (const event of sourceEvents) {
        if (previousSuid !== undefined && compareSuid(previousSuid, event.suid) >= 0) {
          await this.store.appendDeliveryIncident(orderViolationIncident(serviceId, event, previousSuid));
          throw new Error("Projection source was not strictly SUID ordered");
        }
        if (certifiedClosedPrefixSuid === null || (
          certifiedClosedPrefixSuid !== undefined && compareSuid(event.suid, certifiedClosedPrefixSuid) > 0
        )) {
          break;
        }
        // A G44 BLOCK/UNSETTLED tick may still poll live projections, but it
        // must remain fenced by the last settled source frontier. `null`
        // deliberately permits no source advancement; it is not an empty
        // unbounded frontier.
        if (options.maximumSuid === null || (
          options.maximumSuid !== undefined && compareSuid(event.suid, options.maximumSuid) > 0
        )) {
          break;
        }
        // Stop at the first unsafe source event. Because the source is SUID
        // ordered, advancing past it could skip a delayed lower SUID.
        assertSortableUniqueId(event.suid);
        if (!isSortableUniqueIdSafeAt(event.suid, nowMs, dynamicLagBoundMs)) {
          return {
            projectorId: identity.tagProjector,
            tag: identity.tag,
            checkpoint,
            dynamicLagBoundMs,
            safeWindowMs: windowMs,
            indeterminate: false,
            advancedSourceEvents,
            appliedEvents,
          };
        }

        const appliesToTag = event.eventTags.includes(identity.tag);
        const nextState = appliesToTag ? projector.apply(state, projectionEventFromStored(event)) : state;
        const nextCheckpoint = checkpointFor(serviceId, projectionId, event, nextState, projector, nowMs);
        await hooks.beforeCheckpoint?.(event, nextCheckpoint);
        const advanced = await this.store.advanceProjectionCheckpoint({
          ...nextCheckpoint,
          expectedLastSuid: checkpoint?.lastSuid ?? null,
        });
        if (!advanced) {
          casConflict = true;
          break;
        }
        checkpoint = nextCheckpoint;
        state = nextState;
        previousSuid = event.suid;
        advancedSourceEvents += 1;
        if (appliesToTag) {
          appliedEvents += 1;
        }
        await hooks.afterCheckpoint?.(event, nextCheckpoint);
      }

      if (!casConflict) {
        return {
          projectorId: identity.tagProjector,
          tag: identity.tag,
          checkpoint,
          dynamicLagBoundMs,
          safeWindowMs: windowMs,
          indeterminate: false,
          advancedSourceEvents,
          appliedEvents,
        };
      }
    }
    throw new Error("Projection checkpoint did not converge after concurrent updates");
  }

  async pollRegistered(
    serviceId: string,
    nowMs: number,
    maximumSuid?: string | null,
    closedPrefixSuid?: string | null,
    closedPrefixCertificate?: ClosedPrefixCertificate,
  ): Promise<CatchUpResult[]> {
    const tags = await this.store.listProjectionTags(serviceId);
    const jobs: Array<{ readonly tag: string; readonly projector: string }> = [];
    for (const tag of tags) {
      for (const projector of this.registry.registered()) {
        if (tagStateIdentityForPolledTag(tag, projector.id, this.registry) !== undefined) jobs.push({ tag, projector: projector.id });
      }
    }
    const results: CatchUpResult[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        const job = jobs[index];
        if (job === undefined) return;
        const identity = tagStateIdentityForPolledTag(job.tag, job.projector, this.registry);
        if (identity !== undefined) results[index] = await this.catchUp(serviceId, identity, nowMs, {}, { maximumSuid, closedPrefixSuid, closedPrefixCertificate });
      }
    };
    const workerCount = Math.min(MAX_LIVE_PROJECTION_CONCURRENCY, jobs.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }
}

function tagStateIdentityForPolledTag(
  tag: string,
  projector: string,
  registry: ProjectorRegistry,
): TagStateIdentity | undefined {
  const parts = tag.split(":");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    return undefined;
  }
  const [tagGroup, tagContent] = parts;
  return registry.resolve(projector) === undefined
    ? undefined
    : { tag, tagGroup: tagGroup!, tagContent: tagContent!, tagProjector: projector };
}
