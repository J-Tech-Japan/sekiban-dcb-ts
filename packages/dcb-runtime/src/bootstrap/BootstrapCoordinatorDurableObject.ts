import { parseBootstrapDump } from "./manifest";
import type { BootstrapManifestError } from "./manifest";
import type { BootstrapControlRecord, BootstrapDump } from "./types";

const CONTROL = "bootstrap-control";
const DUMP = "bootstrap-dump";
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const epoch = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const reject = (code: string, message: string, status = 409) => response({ code, error: message }, status);

interface BootstrapCoordinatorEnv { TAG: DurableObjectNamespace; ALLOCATOR: DurableObjectNamespace; }
function empty(serviceId: string): BootstrapControlRecord {
  return { schemaVersion: 1, status: "EMPTY", importId: null, targetServiceId: serviceId, allocatorLineageId: null, source: null, digest: null, manifest: null, progress: {}, leaseEpoch: 0, leaseUntil: null, failure: null, readyAt: null, normalInFlight: 0 };
}
function expired(control: BootstrapControlRecord): boolean { return control.leaseUntil !== null && control.leaseUntil <= Date.now(); }

/**
 * Per-target-service durable bootstrap authority.  The control record is the
 * linearization point for both command admission and EMPTY -> PLANNED.
 */
export class BootstrapCoordinatorDurableObject implements DurableObject {
  constructor(private readonly ctx: DurableObjectState, private readonly env: BootstrapCoordinatorEnv) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url); const serviceId = url.searchParams.get("__serviceId");
    if (!string(serviceId)) return reject("bootstrap_service_required", "target service identity is required", 400);
    if (request.method === "GET" && url.pathname === "/state") return response(await this.control(serviceId));
    let body: unknown; try { body = await request.json(); } catch { return reject("bootstrap_body_invalid", "JSON body is required", 400); }
    if (request.method !== "POST") return reject("bootstrap_route_not_found", "bootstrap route was not found", 404);
    if (url.pathname === "/plan") return this.plan(serviceId, body);
    if (url.pathname === "/import") return this.import(serviceId, body);
    if (url.pathname === "/verify") return this.verify(serviceId, body);
    if (url.pathname === "/ready") return this.ready(serviceId, body);
    if (url.pathname === "/command/admit") return this.command(serviceId, body, "admit");
    if (url.pathname === "/command/finalize") return this.command(serviceId, body, "finalize");
    if (url.pathname === "/command/release") return this.command(serviceId, body, "release");
    return reject("bootstrap_route_not_found", "bootstrap route was not found", 404);
  }

  private async control(serviceId: string): Promise<BootstrapControlRecord> { return (await this.ctx.storage.get<BootstrapControlRecord>(CONTROL)) ?? empty(serviceId); }
  private valid(control: BootstrapControlRecord, body: unknown): string | undefined {
    if (!object(body) || !string(body.importId) || !epoch(body.leaseEpoch)) return "bootstrap importId and leaseEpoch are required";
    if (control.importId !== body.importId || control.leaseEpoch !== body.leaseEpoch) return "bootstrap fencing epoch does not match";
    return undefined;
  }

  private async plan(serviceId: string, body: unknown): Promise<Response> {
    if (!object(body) || !string(body.importId) || !object(body.dump) || !object(body.targetEvidence) || typeof body.targetEvidence.bindingExists !== "boolean" || typeof body.targetEvidence.eventsExist !== "boolean") return reject("bootstrap_plan_invalid", "importId, dump, and explicit target evidence are required", 400);
    const importId = body.importId; let dump: BootstrapDump; try { dump = parseBootstrapDump(body.dump); } catch (failure) { const e = failure as BootstrapManifestError; return reject(e.code ?? "bootstrap_dump_invalid", e.message ?? "invalid dump", 400); }
    if (dump.manifest.target.serviceId !== serviceId) return reject("bootstrap_target_mismatch", "manifest target is not this coordinator service", 409);
    if (body.targetEvidence.bindingExists || body.targetEvidence.eventsExist) return reject("bootstrap_target_not_fresh", "existing binding or events forbid bootstrap without writes");
    const planned = await this.ctx.storage.transaction(async (txn) => {
      const control = (await txn.get<BootstrapControlRecord>(CONTROL)) ?? empty(serviceId);
      if (control.status === "READY") return { error: "bootstrap_ready_permanent" };
      if (control.status !== "EMPTY") {
        if (control.importId === importId && control.digest === dump.manifest.contentDigest) return { control };
        return { error: "bootstrap_plan_conflict" };
      }
      // This transaction is the service-scoped race point. A normal command
      // holds its admission only while it can still make durable mutations.
      if (control.normalInFlight !== 0) return { error: "bootstrap_normal_command_in_flight" };
      const next: BootstrapControlRecord = { ...control, status: "PLANNED", importId, allocatorLineageId: dump.manifest.target.allocatorLineageId, source: dump.manifest.source, digest: dump.manifest.contentDigest, manifest: dump.manifest, leaseEpoch: control.leaseEpoch + 1, leaseUntil: Date.now() + 30_000, failure: null };
      await txn.put(CONTROL, next); await txn.put(DUMP, dump); return { control: next };
    });
    return "error" in planned ? reject(planned.error ?? "bootstrap_plan_rejected", planned.error ?? "bootstrap plan rejected") : response(planned.control, planned.control.status === "PLANNED" ? 201 : 200);
  }

  private async import(serviceId: string, body: unknown): Promise<Response> {
    const control = await this.control(serviceId); const error = this.valid(control, body); if (error !== undefined) return reject("bootstrap_epoch_rejected", error);
    if (control.status !== "PLANNED" && control.status !== "IMPORTING" && control.status !== "FAILED") return reject("bootstrap_state_rejected", "import is not permitted in this state");
    if (expired(control)) return reject("bootstrap_lease_expired", "only a same-plan takeover may continue an expired lease");
    const dump = await this.ctx.storage.get<BootstrapDump>(DUMP); if (dump === undefined || control.manifest === null) return reject("bootstrap_plan_missing", "planned dump is unavailable", 500);
    const byTag = new Map<string, BootstrapDump["events"]>(); for (const event of dump.events) for (const tag of event.eventTags) byTag.set(tag, [...(byTag.get(tag) ?? []), event]);
    for (const [tag, events] of [...byTag.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const stub = this.env.TAG.get(this.env.TAG.idFromName(`${serviceId}|${tag}`));
      const tagUrl = new URL("https://bootstrap.internal/bootstrap/admit"); tagUrl.searchParams.set("__tag", tag); tagUrl.searchParams.set("__serviceId", serviceId);
      const admitted = await stub.fetch(new Request(tagUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ importId: control.importId, leaseEpoch: control.leaseEpoch, manifestDigest: control.digest, targetServiceId: serviceId, candidates: events.map((event) => ({ ...event, allocatorLineageId: control.allocatorLineageId })) }) }));
      if (!admitted.ok) return reject("bootstrap_tag_admission_failed", `tag ${tag} rejected bootstrap admission`, admitted.status);
    }
    const allocator = this.env.ALLOCATOR.get(this.env.ALLOCATOR.idFromName(serviceId));
    const seeded = await allocator.fetch(new Request("https://bootstrap.internal/seed-after", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ importId: control.importId, leaseEpoch: control.leaseEpoch, highWatermark: control.manifest.highWatermark ?? "suid-00000000000000000000000000000000" }) }));
    if (!seeded.ok) return reject("bootstrap_allocator_seed_failed", "allocator seedAfter rejected bootstrap", seeded.status);
    const next = await this.ctx.storage.transaction(async (txn) => { const current = await this.control(serviceId); if (current.importId !== control.importId || current.leaseEpoch !== control.leaseEpoch) throw new Error("bootstrap epoch advanced"); const updated: BootstrapControlRecord = { ...current, status: "VERIFYING", progress: Object.fromEntries([...byTag.entries()].map(([tag, events]) => [tag, events.at(-1)?.suid ?? null])) }; await txn.put(CONTROL, updated); return updated; });
    return response(next);
  }

  private async verify(serviceId: string, body: unknown): Promise<Response> { const control = await this.control(serviceId); const error = this.valid(control, body); if (error !== undefined) return reject("bootstrap_epoch_rejected", error); if (control.status !== "VERIFYING") return reject("bootstrap_state_rejected", "verify requires VERIFYING"); return response(control); }
  private async ready(serviceId: string, body: unknown): Promise<Response> {
    const control = await this.control(serviceId); const error = this.valid(control, body); if (error !== undefined) return reject("bootstrap_epoch_rejected", error); if (control.status !== "VERIFYING") return reject("bootstrap_state_rejected", "READY requires VERIFYING");
    const dump = await this.ctx.storage.get<BootstrapDump>(DUMP); if (dump === undefined) return reject("bootstrap_plan_missing", "planned dump is unavailable", 500);
    for (const tag of Object.keys(control.manifest!.tagCounts)) { const stub = this.env.TAG.get(this.env.TAG.idFromName(`${serviceId}|${tag}`)); const url = new URL("https://bootstrap.internal/bootstrap/close"); url.searchParams.set("__tag", tag); const closed = await stub.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ importId: control.importId, leaseEpoch: control.leaseEpoch }) })); if (!closed.ok) return reject("bootstrap_tag_close_failed", `tag ${tag} refused READY close`, closed.status); }
    const ready = await this.ctx.storage.transaction(async (txn) => { const current = await this.control(serviceId); if (current.status === "READY") return current; if (current.status !== "VERIFYING" || current.leaseEpoch !== control.leaseEpoch) throw new Error("bootstrap READY CAS failed"); const updated: BootstrapControlRecord = { ...current, status: "READY", leaseUntil: null, readyAt: new Date().toISOString() }; await txn.put(CONTROL, updated); return updated; });
    return response(ready);
  }
  private async command(serviceId: string, body: unknown, action: "admit" | "finalize" | "release"): Promise<Response> {
    if (!object(body) || !string(body.commandId)) return reject("bootstrap_command_invalid", "commandId is required", 400);
    const result = await this.ctx.storage.transaction(async (txn) => { const control = (await txn.get<BootstrapControlRecord>(CONTROL)) ?? empty(serviceId); if (action === "admit") { if (control.status !== "EMPTY" && control.status !== "READY") return { reject: true }; const updated = { ...control, normalInFlight: control.normalInFlight + 1 }; await txn.put(CONTROL, updated); return { control: updated }; } if (control.status !== "EMPTY" && control.status !== "READY") return { reject: true }; if (action === "release" && control.normalInFlight > 0) { const updated = { ...control, normalInFlight: control.normalInFlight - 1 }; await txn.put(CONTROL, updated); return { control: updated }; } return { control }; });
    return "reject" in result ? reject("bootstrap_command_rejected", "bootstrap state rejects normal durable mutation") : response({ leaseEpoch: result.control.leaseEpoch, admitted: true });
  }
}
