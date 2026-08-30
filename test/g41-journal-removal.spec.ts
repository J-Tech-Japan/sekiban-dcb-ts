import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { allocatorNameForService, type AllocationVector } from "../packages/dcb-runtime/src/allocator/types";
import { CommitWorker, type CommitWorkerEnv } from "../packages/dcb-runtime/src/commit/CommitWorker";
import { GlobalCompletenessReconciler } from "../packages/dcb-runtime/src/completeness/GlobalCompletenessReconciler";
import type { SourceObligationPage } from "../packages/dcb-runtime/src/completeness/types";
import { g32EventId, g32Suid, G32_FIXTURE_TIMESTAMP } from "./helpers/g32-fixtures";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";
// @ts-expect-error Vite raw import keeps this test on the ordinary G32 baseline.
import g32Migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";

const SERVICE = "g41-commit-fixture";

interface NamespaceCalls {
  idFromName: number;
  get: number;
  fetch: number;
}

interface TagFact {
  readonly tag: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
}

interface FakeRun {
  readonly worker: CommitWorker;
  readonly journalCalls: NamespaceCalls;
  readonly tagCalls: NamespaceCalls;
  readonly allocatorCalls: NamespaceCalls;
  readonly appends: string[];
  readonly cancels: TagFact[];
  readonly fences: TagFact[];
}

interface FakeRunOptions {
  readonly acquire?: (tag: string) => Response;
  readonly append?: (tag: string) => Response;
  readonly cancel?: (tag: string) => Response;
}

