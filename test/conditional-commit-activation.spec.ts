import { createExecutionContext, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { defineEvent } from "../packages/dcb-core/src/index";
import { mapBuiltInConditionalHttpResult } from "../packages/dcb-client/src/conditionalCommit";
import { ClientError } from "../packages/dcb-client/src/errors";
import {
  SerializedDcbClient,
  createHttpTransport,
  createInProcessTransport,
  createSekibanExecutor,
  type SerializedDcbTransport,
} from "../packages/dcb-client/src/index";
import { SERIALIZED_PATHS, composeFetch } from "../packages/dcb-cloudflare/src/compose";
import { createCloudflareOnlyRuntimeWorker } from "../packages/dcb-runtime/src/cloudflare";
import type { CommitWorkerEnv } from "../packages/dcb-runtime/src/commit/CommitWorker";
import { createRuntimeWorker } from "../packages/dcb-runtime/src/index";
import { scopeIdFor } from "../packages/dcb-runtime/src/scope/ScopeName";
import { TEST_SERVICE_ID_HEADER } from "../packages/dcb-runtime/src/service/ServiceIdentityProvider";
import { POSTGRES_STORE_PROVIDER, type StoreProvider } from "../packages/dcb-runtime/src/store/provider";

const CONDITIONAL_PATH = "/api/sekiban/serialized/conditional-commit";
const UNSUPPORTED = {
  version: 1,
  outcome: "Unsupported",
  code: "conditional_commit_unsupported",
  error: "Conditional commit is not supported by this deployment.",
  retryable: false,
};
const CORRUPT = {
  version: 1,
  code: "conditional_commit_committed_state_corrupt",
  error: "The durable conditional commit state could not be verified.",
  retryable: false,
};
const event = defineEvent<{ readonly sku: string }>("FixtureEvent");
const domain = { events: [event] };

function serviceId(): string {
  return `act${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function bindings(): CommitWorkerEnv {
  return env as unknown as CommitWorkerEnv;
}

function coordinatorRecord(service: string, status: string): Record<string, unknown> {
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
  };
}

function countingNamespace(namespace: DurableObjectNamespace, counts: { get: number }): DurableObjectNamespace {
  return {
    get(id: DurableObjectId) {
      counts.get += 1;
      return namespace.get(id);
    },
    idFromName: (name: string) => namespace.idFromName(name),
    idFromString: (id: string) => namespace.idFromString(id),
    newUniqueId: (options?: DurableObjectNamespaceNewUniqueIdOptions) => namespace.newUniqueId(options),
    jurisdiction: (jurisdiction: DurableObjectJurisdiction) => namespace.jurisdiction(jurisdiction),
  } as unknown as DurableObjectNamespace;
}

function workerFetch(worker: { fetch?: unknown }): (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> {
  return worker.fetch as (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;
}

function preparedBody(key: string, tag: string, sku: string): string {
  return JSON.stringify({
    version: 1,
    idempotencyKey: key,
    eventCandidate: {
      payload: btoa(JSON.stringify({ sku })),
      eventPayloadName: "FixtureEvent",
      tags: [tag],
    },
  });
}

async function post(
  worker: { fetch?: unknown },
  service: string,
  body: string,
  method = "POST",
  counts?: { get: number },
): Promise<Response> {
  const scoped = {
    ...bindings(),
    SDT_SERVICE_ID: service,
    ...(counts === undefined ? {} : { TAG: countingNamespace(bindings().TAG, counts) }),
  };
  return workerFetch(worker)(new Request(`https://app.test${CONDITIONAL_PATH}`, {
    method,
    headers: {
      "content-type": "application/json",
      [TEST_SERVICE_ID_HEADER]: service,
    },
    body,
  }), scoped, createExecutionContext());
}

async function sqlCount(service: string, tag: string, table: string): Promise<number> {
  const stub = bindings().TAG.get(scopeIdFor(bindings().TAG, { serviceId: service, doClass: "tag", identity: tag }));
  return runInDurableObject(stub, async (_instance, state) => {
    const row = state.storage.sql.exec(`SELECT COUNT(*) AS count FROM ${table}`).one() as { count?: number | bigint };
    return Number(row.count ?? 0);
  });
}

