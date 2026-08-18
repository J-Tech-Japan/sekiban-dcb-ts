import { safeWindowMs } from "../projection/ProjectionRuntime";
import type { ProjectionCheckpoint, ProjectionStore, StoredEvent } from "../store/types";

const MAX_CHECKPOINT_CAS_RETRIES = 8;

export type MaterializedViewOperation = "build" | "follow" | "rebuild" | "reset" | "promote";

export type MaterializedViewErrorCode =
  | "MV_DEFINITION_INVALID"
  | "MV_BUILD_ALREADY_EXISTS"
  | "MV_BUILD_CONFLICT"
  | "MV_FOLLOW_CHECKPOINT_UNAVAILABLE"
  | "MV_CHECKPOINT_CONFLICT"
  | "MV_REBUILD_ID_INVALID"
  | "MV_REBUILD_CANDIDATE_EXISTS"
  | "MV_REBUILD_CONFLICT"
  | "MV_RESET_MISSING"
  | "MV_RESET_NOTHING_TO_RESET"
  | "MV_RESET_CONFLICT"
  | "MV_PROMOTE_CANDIDATE_MISSING"
  | "MV_PROMOTE_NOTHING_TO_PROMOTE"
  | "MV_PROMOTE_CONFLICT"
  | "MV_STATE_INVALID"
  | "MV_OPERATION_FAILED"
  | "MV_SOURCE_NOT_STRICTLY_SUID_ORDERED";

/** A failed change operation is never represented as a successful no-op. */
export class MaterializedViewOperationError extends Error {
  constructor(
    readonly operation: MaterializedViewOperation,
    readonly code: MaterializedViewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MaterializedViewOperationError";
  }
}

/** A deploy-time TypeScript definition; materialized views do not extend V1 HTTP wire. */
export interface MaterializedViewDefinition<State> {
  readonly id: string;
  initialState(): State;
  apply(state: State, event: StoredEvent): State;
  serializeState(state: State): string;
  deserializeState(stateJson: string): State;
  version(state: State): number;
}

export interface MaterializedViewSnapshot<State> {
  serviceId: string;
  viewId: string;
  checkpoint: ProjectionCheckpoint;
  state: State;
}

export interface MaterializedViewFollowResult<State> extends MaterializedViewSnapshot<State> {
  dynamicLagBoundMs: number;
  safeWindowMs: number;
  advancedSourceEvents: number;
  appliedEvents: number;
}

export interface MaterializedViewRebuildResult<State> {
  candidateId: string;
  result: MaterializedViewFollowResult<State>;
}

export interface MaterializedViewFollowHooks {
  /** Test-only crash boundary before durable state/checkpoint advancement. */
  beforeCheckpoint?(event: StoredEvent, checkpoint: ProjectionCheckpoint): Promise<void> | void;
  /** Test-only crash boundary after durable state/checkpoint advancement. */
  afterCheckpoint?(event: StoredEvent, checkpoint: ProjectionCheckpoint): Promise<void> | void;
}

function compareSuid(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return leftBytes.length - rightBytes.length;
}

function nonEmpty(value: string): boolean {
  return value.length > 0;
}

/** Stable durable namespace for the promoted materialized view. */
export function materializedViewId(definitionId: string): string {
  return `mv:${definitionId}`;
}

/** Durable namespace for a rebuild candidate that has not yet been promoted. */
export function materializedViewCandidateId(definitionId: string, rebuildId: string): string {
  return `${materializedViewId(definitionId)}:rebuild:${rebuildId}`;
}

/**
 * A materialized view consumes the same read-only global SUID source and
 * SafeWindow as a live projection. Its state and source position share one
 * durable checkpoint transaction, so a restart cannot double-apply a source
 * event that has already changed state.
 */
export class MaterializedViewRuntime {
  constructor(private readonly store: ProjectionStore) {}

  async read<State>(serviceId: string, definition: MaterializedViewDefinition<State>): Promise<MaterializedViewSnapshot<State> | undefined> {
    const viewId = this.checkedViewId(definition, "follow");
    const checkpoint = await this.store.readProjectionCheckpoint(serviceId, viewId);
    return checkpoint === undefined ? undefined : this.snapshot(serviceId, viewId, checkpoint, definition, "follow");
  }

