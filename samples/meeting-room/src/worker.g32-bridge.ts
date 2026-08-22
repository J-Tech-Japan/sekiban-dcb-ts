import { WorkerEntrypoint } from "cloudflare:workers";
import {
  G32_BRIDGE_COMPONENTS,
  assertG32BridgeIdentity,
  bridgeWriterEntrypoints,
  frozenBridgeResponse,
  parseG32BridgeComponent,
  type G32BridgeComponent,
} from "./g32-bridge";

/**
 * Candidate B is intentionally a tiny old-format fence. It must not import
 * the final G32 runtime: the bridge's only data-plane outcome is a typed
 * freeze, so a failed cutover can still abort before any new-store write.
 */
export interface G32BridgeEnv {
  readonly G32_FREEZE_TOKEN?: string;
  readonly G32_FREEZE_TOKEN_FINGERPRINT?: string;
  readonly G32_BRIDGE_SOURCE_COMMIT?: string;
  readonly G32_BRIDGE_CONFIG_DIGEST?: string;
  readonly G32_BRIDGE_COMPONENT?: string;
  readonly SDT_SERVICE_ID?: string;
  readonly D1?: D1Database;
  readonly ALLOCATOR?: DurableObjectNamespace;
  readonly TAG?: DurableObjectNamespace;
  readonly BOOTSTRAP?: DurableObjectNamespace;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function identity(env: G32BridgeEnv): ReturnType<typeof bridgeIdentity> {
  return bridgeIdentity({
    sourceCommit: env.G32_BRIDGE_SOURCE_COMMIT,
    configDigest: env.G32_BRIDGE_CONFIG_DIGEST,
    tokenFingerprint: env.G32_FREEZE_TOKEN_FINGERPRINT,
    component: env.G32_BRIDGE_COMPONENT,
  });
}

export function bridgeIdentity(value: unknown) {
  assertG32BridgeIdentity(value);
  return Object.freeze(value);
}

function authenticated(request: Request, env: G32BridgeEnv): boolean {
  return typeof env.G32_FREEZE_TOKEN === "string" && env.G32_FREEZE_TOKEN.length > 0 &&
    request.headers.get("authorization") === `Bearer ${env.G32_FREEZE_TOKEN}`;
}

function component(env: G32BridgeEnv): G32BridgeComponent | undefined {
  return parseG32BridgeComponent(env.G32_BRIDGE_COMPONENT);
}

function bridgeAcknowledgement(env: G32BridgeEnv): Response {
  const bridge = identity(env);
  return json({
    task: "SDT-G32",
    phase: "bridge-freeze",
    component: bridge.component,
    sourceCommit: bridge.sourceCommit,
    configDigest: bridge.configDigest,
    tokenFingerprint: bridge.tokenFingerprint,
    writerEntrypoints: bridgeWriterEntrypoints(bridge.component),
    writerEntrypointComponents: G32_BRIDGE_COMPONENTS,
    oldFormatOnly: true,
    freezeActive: true,
  });
}

function requiredBridgeServiceId(env: G32BridgeEnv): string {
  if (typeof env.SDT_SERVICE_ID !== "string" || env.SDT_SERVICE_ID.length === 0) throw new Error("G32_BRIDGE_SERVICE_ID_INVALID");
  return env.SDT_SERVICE_ID;
}

function parseTags(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((tag) => typeof tag === "string" && tag.length > 0) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Explicitly discard the old outbox after B is acknowledged. The source
 * table is only an inventory key; no event payload or old SUID is interpreted
 * here. The final C uses a different queue and service identity.
 */
async function settleBridgeDispositions(env: G32BridgeEnv): Promise<Response> {
  const serviceId = requiredBridgeServiceId(env);
  if (env.D1 === undefined || env.TAG === undefined || env.ALLOCATOR === undefined || env.BOOTSTRAP === undefined) {
    return json({ error: "Bridge inventory bindings are unavailable", code: "bridge_bindings_unavailable" }, 503);
  }
  const rows = await env.D1.prepare("SELECT event_tags FROM serialized_dcb_events WHERE service_id = ?").bind(serviceId).all<{ event_tags: string }>();
  const tags = [...new Set((rows.results ?? []).flatMap((row) => parseTags(row.event_tags)))].sort();
  const discarded = await Promise.all(tags.map(async (tag) => {
    const object = env.TAG!.get(env.TAG!.idFromName(`${serviceId}|${tag}`));
    const response = await object.fetch("https://g32-bridge.internal/g32-bridge/discard", { method: "POST" });
    if (!response.ok) throw new Error(`G32 bridge tag disposition failed for ${tag}`);
    return response.json<{ outboxDiscarded?: number }>();
  }));
  const allocator = env.ALLOCATOR.get(env.ALLOCATOR.idFromName(`service-allocator:${serviceId}`));
  const bootstrap = env.BOOTSTRAP.get(env.BOOTSTRAP.idFromName(serviceId));
  const [allocatorResponse, bootstrapResponse] = await Promise.all([
    allocator.fetch("https://g32-bridge.internal/g32-bridge/discard", { method: "POST" }),
    bootstrap.fetch("https://g32-bridge.internal/g32-bridge/discard", { method: "POST" }),
  ]);
  if (!allocatorResponse.ok || !bootstrapResponse.ok) throw new Error("G32 bridge allocator/bootstrap disposition failed");
  const pipeline = await env.D1.prepare(
    `SELECT
       (SELECT COUNT(*) FROM serialized_dcb_pending_arrivals WHERE service_id = ?) AS pendingArrivals,
       (SELECT COUNT(*) FROM serialized_dcb_delivery_incidents WHERE service_id = ?) AS deliveryIncidents,
       (SELECT COUNT(*) FROM serialized_dcb_events WHERE service_id = ?) AS eventInventory`,
  ).bind(serviceId, serviceId, serviceId).first<Record<string, number>>();
  return json({
    task: "SDT-G32",
    phase: "bridge-freeze",
    serviceId,
    queueDisposition: "old-format messages are explicitly discarded by the bridge consumer; final C binds a new queue",
    tagInventory: tags.length,
    outboxDiscarded: discarded.reduce((total, value) => total + (value.outboxDiscarded ?? 0), 0),
    pipeline: pipeline ?? {},
    allocator: await allocatorResponse.json(),
    bootstrap: await bootstrapResponse.json(),
  });
}

class FrozenDurableObject implements DurableObject {
  constructor(private readonly state: DurableObjectState, private readonly role: string) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/g32-bridge/status") {
      return json({ role: this.role, alarmAt: await this.state.storage.getAlarm() });
    }
    if (url.pathname === "/g32-bridge/discard" && request.method === "POST") {
      // A bridge is permitted to settle an old queued/outbox disposition only
      // by discarding it. It never reconstructs or forwards an old event.
      const result = await this.state.storage.transaction(async (txn) => {
        const record = await txn.get<unknown>("tag");
        let outboxDiscarded = 0;
        if (typeof record === "object" && record !== null && !Array.isArray(record)) {
          const current = record as Record<string, unknown>;
          if (Array.isArray(current.outbox)) {
            outboxDiscarded = current.outbox.length;
            await txn.put("tag", { ...current, outbox: [] });
          }
        }
        await txn.deleteAlarm();
        return { role: this.role, outboxDiscarded, alarmAt: null };
      });
      return json(result);
    }
    return frozenBridgeResponse(this.role, "durable-object");
  }

