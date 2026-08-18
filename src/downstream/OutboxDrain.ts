import { outboxIdentity, systemPipelineClock, type DownstreamOutboxMessage, type OutboxDelivery, type PipelineClock } from "./types";

interface OutboxPendingResponse {
  rows: DownstreamOutboxMessage[];
}

interface OutboxMarkResponse {
  marked: number;
}

export interface OutboxDrainEnv {
  TAG: DurableObjectNamespace;
  DOWNSTREAM_QUEUE: Queue<DownstreamOutboxMessage>;
}

export interface DrainTagInput {
  serviceId: string;
  tag: string;
}

export interface DrainResult {
  serviceId: string;
  tag: string;
  delivered: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDrainRequest(value: unknown): value is { serviceId: string; tags: string[] } {
  return isObject(value) && isNonEmptyString(value.serviceId) && Array.isArray(value.tags) &&
    value.tags.length > 0 && value.tags.every(isNonEmptyString) && new Set(value.tags).size === value.tags.length;
}

function identity(message: DownstreamOutboxMessage): OutboxDelivery {
  return {
    attemptId: message.attemptId,
    eventId: message.eventId,
    suid: message.suid,
    payload: message.payload,
    enqueuedAt: message.enqueuedAt,
    deliveredAt: null,
  };
}

async function tagPost(
  env: Pick<OutboxDrainEnv, "TAG">,
  input: DrainTagInput,
  path: string,
  body: unknown,
): Promise<Response> {
  const stub = env.TAG.get(env.TAG.idFromName(`${input.serviceId}|${input.tag}`));
  const url = new URL(`https://outbox-drain.internal${path}`);
  url.searchParams.set("__tag", input.tag);
  url.searchParams.set("__serviceId", input.serviceId);
  return stub.fetch(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

/**
 * A row gains its durable enqueuedAt fact before the first send. Only a
 * successful Queue send is followed by the idempotent delivered mark; an
 * interruption in between intentionally replays the same message later.
 */
export async function drainTagOutbox(
  input: DrainTagInput,
  env: OutboxDrainEnv,
  clock: PipelineClock = systemPipelineClock,
): Promise<DrainResult> {
  const pending = await tagPost(env, input, "/outbox/pending", { nowMs: clock.now() });
  if (!pending.ok) {
    throw new Error(`Tag outbox pending read failed with ${pending.status}`);
  }
  const body = await pending.json<OutboxPendingResponse>();
  let delivered = 0;
  for (const row of body.rows) {
    await env.DOWNSTREAM_QUEUE.send(row, { contentType: "json" });
    const mark = await tagPost(env, input, "/outbox/mark-delivered", {
      deliveries: [identity(row)],
      nowMs: clock.now(),
    });
    if (!mark.ok) {
      throw new Error(`Tag outbox delivered mark failed with ${mark.status} for ${outboxIdentity(row)}`);
    }
    const markBody = await mark.json<OutboxMarkResponse>();
    delivered += markBody.marked;
  }
  return { ...input, delivered };
}

/** Internal operational trigger; it does not alter any V1 public endpoint. */
export async function handleOutboxDrainRequest(request: Request, env: OutboxDrainEnv): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json<unknown>();
  } catch {
    return json({ error: "Outbox drain request must be JSON", code: "invalid_outbox_drain_request" }, 400);
  }
  if (!isDrainRequest(body)) {
    return json({ error: "serviceId and unique non-empty tags are required", code: "invalid_outbox_drain_request" }, 400);
  }
  try {
    const results: DrainResult[] = [];
    for (const tag of body.tags) {
      results.push(await drainTagOutbox({ serviceId: body.serviceId, tag }, env));
    }
    return json({ results });
  } catch (error) {
    return json({
      error: error instanceof Error ? error.message : "Outbox drain failed",
      code: "outbox_drain_failed",
    }, 503);
  }
}
