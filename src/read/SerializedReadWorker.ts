import { catchUpDurableTagState } from "../projection/ProjectionRuntime";
import {
  DEPLOYED_PROJECTOR_REGISTRY,
  tagStateIdentityFrom,
  type TagStateIdentity,
} from "../projection/ProjectorRegistry";
import type { TagRecord } from "../tag/types";
import { SERIALIZED_DCB_SERVICE_ID, serviceIdForRequest } from "../http/testServiceId";

export { TEST_TAG_STATE_PROJECTOR } from "../projection/ProjectorRegistry";

type JsonObject = Record<string, unknown>;

interface ReadWorkerEnv {
  TAG: DurableObjectNamespace;
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

function tagStateIdentityFromBody(value: unknown): { value?: TagStateIdentity; error?: string } {
  if (!isObject(value) || !isNonEmptyString(value.tagStateId)) {
    return { error: "tagStateId must be a non-empty string" };
  }
  return tagStateIdentityFrom(value.tagStateId);
}

/**
 * V1 read surface. Tag-state validates a deploy-time projector and performs a
 * deterministic catch-up from the Tag DO's durable history. Its read decision
 * remains based on durable-state determinacy, never on fence presence/reason.
 */
export class SerializedReadWorker {
  constructor(
    private readonly env: ReadWorkerEnv,
    private readonly serviceId = SERIALIZED_DCB_SERVICE_ID,
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
    } catch {
      return error(500, "internal_error", "Read could not determine the durable tag state");
    }
  }

  private async latestSortable(body: unknown): Promise<Response> {
    const parsed = tagFromBody(body);
    if (parsed.value === undefined) {
      return error(400, "validation_error", parsed.error ?? "Invalid tag-latest-sortable request");
    }
    const record = await this.readTag(parsed.value);
    return json({
      exists: record !== undefined && record.head.length > 0,
      lastSortableUniqueId: record?.head ?? "",
    });
  }

  private async tagState(body: unknown): Promise<Response> {
    const parsed = tagStateIdentityFromBody(body);
    if (parsed.value === undefined) {
      return error(400, "validation_error", parsed.error ?? "Invalid tag-state request");
    }
    const identity = parsed.value;
    const projector = DEPLOYED_PROJECTOR_REGISTRY.resolve(identity.tagProjector);
    // tagStateIdentityFrom validates the same registry. Keep the guard so a
    // future registry implementation cannot turn a client mistake into 500.
    if (projector === undefined) {
      return error(400, "validation_error", "tagStateId names an unregistered projector");
    }
    const record = await this.readTag(identity.tag);
    const projected = catchUpDurableTagState(projector, record?.events ?? []);
    return json({
      payload: projected.payload,
      version: projected.version,
      lastSortedUniqueId: record?.head ?? "",
      tagGroup: identity.tagGroup,
      tagContent: identity.tagContent,
      tagProjector: identity.tagProjector,
      tagPayloadName: projector.tagPayloadName,
      projectorVersion: projector.projectorVersion,
    });
  }

  private async readTag(tag: string): Promise<TagRecord | undefined> {
    const url = new URL("https://serialized-read.internal/state");
    url.searchParams.set("__tag", tag);
    const tagObject = this.env.TAG.get(this.env.TAG.idFromName(`${this.serviceId}|${tag}`));
    const response = await tagObject.fetch(new Request(url));
    if (response.status === 404) {
      return undefined;
    }
    if (response.status !== 200) {
      throw new Error("Tag state lookup failed");
    }
    const record = (await response.json()) as TagRecord;
    if (record.tag !== tag) {
      throw new Error("Tag identity changed during read");
    }
    return record;
  }
}

export async function handleSerializedRead(request: Request, env: ReadWorkerEnv): Promise<Response> {
  return new SerializedReadWorker(env, serviceIdForRequest(request)).handle(request);
}
