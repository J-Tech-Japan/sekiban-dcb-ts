import { createExecutionContext, createMessageBatch, env, getQueueResult, runInDurableObject } from "cloudflare:test";
// @ts-expect-error Vite raw asset import
import d1Migration from "../migrations/d1/g32/0001_dcb_events.sql?raw";
import { describe, expect, it } from "vitest";

import { parseConditionalCommitHttpResult } from "../packages/dcb-client/src/conditionalCommit";
import { ClientError } from "../packages/dcb-client/src/errors";
import { createCloudflareOnlyRuntimeWorker } from "../packages/dcb-runtime/src/cloudflare";
import {
  createFixedD1ConditionalExecutor,
  createOrdinaryConditionalExecutor,
} from "../packages/dcb-runtime/src/commit/ConditionalCommitWorker";
import type { CommitWorkerEnv } from "../packages/dcb-runtime/src/commit/CommitWorker";
import { createD1StoreProvider } from "../packages/dcb-runtime/src/d1";
import { handleDownstreamQueue } from "../packages/dcb-runtime/src/downstream/DownstreamAdapter";
import { drainTagOutbox } from "../packages/dcb-runtime/src/downstream/OutboxDrain";
import type { DownstreamOutboxMessage } from "../packages/dcb-runtime/src/downstream/types";
import { createRuntimeWorker } from "../packages/dcb-runtime/src/index";
import { scopeIdFor } from "../packages/dcb-runtime/src/scope/ScopeName";
import { TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/service/ServiceIdentityProvider";
import { POSTGRES_STORE_PROVIDER, type StoreProvider } from "../packages/dcb-runtime/src/store/provider";
import { applyG44D1Migration } from "./helpers/g44-d1-migration";
import { G32_FIXTURE_TIMESTAMP, g32EventId, g32Suid } from "./helpers/g32-fixtures";

const PARSERS = { FixtureEvent: (payload: unknown) => payload };

function serviceId(): string {
  return `rt${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function requestFor(service: string, key: string, tag: string, payload: unknown = { n: 1 }, eventPayloadName = "FixtureEvent"): Request {
  return new Request("https://conditional.test/conditional", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [TEST_SERVICE_ID_HEADER]: service,
    },
    body: JSON.stringify({
      version: 1,
      idempotencyKey: key,
      eventCandidate: {
        payload: btoa(JSON.stringify(payload)),
        eventPayloadName,
        tags: [tag],
      },
    }),
  });
}

function coordinatorRecord(service: string, status: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    status,
    importId: null,
    targetServiceId: service,
    allocatorLineageId: null,
    source: null,
    digest: null,
    manifest: null,
    progress: {},
    leaseEpoch: 0,
    leaseUntil: null,
    failure: null,
    readyAt: null,
    normalInFlight: 0,
    normalCommands: {},
    releasedCommands: {},
    writePermits: {},
    verifiedImportId: null,
    verifiedLeaseEpoch: null,
    storeCompletion: null,
    ...patch,
  };
}

function isKind(payload: unknown, kind: string): boolean {
  return typeof payload === "object" && payload !== null && (payload as { kind?: unknown }).kind === kind;
}

function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

function watchedEnv(counts: { append: number; allocate: number }, missingRoute = false): CommitWorkerEnv {
  const tag = workerEnv().TAG;
  const allocator = workerEnv().ALLOCATOR;
  const bootstrap = bootstrapNamespace();
  const namespaceMethods = (namespace: DurableObjectNamespace) => ({
    idFromName: (name: string) => namespace.idFromName(name),
    idFromString: (id: string) => namespace.idFromString(id),
    newUniqueId: (options?: DurableObjectNamespaceNewUniqueIdOptions) => namespace.newUniqueId(options),
    jurisdiction: (jurisdiction: DurableObjectJurisdiction) => namespace.jurisdiction(jurisdiction),
  });
  return {
    ...workerEnv(),
    TAG: {
      get(id: DurableObjectId) {
        const stub = tag.get(id);
        return {
          fetch: async (input: Request) => {
            if (new URL(input.url).pathname.endsWith("/append")) counts.append += 1;
            return stub.fetch(input);
          },
        };
      },
      ...namespaceMethods(tag),
    } as unknown as DurableObjectNamespace,
    ALLOCATOR: {
      get(id: DurableObjectId) {
        const stub = allocator.get(id);
        return {
          fetch: async (input: Request) => {
            if (new URL(input.url).pathname === "/allocate") counts.allocate += 1;
            return stub.fetch(input);
          },
        };
      },
      ...namespaceMethods(allocator),
    } as unknown as DurableObjectNamespace,
    ...(missingRoute
      ? {
          BOOTSTRAP: {
            get: () => ({ fetch: async () => new Response("missing", { status: 404 }) }),
            ...namespaceMethods(bootstrap),
          } as unknown as DurableObjectNamespace,
        }
      : {}),
  };
}

function workerEnv(): CommitWorkerEnv {
  return env as unknown as CommitWorkerEnv;
}

function bootstrapNamespace(): DurableObjectNamespace {
  const namespace = workerEnv().BOOTSTRAP;
  if (namespace === undefined) throw new Error("BOOTSTRAP binding is required");
  return namespace;
}

function workerFetch(worker: { fetch?: unknown }): (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> {
  return worker.fetch as (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;
}

function countingNamespace(namespace: DurableObjectNamespace, counts: { get: number; id: number }): DurableObjectNamespace {
  return {
    get(id: DurableObjectId) {
      counts.get += 1;
      return namespace.get(id);
    },
    idFromName(name: string) {
      counts.id += 1;
      return namespace.idFromName(name);
    },
    idFromString: (id: string) => namespace.idFromString(id),
    newUniqueId: (options?: DurableObjectNamespaceNewUniqueIdOptions) => namespace.newUniqueId(options),
    jurisdiction: (jurisdiction: DurableObjectJurisdiction) => namespace.jurisdiction(jurisdiction),
  } as DurableObjectNamespace;
}

async function bodyOf(response: Response): Promise<unknown> {
  return response.json();
}

async function parsed(response: Response) {
  return parseConditionalCommitHttpResult({ status: response.status, body: await bodyOf(response.clone()) });
}

describe("conditional commit runtime", () => {
  it("checks the parser and provider capability before any Tag resolution", async () => {
    const service = serviceId();
    const counts = { get: 0, id: 0 };
    const scoped = { ...workerEnv(), TAG: countingNamespace(workerEnv().TAG, counts) };
    const missing = await createOrdinaryConditionalExecutor().handleConditionalCommit(
      requestFor(service, "missing-parser", "Order:1"),
      scoped,
      {},
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ code: "conditional_commit_event_not_registered" });
    expect(counts).toEqual({ get: 0, id: 0 });

    const explicit = await createOrdinaryConditionalExecutor({ storeProvider: POSTGRES_STORE_PROVIDER }).handleConditionalCommit(
      requestFor(service, "explicit-provider", "Order:1"),
      scoped,
      { registeredEventParsers: PARSERS },
    );
    expect(explicit.status).toBe(501);
    expect(counts).toEqual({ get: 0, id: 0 });

    let creates = 0;
    const named = { name: "postgres", create() { creates += 1; throw new Error("provider create"); } } as unknown as StoreProvider;
    const custom = await createOrdinaryConditionalExecutor({ storeProvider: named }).handleConditionalCommit(
      requestFor(service, "named-postgres", "Order:1"),
      scoped,
      { registeredEventParsers: PARSERS },
    );
    expect(custom.status).toBe(501);
    expect(creates).toBe(0);
    expect(counts).toEqual({ get: 0, id: 0 });

    const cosmos = { name: "cosmos", create() { creates += 1; throw new Error("cosmos"); } } as unknown as StoreProvider;
    const cosmosResponse = await createOrdinaryConditionalExecutor({ storeProvider: cosmos }).handleConditionalCommit(
      requestFor(service, "cosmos", "Order:1"),
      scoped,
      { registeredEventParsers: PARSERS },
    );
    expect(cosmosResponse.status).toBe(501);
    expect(creates).toBe(0);
  });

  it("keeps the public route and every internal prefix off the Tag stub", async () => {
    const ctx = createExecutionContext();
    const service = serviceId();
    const counts = { get: 0, id: 0 };
    const scoped = { ...workerEnv(), TAG: countingNamespace(workerEnv().TAG, counts) };
    for (const worker of [createRuntimeWorker(), createCloudflareOnlyRuntimeWorker()]) {
      const fetchWorker = workerFetch(worker);
      const direct = await fetchWorker(new Request("https://app.test/api/sekiban/serialized/conditional-commit", {
        method: "POST",
        headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: service },
        body: "{}",
      }), scoped as never, ctx);
      expect(direct.status).toBe(404);
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        const hidden = await fetchWorker(new Request(
          `https://app.test/tags/${encodeURIComponent(service)}/${encodeURIComponent("Order:1")}/__internal/conditional/resolve`,
          { method, headers: { [TEST_SERVICE_ID_HEADER]: service, "x-sdt-g46-source-read": "spoofed" } },
        ), scoped as never, ctx);
        expect(hidden.status).toBe(404);
      }
    }
    expect(counts).toEqual({ get: 0, id: 0 });
  });

  it("maps the closed outcomes and stops when bootstrap is not empty", async () => {
    const service = serviceId();
    const executor = createOrdinaryConditionalExecutor();
    const first = await executor.handleConditionalCommit(
      requestFor(service, "mapped", "Order:mapped", { sku: "a" }),
      workerEnv(),
      { registeredEventParsers: PARSERS },
    );
    const appended = await parsed(first);
    expect(appended.outcome).toBe("Appended");
    if (appended.outcome === "Appended") {
      expect(appended.writtenEvents[0]?.payload).toBe(btoa(JSON.stringify({ sku: "a" })));
      expect(appended.writtenEvents).toHaveLength(1);
    }
    const same = await parsed(await executor.handleConditionalCommit(
      requestFor(service, "mapped", "Order:mapped", { sku: "a" }),
      workerEnv(),
      { registeredEventParsers: PARSERS },
    ));
    expect(same.outcome).toBe("AlreadyCommittedSameOperation");
    if (same.outcome === "AlreadyCommittedSameOperation" && appended.outcome === "Appended") {
      expect(same.receipt).toEqual(appended.receipt);
      expect(same.writtenEvents).toEqual([]);
    }
    const conflict = await executor.handleConditionalCommit(
      requestFor(service, "mapped", "Order:mapped", { sku: "b" }),
      workerEnv(),
      { registeredEventParsers: PARSERS },
    );
    expect((await parsed(conflict)).outcome).toBe("KeyReuseConflict");

    const stub = workerEnv().TAG.get(scopeIdFor(workerEnv().TAG, {
      serviceId: service, doClass: "tag", identity: "Order:mapped",
    }));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE tag_conditional_receipt SET operation_fingerprint = ? WHERE normalized_key = ?",
        "c".repeat(64),
        "mapped",
      );
    });
    await expect(parsed(await executor.handleConditionalCommit(
      requestFor(service, "mapped", "Order:mapped", { sku: "a" }),
      workerEnv(),
      { registeredEventParsers: PARSERS },
    ))).rejects.toBeInstanceOf(ClientError);

    for (const status of ["PLANNED", "IMPORTING", "VERIFYING"] as const) {
      const blockedService = serviceId();
      const bootstrap = bootstrapNamespace().get(scopeIdFor(bootstrapNamespace(), {
        serviceId: blockedService, doClass: "bootstrap", identity: "coordinator",
      }));
      await runInDurableObject(bootstrap, async (_instance, state) => {
        await state.storage.put("bootstrap-control", coordinatorRecord(blockedService, status));
      });
      const blocked = await executor.handleConditionalCommit(
        requestFor(blockedService, "bootstrap", "Order:boot"),
        workerEnv(),
        { registeredEventParsers: PARSERS },
      );
      expect(blocked.status).toBe(503);
      expect(await blocked.json()).toMatchObject({ code: "conditional_commit_in_doubt", reason: "bootstrap_epoch_changed" });
    }

    const readyService = serviceId();
    const ready = bootstrapNamespace().get(scopeIdFor(bootstrapNamespace(), {
      serviceId: readyService, doClass: "bootstrap", identity: "coordinator",
    }));
    await runInDurableObject(ready, async (_instance, state) => {
      await state.storage.put("bootstrap-control", coordinatorRecord(readyService, "READY", { readyAt: G32_FIXTURE_TIMESTAMP }));
    });
    expect((await executor.handleConditionalCommit(
      requestFor(readyService, "ready", "Order:ready"),
      workerEnv(),
      { registeredEventParsers: PARSERS },
    )).status).toBe(501);
  });

  it("returns key reuse when the stored event type differs", async () => {
    const restrictive = {
      TypeA: (payload: unknown) => {
        if (!isKind(payload, "a")) throw new Error("type a");
        return payload;
      },
      TypeB: (payload: unknown) => {
        if (!isKind(payload, "b")) throw new Error("type b");
        return payload;
      },
    };
    const service = serviceId();
    const executor = createOrdinaryConditionalExecutor();
    const first = await executor.handleConditionalCommit(
      requestFor(service, "shared", "Order:types", { kind: "a" }, "TypeA"),
      workerEnv(),
      { registeredEventParsers: restrictive },
    );
    expect(first.status).toBe(201);
    const reuse = await executor.handleConditionalCommit(
      requestFor(service, "shared", "Order:types", { kind: "b" }, "TypeB"),
      workerEnv(),
      { registeredEventParsers: restrictive },
    );
    expect(reuse.status).toBe(409);
    expect((await parsed(reuse)).outcome).toBe("KeyReuseConflict");
  });

  it("rejects failed, old, and malformed coordinator state with zero allocation and zero append", async () => {
    const cases: Array<{ readonly label: string; readonly record: Record<string, unknown> | "missing-route" }> = [
      { label: "FAILED", record: coordinatorRecord("pending", "FAILED", { failure: "failed" }) },
      { label: "old schema", record: coordinatorRecord("pending", "EMPTY", { schemaVersion: 0 }) },
      { label: "extra field", record: coordinatorRecord("pending", "EMPTY", { extra: true }) },
      { label: "missing writePermits", record: without(coordinatorRecord("pending", "EMPTY"), "writePermits") },
      { label: "negative normalInFlight", record: coordinatorRecord("pending", "EMPTY", { normalInFlight: -1 }) },
      { label: "contradictory EMPTY", record: coordinatorRecord("pending", "EMPTY", { importId: "import-1" }) },
      { label: "old route", record: "missing-route" },
    ];
    for (const item of cases) {
      const service = serviceId();
      const record = item.record === "missing-route"
        ? undefined
        : { ...item.record, targetServiceId: service };
      if (record !== undefined) {
        const bootstrap = bootstrapNamespace().get(scopeIdFor(bootstrapNamespace(), {
          serviceId: service, doClass: "bootstrap", identity: "coordinator",
        }));
        await runInDurableObject(bootstrap, async (_instance, state) => {
          await state.storage.put("bootstrap-control", record);
        });
      }
      const counts = { append: 0, allocate: 0 };
      const response = await createOrdinaryConditionalExecutor().handleConditionalCommit(
        requestFor(service, item.label, "Order:closed-state"),
        watchedEnv(counts, item.record === "missing-route"),
        { registeredEventParsers: PARSERS },
      );
      expect(response.status, item.label).toBe(501);
      expect(counts, item.label).toEqual({ append: 0, allocate: 0 });
    }
  });

  it("resolves before allocation and leaves an ambiguous permit held", async () => {
    const service = serviceId();
    const tagCounts = { get: 0, id: 0 };
    let allocates = 0;
    const allocator = workerEnv().ALLOCATOR;
    const scoped = {
      ...workerEnv(),
      BOOTSTRAP: undefined,
      TAG: countingNamespace(workerEnv().TAG, tagCounts),
      ALLOCATOR: {
        get(id: DurableObjectId) {
          const stub = allocator.get(id);
          return { fetch: async (input: Request) => { allocates += 1; return stub.fetch(input); } };
        },
        idFromName: (name: string) => allocator.idFromName(name),
        idFromString: (id: string) => allocator.idFromString(id),
        newUniqueId: (options?: DurableObjectNamespaceNewUniqueIdOptions) => allocator.newUniqueId(options),
        jurisdiction: (jurisdiction: DurableObjectJurisdiction) => allocator.jurisdiction(jurisdiction),
      } as DurableObjectNamespace,
    };
    const unsupported = await createOrdinaryConditionalExecutor().handleConditionalCommit(
      requestFor(service, "no-bootstrap", "Order:none"),
      scoped,
      { registeredEventParsers: PARSERS },
    );
    expect(unsupported.status).toBe(501);
    expect(tagCounts.get).toBe(1);
    expect(allocates).toBe(0);

    const heldService = serviceId();
    const ambiguous = await createOrdinaryConditionalExecutor().handleConditionalCommit(
      requestFor(heldService, "lost", "Order:lost"),
      workerEnv(),
      { registeredEventParsers: PARSERS, loseAppendResponse: true, failRecoveryResolve: true },
    );
    expect(ambiguous.status).toBe(503);
    expect(await ambiguous.json()).toMatchObject({ reason: "ambiguous_after_append" });
    const coordinator = bootstrapNamespace().get(scopeIdFor(bootstrapNamespace(), {
      serviceId: heldService, doClass: "bootstrap", identity: "coordinator",
    }));
    const state = await (await coordinator.fetch(`https://bootstrap.internal/state?__serviceId=${encodeURIComponent(heldService)}`)).json() as { writePermits?: Record<string, string> };
    expect(Object.keys(state.writePermits ?? {})).toHaveLength(1);

    const recoveredService = serviceId();
    const recovered = await parsed(await createOrdinaryConditionalExecutor().handleConditionalCommit(
      requestFor(recoveredService, "recovered", "Order:recovered"),
      workerEnv(),
      { registeredEventParsers: PARSERS, loseAppendResponse: true },
    ));
    expect(recovered.outcome).toBe("AlreadyCommittedSameOperation");
    const released = bootstrapNamespace().get(scopeIdFor(bootstrapNamespace(), {
      serviceId: recoveredService, doClass: "bootstrap", identity: "coordinator",
    }));
    const releasedState = await (await released.fetch(`https://bootstrap.internal/state?__serviceId=${encodeURIComponent(recoveredService)}`)).json() as { writePermits?: Record<string, string> };
    expect(Object.keys(releasedState.writePermits ?? {})).toHaveLength(0);
  });

  it("uses one allocation when a fresh sortable id is already behind the head", async () => {
    const service = serviceId();
    const tag = "Order:behind";
    const seeded = await workerEnv().TAG.get(scopeIdFor(workerEnv().TAG, {
      serviceId: service, doClass: "tag", identity: tag,
    })).fetch(new Request(`https://tag.internal/append?__tag=${encodeURIComponent(tag)}&__serviceId=${encodeURIComponent(service)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attemptId: "seed-behind",
        epoch: 0,
        candidates: [{
          eventId: g32EventId("seed-behind"),
          suid: g32Suid("900000"),
          payload: "{\"n\":1}",
          eventTags: [tag],
          eventType: "FixtureEvent",
          provenance: "g32",
          allocatorLineageId: "seed-lineage",
          timestamp: G32_FIXTURE_TIMESTAMP,
        }],
      }),
    }));
    expect(seeded.status).toBe(201);
    let allocates = 0;
    const allocator = workerEnv().ALLOCATOR;
    const scoped = {
      ...workerEnv(),
      ALLOCATOR: {
        get(id: DurableObjectId) {
          allocates += 1;
          const stub = allocator.get(id);
          return {
            fetch: async (input: Request) => {
              const url = new URL(input.url);
              if (url.pathname !== "/allocate") return stub.fetch(input);
              const requestBody = await input.json() as { candidates: Array<{ eventId: string }> };
              return Response.json({
                allocatorLineageId: "low-lineage",
                candidates: [{ eventId: requestBody.candidates[0]?.eventId, suid: g32Suid(0) }],
              }, { status: 201 });
            },
          };
        },
        idFromName: (name: string) => allocator.idFromName(name),
        idFromString: (id: string) => allocator.idFromString(id),
        newUniqueId: (options?: DurableObjectNamespaceNewUniqueIdOptions) => allocator.newUniqueId(options),
        jurisdiction: (jurisdiction: DurableObjectJurisdiction) => allocator.jurisdiction(jurisdiction),
      } as DurableObjectNamespace,
    };
    const blocked = await createOrdinaryConditionalExecutor().handleConditionalCommit(
      requestFor(service, "behind", tag),
      scoped,
      { registeredEventParsers: PARSERS },
    );
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toMatchObject({ reason: "live_precondition_blocked" });
    expect(allocates).toBe(1);
  });

  it("treats an old tag stub as unsupported and keeps a later provider off the stored receipt", async () => {
    const service = serviceId();
    const old = {
      ...workerEnv(),
      TAG: {
        get: () => ({ fetch: async () => new Response("missing", { status: 404 }) }),
        idFromName: (name: string) => workerEnv().TAG.idFromName(name),
        idFromString: (id: string) => workerEnv().TAG.idFromString(id),
        newUniqueId: (options?: DurableObjectNamespaceNewUniqueIdOptions) => workerEnv().TAG.newUniqueId(options),
        jurisdiction: (jurisdiction: DurableObjectJurisdiction) => workerEnv().TAG.jurisdiction(jurisdiction),
      } as unknown as DurableObjectNamespace,
    };
    expect((await createOrdinaryConditionalExecutor().handleConditionalCommit(
      requestFor(service, "old-tag", "Order:old"),
      old,
      { registeredEventParsers: PARSERS },
    )).status).toBe(501);

    const winnerService = serviceId();
    expect((await createFixedD1ConditionalExecutor().handleConditionalCommit(
      requestFor(winnerService, "d1-winner", "Order:d1", { sku: "d1" }),
      workerEnv(),
      { registeredEventParsers: PARSERS },
    )).status).toBe(201);
    const counts = { get: 0, id: 0 };
    const switched = await createOrdinaryConditionalExecutor({ storeProvider: POSTGRES_STORE_PROVIDER }).handleConditionalCommit(
      requestFor(winnerService, "d1-winner", "Order:d1", { sku: "d1" }),
      { ...workerEnv(), TAG: countingNamespace(workerEnv().TAG, counts) },
      { registeredEventParsers: PARSERS },
    );
    expect(switched.status).toBe(501);
    expect(counts).toEqual({ get: 0, id: 0 });

    const queued: DownstreamOutboxMessage[] = [];
    const drained = await drainTagOutbox({ serviceId: winnerService, tag: "Order:d1" }, {
      TAG: workerEnv().TAG,
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
    expect(drained.delivered).toBe(1);
    const d1 = (env as unknown as { D1: D1Database }).D1;
    const statements = (d1Migration as string).replace(/^\s*--.*$/gm, "").split(";").map((statement) => statement.trim()).filter((statement) => statement.length > 0);
    await d1.batch(statements.map((statement) => d1.prepare(statement)));
    await applyG44D1Migration(d1);
    const store = createD1StoreProvider().create({ D1: d1 });
    await store.initialize();
    const batch = createMessageBatch("serialized-dcb-v1-outbox", queued.map((body, index) => ({
      id: `d1-${index}`,
      timestamp: new Date(),
      attempts: 1,
      body,
    })));
    await handleDownstreamQueue(batch, {}, { store });
    expect((await getQueueResult(batch, createExecutionContext())).retryMessages).toEqual([]);
    expect(await store.readAllEvents(winnerService, "")).toHaveLength(1);
  });
});