interface TagScannerSeam {
  g44ReadSourceObligations(input: Readonly<{
    serviceId: string;
    tag: string;
    upperBoundSequence: number;
    afterSequence: number;
    limit: number;
  }>): Promise<SourceObligationPage>;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function emptyCalls(): NamespaceCalls {
  return { idFromName: 0, get: 0, fetch: 0 };
}

function namespace(
  calls: NamespaceCalls,
  fetch: (id: string, request: Request) => Promise<Response>,
): DurableObjectNamespace {
  return {
    idFromName(name: string): DurableObjectId {
      calls.idFromName += 1;
      return name as unknown as DurableObjectId;
    },
    get(id: DurableObjectId): DurableObjectStub {
      calls.get += 1;
      return {
        async fetch(request: Request): Promise<Response> {
          calls.fetch += 1;
          return fetch(String(id), request);
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

function request(
  tags: readonly string[],
  consistency = tags,
  fault?: string,
  attemptId?: string,
  consistencyHeads = consistency.map((_, index) => g32Suid(`g41-head-${index}`)),
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (fault !== undefined) headers.set("x-sdt-g4-test-fault", fault);
  if (attemptId !== undefined) headers.set("x-sdt-g4-test-attempt-id", attemptId);
  return new Request("https://commit.test/api/sekiban/serialized/commit", {
    method: "POST",
    headers,
    body: JSON.stringify({
      version: 1,
      eventCandidates: [{
        payload: btoa(JSON.stringify({ fixture: "g41" })),
        eventPayloadName: "G41Fixture",
        tags,
      }],
      consistencyTags: consistency.map((tag, index) => ({ tag, lastSortableUniqueId: consistencyHeads[index]! })),
    }),
  });
}

function fakeRun(options: FakeRunOptions = {}): FakeRun {
  const journalCalls = emptyCalls();
  const tagCalls = emptyCalls();
  const allocatorCalls = emptyCalls();
  const bootstrapCalls = emptyCalls();
  const appends: string[] = [];
  const cancels: TagFact[] = [];
  const fences: TagFact[] = [];
  const journal = namespace(journalCalls, async () => json({ code: "journal_must_not_run" }, 500));
  const tag = namespace(tagCalls, async (id, incoming) => {
    const tagName = id.split("|").at(-1)!;
    const path = new URL(incoming.url).pathname;
    if (path === "/acquire") return options.acquire?.(tagName) ?? json({ reservation: { token: `token:${tagName}` } }, 201);
    if (path === "/append") {
      appends.push(tagName);
      return options.append?.(tagName) ?? json({ appended: true }, 201);
    }
    if (path === "/cancel") {
      const body = await incoming.json<Record<string, unknown>>();
      cancels.push({ tag: tagName, path, body });
      return options.cancel?.(tagName) ?? json({ status: "cancelled" });
    }
    if (path === "/fence/install") {
      const body = await incoming.json<Record<string, unknown>>();
      fences.push({ tag: tagName, path, body });
      return json({ status: "fence-installed" }, 201);
    }
    if (path === "/head-facts") {
      return json({ head: g32Suid(`g41-head:${tagName}`), version: 1, updatedAt: "2026-08-29T00:00:00.000Z" });
    }
    return json({ code: `unexpected_tag_path:${path}` }, 500);
  });
  const allocator = namespace(allocatorCalls, async (_id, incoming) => {
    if (new URL(incoming.url).pathname !== "/allocate") return json({ code: "unexpected_allocator_path" }, 500);
    const body = await incoming.json<{ candidates: Array<{ candidateIndex: number; eventId: string }> }>();
    return json({
      attemptId: "g41-fake-attempt",
      allocatorLineageId: "g41-fake-lineage",
      candidates: body.candidates.map((candidate) => ({ ...candidate, suid: g32Suid(`g41-allocation-${candidate.candidateIndex}`) })),
    });
  });
  const bootstrap = namespace(bootstrapCalls, async () => json({ leaseEpoch: 1 }));
  return {
    worker: new CommitWorker({ ALLOCATOR: allocator, JOURNAL: journal, TAG: tag, BOOTSTRAP: bootstrap }, SERVICE),
    journalCalls,
    tagCalls,
    allocatorCalls,
    appends,
    cancels,
    fences,
  };
}

function database(): D1Database {
  const d1 = (env as unknown as { readonly D1?: D1Database }).D1;
  if (d1 === undefined) throw new Error("G41 needs the local D1 binding");
  return d1;
}

function tags(): DurableObjectNamespace {
  const namespace = (env as unknown as { readonly TAG?: DurableObjectNamespace }).TAG;
  if (namespace === undefined) throw new Error("G41 needs the Tag Durable Object namespace");
  return namespace;
}

function tagStub(serviceId: string, tag: string): DurableObjectStub {
  return tags().get(tags().idFromName(`${serviceId}|${tag}`));
}

function allocatorStub(serviceId: string): DurableObjectStub {
  const allocator = (env as unknown as { readonly ALLOCATOR?: DurableObjectNamespace }).ALLOCATOR;
  if (allocator === undefined) throw new Error("G41 needs the Allocator Durable Object namespace");
  return allocator.get(allocator.idFromName(allocatorNameForService(serviceId)));
}

function tagUrl(serviceId: string, tag: string, path: string): string {
  return `https://tag.test/tags/${encodeURIComponent(serviceId)}/${encodeURIComponent(tag)}${path}`;
}

async function tagPost(serviceId: string, tag: string, path: string, body: unknown): Promise<Response> {
  return SELF.fetch(tagUrl(serviceId, tag, path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readTagState(serviceId: string, tag: string): Promise<{
  events: Array<{ eventId: string }>;
  activeReservation: {
    attemptId: string;
    epoch: number;
    token: string;
    expectedHead: string;
    expiresAt: number;
  } | null;
  fences: Array<{ reason: string; attemptId: string; epoch: number }>;
  alarmDueAt: number | null;
}> {
  const response = await SELF.fetch(tagUrl(serviceId, tag, "/state"));
  expect(response.status).toBe(200);
  return response.json();
}

async function seedObservedTag(serviceId: string, tag: string, seed: string): Promise<string> {
  const seeded = await tagPost(serviceId, tag, "/append", {
    attemptId: `g41-seed:${seed}`,
    epoch: 0,
    candidates: [{
      eventId: g32EventId(`g41-seed:${seed}`),
      suid: g32Suid(`g41-seed:${seed}`),
      payload: JSON.stringify({ fixture: "g41-boundary-seed", seed }),
      eventTags: [tag],
      eventType: "G41BoundarySeed",
      provenance: "g32",
      allocatorLineageId: "g41-boundary-seed-lineage",
      timestamp: G32_FIXTURE_TIMESTAMP,
    }],
  });
  expect(seeded.status).toBe(201);
  const facts = await SELF.fetch(tagUrl(serviceId, tag, "/head-facts"));
  expect(facts.status).toBe(200);
  return (await facts.json<{ head: string }>()).head;
}

/**
 * Establishes a pre-existing observed head without fabricating an event,
 * membership, or obligation.  The actual boundary begins with the two normal
 * /acquire calls below; this setup only gives both of them a real, matching
 * durable head to compare against without contaminating the G44 source
 * partition whose sole row must be the first post-boundary append.
 */
async function seedObservedTagHead(
  serviceId: string,
  tag: string,
  seed: string,
): Promise<string> {
  // This invokes ensureSqlTag through the real route but deliberately omits
  // the consistency entry, so it cannot acquire a reservation.
  const initialized = await tagPost(serviceId, tag, "/acquire", {
    attemptId: `g41-seed:${seed}`,
    epoch: 0,
    eventTags: [tag],
    consistencyTags: [],
  });
  expect(initialized.status).toBe(200);
  const head = g32Suid(`g41-seed-head:${seed}`);
  await runInDurableObject(tagStub(serviceId, tag), async (_instance, state) => {
    const updatedAt = new Date().toISOString();
    state.storage.sql.exec(
      "UPDATE tag_control SET head_suid = ?, version = version + 1, updated_at = ? WHERE singleton = 1",
      head,
      updatedAt,
    );
    state.storage.sql.exec(
      "UPDATE tag_head SET service_id = ?, head_suid = ? WHERE singleton = 1",
      serviceId,
      head,
    );
  });
  const facts = await SELF.fetch(tagUrl(serviceId, tag, "/head-facts"));
  expect(facts.status).toBe(200);
  return (await facts.json<{ head: string }>()).head;
}

async function reserveObservedTag(
  serviceId: string,
  tag: string,
  attemptId: string,
  expectedHead: string,
): Promise<{ attemptId: string; epoch: number; token: string; expectedHead: string; expiresAt: number }> {
  const acquired = await tagPost(serviceId, tag, "/acquire", {
    attemptId,
    epoch: 0,
    eventTags: [tag],
    consistencyTags: [{ tag, lastSortableUniqueId: expectedHead }],
  });
  expect(acquired.status).toBe(201);
  const body = await acquired.json<{
    reservation: { attemptId: string; epoch: number; token: string; expectedHead: string; expiresAt: number };
  }>();
  return body.reservation;
}

async function allocateObservedVector(
  serviceId: string,
  attemptId: string,
  eventId: string,
): Promise<AllocationVector> {
  const allocated = await allocatorStub(serviceId).fetch(new Request("https://allocator.test/allocate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      attemptId,
      candidates: [{ candidateIndex: 0, eventId }],
    }),
  }));
  expect(allocated.status).toBe(201);
  const vector = await allocated.json<AllocationVector>();
  expect(vector).toMatchObject({
    attemptId,
    allocatorLineageId: expect.any(String),
    candidates: [{ candidateIndex: 0, eventId, suid: expect.any(String) }],
  });
  return vector;
}

async function expireByRealTagAlarm(serviceId: string, tag: string, expiresAt: number): Promise<void> {
  expect((await tagPost(serviceId, tag, "/debug/clock", { nowMs: expiresAt + 1 })).status).toBe(200);
  // The test-only route invokes the same private runAlarm implementation as
  // DurableObject.alarm without waiting thirty real-time seconds.
  expect((await tagPost(serviceId, tag, "/debug/alarm", {})).status).toBe(200);
}

async function readAllocation(serviceId: string, attemptId: string): Promise<Response> {
  return allocatorStub(serviceId).fetch(new Request(
    `https://allocator.test/attempts/${encodeURIComponent(attemptId)}`,
  ));
}

async function configureD1BackedTag(serviceId: string, tag: string): Promise<() => Promise<void>> {
  let previousD1: D1Database | undefined;
  let previousAutoDrain: string | undefined;
  await runInDurableObject(tagStub(serviceId, tag), (instance) => {
    const runtime = instance as unknown as { env: { D1?: D1Database; AUTO_DRAIN_OUTBOX?: string } };
    previousD1 = runtime.env.D1;
    previousAutoDrain = runtime.env.AUTO_DRAIN_OUTBOX;
    runtime.env.D1 = database();
    runtime.env.AUTO_DRAIN_OUTBOX = "false";
  });
  // Miniflare may share a binding object between DO instances in a worker
  // isolate. Restore this fixture-only override so a zero-delivery G41 case
  // cannot alter another file's independent scheduler test.
  return async () => {
    await runInDurableObject(tagStub(serviceId, tag), (instance) => {
      const runtime = instance as unknown as { env: { D1?: D1Database; AUTO_DRAIN_OUTBOX?: string } };
      runtime.env.D1 = previousD1;
      runtime.env.AUTO_DRAIN_OUTBOX = previousAutoDrain;
    });
  };
}

/**
 * The source-obligation fixture deliberately disables delivery. Its new row
 * is immediately due, which makes a real DO alarm retry forever by design.
 * Move only the test row to a future due time after the commit has proved its
 * local atomic write, so it cannot leave an unrelated test worker busy.
 */
async function deferDisabledDeliveryRetry(serviceId: string, tag: string): Promise<void> {
  await runInDurableObject(tagStub(serviceId, tag), async (_instance, state) => {
    const dueAt = Date.now() + 60_000;
    state.storage.sql.exec(
      "UPDATE tag_outbox_obligation SET next_attempt_at = ? WHERE status = 'pending'",
      dueAt,
    );
    await state.storage.setAlarm(dueAt);
  });
}

async function sourceRows(serviceId: string, tag: string): Promise<SourceObligationPage["rows"]> {
  const bound = await database().prepare(
    "SELECT last_obligation_sequence FROM serialized_dcb_source_partitions WHERE service_id = ? AND partition_tag = ?",
  ).bind(serviceId, tag).first<{ last_obligation_sequence: number }>();
  if (bound === null || bound === undefined) throw new Error("G41 source partition is absent");
  const page = await runInDurableObject(tagStub(serviceId, tag), (instance) =>
    (instance as unknown as TagScannerSeam).g44ReadSourceObligations({
      serviceId,
      tag,
      upperBoundSequence: bound.last_obligation_sequence,
      afterSequence: 0,
      limit: 64,
    }));
  return page.rows;
}

beforeAll(async () => {
  const existing = await database().prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dcb_events'",
  ).first<{ name: string }>();
  if (existing === null || existing === undefined) {
    const statements = (g32Migration as string).replace(/^\s*--.*$/gm, "")
      .split(";").map((statement) => statement.trim()).filter(Boolean)
      .map((statement) => database().prepare(statement));
    await database().batch(statements);
  }
  await applyG44D1Migration(database());
});

describe("SDT-G41 Journal-free commit path", () => {
  it("AC2: performs zero JOURNAL namespace calls while the Tag positive control is live", async () => {
    const run = fakeRun();

    const response = await run.worker.handle(request(["room:g41:a", "room:g41:b"]));

    expect(response.status).toBe(200);
    expect(run.journalCalls).toEqual({ idFromName: 0, get: 0, fetch: 0 });
    expect(run.tagCalls.idFromName).toBeGreaterThan(0);
    expect(run.tagCalls.get).toBeGreaterThan(0);
    expect(run.tagCalls.fetch).toBeGreaterThan(0);
  });

  it("AC3: prepare failure cancels every already-reserved tag and leaves the primary refusal intact", async () => {
    const first = "room:g41:prepare:a";
    const refused = "room:g41:prepare:b";
    const run = fakeRun({
      acquire: (tag) => tag === refused
        ? json({ reason: "consistency_head_mismatch" }, 409)
        : json({ reservation: { token: `token:${tag}` } }, 201),
      cancel: () => json({ code: "cancel_ack_lost" }, 503),
    });

    const response = await run.worker.handle(request([first, refused]));
    const body = await response.json<{ code: string }>();

    expect(response.status).toBe(400);
    expect(body.code).toBe("consistency_conflict");
    expect(run.allocatorCalls).toEqual({ idFromName: 0, get: 0, fetch: 0 });
    expect(run.appends).toEqual([]);
    expect(run.cancels.map((entry) => entry.tag)).toEqual([first]);
    expect(run.cancels[0]?.body).toMatchObject({ epoch: 0, forceTombstone: true });
    expect(run.journalCalls).toEqual({ idFromName: 0, get: 0, fetch: 0 });
  });

  it("AC3: commit failure cancels every tag but cannot delete a committed event or overwrite partial_write", async () => {
    const written = "room:g41:commit:a";
    const missing = "room:g41:commit:b";
    const run = fakeRun({
      append: (tag) => tag === missing ? json({ code: "append_failed" }, 500) : json({ appended: true }, 201),
      cancel: () => json({ code: "cancel_ack_lost" }, 503),
    });

    const response = await run.worker.handle(request([written, missing]));
    const body = await response.json<{ code: string; partial: { writtenTags: string[]; missingTags: string[]; eventsDeleted: boolean } }>();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      code: "partial_write",
      partial: { writtenTags: [written], missingTags: [missing], eventsDeleted: false },
    });
    expect(run.appends).toEqual([written, missing, missing]);
    expect(run.cancels.map((entry) => entry.tag).sort()).toEqual([missing, written].sort());
    expect(run.fences).toEqual([
      expect.objectContaining({
        tag: missing,
        body: expect.objectContaining({ attemptId: expect.any(String), epoch: 0, reason: "partial_write" }),
      }),
    ]);
    // The fake represents the durable event written by the first append.
    // Cancellation receives no deletion capability and cannot remove it.
    expect(run.appends).toContain(written);
    expect(run.journalCalls).toEqual({ idFromName: 0, get: 0, fetch: 0 });
  });

  it("AC4 genuine interruption boundary 1: surviving reservations converge through Tag alarms with no CommitWorker cleanup", async () => {
    const serviceId = `g41-boundary-1-${crypto.randomUUID()}`;
    const preparedTags = ["room:g41:boundary:one:a", "room:g41:boundary:one:b"];
    const attemptId = `g41-boundary-1:${crypto.randomUUID()}`;
    const heads = await Promise.all(preparedTags.map((tag, index) => seedObservedTag(serviceId, tag, `one-${index}`)));
    const reservations = await Promise.all(preparedTags.map((tag, index) =>
      reserveObservedTag(serviceId, tag, attemptId, heads[index]!)));

    // This directly seeds the durable post-reservation/pre-allocation state
    // and deliberately invokes no CommitWorker cancellation or fence path.
    for (const [index, tag] of preparedTags.entries()) {
      const before = await readTagState(serviceId, tag);
      expect(before.activeReservation).toMatchObject({ attemptId, epoch: 0 });
      expect(before.alarmDueAt).not.toBeNull();
      await expireByRealTagAlarm(serviceId, tag, reservations[index]!.expiresAt);
      const after = await readTagState(serviceId, tag);
      expect(after.activeReservation).toBeNull();
      expect(after.alarmDueAt).toBeNull();
    }
    expect((await readAllocation(serviceId, attemptId)).status).toBe(404);
  });

  it("AC4 genuine interruption boundary 2: a surviving orphan allocation vector is dispositioned after Tag alarm convergence without Worker cleanup", async () => {
    const serviceId = `g41-boundary-2-${crypto.randomUUID()}`;
    const preparedTags = ["room:g41:boundary:two:a", "room:g41:boundary:two:b"];
    const attemptId = `g41-boundary-2:${crypto.randomUUID()}`;
    const heads = await Promise.all(preparedTags.map((tag, index) => seedObservedTag(serviceId, tag, `two-${index}`)));
    const worker = new CommitWorker(env as unknown as CommitWorkerEnv, serviceId, {
      // This is a genuine interruption at the allocator-to-first-append
      // boundary. The exception escapes handle(), so no post-boundary Worker
      // cancellation or partial-write fence code can execute.
      beforeBootstrapFinalization: () => {
        throw new Error("g41 genuine interruption after allocator commit");
      },
    });
    await expect(worker.handle(request(
      preparedTags,
      preparedTags,
      "tag-append-last",
      attemptId,
      heads,
    ))).rejects.toThrow("g41 genuine interruption after allocator commit");

    const vector = await readAllocation(serviceId, attemptId);
    expect(vector.status).toBe(200);
    const allocated = await vector.json<{ attemptId: string; candidates: Array<{ eventId: string }> }>();
    expect(allocated).toMatchObject({ attemptId, candidates: [{ eventId: expect.any(String) }] });
    const candidateEventId = allocated.candidates[0]!.eventId;
    const reservations = await Promise.all(preparedTags.map(async (tag) => {
      const state = await readTagState(serviceId, tag);
      expect(state.activeReservation).toMatchObject({ attemptId, epoch: 0 });
      return state.activeReservation!;
    }));

    for (const [index, tag] of preparedTags.entries()) {
      await expireByRealTagAlarm(serviceId, tag, reservations[index]!.expiresAt);
      const state = await readTagState(serviceId, tag);
      expect(state.activeReservation).toBeNull();
      expect(state.events.map((event) => event.eventId)).not.toContain(candidateEventId);
    }
    const survivingVector = await readAllocation(serviceId, attemptId);
    expect(survivingVector.status).toBe(200);
    expect(await survivingVector.json()).toMatchObject({ attemptId, candidates: [{ eventId: candidateEventId }] });
  });

  it("AC4 boundary 4: all tag writes can survive a lost response without fabricating a Journal terminal outcome", async () => {
    const first = "room:g41:response:a";
    const second = "room:g41:response:b";
    const run = fakeRun();

    const response = await run.worker.handle(request([first, second], [first, second], "sealing-after-cas"));
    const body = await response.json<{ code: string }>();

    expect(response.status).toBe(504);
    expect(body.code).toBe("timeout");
    expect(run.appends).toEqual([first, second]);
    expect(run.cancels).toEqual([]);
    expect(run.journalCalls).toEqual({ idFromName: 0, get: 0, fetch: 0 });
  });

  it("AC3: a superseded attempt epoch is rejected by the real Tag owner after its cancel tombstone", async () => {
    const serviceId = `g41-stale-${crypto.randomUUID()}`;
    const tag = "room:g41:stale";
    const eventId = g32EventId("g41-stale-seed");
    const seed = await SELF.fetch(`https://tag.test/tags/${encodeURIComponent(serviceId)}/${encodeURIComponent(tag)}/append`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attemptId: "g41-stale-seed",
        epoch: 0,
        candidates: [{
          eventId,
          suid: g32Suid("g41-stale-seed"),
          payload: JSON.stringify({ fixture: "g41-stale" }),
          eventTags: [tag],
          eventType: "G41Stale",
          provenance: "g32",
          allocatorLineageId: "g41-stale-lineage",
          timestamp: G32_FIXTURE_TIMESTAMP,
        }],
      }),
    });
    expect(seed.status).toBe(201);
    const head = (await SELF.fetch(
      `https://tag.test/tags/${encodeURIComponent(serviceId)}/${encodeURIComponent(tag)}/head-facts`,
    ));
    expect(head.status).toBe(200);
    const facts = await head.json<{ head: string }>();
    const attemptId = "g41-superseded-attempt";
    const acquired = await SELF.fetch(`https://tag.test/tags/${encodeURIComponent(serviceId)}/${encodeURIComponent(tag)}/acquire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attemptId, epoch: 0, eventTags: [tag], consistencyTags: [{ tag, lastSortableUniqueId: facts.head }] }),
    });
    expect(acquired.status).toBe(201);
    const cancelled = await SELF.fetch(`https://tag.test/tags/${encodeURIComponent(serviceId)}/${encodeURIComponent(tag)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attemptId, epoch: 0, forceTombstone: true }),
    });
    expect(cancelled.status).toBe(200);
    const delayed = await SELF.fetch(`https://tag.test/tags/${encodeURIComponent(serviceId)}/${encodeURIComponent(tag)}/acquire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attemptId, epoch: 0, eventTags: [tag], consistencyTags: [{ tag, lastSortableUniqueId: facts.head }] }),
    });
    expect(delayed.status).toBe(409);
    expect(await delayed.json()).toMatchObject({ reason: "tombstoned_epoch" });
  });

  it("AC4 genuine interruption boundary 3: surviving source facts discover zero-delivery G44 incompleteness without CommitWorker compensation", async () => {
    const serviceId = `g41-source-${crypto.randomUUID()}`;
    const writtenTag = "room:g41:source:written";
    const missingTag = "room:g41:source:missing";
    const attemptId = `g41-boundary-3:${crypto.randomUUID()}`;
    const eventId = g32EventId(`g41-boundary-3:${attemptId}`);
    const [writtenHead, missingHead] = await Promise.all([
      seedObservedTagHead(serviceId, writtenTag, "three-written"),
      seedObservedTagHead(serviceId, missingTag, "three-missing"),
    ]);
    const [writtenReservation, missingReservation] = await Promise.all([
      reserveObservedTag(serviceId, writtenTag, attemptId, writtenHead),
      reserveObservedTag(serviceId, missingTag, attemptId, missingHead),
    ]);
    expect(writtenReservation).toMatchObject({ attemptId, epoch: 0, expectedHead: writtenHead });
    expect(missingReservation).toMatchObject({ attemptId, epoch: 0, expectedHead: missingHead });
    expect(writtenReservation.token).not.toBe(missingReservation.token);
    const allocated = await allocateObservedVector(serviceId, attemptId, eventId);
    const allocatedCandidate = allocated.candidates[0]!;
    const allocationBeforeFirstAppend = await readAllocation(serviceId, attemptId);
    expect(allocationBeforeFirstAppend.status).toBe(200);
    expect(await allocationBeforeFirstAppend.json<AllocationVector>()).toEqual(allocated);
    const restoreWritten = await configureD1BackedTag(serviceId, writtenTag);
    const restoreMissing = await configureD1BackedTag(serviceId, missingTag);
    try {
      // This is the exact durable boundary after real reservations and a
      // durable vector but immediately after only the first real local append.
      // A matching reservation token makes appendSql atomically confirm the
      // written reservation; no CommitWorker is left alive to compensate the
      // missing reservation or to install a post-boundary partial-write fence.
      const response = await tagPost(serviceId, writtenTag, "/append", {
        attemptId,
        epoch: 0,
        reservationToken: writtenReservation.token,
        candidates: [{
          eventId,
          suid: allocatedCandidate.suid,
          payload: JSON.stringify({ fixture: "g41-boundary-3" }),
          eventTags: [writtenTag, missingTag],
          eventType: "G41BoundaryThree",
          provenance: "g32",
          allocatorLineageId: allocated.allocatorLineageId,
          timestamp: G32_FIXTURE_TIMESTAMP,
        }],
      });
      expect(response.status).toBe(201);
      await deferDisabledDeliveryRetry(serviceId, writtenTag);

      const [writtenAfterFirstAppend, missingBeforeAlarm] = await Promise.all([
        readTagState(serviceId, writtenTag),
        readTagState(serviceId, missingTag),
      ]);
      expect(writtenAfterFirstAppend.events.map((event) => event.eventId)).toContain(eventId);
      expect(writtenAfterFirstAppend.activeReservation).toBeNull();
      expect(missingBeforeAlarm).toMatchObject({
        activeReservation: {
          attemptId,
          epoch: 0,
          token: missingReservation.token,
          expectedHead: missingHead,
          expiresAt: missingReservation.expiresAt,
        },
      });
      expect(missingBeforeAlarm.alarmDueAt).not.toBeNull();
      expect(missingBeforeAlarm.events.map((event) => event.eventId)).not.toContain(eventId);
      expect(missingBeforeAlarm.fences).toEqual([]);

      const rows = await sourceRows(serviceId, writtenTag);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        declaredTagSet: [missingTag, writtenTag].sort(),
        localCommittedMembership: [{ serviceId, tag: writtenTag }],
        status: "pending",
      });
      expect(rows[0]?.declaredTagSet).toHaveLength(2);
      expect(rows[0]?.localCommittedMembership).toHaveLength(1);
      const delivered = await database().prepare(
        'SELECT COUNT(*) AS count FROM dcb_events WHERE "ServiceId" = ?',
      ).bind(serviceId).first<{ count: number }>();
      const receipts = await database().prepare(
        "SELECT COUNT(*) AS count FROM serialized_dcb_global_receipts WHERE service_id = ?",
      ).bind(serviceId).first<{ count: number }>();
      expect(delivered?.count ?? 0).toBe(0);
      expect(receipts?.count ?? 0).toBe(0);

      // This is the real Tag DO alarm body, reached after the interruption;
      // it clears only the missing reservation without Worker compensation.
      await expireByRealTagAlarm(serviceId, missingTag, missingReservation.expiresAt);
      const missingAfterAlarm = await readTagState(serviceId, missingTag);
      expect(missingAfterAlarm.activeReservation).toBeNull();
      expect(missingAfterAlarm.alarmDueAt).toBeNull();
      expect(missingAfterAlarm.events.map((event) => event.eventId)).not.toContain(eventId);
      expect(missingAfterAlarm.fences).toEqual([]);

      // The allocator's orphan vector is an explicit durable disposition: it
      // survives the interruption and alarm convergence for allocator-side
      // reconciliation; neither the test nor CommitWorker deletes it.
      const orphanVector = await readAllocation(serviceId, attemptId);
      expect(orphanVector.status).toBe(200);
      expect(await orphanVector.json<AllocationVector>()).toEqual(allocated);

      const reconciler = new GlobalCompletenessReconciler(database(), tags());
      await expect(reconciler.reconcile(serviceId, 41_000)).resolves.toMatchObject({ kind: "BLOCK", findingCount: 1 });
      const finding = await database().prepare(
        "SELECT incident_type, state FROM serialized_dcb_completeness_findings WHERE service_id = ?",
      ).bind(serviceId).first<{ incident_type: string; state: string }>();
      expect(finding).toEqual({ incident_type: "GLOBAL_ARRAY_RECEIPT_ABSENT", state: "OPEN" });
    } finally {
      await restoreMissing();
      await restoreWritten();
    }
  });
});
