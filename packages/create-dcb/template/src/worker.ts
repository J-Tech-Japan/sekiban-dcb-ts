import { composeHandlers, requireHandlers } from "@sekiban/dcb-cloudflare";
import { createCloudflareOnlyRuntimeWorker } from "@sekiban/dcb-runtime/cloudflare";
import { applicationFetch, type StarterEnvironment } from "./booking-routes";
import { bookingDomain, bookingRuntimeConfig } from "./booking-domain";
import { bookingDeliveryViews, catchUpBookingViews, ensureBookingViews } from "./booking-mv";

export {
  AllocatorDurableObject,
  BootstrapCoordinatorDurableObject,
  JournalDurableObject,
  TagDurableObject,
  TagStateDurableObject,
} from "@sekiban/dcb-cloudflare";

const runtime = requireHandlers(createCloudflareOnlyRuntimeWorker({
  domain: bookingDomain,
  config: bookingRuntimeConfig,
  afterBootstrapVerify: async ({ serviceId, env }) => {
    await ensureBookingViews(env, serviceId);
    await catchUpBookingViews(env, serviceId);
  },
  deliveryViews: ({ env }) => bookingDeliveryViews(env),
}));

const worker: ExportedHandler<StarterEnvironment> = composeHandlers<StarterEnvironment>({
  application: {
    fetch: (request, env, ctx) => applicationFetch(request, env, ctx, runtime),
  },
  sekiban: {
    prefix: "/internal/sekiban",
    fetch: runtime.fetch,
    authorize: () => true,
    extraPrefixes: ["/maintenance"],
    queue: runtime.queue,
    scheduled: runtime.scheduled,
  },
});

export default worker;
