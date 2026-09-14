import {
  observeFaultBarrier,
  createG60DurableHopObserver,
  G65_DIRECT_RING_BUDGET_MS,
  markG65DirectApplyFinished,
  markG65DirectApplyStarted,
  readG65DirectRing,
  recordG65DirectRing,
  processDownstreamDoorbell,
  readDirectDoorbellConfig,
  selectDirectDoorbellViews,
  type G65DirectApplyOutcome,
} from "@sekiban/dcb-runtime/cloudflare";
import { createD1StoreProvider } from "@sekiban/dcb-runtime/d1";
import { assertG32FinalFence } from "./compatibility";
import { deliveryPolicyFromDomain } from "@sekiban/dcb-domain";
import { meetingRoomDomain, meetingRoomRuntimeConfig } from "./domain";
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
 * The per-view policy comes only from the domain's view descriptors. The
 * in-process test seam may substitute descriptors, never a separate policy map.
 */
function meetingRoomDoorbellConfig(env: MeetingRoomCloudflareEnv) {
  return readDirectDoorbellConfig(
    env as unknown as Record<string, unknown>,
    meetingRoomRuntimeConfig.deliveryClass,
    deliveryPolicyFromDomain({ views: env.__G29_DOORBELL_TEST__?.domainViews ?? meetingRoomDomain.views }),
  );
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
  const config = meetingRoomDoorbellConfig(env);
  // The local receiver-only fixtures do not bind D1. The deployed G38
  // receiver does, and that binding is the durable RING authority for AC0.
  // Keeping the fixture fallback preserves the existing transport-only G29/G38
  // tests without pretending their in-memory store is a durable ring.
  if (env.D1 !== undefined) {
    return ringMeetingRoomDoorbell(env, ctx, message, config);
  }
  return applyMeetingRoomDoorbell(env, ctx, message, config);
}

