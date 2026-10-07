import { describe, expect, it } from "vitest";
import { requireHandlers } from "../packages/dcb-cloudflare/src/compose.js";

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