  /** Creates the initial durable state then follows through the SafeWindow. */
  async build<State>(
    serviceId: string,
    definition: MaterializedViewDefinition<State>,
    nowMs: number,
    hooks: MaterializedViewFollowHooks = {},
  ): Promise<MaterializedViewFollowResult<State>> {
    try {
      const viewId = this.checkedViewId(definition, "build");
      await this.ensureInitialCheckpoint(serviceId, viewId, definition, nowMs, "build", true);
      return await this.followCheckpoint(serviceId, viewId, definition, nowMs, "build", hooks);
    } catch (error) {
      throw this.typedFailure("build", error);
    }
  }

  /** Continues the promoted durable view from its own global SUID checkpoint. */
  async follow<State>(
    serviceId: string,
    definition: MaterializedViewDefinition<State>,
    nowMs: number,
    hooks: MaterializedViewFollowHooks = {},
  ): Promise<MaterializedViewFollowResult<State>> {
    try {
      const viewId = this.checkedViewId(definition, "follow");
      await this.ensureInitialCheckpoint(serviceId, viewId, definition, nowMs, "follow", false);
      return await this.followCheckpoint(serviceId, viewId, definition, nowMs, "follow", hooks);
    } catch (error) {
      throw this.typedFailure("follow", error);
    }
  }

  /**
   * Builds a separate durable candidate from the beginning of the global
   * source. The caller must explicitly promote it; no rebuild silently swaps
   * production state.
   */
  async rebuild<State>(
    serviceId: string,
    definition: MaterializedViewDefinition<State>,
    rebuildId: string,
    nowMs: number,
    hooks: MaterializedViewFollowHooks = {},
  ): Promise<MaterializedViewRebuildResult<State>> {
    try {
      const definitionId = this.checkedDefinitionId(definition, "rebuild");
      if (!nonEmpty(rebuildId)) {
        throw this.failure("rebuild", "MV_REBUILD_ID_INVALID", "Materialized-view rebuildId is required");
      }
      const candidateId = materializedViewCandidateId(definitionId, rebuildId);
      await this.ensureInitialCheckpoint(serviceId, candidateId, definition, nowMs, "rebuild", true);
      return {
        candidateId,
        result: await this.followCheckpoint(serviceId, candidateId, definition, nowMs, "rebuild", hooks),
      };
    } catch (error) {
      throw this.typedFailure("rebuild", error);
    }
  }

  /** Resets the promoted view to a durable initial state, never a no-op. */
  async reset<State>(
    serviceId: string,
    definition: MaterializedViewDefinition<State>,
    nowMs: number,
  ): Promise<MaterializedViewSnapshot<State>> {
    try {
      const viewId = this.checkedViewId(definition, "reset");
      const existing = await this.store.readProjectionCheckpoint(serviceId, viewId);
      if (existing === undefined) {
        throw this.failure("reset", "MV_RESET_MISSING", "Cannot reset a materialized view that was never built");
      }
      const initial = this.checkpointFor(serviceId, viewId, "", this.initialState(definition, "reset"), definition, nowMs, "reset");
      if (
        existing.lastSuid === initial.lastSuid
        && existing.stateJson === initial.stateJson
        && existing.version === initial.version
      ) {
        throw this.failure("reset", "MV_RESET_NOTHING_TO_RESET", "Materialized view is already at its durable initial state");
      }
      const advanced = await this.store.advanceProjectionCheckpoint({
        ...initial,
        expectedLastSuid: existing.lastSuid,
      });
      if (!advanced) {
        throw this.failure("reset", "MV_RESET_CONFLICT", "Materialized-view checkpoint changed before reset could commit");
      }
      return this.snapshot(serviceId, viewId, initial, definition, "reset");
    } catch (error) {
      throw this.typedFailure("reset", error);
    }
  }

  /** Promotes a previously rebuilt durable candidate with a compare-and-swap. */
  async promote<State>(
    serviceId: string,
    definition: MaterializedViewDefinition<State>,
    rebuildId: string,
    nowMs: number,
  ): Promise<MaterializedViewSnapshot<State>> {
    try {
      const definitionId = this.checkedDefinitionId(definition, "promote");
      if (!nonEmpty(rebuildId)) {
        throw this.failure("promote", "MV_REBUILD_ID_INVALID", "Materialized-view rebuildId is required");
      }
      const viewId = materializedViewId(definitionId);
      const candidateId = materializedViewCandidateId(definitionId, rebuildId);
      const candidate = await this.store.readProjectionCheckpoint(serviceId, candidateId);
      if (candidate === undefined) {
        throw this.failure("promote", "MV_PROMOTE_CANDIDATE_MISSING", "Materialized-view rebuild candidate does not exist");
      }
      const candidateSnapshot = this.snapshot(serviceId, candidateId, candidate, definition, "promote");
      const current = await this.store.readProjectionCheckpoint(serviceId, viewId);
      if (
        current !== undefined
        && current.lastSuid === candidate.lastSuid
        && current.stateJson === candidate.stateJson
        && current.version === candidate.version
      ) {
        throw this.failure("promote", "MV_PROMOTE_NOTHING_TO_PROMOTE", "Materialized-view candidate is already promoted");
      }
      const promoted: ProjectionCheckpoint = {
        ...candidateSnapshot.checkpoint,
        projectionId: viewId,
        updatedAt: nowMs,
      };
      const advanced = await this.store.advanceProjectionCheckpoint({
        ...promoted,
        expectedLastSuid: current?.lastSuid ?? null,
      });
      if (!advanced) {
        throw this.failure("promote", "MV_PROMOTE_CONFLICT", "Materialized-view checkpoint changed before candidate promotion could commit");
      }
      return this.snapshot(serviceId, viewId, promoted, definition, "promote");
    } catch (error) {
      throw this.typedFailure("promote", error);
    }
  }

