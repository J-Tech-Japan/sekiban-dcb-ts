import { describe, expect, it, vi } from "vitest";
import { composeFetch, requireHandlers } from "../packages/dcb-cloudflare/src/compose.js";

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
