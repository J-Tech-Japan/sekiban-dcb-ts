import { PARTIAL_WRITE_FENCE_REASON, type TagEvent, type TagRecord } from "../tag/types";

const SERVICE_ID = "serialized-dcb-v1";
export const TEST_TAG_STATE_PROJECTOR = "test-projector";

type JsonObject = Record<string, unknown>;

interface ReadWorkerEnv {
  TAG: DurableObjectNamespace;
}

interface TagStateIdentity {
  tag: string;
  tagGroup: string;
  tagContent: string;
  tagProjector: string;
}

interface TagStateProjector {
  tagPayloadName: string;
  projectorVersion: string;
  payload(events: TagEvent[]): string;
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

function base64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

const TEST_PROJECTOR: TagStateProjector = {
  tagPayloadName: "SerializedDcbTestTagState",
  projectorVersion: "1",
  payload(events): string {
    return base64Json(events.map(({ eventId, payload, suid }) => ({ eventId, payload, suid })));
  },
};

const PROJECTORS = new Map<string, TagStateProjector>([[TEST_TAG_STATE_PROJECTOR, TEST_PROJECTOR]]);

function tagFromBody(value: unknown): { value?: string; error?: string } {
  return isObject(value) && isNonEmptyString(value.tag)
    ? { value: value.tag }
    : { error: "tag must be a non-empty string" };
}

function tagStateIdentityFrom(value: unknown): { value?: TagStateIdentity; error?: string } {
  if (!isObject(value) || !isNonEmptyString(value.tagStateId)) {
    return { error: "tagStateId must be a non-empty string" };
  }
  const parts = value.tagStateId.split(":");
  if (parts.length !== 3 || !parts.every(isNonEmptyString)) {
    return { error: "tagStateId must be group:content:projector" };
  }
  const [tagGroup, tagContent, tagProjector] = parts;
  if (!PROJECTORS.has(tagProjector!)) {
    return { error: "tagStateId names an unregistered projector" };
  }
  return {
    value: {
      tag: `${tagGroup}:${tagContent}`,
      tagGroup: tagGroup!,
      tagContent: tagContent!,
      tagProjector: tagProjector!,
    },
  };
}

/**
 * Read determinacy is a property of the fence's durable reason, never merely
 * of fence presence. A partial-write fence represents a known missing write;
 * a rotation fence can still expose an already-determinate snapshot.
 */
function isIndeterminateFencedState(record: TagRecord | undefined): boolean {
  return record?.fences.some((fence) => fence.reason === PARTIAL_WRITE_FENCE_REASON) ?? false;
}

/**
 * Minimal V1 read surface for the registered test projector. It intentionally
 * has no catch-up, query, list-query, or wait semantics; SDT-G6 owns those.
 */
export class SerializedReadWorker {
  constructor(private readonly env: ReadWorkerEnv) {}

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
        return this.latestSortable(body);
      }
      if (path === "/api/sekiban/serialized/tag-state") {
        return this.tagState(body);
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
    if (isIndeterminateFencedState(record)) {
      return error(500, "internal_error", "Tag head is indeterminate while a repair fence is held");
    }
    return json({
      exists: record !== undefined && record.head.length > 0,
      lastSortableUniqueId: record?.head ?? "",
    });
  }

  private async tagState(body: unknown): Promise<Response> {
    const parsed = tagStateIdentityFrom(body);
    if (parsed.value === undefined) {
      return error(400, "validation_error", parsed.error ?? "Invalid tag-state request");
    }
    const identity = parsed.value;
    const record = await this.readTag(identity.tag);
    if (isIndeterminateFencedState(record)) {
      return error(500, "internal_error", "Tag state is indeterminate while a repair fence is held");
    }
    const projector = PROJECTORS.get(identity.tagProjector)!;
    return json({
      payload: projector.payload(record?.events ?? []),
      version: record?.events.length ?? 0,
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
    const tagObject = this.env.TAG.get(this.env.TAG.idFromName(`${SERVICE_ID}|${tag}`));
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
  return new SerializedReadWorker(env).handle(request);
}
