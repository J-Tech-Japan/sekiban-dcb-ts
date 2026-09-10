import { projectionIdFor } from "../projection/ProjectionRuntime";
import type { ProjectionCheckpoint, ProjectionStore, StoredEvent } from "../store/types";
import type { QueryDefinition } from "./QueryRegistry";
import type {
  MaterializedViewListOptions,
  MaterializedViewListPage,
  MaterializedViewQueryOptions,
  MaterializedViewOrderingQuarantine,
  MaterializedViewRow,
  MaterializedViewWaitForState,
} from "../mv/MaterializedViewStore";
import type { UnsafeComposedPage } from "../mv/UnsafeWindowMaterializedView";

/** The query surface can only inspect durable source and projection facts. */
export type QueryProjectionStore = Pick<
  ProjectionStore,
  "readAllEvents" | "currentLagBound" | "listProjectionTags" | "readProjectionCheckpoint"
>;

/**
 * SDT-G31's source-side wait lookup.  A D1 implementation must distinguish a
 * missing target from a contradictory target/incident; callers must never
 * turn either unavailable result into a successful safe-head observation.
 */
export type WaitForTargetLookup =
  | { readonly kind: "pending" }
  | { readonly kind: "stored"; readonly eventId: string; readonly suid: string }
  | { readonly kind: "unavailable"; readonly reason: "incident" | "suid-contradiction" };

/** Indexed D1 source port used only by the d1-mv waitFor implementation. */
export interface WaitForTargetSourcePort {
  readWaitForTarget(serviceId: string, suid: string): Promise<WaitForTargetLookup>;
}

/** The backing choice is typed and deploy-time; it never changes the V1 wire. */
export type QueryBacking = "memory" | "d1-mv";

export interface MaterializedViewQueryPort {
  queryRows(serviceId: string, viewId: string, options?: MaterializedViewQueryOptions): Promise<MaterializedViewRow[]>;
  /** Optional SDT-G23 port. D1 provides one-statement winner/count paging. */
  queryRowsWithTotal?(serviceId: string, viewId: string, options?: MaterializedViewQueryOptions): Promise<UnsafeComposedPage>;
  /** SDT-G55's explicit safe/unsafe list port; absent ports retain legacy behavior. */
  readListPage?(serviceId: string, viewId: string, options?: MaterializedViewListOptions): Promise<MaterializedViewListPage>;
  /** Target receipt is the unsafe-window wait oracle; global heads are not. */
  hasTargetReceipt?(serviceId: string, viewId: string, eventId: string, suid: string): Promise<boolean>;
  /** SDT-G24 active-generation finding; true means every composed read is unavailable. */
  hasCheckpointAheadFinding?(serviceId: string, viewId: string): Promise<boolean>;
  /** G69 fail-closed ordering gate; only the active generation can refuse safe reads. */
  readOrderingQuarantine?(serviceId: string, viewId: string): Promise<MaterializedViewOrderingQuarantine | undefined>;
  /** Generation snapshot paired with the final safe-read boundary check. */
  readActiveGeneration?(serviceId: string, viewId: string): Promise<number | undefined>;
  /**
   * SDT-G31 active-generation wait facts.  This deliberately combines only
   * indexed point reads; its receipt is generation/definition-bound and its
   * hard gates are evaluated before a wait can report success.
   */
  readWaitForState?(
    serviceId: string,
    viewId: string,
    target: { readonly eventId?: string; readonly suid: string },
  ): Promise<MaterializedViewWaitForState>;
  /** D1-backed implementations may need to verify the versioned schema first. */
  initialize?: () => Promise<void>;
}

export type QueryBackingSelection =
  | { readonly backing: "memory"; readonly store: QueryProjectionStore }
  | { readonly backing: "d1-mv"; readonly store: MaterializedViewQueryPort };

export interface QueryBackingOptions {
  readonly backing: QueryBacking;
  readonly memory?: QueryProjectionStore;
  readonly materializedView?: MaterializedViewQueryPort;
}

/** Select a query backing without allowing an HTTP request to provide a store. */
export function selectQueryBacking(options: QueryBackingOptions): QueryBackingSelection {
  if (options.backing === "memory") {
    if (options.memory === undefined) throw new Error("A memory query backing is required when backing=memory");
    return { backing: "memory", store: options.memory };
  }
  if (options.materializedView === undefined) {
    throw new Error("A D1 materialized-view query backing is required when backing=d1-mv");
  }
  return { backing: "d1-mv", store: options.materializedView };
}

