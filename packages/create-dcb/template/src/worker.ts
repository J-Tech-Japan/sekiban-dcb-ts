import { composeHandlers, type FetchHandler, type QueueHandler, type ScheduledHandler } from "@sekiban/dcb-cloudflare";
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
    fetch: ((request: Request, env: unknown, ctx: unknown) => applicationFetch(request, env as StarterEnvironment, ctx as ExecutionContext, runtime)) as unknown as FetchHandler,
  },
  sekiban: {
    prefix: "/internal/sekiban",
    fetch: runtime.fetch as unknown as FetchHandler,
    authorize: () => true,
    queue: runtime.queue as QueueHandler,
    scheduled: runtime.scheduled as ScheduledHandler,
  },
});

const worker = handlers as unknown as ExportedHandler<StarterEnvironment>;

export default worker;
