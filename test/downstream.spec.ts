import { createExecutionContext, createMessageBatch, env, getQueueResult, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { handleSerializedCommit, type CommitWorkerEnv } from "../packages/dcb-runtime/src/commit/CommitWorker";
import { handleDownstreamQueue, processDownstreamDelivery } from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import {
  type ExclusionLedgerPort,
  InconsistencyDetector,
  MIN_STABILITY_HORIZON_MS,
} from "../packages/dcb-runtime/src/downstream/InconsistencyDetector";
import { drainTagOutbox } from "../packages/dcb-runtime/src/downstream/OutboxDrain";
import type { DownstreamOutboxMessage, PipelineClock } from "../packages/dcb-runtime/src/downstream/types";
import type { Env as WorkerEnv } from "../packages/dcb-runtime/src/index";
import { PostgresEventStore } from "../packages/dcb-runtime/src/store/PostgresEventStore";
import { createPostgresStoreProvider } from "../packages/dcb-runtime/src/store/provider";

const PAYLOAD = "cGF5bG9hZA==";

function unique(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function mutableClock(nowMs: number): { clock: PipelineClock; set(now: number): void } {
  let now = nowMs;
  return { clock: { now: () => now }, set: (next) => { now = next; } };
}

function message(
  serviceId: string,
  eventId: string,
  suid: string,
  tag: string,
  eventTags: string[],
  enqueuedAt: number,
): DownstreamOutboxMessage {
  return {
    version: 1,
    serviceId,
    allocatorLineageId: "legacy-pre-g17",
    tag,
    attemptId: `${eventId}-attempt`,
    eventId,
    suid,
    payload: PAYLOAD,
    eventTags,
    provenance: "pre-g27-queue",
    enqueuedAt,
  };
}

async function appendOutboxCopy(
  serviceId: string,
  tag: string,
  body: { attemptId: string; eventId: string; suid: string; eventTags: string[] },
): Promise<void> {
  const response = await SELF.fetch(
    `https://downstream.test/tags/${encodeURIComponent(serviceId)}/${encodeURIComponent(tag)}/append`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attemptId: body.attemptId,
        epoch: 0,
        candidates: [{
          eventId: body.eventId,
          suid: body.suid,
          payload: PAYLOAD,
          eventTags: body.eventTags,
          provenance: "pre-g27",
          legacyMigrationMarker: "pre-g27-append-v1",
        }],
      }),
    },
  );
  expect(response.status, await response.clone().text()).toBe(201);
}

function collectingQueue(messages: DownstreamOutboxMessage[]): Queue<DownstreamOutboxMessage> {
  return {
    async metrics() {
      return { backlogCount: messages.length, backlogBytes: 0 };
    },
    async send(body) {
      messages.push(body);
      return { metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } } };
    },
    async sendBatch(batch) {
      for (const entry of batch) {
        messages.push(entry.body);
      }
      return { metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } } };
    },
  };
}

function postgresStore(): PostgresEventStore {
  const url = (env as unknown as WorkerEnv).POSTGRES_URL;
  if (url === undefined) {
    throw new Error("POSTGRES_URL binding is required; run docker compose up --wait postgres");
  }
  return new PostgresEventStore(url);
}

/** Database sockets are retained for the lifetime of the Miniflare isolate. */
async function withPostgresStore<T>(operation: (store: PostgresEventStore) => Promise<T>): Promise<T> {
  const store = postgresStore();
  await store.initialize();
  return operation(store);
}