  /** A pre-existing alarm is intentionally quiesced, never allowed to append. */
  async alarm(): Promise<void> {
    await this.state.storage.deleteAlarm();
  }
}

export class AllocatorDurableObject extends FrozenDurableObject {
  constructor(state: DurableObjectState) { super(state, "allocator-do"); }
}
export class JournalDurableObject extends FrozenDurableObject {
  constructor(state: DurableObjectState) { super(state, "journal-do"); }
}
export class TagDurableObject extends FrozenDurableObject {
  constructor(state: DurableObjectState) { super(state, "tag-do"); }
}
export class BootstrapCoordinatorDurableObject extends FrozenDurableObject {
  constructor(state: DurableObjectState) { super(state, "bootstrap-do"); }
}

/** Service-binding-only receiver. Any delayed old doorbell fails closed. */
export class MeetingRoomDownstreamDoorbell extends WorkerEntrypoint<G32BridgeEnv> {
  async deliver(): Promise<never> {
    throw new Error("G32_CUTOVER_FROZEN_DOORBELL");
  }
}

const worker: ExportedHandler<G32BridgeEnv> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/conformance/v1/g32-bridge") {
      if (!authenticated(request, env)) return json({ error: "Bridge acknowledgement authentication required", code: "unauthorized" }, 403);
      try {
        return bridgeAcknowledgement(env);
      } catch {
        return json({ error: "Bridge candidate identity is not sealed", code: "bridge_identity_invalid" }, 503);
      }
    }
    if (url.pathname === "/conformance/v1/g32-bridge/settle" && request.method === "POST") {
      if (!authenticated(request, env)) return json({ error: "Bridge settlement authentication required", code: "unauthorized" }, 403);
      try {
        identity(env);
        return await settleBridgeDispositions(env);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Bridge settlement failed", code: "bridge_settlement_failed" }, 503);
      }
    }
    return frozenBridgeResponse(component(env) ?? "unsealed-bridge", "fetch");
  },
  async queue(batch) {
    // Queue disposition is explicit discard after the primary bridge is
    // active. This is the only way an old-format message settles; it cannot
    // reach a Store, Tag DO append, doorbell, or final-C queue.
    batch.ackAll();
  },
  async scheduled() {
    // Cron is a writer entrypoint under the old runtime. Quiescence is the
    // only bridge action; the final candidate owns all resumed work.
  },
};

export default worker;
