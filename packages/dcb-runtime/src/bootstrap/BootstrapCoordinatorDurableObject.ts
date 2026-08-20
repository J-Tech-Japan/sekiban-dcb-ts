import { parseBootstrapDump } from "./manifest";
import type { BootstrapManifestError } from "./manifest";
import type { BootstrapControlRecord, BootstrapDump, BootstrapEventRecord } from "./types";
import { allocatorNameForService } from "../allocator/types";

const CONTROL = "bootstrap-control";
const DUMP = "bootstrap-dump";
const MAX_CHUNK_EVENTS = 128;
const MAX_CHUNK_BYTES = 192 * 1024;
const MAX_RELEASED_COMMANDS = 512;
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const epoch = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const reject = (code: string, message: string, status = 409) => response({ code, error: message }, status);

interface BootstrapCoordinatorEnv { TAG: DurableObjectNamespace; ALLOCATOR: DurableObjectNamespace; }
type CommandAction = "admit" | "finalize" | "release";
type FaultPoint = "mode-record" | "tag-chunk" | "store-progress-gap" | "allocator-seed" | "verifying" | "ready-cas";

function empty(serviceId: string): BootstrapControlRecord {
  return { schemaVersion: 1, status: "EMPTY", importId: null, targetServiceId: serviceId, allocatorLineageId: null, source: null, digest: null, manifest: null, progress: {}, leaseEpoch: 0, leaseUntil: null, failure: null, readyAt: null, normalInFlight: 0, normalCommands: {}, releasedCommands: {}, verifiedImportId: null, verifiedLeaseEpoch: null, storeCompletion: null };
}
function expired(control: BootstrapControlRecord): boolean { return control.leaseUntil !== null && control.leaseUntil <= Date.now(); }
function commands(control: BootstrapControlRecord): Record<string, number> { return { ...(control.normalCommands ?? {}) }; }
function released(control: BootstrapControlRecord): Record<string, number> { return { ...(control.releasedCommands ?? {}) }; }
function fault(body: unknown, point: FaultPoint): boolean { return object(body) && body.faultAt === point; }
function encodedBytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }

/** Per-service authority and linearization point for bootstrap and normal writes. */
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
    if (url.pathname === "/abort") return this.abort(serviceId, body);
    if (url.pathname === "/route/check") return this.route(serviceId, body);
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
    const importId = body.importId as string;
    let dump: BootstrapDump; try { dump = parseBootstrapDump(body.dump); } catch (failure) { const e = failure as BootstrapManifestError; return reject(e.code ?? "bootstrap_dump_invalid", e.message ?? "invalid dump", 400); }
    if (dump.manifest.target.serviceId !== serviceId) return reject("bootstrap_target_mismatch", "manifest target is not this coordinator service");
    if (body.targetEvidence.bindingExists || body.targetEvidence.eventsExist) return reject("bootstrap_target_not_fresh", "existing binding or events forbid bootstrap without writes");
    const planned = await this.ctx.storage.transaction(async (txn) => {
      const control = (await txn.get<BootstrapControlRecord>(CONTROL)) ?? empty(serviceId);
      if (control.status === "READY") return { error: "bootstrap_ready_permanent" };
      if (control.status !== "EMPTY") return control.importId === importId && control.digest === dump.manifest.contentDigest ? { control } : { error: "bootstrap_plan_conflict" };
      if (control.normalInFlight !== 0 || Object.keys(commands(control)).length !== 0) return { error: "bootstrap_normal_command_in_flight" };
      const next: BootstrapControlRecord = { ...control, status: "PLANNED", importId, allocatorLineageId: dump.manifest.target.allocatorLineageId, source: dump.manifest.source, digest: dump.manifest.contentDigest, manifest: dump.manifest, leaseEpoch: control.leaseEpoch + 1, leaseUntil: Date.now() + 30_000, failure: null, progress: {}, verifiedImportId: null, verifiedLeaseEpoch: null, storeCompletion: null };
      await txn.put(CONTROL, next); await txn.put(DUMP, dump); return { control: next };
    });
    if (fault(body, "mode-record") && !("error" in planned)) return reject("bootstrap_simulated_crash", "simulated crash after mode record", 503);
    return "error" in planned ? reject(planned.error ?? "bootstrap_plan_rejected", planned.error ?? "bootstrap plan rejected") : response(planned.control, planned.control.status === "PLANNED" ? 201 : 200);
  }

  private chunks(events: readonly BootstrapEventRecord[]): BootstrapEventRecord[][] {
    const chunks: BootstrapEventRecord[][] = []; let current: BootstrapEventRecord[] = []; let bytes = 0;
    for (const event of events) { const eventBytes = encodedBytes(event); if (eventBytes > MAX_CHUNK_BYTES) throw new Error("bootstrap event exceeds encoded chunk bound"); if (current.length === MAX_CHUNK_EVENTS || bytes + eventBytes > MAX_CHUNK_BYTES) { chunks.push(current); current = []; bytes = 0; } current.push(event); bytes += eventBytes; }
    if (current.length > 0) chunks.push(current); return chunks;
  }

  private async import(serviceId: string, body: unknown): Promise<Response> {
    const control = await this.control(serviceId); const invalid = this.valid(control, body); if (invalid !== undefined) return reject("bootstrap_epoch_rejected", invalid);
    if (control.status !== "PLANNED" && control.status !== "IMPORTING" && control.status !== "FAILED") return reject("bootstrap_state_rejected", "import is not permitted in this state");
    if (expired(control)) return reject("bootstrap_lease_expired", "only a same-plan takeover may continue an expired lease");
    const dump = await this.ctx.storage.get<BootstrapDump>(DUMP); if (dump === undefined || control.manifest === null) return reject("bootstrap_plan_missing", "planned dump is unavailable", 500);
    const byTag = new Map<string, BootstrapEventRecord[]>(); for (const event of dump.events) for (const tag of event.eventTags) byTag.set(tag, [...(byTag.get(tag) ?? []), event]);
    await this.ctx.storage.transaction(async (txn) => { const current = (await txn.get<BootstrapControlRecord>(CONTROL)) ?? empty(serviceId); if (current.importId !== control.importId || current.leaseEpoch !== control.leaseEpoch) throw new Error("bootstrap epoch advanced"); await txn.put(CONTROL, { ...current, status: "IMPORTING" }); });
    // Sequential tags give strict same-tag ordering and bounded cross-tag concurrency (one).
    for (const [tag, events] of [...byTag.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      for (const chunk of this.chunks(events)) {
        const stub = this.env.TAG.get(this.env.TAG.idFromName(`${serviceId}|${tag}`)); const tagUrl = new URL("https://bootstrap.internal/bootstrap/admit"); tagUrl.searchParams.set("__tag", tag); tagUrl.searchParams.set("__serviceId", serviceId);
        const admitted = await stub.fetch(new Request(tagUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ importId: control.importId, leaseEpoch: control.leaseEpoch, manifestDigest: control.digest, targetServiceId: serviceId, candidates: chunk.map((event) => ({ ...event, allocatorLineageId: control.allocatorLineageId })) }) }));
        if (!admitted.ok) return reject("bootstrap_tag_admission_failed", `tag ${tag} rejected bootstrap admission`, admitted.status);
        if (fault(body, "tag-chunk")) return reject("bootstrap_simulated_crash", "simulated crash after tag chunk", 503);
        await this.ctx.storage.transaction(async (txn) => { const current = (await txn.get<BootstrapControlRecord>(CONTROL)) ?? empty(serviceId); if (current.importId !== control.importId || current.leaseEpoch !== control.leaseEpoch) throw new Error("bootstrap epoch advanced"); await txn.put(CONTROL, { ...current, progress: { ...current.progress, [tag]: chunk.at(-1)!.suid } }); });
        if (fault(body, "store-progress-gap")) return reject("bootstrap_simulated_crash", "simulated crash after durable tag write", 503);
      }
    }
    // Seed the exact allocator used by normal commits for this service. Its
    // durable lineage is the target store binding.
    const allocator = this.env.ALLOCATOR.get(this.env.ALLOCATOR.idFromName(allocatorNameForService(serviceId)));
    const seeded = await allocator.fetch(new Request("https://bootstrap.internal/seed-after", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ importId: control.importId, leaseEpoch: control.leaseEpoch, highWatermark: control.manifest.highWatermark ?? "suid-00000000000000000000000000000000" }) }));
    if (!seeded.ok) return reject("bootstrap_allocator_seed_failed", "allocator seedAfter rejected bootstrap", seeded.status);
    if (fault(body, "allocator-seed")) return reject("bootstrap_simulated_crash", "simulated crash after allocator seed", 503);
    const next = await this.ctx.storage.transaction(async (txn) => { const current = (await txn.get<BootstrapControlRecord>(CONTROL)) ?? empty(serviceId); if (current.importId !== control.importId || current.leaseEpoch !== control.leaseEpoch) throw new Error("bootstrap epoch advanced"); const updated: BootstrapControlRecord = { ...current, status: "VERIFYING" }; await txn.put(CONTROL, updated); return updated; });
    return response(next);
  }

  private async verify(serviceId: string, body: unknown): Promise<Response> {
    const control = await this.control(serviceId); const invalid = this.valid(control, body); if (invalid !== undefined) return reject("bootstrap_epoch_rejected", invalid);
    if (control.status !== "VERIFYING" || control.manifest === null) return reject("bootstrap_state_rejected", "verify requires VERIFYING");
    const dump = await this.ctx.storage.get<BootstrapDump>(DUMP); if (dump === undefined) return reject("bootstrap_plan_missing", "planned dump is unavailable", 500);
    const expectedByTag = new Map<string, BootstrapEventRecord[]>(); for (const event of dump.events) for (const tag of event.eventTags) expectedByTag.set(tag, [...(expectedByTag.get(tag) ?? []), event]);
    for (const [tag, expected] of expectedByTag) {
      const url = new URL("https://bootstrap.internal/state"); url.searchParams.set("__tag", tag); const actual = await this.env.TAG.get(this.env.TAG.idFromName(`${serviceId}|${tag}`)).fetch(new Request(url));
      if (!actual.ok) return reject("bootstrap_verify_tag_missing", `tag ${tag} is missing`, actual.status);
      const state = await actual.json() as { head?: unknown; events?: unknown }; const actualEvents = Array.isArray(state.events) ? state.events : [];
      const expectedHead = expected.at(-1)?.suid ?? null;
      if (state.head !== expectedHead || actualEvents.length !== expected.length || actualEvents.some((value, index) => { const event = value as Partial<BootstrapEventRecord>; const source = expected[index]!; return event.eventId !== source.eventId || event.suid !== source.suid || event.payload !== source.payload || JSON.stringify(event.eventTags) !== JSON.stringify(source.eventTags); })) return reject("bootstrap_verify_tag_mismatch", `tag ${tag} does not match manifest`);
    }
    // Permitted core completion branch: immutable pre-populated manifest snapshot.
    const ids = new Set(dump.events.map((event) => event.eventId));
    if (ids.size !== dump.events.length || dump.events.length !== control.manifest.eventCount) return reject("bootstrap_verify_store_mismatch", "prepopulated store snapshot does not match manifest");
    if (fault(body, "verifying")) return reject("bootstrap_simulated_crash", "simulated crash during verification", 503);
    const verified = await this.ctx.storage.transaction(async (txn) => { const current = (await txn.get<BootstrapControlRecord>(CONTROL)) ?? empty(serviceId); if (current.status !== "VERIFYING" || current.importId !== control.importId || current.leaseEpoch !== control.leaseEpoch) throw new Error("bootstrap verification CAS failed"); const updated: BootstrapControlRecord = { ...current, verifiedImportId: control.importId, verifiedLeaseEpoch: control.leaseEpoch, storeCompletion: "prepopulated-manifest" }; await txn.put(CONTROL, updated); return updated; });
    return response(verified);
  }

  private async ready(serviceId: string, body: unknown): Promise<Response> {
    const control = await this.control(serviceId); const invalid = this.valid(control, body); if (invalid !== undefined) return reject("bootstrap_epoch_rejected", invalid);
    if (control.status !== "VERIFYING" || control.verifiedImportId !== control.importId || control.verifiedLeaseEpoch !== control.leaseEpoch || control.storeCompletion === null) return reject("bootstrap_verification_required", "READY requires same importId and epoch verification");
    for (const tag of Object.keys(control.manifest!.tagCounts)) { const stub = this.env.TAG.get(this.env.TAG.idFromName(`${serviceId}|${tag}`)); const url = new URL("https://bootstrap.internal/bootstrap/close"); url.searchParams.set("__tag", tag); const closed = await stub.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ importId: control.importId, leaseEpoch: control.leaseEpoch }) })); if (!closed.ok) return reject("bootstrap_tag_close_failed", `tag ${tag} refused READY close`, closed.status); }
    if (fault(body, "ready-cas")) return reject("bootstrap_simulated_crash", "simulated crash before READY CAS", 503);
    const ready = await this.ctx.storage.transaction(async (txn) => { const current = (await txn.get<BootstrapControlRecord>(CONTROL)) ?? empty(serviceId); if (current.status === "READY") return current; if (current.status !== "VERIFYING" || current.leaseEpoch !== control.leaseEpoch || current.verifiedImportId !== current.importId || current.verifiedLeaseEpoch !== current.leaseEpoch) throw new Error("bootstrap READY CAS failed"); const updated: BootstrapControlRecord = { ...current, status: "READY", leaseUntil: null, readyAt: new Date().toISOString() }; await txn.put(CONTROL, updated); return updated; });
    return response(ready);
  }

  /** Operator abort retains the durable failed plan for audit/retry; it never clears target state. */
  private async abort(serviceId: string, body: unknown): Promise<Response> {
    const control = await this.control(serviceId); const invalid = this.valid(control, body); if (invalid !== undefined) return reject("bootstrap_epoch_rejected", invalid);
    if (control.status === "EMPTY" || control.status === "READY") return reject("bootstrap_state_rejected", "abort requires an active bootstrap");
    const aborted = await this.ctx.storage.transaction(async (txn) => {
      const current = (await txn.get<BootstrapControlRecord>(CONTROL)) ?? empty(serviceId);
      if (current.importId !== control.importId || current.leaseEpoch !== control.leaseEpoch) throw new Error("bootstrap abort CAS failed");
      const next: BootstrapControlRecord = { ...current, status: "FAILED", failure: "operator_abort", leaseUntil: null };
      await txn.put(CONTROL, next); return next;
    });
    return response(aborted);
  }

  private async route(serviceId: string, body: unknown): Promise<Response> {
    if (!object(body) || !string(body.route)) return reject("bootstrap_route_invalid", "route is required", 400);
    const control = await this.control(serviceId);
    return control.status === "EMPTY" || control.status === "READY" ? response({ admitted: true, leaseEpoch: control.leaseEpoch, route: body.route }) : reject("bootstrap_route_rejected", `${body.route} is unavailable during bootstrap`);
  }

  private async command(serviceId: string, body: unknown, action: CommandAction): Promise<Response> {
    if (!object(body) || !string(body.commandId)) return reject("bootstrap_command_invalid", "commandId is required", 400);
    const commandId = body.commandId as string;
    const result = await this.ctx.storage.transaction(async (txn) => {
      const control = (await txn.get<BootstrapControlRecord>(CONTROL)) ?? empty(serviceId); const current = commands(control); const completed = released(control);
      if (action === "admit") { if (control.status !== "EMPTY" && control.status !== "READY") return { rejected: true }; if (current[commandId] !== undefined) return { control }; current[commandId] = control.leaseEpoch; const updated = { ...control, normalInFlight: Object.keys(current).length, normalCommands: current }; await txn.put(CONTROL, updated); return { control: updated }; }
      const expectedEpoch = body.leaseEpoch;
      // Release is cleanup only and may be retried after a lost response; it
      // may never authorize a mutation. Finalize retains the strict epoch CAS.
      if (action === "release") { if (current[commandId] === undefined || (expectedEpoch !== undefined && (!epoch(expectedEpoch) || current[commandId] !== expectedEpoch))) return { rejected: true }; completed[commandId] = current[commandId]!; delete current[commandId]; for (const stale of Object.keys(completed).slice(0, Math.max(0, Object.keys(completed).length - MAX_RELEASED_COMMANDS))) delete completed[stale]; const updated = { ...control, normalInFlight: Object.keys(current).length, normalCommands: current, releasedCommands: completed }; await txn.put(CONTROL, updated); return { control: updated }; }
      if (!epoch(expectedEpoch) || (current[commandId] !== expectedEpoch && completed[commandId] !== expectedEpoch) || control.leaseEpoch !== expectedEpoch || (control.status !== "EMPTY" && control.status !== "READY")) return { rejected: true };
      return { control };
    });
    return "rejected" in result ? reject("bootstrap_command_rejected", "bootstrap epoch rejects normal durable mutation") : response({ leaseEpoch: result.control.leaseEpoch, admitted: true });
  }
}
