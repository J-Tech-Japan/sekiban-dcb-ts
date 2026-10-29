import { describe, expect, it, vi } from "vitest";
import {
  SERIALIZED_PATHS,
  composeFetch,
  composeHandlers,
  requireHandlers,
} from "../packages/dcb-cloudflare/src/compose.js";

describe("cloudflare composition", () => {
  it("requireHandlers: rejects a missing fetch, queue, or scheduled handler and forwards present ones", async () => {
    const fetch = async () => new Response("ok");
    const queue = async () => undefined;
    const scheduled = async () => undefined;

    expect(() => requireHandlers({ queue, scheduled })).toThrow(/^fetch handler is required$/);
    expect(() => requireHandlers({ fetch, scheduled })).toThrow(/^queue handler is required$/);
    expect(() => requireHandlers({ fetch, queue })).toThrow(/^scheduled handler is required$/);

    const request = new Request("https://example.test/");
    const env = { token: "secret" };
    const ctx = { waitUntil: () => undefined };
    const expectedResponse = new Response("forwarded");
    let forwarded: { request: Request; env: typeof env; ctx: typeof ctx } | undefined;
    const complete = requireHandlers({
      fetch: async (originalRequest: Request, originalEnv: typeof env, originalCtx: typeof ctx) => {
        forwarded = { request: originalRequest, env: originalEnv, ctx: originalCtx };
        return expectedResponse;
      },
      queue,
      scheduled,
    });

    expect(complete.queue).toBe(queue);
    expect(complete.scheduled).toBe(scheduled);
    const response = await complete.fetch(request, env, ctx);
    expect(forwarded?.request).toBe(request);
    expect(forwarded?.env).toBe(env);
    expect(forwarded?.ctx).toBe(ctx);
    expect(response).toBe(expectedResponse);
  });
});

describe("composeFetch authorization", () => {
  const prefix = "/internal";
  const admittedUrl = "https://example.test/internal/custom-health";

  type Marker = { marker: string };
  type Decision = boolean | Response | Promise<boolean | Response>;
  function mount(
    authorize: (request: Request, env: Marker, ctx: Marker) => Decision,
    runtimeFetch: (request: Request, env: Marker, ctx: Marker) => Promise<Response>,
  ) {
    return composeFetch({
      application: async () => new Response("app"),
      sekiban: {
        prefix,
        extraPaths: ["/custom-health"],
        authorize,
        fetch: runtimeFetch,
      },
    });
  }

  it("passes the exact request, env, and ctx, then calls runtime once", async () => {
    const env = { marker: "env-identity" };
    const ctx = { marker: "ctx-identity" };
    const request = new Request(admittedUrl);
    const order: string[] = [];
    let seen: { request: Request; env: typeof env; ctx: typeof ctx } | undefined;
    const runtimeFetch = vi.fn(async (runtimeRequest: Request, runtimeEnv: typeof env, runtimeCtx: typeof ctx) => {
      order.push("runtime");
      expect(runtimeRequest).not.toBe(request);
      expect(new URL(runtimeRequest.url).pathname).toBe("/custom-health");
      expect(runtimeEnv).toBe(env);
      expect(runtimeCtx).toBe(ctx);
      return new Response("runtime");
    });
    const fetch = mount((gotRequest, gotEnv, gotCtx) => {
      order.push("authorize");
      seen = { request: gotRequest, env: gotEnv, ctx: gotCtx };
      return true;
    }, runtimeFetch);

    const response = await fetch(request, env, ctx);
    expect(seen?.request).toBe(request);
    expect(seen?.env).toBe(env);
    expect(seen?.ctx).toBe(ctx);
    expect(order).toEqual(["authorize", "runtime"]);
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("runtime");
  });

  it.each([404, 503])("returns the authorize Response %s by identity and does not call runtime", async (status) => {
    const env = { marker: `env-${status}` };
    const ctx = { marker: `ctx-${status}` };
    const decision = new Response(`decision-${status}`, { status });
    const runtimeFetch = vi.fn(async () => new Response("runtime"));
    const authorize = vi.fn(() => decision);
    const fetch = mount(authorize, runtimeFetch);
    const response = await fetch(new Request(admittedUrl), env, ctx);
    expect(response).toBe(decision);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(runtimeFetch).not.toHaveBeenCalled();
    expect(runtimeFetch.mock.calls).toHaveLength(0);
  });

  it("maps false to the existing 403 and does not call runtime", async () => {
    const env = { marker: "env-false" };
    const ctx = { marker: "ctx-false" };
    const runtimeFetch = vi.fn(async () => new Response("runtime"));
    const authorize = vi.fn(() => false as const);
    const fetch = mount(authorize, runtimeFetch);
    const response = await fetch(new Request(admittedUrl), env, ctx);
    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe("runtime route denied");
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(runtimeFetch).not.toHaveBeenCalled();
    expect(runtimeFetch.mock.calls).toHaveLength(0);
  });

  it("does not authorize or call runtime when the path is not admitted", async () => {
    const env = { marker: "env-hidden" };
    const ctx = { marker: "ctx-hidden" };
    const runtimeFetch = vi.fn(async () => new Response("runtime"));
    const authorize = vi.fn(() => true);
    const fetch = mount(authorize, runtimeFetch);
    const response = await fetch(new Request("https://example.test/internal/not-listed"), env, ctx);
    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("runtime route is not forwarded");
    expect(authorize).not.toHaveBeenCalled();
    expect(authorize.mock.calls).toHaveLength(0);
    expect(runtimeFetch).not.toHaveBeenCalled();
    expect(runtimeFetch.mock.calls).toHaveLength(0);
  });
});