async function applyMeetingRoomDoorbell(
  env: MeetingRoomCloudflareEnv,
  ctx: ExecutionContext,
  message: unknown,
  config = meetingRoomDoorbellConfig(env),
) {
  const testOverrides = env.__G29_DOORBELL_TEST__;
  const attemptId = message !== null && typeof message === "object" && typeof (message as { attemptId?: unknown }).attemptId === "string"
    ? (message as { attemptId: string }).attemptId
    : undefined;
  const durableHopObserver = env.TAG === undefined
    ? undefined
    : createG60DurableHopObserver(env.D1, (promise) => ctx.waitUntil(promise));
  const configuredViews = testOverrides?.views ?? meetingRoomDeliveryViews(env, durableHopObserver);
  const result = await processDownstreamDoorbell(message, env, {
    ...(testOverrides?.store === undefined ? { storeProvider: createD1StoreProvider() } : { store: testOverrides.store }),
    views: selectDirectDoorbellViews(configuredViews, config),
    // Unsafe delivery owns a durable kick, but it must stay queryable until
    // scheduled safe convergence consumes it. The test seam may still supply
    // an explicit post-delivery hook for its own bounded lifecycle oracle.
    afterDelivery: testOverrides?.afterDelivery,
    // The test seam can reproduce the real G44 BLOCK/UNSETTLED callback after
    // independent-unsafe views, without changing the deployed composition.
    beforeViews: testOverrides?.beforeViews,
    durableHopObserver,
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
 * Persist the immutable receiver obligation, return the ring result, and run
 * the existing DeliveryCore in this receiver invocation's waitUntil context.
 * The caller can therefore observe a durable ring without waiting for D1 MV
 * apply. Queue delivery remains the durable global guarantee and replay-safe
 * apply owner.
 */
async function ringMeetingRoomDoorbell(
  env: MeetingRoomCloudflareEnv,
  ctx: ExecutionContext,
  rawMessage: unknown,
  config: ReturnType<typeof readDirectDoorbellConfig>,
) {
  if (rawMessage === null || typeof rawMessage !== "object") {
    throw new Error("Doorbell contained an invalid outbox message");
  }
  const message = rawMessage as Parameters<typeof recordG65DirectRing>[1];
  const ringStartedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ringOperation = recordG65DirectRing(env.D1!, message, ringStartedAt)
    .then((ringOutcome) => ({ status: "completed" as const, ringOutcome }))
    .catch((error) => ({ status: "failed" as const, error }));
  const timeout = new Promise<{ readonly status: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), G65_DIRECT_RING_BUDGET_MS);
  });
  let ring: Awaited<typeof ringOperation> | { readonly status: "timeout" };
  try {
    ring = await Promise.race([ringOperation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const ringFinishedAt = Date.now();
  if (ring.status !== "completed") {
    console.warn("direct_doorbell_ring", {
      status: ring.status === "timeout" ? "budget-expired" : "failed",
      budgetMs: G65_DIRECT_RING_BUDGET_MS,
      ringStartedAt,
      ringFinishedAt,
    });
    return {
      fastDisposition: "failed" as const,
      ringOutcome: ring.status === "timeout" ? "budget-expired" : "failed",
      ringDurationMs: Math.max(0, ringFinishedAt - ringStartedAt),
    };
  }
  const apply = applyG65DirectRing(env, ctx, message, config);
  ctx.waitUntil(apply.catch((error) => {
    console.warn("direct_doorbell_apply", {
      status: "failed",
      error: String(error),
      eventId: message.eventId,
      attemptId: message.attemptId,
    });
  }));
  return {
    fastDisposition: "completed" as const,
    ringOutcome: ring.ringOutcome,
    ringDurationMs: Math.max(0, ringFinishedAt - ringStartedAt),
    applyOutcome: "scheduled" as const,
  };
}

async function applyG65DirectRing(
  env: MeetingRoomCloudflareEnv,
  ctx: ExecutionContext,
  fallbackMessage: Parameters<typeof recordG65DirectRing>[1],
  config: ReturnType<typeof readDirectDoorbellConfig>,
): Promise<void> {
  const message = await readG65DirectRing(env.D1!, fallbackMessage) ?? fallbackMessage;
  const applyStartedAt = Date.now();
  await markG65DirectApplyStarted(env.D1!, message, applyStartedAt);
  try {
    const result = await applyMeetingRoomDoorbell(env, ctx, message, config);
    // DeliveryCore's fast disposition includes the G44 completeness/detector
    // result. That aggregate is intentionally allowed to fail closed while
    // the independent-unsafe views have already applied. The G65 ledger is
    // the RING/APPLY observation, so classify it from the selected unsafe
    // view results and retain the full-core failures as diagnostics instead
    // of misreporting a successful unsafe apply as failed.
    const outcome = classifyG65DirectApplyOutcome(result, config);
    console.log("direct_doorbell_apply", {
      status: outcome,
      coreDisposition: result.fastDisposition,
      failures: result.failures.map((failure) => ({
        failureId: `${failure.phase}:${failure.viewId ?? "core"}:${failure.class}`,
        phase: failure.phase,
        class: failure.class,
        viewId: failure.viewId,
        error: failure.error,
      })),
      unsafeViews: result.views
        .filter((view) => config.allowedViews.includes(view.id))
        .map((view) => ({ id: view.id, status: view.status, durationMs: view.durationMs })),
    });
    await markG65DirectApplyFinished(env.D1!, message, Date.now(), outcome);
  } catch (error) {
    await markG65DirectApplyFinished(env.D1!, message, Date.now(), "failed", String(error));
    throw error;
  }
}

function classifyG65DirectApplyOutcome(
  result: Awaited<ReturnType<typeof applyMeetingRoomDoorbell>>,
  config: ReturnType<typeof readDirectDoorbellConfig>,
): G65DirectApplyOutcome {
  const allowedViews = new Set(config.allowedViews);
  const unsafeViews = result.views.filter((view) => allowedViews.has(view.id));
  if (unsafeViews.length === 0) return "failed";
  if (unsafeViews.every((view) => view.status === "duplicate-race")) return "duplicate";
  return unsafeViews.every((view) => view.status === "applied" || view.status === "duplicate-race")
    ? "applied"
    : "failed";
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
