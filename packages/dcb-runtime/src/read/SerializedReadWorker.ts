import {
  DEPLOYED_PROJECTOR_REGISTRY,
  type ProjectorRegistry,
  tagStateIdentitySyntaxFrom,
  type TagStateIdentity,
} from "../projection/ProjectorRegistry";
import { safeWindowCeilingExceeded } from "../projection/ProjectionRuntime";
import type { StoreProvider } from "../store/provider";
import type { TagRecord } from "../tag/types";
import type { TagStateReadSuccess } from "../tagstate/TagStateDurableObject";
import { scopeIdFor, tagStateScopeIdentity } from "../scope/ScopeName";
import {
  envServiceIdentity,
  requestServiceIdentity,
  type ServiceIdentityProvider,
} from "../service/ServiceIdentityProvider";

export { TEST_TAG_STATE_PROJECTOR } from "../projection/ProjectorRegistry";

type JsonObject = Record<string, unknown>;

interface ReadWorkerEnv {
  TAG: DurableObjectNamespace;
  /** SQLite-backed cache/replay owner for (serviceId, tag, projector). */
  TAG_STATE?: DurableObjectNamespace;
  POSTGRES_URL?: string;
  HYPERDRIVE?: Hyperdrive;
  /** Optional explicit D1 provider binding; Postgres remains the default. */
  D1?: D1Database;
  /** Set only by an authenticated deployment-verification lane. */
  G11_VERIFICATION_ENABLED?: string;
  /** Non-secret service identity configured per deployment. */
  SDT_SERVICE_ID?: string;
}

class ReadFailure extends Error {
  constructor(
    readonly failingSubCall: "ensureWindowDeterminate" | "readTag",
    cause: unknown,
    readonly diagnostic?: Record<string, unknown>,
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message);
    this.name = cause instanceof Error ? cause.name : "UnknownError";
  }
}

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

function tagFromBody(value: unknown): { value?: string; error?: string } {
  return isObject(value) && isNonEmptyString(value.tag)
    ? { value: value.tag }
    : { error: "tag must be a non-empty string" };
}

function tagStateIdentityFromBody(
  value: unknown,
): { value?: TagStateIdentity; error?: string } {
  if (!isObject(value) || !isNonEmptyString(value.tagStateId)) {
    return { error: "tagStateId must be a non-empty string" };
  }
  return tagStateIdentitySyntaxFrom(value.tagStateId);
}

/**
 * V1 read surface. Tag-state validates a deploy-time projector and delegates
 * its cache/replay to TagStateDO. It intentionally does not call the D1
 * SafeWindow authority: the Tag-local G43 source RPC is the single source on
 * this path, while latest-sortable retains its existing SafeWindow rule.
 */
export class SerializedReadWorker {
  constructor(
    private readonly env: ReadWorkerEnv,
    private readonly serviceId: string,
    private readonly registry: ProjectorRegistry = DEPLOYED_PROJECTOR_REGISTRY,
    private readonly storeProvider?: StoreProvider,
  ) {}

