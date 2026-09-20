import {
  AllocatorDurableObject,
  BootstrapCoordinatorDurableObject,
  JournalDurableObject,
  TagDurableObject,
  TagStateDurableObject,
} from "@sekiban/dcb-runtime/cloudflare";

export {
  AllocatorDurableObject,
  BootstrapCoordinatorDurableObject,
  JournalDurableObject,
  TagDurableObject,
  TagStateDurableObject,
};

const marker = "g102-app-marker";

export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/app") return new Response(marker);
    return new Response("not-found", { status: 404 });
  },
};
