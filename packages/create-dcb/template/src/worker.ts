import { composeHandlers } from "@sekiban/dcb-cloudflare";
import { createCloudflareOnlyRuntimeWorker } from "@sekiban/dcb-runtime/cloudflare";
import { applicationFetch, type StarterEnvironment, type StarterRuntime } from "./booking-routes";
import { bookingDomain, bookingRuntimeConfig } from "./booking-domain";
import { bookingDeliveryViews, catchUpBookingViews, ensureBookingViews } from "./booking-mv";

export {
  AllocatorDurableObject,
  BootstrapCoordinatorDurableObject,
  JournalDurableObject,
  TagDurableObject,
  TagStateDurableObject,
} from "@sekiban/dcb-cloudflare";

const runtime = createCloudflareOnlyRuntimeWorker({
  domain: bookingDomain,
  config: bookingRuntimeConfig,
  afterBootstrapVerify: async ({ serviceId, env }) => {
    await ensureBookingViews(env, serviceId);
    await catchUpBookingViews(env, serviceId);
  },
  deliveryViews: ({ env }) => bookingDeliveryViews(env),
}) as unknown as StarterRuntime & {
  readonly queue?: (batch: unknown, env: StarterEnvironment, ctx: ExecutionContext) => Promise<void>;
  readonly scheduled?: (controller: unknown, env: StarterEnvironment, ctx: ExecutionContext) => Promise<void>;
};

const handlers = composeHandlers({
  application: {
    fetch: (request, env, ctx) => applicationFetch(request, env as StarterEnvironment, ctx as ExecutionContext, runtime),
  },
  sekiban: {
    prefix: "/internal/sekiban",
    fetch: runtime.fetch,
    authorize: () => true,
    queue: runtime.queue,
    scheduled: runtime.scheduled,
  },
});

const worker: ExportedHandler<StarterEnvironment> = {
  fetch: handlers.fetch as ExportedHandler<StarterEnvironment>["fetch"],
  queue: handlers.queue as ExportedHandler<StarterEnvironment>["queue"],
  scheduled: handlers.scheduled as ExportedHandler<StarterEnvironment>["scheduled"],
};

export default worker;
