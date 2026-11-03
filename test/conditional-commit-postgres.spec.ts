import { createMessageBatch, env, getQueueResult, createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createOrdinaryConditionalExecutor } from "../packages/dcb-runtime/src/commit/ConditionalCommitWorker";
import type { CommitWorkerEnv } from "../packages/dcb-runtime/src/commit/CommitWorker";
import { handleDownstreamQueue } from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import { drainTagOutbox } from "../packages/dcb-runtime/src/downstream/OutboxDrain";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/service/ServiceIdentityProvider";
import { PostgresEventStore } from "../packages/dcb-runtime/src/store/PostgresEventStore";

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

async function deliver(service: string, tag: string, store: PostgresEventStore): Promise<number> {
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
  if (queued.length === 0) return drained.delivered;
  const batch = createMessageBatch("serialized-dcb-v1-outbox", queued.map((body, index) => ({
    id: `${service}-${index}-${crypto.randomUUID()}`,
    timestamp: new Date(),
    attempts: 1,
    body,
  })));
  await handleDownstreamQueue(batch, { POSTGRES_URL: postgresUrl() }, { store });
  const result = await getQueueResult(batch, createExecutionContext());
  expect(result.retryMessages).toEqual([]);
  return drained.delivered;
}

describe("conditional commit postgres delivery", () => {
  it("delivers one winner and does not add an event for a same-operation retry", async () => {
    const store = new PostgresEventStore(postgresUrl());
    await store.initialize();
    const service = serviceId();
    const tag = "Order:pg";
    const executor = createOrdinaryConditionalExecutor();
    const first = await executor.handleConditionalCommit(
      requestFor(service, "pg-key", tag, { sku: "pg" }),
      env as unknown as CommitWorkerEnv,
      { registeredEventParsers: PARSERS },
    );
    expect(first.status).toBe(201);
    expect(await deliver(service, tag, store)).toBe(1);
    expect(await store.readAllEvents(service, "")).toHaveLength(1);
    const retry = await executor.handleConditionalCommit(
      requestFor(service, "pg-key", tag, { sku: "pg" }),
      env as unknown as CommitWorkerEnv,
      { registeredEventParsers: PARSERS },
    );
    expect(retry.status).toBe(200);
    expect(await deliver(service, tag, store)).toBe(0);
    expect(await store.readAllEvents(service, "")).toHaveLength(1);
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
    expect(await deliver(service, tag, store)).toBe(1);
    expect(await store.readAllEvents(service, "")).toHaveLength(1);
    expect(await deliver(service, tag, store)).toBe(0);
  });
});
