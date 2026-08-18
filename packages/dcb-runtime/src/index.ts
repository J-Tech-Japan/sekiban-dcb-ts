import type { DomainDefinition } from "@sekiban/dcb-core";
import { AllocatorDurableObject } from "./allocator/AllocatorDurableObject";
import { handleOperatorRepair } from "./cli/OperatorRepairCli";
import { handleSerializedCommit } from "./commit/CommitWorker";
import { handleDownstreamQueue, stabilizeDownstream } from "./downstream/DownstreamAdapter";
import { handleOutboxDrainRequest } from "./downstream/OutboxDrain";
import type { DownstreamOutboxMessage } from "./downstream/types";
import { JournalDurableObject } from "./journal/JournalDurableObject";
import { composeRuntime, type RuntimeWorkerConfig } from "./composition";
import { handleProjectionLag, pollLiveProjections } from "./projection/LiveProjectionWorker";
import { handleSerializedQuery } from "./http/SerializedQueryWorker";
import { handleSerializedRead } from "./read/SerializedReadWorker";
import { TagDurableObject } from "./tag/TagDurableObject";

export { AllocatorDurableObject, JournalDurableObject, TagDurableObject };
export { handleDownstreamQueue, stabilizeDownstream } from "./downstream/DownstreamAdapter";
export type { JsonValue } from "@sekiban/dcb-core";
export type { RuntimeQueryDefinition, RuntimeWorkerConfig } from "./composition";

export interface Env {
  ALLOCATOR: DurableObjectNamespace;
  JOURNAL: DurableObjectNamespace;
  TAG: DurableObjectNamespace;
  /** Secret binding; deployment must configure this rather than a public var. */
  REPAIR_OPERATOR_TOKEN: string;
  /** Queue producer/consumer for durable Tag outbox rows. */
  DOWNSTREAM_QUEUE: Queue<DownstreamOutboxMessage>;
  /** Deployment-only handoff; local tests retain explicit drain control. */
  AUTO_DRAIN_OUTBOX?: string;
  /** Local Docker/CI connection; deployed Workers normally use HYPERDRIVE. */
  POSTGRES_URL?: string;
  HYPERDRIVE?: Hyperdrive;
  REPAIR_EXCLUSION_LOOKUP?: Fetcher;
}

export interface RuntimeWorkerOptions {
  readonly domain?: DomainDefinition;
  readonly config?: RuntimeWorkerConfig;
}

/**
 * Compose a Worker from dcb-core domain values. Projector/query registries are
 * intentionally private implementation details; callers only receive the
 * ordinary Worker handler and can therefore use the same public package
 * surface in consumer applications and local Miniflare tests.
 */
export function createRuntimeWorker(options: RuntimeWorkerOptions = {}): ExportedHandler<Env> {
  const composition = composeRuntime(options.domain, options.config);
  return {
    async fetch(request, env): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/api/sekiban/serialized/commit") {
        return handleSerializedCommit(request, env);
      }
      if (
        url.pathname === "/api/sekiban/serialized/query" ||
        url.pathname === "/api/sekiban/serialized/list-query"
      ) {
        return handleSerializedQuery(request, env, {
          registry: composition.queries,
          projectors: composition.projectors,
        });
      }
      if (url.pathname === "/operator/repair") {
        return handleOperatorRepair(request, env);
      }
      if (url.pathname === "/internal/downstream/drain" && request.method === "POST") {
        return handleOutboxDrainRequest(request, env);
      }
      if (url.pathname === "/internal/projection/lag") {
        return handleProjectionLag(request, env, composition.projectors);
      }
      if (
        url.pathname === "/api/sekiban/serialized/tag-latest-sortable" ||
        url.pathname === "/api/sekiban/serialized/tag-state"
      ) {
        return handleSerializedRead(request, env, composition.projectors);
      }
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
        url.searchParams.set("__serviceId", serviceId);
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

    async queue(batch, env): Promise<void> {
      await handleDownstreamQueue(batch, env);
    },

    async scheduled(_controller, env): Promise<void> {
      await stabilizeDownstream(env);
      await pollLiveProjections(env, { registry: composition.projectors });
    },
  };
}

const worker = createRuntimeWorker();

export default worker;
