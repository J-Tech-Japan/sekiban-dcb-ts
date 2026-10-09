import { describe, expect, it } from "vitest";

import {
  CosmosConfigurationError,
  createCosmosStoreProvider,
} from "../packages/dcb-runtime/src/cosmos";
import { createRuntimeWorker } from "../packages/dcb-runtime/src/index";
import { createCloudflareOnlyRuntimeWorker } from "../packages/dcb-runtime/src/cloudflare";
import { createD1StoreProvider } from "../packages/dcb-runtime/src/d1";
import { POSTGRES_STORE_PROVIDER } from "../packages/dcb-runtime/src/store/provider";
import { handleSerializedRead } from "../packages/dcb-runtime/src/read/SerializedReadWorker";
import { DEPLOYED_PROJECTOR_REGISTRY } from "../packages/dcb-runtime/src/projection/ProjectorRegistry";
import type { CosmosDocumentClient, CosmosDocumentRecord } from "../packages/dcb-runtime/src/store/CosmosEventStore";

function emptyClient(): CosmosDocumentClient {
  return {
    initialize: async () => {},
    read: async <T extends Record<string, unknown>>(): Promise<CosmosDocumentRecord<T> | undefined> => undefined,
    create: async <T extends Record<string, unknown>>(_container: string, document: T): Promise<CosmosDocumentRecord<T>> => ({ document }),
    replace: async <T extends Record<string, unknown>>(
      container: string,
      document: T,
      partitionKey: string,
      etag?: string,
    ): Promise<boolean> => {
      void container;
      void document;
      void partitionKey;
      void etag;
      return true;
    },
    query: async <T extends Record<string, unknown>>(
      container: string,
      query: string,
      parameters: readonly { name: string; value: unknown }[],
      partitionKey?: string,
    ): Promise<CosmosDocumentRecord<T>[]> => {
      void container;
      void query;
      void parameters;
      void partitionKey;
      return [];
    },
  };
}

function tagNamespace(): DurableObjectNamespace {
  return {
    idFromName: () => ({}) as DurableObjectId,
    get: () => ({ fetch: async () => new Response(null, { status: 404 }) }),
  } as unknown as DurableObjectNamespace;
}

type TestWorkerFetch = (request: Request, env: object, ctx: ExecutionContext) => Promise<Response>;

function workerFetch(worker: { fetch?: unknown }): TestWorkerFetch {
  return worker.fetch as TestWorkerFetch;
}

const completeEnvironment = {
  COSMOS_ENDPOINT: "https://cosmos.example/",
  COSMOS_DATABASE: "experimental-db",
  COSMOS_KEY: "Y2FuYXJ5LWtleS1zdXBwbGllZA==",
  SDT_SERVICE_ID: "selection-test",
};

