import { AllocatorDurableObject } from "./allocator/AllocatorDurableObject";
import { JournalDurableObject } from "./journal/JournalDurableObject";
import { TagDurableObject } from "./tag/TagDurableObject";

export { AllocatorDurableObject, JournalDurableObject, TagDurableObject };

export interface Env {
  ALLOCATOR: DurableObjectNamespace;
  JOURNAL: DurableObjectNamespace;
  TAG: DurableObjectNamespace;
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/allocator" || url.pathname.startsWith("/allocator/")) {
      url.pathname = url.pathname.slice("/allocator".length) || "/state";
      const allocator = env.ALLOCATOR.get(env.ALLOCATOR.idFromName("service-wide-allocator"));
      return allocator.fetch(new Request(url.toString(), request));
    }

    const tagMatch = url.pathname.match(/^\/tags\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (tagMatch !== null) {
      let serviceId: string;
      let tag: string;
      try {
        serviceId = decodeURIComponent(tagMatch[1]);
        tag = decodeURIComponent(tagMatch[2]);
      } catch {
        return new Response("Tag serviceId and tag must be URI encoded", { status: 400 });
      }
      if (serviceId.length === 0 || tag.length === 0) {
        return new Response("Tag serviceId and tag are required", { status: 400 });
      }
      url.pathname = tagMatch[3] ?? "/state";
      url.searchParams.set("__tag", tag);
      const tagObject = env.TAG.get(env.TAG.idFromName(`${serviceId}|${tag}`));
      return tagObject.fetch(new Request(url.toString(), request));
    }

    const match = url.pathname.match(/^\/journals\/([^/]+)(\/.*)?$/);
    if (match === null) {
      return new Response("Journal control route not found", { status: 404 });
    }

    const attemptId = decodeURIComponent(match[1]);
    if (attemptId.length === 0) {
      return new Response("Journal attempt id is required", { status: 400 });
    }

    url.pathname = match[2] ?? "/state";
    const journal = env.JOURNAL.get(env.JOURNAL.idFromName(attemptId));
    return journal.fetch(new Request(url.toString(), request));
  },
};

export default worker;
