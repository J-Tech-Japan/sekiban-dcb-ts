import { parseBootstrapDump } from "./manifest";
import { createBootstrapStoreAdapter } from "./BootstrapStoreAdapter";
import type { BootstrapManifest } from "./types";
import type { StoreProvider, StoreProviderEnvironment } from "../store/provider";
import { allocatorNameForService, type AllocatorState } from "../allocator/types";

type JsonObject = Record<string, unknown>;
function json(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } }); }
function object(value: unknown): value is JsonObject { return typeof value === "object" && value !== null && !Array.isArray(value); }
function bearer(request: Request, token: string): Response | undefined {
  const supplied = request.headers.get("authorization");
  // Keep absence indistinguishable from an undiscovered management surface.
  if (supplied === null) return json({ code: "not_found", error: "not found" }, 404);
  if (supplied !== `Bearer ${token}`) return json({ code: "operator_auth_required", error: "valid bearer required" }, 403);
  return undefined;
}

export interface OperatorBootstrapEnv extends StoreProviderEnvironment {
  readonly BOOTSTRAP: DurableObjectNamespace;
  readonly ALLOCATOR: DurableObjectNamespace;
  readonly REPAIR_OPERATOR_TOKEN: string;
}

/** Deployment composition may rebuild provider-specific read models after the
 * durable store and tag verification, but before the coordinator becomes READY. */
export interface OperatorBootstrapHooks {
  readonly afterVerifyBeforeReady?: (input: {
    readonly serviceId: string;
    readonly importId: string;
    readonly leaseEpoch: number;
    readonly manifest: BootstrapManifest;
  }) => Promise<void>;
}

/** Bearer-only operator lane. Incoming headers are never forwarded to a DO. */
export async function handleOperatorBootstrap(request: Request, env: OperatorBootstrapEnv, storeProvider: StoreProvider, hooks: OperatorBootstrapHooks = {}): Promise<Response> {
  const denied = bearer(request, env.REPAIR_OPERATOR_TOKEN); if (denied !== undefined) return denied;
  const url = new URL(request.url); const match = url.pathname.match(/^\/operator\/bootstrap\/([^/]+)\/(plan|import|status|abort|export)$/);
  if (match === null) return json({ code: "not_found", error: "not found" }, 404);
  const serviceId = decodeURIComponent(match[1]!); const operation = match[2]!;
  const coordinator = env.BOOTSTRAP.get(env.BOOTSTRAP.idFromName(serviceId));
  let body: unknown = {};
  if (operation !== "status") try { body = await request.json(); } catch { return json({ code: "bootstrap_body_invalid", error: "JSON body required" }, 400); }
  const invoke = (path: string, value: unknown, method = "POST") => {
    const internal = new URL(`https://bootstrap.internal${path}`); internal.searchParams.set("__serviceId", serviceId);
    return coordinator.fetch(new Request(internal, method === "GET" ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(value) }));
  };
  if (operation === "status") return invoke("/state", undefined, "GET");
  if (operation === "abort") return invoke("/abort", body);
  if (operation === "export") {
    if (!object(body) || typeof body.targetServiceId !== "string" || body.targetServiceId.length === 0 || "allocatorLineageId" in body) return json({ code: "bootstrap_export_invalid", error: "targetServiceId is required and allocator lineage is server-derived" }, 400);
    // A caller must not nominate a synthetic lineage. Initializing the target
    // service allocator first gives bootstrap and future commits one durable,
    // authoritative lineage source.
    const allocator = env.ALLOCATOR.get(env.ALLOCATOR.idFromName(allocatorNameForService(body.targetServiceId)));
    const allocatorState = await allocator.fetch(new Request("https://bootstrap.internal/state"));
    if (!allocatorState.ok) return json({ code: "bootstrap_allocator_unavailable", error: "target allocator state is unavailable" }, 503);
    const allocatorBody = await allocatorState.json<Partial<AllocatorState>>();
    if (typeof allocatorBody.allocatorLineageId !== "string" || allocatorBody.allocatorLineageId.length === 0) return json({ code: "bootstrap_allocator_invalid", error: "target allocator lineage is invalid" }, 500);
    const adapter = createBootstrapStoreAdapter(storeProvider.name, storeProvider.create(env));
    return json(await adapter.exportPage({ sourceServiceId: serviceId, targetServiceId: body.targetServiceId, allocatorLineageId: allocatorBody.allocatorLineageId, pageSize: typeof body.pageSize === "number" ? body.pageSize : 128 }));
  }
  if (operation === "plan") return invoke("/plan", body);
  if (!object(body) || !object(body.dump)) return json({ code: "bootstrap_dump_invalid", error: "import requires dump" }, 400);
  let dump; try { dump = parseBootstrapDump(body.dump); } catch { return json({ code: "bootstrap_dump_invalid", error: "invalid canonical dump" }, 400); }
  if (typeof body.importId !== "string" || typeof body.leaseEpoch !== "number") return json({ code: "bootstrap_epoch_rejected", error: "importId and leaseEpoch required" }, 409);
  const adapter = createBootstrapStoreAdapter(storeProvider.name, storeProvider.create(env));
  await adapter.admitBootstrap({ importId: body.importId, leaseEpoch: body.leaseEpoch, manifest: dump.manifest, events: dump.events });
  const imported = await invoke("/import", body);
  if (!imported.ok) return imported;
  const verified = await invoke("/verify", body); if (!verified.ok) return verified;
  await adapter.verifyBootstrap({ importId: body.importId, manifest: dump.manifest });
  try {
    await hooks.afterVerifyBeforeReady?.({ serviceId, importId: body.importId, leaseEpoch: body.leaseEpoch, manifest: dump.manifest });
  } catch {
    return json({ code: "bootstrap_read_model_rebuild_failed", error: "target read-model rebuild failed before READY" }, 503);
  }
  return invoke("/ready", body);
}
