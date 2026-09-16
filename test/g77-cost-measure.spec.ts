/**
 * Portable AC6 cost proxy. Copied into pinned-main worktrees by scripts/g77-cost-measure.mjs
 * because G77 producer routes do not exist at the design-freeze SHA.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { scopeIdFor } from "../packages/dcb-runtime/src/scope/ScopeName";

const BACKLOG_ATTEMPTS = 40;

function allocatorNamespace(): DurableObjectNamespace {
  const namespace = (env as unknown as { readonly ALLOCATOR?: DurableObjectNamespace }).ALLOCATOR;
  if (namespace === undefined) throw new Error("G77 cost proxy needs the Allocator namespace");
  return namespace;
}

async function allocatorPost(serviceId: string, path: string, body?: unknown): Promise<Response> {
  const stub = allocatorNamespace().get(scopeIdFor(allocatorNamespace(), {
    serviceId,
    doClass: "allocator",
    identity: "allocator",
  }));
  return stub.fetch(new Request(`https://allocator.test${path}`, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

async function allocatorGet(serviceId: string, path: string): Promise<Response> {
  const stub = allocatorNamespace().get(scopeIdFor(allocatorNamespace(), {
    serviceId,
    doClass: "allocator",
    identity: "allocator",
  }));
  return stub.fetch(new Request(`https://allocator.test${path}`));
}

async function probeG77Routes(serviceId: string): Promise<boolean> {
  const response = await allocatorGet(serviceId, "/__internal/g77/certificate?serviceId=probe");
  return response.status !== 404;
}

describe("G77 AC6 portable cost proxy", () => {
  it("G77 cost proxy seeds backlog and exercises allocator storage", async () => {
    const serviceId = `g77-cost-${crypto.randomUUID()}`;
    const hasG77 = await probeG77Routes(serviceId);
    for (let index = 0; index < BACKLOG_ATTEMPTS; index += 1) {
      const attemptId = `g77-cost-${String(index).padStart(3, "0")}:${crypto.randomUUID()}`;
      const body: Record<string, unknown> = {
        attemptId,
        serviceId,
        candidates: [{ candidateIndex: 0, eventId: `${attemptId}-event` }],
      };
      if (hasG77) {
        body.candidates = [{
          candidateIndex: 0,
          eventId: `${attemptId}-event`,
          targetTags: [`room:g77:cost:${index}`],
          pinnedWriterEpoch: 0,
        }];
      }
      const allocated = await allocatorPost(serviceId, "/allocate", body);
      expect(allocated.status).toBe(201);
    }
    if (hasG77) {
      await allocatorPost(serviceId, "/__internal/g77/migration-cut", { cutAt: Date.now() });
      let complete = false;
      let pages = 0;
      while (!complete && pages < 20) {
        const page = await allocatorPost(serviceId, "/__internal/g77/legacy-inventory-page", { pageSize: 8 });
        expect(page.status).toBe(200);
        const body = await page.json<{ inventoryComplete: boolean }>();
        complete = body.inventoryComplete;
        pages += 1;
      }
      expect(complete).toBe(true);
      for (let index = 0; index < 3; index += 1) {
        const reconcile = await allocatorPost(serviceId, "/__internal/g77/reconcile-now", {});
        expect(reconcile.status).toBe(200);
      }
    }
    const state = await allocatorGet(serviceId, "/state");
    expect(state.status).toBe(200);
  });

  it("G77 cost proxy A01 pause sample", async () => {
    const serviceId = `g77-cost-pause-${crypto.randomUUID()}`;
    const attemptId = `g77-cost-pause:${crypto.randomUUID()}`;
    const allocated = await allocatorPost(serviceId, "/allocate", {
      attemptId,
      serviceId,
      candidates: [{ candidateIndex: 0, eventId: `${attemptId}-event` }],
    });
    expect(allocated.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const state = await allocatorGet(serviceId, "/state");
    expect(state.status).toBe(200);
  });
});