describe("conditional commit activation", () => {
  it("public route maps the exact B1 success and failure statuses", async () => {
    const ordinary = createRuntimeWorker({ domain });
    const fixed = createCloudflareOnlyRuntimeWorker({ domain });
    for (const worker of [ordinary, fixed]) {
      const service = serviceId();
      const tag = "order:status";
      const appended = await post(worker, service, preparedBody("status-key", tag, "a"));
      expect(appended.status).toBe(201);
      expect(await appended.json()).toMatchObject({ outcome: "Appended", version: 1 });
      const same = await post(worker, service, preparedBody("status-key", tag, "a"));
      expect(same.status).toBe(200);
      expect(await same.json()).toMatchObject({ outcome: "AlreadyCommittedSameOperation", writtenEvents: [] });
      const conflict = await post(worker, service, preparedBody("status-key", tag, "b"));
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ outcome: "KeyReuseConflict", retryable: false });
    }

    const invalid = await post(createRuntimeWorker({ domain }), serviceId(), "{");
    expect(invalid.status).toBe(400);

    const deniedCounts = { get: 0 };
    const unsupported = await post(
      createRuntimeWorker({ domain, storeProvider: POSTGRES_STORE_PROVIDER }),
      serviceId(),
      preparedBody("explicit", "order:explicit", "a"),
      "POST",
      deniedCounts,
    );
    expect(unsupported.status).toBe(501);
    expect(await unsupported.json()).toEqual(UNSUPPORTED);
    expect(deniedCounts.get).toBe(0);

    const importing = serviceId();
    const bootstrapNamespace = bindings().BOOTSTRAP;
    if (bootstrapNamespace === undefined) throw new Error("BOOTSTRAP binding is required");
    const bootstrap = bootstrapNamespace.get(scopeIdFor(bootstrapNamespace, {
      serviceId: importing,
      doClass: "bootstrap",
      identity: "coordinator",
    }));
    await runInDurableObject(bootstrap, async (_instance, state) => {
      await state.storage.put("bootstrap-control", coordinatorRecord(importing, "IMPORTING"));
    });
    const inDoubt = await post(createRuntimeWorker({ domain }), importing, preparedBody("planned", "order:planned", "a"));
    expect(inDoubt.status).toBe(503);
    expect(await inDoubt.json()).toMatchObject({
      code: "conditional_commit_in_doubt",
      reason: "bootstrap_epoch_changed",
      retryable: true,
    });

    const corruptService = serviceId();
    const corruptTag = "order:corrupt";
    const winner = await post(createRuntimeWorker({ domain }), corruptService, preparedBody("corrupt-key", corruptTag, "a"));
    expect(winner.status).toBe(201);
    const before = await sqlCount(corruptService, corruptTag, "tag_event");
    const stub = bindings().TAG.get(scopeIdFor(bindings().TAG, {
      serviceId: corruptService,
      doClass: "tag",
      identity: corruptTag,
    }));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM tag_outbox_obligation");
    });
    const corrupt = await post(createRuntimeWorker({ domain }), corruptService, preparedBody("corrupt-key", corruptTag, "a"));
    expect(corrupt.status).toBe(500);
    expect(await corrupt.json()).toEqual(CORRUPT);
    expect(await sqlCount(corruptService, corruptTag, "tag_event")).toBe(before);
    expect(await sqlCount(corruptService, corruptTag, "tag_conditional_receipt")).toBe(1);
  });

  it("another method or child path cannot become a conditional call", async () => {
    const worker = createRuntimeWorker({ domain });
    const service = serviceId();
    for (const method of ["PUT", "DELETE"]) {
      const response = await post(worker, service, preparedBody("method", "order:method", "a"), method);
      expect(response.status).toBe(400);
    }
    const get = await workerFetch(worker)(new Request(`https://app.test${CONDITIONAL_PATH}`, {
      method: "GET",
      headers: { [TEST_SERVICE_ID_HEADER]: service },
    }), bindings(), createExecutionContext());
    expect(get.status).toBe(400);
    const child = await workerFetch(worker)(new Request(`https://app.test${CONDITIONAL_PATH}/extra`, {
      method: "POST",
      headers: { "content-type": "application/json", [TEST_SERVICE_ID_HEADER]: service },
      body: preparedBody("child", "order:child", "a"),
    }), bindings(), createExecutionContext());
    expect(child.status).toBe(404);
  });

  it("built-ins send the same prepared request once", async () => {
    const prepared = {
      version: 1 as const,
      idempotencyKey: "once",
      eventCandidate: { payload: "e30=", eventPayloadName: "FixtureEvent", tags: ["order:once"] as [string] },
    };
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(init?.body));
      return new Response(JSON.stringify(UNSUPPORTED), { status: 501, headers: { "content-type": "application/json" } });
    });
    const client = new SerializedDcbClient("https://example.test", fetchImpl);
    const http = createHttpTransport({ baseUrl: "https://example.test", fetch: fetchImpl });
    const inProcess = createInProcessTransport({ fetch: fetchImpl });
    await client.conditionalCommit(prepared);
    await http.conditionalCommit?.(prepared);
    await inProcess.conditionalCommit?.(prepared);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(seen.every((body) => body === JSON.stringify(prepared))).toBe(true);
  });

  it("only the built-in exact-path 404 becomes Unsupported", async () => {
    const kept = { status: 409, body: { outcome: "KeyReuseConflict" } };
    expect(mapBuiltInConditionalHttpResult(kept)).toBe(kept);
    const missing = { status: 404, body: { error: "missing" } };
    expect(mapBuiltInConditionalHttpResult(missing)).toEqual({ status: 501, body: UNSUPPORTED });
    const fetchImpl = vi.fn(async () => new Response("missing", {
      status: 404,
      headers: { "content-type": "text/plain" },
    }));
    const http = createHttpTransport({ baseUrl: "https://example.test", fetch: fetchImpl });
    const conditional = await http.conditionalCommit?.({
      version: 1,
      idempotencyKey: "old",
      eventCandidate: { payload: "e30=", eventPayloadName: "FixtureEvent", tags: ["order:old"] },
    });
    expect(conditional).toEqual({ status: 501, body: UNSUPPORTED });
    const v1 = await http.commit({ candidates: [], consistency: [] });
    expect((v1 as { status: number }).status).toBe(404);
  });

  it("custom transport 404 remains a transport failure", async () => {
    const member = vi.fn(async () => ({ status: 404, body: { error: "custom" } }));
    const transport: SerializedDcbTransport = {
      readTagState: async () => { throw new Error("unused"); },
      commit: vi.fn(),
      query: async () => { throw new Error("unused"); },
      listQuery: async () => { throw new Error("unused"); },
      conditionalCommit: member,
    };
    const executor = createSekibanExecutor(transport);
    const prepared = executor.prepareConditionalCommit({
      idempotencyKey: "custom",
      event,
      payload: { sku: "a" },
      tag: "order:custom",
    });
    await expect(executor.commitPreparedConditionally(prepared)).rejects.toMatchObject({ code: "http_error" });
    expect(member).toHaveBeenCalledTimes(1);
    expect(transport.commit).not.toHaveBeenCalled();
  });

  it("executor preparation calls the event parser once", () => {
    let parses = 0;
    const counted = defineEvent<{ readonly sku: string }>("FixtureEvent", (payload) => {
      parses += 1;
      return payload as { readonly sku: string };
    });
    const executor = createSekibanExecutor(createHttpTransport({ baseUrl: "https://example.test", fetch: vi.fn() }));
    executor.prepareConditionalCommit({
      idempotencyKey: "parse",
      event: counted,
      payload: { sku: "a" },
      tag: "order:parse",
    });
    expect(parses).toBe(1);
  });

  it("executor dispatch preserves the prepared object identity", async () => {
    const seen: unknown[] = [];
    const inner = createHttpTransport({
      baseUrl: "https://example.test",
      fetch: vi.fn(async () => new Response(JSON.stringify(UNSUPPORTED), {
        status: 501,
        headers: { "content-type": "application/json" },
      })),
      serviceId: "scope-a",
    });
    const transport: SerializedDcbTransport = {
      ...inner,
      conditionalCommit: (request, signal) => {
        seen.push(request);
        return inner.conditionalCommit!(request, signal);
      },
    };
    const executor = createSekibanExecutor(transport, { serviceId: "scope-a" });
    const prepared = executor.prepareConditionalCommit({
      idempotencyKey: "identity",
      event,
      payload: { sku: "a" },
      tag: "order:identity",
    });
    await executor.commitPreparedConditionally(prepared);
    expect(seen).toEqual([prepared]);
  });

  it("executor scope mismatch performs zero calls", async () => {
    const fetchImpl = vi.fn();
    const executor = createSekibanExecutor(createHttpTransport({
      baseUrl: "https://example.test",
      fetch: fetchImpl,
      serviceId: "scope-a",
    }), { serviceId: "scope-b" });
    const prepared = executor.prepareConditionalCommit({
      idempotencyKey: "scope",
      event,
      payload: { sku: "a" },
      tag: "order:scope",
    });
    await expect(executor.commitPreparedConditionally(prepared)).rejects.toMatchObject({ code: "scope.mismatch" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("in-doubt and network failures are not automatically retried", async () => {
    const inDoubtBody = {
      version: 1,
      code: "conditional_commit_in_doubt",
      error: "The conditional commit outcome is not yet verified; resend the same prepared request.",
      retryable: true,
      reason: "winner_unreadable",
    };
    let calls = 0;
    const http = createHttpTransport({
      baseUrl: "https://example.test",
      fetch: vi.fn(async () => {
        calls += 1;
        return new Response(JSON.stringify(inDoubtBody), { status: 503, headers: { "content-type": "application/json" } });
      }),
    });
    const executor = createSekibanExecutor(http);
    const prepared = executor.prepareConditionalCommit({
      idempotencyKey: "doubt",
      event,
      payload: { sku: "a" },
      tag: "order:doubt",
    });
    await expect(executor.commitPreparedConditionally(prepared)).rejects.toBeInstanceOf(ClientError);
    expect(calls).toBe(1);
    const network = createHttpTransport({
      baseUrl: "https://example.test",
      fetch: vi.fn(async () => {
        calls += 1;
        throw new TypeError("network down");
      }),
    });
    const networkExecutor = createSekibanExecutor(network);
    await expect(networkExecutor.commitPreparedConditionally(prepared)).rejects.toBeInstanceOf(ClientError);
    expect(calls).toBe(2);
  });

  it("conditional dispatch never calls V1 commit", async () => {
    const commit = vi.fn();
    const conditionalCommit = vi.fn(async () => ({ status: 501, body: UNSUPPORTED }));
    const transport: SerializedDcbTransport = {
      readTagState: async () => { throw new Error("unused"); },
      commit,
      query: async () => { throw new Error("unused"); },
      listQuery: async () => { throw new Error("unused"); },
      conditionalCommit,
    };
    const executor = createSekibanExecutor(transport);
    const prepared = executor.prepareConditionalCommit({
      idempotencyKey: "no-v1",
      event,
      payload: { sku: "a" },
      tag: "order:nov1",
    });
    const result = await executor.commitPreparedConditionally(prepared);
    expect(result.outcome).toBe("Unsupported");
    expect(conditionalCommit).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it("serialized mount forwards all six paths only when enabled", async () => {
    expect(SERIALIZED_PATHS).toEqual([
      "/api/sekiban/serialized/commit",
      "/api/sekiban/serialized/conditional-commit",
      "/api/sekiban/serialized/query",
      "/api/sekiban/serialized/list-query",
      "/api/sekiban/serialized/tag-latest-sortable",
      "/api/sekiban/serialized/tag-state",
    ]);
    let runtimeCalls = 0;
    let authorizeCalls = 0;
    const enabled = composeFetch({
      application: async () => new Response("app"),
      sekiban: {
        prefix: "/sekiban",
        authorize: () => {
          authorizeCalls += 1;
          return true;
        },
        fetch: async () => {
          runtimeCalls += 1;
          return new Response("runtime");
        },
        forwardSerializedRoutes: true,
      },
    });
    for (const path of SERIALIZED_PATHS) {
      const response = await enabled(new Request(`https://app.test/sekiban${path}`) as Parameters<typeof enabled>[0], {}, {} as ExecutionContext);
      expect(response.status).toBe(200);
    }
    expect(runtimeCalls).toBe(6);
    expect(authorizeCalls).toBe(6);
    const disabled = composeFetch({
      application: async () => new Response("app"),
      sekiban: {
        prefix: "/sekiban",
        authorize: () => {
          throw new Error("authorize");
        },
        fetch: async () => {
          throw new Error("runtime");
        },
        forwardSerializedRoutes: false,
      },
    });
    for (const path of SERIALIZED_PATHS) {
      const response = await disabled(new Request(`https://app.test/sekiban${path}`) as Parameters<typeof disabled>[0], {}, {} as ExecutionContext);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("runtime route is not forwarded");
    }
  });

  it("refuses a named postgres provider before Tag access", async () => {
    const counts = { get: 0 };
    let creates = 0;
    const named = {
      name: "postgres",
      create() {
        creates += 1;
        throw new Error("provider create");
      },
    } as unknown as StoreProvider;
    const response = await post(
      createRuntimeWorker({ domain, storeProvider: named }),
      serviceId(),
      preparedBody("named", "order:named", "a"),
      "POST",
      counts,
    );
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual(UNSUPPORTED);
    expect(counts.get).toBe(0);
    expect(creates).toBe(0);
  });
});
