import { beforeAll, describe, expect, it, vi } from "vitest";
import { SERIALIZED_PATHS } from "../packages/dcb-cloudflare/src/compose";

const { authorizeSpy, runtimeFetch } = vi.hoisted(() => ({
  authorizeSpy: vi.fn<(request: unknown, env: unknown, ctx: unknown) => boolean>(() => true),
  runtimeFetch: vi.fn(async () => new Response("runtime")),
}));

vi.mock("@sekiban/dcb-runtime/cloudflare", () => ({
  createCloudflareOnlyRuntimeWorker: () => ({
    fetch: runtimeFetch,
    queue: async () => undefined,
    scheduled: async () => undefined,
  }),
  AllocatorDurableObject: class AllocatorDurableObject {},
  BootstrapCoordinatorDurableObject: class BootstrapCoordinatorDurableObject {},
  JournalDurableObject: class JournalDurableObject {},
  TagDurableObject: class TagDurableObject {},
  TagStateDurableObject: class TagStateDurableObject {},
}));

vi.mock("@sekiban/dcb-cloudflare", async () => {
  const actual = await import("../packages/dcb-cloudflare/src/compose");
  return {
    ...actual,
    AllocatorDurableObject: class AllocatorDurableObject {},
    BootstrapCoordinatorDurableObject: class BootstrapCoordinatorDurableObject {},
    JournalDurableObject: class JournalDurableObject {},
    TagDurableObject: class TagDurableObject {},
    TagStateDurableObject: class TagStateDurableObject {},
    composeHandlers(input: Parameters<typeof actual.composeHandlers>[0]) {
      const sekiban = input.sekiban;
      if (sekiban === undefined) return actual.composeHandlers(input);
      return actual.composeHandlers({
        ...input,
        sekiban: {
          ...sekiban,
          authorize: (request, env, ctx) => {
            authorizeSpy(request, env, ctx);
            return sekiban.authorize(request, env, ctx);
          },
        },
      });
    },
  };
});

const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PURGE"] as const;

function spellings(path: string): Array<{ label: string; pathname: string }> {
  const slash = path.lastIndexOf("/");
  const segment = path.slice(slash + 1);
  const caseChanged = `${path.slice(0, slash + 1)}${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`;
  const code = segment.charCodeAt(segment.length - 1).toString(16).toUpperCase();
  const encoded = `${path.slice(0, -1)}%${code}`;
  return [
    { label: "canonical", pathname: path },
    { label: "trailing-slash", pathname: `${path}/` },
    { label: "case-changed", pathname: caseChanged },
    { label: "percent-encoded", pathname: encoded },
  ];
}

type WorkerFetch = (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;

describe("generated starter HTTP surface", () => {
  let workerFetch: WorkerFetch;

  beforeAll(async () => {
    const worker = await import("../packages/create-dcb/template/src/worker");
    workerFetch = worker.default.fetch as WorkerFetch;
  });

  async function expectQuiet(
    boundary: "mounted" | "bare",
    path: string,
    method: string,
    label: string,
    pathname: string,
  ): Promise<void> {
    const mounted = boundary === "mounted";
    const detail = `${path} ${method} ${label} ${mounted ? "under /internal/sekiban" : "at the bare application path"}`;
    authorizeSpy.mockClear();
    runtimeFetch.mockClear();
    const response = await workerFetch(
      new Request(`https://starter.test${mounted ? "/internal/sekiban" : ""}${pathname}`, { method }),
      {},
      {} as ExecutionContext,
    );
    expect(response.status, detail).toBe(404);
    await expect(response.text(), detail).resolves.toBe(
      mounted ? "runtime route is not forwarded" : "Not found",
    );
    expect(authorizeSpy, detail).not.toHaveBeenCalled();
    expect(authorizeSpy.mock.calls, detail).toHaveLength(0);
    expect(runtimeFetch, detail).not.toHaveBeenCalled();
    expect(runtimeFetch.mock.calls, detail).toHaveLength(0);
  }

  it.each(SERIALIZED_PATHS)("serialized route matrix stays unmounted for %s", async (path) => {
    for (const method of methods) {
      for (const spelling of spellings(path)) {
        await expectQuiet("mounted", path, method, spelling.label, spelling.pathname);
        await expectQuiet("bare", path, method, spelling.label, spelling.pathname);
      }
    }
  });
});
