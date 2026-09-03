import { describe, expect, it, vi } from "vitest";

import { createRuntimeWorker, type Env } from "../packages/dcb-runtime/src/index";
import { enforceControlRouteScope } from "../packages/dcb-runtime/src/scope/ControlRouteScope";
import {
  buildScopeName,
  parseScopeName,
  scopeIdFor,
  ScopeNameError,
} from "../packages/dcb-runtime/src/scope/ScopeName";
import {
  envServiceIdentity,
  injectableServiceIdentity,
  ServiceIdentityMissingError,
  G11_SERVICE_ID_HEADER,
  TEST_SERVICE_ID_HEADER,
} from "../packages/dcb-runtime/src/service/ServiceIdentityProvider";

interface NamespaceCalls {
  readonly names: string[];
  get: number;
}

function namespace(calls: NamespaceCalls): DurableObjectNamespace {
  return {
    idFromName(name: string): DurableObjectId {
      calls.names.push(name);
      return name as unknown as DurableObjectId;
    },
    get(id: DurableObjectId): DurableObjectStub {
      calls.get += 1;
      return {
        fetch: async () => new Response(JSON.stringify({ scope: String(id) }), {
          headers: { "content-type": "application/json" },
        }),
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

function controls(provider = injectableServiceIdentity("deployed-service")) {
  const allocatorCalls: NamespaceCalls = { names: [], get: 0 };
  const bootstrapCalls: NamespaceCalls = { names: [], get: 0 };
  const journalCalls: NamespaceCalls = { names: [], get: 0 };
  const tagCalls: NamespaceCalls = { names: [], get: 0 };
  const tagStateCalls: NamespaceCalls = { names: [], get: 0 };
  const worker = createRuntimeWorker({ serviceIdentityProvider: provider });
  const fetch = worker.fetch;
  if (fetch === undefined) throw new Error("runtime Worker must expose fetch");
  const env = {
    ALLOCATOR: namespace(allocatorCalls),
    BOOTSTRAP: namespace(bootstrapCalls),
    JOURNAL: namespace(journalCalls),
    TAG: namespace(tagCalls),
    TAG_STATE: namespace(tagStateCalls),
    DOWNSTREAM_QUEUE: {} as Queue,
    REPAIR_OPERATOR_TOKEN: "test-operator-token",
    SDT_SERVICE_ID: "ignored-by-injected-provider",
  } as unknown as Env;
  return {
    allocatorCalls,
    bootstrapCalls,
    journalCalls,
    tagCalls,
    tagStateCalls,
    fetch: (request: Request) => fetch(request as never, env, {} as ExecutionContext),
  };
}

describe("SDT-G53 canonical Durable Object scope names", () => {
  it("builds and parses the one service/class/identity grammar", () => {
    const scope = { serviceId: "meeting-room.v2", doClass: "tag" as const, identity: "room:alpha" };
    const name = buildScopeName(scope);
    expect(name).toBe("meeting-room.v2/tag/room:alpha");
    expect(parseScopeName(name)).toEqual(scope);
    expect(scopeIdFor({ idFromName: (value: string) => value }, scope)).toBe(name);
  });

  it("rejects every invalid scope part instead of producing an alias", () => {
    expect(() => buildScopeName({ serviceId: "", doClass: "tag", identity: "room" })).toThrow(ScopeNameError);
    expect(() => buildScopeName({ serviceId: "service", doClass: "unknown" as never, identity: "room" })).toThrow(ScopeNameError);
    expect(() => buildScopeName({ serviceId: "service", doClass: "tag", identity: "room/alias" })).toThrow(ScopeNameError);
    expect(() => parseScopeName("service/tag/room/alias")).toThrow(ScopeNameError);
  });
});

describe("SDT-G53 ServiceIdentityProvider seam", () => {
  for (const [label, create] of [
    ["environment", () => envServiceIdentity({ SDT_SERVICE_ID: "deployment-service" })],
    ["injectable", () => injectableServiceIdentity("deployment-service")],
  ] as const) {
    it(`uses the same .test and G11 request behaviour for the ${label} provider`, () => {
      const provider = create();
      expect(provider.deployment()).toEqual({ serviceId: "deployment-service", behavior: "deployment" });
      expect(provider.forRequest(new Request("https://identity.test/", {
        headers: { [TEST_SERVICE_ID_HEADER]: "test-service" },
      }))).toEqual({ serviceId: "test-service", behavior: "test-tld-header" });
      expect(provider.forRequest(new Request("https://identity.test/", {
        headers: { [G11_SERVICE_ID_HEADER]: "g11-service" },
      }))).toEqual({ serviceId: "g11-service", behavior: "g11-verification-header" });
      expect(provider.forRequest(new Request("https://identity.example/", {
        headers: { [G11_SERVICE_ID_HEADER]: "g11-service" },
      }), { allowG11Verification: true })).toEqual({ serviceId: "g11-service", behavior: "g11-verification-header" });
      expect(provider.forRequest(new Request("https://identity.example/", {
        headers: { [TEST_SERVICE_ID_HEADER]: "must-not-override" },
      }))).toEqual({ serviceId: "deployment-service", behavior: "deployment" });
    });
  }

  it("has no silent deployment identity default", () => {
    const provider = injectableServiceIdentity(undefined);
    expect(() => provider.deployment()).toThrow(ServiceIdentityMissingError);
    expect(() => provider.forRequest(new Request("https://identity.example/"))).toThrow(ServiceIdentityMissingError);
  });
});

describe("SDT-G53 control-route scope authorization", () => {
  it("rejects a control-route service mismatch before a Durable Object call", async () => {
    const target = controls();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const response = await target.fetch(new Request("https://runtime.test/bootstrap/other-service/state"));
      expect(response.status).toBe(403);
      const body = await response.json<Record<string, unknown>>();
      expect(body).toMatchObject({ code: "scope.mismatch" });
      expect(JSON.stringify(body)).not.toContain("deployed-service");
      expect(target.bootstrapCalls.get).toBe(0);
      expect(target.bootstrapCalls.names).toEqual([]);
      expect(warning).toHaveBeenCalledWith(expect.objectContaining({
        schema: "sdt.scope/v1",
        code: "scope.mismatch",
        route: "bootstrap",
      }));
    } finally {
      warning.mockRestore();
    }
  });

  it("rejects mismatched tag controls before their namespace is resolved", async () => {
    const target = controls();
    const response = await target.fetch(new Request("https://runtime.test/tags/other-service/room%3A1/state"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "scope.mismatch" });
    expect(target.tagCalls.get).toBe(0);
    expect(target.tagCalls.names).toEqual([]);
  });

  it("addresses a valid control route through the injected provider's scoped name", async () => {
    const target = controls(injectableServiceIdentity("injected-service"));
    const response = await target.fetch(new Request("https://runtime.test/bootstrap/injected-service/state"));
    expect(response.status).toBe(200);
    expect(target.bootstrapCalls.names).toEqual(["injected-service/bootstrap/coordinator"]);
    expect(target.bootstrapCalls.get).toBe(1);
  });

  it("returns scope.identity_missing without deriving a control-route identity", () => {
    const result = enforceControlRouteScope({
      request: new Request("https://runtime.test/bootstrap/path-service/state"),
      provider: injectableServiceIdentity(undefined),
      pathServiceId: "path-service",
      route: "bootstrap",
    });
    expect("response" in result).toBe(true);
    if (!("response" in result)) throw new Error("control scope unexpectedly derived an identity");
    expect(result.response.status).toBe(503);
  });

  it("returns a typed missing-identity response before any runtime namespace call", async () => {
    const target = controls(injectableServiceIdentity(undefined));
    const response = await target.fetch(new Request("https://runtime.test/tags/path-service/room/state"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "scope.identity_missing" });
    expect(target.tagCalls.get).toBe(0);
    expect(target.bootstrapCalls.get).toBe(0);
  });
});
