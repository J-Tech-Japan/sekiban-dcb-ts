import {
  observeFaultBarrier,
  processDownstreamDoorbell,
  readDirectDoorbellConfig,
  selectDirectDoorbellViews,
} from "@sekiban/dcb-runtime/cloudflare";
import { createD1StoreProvider } from "@sekiban/dcb-runtime/d1";
import { assertG32FinalFence } from "./compatibility";
import { meetingRoomDeliveryPolicy, meetingRoomRuntimeConfig } from "./domain";
import { meetingRoomDeliveryViews } from "./d1-mv";
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
  const attemptId = message !== null && typeof message === "object" && typeof (message as { attemptId?: unknown }).attemptId === "string"
    ? (message as { attemptId: string }).attemptId
    : undefined;
  if (testOverrides?.faultBarrier !== undefined) {
    await waitForTestFaultBarrier(testOverrides.faultBarrier, attemptId);
  }
  const config = readDirectDoorbellConfig(
    env as unknown as Record<string, unknown>,
    meetingRoomRuntimeConfig.deliveryClass,
    testOverrides?.deliveryPolicy ?? meetingRoomDeliveryPolicy,
  );
  const configuredViews = testOverrides?.views ?? meetingRoomDeliveryViews(env);
  const result = await processDownstreamDoorbell(message, env, {
    ...(testOverrides?.store === undefined ? { storeProvider: createD1StoreProvider() } : { store: testOverrides.store }),
    views: selectDirectDoorbellViews(configuredViews, config),
    // Unsafe delivery owns a durable kick, but it must stay queryable until
    // scheduled safe convergence consumes it. The test seam may still supply
    // an explicit post-delivery hook for its own bounded lifecycle oracle.
    afterDelivery: testOverrides?.afterDelivery,
  });
  console.log("direct_doorbell_core", {
    correlationId: result.correlationId,
    coreDurationMs: result.coreDurationMs,
    viewDurationsMs: result.views.map((view) => ({ id: view.id, durationMs: view.durationMs, status: view.status })),
    disposition: result.fastDisposition,
  });
  if (testOverrides?.faultBarrier !== undefined) {
    observeFaultBarrier({
      barrierId: testOverrides.faultBarrier.barrierId,
      stage: "drained",
      boundedWindowMs: testOverrides.faultBarrier.boundedWindowMs,
      attemptId,
    });
  }
  return result;
}

/**
 * G30's queue/doorbell discrimination uses the pre-existing in-process
 * receiver seam only. It is absent from deployed bindings and cannot change
 * public protocol/control behavior. The structured events let the evidence
 * contract verify start -> release -> drain from measured timestamps.
 */
async function waitForTestFaultBarrier(barrier: Readonly<{
  barrierId: string;
  boundedWindowMs: number;
  waitForRelease: () => Promise<void>;
}>, attemptId?: string): Promise<void> {
  observeFaultBarrier({ barrierId: barrier.barrierId, stage: "started", boundedWindowMs: barrier.boundedWindowMs, attemptId });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      barrier.waitForRelease(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`G30 test fault barrier ${barrier.barrierId} exceeded its bound`)), barrier.boundedWindowMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  observeFaultBarrier({ barrierId: barrier.barrierId, stage: "ended", boundedWindowMs: barrier.boundedWindowMs, attemptId });
}
