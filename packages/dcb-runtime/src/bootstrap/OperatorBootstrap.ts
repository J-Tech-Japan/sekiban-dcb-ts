import { parseBootstrapDump } from "./manifest";
import { createBootstrapStoreAdapter } from "./BootstrapStoreAdapter";
import type { StoreProvider, StoreProviderEnvironment } from "../store/provider";

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
  readonly REPAIR_OPERATOR_TOKEN: string;
}

/** Bearer-only operator lane. Incoming headers are never forwarded to a DO. */
export async function handleOperatorBootstrap(request: Request, env: OperatorBootstrapEnv, storeProvider: StoreProvider): Promise<Response> {
  const denied = bearer(request, env.REPAIR_OPERATOR_TOKEN); if (denied !== undefined) return denied;
  const url = new URL(request.url); const match = url.pathname.match(/^\/operator\/bootstrap\/([^/]+)\/(plan|import|status|abort)$/);
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
  return invoke("/ready", body);
}
