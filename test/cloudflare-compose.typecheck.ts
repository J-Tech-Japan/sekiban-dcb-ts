import {
  composeHandlers,
  requireHandlers,
  type Authorize,
  type FetchHandler,
  type IncomingRequest,
} from "@sekiban/dcb-cloudflare";

interface Env {
  readonly token: string;
}

interface IncompatibleEnv {
  readonly count: number;
}

declare const optionalRuntime: ExportedHandler<Env>;
const runtime = requireHandlers(optionalRuntime);

const application: FetchHandler<Env, ExecutionContext, IncomingRequest> =
  async () => new Response("application");
const incompatible: FetchHandler<IncompatibleEnv, ExecutionContext, Request> =
  async () => new Response("incompatible");

const worker: ExportedHandler<Env> = composeHandlers<Env>({
  application: { fetch: application },
  sekiban: {
    prefix: "/internal/sekiban",
    // @ts-expect-error IncompatibleEnv cannot be used where Env is required.
    fetch: incompatible,
    authorize: () => true,
    queue: runtime.queue,
    scheduled: runtime.scheduled,
  },
});

const validWorker: ExportedHandler<Env> = composeHandlers<Env>({
  application: { fetch: application },
  sekiban: {
    prefix: "/internal/sekiban",
    fetch: runtime.fetch,
    authorize: () => true,
    queue: runtime.queue,
    scheduled: runtime.scheduled,
  },
});

type IsAny<T> = 0 extends (1 & T) ? true : false;

function assertNotAny<T>(_proof: IsAny<T> extends true ? never : true): void {
  void _proof;
}

const contextAuthorize: Authorize<IncomingRequest, Env, ExecutionContext> = (request, env, ctx) => {
  assertNotAny<typeof env>(true);
  assertNotAny<typeof ctx>(true);
  const token: string = env.token;
  ctx.waitUntil(Promise.resolve(request.url));
  void token;
  return true;
};

const contextWorker: ExportedHandler<Env> = composeHandlers<Env>({
  application: { fetch: application },
  sekiban: {
    prefix: "/internal/sekiban",
    fetch: runtime.fetch,
    authorize: contextAuthorize,
    queue: runtime.queue,
    scheduled: runtime.scheduled,
  },
});

const oneArgumentWorker: ExportedHandler<Env> = composeHandlers<Env>({
  application: { fetch: application },
  sekiban: {
    prefix: "/internal/sekiban",
    fetch: runtime.fetch,
    authorize: (request) => request.method.length > 0,
    queue: runtime.queue,
    scheduled: runtime.scheduled,
  },
});

const omittedForwarding: ExportedHandler<Env> = composeHandlers<Env>({
  application: { fetch: application },
  sekiban: {
    prefix: "/internal/sekiban",
    fetch: runtime.fetch,
    authorize: () => true,
    queue: runtime.queue,
    scheduled: runtime.scheduled,
  },
});

const explicitForwarding: ExportedHandler<Env> = composeHandlers<Env>({
  application: { fetch: application },
  sekiban: {
    prefix: "/internal/sekiban",
    fetch: runtime.fetch,
    authorize: () => true,
    forwardSerializedRoutes: true,
    queue: runtime.queue,
    scheduled: runtime.scheduled,
  },
});

const maintenanceOnly: ExportedHandler<Env> = composeHandlers<Env>({
  application: { fetch: application },
  sekiban: {
    prefix: "/internal/sekiban",
    fetch: runtime.fetch,
    authorize: () => true,
    forwardSerializedRoutes: false,
    extraPrefixes: ["/maintenance"],
    queue: runtime.queue,
    scheduled: runtime.scheduled,
  },
});

const nonBooleanForwarding: ExportedHandler<Env> = composeHandlers<Env>({
  application: { fetch: application },
  sekiban: {
    prefix: "/internal/sekiban",
    fetch: runtime.fetch,
    authorize: () => true,
    // @ts-expect-error forwardSerializedRoutes accepts only a boolean.
    forwardSerializedRoutes: "false",
    queue: runtime.queue,
    scheduled: runtime.scheduled,
  },
});

void worker;
void validWorker;
void contextWorker;
void oneArgumentWorker;
void omittedForwarding;
void explicitForwarding;
void maintenanceOnly;
void nonBooleanForwarding;
