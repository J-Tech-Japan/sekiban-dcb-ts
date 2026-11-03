import { createMessageBatch, env, getQueueResult, createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createOrdinaryConditionalExecutor } from "../packages/dcb-runtime/src/commit/ConditionalCommitWorker";
import type { CommitWorkerEnv } from "../packages/dcb-runtime/src/commit/CommitWorker";
import { handleDownstreamQueue, processDownstreamDoorbell } from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import { drainTagOutbox } from "../packages/dcb-runtime/src/downstream/OutboxDrain";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { projectionIdFor, ProjectionRuntime } from "../packages/dcb-runtime/src/projection/ProjectionRuntime";
import { ProjectorRegistry, type ProjectionEvent, type TagStateProjector } from "../packages/dcb-runtime/src/projection/ProjectorRegistry";
import { TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/service/ServiceIdentityProvider";
import { PostgresEventStore } from "../packages/dcb-runtime/src/store/PostgresEventStore";

(globalThis as { __SDT_SKIP_CONDITIONAL_E2E_ENTRY?: boolean }).__SDT_SKIP_CONDITIONAL_E2E_ENTRY = true;
const { conditionalFixtureEvent, openConditionalFacade, registerPublicConditionalConformanceSuite } = await import("./conditional-commit-e2e.spec");

const PARSERS = { FixtureEvent: (payload: unknown) => payload };

function serviceId(): string {
  return `pg${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function requestFor(service: string, key: string, tag: string, payload: unknown = { n: 1 }): Request {
  return new Request("https://conditional.test/conditional", {
    method: "POST",
    headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: service },
    body: JSON.stringify({
      version: 1,
      idempotencyKey: key,
      eventCandidate: {
        payload: btoa(JSON.stringify(payload)),
        eventPayloadName: "FixtureEvent",
        tags: [tag],
      },
    }),
  });
}

function postgresUrl(): string {
  const url = (env as unknown as { POSTGRES_URL?: string }).POSTGRES_URL;
  if (url === undefined || url.length === 0) throw new Error("POSTGRES_URL is required");
  return url;
}

async function deliver(service: string, tag: string): Promise<DownstreamOutboxMessage[]> {
  const queued: DownstreamOutboxMessage[] = [];
  const drained = await drainTagOutbox({ serviceId: service, tag }, {
    TAG: (env as unknown as CommitWorkerEnv).TAG,
    DOWNSTREAM_QUEUE: {
      async metrics() { return { backlogCount: queued.length, backlogBytes: 0 }; },
      async send(body: DownstreamOutboxMessage) {
        queued.push(body);
        return { metadata: { metrics: { backlogCount: queued.length, backlogBytes: 0 } } };
      },
      async sendBatch(batch: Iterable<{ body: DownstreamOutboxMessage }>) {
        for (const entry of batch) queued.push(entry.body);
        return { metadata: { metrics: { backlogCount: queued.length, backlogBytes: 0 } } };
      },
    },
  });
  expect(queued).toHaveLength(drained.delivered);
  return queued;
}

async function deliverQueue(message: DownstreamOutboxMessage, store: PostgresEventStore): Promise<void> {
  const batch = createMessageBatch("serialized-dcb-v1-outbox", [{
    id: `${message.eventId}-queue`,
    timestamp: new Date(),
    attempts: 1,
    body: message,
  }]);
  await handleDownstreamQueue(batch, { POSTGRES_URL: postgresUrl() }, { store });
  expect((await getQueueResult(batch, createExecutionContext())).retryMessages).toEqual([]);
}

function witnessProjector(id: string): TagStateProjector {
  return {
    id,
    tagPayloadName: "FixtureEvent",
    projectorVersion: "1",
    initialState: () => [] as string[],
    apply(state: unknown, event: ProjectionEvent) {
      return [...(state as string[]), event.eventId];
    },
    serializeState: (state: unknown) => JSON.stringify(state),
    deserializeState: (serialized: string) => JSON.parse(serialized) as string[],
    payload: (state: unknown) => JSON.stringify(state),
    version: (state: unknown) => (state as string[]).length,
  };
}

const witnessProjectors = [witnessProjector("conditional-pg-a"), witnessProjector("conditional-pg-b")];

registerPublicConditionalConformanceSuite(
  "omitted-provider PostgreSQL",
  (dropFirst = false) => openConditionalFacade({ kind: "postgres", dropFirst }),
);

describe("conditional commit postgres delivery", () => {
  it("delivers one winner through the public facade and does not add an event for a same-operation retry", async () => {
    const store = new PostgresEventStore(postgresUrl());
    await store.initialize();
    const opened = openConditionalFacade({ kind: "postgres" });
    const tag = "Order:pg";
    const prepared = opened.executor.prepareConditionalCommit({
      idempotencyKey: "pg-key",
      event: conditionalFixtureEvent,
      payload: { sku: "pg" },
      tag,
    });
    const first = await opened.executor.commitPreparedConditionally(prepared);
    expect(first.outcome).toBe("Appended");
    const queued = await deliver(opened.serviceId, tag);
    expect(queued).toHaveLength(1);
    await deliverQueue(queued[0]!, store);
    const stored = await store.readAllEvents(opened.serviceId, "");
    expect(stored, "one postgres event").toHaveLength(1);
    if (first.outcome === "Appended") expect(stored[0]?.eventId).toBe(first.receipt.winnerEventId);
    const retry = await opened.executor.commitPreparedConditionally(prepared);
    expect(retry.outcome).toBe("AlreadyCommittedSameOperation");
    expect(await deliver(opened.serviceId, tag)).toHaveLength(0);
    expect(await store.readAllEvents(opened.serviceId, "")).toHaveLength(1);
  });

  it("keeps one postgres event when the same key is committed concurrently", async () => {
    const store = new PostgresEventStore(postgresUrl());
    await store.initialize();
    const service = serviceId();
    const tag = "Order:race";
    const executor = createOrdinaryConditionalExecutor();
    const responses = await Promise.all(Array.from({ length: 6 }, () => executor.handleConditionalCommit(
      requestFor(service, "race-key", tag, { sku: "race" }),
      env as unknown as CommitWorkerEnv,
      { registeredEventParsers: PARSERS },
    )));
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 200)).toHaveLength(5);
    const queued = await deliver(service, tag);
    expect(queued).toHaveLength(1);
    await deliverQueue(queued[0]!, store);
    expect(await store.readAllEvents(service, "")).toHaveLength(1);
    expect(await deliver(service, tag)).toHaveLength(0);
  });

  it.each(["direct-first", "queue-first"] as const)("applies one public winner per projector when delivery is %s", async (order) => {
    const store = new PostgresEventStore(postgresUrl());
    await store.initialize();
    const opened = openConditionalFacade({ kind: "postgres" });
    const tag = `order:${order}`;
    const prepared = opened.executor.prepareConditionalCommit({
      idempotencyKey: `${order}-key`,
      event: conditionalFixtureEvent,
      payload: { sku: order },
      tag,
    });
    const committed = await opened.executor.commitPreparedConditionally(prepared);
    expect(committed.outcome).toBe("Appended");
    if (committed.outcome !== "Appended") return;
    const queued = await deliver(opened.serviceId, tag);
    const message = queued[0];
    if (message === undefined) throw new Error("outbox message missing");
    if (order === "direct-first") {
      await processDownstreamDoorbell(message, { POSTGRES_URL: postgresUrl() }, { store });
      await deliverQueue(message, store);
    } else {
      await deliverQueue(message, store);
      await processDownstreamDoorbell(message, { POSTGRES_URL: postgresUrl() }, { store });
    }
    const stored = await store.readAllEvents(opened.serviceId, "");
    expect(stored, "one postgres event").toHaveLength(1);
    expect(stored[0]?.eventId).toBe(committed.receipt.winnerEventId);
    expect(stored[0]?.suid).toBe(committed.receipt.winnerSortableUniqueId);
    const runtime = new ProjectionRuntime(store, new ProjectorRegistry(witnessProjectors));
    const nowMs = Date.now() + 60_000;
    const [tagGroup, tagContent] = tag.split(":");
    const unsafeViews = witnessProjectors.map((item) => item.apply(item.initialState(), {
      eventId: stored[0]!.eventId,
      suid: stored[0]!.suid,
      payload: stored[0]!.payload,
      eventTags: stored[0]!.eventTags,
      eventType: stored[0]!.eventType,
      provenance: "g32",
    }) as string[]);
    expect(unsafeViews).toEqual([
      [committed.receipt.winnerEventId],
      [committed.receipt.winnerEventId],
    ]);
    for (const item of witnessProjectors) {
      const identity = {
        tag,
        tagGroup: tagGroup ?? tag,
        tagContent: tagContent ?? tag,
        tagProjector: item.id,
      };
      const applied = await runtime.catchUp(opened.serviceId, identity, nowMs);
      expect(applied.appliedEvents).toBe(1);
      const duplicate = await runtime.catchUp(opened.serviceId, identity, nowMs);
      expect(duplicate.appliedEvents).toBe(0);
      const checkpoint = await store.readProjectionCheckpoint(opened.serviceId, projectionIdFor(identity));
      if (checkpoint === undefined) throw new Error("safe checkpoint missing");
      expect(item.deserializeState(checkpoint.stateJson)).toEqual([committed.receipt.winnerEventId]);
      expect(checkpoint.lastSuid).toBe(committed.receipt.winnerSortableUniqueId);
    }
  });
});
