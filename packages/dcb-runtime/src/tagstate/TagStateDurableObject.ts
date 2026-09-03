import { assertSortableUniqueId, compareSortableUniqueId } from "../allocator/SortableUniqueId";
import {
  projectionEventFromTagEvent,
  type ProjectorRegistry,
  type TagStateProjector,
} from "../projection/ProjectorRegistry";
import type {
  G43TagStateIncrementalPage,
  TagEvent,
} from "../tag/types";
import { scopeIdFor } from "../scope/ScopeName";

/** The fixed bounded source page used by both normal delta and replay. */
export const TAG_STATE_SOURCE_PAGE_LIMIT = 64;

// A deployed Worker has one composed domain registry. The public Worker
// factories install that exact registry before any request can reach a
// TagStateDO. A global Symbol makes the slot common to the entrypoint bundle
// and this package module, rather than silently falling back when tooling
// loads them through distinct module URLs.
const TAG_STATE_REGISTRY_SLOT = Symbol.for("sekiban.dcb.tagstate.projector-registry.v1");

function configuredProjectorRegistry(): ProjectorRegistry | undefined {
  return (globalThis as typeof globalThis & {
    [TAG_STATE_REGISTRY_SLOT]?: ProjectorRegistry;
  })[TAG_STATE_REGISTRY_SLOT];
}

export function configureTagStateProjectorRegistry(registry: ProjectorRegistry | undefined): void {
  const target = globalThis as typeof globalThis & {
    [TAG_STATE_REGISTRY_SLOT]?: ProjectorRegistry;
  };
  if (registry === undefined) {
    delete target[TAG_STATE_REGISTRY_SLOT];
    return;
  }
  target[TAG_STATE_REGISTRY_SLOT] = registry;
}

type JsonObject = Record<string, unknown>;
type SqlRow = Record<string, SqlStorageValue>;
type TagStatePhase = "READY" | "REBUILDING";

export interface TagStateObjectIdentity {
  readonly serviceId: string;
  readonly tag: string;
  readonly projectorId: string;
}

export interface TagStateReadSuccess {
  readonly kind: "ready";
  readonly payload: string;
  readonly version: number;
  readonly lastSortedUniqueId: string;
  readonly projectorVersion: string;
}

interface TagStateDurableObjectEnv {
  readonly TAG: DurableObjectNamespace;
}

interface TagStateSourceStub {
  fetch(request: Request): Promise<Response>;
}

interface ReadyCache {
  readonly phase: "READY";
  readonly projectorVersion: string;
  readonly stateJson: string;
  readonly lastSuid: string;
}

interface RebuildingCache {
  readonly phase: "REBUILDING";
  readonly targetProjectorVersion: string;
  readonly frozenThrough: string | null;
  readonly replayCursor: string;
  readonly accumulatorJson: string;
  readonly rebuildId: string;
}

type Cache = ReadyCache | RebuildingCache;

class TagStateIdentityConflict extends Error {
  constructor() {
    super("TagState Durable Object identity changed");
    this.name = "TagStateIdentityConflict";
  }
}

class TagStateUnknownProjector extends Error {
  constructor() {
    super("TagState projector is no longer registered");
    this.name = "TagStateUnknownProjector";
  }
}

class TagStateRegistryFailure extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "TagStateRegistryFailure";
  }
}

class TagStateSourceFailure extends Error {
  constructor(readonly status: 409 | 503, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "TagStateSourceFailure";
  }
}

class TagStateCacheCorruption extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "TagStateCacheCorruption";
  }
}