export const chooseQueryBacking = selectQueryBacking;

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

/** Internal query entries retain JSON text rather than reconstructing base64. */
function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

function stateEntries(checkpoint: ProjectionCheckpoint): SerializedEventHistoryEntry[] {
  const decoded: unknown = JSON.parse(checkpoint.stateJson);
  if (Array.isArray(decoded)) {
    if (!decoded.every((entry) =>
      isObject(entry) &&
      isNonEmptyString(entry.eventId) &&
      isNonEmptyString(entry.suid) &&
      typeof entry.payload === "string")) {
      throw new Error("Projected event-history state was malformed");
    }
    return decoded.map((entry) => ({
      eventId: (entry as Record<string, unknown>).eventId as string,
      suid: (entry as Record<string, unknown>).suid as string,
      payload: (entry as Record<string, unknown>).payload as string,
    }));
  }
  // A composed consumer may register a domain projector whose durable state
  // is not the test event-history array. Preserve the fixed V1 query shape by
  // exposing one deterministic snapshot entry for that tag projection; the
  // source SUID remains the checkpoint's opaque ordering fact.
  if (isObject(decoded)) {
    return [{
      eventId: `projection:${checkpoint.projectionId}`,
      suid: checkpoint.lastSuid,
      payload: jsonText(decoded),
    }];
  }
  throw new Error("Projected state was malformed");
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
 * Return the greatest durable checkpoint that backs a projection definition.
 * This is the safe head for the memory query lane, including an empty page;
 * it is never inferred from the number of rows returned.
 */
export async function readProjectionHead(
  store: QueryProjectionStore,
  serviceId: string,
  definition: QueryDefinition,
): Promise<string> {
  let head = "";
  const tags = await store.listProjectionTags(serviceId);
  for (const tag of tags) {
    const identity = tagIdentity(tag, definition);
    if (identity === undefined) continue;
    const checkpoint = await store.readProjectionCheckpoint(serviceId, projectionIdFor(identity));
    if (checkpoint !== undefined && compareSuid(checkpoint.lastSuid, head) > 0) head = checkpoint.lastSuid;
  }
  return head;
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

/** Query rows through the selected backing while preserving typed paging inputs. */
export async function readRowsFromBacking(
  selection: QueryBackingSelection,
  serviceId: string,
  viewId: string,
  definition: QueryDefinition,
  options: MaterializedViewQueryOptions = {},
): Promise<ProjectedQueryEntry[]> {
  if (selection.backing === "d1-mv") {
    const rows = await selection.store.queryRows(serviceId, viewId, options);
    return rows.map((row) => {
      const value = row.value;
      const eventId = isObject(value) && typeof value.eventId === "string" && value.eventId.length > 0
        ? value.eventId
        : row.rowKey;
      return { eventId, suid: row.sourceSuid, payload: jsonText(value) };
    }).sort((left, right) => {
      const bySuid = compareSuid(left.suid, right.suid);
      return bySuid === 0 ? compareSuid(left.eventId, right.eventId) : bySuid;
    });
  }
  const entries = await readProjectedEntries(selection.store, serviceId, definition);
  return options.descending === true ? [...entries].reverse() : entries;
}

/** Page in the backing when it supports composed SQL, otherwise preserve the legacy port. */
export async function readRowsPageFromBacking(
  selection: QueryBackingSelection,
  serviceId: string,
  viewId: string,
  definition: QueryDefinition,
  options: MaterializedViewQueryOptions,
): Promise<{ readonly entries: ProjectedQueryEntry[]; readonly totalCount: number; readonly serverPaged: boolean }> {
  if (selection.backing === "d1-mv" && selection.store.queryRowsWithTotal !== undefined) {
    const page = await selection.store.queryRowsWithTotal(serviceId, viewId, options);
    return {
      entries: page.rows.map((row) => ({
        eventId: isObject(row.value) && typeof row.value.eventId === "string" && row.value.eventId.length > 0 ? row.value.eventId : row.rowKey,
        suid: row.sourceSuid,
        payload: jsonText(row.value),
      })),
      totalCount: page.totalCount,
      serverPaged: true,
    };
  }
  const entries = await readRowsFromBacking(selection, serviceId, viewId, definition, options);
  return { entries, totalCount: entries.length, serverPaged: false };
}