describe("SDT-G122 experimental Cosmos selection and configuration", () => {
  it("keeps defaults explicit and supports direct client injection without credentials", () => {
    expect(POSTGRES_STORE_PROVIDER.name).toBe("postgres");
    expect(POSTGRES_STORE_PROVIDER.isConfigured?.(completeEnvironment)).toBe(false);

    const provider = createCosmosStoreProvider({ client: emptyClient() });
    expect(provider.name).toBe("cosmos");
    expect(provider.isConfigured?.({})).toBe(true);
    expect(provider.create({})).toBeDefined();
  });

  it("resolves a complete environment triple per invocation and rejects every incomplete shape", () => {
    const provider = createCosmosStoreProvider();
    expect(provider.isConfigured?.(completeEnvironment)).toBe(true);
    expect(provider.create(completeEnvironment)).toBeDefined();

    const names = ["COSMOS_ENDPOINT", "COSMOS_DATABASE", "COSMOS_KEY"] as const;
    for (const name of names) {
      const empty = { ...completeEnvironment, [name]: "" };
      expect(() => provider.isConfigured?.(empty)).toThrow(new RegExp(name));
    }
    for (const name of names) {
      const absent: Record<string, unknown> = { ...completeEnvironment };
      delete absent[name];
      expect(() => provider.isConfigured?.(absent)).toThrow(new RegExp(name));
    }
    for (const keep of names) {
      const partial = Object.fromEntries(names.filter((name) => name === keep).map((name) => [name, completeEnvironment[name]]));
      expect(() => provider.isConfigured?.(partial)).toThrow(CosmosConfigurationError);
    }

    expect(() => createCosmosStoreProvider({ endpoint: "https://static.example/" }).isConfigured?.(completeEnvironment)).toThrow(/COSMOS_DATABASE/);
    expect(() => createCosmosStoreProvider({ endpoint: "https://static.example/", database: "static-db" }).isConfigured?.(completeEnvironment)).toThrow(/COSMOS_KEY/);
    expect(() => createCosmosStoreProvider({ endpoint: "https://static.example/", key: completeEnvironment.COSMOS_KEY }).isConfigured?.(completeEnvironment)).toThrow(/COSMOS_DATABASE/);
    expect(() => createCosmosStoreProvider({ database: "static-db", key: completeEnvironment.COSMOS_KEY }).isConfigured?.(completeEnvironment)).toThrow(/COSMOS_ENDPOINT/);
    expect(() => createCosmosStoreProvider({ endpoint: "", database: "", key: "" })).toThrow(CosmosConfigurationError);
    expect(() => createCosmosStoreProvider().isConfigured?.({})).toThrow(/COSMOS_ENDPOINT/);
    expect(() => createCosmosStoreProvider().isConfigured?.({ COSMOS_ENDPOINT: "", COSMOS_DATABASE: "", COSMOS_KEY: "" })).toThrow(CosmosConfigurationError);
    expect(() => createCosmosStoreProvider({ endpoint: "https://static.example/", key: completeEnvironment.COSMOS_KEY })).toThrow(/COSMOS_DATABASE/);
    expect(() => createCosmosStoreProvider({ database: "static-db", key: completeEnvironment.COSMOS_KEY })).toThrow(/COSMOS_ENDPOINT/);
  });

  it("keeps complete Cosmos bindings out of both default worker compositions", async () => {
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("Cosmos must not be selected by environment values");
    }) as typeof fetch;
    const env = { ...completeEnvironment, TAG: tagNamespace(), SDT_SERVICE_ID: "selection-test" };
    try {
      const defaultWorker = createRuntimeWorker();
      const defaultResponse = await workerFetch(defaultWorker)(
        new Request("https://selection.test/api/sekiban/serialized/tag-latest-sortable", {
          method: "POST",
          headers: { "x-provider": "cosmos", "x-cosmos-endpoint": completeEnvironment.COSMOS_ENDPOINT },
          body: JSON.stringify({ tag: "provider=cosmos", COSMOS_KEY: completeEnvironment.COSMOS_KEY }),
        }), env, {} as ExecutionContext,
      );
      expect(defaultResponse.status).toBe(200);
      expect(createD1StoreProvider().name).toBe("d1");
      const cloudflareWorker = createCloudflareOnlyRuntimeWorker();
      const cloudflareResponse = await workerFetch(cloudflareWorker)(
        new Request("https://selection.test/api/sekiban/serialized/tag-latest-sortable?provider=cosmos", {
          method: "POST",
          body: JSON.stringify({ tag: "provider=cosmos", COSMOS_ENDPOINT: completeEnvironment.COSMOS_ENDPOINT }),
        }), env, {} as ExecutionContext,
      );
      expect(cloudflareResponse.status).toBe(200);
      expect(fetchCalls).toBe(0);
      expect(POSTGRES_STORE_PROVIDER.name).toBe("postgres");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("composes the environment-backed provider explicitly and resolves values per invocation", async () => {
    const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body?.toString() });
      return new Response(null, { status: init?.method === "GET" ? 404 : 201 });
    }) as typeof fetch;
    const provider = createCosmosStoreProvider({ fetcher });
    const envA = { ...completeEnvironment, COSMOS_ENDPOINT: "https://a.example/", COSMOS_DATABASE: "db-a" };
    const envB = { ...completeEnvironment, COSMOS_ENDPOINT: "https://b.example/", COSMOS_DATABASE: "db-b" };
    await provider.create(envA).initialize();
    await provider.create(envB).initialize();
    expect(calls.some((call) => call.url === "https://a.example/dbs" && call.method === "POST" && call.body === JSON.stringify({ id: "db-a" }))).toBe(true);
    expect(calls.some((call) => call.url === "https://b.example/dbs" && call.method === "POST" && call.body === JSON.stringify({ id: "db-b" }))).toBe(true);

    const worker = createRuntimeWorker({ storeProvider: provider });
    const response = await workerFetch(worker)(
      new Request("https://selection.test/api/sekiban/serialized/tag-latest-sortable", {
        method: "POST",
        body: JSON.stringify({ tag: "explicit-cosmos" }),
      }),
      { ...envA, TAG: tagNamespace(), SDT_SERVICE_ID: "selection-test" }, {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(calls.some((call) => call.url.startsWith("https://a.example/"))).toBe(true);
  });

  it("passes the complete static triple to the REST client without environment mixing", async () => {
    const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
    const provider = createCosmosStoreProvider({
      endpoint: "https://static.example/root",
      database: "static-db",
      key: completeEnvironment.COSMOS_KEY,
      fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body?.toString() });
        return new Response(null, { status: 201 });
      }) as typeof fetch,
    });
    await provider.create({}).initialize();
    expect(calls[0]).toEqual({ url: "https://static.example/root/dbs", method: "POST", body: JSON.stringify({ id: "static-db" }) });
  });

  it("fails a selected misconfigured read before client or network access", async () => {
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("unexpected Cosmos network call");
    }) as typeof fetch;
    try {
      const response = await handleSerializedRead(
        new Request("https://selection.test/api/sekiban/serialized/tag-latest-sortable", {
          method: "POST",
          body: JSON.stringify({ tag: "selection" }),
        }),
        { TAG: tagNamespace(), SDT_SERVICE_ID: "selection-test", COSMOS_ENDPOINT: "https://cosmos.example/" },
        DEPLOYED_PROJECTOR_REGISTRY,
        createCosmosStoreProvider(),
      );
      expect(response.status).toBe(500);
      expect(fetchCalls).toBe(0);
      const body = await response.json<{ error: string; detail?: { message?: string } }>();
      expect(body.error).not.toContain(completeEnvironment.COSMOS_KEY);
      expect(body.detail?.message ?? "").not.toContain(completeEnvironment.COSMOS_KEY);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not let request data or static partial values select or complete Cosmos", () => {
    const provider = createCosmosStoreProvider({ client: emptyClient() });
    expect(provider.isConfigured?.({
      COSMOS_ENDPOINT: "request-data-must-not-be-read",
    })).toBe(true);
    expect(() => createCosmosStoreProvider({ database: "static-db" })).toThrow(/COSMOS_ENDPOINT/);
  });

  it("keeps a supplied canary key out of selected-provider responses and committed configuration", async () => {
    const canary = "Y2FuYXJ5LXNlY3JldC1tdXN0LW5vdC1sZWFr";
    const provider = createCosmosStoreProvider({
      endpoint: "https://canary.example/",
      database: "canary-db",
      key: canary,
      fetcher: (async () => { throw new Error(`transport contained ${canary}`); }) as typeof fetch,
    });
    const response = await handleSerializedRead(
      new Request("https://selection.test/api/sekiban/serialized/tag-latest-sortable", {
        method: "POST",
        body: JSON.stringify({ tag: "selection" }),
      }),
      { TAG: tagNamespace(), SDT_SERVICE_ID: "selection-test", G11_VERIFICATION_ENABLED: "true" },
      DEPLOYED_PROJECTOR_REGISTRY,
      provider,
    );
    expect(await response.text()).not.toContain(canary);
    expect(JSON.stringify({ bindings: ["COSMOS_ENDPOINT", "COSMOS_DATABASE", "COSMOS_KEY"], vars: {} })).not.toContain(canary);
  });
});