class TagStateCheckpointFault extends Error {
  constructor() {
    super("G46 checkpoint fault");
    this.name = "TagStateCheckpointFault";
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function error(status: number, code: string, message: string): Response {
  return json({ code, error: message }, status);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function sqlString(value: SqlStorageValue | undefined, column: string): string {
  if (typeof value !== "string") throw new TagStateCacheCorruption(new Error(`TagState SQL ${column} is not a string`));
  return value;
}

function sqlNullableString(value: SqlStorageValue | undefined, column: string): string | null {
  if (value === null || value === undefined) return null;
  return sqlString(value, column);
}

function parseIdentity(value: unknown): TagStateObjectIdentity | undefined {
  if (!isObject(value) || !isNonEmptyString(value.serviceId) || !isNonEmptyString(value.tag) || !isNonEmptyString(value.projectorId)) {
    return undefined;
  }
  return { serviceId: value.serviceId, tag: value.tag, projectorId: value.projectorId };
}

function initializeTagStateSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS tag_state_identity (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      service_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      projector_id TEXT NOT NULL,
      UNIQUE (service_id, tag, projector_id)
    );

    CREATE TABLE IF NOT EXISTS tag_state_cache (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      phase TEXT NOT NULL CHECK (phase IN ('READY', 'REBUILDING')),
      projector_version TEXT,
      state_json TEXT,
      last_suid TEXT NOT NULL,
      target_projector_version TEXT,
      frozen_through TEXT,
      replay_cursor TEXT,
      accumulator_json TEXT,
      rebuild_id TEXT,
      FOREIGN KEY (singleton) REFERENCES tag_state_identity(singleton) ON DELETE RESTRICT
    );
  `);
}

/**
 * TagState cache and resumable replay owner.  The only event source is the
 * existing G43 Tag RPC; this object deliberately has neither a full-record
 * fetch route nor a second source-query implementation.
 */
export class TagStateDurableObject implements DurableObject {
  private g46CheckpointFault: "before-checkpoint" | "after-checkpoint" | undefined;
  private g46SourceNamespace: DurableObjectNamespace | undefined;
  /**
   * Installed by the entrypoint when it composes the deployed domain.  There
   * is deliberately no default/test-registry fallback here: a DO isolate
   * which was not built from that composition must return the typed registry
   * failure rather than fold with a different projector authority.
   */
  private readonly registry: ProjectorRegistry | undefined;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: TagStateDurableObjectEnv,
    registry?: ProjectorRegistry,
  ) {
    this.registry = registry ?? configuredProjectorRegistry();
    if (typeof ctx.storage.sql?.exec !== "function") {
      throw new Error("TagState Durable Object requires SQLite storage");
    }
    initializeTagStateSchema(ctx.storage.sql);
  }

  /** Test-only fault seam for the two durable checkpoint boundaries. */
  setG46CheckpointFaultForTest(fault: "before-checkpoint" | "after-checkpoint" | undefined): void {
    this.g46CheckpointFault = fault;
  }

  /** Test-only source seam; production always resolves `env.TAG`. */
  setG46SourceNamespaceForTest(namespace: DurableObjectNamespace | undefined): void {
    this.g46SourceNamespace = namespace;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/read") {
      return error(404, "tag_state_route_not_found", "TagState route was not found");
    }
    let body: unknown;
    try {
      body = await request.json<unknown>();
    } catch {
      return error(400, "tag_state_validation_error", "TagState request must be JSON");
    }
    const identity = parseIdentity(body);
    if (identity === undefined) {
      return error(400, "tag_state_validation_error", "TagState identity requires serviceId, tag, and projectorId");
    }
    return await this.read(identity);
  }

  private async read(identity: TagStateObjectIdentity): Promise<Response> {
    try {
      this.ensureIdentity(identity);
      const projector = this.resolveProjector(identity.projectorId);
      let cache = this.readCache();
      if (cache === undefined) {
        cache = this.beginRebuild(projector, "cache-missing");
      } else if (cache.phase === "READY" && cache.projectorVersion !== projector.projectorVersion) {
        cache = this.beginRebuild(projector, "projector-version-mismatch");
      } else if (cache.phase === "REBUILDING" && cache.targetProjectorVersion !== projector.projectorVersion) {
        // The author changed its declared version while a previous rebuild was
        // unfinished. Discard only the derived accumulator and restart from
        // the source; the Tag DO remains the sole event authority.
        cache = this.beginRebuild(projector, "target-projector-version-changed");
      }

      if (cache.phase === "READY") {
        return await this.beginDeltaOrRespondReady(identity, projector, cache);
      }
      return await this.continueRebuild(identity, projector, cache);
    } catch (caught) {
      if (caught instanceof TagStateIdentityConflict) {
        return error(409, "tag_state_identity_conflict", "TagState Durable Object identity changed");
      }
      if (caught instanceof TagStateUnknownProjector) {
        return error(404, "tag_state_unknown_projector", "TagState projector is not registered");
      }
      if (caught instanceof TagStateRegistryFailure) {
        return error(503, "tag_state_projector_registry_failure", "TagState projector registry is unavailable");
      }
      if (caught instanceof TagStateSourceFailure) {
        return error(caught.status, "tag_state_source_frontier_failure", "TagState source frontier could not be read");
      }
      if (caught instanceof TagStateCacheCorruption) {
        // A corrupt cache is deliberately not an empty state. Start the
        // source-backed rebuild now, then make this read distinguishable from
        // both a normal empty tag and a later rebuild-in-progress response.
        try {
          const projector = this.resolveProjector(identity.projectorId);
          this.beginRebuild(projector, "cache-corrupt");
        } catch (rebuildFailure) {
          if (rebuildFailure instanceof TagStateRegistryFailure) {
            return error(503, "tag_state_projector_registry_failure", "TagState projector registry is unavailable");
          }
        }
        return error(409, "tag_state_cache_corrupt", "TagState cache is corrupt and is rebuilding");
      }
      if (caught instanceof TagStateCheckpointFault) {
        return error(503, "tag_state_rebuild_interrupted", "TagState replay checkpoint was interrupted");
      }
      return error(503, "tag_state_unavailable", "TagState cache is unavailable");
    }
  }

  private async beginDeltaOrRespondReady(
    identity: TagStateObjectIdentity,
    projector: TagStateProjector,
    cache: ReadyCache,
  ): Promise<Response> {
    // Freeze the next delta before changing durable phase. A zero-event page
    // completes immediately and preserves the legitimate empty initial state.
    const page = await this.readSource(identity, cache.lastSuid, undefined);
    if (page.events.length === 0 && page.completeThrough !== null) {
      return json(this.success(projector, cache.stateJson, cache.lastSuid));
    }
    const rebuild = this.beginRebuild(projector, "normal-delta", {
      cursor: cache.lastSuid,
      accumulatorJson: cache.stateJson,
      frozenThrough: page.through,
    });
    return this.foldAndCheckpoint(projector, rebuild, page);
  }

  private async continueRebuild(
    identity: TagStateObjectIdentity,
    projector: TagStateProjector,
    cache: RebuildingCache,
  ): Promise<Response> {
    const page = await this.readSource(identity, cache.replayCursor, cache.frozenThrough);
    return this.foldAndCheckpoint(projector, cache, page);
  }

  private async foldAndCheckpoint(
    projector: TagStateProjector,
    cache: RebuildingCache,
    page: G43TagStateIncrementalPage,
  ): Promise<Response> {
    let state: unknown;
    try {
      state = projector.deserializeState(cache.accumulatorJson);
      for (const event of page.events) state = projector.apply(state, projectionEventFromTagEvent(event));
    } catch (caught) {
      throw new TagStateCacheCorruption(caught);
    }
    let accumulatorJson: string;
    try {
      accumulatorJson = projector.serializeState(state);
    } catch (caught) {
      throw new TagStateCacheCorruption(caught);
    }

    if (this.g46CheckpointFault === "before-checkpoint") throw new TagStateCheckpointFault();
    const complete = page.completeThrough !== null;
    this.transaction(() => {
      const sql = this.sql();
      if (complete) {
        sql.exec(`
          UPDATE tag_state_cache
          SET phase = 'READY', projector_version = ?, state_json = ?, last_suid = ?,
              target_projector_version = NULL, frozen_through = NULL, replay_cursor = NULL,
              accumulator_json = NULL, rebuild_id = NULL
          WHERE singleton = 1
        `, projector.projectorVersion, accumulatorJson, page.completeThrough!);
      } else {
        sql.exec(`
          UPDATE tag_state_cache
          SET frozen_through = ?, replay_cursor = ?, accumulator_json = ?
          WHERE singleton = 1 AND phase = 'REBUILDING' AND rebuild_id = ?
        `, page.through, page.lastSortableUniqueId, accumulatorJson, cache.rebuildId);
      }
    });
    if (this.g46CheckpointFault === "after-checkpoint") throw new TagStateCheckpointFault();

    if (!complete) {
      return error(503, "tag_state_rebuild_in_progress", "TagState replay is rebuilding to its frozen frontier");
    }
    return json(this.success(projector, accumulatorJson, page.completeThrough!));
  }

  private success(projector: TagStateProjector, stateJson: string, lastSortedUniqueId: string): TagStateReadSuccess {
    try {
      const state = projector.deserializeState(stateJson);
      return {
        kind: "ready",
        payload: projector.payload(state),
        version: projector.version(state),
        lastSortedUniqueId,
        projectorVersion: projector.projectorVersion,
      };
    } catch (caught) {
      throw new TagStateCacheCorruption(caught);
    }
  }

  private async readSource(
    identity: TagStateObjectIdentity,
    cursor: string,
    through: string | null | undefined,
  ): Promise<G43TagStateIncrementalPage> {
    if (cursor !== "") assertSortableUniqueId(cursor);
    if (through !== undefined && through !== null && through !== "") assertSortableUniqueId(through);
    try {
      const namespace = this.g46SourceNamespace ?? this.env.TAG;
      const stub = namespace.get(scopeIdFor(namespace, {
        serviceId: identity.serviceId,
        doClass: "tag",
        identity: identity.tag,
      })) as unknown as TagStateSourceStub;
      const sourceUrl = new URL("https://tag-source.internal/__internal/g46/tag-state-incremental");
      sourceUrl.searchParams.set("__tag", identity.tag);
      sourceUrl.searchParams.set("__serviceId", identity.serviceId);
      const response = await stub.fetch(new Request(sourceUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sdt-g46-source-read": "1",
        },
        body: JSON.stringify({
          tag: identity.tag,
          cursor,
          limit: TAG_STATE_SOURCE_PAGE_LIMIT,
          ...(through === undefined || through === null ? {} : { through }),
        }),
      }));
      if (response.status !== 200) {
        const detail = await response.text();
        const identityConflict = response.status === 409;
        throw new TagStateSourceFailure(identityConflict ? 409 : 503, new Error(detail));
      }
      const page = await response.json<G43TagStateIncrementalPage>();
      this.assertSourcePage(cursor, through, page);
      return page;
    } catch (caught) {
      if (caught instanceof TagStateSourceFailure) throw caught;
      const identityConflict = caught instanceof Error && caught.name === "TagIdentityConflict";
      throw new TagStateSourceFailure(identityConflict ? 409 : 503, caught);
    }
  }

  private assertSourcePage(
    cursor: string,
    expectedThrough: string | null | undefined,
    page: G43TagStateIncrementalPage,
  ): void {
    if (!isObject(page) || !Array.isArray(page.events) || typeof page.lastSortableUniqueId !== "string" ||
      typeof page.through !== "string" || (page.completeThrough !== null && typeof page.completeThrough !== "string")) {
      throw new TagStateSourceFailure(503, new Error("TagState source response was malformed"));
    }
    if (expectedThrough !== undefined && expectedThrough !== null && page.through !== expectedThrough) {
      throw new TagStateSourceFailure(503, new Error("TagState source changed its frozen frontier"));
    }
    if (page.through !== "") assertSortableUniqueId(page.through);
    let prior = cursor;
    for (const event of page.events as readonly TagEvent[]) {
      assertSortableUniqueId(event.suid);
      if (prior !== "" && compareSortableUniqueId(event.suid, prior) <= 0) {
        throw new TagStateSourceFailure(503, new Error("TagState source cursor did not advance"));
      }
      if (page.through !== "" && compareSortableUniqueId(event.suid, page.through) > 0) {
        throw new TagStateSourceFailure(503, new Error("TagState source read beyond its frozen frontier"));
      }
      prior = event.suid;
    }
    const expectedLast = page.events.length === 0 ? cursor : prior;
    if (page.lastSortableUniqueId !== expectedLast) {
      throw new TagStateSourceFailure(503, new Error("TagState source cursor/result mismatch"));
    }
    if (page.completeThrough !== null && page.completeThrough !== page.through) {
      throw new TagStateSourceFailure(503, new Error("TagState source completion frontier mismatch"));
    }
  }

  private resolveProjector(projectorId: string): TagStateProjector {
    try {
      const registry = this.registry;
      if (registry === undefined) {
        throw new TagStateRegistryFailure(new Error("TagState projector registry was not installed by the runtime composition"));
      }
      const projector = registry.resolve(projectorId);
      if (projector === undefined) throw new TagStateUnknownProjector();
      return projector;
    } catch (caught) {
      if (caught instanceof TagStateUnknownProjector || caught instanceof TagStateRegistryFailure) throw caught;
      throw new TagStateRegistryFailure(caught);
    }
  }

  private ensureIdentity(identity: TagStateObjectIdentity): void {
    const row = this.sql().exec<SqlRow>(`
      SELECT service_id, tag, projector_id
      FROM tag_state_identity
      WHERE singleton = 1
    `).toArray()[0];
    if (row === undefined) {
      this.transaction(() => {
        this.sql().exec(`
          INSERT INTO tag_state_identity (singleton, service_id, tag, projector_id)
          VALUES (1, ?, ?, ?)
        `, identity.serviceId, identity.tag, identity.projectorId);
      });
      return;
    }
    if (
      sqlString(row.service_id, "tag_state_identity.service_id") !== identity.serviceId ||
      sqlString(row.tag, "tag_state_identity.tag") !== identity.tag ||
      sqlString(row.projector_id, "tag_state_identity.projector_id") !== identity.projectorId
    ) throw new TagStateIdentityConflict();
  }

  private readCache(): Cache | undefined {
    const row = this.sql().exec<SqlRow>(`
      SELECT phase, projector_version, state_json, last_suid,
             target_projector_version, frozen_through, replay_cursor,
             accumulator_json, rebuild_id
      FROM tag_state_cache
      WHERE singleton = 1
    `).toArray()[0];
    if (row === undefined) return undefined;
    const phase = sqlString(row.phase, "tag_state_cache.phase") as TagStatePhase;
    if (phase === "READY") {
      return {
        phase,
        projectorVersion: sqlString(row.projector_version, "tag_state_cache.projector_version"),
        stateJson: sqlString(row.state_json, "tag_state_cache.state_json"),
        lastSuid: sqlString(row.last_suid, "tag_state_cache.last_suid"),
      };
    }
    if (phase === "REBUILDING") {
      return {
        phase,
        targetProjectorVersion: sqlString(row.target_projector_version, "tag_state_cache.target_projector_version"),
        frozenThrough: sqlNullableString(row.frozen_through, "tag_state_cache.frozen_through"),
        replayCursor: sqlString(row.replay_cursor, "tag_state_cache.replay_cursor"),
        accumulatorJson: sqlString(row.accumulator_json, "tag_state_cache.accumulator_json"),
        rebuildId: sqlString(row.rebuild_id, "tag_state_cache.rebuild_id"),
      };
    }
    throw new TagStateCacheCorruption(new Error("TagState cache phase was invalid"));
  }

  private beginRebuild(
    projector: TagStateProjector,
    _reason: "cache-missing" | "projector-version-mismatch" | "target-projector-version-changed" | "normal-delta" | "cache-corrupt",
    existing: Readonly<{
      cursor: string;
      accumulatorJson: string;
      frozenThrough: string;
    }> | undefined = undefined,
  ): RebuildingCache {
    let accumulatorJson: string;
    try {
      accumulatorJson = existing?.accumulatorJson ?? projector.serializeState(projector.initialState());
      // Validate the serialized state before it becomes a durable rebuild
      // accumulator. A bad registry reducer is a registry failure, not an
      // empty successful projection.
      projector.deserializeState(accumulatorJson);
    } catch (caught) {
      throw new TagStateRegistryFailure(caught);
    }
    const rebuild: RebuildingCache = {
      phase: "REBUILDING",
      targetProjectorVersion: projector.projectorVersion,
      frozenThrough: existing?.frozenThrough ?? null,
      replayCursor: existing?.cursor ?? "",
      accumulatorJson,
      rebuildId: crypto.randomUUID(),
    };
    this.transaction(() => {
      this.sql().exec(`
        INSERT INTO tag_state_cache (
          singleton, phase, projector_version, state_json, last_suid,
          target_projector_version, frozen_through, replay_cursor,
          accumulator_json, rebuild_id
        ) VALUES (1, 'REBUILDING', NULL, NULL, '', ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          phase = excluded.phase,
          projector_version = NULL,
          state_json = NULL,
          last_suid = '',
          target_projector_version = excluded.target_projector_version,
          frozen_through = excluded.frozen_through,
          replay_cursor = excluded.replay_cursor,
          accumulator_json = excluded.accumulator_json,
          rebuild_id = excluded.rebuild_id
      `, rebuild.targetProjectorVersion, rebuild.frozenThrough, rebuild.replayCursor, rebuild.accumulatorJson, rebuild.rebuildId);
    });
    return rebuild;
  }

  private sql(): SqlStorage {
    const sql = this.ctx.storage.sql;
    if (typeof sql?.exec !== "function") throw new Error("TagState Durable Object requires SQLite storage");
    return sql;
  }

  private transaction(callback: () => void): void {
    const storage = this.ctx.storage as DurableObjectStorage & {
      transactionSync?: (closure: () => void) => void;
    };
    if (typeof storage.transactionSync !== "function") {
      throw new Error("TagState Durable Object requires SQLite transactionSync");
    }
    storage.transactionSync(callback);
  }
}
