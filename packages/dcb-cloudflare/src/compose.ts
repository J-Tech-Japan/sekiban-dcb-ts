export const SERIALIZED_PATHS = [
  "/api/sekiban/serialized/commit",
  "/api/sekiban/serialized/query",
  "/api/sekiban/serialized/list-query",
  "/api/sekiban/serialized/tag-latest-sortable",
  "/api/sekiban/serialized/tag-state",
] as const;

export type FetchHandler = (request: Request, env?: unknown, ctx?: unknown) => Promise<Response> | Response;
export type QueueHandler = (batch: unknown, env?: unknown, ctx?: unknown) => Promise<void> | void;
export type ScheduledHandler = (controller: unknown, env?: unknown, ctx?: unknown) => Promise<void> | void;
export type AuthorizeResult = boolean | Response;
export type Authorize = (request: Request) => AuthorizeResult | Promise<AuthorizeResult>;

export interface SekibanMount {
  prefix: string;
  fetch: FetchHandler;
  authorize: Authorize;
  extraPaths?: readonly string[];
  queue?: QueueHandler;
  scheduled?: ScheduledHandler;
}

export interface ApplicationHandlers {
  fetch: FetchHandler;
  queue?: QueueHandler;
  scheduled?: ScheduledHandler;
}

function assertPrefix(prefix: string): void {
  if (prefix === "" || prefix === "/") {
    throw new Error("prefix must not be empty or /");
  }
  if (!prefix.startsWith("/") || prefix.endsWith("/")) {
    throw new Error("prefix must be an absolute path without a trailing slash");
  }
}

function segmentPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function stripPrefix(pathname: string, prefix: string): string {
  if (pathname === prefix) return "/";
  return pathname.slice(prefix.length);
}

function rewriteRequest(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url, request);
}

function allowlist(mount: SekibanMount): ReadonlySet<string> {
  return new Set<string>([...SERIALIZED_PATHS, ...(mount.extraPaths ?? [])]);
}

export function composeFetch(input: { application: FetchHandler; sekiban?: SekibanMount }): FetchHandler {
  const mount = input.sekiban;
  if (mount !== undefined) {
    if (typeof mount.authorize !== "function") {
      throw new Error("authorize is required to mount runtime routes");
    }
    assertPrefix(mount.prefix);
  }
  const allowed = mount === undefined ? new Set<string>() : allowlist(mount);
  return async (request, env, ctx) => {
    if (mount === undefined) return input.application(request, env, ctx);
    const url = new URL(request.url);
    if (!segmentPrefix(url.pathname, mount.prefix)) return input.application(request, env, ctx);
    const stripped = stripPrefix(url.pathname, mount.prefix);
    if (!allowed.has(stripped)) return new Response("runtime route is not forwarded", { status: 404 });
    const decision = await mount.authorize(request);
    if (decision instanceof Response) return decision;
    if (decision !== true) return new Response("runtime route denied", { status: 403 });
    return mount.fetch(rewriteRequest(request, stripped), env, ctx);
  };
}

function chain<T extends (...args: never[]) => Promise<void> | void>(first?: T, second?: T): T | undefined {
  if (first === undefined && second === undefined) return undefined;
  const wrapped = async (...args: never[]) => {
    if (first !== undefined) await first(...args);
    if (second !== undefined) await second(...args);
  };
  return wrapped as T;
}

export function composeHandlers(input: { application: ApplicationHandlers; sekiban?: SekibanMount }): {
  fetch: FetchHandler;
  queue?: QueueHandler;
  scheduled?: ScheduledHandler;
} {
  const fetch = composeFetch({ application: input.application.fetch, sekiban: input.sekiban });
  const queue = chain(input.sekiban?.queue, input.application.queue);
  const scheduled = chain(input.sekiban?.scheduled, input.application.scheduled);
  return {
    fetch,
    ...(queue === undefined ? {} : { queue }),
    ...(scheduled === undefined ? {} : { scheduled }),
  };
}