describe("SDT-G7 downstream pipeline and PostgreSQL event store", () => {
  it("drains durable Tag outboxes to Queue, survives duplicate/reordered retry storms, scans by service/SUID, and keeps commit downstream-read-free", async () => {
    const serviceId = unique("downstream-service");
    const tags = [unique("downstream-a"), unique("downstream-b")];
    const eventId = unique("z-downstream-event");
    const attemptId = unique("downstream-attempt");
    const clock = mutableClock(1_000);
    for (const tag of tags) {
      await appendOutboxCopy(serviceId, tag, {
        attemptId,
        eventId,
        suid: "suid-00000000000000000000000000000001",
        eventTags: tags,
      });
    }

    const queued: DownstreamOutboxMessage[] = [];
    const drainEnv = {
      TAG: (env as unknown as WorkerEnv).TAG,
      DOWNSTREAM_QUEUE: collectingQueue(queued),
    };
    expect((await drainTagOutbox({ serviceId, tag: tags[0]! }, drainEnv, clock.clock)).delivered).toBe(1);
    expect((await drainTagOutbox({ serviceId, tag: tags[1]! }, drainEnv, clock.clock)).delivered).toBe(1);
    expect((await drainTagOutbox({ serviceId, tag: tags[0]! }, drainEnv, clock.clock)).delivered).toBe(0);
    expect(queued).toHaveLength(2);
    expect(queued.map((entry) => entry.enqueuedAt)).toEqual([1_000, 1_000]);

    const retryTag = unique("outbox-retry");
    await appendOutboxCopy(serviceId, retryTag, {
      attemptId: unique("outbox-retry-attempt"),
      eventId: unique("outbox-retry-event"),
      suid: "suid-00000000000000000000000000000003",
      eventTags: [retryTag],
    });
    const retrySends: DownstreamOutboxMessage[] = [];
    let failOnce = true;
    const retryQueue: Queue<DownstreamOutboxMessage> = {
      ...collectingQueue(retrySends),
      async send(body) {
        retrySends.push(body);
        if (failOnce) {
          failOnce = false;
          throw new Error("injected Queue retry");
        }
        return { metadata: { metrics: { backlogCount: retrySends.length, backlogBytes: 0 } } };
      },
    };
    await expect(drainTagOutbox({ serviceId, tag: retryTag }, {
      TAG: (env as unknown as WorkerEnv).TAG,
      DOWNSTREAM_QUEUE: retryQueue,
    }, clock.clock)).rejects.toThrow("injected Queue retry");
    expect((await drainTagOutbox({ serviceId, tag: retryTag }, {
      TAG: (env as unknown as WorkerEnv).TAG,
      DOWNSTREAM_QUEUE: retryQueue,
    }, clock.clock)).delivered).toBe(1);
    expect(retrySends).toHaveLength(2);
    expect(retrySends[0]!.enqueuedAt).toBe(retrySends[1]!.enqueuedAt);

    await withPostgresStore(async (store) => {
      const retryStorm = [queued[1]!, queued[0]!, queued[1]!, queued[0]!, queued[0]!];
      const batch = createMessageBatch("serialized-dcb-v1-outbox", retryStorm.map((body, index) => ({
        id: `retry-${index}`,
        timestamp: new Date(clock.clock.now()),
        attempts: index + 1,
        body,
      })));
      await handleDownstreamQueue(batch, { POSTGRES_URL: (env as unknown as WorkerEnv).POSTGRES_URL }, {
        store,
        clock: clock.clock,
      });
      const queueResult = await getQueueResult(batch, createExecutionContext());
      expect(queueResult.retryMessages).toEqual([]);
      expect(queueResult.explicitAcks).toHaveLength(retryStorm.length);

      const second = message(
        serviceId,
        unique("a-scan-second"),
        "suid-00000000000000000000000000000002",
        tags[0]!,
        [tags[0]!],
        1_000,
      );
      clock.set(1_010);
      await store.recordDelivery(second, clock.clock.now());
      const secondDetector = new InconsistencyDetector(store, { isExcludedAudited: async () => false });
      await secondDetector.observe(second, clock.clock.now(), await store.currentLagBound(serviceId));

      const anotherService = message(
        unique("other-service"),
        unique("other-event"),
        "suid-00000000000000000000000000000000",
        unique("other-tag"),
        [unique("other-only-tag")],
        1_000,
      );
      await store.recordDelivery(anotherService, clock.clock.now());

      const all = await store.readAllEvents(serviceId, "");
      expect(all.map((event) => event.suid)).toEqual([
        "suid-00000000000000000000000000000001",
        "suid-00000000000000000000000000000002",
      ]);
      expect(all[0]!.arrivals.map((arrival) => arrival.tag)).toEqual([...tags].sort());
      expect(await store.readAllEvents(serviceId, all[0]!.suid)).toMatchObject([{ eventId: second.eventId }]);

      const downstreamReads: string[] = [];
      const base = env as unknown as CommitWorkerEnv;
      const instrumented = new Proxy(base, {
        get(target, property, receiver) {
          const name = String(property);
          if (name === "DOWNSTREAM_QUEUE" || name === "POSTGRES_URL" || name === "HYPERDRIVE") {
            downstreamReads.push(name);
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const commitTag = unique("commit-does-not-read-downstream");
      const commitResponse = await handleSerializedCommit(new Request("https://commit.test/api/sekiban/serialized/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          eventCandidates: [{ payload: PAYLOAD, eventPayloadName: "DownstreamReadProbe", tags: [commitTag] }],
          consistencyTags: [{ tag: commitTag, lastSortableUniqueId: "" }],
        }),
      }), instrumented);
      expect(commitResponse.status, await commitResponse.clone().text()).toBe(200);
      expect(downstreamReads).toEqual([]);
    });
  });

  it("returns after Queue persistence without waiting for read-side convergence", async () => {
    const serviceId = unique("queue-consumer-no-convergence-wait");
    const tag = unique("queue-consumer-tag");
    const body = message(
      serviceId,
      unique("queue-consumer-event"),
      "suid-queue-consumer-no-convergence-wait",
      tag,
      [tag],
      Date.now(),
    );
    const batch = createMessageBatch("serialized-dcb-v1-outbox", [{
      id: unique("queue-consumer-delivery"),
      timestamp: new Date(),
      attempts: 1,
      body,
    }]);

    // Omitting AdapterOptions.store deliberately exercises the production
    // Postgres Queue-consumer path. The consumer persists/observes delivery
    // and returns; cron/operator projection polling owns convergence.
    const startedAt = performance.now();
    await handleDownstreamQueue(batch, {
      POSTGRES_URL: (env as unknown as WorkerEnv).POSTGRES_URL,
    }, { storeProvider: createPostgresStoreProvider() });
    const elapsedMs = performance.now() - startedAt;
    const queueResult = await getQueueResult(batch, createExecutionContext());
    expect(queueResult.retryMessages).toEqual([]);
    expect(queueResult.explicitAcks).toHaveLength(1);
    // The removed SafeWindow sleep was at least 20,025ms at the floor. Keep
    // this budget comfortably below that block while allowing DB bootstrap.
    expect(elapsedMs).toBeLessThan(10_000);
  }, 15_000);

  it("holds a low-lag missing arrival until the 20 second stability floor", async () => {
    const serviceId = unique("stability-floor-service");
    const tags = [unique("stability-floor-a"), unique("stability-floor-b")];
    const clock = mutableClock(10_000);
    await withPostgresStore(async (store) => {
      const detector = new InconsistencyDetector(store, { isExcludedAudited: async () => false });
      const lowLagMissing = message(
        serviceId,
        unique("low-lag-missing"),
        "suid-low-lag-missing",
        tags[0]!,
        tags,
        9_900,
      );
      await store.recordDelivery(lowLagMissing, clock.clock.now());
      await detector.observe(lowLagMissing, clock.clock.now(), await store.currentLagBound(serviceId));

      const pending = (await store.listPending(serviceId)).find((entry) => entry.eventId === lowLagMissing.eventId)!;
      expect(MIN_STABILITY_HORIZON_MS).toBe(20_000);
      expect(pending.lagBoundMs).toBe(20_000);

      clock.set(pending.firstObservedAt + pending.lagBoundMs - 1);
      await detector.stabilize(clock.clock, serviceId);
      expect(await store.listFindings(serviceId, lowLagMissing.eventId)).toEqual([]);

      clock.set(pending.firstObservedAt + pending.lagBoundMs);
      await detector.stabilize(clock.clock, serviceId);
      expect(await store.listFindings(serviceId, lowLagMissing.eventId)).toMatchObject([
        { path: tags[1], classification: "MISSING_STABLE" },
      ]);
    });
  });

  it("stabilizes only pipeline clock facts, classifies exclusions immediately, appends resolved-late findings, and never lets the detector write event rows", async () => {
    const serviceId = unique("clock-service");
    const tags = [unique("clock-a"), unique("clock-b")];
    const clock = mutableClock(1_000);
    const exclusions: ExclusionLedgerPort = {
      isExcludedAudited: async (input) => input.eventId === "known-exclusion" && input.tag === tags[1],
    };
    await withPostgresStore(async (store) => {
      const detector = new InconsistencyDetector(store, exclusions);
      const ingest = async (entry: DownstreamOutboxMessage): Promise<void> => {
        await store.recordDelivery(entry, clock.clock.now());
        await detector.observe(entry, clock.clock.now(), await store.currentLagBound(entry.serviceId));
      };

      const completeEarly = message(serviceId, "complete-before-horizon", "suid-10", tags[0]!, tags, 900);
      await ingest(completeEarly);
      clock.set(20_999);
      await ingest({ ...completeEarly, tag: tags[1]! });
      await detector.stabilize(clock.clock, serviceId);
      expect(await store.listFindings(serviceId, completeEarly.eventId)).toEqual([]);

      clock.set(30_000);
      const permanentlyMissing = message(serviceId, "missing-after-horizon", "suid-20", tags[0]!, tags, 5_000);
      await ingest(permanentlyMissing);
      const pending = (await store.listPending(serviceId)).find((entry) => entry.eventId === permanentlyMissing.eventId)!;
      expect(pending.lagBoundMs).toBe(25_000);
      const eventsBeforeStabilization = await store.readAllEvents(serviceId, "");
      clock.set(pending.firstObservedAt + pending.lagBoundMs - 1);
      await detector.stabilize(clock.clock, serviceId);
      expect(await store.listFindings(serviceId, permanentlyMissing.eventId)).toEqual([]);
      clock.set(pending.firstObservedAt + pending.lagBoundMs);
      await detector.stabilize(clock.clock, serviceId);
      expect(await store.listFindings(serviceId, permanentlyMissing.eventId)).toMatchObject([
        { path: tags[1], classification: "MISSING_STABLE" },
      ]);
      expect(await store.readAllEvents(serviceId, "")).toEqual(eventsBeforeStabilization);

      clock.set(clock.clock.now() + 1);
      await ingest({ ...permanentlyMissing, tag: tags[1]! });
      expect(await store.listFindings(serviceId, permanentlyMissing.eventId)).toMatchObject([
        { path: tags[1], classification: "MISSING_STABLE" },
        { path: tags[1], classification: "RESOLVED_LATE" },
      ]);

      const excluded = message(serviceId, "known-exclusion", "suid-30", tags[0]!, tags, clock.clock.now());
      const lookupCalls: Array<Record<string, unknown>> = [];
      const lookup = {
        async fetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
          lookupCalls.push(JSON.parse(init?.body as string) as Record<string, unknown>);
          return new Response(JSON.stringify({ classification: "EXCLUDED_AUDITED" }), {
            headers: { "content-type": "application/json" },
          });
        },
      } as Fetcher;
      await processDownstreamDelivery(excluded, {
        POSTGRES_URL: (env as unknown as WorkerEnv).POSTGRES_URL,
        REPAIR_EXCLUSION_LOOKUP: lookup,
      }, { store, clock: clock.clock });
      expect(lookupCalls).toEqual([expect.objectContaining({
        serviceId,
        attemptId: excluded.attemptId,
        eventId: excluded.eventId,
        tag: tags[1],
      })]);
      expect(await store.listFindings(serviceId, excluded.eventId)).toMatchObject([
        { path: tags[1], classification: "EXCLUDED_AUDITED" },
      ]);
    });
  });
});
