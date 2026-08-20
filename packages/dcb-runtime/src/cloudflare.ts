/**
 * Cloudflare-only runtime composition.
 *
 * This entrypoint is deliberately separate from the default runtime entrypoint:
 * it imports the D1 provider directly and never imports the Postgres/Cosmos
 * provider graph. A Worker using this surface therefore has an auditable
 * zero-external-database bundle while the ordinary entrypoint remains the
 * unchanged Postgres composition.
 */
import type { DomainDefinition } from "@sekiban/dcb-core";
import { AllocatorDurableObject } from "./allocator/AllocatorDurableObject";
import { allocatorNameForService } from "./allocator/types";
import { BootstrapCoordinatorDurableObject } from "./bootstrap/BootstrapCoordinatorDurableObject";
import { handleOperatorBootstrap } from "./bootstrap/OperatorBootstrap";
import { handleOperatorRepair } from "./cli/OperatorRepairCli";
import { handleSerializedCommit } from "./commit/CommitWorker";
import { handleDownstreamQueue, stabilizeDownstream } from "./downstream/DownstreamAdapter";
import { handleOutboxDrainRequest } from "./downstream/OutboxDrain";
import type { DownstreamOutboxMessage } from "./downstream/types";
import { JournalDurableObject } from "./journal/JournalDurableObject";
import { composeRuntime, type RuntimeWorkerConfig } from "./composition";
import { createD1StoreProvider } from "./d1";
import { handleProjectionLag, pollLiveProjections } from "./projection/LiveProjectionWorker";
import { handleSerializedQuery } from "./http/SerializedQueryWorker";
import { serviceIdForRequest } from "./http/testServiceId";
import { handleSerializedRead } from "./read/SerializedReadWorker";
import { TagDurableObject } from "./tag/TagDurableObject";

export interface CloudflareOnlyEnv {
  ALLOCATOR: DurableObjectNamespace;
  BOOTSTRAP: DurableObjectNamespace;
  JOURNAL: DurableObjectNamespace;
  TAG: DurableObjectNamespace;
  DOWNSTREAM_QUEUE: Queue<DownstreamOutboxMessage>;
  D1: D1Database;
  D1_MV: D1Database;
  AUTO_DRAIN_OUTBOX?: string;
  REPAIR_OPERATOR_TOKEN: string;
  REPAIR_EXCLUSION_LOOKUP?: Fetcher;
  G11_VERIFICATION_ENABLED?: string;
  SDT_SERVICE_ID?: string;
}

export interface CloudflareOnlyWorkerOptions {
  readonly domain?: DomainDefinition;
  readonly config?: RuntimeWorkerConfig;
  /** Optional deployment read-model rebuild that must finish before READY. */
  readonly afterBootstrapVerify?: (input: { readonly serviceId: string; readonly env: CloudflareOnlyEnv }) => Promise<void>;
}

/** Compose the named two-D1 Cloudflare-only Worker. */
export function createCloudflareOnlyRuntimeWorker(
  options: CloudflareOnlyWorkerOptions = {},
): ExportedHandler<CloudflareOnlyEnv> {
  const composition = composeRuntime(options.domain, options.config);
  const storeProvider = createD1StoreProvider();
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
          storeProvider,
          queryBacking: "d1-mv",
        });
      }
      if (url.pathname === "/operator/repair") {
        return handleOperatorRepair(request, env);
      }
      if (url.pathname.startsWith("/operator/bootstrap/")) {
        return handleOperatorBootstrap(request, env, storeProvider, {
          afterVerifyBeforeReady: options.afterBootstrapVerify === undefined
            ? undefined
            : ({ serviceId }) => options.afterBootstrapVerify!({ serviceId, env }),
        });
      }
      if (url.pathname === "/internal/downstream/drain" && request.method === "POST") {
        return handleOutboxDrainRequest(request, env);
      }
      if (url.pathname === "/internal/projection/lag") {
        return handleProjectionLag(request, env, composition.projectors, storeProvider);
      }
      if (
        url.pathname === "/api/sekiban/serialized/tag-latest-sortable" ||
        url.pathname === "/api/sekiban/serialized/tag-state"
      ) {
        return handleSerializedRead(request, env, composition.projectors, storeProvider);
      }
      if (url.pathname === "/allocator" || url.pathname.startsWith("/allocator/")) {
        url.pathname = url.pathname.slice("/allocator".length) || "/state";
        const serviceId = serviceIdForRequest(request, {
          allowG11Verification: env.G11_VERIFICATION_ENABLED === "true",
          configuredServiceId: env.SDT_SERVICE_ID,
        });
        const allocator = env.ALLOCATOR.get(env.ALLOCATOR.idFromName(allocatorNameForService(serviceId)));
        return allocator.fetch(new Request(url.toString(), request));
      }

      const bootstrapMatch = url.pathname.match(/^\/bootstrap\/([^/]+)(\/.*)?$/);
      if (bootstrapMatch !== null) {
        let serviceId: string;
        try { serviceId = decodeURIComponent(bootstrapMatch[1]); } catch { return new Response("Bootstrap serviceId must be URI encoded", { status: 400 }); }
        if (serviceId.length === 0) return new Response("Bootstrap serviceId is required", { status: 400 });
        url.pathname = bootstrapMatch[2] ?? "/state"; url.searchParams.set("__serviceId", serviceId);
        return env.BOOTSTRAP.get(env.BOOTSTRAP.idFromName(serviceId)).fetch(new Request(url.toString(), request));
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
      await handleDownstreamQueue(batch, env, { storeProvider });
    },

    async scheduled(_controller, env): Promise<void> {
      await stabilizeDownstream(env, { storeProvider });
      await pollLiveProjections(env, { registry: composition.projectors, storeProvider });
    },
  };
}

export { AllocatorDurableObject, BootstrapCoordinatorDurableObject, JournalDurableObject, TagDurableObject };

const cloudflareOnlyRuntime = createCloudflareOnlyRuntimeWorker();
export default cloudflareOnlyRuntime;
