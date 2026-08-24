import {
  processDownstreamDoorbell,
  readDirectDoorbellConfig,
  selectDirectDoorbellViews,
} from "@sekiban/dcb-runtime/cloudflare";
import { createD1StoreProvider } from "@sekiban/dcb-runtime/d1";
import { assertG32FinalFence } from "./compatibility";
import { meetingRoomDeliveryPolicy, meetingRoomRuntimeConfig } from "./domain";
import { drainMeetingRoomUnsafeKicks, meetingRoomDeliveryViews } from "./d1-mv";
import type { MeetingRoomCloudflareEnv } from "./worker.cloudflare-env";

/** Local/legacy fixtures do not set G32 phase. A deployed final C always does. */
export async function assertFinalCutoverFenceIfConfigured(env: MeetingRoomCloudflareEnv): Promise<void> {
  const configured = env.G32_CUTOVER_PHASE !== undefined || env.G32_CUTOVER_FENCE_TOKEN !== undefined || env.G32_CUTOVER_FENCE_FINGERPRINT !== undefined;
  if (!configured) return;
  await assertG32FinalFence({
    phase: env.G32_CUTOVER_PHASE,
    release: env.G32_FREEZE_RELEASE,
    token: env.G32_CUTOVER_FENCE_TOKEN,
    tokenFingerprint: env.G32_CUTOVER_FENCE_FINGERPRINT,
  });
}

/**
 * The direct delivery implementation is shared intentionally, but its public
 * entrypoint lives only in worker.g38-receiver.ts. This keeps the receiver
 * deployment free of a default fetch surface and local Durable Object classes.
 */
export async function deliverMeetingRoomDoorbell(
  env: MeetingRoomCloudflareEnv,
  ctx: ExecutionContext,
  message: unknown,
) {
  await assertFinalCutoverFenceIfConfigured(env);
  const testOverrides = env.__G29_DOORBELL_TEST__;
  const config = readDirectDoorbellConfig(
    env as unknown as Record<string, unknown>,
    meetingRoomRuntimeConfig.deliveryClass,
    testOverrides?.deliveryPolicy ?? meetingRoomDeliveryPolicy,
  );
  const configuredViews = testOverrides?.views ?? meetingRoomDeliveryViews(env);
  const result = await processDownstreamDoorbell(message, env, {
    ...(testOverrides?.store === undefined ? { storeProvider: createD1StoreProvider() } : { store: testOverrides.store }),
    views: selectDirectDoorbellViews(configuredViews, config),
    afterDelivery: testOverrides?.afterDelivery ?? (async () => {
      ctx.waitUntil(drainMeetingRoomUnsafeKicks(env));
    }),
  });
  console.log("direct_doorbell_core", {
    correlationId: result.correlationId,
    coreDurationMs: result.coreDurationMs,
    viewDurationsMs: result.views.map((view) => ({ id: view.id, durationMs: view.durationMs, status: view.status })),
    disposition: result.fastDisposition,
  });
  return result;
}
