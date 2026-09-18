import { describe, expect, it, vi } from "vitest";

import { createRuntimeWorker, type Env } from "../packages/dcb-runtime/src/index";
import { handleOutboxDrainRequest } from "../packages/dcb-runtime/src/downstream/OutboxDrain";
import { buildScopeName } from "../packages/dcb-runtime/src/scope/ScopeName";
import {
  injectableServiceIdentity,
  TEST_SERVICE_ID_HEADER,
} from "../packages/dcb-runtime/src/service/ServiceIdentityProvider";

interface NamespaceCalls {
  readonly names: string[];
  get: number;
}

function namespace(calls: NamespaceCalls, fetchImpl?: DurableObjectStub["fetch"]): DurableObjectNamespace {
  return {
    idFromName(name: string): DurableObjectId {
      calls.names.push(name);
      return name as unknown as DurableObjectId;
    },
    get(id: DurableObjectId): DurableObjectStub {
      calls.get += 1;
      return {
        fetch: fetchImpl ?? (async () => new Response(JSON.stringify({ scope: String(id) }), {
          headers: { "content-type": "application/json" },
        })),
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

function controls(provider = injectableServiceIdentity("deployed-service")) {
  const allocatorCalls: NamespaceCalls = { names: [], get: 0 };
  const bootstrapCalls: NamespaceCalls = { names: [], get: 0 };
  const journalCalls: NamespaceCalls = { names: [], get: 0 };
  const tagCalls: NamespaceCalls = { names: [], get: 0 };
  const worker = createRuntimeWorker({ serviceIdentityProvider: provider });
  const fetch = worker.fetch;
  if (fetch === undefined) throw new Error("runtime Worker must expose fetch");
  const env = {
    ALLOCATOR: namespace(allocatorCalls),
    BOOTSTRAP: namespace(bootstrapCalls),
    JOURNAL: namespace(journalCalls),
    TAG: namespace(tagCalls),
    TAG_STATE: namespace({ names: [], get: 0 }),
    DOWNSTREAM_QUEUE: { send: async () => undefined } as unknown as Queue,
    REPAIR_OPERATOR_TOKEN: "test-operator-token",
    SDT_SERVICE_ID: "ignored-by-injected-provider",
  } as unknown as Env;
  return {
    allocatorCalls,
    bootstrapCalls,
    journalCalls,
    tagCalls,
    env,
    fetch: (request: Request) => fetch(request as never, env, {} as ExecutionContext),
  };
}

describe("SDT-G35 confused-deputy fail-closed", () => {
  it("rejects control-route path serviceId that is not caller authority", async () => {
    const target = controls();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const response = await target.fetch(new Request("https://runtime.test/tags/other-service/room%3A1/state"));
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: "scope.mismatch" });
      expect(target.tagCalls.names).toEqual([]);
      expect(target.tagCalls.get).toBe(0);
    } finally {
      warning.mockRestore();
    }
  });

  it("rejects outbox-drain body serviceId that is not caller authority", async () => {
    const tagCalls: NamespaceCalls = { names: [], get: 0 };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const response = await handleOutboxDrainRequest(
        new Request("https://runtime.test/internal/downstream/drain", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ serviceId: "foreign-service", tags: ["room:1"] }),
        }),
        {
          TAG: namespace(tagCalls),
          DOWNSTREAM_QUEUE: { send: async () => undefined } as unknown as Queue,
          SDT_SERVICE_ID: "deployed-service",
        },
        { serviceIdentityProvider: injectableServiceIdentity("deployed-service") },
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: "scope.mismatch" });
      expect(tagCalls.names).toEqual([]);
      expect(tagCalls.get).toBe(0);
      expect(warning).toHaveBeenCalledWith(expect.objectContaining({
        schema: "sdt.scope/v1",
        code: "scope.mismatch",
        route: "outbox-drain",
      }));
    } finally {
      warning.mockRestore();
    }
  });

  it("addresses outbox-drain through caller authority even when body repeats it", async () => {
    const tagCalls: NamespaceCalls = { names: [], get: 0 };
    const response = await handleOutboxDrainRequest(
      new Request("https://runtime.test/internal/downstream/drain", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TEST_SERVICE_ID_HEADER]: "authority-service",
        },
        body: JSON.stringify({ serviceId: "authority-service", tags: ["room:alpha"] }),
      }),
      {
        TAG: namespace(tagCalls, async () => new Response(JSON.stringify({ rows: [] }), {
          headers: { "content-type": "application/json" },
        })),
        DOWNSTREAM_QUEUE: { send: async () => undefined } as unknown as Queue,
        SDT_SERVICE_ID: "deployed-service",
      },
      { serviceIdentityProvider: injectableServiceIdentity("deployed-service") },
    );
    expect(response.status).toBe(200);
    expect(tagCalls.names).toEqual([
      buildScopeName({ serviceId: "authority-service", doClass: "tag", identity: "room:alpha" }),
    ]);
  });

  it("journal control route names include caller authority serviceId", async () => {
    const target = controls(injectableServiceIdentity("journal-authority"));
    const response = await target.fetch(new Request("https://runtime.test/journals/attempt-1/state"));
    expect(response.status).toBe(200);
    expect(target.journalCalls.names).toEqual([
      buildScopeName({ serviceId: "journal-authority", doClass: "journal", identity: "attempt-1" }),
    ]);
  });

});
