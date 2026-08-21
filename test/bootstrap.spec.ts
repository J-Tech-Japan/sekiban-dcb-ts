import { createExecutionContext, createMessageBatch, env, getQueueResult, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bootstrapDigest, parseBootstrapDump } from "../packages/dcb-runtime/src/bootstrap/manifest";
import type { BootstrapDump, BootstrapManifest } from "../packages/dcb-runtime/src/bootstrap/types";
import { CommitWorker, type CommitWorkerEnv } from "../packages/dcb-runtime/src/commit/CommitWorker";
import { allocatorNameForService } from "../packages/dcb-runtime/src/allocator/types";
import { handleDownstreamQueue } from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import { pollLiveProjections } from "../packages/dcb-runtime/src/projection/LiveProjectionWorker";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import type { Env as WorkerEnv } from "../packages/dcb-runtime/src/index";
import { PostgresEventStore } from "../packages/dcb-runtime/src/store/PostgresEventStore";

const suid = (n: number) => `suid-${String(n).padStart(32, "0")}`;
function dumpFor(serviceId: string, allocatorLineageId = "bootstrap-lineage"): BootstrapDump {
  const events = [
    { eventId: "event-a", suid: suid(1), payload: "AQ==", eventTags: ["orders", "users"] },
    { eventId: "event-b", suid: suid(2), payload: "Ag==", eventTags: ["orders"] },
  ];
  const draft: Omit<BootstrapManifest, "contentDigest"> = { format: "sekiban-dcb-bootstrap", version: 1, source: { serviceId: "source", lineageId: "unknown-legacy" }, target: { serviceId, allocatorLineageId }, highWatermark: suid(2), eventCount: 2, tagCounts: { orders: 2, users: 1 }, canonicalization: "utf8-json-sorted-keys-v1" };
  return { manifest: { ...draft, contentDigest: bootstrapDigest({ manifest: { ...draft, contentDigest: "" }, events }) }, events };
}
async function post(serviceId: string, path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://bootstrap.test/bootstrap/${encodeURIComponent(serviceId)}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
function workerEnv(): WorkerEnv { return env as unknown as WorkerEnv; }
function store(): PostgresEventStore {
  const url = workerEnv().POSTGRES_URL;
  if (url === undefined) throw new Error("POSTGRES_URL binding is required");
  return new PostgresEventStore(url);
}
async function allocatorPost(name: string, path: string, body: unknown): Promise<Response> {
  return workerEnv().ALLOCATOR.get(workerEnv().ALLOCATOR.idFromName(name)).fetch(new Request(`https://bootstrap.test${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}
function queueMessage(serviceId: string): DownstreamOutboxMessage {
  return { version: 1, serviceId, allocatorLineageId: "bootstrap-test-lineage", tag: "orders", attemptId: `queue-${crypto.randomUUID()}`, eventId: `queue-event-${crypto.randomUUID()}`, suid: suid(7), payload: "AQ==", eventTags: ["orders"], provenance: "pre-g27-queue", enqueuedAt: Date.now() };
}

describe("SDT-G21 bootstrap core", () => {
  it("fails parser preflight before target admission on unknown, duplicate, and digest-invalid dumps", async () => {
    const valid = dumpFor("parser-target");
    expect(parseBootstrapDump(valid)).toEqual(valid);
    expect(() => parseBootstrapDump({ ...valid, extra: true })).toThrow(/unknown/i);
    expect(() => parseBootstrapDump({ ...valid, events: [valid.events[0], valid.events[0]] })).toThrow();
    expect(() => parseBootstrapDump({ ...valid, manifest: { ...valid.manifest, contentDigest: "fnv1a32:00000000" } })).toThrow(/digest/i);
    expect((await SELF.fetch("https://bootstrap.test/bootstrap/parser-target/state")).status).toBe(200);
  });

  it("uses the coordinator transaction as the plan/command gate and permanently closes tag admission at READY", async () => {
    const serviceId = `bootstrap-${crypto.randomUUID()}`; const dump = dumpFor(serviceId);
    const command = await post(serviceId, "/command/admit", { commandId: "stalled-command" }); expect(command.status).toBe(200);
    const blocked = await post(serviceId, "/plan", { importId: "import-1", dump, targetEvidence: { bindingExists: false, eventsExist: false } }); expect(blocked.status).toBe(409);
    await post(serviceId, "/command/release", { commandId: "stalled-command" });
    const planned = await post(serviceId, "/plan", { importId: "import-1", dump, targetEvidence: { bindingExists: false, eventsExist: false } }); expect(planned.status).toBe(201);
    const control = await planned.json<{ leaseEpoch: number }>();
    expect((await post(serviceId, "/command/admit", { commandId: "after-planned" })).status).toBe(409);
    expect((await post(serviceId, "/import", { importId: "import-1", leaseEpoch: control.leaseEpoch })).status).toBe(200);
    expect((await post(serviceId, "/verify", { importId: "import-1", leaseEpoch: control.leaseEpoch })).status).toBe(200);
    expect((await post(serviceId, "/ready", { importId: "import-1", leaseEpoch: control.leaseEpoch })).status).toBe(200);
    const tag = await SELF.fetch(`https://bootstrap.test/tags/${encodeURIComponent(serviceId)}/orders/bootstrap/admit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ importId: "import-1", leaseEpoch: control.leaseEpoch, manifestDigest: dump.manifest.contentDigest, targetServiceId: serviceId, candidates: [{ ...dump.events[0], allocatorLineageId: "bootstrap-lineage" }] }) });
    expect(tag.status).toBe(409);
  });

  it("uses the serving allocator lineage after READY so a real commit reaches the downstream store query", async () => {
    const serviceId = `ready-delivery-${crypto.randomUUID()}`;
    const servingAllocator = await allocatorPost(allocatorNameForService(serviceId), "/state", undefined);
    const servingState = await servingAllocator.json<{ allocatorLineageId: string }>();
    const dump = dumpFor(serviceId, servingState.allocatorLineageId);
    const planned = await post(serviceId, "/plan", { importId: "ready-delivery", dump, targetEvidence: { bindingExists: false, eventsExist: false } });
    const control = await planned.json<{ leaseEpoch: number }>();
    expect(planned.status).toBe(201);
    expect((await post(serviceId, "/import", { importId: "ready-delivery", leaseEpoch: control.leaseEpoch })).status).toBe(200);
    expect((await post(serviceId, "/verify", { importId: "ready-delivery", leaseEpoch: control.leaseEpoch })).status).toBe(200);
    expect((await post(serviceId, "/ready", { importId: "ready-delivery", leaseEpoch: control.leaseEpoch })).status).toBe(200);

    const commit = await new CommitWorker(workerEnv(), serviceId).handle(new Request("https://commit.test/api/sekiban/serialized/commit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, eventCandidates: [{ payload: "AQ==", eventPayloadName: "ReadyDelivery", tags: ["orders"] }], consistencyTags: [] }),
    }));
    expect(commit.status).toBe(200);
    const committed = await commit.json<{ writtenEvents: Array<{ id: string; sortableUniqueIdValue: string }> }>();
    const written = committed.writtenEvents[0]!;
    const tag = await SELF.fetch(`https://bootstrap.test/tags/${encodeURIComponent(serviceId)}/orders/state`);
    const tagState = await tag.json<{ events: Array<{ eventId: string; suid: string; payload: string; eventTags: string[]; allocatorLineageId: string }> }>();
    const delivered = tagState.events.find((event) => event.eventId === written.id)!;
    expect(delivered.allocatorLineageId).toBe(servingState.allocatorLineageId);

    const database = store(); await database.initialize();
    const batch = createMessageBatch("serialized-dcb-v1-outbox", [{ id: "ready-delivery", timestamp: new Date(), attempts: 1, body: { version: 1, serviceId, allocatorLineageId: delivered.allocatorLineageId, tag: "orders", attemptId: "ready-delivery", eventId: delivered.eventId, suid: delivered.suid, payload: delivered.payload, eventTags: delivered.eventTags, provenance: "pre-g27-queue", enqueuedAt: Date.now() } }]);
    await handleDownstreamQueue(batch, { POSTGRES_URL: workerEnv().POSTGRES_URL, BOOTSTRAP: workerEnv().BOOTSTRAP }, { store: database });
    expect((await getQueueResult(batch, createExecutionContext())).explicitAcks).toHaveLength(1);
    const queried = await database.readAllEvents(serviceId, "");
    expect(queried).toEqual(expect.arrayContaining([expect.objectContaining({ eventId: written.id, suid: written.sortableUniqueIdValue })]));
  });

  it("isolates fresh-target plus already-seeded and already-allocating allocator guards", async () => {
    const bindingService = `binding-${crypto.randomUUID()}`;
    const binding = await post(bindingService, "/plan", { importId: "x", dump: dumpFor(bindingService), targetEvidence: { bindingExists: true, eventsExist: false } }); expect(binding.status).toBe(409);
    const eventsService = `events-${crypto.randomUUID()}`;
    const events = await post(eventsService, "/plan", { importId: "x", dump: dumpFor(eventsService), targetEvidence: { bindingExists: false, eventsExist: true } }); expect(events.status).toBe(409);
    const seededName = `seeded-${crypto.randomUUID()}`;
    expect((await allocatorPost(seededName, "/seed-after", { importId: "seed", leaseEpoch: 1, highWatermark: suid(9) })).status).toBe(201);
    const second = await allocatorPost(seededName, "/seed-after", { importId: "other", leaseEpoch: 2, highWatermark: suid(10) });
    expect(second.status).toBe(409); expect(await second.json()).toMatchObject({ code: "allocator_seed_rejected", error: "allocator already seeded" });
    const allocatingName = `allocating-${crypto.randomUUID()}`;
    expect((await allocatorPost(allocatingName, "/allocate", { attemptId: "allocated", candidates: [{ candidateIndex: 0, eventId: "allocated-event" }] })).status).toBe(201);
    const allocating = await allocatorPost(allocatingName, "/seed-after", { importId: "seed", leaseEpoch: 1, highWatermark: suid(9) });
    expect(allocating.status).toBe(409); expect(await allocating.json()).toMatchObject({ code: "allocator_seed_rejected", error: "allocator already allocating" });
  });

  it("drives the real Queue entry point with BOOTSTRAP bound and retries a legal PLANNED service", async () => {
    const serviceId = `queue-gate-${crypto.randomUUID()}`; expect((await post(serviceId, "/plan", { importId: "queue", dump: dumpFor(serviceId), targetEvidence: { bindingExists: false, eventsExist: false } })).status).toBe(201);
    const database = store(); await database.initialize(); const batch = createMessageBatch("serialized-dcb-v1-outbox", [{ id: "queue-gate", timestamp: new Date(), attempts: 1, body: queueMessage(serviceId) }]);
    await handleDownstreamQueue(batch, { POSTGRES_URL: workerEnv().POSTGRES_URL, BOOTSTRAP: workerEnv().BOOTSTRAP }, { store: database });
    const outcome = await getQueueResult(batch, createExecutionContext());
    expect(outcome.explicitAcks).toEqual([]); expect(outcome.retryMessages).toHaveLength(1);
  });

  it("drives the real projection-rebuild entry point with BOOTSTRAP bound and a legal PLANNED service", async () => {
    const serviceId = `projection-gate-${crypto.randomUUID()}`; expect((await post(serviceId, "/plan", { importId: "projection", dump: dumpFor(serviceId), targetEvidence: { bindingExists: false, eventsExist: false } })).status).toBe(201);
    const database = store(); await database.initialize();
    await expect(pollLiveProjections({ POSTGRES_URL: workerEnv().POSTGRES_URL, BOOTSTRAP: workerEnv().BOOTSTRAP }, { store: database, serviceId })).rejects.toThrow("bootstrap_route_rejected:projection-rebuild");
  });

  it("gates the real /allocate route during PLANNED bootstrap and leaves the allocator seedable", async () => {
    const serviceId = `allocator-gate-${crypto.randomUUID()}`; const allocatorName = `allocator-gate-${crypto.randomUUID()}`;
    const admitted = await post(serviceId, "/command/admit", { commandId: "allocator-command" }); const { leaseEpoch } = await admitted.json<{ leaseEpoch: number }>();
    expect((await post(serviceId, "/command/release", { commandId: "allocator-command", leaseEpoch })).status).toBe(200);
    expect((await post(serviceId, "/plan", { importId: "allocator", dump: dumpFor(serviceId), targetEvidence: { bindingExists: false, eventsExist: false } })).status).toBe(201);
    const rejected = await allocatorPost(allocatorName, "/allocate", { attemptId: "planned-allocation", serviceId, bootstrapCommandId: "allocator-command", bootstrapEpoch: leaseEpoch, candidates: [{ candidateIndex: 0, eventId: "planned-event" }] });
    expect(rejected.status).toBe(409); expect(await rejected.json()).toMatchObject({ code: "bootstrap_command_rejected" });
    expect(await (await allocatorPost(allocatorName, "/state", undefined)).json()).toMatchObject({ allocatedWatermark: null, bootstrapSeed: null });
    expect((await allocatorPost(allocatorName, "/seed-after", { importId: "allocator", leaseEpoch: 1, highWatermark: suid(2) })).status).toBe(201);
  });

  it("keeps normal allocation legal and blocks the real stalled CommitWorker allocation before watermark mutation", async () => {
    const normalAllocator = `normal-allocation-${crypto.randomUUID()}`;
    expect((await allocatorPost(normalAllocator, "/allocate", { attemptId: "normal", candidates: [{ candidateIndex: 0, eventId: "normal-event" }] })).status).toBe(201);
    const serviceId = `commit-allocator-gate-${crypto.randomUUID()}`; const allocatorName = `commit-allocator-gate-${crypto.randomUUID()}`;
    let entered!: () => void; const enteredAllocation = new Promise<void>((resolve) => { entered = resolve; });
    let resume!: () => void; const resumeAllocation = new Promise<void>((resolve) => { resume = resolve; });
    const worker = new CommitWorker(workerEnv(), serviceId, { allocatorName, beforeBootstrapAllocation: async () => { entered(); await resumeAllocation; } });
    const pending = worker.handle(new Request("https://commit.test/api/sekiban/serialized/commit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 1, eventCandidates: [{ payload: "AQ==", eventPayloadName: "AllocatorRace", tags: ["orders"] }], consistencyTags: [] }) }));
    await enteredAllocation;
    expect((await post(serviceId, "/plan", { importId: "commit-allocator", dump: dumpFor(serviceId), targetEvidence: { bindingExists: false, eventsExist: false } })).status).toBe(201);
    resume(); const result = await pending;
    expect(result.status).toBe(500);
    expect(await (await allocatorPost(allocatorName, "/state", undefined)).json()).toMatchObject({ allocatedWatermark: null, bootstrapSeed: null });
    expect((await allocatorPost(allocatorName, "/seed-after", { importId: "commit-allocator", leaseEpoch: 1, highWatermark: suid(2) })).status).toBe(201);
  });

  it("resumes all six durable fault boundaries without duplicate tag rows or early READY", async () => {
    const serviceId = `fault-${crypto.randomUUID()}`; const dump = dumpFor(serviceId);
    const crashedPlan = await post(serviceId, "/plan", { importId: "faults", dump, targetEvidence: { bindingExists: false, eventsExist: false }, faultAt: "mode-record" });
    expect(crashedPlan.status).toBe(503);
    const state = await SELF.fetch(`https://bootstrap.test/bootstrap/${encodeURIComponent(serviceId)}/state`);
    const control = await state.json<{ leaseEpoch: number; status: string }>(); expect(control.status).toBe("PLANNED");
    expect((await post(serviceId, "/import", { importId: "faults", leaseEpoch: control.leaseEpoch, faultAt: "tag-chunk" })).status).toBe(503);
    expect((await post(serviceId, "/import", { importId: "faults", leaseEpoch: control.leaseEpoch, faultAt: "store-progress-gap" })).status).toBe(503);
    expect((await post(serviceId, "/import", { importId: "faults", leaseEpoch: control.leaseEpoch, faultAt: "allocator-seed" })).status).toBe(503);
    expect((await post(serviceId, "/import", { importId: "faults", leaseEpoch: control.leaseEpoch })).status).toBe(200);
    expect((await post(serviceId, "/ready", { importId: "faults", leaseEpoch: control.leaseEpoch })).status).toBe(409);
    expect((await post(serviceId, "/verify", { importId: "faults", leaseEpoch: control.leaseEpoch, faultAt: "verifying" })).status).toBe(503);
    expect((await post(serviceId, "/verify", { importId: "faults", leaseEpoch: control.leaseEpoch })).status).toBe(200);
    expect((await post(serviceId, "/ready", { importId: "faults", leaseEpoch: control.leaseEpoch, faultAt: "ready-cas" })).status).toBe(503);
    expect((await post(serviceId, "/ready", { importId: "faults", leaseEpoch: control.leaseEpoch })).status).toBe(200);
    const tag = await SELF.fetch(`https://bootstrap.test/tags/${encodeURIComponent(serviceId)}/orders/state`);
    expect((await tag.json<{ events: unknown[] }>()).events).toHaveLength(2);
  });

  it("isolates stale fencing epoch with all plan and freshness predicates legal", async () => {
    const serviceId = `epoch-${crypto.randomUUID()}`; const dump = dumpFor(serviceId);
    const planned = await post(serviceId, "/plan", { importId: "epoch", dump, targetEvidence: { bindingExists: false, eventsExist: false } });
    const control = await planned.json<{ leaseEpoch: number }>();
    expect((await post(serviceId, "/import", { importId: "epoch", leaseEpoch: control.leaseEpoch + 1 })).status).toBe(409);
  });

  it("has both directions of the real CommitWorker/bootstrap race oracle", async () => {
    const serviceId = `race-${crypto.randomUUID()}`; const dump = dumpFor(serviceId);
    // Bootstrap first: the actual HTTP commit worker loses its admission gate.
    expect((await post(serviceId, "/plan", { importId: "race", dump, targetEvidence: { bindingExists: false, eventsExist: false } })).status).toBe(201);
    const worker = new CommitWorker(env as unknown as CommitWorkerEnv, serviceId);
    const commit = await worker.handle(new Request("https://commit.test/api/sekiban/serialized/commit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 1, eventCandidates: [{ payload: "AQ==", eventPayloadName: "Race", tags: ["orders"] }], consistencyTags: [] }) }));
    expect(commit.status).toBe(409); expect((await commit.json<{ code: string }>()).code).toBe("bootstrap_command_rejected");
    // Commit first: its held real command admission prevents EMPTY -> PLANNED.
    const other = `race-other-${crypto.randomUUID()}`; const held = await post(other, "/command/admit", { commandId: "commit-stalled" }); const epoch = await held.json<{ leaseEpoch: number }>();
    expect((await post(other, "/plan", { importId: "race-other", dump: dumpFor(other), targetEvidence: { bindingExists: false, eventsExist: false } })).status).toBe(409);
    expect((await post(other, "/command/finalize", { commandId: "commit-stalled", leaseEpoch: epoch.leaseEpoch })).status).toBe(200);
    expect((await post(other, "/command/release", { commandId: "commit-stalled", leaseEpoch: epoch.leaseEpoch })).status).toBe(200);
  });

  it("revalidates a real admitted commit after bootstrap advances its epoch and leaves tags byte-empty", async () => {
    const serviceId = `final-write-race-${crypto.randomUUID()}`; const dump = dumpFor(serviceId);
    let entered!: () => void; const enteredFinalization = new Promise<void>((resolve) => { entered = resolve; });
    let resume!: () => void; const resumeFinalization = new Promise<void>((resolve) => { resume = resolve; });
    const worker = new CommitWorker(workerEnv(), serviceId, { beforeBootstrapFinalization: async () => { entered(); await resumeFinalization; } });
    const pending = worker.handle(new Request("https://commit.test/api/sekiban/serialized/commit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 1, eventCandidates: [{ payload: "AQ==", eventPayloadName: "Race", tags: ["orders"] }], consistencyTags: [] }) }));
    await enteredFinalization;
    expect((await post(serviceId, "/plan", { importId: "advanced", dump, targetEvidence: { bindingExists: false, eventsExist: false } })).status).toBe(201);
    resume(); const result = await pending;
    expect(result.status).toBe(409); expect((await result.json<{ code: string }>()).code).toBe("bootstrap_command_rejected");
    expect((await SELF.fetch(`https://bootstrap.test/tags/${encodeURIComponent(serviceId)}/orders/state`)).status).toBe(404);
  });
});
