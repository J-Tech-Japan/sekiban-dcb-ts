import { projectionIdFor } from "../projection/ProjectionRuntime";
import type { ProjectionCheckpoint, ProjectionStore, StoredEvent } from "../store/types";
import type { QueryDefinition } from "./QueryRegistry";

/** The query surface can only inspect durable source and projection facts. */
export type QueryProjectionStore = Pick<
  ProjectionStore,
  "readAllEvents" | "currentLagBound" | "listProjectionTags" | "readProjectionCheckpoint"
>;

export interface ProjectedQueryEntry {
  readonly eventId: string;
  readonly suid: string;
  readonly payload: string;
}

interface SerializedEventHistoryEntry {
  eventId: string;
  suid: string;
  payload: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** V1 SUID ordering is bytewise ordinal, not locale or parsed timestamp order. */
export function compareSuid(left: string, right: string): number {
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

function tagIdentity(tag: string, definition: QueryDefinition): {
  tag: string;
  tagGroup: string;
  tagContent: string;
  tagProjector: string;
} | undefined {
  const parts = tag.split(":");
  if (parts.length !== 2 || parts.some((part) => part.length === 0) || parts[0] !== definition.tagGroup) {
    return undefined;
  }
  return {
    tag,
    tagGroup: parts[0]!,
    tagContent: parts[1]!,
    tagProjector: definition.tagProjector,
  };
}

function stateEntries(checkpoint: ProjectionCheckpoint): SerializedEventHistoryEntry[] {
  const decoded: unknown = JSON.parse(checkpoint.stateJson);
  if (
    !Array.isArray(decoded) ||
    !decoded.every((entry) =>
      isObject(entry) &&
      isNonEmptyString(entry.eventId) &&
      isNonEmptyString(entry.suid) &&
      typeof entry.payload === "string")
  ) {
    throw new Error("Projected event-history state was malformed");
  }
  return decoded.map((entry) => ({
    eventId: entry.eventId as string,
    suid: entry.suid as string,
    payload: entry.payload as string,
  }));
}

function sameEntry(left: ProjectedQueryEntry, right: ProjectedQueryEntry): boolean {
  return left.suid === right.suid && left.payload === right.payload;
}

/**
 * Builds a query snapshot exclusively from durable read-side checkpoints.
 * A recently appended tag with no safe checkpoint is deliberately absent,
 * which keeps an already-open page window stable while SafeWindow holds it.
 */
export async function readProjectedEntries(
  store: QueryProjectionStore,
  serviceId: string,
  definition: QueryDefinition,
): Promise<ProjectedQueryEntry[]> {
  const entriesByEventId = new Map<string, ProjectedQueryEntry>();
  const tags = await store.listProjectionTags(serviceId);
  for (const tag of tags) {
    const identity = tagIdentity(tag, definition);
    if (identity === undefined) {
      continue;
    }
    const checkpoint = await store.readProjectionCheckpoint(serviceId, projectionIdFor(identity));
    if (checkpoint === undefined) {
      continue;
    }
    for (const serialized of stateEntries(checkpoint)) {
      const entry: ProjectedQueryEntry = serialized;
      const existing = entriesByEventId.get(entry.eventId);
      if (existing !== undefined && !sameEntry(existing, entry)) {
        throw new Error(`Projected EventId ${entry.eventId} has contradictory state`);
      }
      entriesByEventId.set(entry.eventId, entry);
    }
  }
  return [...entriesByEventId.values()].sort((left, right) => {
    const bySuid = compareSuid(left.suid, right.suid);
    return bySuid === 0 ? compareSuid(left.eventId, right.eventId) : bySuid;
  });
}

/**
 * A requested SUID is observed only after a relevant durable source event and
 * its mapped tag projector checkpoint both prove that observation. A mere
 * source-row arrival is not enough to fabricate a query result.
 */
export async function projectionHasObserved(
  store: QueryProjectionStore,
  serviceId: string,
  definition: QueryDefinition,
  requestedSuid: string,
): Promise<boolean> {
  const source = await store.readAllEvents(serviceId, "");
  const target = source.find((event: StoredEvent) => event.suid === requestedSuid);
  if (target === undefined) {
    return false;
  }
  for (const tag of target.eventTags) {
    const identity = tagIdentity(tag, definition);
    if (identity === undefined) {
      continue;
    }
    const checkpoint = await store.readProjectionCheckpoint(serviceId, projectionIdFor(identity));
    if (checkpoint !== undefined && compareSuid(checkpoint.lastSuid, requestedSuid) >= 0) {
      return true;
    }
  }
  return false;
}