  async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") {
      return error(404, "read_route_not_found", "Read routes require POST");
    }
    let body: unknown;
    try {
      body = await request.json<unknown>();
    } catch {
      return error(400, "validation_error", "Read request must be JSON");
    }
    try {
      if (path === "/api/sekiban/serialized/tag-latest-sortable") {
        return await this.latestSortable(body);
      }
      if (path === "/api/sekiban/serialized/tag-state") {
        return await this.tagState(body);
      }
      return error(404, "read_route_not_found", "Read route was not found");
    } catch (caught) {
      const body: JsonObject = { error: "Read could not determine the durable tag state", code: "internal_error" };
      if (this.env.G11_VERIFICATION_ENABLED === "true" && caught instanceof ReadFailure) {
        body.detail = {
          errorClass: caught.name,
          message: caught.message,
          failingSubCall: caught.failingSubCall,
          ...caught.diagnostic,
        };
      }
      return json(body, 500);
    }
  }

  private async latestSortable(body: unknown): Promise<Response> {
    const parsed = tagFromBody(body);
    if (parsed.value === undefined) {
      return error(400, "validation_error", parsed.error ?? "Invalid tag-latest-sortable request");
    }
    await this.ensureWindowDeterminate();
    const record = await this.readTag(parsed.value);
    return json({
      // Tag existence is the durable Tag record's fact, not a proxy for the
      // record having emitted an event.  A created/identified tag can have an
      // empty head and must still be observable as existing.
      exists: record !== undefined,
      lastSortableUniqueId: record?.head ?? "",
    });
  }

  private async tagState(body: unknown): Promise<Response> {
    const parsed = tagStateIdentityFromBody(body);
    if (parsed.value === undefined) {
      return error(400, "validation_error", parsed.error ?? "Invalid tag-state request");
    }
    const identity = parsed.value;
    let projector;
    try {
      projector = this.registry.resolve(identity.tagProjector);
    } catch {
      return error(503, "tag_state_projector_registry_failure", "Tag-state projector registry is unavailable");
    }
    if (projector === undefined) {
      return error(404, "tag_state_unknown_projector", "Tag-state projector is not registered");
    }
    if (this.env.TAG_STATE === undefined) {
      return error(503, "tag_state_source_frontier_failure", "Tag-state cache binding is unavailable");
    }
    const stateObject = this.env.TAG_STATE.get(scopeIdFor(this.env.TAG_STATE, {
      serviceId: this.serviceId,
      doClass: "tag-state",
      identity: tagStateScopeIdentity(identity.tag, identity.tagProjector),
    }));
    let cached: Response;
    try {
      cached = await stateObject.fetch(new Request("https://tag-state.internal/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serviceId: this.serviceId,
          tag: identity.tag,
          projectorId: identity.tagProjector,
        }),
      }));
    } catch {
      return error(503, "tag_state_source_frontier_failure", "Tag-state source cache could not be reached");
    }
    if (cached.status !== 200) return cached;
    let projected: TagStateReadSuccess;
    try {
      projected = await cached.json<TagStateReadSuccess>();
    } catch {
      return error(503, "tag_state_cache_corrupt", "Tag-state cache returned an invalid result");
    }
    if (
      projected.kind !== "ready" || typeof projected.payload !== "string" ||
      !Number.isSafeInteger(projected.version) || typeof projected.lastSortedUniqueId !== "string" ||
      projected.projectorVersion !== projector.projectorVersion
    ) {
      return error(503, "tag_state_cache_corrupt", "Tag-state cache returned an inconsistent result");
    }
    return json({
      payload: projected.payload,
      version: projected.version,
      lastSortedUniqueId: projected.lastSortedUniqueId,
      tagGroup: identity.tagGroup,
      tagContent: identity.tagContent,
      tagProjector: identity.tagProjector,
      tagPayloadName: projector.tagPayloadName,
      projectorVersion: projector.projectorVersion,
    });
  }

  private async ensureWindowDeterminate(): Promise<void> {
    // Direct unit tests can exercise Tag DO determinacy with only TAG. The
    // default provider has no backing store in that fixture. An explicit
    // provider (including Cosmos) is always checked when it is configured.
    if (this.storeProvider === undefined || this.storeProvider.isConfigured?.(this.env) === false) {
      return;
    }
    try {
      const store = this.storeProvider.create(this.env);
      await store.initialize();
      const nowMs = Date.now();
      const diagnostic = await store.lagBoundDiagnostics?.(this.serviceId, nowMs);
      const dynamicLagBoundMs = diagnostic?.dynamicLagBoundMs ?? await store.currentLagBound(this.serviceId, nowMs);
      if (safeWindowCeilingExceeded(dynamicLagBoundMs)) {
        throw new ReadFailure("ensureWindowDeterminate", new Error("Read-side SafeWindow ceiling exceeded; durable state is indeterminate"), diagnostic);
      }
    } catch (caught) {
      if (caught instanceof ReadFailure) throw caught;
      throw new ReadFailure("ensureWindowDeterminate", caught);
    }
  }

  private async readTag(tag: string): Promise<TagRecord | undefined> {
    const url = new URL("https://serialized-read.internal/state");
    url.searchParams.set("__tag", tag);
    url.searchParams.set("__serviceId", this.serviceId);
    const tagObject = this.env.TAG.get(scopeIdFor(this.env.TAG, {
      serviceId: this.serviceId,
      doClass: "tag",
      identity: tag,
    }));
    try {
      const response = await tagObject.fetch(new Request(url));
      if (response.status === 404) return undefined;
      if (response.status !== 200) throw new Error("Tag state lookup failed");
      const record = (await response.json()) as TagRecord;
      if (record.tag !== tag) throw new Error("Tag identity changed during read");
      return record;
    } catch (caught) {
      throw new ReadFailure("readTag", caught);
    }
  }
}

export async function handleSerializedRead(
  request: Request,
  env: ReadWorkerEnv,
  registry: ProjectorRegistry = DEPLOYED_PROJECTOR_REGISTRY,
  storeProvider?: StoreProvider,
  serviceIdentityProvider?: ServiceIdentityProvider,
): Promise<Response> {
  return new SerializedReadWorker(env, requestServiceIdentity(request, serviceIdentityProvider ?? envServiceIdentity(env), {
    allowG11Verification: env.G11_VERIFICATION_ENABLED === "true",
  }), registry, storeProvider).handle(request);
}
