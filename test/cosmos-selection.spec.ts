import { describe, expect, it } from "vitest";

import {
  CosmosConfigurationError,
  createCosmosStoreProvider,
} from "../packages/dcb-runtime/src/cosmos";
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

const completeEnvironment = {
  COSMOS_ENDPOINT: "https://cosmos.example/",
  COSMOS_DATABASE: "experimental-db",
  COSMOS_KEY: ["fixture", "cosmos", "key"].join("-"),
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
});