  private async ensureInitialCheckpoint<State>(
    serviceId: string,
    viewId: string,
    definition: MaterializedViewDefinition<State>,
    nowMs: number,
    operation: MaterializedViewOperation,
    failIfPresent: boolean,
  ): Promise<ProjectionCheckpoint> {
    const existing = await this.store.readProjectionCheckpoint(serviceId, viewId);
    if (existing !== undefined) {
      if (failIfPresent) {
        throw this.failure(
          operation,
          operation === "build" ? "MV_BUILD_ALREADY_EXISTS" : "MV_REBUILD_CANDIDATE_EXISTS",
          operation === "build"
            ? "Materialized view already has durable state; use follow or rebuild"
            : "Materialized-view rebuild candidate already exists",
        );
      }
      return existing;
    }
    const initial = this.checkpointFor(serviceId, viewId, "", this.initialState(definition, operation), definition, nowMs, operation);
    const advanced = await this.store.advanceProjectionCheckpoint({
      ...initial,
      expectedLastSuid: null,
    });
    if (advanced) {
      return initial;
    }
    if (failIfPresent) {
      throw this.failure(
        operation,
        operation === "build" ? "MV_BUILD_CONFLICT" : "MV_REBUILD_CONFLICT",
        "Materialized-view checkpoint appeared before the requested durable operation could commit",
      );
    }
    const raced = await this.store.readProjectionCheckpoint(serviceId, viewId);
    if (raced === undefined) {
      throw this.failure("follow", "MV_FOLLOW_CHECKPOINT_UNAVAILABLE", "Materialized-view checkpoint could not be established");
    }
    return raced;
  }

  private async followCheckpoint<State>(
    serviceId: string,
    viewId: string,
    definition: MaterializedViewDefinition<State>,
    nowMs: number,
    operation: MaterializedViewOperation,
    hooks: MaterializedViewFollowHooks,
  ): Promise<MaterializedViewFollowResult<State>> {
    const dynamicLagBoundMs = await this.store.currentLagBound(serviceId);
    const windowMs = safeWindowMs(dynamicLagBoundMs);
    const safeThrough = nowMs - windowMs;

    for (let retry = 0; retry < MAX_CHECKPOINT_CAS_RETRIES; retry += 1) {
      const checkpoint = await this.store.readProjectionCheckpoint(serviceId, viewId);
      if (checkpoint === undefined) {
        throw this.failure("follow", "MV_FOLLOW_CHECKPOINT_UNAVAILABLE", "Materialized-view checkpoint disappeared during follow");
      }
      let currentCheckpoint = checkpoint;
      let state = this.stateFrom(definition, checkpoint, operation);
      const sourceEvents = await this.store.readAllEvents(serviceId, checkpoint.lastSuid);
      let validatedPreviousSuid = checkpoint.lastSuid;
      for (const event of sourceEvents) {
        if (compareSuid(validatedPreviousSuid, event.suid) >= 0) {
          throw this.failure(
            operation,
            "MV_SOURCE_NOT_STRICTLY_SUID_ORDERED",
            "Materialized-view source was not strictly SUID ordered",
          );
        }
        validatedPreviousSuid = event.suid;
      }
      let advancedSourceEvents = 0;
      let appliedEvents = 0;
      let casConflict = false;

      for (const event of sourceEvents) {
        // SafeWindow is deliberately read-only: stopping at the first unsafe
        // SUID preserves convergence when a lower SUID is delivered late.
        if (event.lastArrivedAt > safeThrough) {
          return {
            ...this.snapshot(serviceId, viewId, currentCheckpoint, definition, operation),
            dynamicLagBoundMs,
            safeWindowMs: windowMs,
            advancedSourceEvents,
            appliedEvents,
          };
        }
        const nextState = this.apply(definition, state, event, operation);
        const nextCheckpoint = this.checkpointFor(serviceId, viewId, event.suid, nextState, definition, nowMs, operation);
        await hooks.beforeCheckpoint?.(event, nextCheckpoint);
        const advanced = await this.store.advanceProjectionCheckpoint({
          ...nextCheckpoint,
          expectedLastSuid: currentCheckpoint.lastSuid,
        });
        if (!advanced) {
          casConflict = true;
          break;
        }
        currentCheckpoint = nextCheckpoint;
        state = nextState;
        advancedSourceEvents += 1;
        appliedEvents += 1;
        await hooks.afterCheckpoint?.(event, nextCheckpoint);
      }

      if (!casConflict) {
        return {
          ...this.snapshot(serviceId, viewId, currentCheckpoint, definition, operation),
          dynamicLagBoundMs,
          safeWindowMs: windowMs,
          advancedSourceEvents,
          appliedEvents,
        };
      }
    }
    throw this.failure(operation, "MV_CHECKPOINT_CONFLICT", "Materialized-view checkpoint did not converge after concurrent updates");
  }