describe("forwardSerializedRoutes", () => {
  const prefix = "/internal";
  const notForwarded = "runtime route is not forwarded";

  function quietMount(extra: { extraPaths?: readonly string[]; extraPrefixes?: readonly string[] } = {}) {
    const application = vi.fn<(request: Request) => Promise<Response>>(async () => new Response("app"));
    const authorize = vi.fn<(request: Request, env: unknown, ctx: unknown) => boolean>(() => true);
    const runtimeFetch = vi.fn(async () => new Response("runtime"));
    const fetch = composeFetch({
      application,
      sekiban: {
        prefix,
        fetch: runtimeFetch,
        authorize,
        forwardSerializedRoutes: false,
        ...extra,
      },
    });
    return { application, authorize, fetch, runtimeFetch };
  }

  async function expectVeto(
    harness: ReturnType<typeof quietMount>,
    path: string,
  ): Promise<void> {
    harness.authorize.mockClear();
    harness.runtimeFetch.mockClear();
    harness.application.mockClear();
    const response = await harness.fetch(
      new Request(`https://example.test${prefix}${path}`),
      { marker: "env" },
      { marker: "ctx" },
    );
    expect(response.status, path).toBe(404);
    await expect(response.text(), path).resolves.toBe(notForwarded);
    expect(harness.authorize, path).not.toHaveBeenCalled();
    expect(harness.authorize.mock.calls, path).toHaveLength(0);
    expect(harness.runtimeFetch, path).not.toHaveBeenCalled();
    expect(harness.runtimeFetch.mock.calls, path).toHaveLength(0);
    expect(harness.application, path).not.toHaveBeenCalled();
  }

  it.each(SERIALIZED_PATHS)("vetoes %s before authorization and runtime", async (path) => {
    await expectVeto(quietMount(), path);
  });

  it.each(SERIALIZED_PATHS)("vetoes %s when that path is also an extraPath", async (path) => {
    await expectVeto(quietMount({ extraPaths: [path] }), path);
  });

  it.each(SERIALIZED_PATHS)("vetoes %s when that path is also an extraPrefix", async (path) => {
    await expectVeto(quietMount({ extraPrefixes: [path] }), path);
  });

  it.each(SERIALIZED_PATHS)("vetoes %s when an ancestor extraPrefix would match it", async (path) => {
    await expectVeto(quietMount({ extraPrefixes: ["/api/sekiban/serialized"] }), path);
  });

  it("keeps a false mount with no extras quiet and still composes queue and scheduled", async () => {
    const order: string[] = [];
    const application = vi.fn<(request: Request) => Promise<Response>>(async () => new Response("app"));
    const authorize = vi.fn<(request: Request, env: unknown, ctx: unknown) => boolean>(() => true);
    const runtimeFetch = vi.fn(async () => new Response("runtime"));
    const handlers = composeHandlers({
      application: {
        fetch: application,
        queue: async () => { order.push("app-queue"); },
        scheduled: async () => { order.push("app-scheduled"); },
      },
      sekiban: {
        prefix,
        fetch: runtimeFetch,
        authorize,
        forwardSerializedRoutes: false,
        queue: async () => { order.push("runtime-queue"); },
        scheduled: async () => { order.push("runtime-scheduled"); },
      },
    });
    for (const path of SERIALIZED_PATHS) {
      const response = await handlers.fetch(
        new Request(`https://example.test${prefix}${path}`),
        {},
        {} as ExecutionContext,
      );
      expect(response.status, path).toBe(404);
      await expect(response.text(), path).resolves.toBe(notForwarded);
    }
    const inside = await handlers.fetch(
      new Request(`https://example.test${prefix}/not-listed`),
      {},
      {} as ExecutionContext,
    );
    expect(inside.status).toBe(404);
    const outside = await handlers.fetch(
      new Request("https://example.test/application"),
      {},
      {} as ExecutionContext,
    );
    await expect(outside.text()).resolves.toBe("app");
    expect(authorize).not.toHaveBeenCalled();
    expect(authorize.mock.calls).toHaveLength(0);
    expect(runtimeFetch).not.toHaveBeenCalled();
    expect(runtimeFetch.mock.calls).toHaveLength(0);
    await handlers.queue?.({} as MessageBatch, {}, {} as ExecutionContext);
    await handlers.scheduled?.({} as ScheduledController, {}, {} as ExecutionContext);
    expect(order).toEqual(["runtime-queue", "app-queue", "runtime-scheduled", "app-scheduled"]);
  });

  it("still forwards a non-overlapping extra path and the maintenance prefix", async () => {
    const harness = quietMount({
      extraPaths: ["/custom-health"],
      extraPrefixes: ["/maintenance"],
    });
    const health = await harness.fetch(
      new Request(`https://example.test${prefix}/custom-health`),
      {},
      {},
    );
    expect(health.status).toBe(200);
    await expect(health.text()).resolves.toBe("runtime");
    const maintenance = await harness.fetch(
      new Request(`https://example.test${prefix}/maintenance/incidents`),
      {},
      {},
    );
    expect(maintenance.status).toBe(200);
    expect(harness.runtimeFetch).toHaveBeenCalledTimes(2);
    expect(harness.authorize).toHaveBeenCalledTimes(2);
    for (const path of SERIALIZED_PATHS) await expectVeto(harness, path);
  });

  it.each([
    ["omitted", undefined],
    ["true", true],
  ] as const)("forwards a serialized path when the option is %s", async (_label, flag) => {
    const authorize = vi.fn<(request: Request, env: unknown, ctx: unknown) => boolean>(() => true);
    const runtimeFetch = vi.fn(async () => new Response("runtime"));
    const application = vi.fn<(request: Request) => Promise<Response>>(async () => new Response("app"));
    const sekiban = {
      prefix,
      fetch: runtimeFetch,
      authorize,
      ...(flag === undefined ? {} : { forwardSerializedRoutes: flag }),
    };
    const fetch = composeFetch({ application, sekiban });
    const response = await fetch(
      new Request(`https://example.test${prefix}${SERIALIZED_PATHS[0]}`),
      {},
      {},
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("runtime");
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
    expect(application).not.toHaveBeenCalled();
  });

  it.each([
    ["string", "false"],
    ["number", 1],
    ["object", { value: false }],
    ["null", null],
    ["undefined", undefined],
  ] as const)("rejects a present %s value before returning a handler", (_label, value) => {
    const sekiban = {
      prefix,
      fetch: async () => new Response("runtime"),
      authorize: () => true,
    };
    Object.defineProperty(sekiban, "forwardSerializedRoutes", {
      value,
      enumerable: true,
      configurable: true,
    });
    expect(() => composeFetch({
      application: async () => new Response("app"),
      sekiban,
    })).toThrow(/^forwardSerializedRoutes must be boolean$/);
  });
});
