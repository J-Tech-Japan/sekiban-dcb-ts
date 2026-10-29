import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

const matrix = SERIALIZED_PATHS.flatMap((path) => methods.flatMap((method) => (
  spellings(path).map((spelling) => ({ path, method, ...spelling }))
)));

type WorkerFetch = (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;

describe("generated starter HTTP surface", () => {
  let workerFetch: WorkerFetch;

  beforeAll(async () => {
    const worker = await import("../packages/create-dcb/template/src/worker");
    workerFetch = worker.default.fetch as WorkerFetch;
  });

  beforeEach(() => {
    authorizeSpy.mockClear();
    runtimeFetch.mockClear();
  });

  it.each(matrix)(
    "serialized route matrix stays unmounted for $path $method $label under /internal/sekiban",
    async ({ method, pathname }) => {
      const response = await workerFetch(
        new Request(`https://starter.test/internal/sekiban${pathname}`, { method }),
        {},
        {} as ExecutionContext,
      );
      expect(response.status, pathname).toBe(404);
      await expect(response.text(), pathname).resolves.toBe("runtime route is not forwarded");
      expect(authorizeSpy, pathname).not.toHaveBeenCalled();
      expect(authorizeSpy.mock.calls, pathname).toHaveLength(0);
      expect(runtimeFetch, pathname).not.toHaveBeenCalled();
      expect(runtimeFetch.mock.calls, pathname).toHaveLength(0);
    },
  );

  it.each(matrix)(
    "serialized route matrix stays unmounted for $path $method $label at the bare application path",
    async ({ method, pathname }) => {
      const response = await workerFetch(
        new Request(`https://starter.test${pathname}`, { method }),
        {},
        {} as ExecutionContext,
      );
      expect(response.status, pathname).toBe(404);
      await expect(response.text(), pathname).resolves.toBe("Not found");
      expect(authorizeSpy, pathname).not.toHaveBeenCalled();
      expect(authorizeSpy.mock.calls, pathname).toHaveLength(0);
      expect(runtimeFetch, pathname).not.toHaveBeenCalled();
      expect(runtimeFetch.mock.calls, pathname).toHaveLength(0);
    },
  );
});