  private checkedViewId<State>(definition: MaterializedViewDefinition<State>, operation: MaterializedViewOperation): string {
    return materializedViewId(this.checkedDefinitionId(definition, operation));
  }

  private checkedDefinitionId<State>(
    definition: MaterializedViewDefinition<State>,
    operation: MaterializedViewOperation,
  ): string {
    if (!nonEmpty(definition.id)) {
      throw this.failure(operation, "MV_DEFINITION_INVALID", "Materialized-view definition id is required");
    }
    return definition.id;
  }

  private stateFrom<State>(
    definition: MaterializedViewDefinition<State>,
    checkpoint: ProjectionCheckpoint,
    operation: MaterializedViewOperation,
  ): State {
    try {
      return definition.deserializeState(checkpoint.stateJson);
    } catch (error) {
      throw this.failure(operation, "MV_STATE_INVALID", `Materialized-view durable state was invalid: ${String(error)}`);
    }
  }

  private initialState<State>(
    definition: MaterializedViewDefinition<State>,
    operation: MaterializedViewOperation,
  ): State {
    try {
      return definition.initialState();
    } catch (error) {
      throw this.failure(operation, "MV_STATE_INVALID", `Materialized-view initial state was invalid: ${String(error)}`);
    }
  }

  private apply<State>(
    definition: MaterializedViewDefinition<State>,
    state: State,
    event: StoredEvent,
    operation: MaterializedViewOperation,
  ): State {
    try {
      return definition.apply(state, event);
    } catch (error) {
      throw this.failure(operation, "MV_STATE_INVALID", `Materialized-view reducer failed: ${String(error)}`);
    }
  }

  private checkpointFor<State>(
    serviceId: string,
    viewId: string,
    lastSuid: string,
    state: State,
    definition: MaterializedViewDefinition<State>,
    nowMs: number,
    operation: MaterializedViewOperation,
  ): ProjectionCheckpoint {
    try {
      return {
        serviceId,
        projectionId: viewId,
        lastSuid,
        stateJson: definition.serializeState(state),
        version: definition.version(state),
        updatedAt: nowMs,
      };
    } catch (error) {
      throw this.failure(operation, "MV_STATE_INVALID", `Materialized-view state could not be persisted: ${String(error)}`);
    }
  }

  private snapshot<State>(
    serviceId: string,
    viewId: string,
    checkpoint: ProjectionCheckpoint,
    definition: MaterializedViewDefinition<State>,
    operation: MaterializedViewOperation,
  ): MaterializedViewSnapshot<State> {
    return {
      serviceId,
      viewId,
      checkpoint,
      state: this.stateFrom(definition, checkpoint, operation),
    };
  }

  private failure(
    operation: MaterializedViewOperation,
    code: MaterializedViewErrorCode,
    message: string,
  ): MaterializedViewOperationError {
    return new MaterializedViewOperationError(operation, code, message);
  }

  private typedFailure(operation: MaterializedViewOperation, error: unknown): MaterializedViewOperationError {
    return error instanceof MaterializedViewOperationError
      ? error
      : this.failure(operation, "MV_OPERATION_FAILED", `Materialized-view ${operation} failed: ${String(error)}`);
  }
}
