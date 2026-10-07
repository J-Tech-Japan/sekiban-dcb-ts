import {
  composeHandlers,
  requireHandlers,
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

void worker;
void validWorker;
