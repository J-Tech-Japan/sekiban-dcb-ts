import type { CloudflareOnlyEnv, DeliveryCoreOptions } from "@sekiban/dcb-runtime/cloudflare";

/**
 * Bindings shared by the primary facade and the receiver-only service entry.
 * This is deliberately not a Worker entry module: deployment identity is
 * selected exclusively by the corresponding wrangler configuration.
 */
export interface MeetingRoomCloudflareEnv extends CloudflareOnlyEnv {
  readonly ASSETS?: Fetcher;
  readonly CONFORMANCE_TOKEN?: string;
  readonly G29_SOURCE_COMMIT?: string;
  /** Sealed SDT-G31 source identity exposed only to the authenticated witness. */
  readonly G31_SOURCE_COMMIT?: string;
  /** Final-C identity and new-binding witness; absent only in local pre-G32 fixtures. */
  readonly G32_SOURCE_COMMIT?: string;
  readonly G32_PIPELINE_DATABASE_ID?: string;
  readonly G32_MATERIALIZED_VIEW_DATABASE_ID?: string;
  readonly G32_QUEUE_NAME?: string;
  /** Deployment role; public command/operator/conformance routes require primary. */
  readonly G32_COMPONENT?: string;
  readonly G32_CONFIG_DIGEST?: string;
  readonly G32_CUTOVER_PHASE?: string;
  readonly G32_FREEZE_RELEASE?: string;
  readonly G32_CUTOVER_FENCE_TOKEN?: string;
  readonly G32_CUTOVER_FENCE_FINGERPRINT?: string;
  /** Declares that this deployed component serves the direct doorbell entrypoint. */
  readonly G38_DOORBELL_DELIVERY_ROLE?: string;
  /** In-process integration seam; never configured by a deployed Worker. */
  readonly __G29_DOORBELL_TEST__?: Pick<DeliveryCoreOptions, "store" | "views" | "afterDelivery"> & {
    readonly deliveryPolicy?: Readonly<Record<string, "immediate-preferred" | "queued">>;
  };
}
