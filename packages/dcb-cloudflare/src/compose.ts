export const SERIALIZED_PATHS = [
  "/api/sekiban/serialized/commit",
  "/api/sekiban/serialized/query",
  "/api/sekiban/serialized/list-query",
  "/api/sekiban/serialized/tag-latest-sortable",
  "/api/sekiban/serialized/tag-state",
] as const;

export type IncomingRequest<CfHostMetadata = unknown> = Request<
  CfHostMetadata,
  IncomingRequestCfProperties<CfHostMetadata>
>;

export type FetchHandler<
  Env = unknown,
  Ctx = ExecutionContext,
  RequestType extends Request = IncomingRequest,
> = (request: RequestType, env: Env, ctx: Ctx) => Promise<Response> | Response;
export type QueueHandler<
  Env = unknown,
  Ctx = ExecutionContext,
  Batch = MessageBatch<unknown>,
> = (batch: Batch, env: Env, ctx: Ctx) => Promise<void> | void;
export type ScheduledHandler<
  Env = unknown,
  Ctx = ExecutionContext,
  Controller = ScheduledController,
> = (controller: Controller, env: Env, ctx: Ctx) => Promise<void> | void;
export type AuthorizeResult = boolean | Response;
export type Authorize<RequestType extends Request = IncomingRequest> = (
  request: RequestType,
) => AuthorizeResult | Promise<AuthorizeResult>;

export interface SekibanMount<
  Env = unknown,
  Ctx = ExecutionContext,
  RequestType extends Request = IncomingRequest,
  Batch = MessageBatch<unknown>,
  Controller = ScheduledController,
> {
  prefix: string;
  fetch: FetchHandler<Env, Ctx, Request>;
  authorize: Authorize<RequestType>;
  extraPaths?: readonly string[];
  queue?: QueueHandler<Env, Ctx, Batch>;
  scheduled?: ScheduledHandler<Env, Ctx, Controller>;
}

export interface ApplicationHandlers<
  Env = unknown,
  Ctx = ExecutionContext,
  RequestType extends Request = IncomingRequest,
  Batch = MessageBatch<unknown>,
  Controller = ScheduledController,
> {
  fetch: FetchHandler<Env, Ctx, RequestType>;
  queue?: QueueHandler<Env, Ctx, Batch>;
  scheduled?: ScheduledHandler<Env, Ctx, Controller>;
}

export interface RequiredHandlers<
  Env,
  Ctx = ExecutionContext,
  Batch = MessageBatch<unknown>,
  Controller = ScheduledController,
> {
  fetch: (request: Request, env: Env, ctx: Ctx) => Promise<Response>;
  queue: QueueHandler<Env, Ctx, Batch>;
  scheduled: ScheduledHandler<Env, Ctx, Controller>;
}

/** Bridge the optional handler members returned by createCloudflareOnlyRuntimeWorker(). */
export function requireHandlers<
  Env,
  Ctx,
  CfHostMetadata,
  Batch,
  Controller,
>(handlers: {
  fetch?: FetchHandler<Env, Ctx, IncomingRequest<CfHostMetadata>>;
  queue?: QueueHandler<Env, Ctx, Batch>;
  scheduled?: ScheduledHandler<Env, Ctx, Controller>;
}): RequiredHandlers<Env, Ctx, Batch, Controller> {
  const { fetch, queue, scheduled } = handlers;
  if (fetch === undefined) throw new Error("fetch handler is required");
  if (queue === undefined) throw new Error("queue handler is required");
  if (scheduled === undefined) throw new Error("scheduled handler is required");
  return {
    fetch: async (request, env, ctx) => fetch(request as IncomingRequest<CfHostMetadata>, env, ctx),
    queue,
    scheduled,
  };
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

function allowlist(mount: Pick<SekibanMount, "extraPaths">): ReadonlySet<string> {
  return new Set<string>([...SERIALIZED_PATHS, ...(mount.extraPaths ?? [])]);
}

export function composeFetch<
  Env = unknown,
  Ctx = ExecutionContext,
  RequestType extends Request = IncomingRequest,
>(input: {
  application: FetchHandler<Env, Ctx, RequestType>;
  sekiban?: SekibanMount<Env, Ctx, RequestType, never, never>;
}): FetchHandler<Env, Ctx, RequestType> {
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

type VoidHandler<Input, Env, Ctx> = (input: Input, env: Env, ctx: Ctx) => Promise<void> | void;

function chain<Input, Env, Ctx>(
  first?: VoidHandler<Input, Env, Ctx>,
  second?: VoidHandler<Input, Env, Ctx>,
): VoidHandler<Input, Env, Ctx> | undefined {
  if (first === undefined && second === undefined) return undefined;
  const wrapped: VoidHandler<Input, Env, Ctx> = async (...args) => {
    if (first !== undefined) await first(...args);
    if (second !== undefined) await second(...args);
  };
  return wrapped;
}

export function composeHandlers<
  Env = unknown,
  Ctx = ExecutionContext,
  RequestType extends Request = IncomingRequest,
  Batch = MessageBatch<unknown>,
  Controller = ScheduledController,
>(input: {
  application: ApplicationHandlers<Env, Ctx, RequestType, Batch, Controller>;
  sekiban?: SekibanMount<Env, Ctx, RequestType, Batch, Controller>;
}): ApplicationHandlers<Env, Ctx, RequestType, Batch, Controller> {
  const fetch = composeFetch({ application: input.application.fetch, sekiban: input.sekiban });
  const queue = chain(input.sekiban?.queue, input.application.queue);
  const scheduled = chain(input.sekiban?.scheduled, input.application.scheduled);
  return {
    fetch,
    ...(queue === undefined ? {} : { queue }),
    ...(scheduled === undefined ? {} : { scheduled }),
  };
}
