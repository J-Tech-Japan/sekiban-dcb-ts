import { outboxIdentity, systemPipelineClock, type DownstreamOutboxMessage, type PipelineClock } from "./types";
import { scopeIdFor } from "../scope/ScopeName";
import type { G60DurableHopObserver } from "../diagnostics/G60DurableHop";

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

/**
 * The ordinary runtime predates the G44 D1 global-array authority and keeps
 * its historical transport acknowledgement for its private operational
 * endpoint.  The Cloudflare-only runtime opts into `global-receipt` below;
 * that branch is deliberately not selected by a rollout flag.
 */
export interface OutboxDrainOptions {
  readonly acknowledgement?: "transport" | "global-receipt";
  /** G60 observation is scheduled by the active Worker context. */
  readonly durableHopObserver?: G60DurableHopObserver;
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

function identity(message: DownstreamOutboxMessage) {
  return {
    attemptId: message.attemptId,
    eventId: message.eventId,
    suid: message.suid,
    allocatorLineageId: message.allocatorLineageId,
    payload: message.payload,
    eventType: message.eventType,
    provenance: message.provenance,
    timestamp: message.timestamp,
    causationId: message.causationId,
    correlationId: message.correlationId,
    executedUser: message.executedUser,
    // Legacy transport acknowledgement still has to present the full G43
    // source fact because TagDurableObject rejects a lossy identity.
    completeness: message.completeness,
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
  const stub = env.TAG.get(scopeIdFor(env.TAG, {
    serviceId: input.serviceId,
    doClass: "tag",
    identity: input.tag,
  }));
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
 * A row gains its durable enqueuedAt fact before the first send. Queue send
 * is only transport acceptance: G44 deliberately leaves the source pending
 * until the receiver has atomically written and read back the global receipt
 * plus committed-membership join. An interruption therefore replays safely.
 */
export async function drainTagOutbox(
  input: DrainTagInput,
  env: OutboxDrainEnv,
  clock: PipelineClock = systemPipelineClock,
  options: OutboxDrainOptions = {},
): Promise<DrainResult> {
  // Queue-triggered draining is an explicit retry attempt. The source's
  // `next_attempt_at` controls automatic alarm wakes, but must not suppress a
  // caller that is already actively draining the durable obligation.
  const pending = await tagPost(env, input, "/outbox/pending", { nowMs: clock.now(), force: true });
  if (!pending.ok) {
    throw new Error(`Tag outbox pending read failed with ${pending.status}`);
  }
  const body = await pending.json<OutboxPendingResponse>();
  let delivered = 0;
  for (const row of body.rows) {
    await env.DOWNSTREAM_QUEUE.send(row, { contentType: "json" });
    options.durableHopObserver?.observe({
      stage: "queue-send-returned",
      serviceId: input.serviceId,
      eventId: row.eventId,
      suid: row.suid,
      attemptId: row.attemptId,
      partitionTag: input.tag,
      transport: "queue",
      observedAt: clock.now(),
    });
    if (options.acknowledgement === "global-receipt") {
      // G44 Queue handoff is only transport acceptance.  The D1 receiver
      // performs the source acknowledgement after its atomic event,
      // membership, and receipt join has been read back.
      delivered += 1;
      continue;
    }
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
export async function handleOutboxDrainRequest(
  request: Request,
  env: OutboxDrainEnv,
  options: OutboxDrainOptions = {},
): Promise<Response> {
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
      results.push(await drainTagOutbox({ serviceId: body.serviceId, tag }, env, systemPipelineClock, options));
    }
    return json({ results });
  } catch (error) {
    return json({
      error: error instanceof Error ? error.message : "Outbox drain failed",
      code: "outbox_drain_failed",
    }, 503);
  }
}
