import type { ExecuteResult } from "@sekiban/dcb-client";
import {
  createCloudflareOnlyRuntimeWorker,
  createG60DurableHopObserver,
  AllocatorDurableObject,
  BootstrapCoordinatorDurableObject as RuntimeBootstrapCoordinatorDurableObject,
  cleanupG42JournalProbeTrial,
  envServiceIdentity,
  GlobalCompletenessReconciler,
  G42_JOURNAL_PROBE_PATH,
  inventoryG42JournalProbeTrial,
  JournalDurableObject,
  measureG42JournalProbeTrial,
  parseG42JournalProbeRequest,
  prepareG42JournalProbeTrial,
  readDirectDoorbellConfig,
  requireServiceIdentity,
  runG42JournalProbeTrial,
  scopeIdFor,
  TagDurableObject,
  TagStateDurableObject,
  type G42JournalProbeRequest,
  type GlobalCompletenessCoverage,
} from "@sekiban/dcb-runtime/cloudflare";
import { D1EventStore, D1MaterializedViewStore } from "@sekiban/dcb-runtime/d1";
import {
  createV1Transport,
  executeMeetingRoomCommand,
  globalAdmissionStatusFromResult,
  parseMeetingRoomCommandRequest,
} from "./transport";
import { ClientError, createSekibanExecutor } from "@sekiban/dcb-client";
import { meetingRoomDeliveryPolicy, meetingRoomDomain, meetingRoomRuntimeConfig, reservationTag, roomTag } from "./domain";
import {
  catchUpMeetingRoomMaterializedViews,
  drainMeetingRoomUnsafeKicks,
  meetingRoomDeliveryViews,
  readMeetingRoomHealth,
  recordMeetingRoomLivePollAttempt,
  recordMeetingRoomLivePollOutcome,
  recordMeetingRoomSafeLaneCoverage,
  recordMeetingRoomSafeLanePass,
  readMeetingRoomSafeHeads,
  type MeetingRoomSafeLaneCoverage,
} from "./d1-mv";
import { rejectUnlessPrimaryComponent } from "./worker.g38-component-guard";
import { assertFinalCutoverFenceIfConfigured } from "./worker.cloudflare-receiver-support";
import type { MeetingRoomCloudflareEnv } from "./worker.cloudflare-env";
import { runtimeRequestWithIngressRay } from "./ingress-observation";
import {
  createSafeLaneKickScheduler,
  type SafeLaneKickOwner,
  type SafeLaneKickRequest,
  type SafeLanePassTrigger,
} from "./safe-lane-kick";

export { MeetingRoomDownstreamDoorbell } from "./worker.g38-receiver";
export type { MeetingRoomCloudflareEnv } from "./worker.cloudflare-env";

export { AllocatorDurableObject, JournalDurableObject, TagDurableObject, TagStateDurableObject };

const safeLaneKickSchedulers = new Map<string, (request: SafeLaneKickRequest) => Promise<void>>();
const SAFE_LANE_ALARM_KEY = "sdt-g67-safe-lane-alarm";
const SAFE_LANE_RETRY_BASE_MS = 1_000;
const SAFE_LANE_RETRY_MAX_MS = 30_000;

interface SafeLaneAlarmState {
  readonly serviceId: string;
  readonly dueAt: number;
  readonly trigger: "fence-expiry" | "coverage-retry";
  readonly retryCount: number;
  readonly owner?: SafeLaneKickOwner;
}

interface SafeLaneFollowUp {
  readonly trigger: "fence-expiry" | "coverage-retry";
  readonly dueAt: number;
  readonly retryCount: number;
  readonly reason: string;
  readonly owner?: SafeLaneKickOwner;
}

function safeLaneRetryDelayMs(retryCount: number): number {
  const exponent = Math.min(Math.max(retryCount, 0), 5);
  return Math.min(SAFE_LANE_RETRY_MAX_MS, SAFE_LANE_RETRY_BASE_MS * (2 ** exponent));
}

async function scheduleMeetingRoomSafeLaneFollowUp(
  env: MeetingRoomCloudflareEnv,
  serviceId: string,
  followUp: SafeLaneFollowUp,
): Promise<void> {
  if (serviceId.length === 0 || env.BOOTSTRAP === undefined) {
    console.warn("safe_lane_alarm", {
      status: "not-scheduled",
      reason: "bootstrap_binding_or_service_identity_missing",
      trigger: followUp.trigger,
      dueAt: followUp.dueAt,
    });
    return;
  }
  const coordinator = env.BOOTSTRAP.get(scopeIdFor(env.BOOTSTRAP, {
    serviceId,
    doClass: "bootstrap",
    identity: "coordinator",
  }));
  const response = await coordinator.fetch(new Request(
    `https://safe-lane.internal/safe-lane/schedule?__serviceId=${encodeURIComponent(serviceId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        dueAt: followUp.dueAt,
        trigger: followUp.trigger,
        retryCount: followUp.retryCount,
        ...(followUp.owner === undefined ? {} : { owner: followUp.owner }),
      }),
    },
  ));
  if (!response.ok) throw new Error(`safe_lane_alarm_schedule_failed:${response.status}`);
}

async function bestEffortSafeLanePassObservation(
  env: MeetingRoomCloudflareEnv,
  input: Parameters<typeof recordMeetingRoomSafeLanePass>[1],
): Promise<void> {
  try {
    await recordMeetingRoomSafeLanePass(env, input);
  } catch (error) {
    // The observer is additive evidence only. A missing or unavailable
    // observer table must not change the G44 decision or safe catch-up.
    console.warn("safe_lane_pass_observation", {
      status: "failed",
      serviceId: input.serviceId,
      passId: input.passId,
      trigger: input.trigger,
      lifecycle: input.status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function bestEffortSafeLaneHeads(
  env: MeetingRoomCloudflareEnv,
  serviceId: string,
): Promise<string | null> {
  try {
    return await readMeetingRoomSafeHeads(env, serviceId);
  } catch (error) {
    console.warn("safe_lane_pass_observation", {
      status: "failed",
      serviceId,
      lifecycle: "safe-head-read",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Run the same G44 coverage -> safe MV catch-up body used by cron. A kick
 * performs a fresh reconciliation first; cron supplies the scan it already
 * completed so it does not introduce a second scanner pass in that tick.
 */
export async function runMeetingRoomSafeLanePass(
  env: MeetingRoomCloudflareEnv,
  serviceId: string,
  trigger: SafeLanePassTrigger,
  existingCoverage?: GlobalCompletenessCoverage,
  request?: SafeLaneKickRequest,
): Promise<void> {
  if (env.D1 === undefined || env.TAG === undefined || env.D1_MV === undefined) return;
  const startedAt = Date.now();
  const effectiveTrigger = request?.trigger ?? trigger;
  const passId = request?.passId ?? `${effectiveTrigger}:${String(startedAt)}:${crypto.randomUUID()}`;
  const scheduledAt = request?.scheduledAt ?? startedAt;
  const deliveryOwner = request?.owner;
  await bestEffortSafeLanePassObservation(env, {
    serviceId,
    passId,
    trigger: effectiveTrigger,
    status: "scheduled",
    scheduledAt,
    deliveryOwner,
  });
  await bestEffortSafeLanePassObservation(env, {
    serviceId,
    passId,
    trigger: effectiveTrigger,
    status: "running",
    scheduledAt,
    startedAt,
    deliveryOwner,
  });
  let coverage: GlobalCompletenessCoverage | undefined;
  let safeHeadsBeforeJson: string | null = null;
  let catchUpStartedAt: number | null = null;
  let catchUpCompletedAt: number | null = null;
  let catchUpOutcome: string | null = null;
  let catchUpResultJson: string | null = null;
  let catchUpError: string | null = null;
  let catchUpObservations: Awaited<ReturnType<typeof catchUpMeetingRoomMaterializedViews>> = [];
  try {
    const reconciler = new GlobalCompletenessReconciler(env.D1, env.TAG);
    const computedCoverage = existingCoverage ?? await (async () => {
      await reconciler.reconcile(serviceId, Date.now());
      return reconciler.coverage(serviceId, Date.now());
    })();
    coverage = computedCoverage;
    safeHeadsBeforeJson = await bestEffortSafeLaneHeads(env, serviceId);
    const effectiveCatchUp = async (frontierSuid?: string | null): Promise<void> => {
      catchUpStartedAt = Date.now();
      try {
        const observations = await catchUpMeetingRoomMaterializedViews(env, serviceId, frontierSuid, {
          // The late-lower detector is retained only for explicit isolated
          // proof tests. It is not affordable on either production safe-lane
          // trigger, including the cron backstop; G44/G62 safe catch-up and
          // the in-batch fail-closed order check remain unchanged.
          runOrderingDetector: false,
        });
        catchUpObservations = observations;
        // Persist the actual SafeWindow/MV result separately from the G44
        // coverage decision. A completed pass may legitimately advance zero
        // rows when the first source event is still inside SafeWindow; that
        // is evidence, not permission to widen the safe lane.
        catchUpResultJson = JSON.stringify(observations);
        catchUpCompletedAt = Date.now();
        catchUpOutcome = "completed";
      } catch (error) {
        catchUpCompletedAt = Date.now();
        catchUpOutcome = "failed";
        catchUpError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    };
    await runMeetingRoomScheduledMaintenance({
      freshCoverage: async () => computedCoverage,
      catchUp: effectiveCatchUp,
      drainUnsafeKicks: (frontierSuid) => drainMeetingRoomUnsafeKicks(env, Date.now(), frontierSuid),
      runGenericScheduledWork: async () => {},
      ...(effectiveTrigger === "cron"
        ? { recordCoverage: (safeLaneCoverage: MeetingRoomSafeLaneCoverage) => recordMeetingRoomSafeLaneCoverage(env, serviceId, safeLaneCoverage) }
        : {}),
    });
    const deferred = catchUpObservations
      .filter((observation) => observation.deferredDeadlineAt !== null)
      .sort((left, right) => (left.deferredDeadlineAt ?? Number.MAX_SAFE_INTEGER) - (right.deferredDeadlineAt ?? Number.MAX_SAFE_INTEGER))[0];
    const nonFenceStop = catchUpObservations.find((observation) => observation.stopReason !== null && observation.stopReason !== "safe_window_fence");
    let followUp: SafeLaneFollowUp | undefined;
    let stopDeadlineAt: number | null = null;
    let stopReason: string | null = null;
    if (coverage?.kind !== "SETTLED") {
      const retryCount = (request?.retryCount ?? 0) + 1;
      stopDeadlineAt = Date.now() + safeLaneRetryDelayMs(retryCount);
      stopReason = `coverage_retry:${coverage?.reason ?? "not_settled"}`;
      followUp = {
        trigger: "coverage-retry",
        dueAt: stopDeadlineAt,
        retryCount,
        reason: stopReason,
        owner: deliveryOwner,
      };
    } else if (deferred?.deferredDeadlineAt !== null && deferred?.deferredDeadlineAt !== undefined) {
      stopDeadlineAt = deferred.deferredDeadlineAt;
      stopReason = "safe_window_fence";
      followUp = {
        trigger: "fence-expiry",
        dueAt: stopDeadlineAt,
        retryCount: 0,
        reason: stopReason,
        owner: deliveryOwner,
      };
    } else if (nonFenceStop !== undefined || catchUpOutcome !== "completed") {
      const retryCount = (request?.retryCount ?? 0) + 1;
      stopDeadlineAt = Date.now() + safeLaneRetryDelayMs(retryCount);
      stopReason = nonFenceStop?.stopReason ?? "catch_up_retry";
      followUp = {
        trigger: "coverage-retry",
        dueAt: stopDeadlineAt,
        retryCount,
        reason: stopReason,
        owner: deliveryOwner,
      };
    } else {
      stopReason = "advanced_or_caught_up";
    }
    const safeHeadsAfterJson = await bestEffortSafeLaneHeads(env, serviceId);
    await bestEffortSafeLanePassObservation(env, {
      serviceId,
      passId,
      trigger: effectiveTrigger,
      status: "completed",
      scheduledAt,
      startedAt,
      completedAt: Date.now(),
      coverage,
      safeHeadsBeforeJson,
      safeHeadsAfterJson,
      deliveryOwner,
      catchUpStartedAt,
      catchUpCompletedAt,
      catchUpOutcome,
      catchUpResultJson,
      catchUpError,
      stopDeadlineAt,
      stopReason,
    });
    if (followUp !== undefined) {
      try {
        await scheduleMeetingRoomSafeLaneFollowUp(env, serviceId, followUp);
      } catch (error) {
        console.warn("safe_lane_alarm", {
          status: "failed-to-schedule",
          serviceId,
          trigger: followUp.trigger,
          dueAt: followUp.dueAt,
          reason: followUp.reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    console.log("safe_lane_pass", {
      passId,
      scheduledAt,
      startedAt,
      completedAt: Date.now(),
      trigger: effectiveTrigger,
      status: "completed",
      serviceId,
      coverage: coverage.kind,
      reason: coverage.reason,
      frontierSuid: coverage.frontierSuid,
      stopDeadlineAt,
      stopReason,
      durationMs: Math.max(0, Date.now() - startedAt),
    });
  } catch (error) {
    await bestEffortSafeLanePassObservation(env, {
      serviceId,
      passId,
      trigger: effectiveTrigger,
      status: "failed",
      scheduledAt,
      startedAt,
      completedAt: Date.now(),
      coverage,
      safeHeadsBeforeJson,
      deliveryOwner,
      catchUpStartedAt,
      catchUpCompletedAt,
      catchUpOutcome,
      catchUpResultJson,
      catchUpError,
      stopDeadlineAt: Date.now() + safeLaneRetryDelayMs((request?.retryCount ?? 0) + 1),
      stopReason: "pass_failed",
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      await scheduleMeetingRoomSafeLaneFollowUp(env, serviceId, {
        trigger: "coverage-retry",
        dueAt: Date.now() + safeLaneRetryDelayMs((request?.retryCount ?? 0) + 1),
        retryCount: (request?.retryCount ?? 0) + 1,
        reason: "pass_failed",
        owner: deliveryOwner,
      });
    } catch (scheduleError) {
      console.warn("safe_lane_alarm", {
        status: "failed-to-schedule",
        serviceId,
        trigger: "coverage-retry",
        error: scheduleError instanceof Error ? scheduleError.message : String(scheduleError),
      });
    }
    console.warn("safe_lane_pass", {
      passId,
      scheduledAt,
      startedAt,
      trigger: effectiveTrigger,
      status: "failed",
      serviceId,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Math.max(0, Date.now() - startedAt),
    });
    throw error;
  }
}

/**
 * The existing service-scoped BOOTSTRAP object owns the one delayed safe-lane
 * alarm.  Keeping this state beside the existing coordinator avoids a new
 * Cloudflare resource/binding while giving fence expiry a durable trigger.
 * Normal bootstrap routes remain delegated unchanged to the runtime class.
 */
export class BootstrapCoordinatorDurableObject extends RuntimeBootstrapCoordinatorDurableObject {
  constructor(
    private readonly safeLaneContext: DurableObjectState,
    private readonly safeLaneEnvironment: MeetingRoomCloudflareEnv,
  ) {
    super(safeLaneContext, safeLaneEnvironment);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/safe-lane/schedule") {
      return this.scheduleSafeLaneAlarm(url, request);
    }
    return super.fetch(request);
  }

  async alarm(): Promise<void> {
    const pending = await this.safeLaneContext.storage.transaction(async (txn) => {
      const state = await txn.get<SafeLaneAlarmState>(SAFE_LANE_ALARM_KEY);
      if (state === undefined) return undefined;
      if (state.dueAt > Date.now()) {
        await txn.setAlarm(state.dueAt);
        return undefined;
      }
      await txn.delete(SAFE_LANE_ALARM_KEY);
      return state;
    });
    if (pending === undefined) return;

    const waiters: Promise<void>[] = [];
    scheduleMeetingRoomSafeLaneKick(
      this.safeLaneEnvironment,
      pending.serviceId,
      { waitUntil: (promise: Promise<void>) => { waiters.push(promise); } } as unknown as ExecutionContext,
      undefined,
      pending.owner,
      pending.trigger,
      pending.retryCount,
    );
    await Promise.all(waiters);
  }

  private async scheduleSafeLaneAlarm(url: URL, request: Request): Promise<Response> {
    const serviceId = url.searchParams.get("__serviceId");
    if (serviceId === null || serviceId.length === 0) return json({ code: "safe_lane_service_required" }, 400);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ code: "safe_lane_alarm_body_invalid" }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return json({ code: "safe_lane_alarm_body_invalid" }, 400);
    const input = body as Record<string, unknown>;
    const dueAt = typeof input.dueAt === "number" && Number.isSafeInteger(input.dueAt) && input.dueAt >= 0 ? input.dueAt : undefined;
    const trigger = input.trigger === "fence-expiry" || input.trigger === "coverage-retry" ? input.trigger : undefined;
    const retryCount = typeof input.retryCount === "number" && Number.isSafeInteger(input.retryCount) && input.retryCount >= 0 ? input.retryCount : 0;
    if (dueAt === undefined || trigger === undefined) return json({ code: "safe_lane_alarm_body_invalid" }, 400);
    const owner = typeof input.owner === "object" && input.owner !== null && !Array.isArray(input.owner)
      ? input.owner as SafeLaneKickOwner
      : undefined;
    const next: SafeLaneAlarmState = { serviceId, dueAt, trigger, retryCount, owner };
    const result = await this.safeLaneContext.storage.transaction(async (txn) => {
      const current = await txn.get<SafeLaneAlarmState>(SAFE_LANE_ALARM_KEY);
      if (current !== undefined && current.dueAt <= next.dueAt) {
        await txn.setAlarm(current.dueAt);
        return { coalesced: true, dueAt: current.dueAt, trigger: current.trigger };
      }
      await txn.put(SAFE_LANE_ALARM_KEY, next);
      await txn.setAlarm(next.dueAt);
      return { coalesced: false, dueAt: next.dueAt, trigger: next.trigger };
    });
    return json(result, 202);
  }
}

/**
 * Queue recordDelivery has committed before this function is reached. The
 * only synchronous work here is registering the promise with waitUntil; the
 * Queue handler's acknowledgement/retry decision is never held by coverage
 * or materialized-view D1 work. The cron remains the recovery backstop.
 */
export function scheduleMeetingRoomSafeLaneKick(
  env: MeetingRoomCloudflareEnv,
  serviceId: string,
  ctx: ExecutionContext,
  pass: (env: MeetingRoomCloudflareEnv, serviceId: string, request?: SafeLaneKickRequest) => Promise<void> = (passEnv, passServiceId, request) => runMeetingRoomSafeLanePass(passEnv, passServiceId, "kick", undefined, request),
  owner?: SafeLaneKickOwner,
  trigger: SafeLanePassTrigger = owner === undefined ? "kick" : "delivery",
  retryCount = 0,
): void {
  let scheduler = safeLaneKickSchedulers.get(serviceId);
  if (scheduler === undefined) {
    scheduler = createSafeLaneKickScheduler(
      (request) => {
        // The runner is selected by the request, not by the first trigger
        // that created the single-flight state.  This keeps a delivery's
        // fresh reconciliation from inheriting a cron callback's captured
        // coverage when it coalesces behind an active cron pass.
        if (request.runPass === undefined) {
          return Promise.reject(new Error("safe_lane_pass_runner_missing"));
        }
        return request.runPass(request);
      },
      () => {
        if (safeLaneKickSchedulers.get(serviceId) === scheduler) safeLaneKickSchedulers.delete(serviceId);
      },
      (request) => {
        ctx.waitUntil(bestEffortSafeLanePassObservation(env, {
          serviceId,
          passId: request.passId,
          trigger: request.trigger ?? "kick",
          status: "coalesced",
          scheduledAt: request.scheduledAt,
          deliveryOwner: request.owner,
        }));
      },
    );
    safeLaneKickSchedulers.set(serviceId, scheduler);
  }
  const scheduledAt = Date.now();
  const request: SafeLaneKickRequest = {
    passId: `${trigger}:${String(scheduledAt)}:${crypto.randomUUID()}`,
    scheduledAt,
    trigger,
    retryCount,
    owner,
    // Keep the callback on the in-memory request so every coalesced trigger
    // retains its own coverage context. The durable observer receives only
    // the serializable request fields above.
    runPass: (runRequest) => pass(env, serviceId, runRequest),
  };
  // Defer even the observer write and scheduler invocation until after the
  // Queue callback has registered waitUntil. This keeps Queue acknowledgement
  // and the public commit response independent from safe-lane D1 work.
  const scheduled = Promise.resolve().then(async () => {
    await bestEffortSafeLanePassObservation(env, {
      serviceId,
      passId: request.passId,
      trigger: request.trigger ?? "kick",
      status: "scheduled",
      scheduledAt: request.scheduledAt,
      deliveryOwner: request.owner,
    });
    return scheduler!(request);
  });
  ctx.waitUntil(scheduled.catch((error) => {
    // Cron will retry a lost kick. Keep the failure visible without changing
    // the already-completed Queue disposition.
    console.warn("safe_lane_kick", {
      status: "failed",
      passId: request.passId,
      serviceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }));
}


const runtime = createCloudflareOnlyRuntimeWorker({
  domain: meetingRoomDomain,
  config: meetingRoomRuntimeConfig,
  afterBootstrapVerify: async ({ serviceId, env }) => {
    await catchUpMeetingRoomMaterializedViews(env, serviceId);
  },
  deliveryViews: ({ env, ctx }) => meetingRoomDeliveryViews(
    env,
    env.TAG === undefined ? undefined : createG60DurableHopObserver(env.D1, (promise) => ctx.waitUntil(promise)),
  ),
  beforeLiveProjectionPoll: async ({ env, serviceId, ctx }) => {
    // Unit-only D1 fixtures intentionally omit the Tag authority. Preserve
    // their original unrestricted local catch-up seam; deployed primaries
    // always bind TAG and take the fresh-reconcile path below.
    if (env.TAG === undefined) {
      await runMeetingRoomScheduledMaintenance({
        catchUp: async (frontierSuid) => {
          await catchUpMeetingRoomMaterializedViews(env, serviceId, frontierSuid);
        },
        drainUnsafeKicks: (frontierSuid) => drainMeetingRoomUnsafeKicks(env, Date.now(), frontierSuid),
        runGenericScheduledWork: async () => {},
      });
      return { frontierSuid: undefined };
    }
    const coverage = await new GlobalCompletenessReconciler(env.D1, env.TAG).coverage(serviceId, Date.now());
    // Cron is the backstop, but it must enter the same per-service
    // single-flight/coalescing scheduler as Queue and fence-expiry triggers.
    // The scan result is captured so this scheduled pass uses the same
    // coverage decision that the runtime just computed.
    scheduleMeetingRoomSafeLaneKick(
      env as MeetingRoomCloudflareEnv,
      serviceId,
      ctx,
      (passEnv, passServiceId, request) => runMeetingRoomSafeLanePass(passEnv, passServiceId, "cron", coverage, request),
      undefined,
      "cron",
    );
    return { frontierSuid: coverage.frontierSuid };
  },
  afterStoredQueueDelivery: ({ message, env, ctx }) => {
    // Receiver-only G25 fixtures intentionally omit the source authority;
    // they keep their existing transport-only behavior and cron is not
    // meaningful there.
    if (env.D1 === undefined || env.TAG === undefined || env.D1_MV === undefined) return;
    scheduleMeetingRoomSafeLaneKick(env as MeetingRoomCloudflareEnv, message.serviceId, ctx, undefined, {
      eventId: message.eventId,
      suid: message.suid,
      attemptId: message.attemptId,
      partitionTag: message.tag,
      obligationSequence: message.completeness.obligationSequence,
    });
  },
  liveProjectionPollObserver: {
    onAttempt: ({ env, serviceId, projectorIds, attemptedAt }) =>
      recordMeetingRoomLivePollAttempt(env, serviceId, projectorIds, attemptedAt),
    onOutcome: ({ env, ...observation }) => recordMeetingRoomLivePollOutcome(env, observation),
  },
});
const runtimeFetch = runtime.fetch as unknown as (request: Request, env: MeetingRoomCloudflareEnv, ctx: ExecutionContext) => Promise<Response>;

// P1 is deliberately the smallest possible custom-span control: one span,
// one application attribute, at the public Worker fetch boundary. It is not a
// commit trace row and does not participate in any request or response data.
const G51_P1_PROBE_SPAN = "sdt.g51.probe.p1";
const G51_PROBE_ATTRIBUTE = "sdt.g51.probe";

/**
 * Safe MV convergence runs from an already-computed coverage decision. The
 * freshCoverage seam is used by the deployed Worker after the current G44
 * reconciliation; the older globalCoverage seam remains for unit-only callers
 * that supply a persisted decision directly.
 */
export async function runMeetingRoomScheduledMaintenance(input: {
  readonly catchUp: (frontierSuid?: string | null) => Promise<void>;
  readonly drainUnsafeKicks: (frontierSuid?: string | null) => Promise<void>;
  readonly runGenericScheduledWork: () => Promise<void>;
  /**
   * G44's one interim coverage decision.  It is intentionally an internal
   * gate rather than a new public query-response policy.
  */
  readonly globalCoverage?: () => Promise<"SETTLED" | "BLOCK/UNSETTLED" | GlobalCompletenessCoverage>;
  /** A fresh reconciliation result, computed before this safe-lane pass. */
  readonly freshCoverage?: () => Promise<GlobalCompletenessCoverage>;
  /** Records the decision that governed this scheduled safe-lane pass. */
  readonly recordCoverage?: (coverage: MeetingRoomSafeLaneCoverage) => Promise<void>;
}): Promise<void> {
  if (input.freshCoverage !== undefined) {
    const coverage = await input.freshCoverage();
    await input.recordCoverage?.({
      kind: coverage.kind,
      reason: coverage.reason,
      partitionTag: coverage.partitionTag,
      frontierSuid: coverage.frontierSuid,
      observedAt: coverage.observedAt,
    });
    // The caller has just completed this tick's scanner. A FULL/SETTLED
    // frontier is therefore immediately eligible; a BLOCK frontier is the
    // last proven cursor retained by the reconciler and remains fenced.
    await input.catchUp(coverage.frontierSuid);
    await input.drainUnsafeKicks(coverage.frontierSuid);
    await input.runGenericScheduledWork();
    return;
  }
  if (input.globalCoverage !== undefined) {
    const coverage = await input.globalCoverage();
    if (typeof coverage === "string") {
      // Compatibility for the original unit-only seam: a bare BLOCK decision
      // carries no durable FULL frontier, so it cannot safely advance any
      // source checkpoint. Deployed maintenance always supplies the richer
      // reconciler result below.
      if (coverage !== "SETTLED") {
        await input.runGenericScheduledWork();
        return;
      }
    } else {
      await input.recordCoverage?.({
        kind: coverage.kind,
        reason: coverage.reason,
        partitionTag: coverage.partitionTag,
        frontierSuid: coverage.frontierSuid,
        observedAt: coverage.observedAt,
      });
      // A BLOCK tick still drains work that a prior FULL scan proved
      // contiguous. `null` permits no source advancement; it is not an
      // unrestricted empty frontier.
      await input.catchUp(coverage.frontierSuid);
      await input.drainUnsafeKicks(coverage.frontierSuid);
      await input.runGenericScheduledWork();
      return;
    }
  }
  await input.catchUp();
  await input.drainUnsafeKicks();
  await input.runGenericScheduledWork();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Every sample path resolves deployment identity through the runtime seam. */
function serviceIdentity(env: MeetingRoomCloudflareEnv): string {
  return requireServiceIdentity(envServiceIdentity(env));
}

function optionalServiceIdentity(env: MeetingRoomCloudflareEnv): string | null {
  try {
    return serviceIdentity(env);
  } catch {
    return null;
  }
}

function resultBody(result: ExecuteResult): Record<string, unknown> {
  const body = { ...result } as Record<string, unknown>;
  delete body.cause;
  return body;
}

function resultResponse(result: ExecuteResult): Response {
  const body = resultBody(result);
  const admission = globalAdmissionStatusFromResult(result);
  let response: Response;
  switch (result.kind) {
    case "committed":
    case "noop":
      response = json(body, 200);
      break;
    case "rejected":
    case "invalid":
    case "conflict":
      response = json({ error: result.error ?? "Command was rejected", code: result.code ?? result.kind, ...body }, result.kind === "conflict" ? 409 : 400);
      break;
    case "partial":
      response = json({ error: result.error ?? "Commit was partial", code: result.code ?? "partial_write", ...body }, 500);
      break;
    case "timeout":
      response = json({ error: result.error ?? "Command outcome is undetermined", code: result.code ?? "timeout", ...body }, 504);
      break;
    case "unavailable":
      response = json({ error: result.error ?? "Projection is unavailable", code: result.code ?? "projection_unavailable", ...body }, 503);
      break;
    case "transport":
      response = json({ error: result.error ?? "Command transport failed", code: result.code ?? "transport", ...body }, 502);
      break;
  }
  response.headers.set("x-sdt-global-admission", admission === "admitted" || admission === "not-admitted" || admission === "unknown" ? admission : "unknown");
  return response;
}

function decodeProjectionPayload(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return value;
  }
}

function positiveInteger(value: string | null, name: string, fallback: number): number | Response {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return json({ error: `${name} must be a positive integer`, code: "validation_error" }, 400);
  return parsed;
}

type G42ProbeRouteInput =
  | Readonly<{ kind: "not-g42" }>
  | Readonly<{ kind: "invalid"; error: string }>
  | Readonly<{ kind: "valid"; value: G42JournalProbeRequest }>;

/**
 * This parser deliberately runs before the G32 fence only for G42's one
 * exact conformance endpoint.  It cannot touch a Durable Object; the fence
 * remains mandatory before a valid request is allowed to resolve JOURNAL.
 */
async function g42ProbeRouteInput(request: Request, url: URL): Promise<G42ProbeRouteInput> {
  if (url.pathname !== G42_JOURNAL_PROBE_PATH) return { kind: "not-g42" };
  if (request.method !== "POST") return { kind: "invalid", error: "G42 probe requires POST" };
  if (url.search.length !== 0) return { kind: "invalid", error: "G42 probe query must be empty" };
  if (request.headers.get("content-type") !== "application/json") {
    return { kind: "invalid", error: "G42 probe content-type must be application/json" };
  }
  let body: unknown;
  try {
    body = JSON.parse(await request.text()) as unknown;
  } catch {
    return { kind: "invalid", error: "G42 probe body must be JSON" };
  }
  const parsed = parseG42JournalProbeRequest(body);
  return "value" in parsed
    ? { kind: "valid", value: parsed.value }
    : { kind: "invalid", error: parsed.error };
}

function callerColo(request: Request): string | null {
  const cf = request.cf as unknown as { colo?: unknown } | undefined;
  return typeof cf?.colo === "string" && cf.colo.length > 0 ? cf.colo : null;
}

async function readProjection(request: Request, env: MeetingRoomCloudflareEnv, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "GET") return json({ error: "Projection routes require GET", code: "validation_error" }, 400);
  const url = new URL(request.url);
  const isRoom = url.pathname === "/api/read/room";
  const isReservation = url.pathname === "/api/read/reservation";
  if (!isRoom && !isReservation) return json({ error: "Projection route was not found", code: "not_found" }, 404);
  const parameter = isRoom ? "roomId" : "reservationId";
  const value = url.searchParams.get(parameter);
  if (value === null || value.length === 0) return json({ error: `${parameter} is required`, code: "validation_error" }, 400);
  const tag = isRoom ? roomTag(value) : reservationTag(value);
  const tagProjector = isRoom ? "RoomProjector" : "ReservationProjector";
  const response = await runtimeFetch(new Request("https://runtime.internal/api/sekiban/serialized/tag-state", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ tagStateId: `${tag.id}:${tagProjector}` }),
  }), env, ctx);
  let body: unknown;
  try { body = await response.json(); } catch { return json({ error: `Projection read returned HTTP ${response.status}`, code: "transport" }, 502); }
  if (response.status < 200 || response.status >= 300) return json(body, response.status);
  if (typeof body !== "object" || body === null || Array.isArray(body)) return json({ error: "Projection read returned an invalid body", code: "transport" }, 502);
  const record = body as Record<string, unknown>;
  if (typeof record.lastSortedUniqueId !== "string") return json({ error: "Projection read omitted lastSortedUniqueId", code: "transport" }, 502);
  return json({ projection: isRoom ? "room" : "reservation", [parameter]: value, tagStateId: `${tag.id}:${tagProjector}`, state: decodeProjectionPayload(record.payload), version: record.version, lastSortedUniqueId: record.lastSortedUniqueId });
}

async function readQuery(request: Request, env: MeetingRoomCloudflareEnv, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "GET") return json({ error: "Query routes require GET", code: "validation_error" }, 400);
  const url = new URL(request.url);
  const isReservations = url.pathname === "/api/read/reservations";
  const isRoomQuery = url.pathname === "/api/read/room-query";
  if (!isReservations && !isRoomQuery) return json({ error: "Query route was not found", code: "not_found" }, 404);
  let queryParams: Record<string, unknown>;
  let waitForSortableUniqueId: string | undefined;
  if (isReservations) {
    const pageNumber = positiveInteger(url.searchParams.get("pageNumber"), "pageNumber", 1);
    if (pageNumber instanceof Response) return pageNumber;
    const pageSize = positiveInteger(url.searchParams.get("pageSize"), "pageSize", 20);
    if (pageSize instanceof Response) return pageSize;
    const newestFirst = url.searchParams.get("newestFirst");
    if (newestFirst !== null && newestFirst !== "true" && newestFirst !== "false") return json({ error: "newestFirst must be true or false", code: "validation_error" }, 400);
    const requestedWait = url.searchParams.get("waitForSortableUniqueId");
    if (requestedWait !== null && requestedWait.length === 0) return json({ error: "waitForSortableUniqueId must be non-empty", code: "validation_error" }, 400);
    waitForSortableUniqueId = requestedWait ?? undefined;
    queryParams = { PageNumber: pageNumber, PageSize: pageSize, ...(newestFirst === "true" ? { NewestFirst: true } : {}) };
  } else {
    const roomId = url.searchParams.get("roomId");
    queryParams = roomId === null || roomId.length === 0 ? {} : { roomId };
  }
  const queryType = isReservations ? "GetReservationListQuery" : "GetRoomStateQuery";
  const runtimeTransport = createV1Transport({
    fetch: (input, init) => runtimeFetch(new Request(input, init), env, ctx),
  }, serviceIdentity(env));
  const executor = createSekibanExecutor(runtimeTransport, { serviceId: serviceIdentity(env) });
  try {
    if (isReservations) {
      const result = await executor.listQuery({
        queryType,
        queryParamsJson: JSON.stringify(queryParams),
        ...(waitForSortableUniqueId === undefined ? {} : { waitForSortableUniqueId }),
      }, { consistency: "unsafe" });
      return json(result);
    }
    const result = await executor.query({
      queryType,
      queryParamsJson: JSON.stringify(queryParams),
      ...(waitForSortableUniqueId === undefined ? {} : { waitForSortableUniqueId }),
    });
    return json(result);
  } catch (error) {
    if (error instanceof ClientError) return json({ error: error.message, code: error.code }, error.status ?? 502);
    return json({ error: "Query read failed", code: "transport" }, 502);
  }
}

async function command(request: Request, env: MeetingRoomCloudflareEnv, ctx: ExecutionContext): Promise<Response> {
  const componentReject = rejectUnlessPrimaryComponent(env, "command");
  if (componentReject !== undefined) return componentReject;
  try {
    await assertFinalCutoverFenceIfConfigured(env);
  } catch {
    return json({ error: "G32 cutover fence is unavailable", code: "g32_cutover_fence_invalid" }, 503);
  }
  if (request.method !== "POST") return json({ error: "Command route requires POST", code: "validation_error" }, 400);
  const commandId = new URL(request.url).pathname.slice("/api/commands/".length);
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "Command request must be JSON", code: "validation_error" }, 400); }
  let commandRequest: ReturnType<typeof parseMeetingRoomCommandRequest>;
  try {
    commandRequest = parseMeetingRoomCommandRequest(body);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Command executor options were invalid", code: "validation_error" }, 400);
  }
  // `runtimeFetch` is an in-isolate call, so its synthetic Request does not
  // inherit the public ingress CF-Ray.  Preserve that provider-owned identity
  // only for observation: CommitWorker uses it to emit the existing
  // post-admission worker observation, which is the exact join from a public
  // command response to its custom-span root.  It is neither a protocol input
  // nor a response/header mutation.
  const ingressRay = request.headers.get("cf-ray");
  const commandRuntime = {
    fetch: (inputValue: RequestInfo | URL, init?: RequestInit) =>
      runtimeFetch(runtimeRequestWithIngressRay(inputValue, init, ingressRay), env, ctx),
  };
  const result = await executeMeetingRoomCommand(commandId, commandRequest.input, {
    RUNTIME: commandRuntime,
    localRuntime: commandRuntime,
    serviceId: serviceIdentity(env),
  }, commandRequest.options);
  return resultResponse(result);
}

async function conformance(request: Request, env: MeetingRoomCloudflareEnv, ctx: ExecutionContext): Promise<Response> {
  const componentReject = rejectUnlessPrimaryComponent(env, "conformance");
  if (componentReject !== undefined) return componentReject;
  const supplied = request.headers.get("authorization");
  if (env.CONFORMANCE_TOKEN === undefined || supplied !== `Bearer ${env.CONFORMANCE_TOKEN}`) return json({ error: "Conformance authentication required", code: "unauthorized" }, 403);
  const url = new URL(request.url);
  const g42 = await g42ProbeRouteInput(request, url);
  if (g42.kind === "invalid") {
    // Exact method/path/query/content-type/schema validation deliberately
    // precedes both the cutover fence and Durable Object namespace lookup.
    return json({ error: g42.error, code: "g42_probe_validation_error" }, 400);
  }
  if (g42.kind === "valid") {
    try {
      await assertFinalCutoverFenceIfConfigured(env);
    } catch {
      return json({ error: "G32 cutover fence is unavailable", code: "g32_cutover_fence_invalid" }, 503);
    }
    try {
      const serviceId = serviceIdentity(env);
      if (g42.value.action === "trial") {
        return json(await runG42JournalProbeTrial(env.JOURNAL, serviceId, g42.value, callerColo(request)));
      }
      if (g42.value.action === "prepare") {
        return json(await prepareG42JournalProbeTrial(env.JOURNAL, serviceId, g42.value));
      }
      if (g42.value.action === "measure") {
        return json(await measureG42JournalProbeTrial(env.JOURNAL, serviceId, g42.value, callerColo(request)));
      }
      if (g42.value.action === "cleanup") {
        return json(await cleanupG42JournalProbeTrial(env.JOURNAL, serviceId, g42.value));
      }
      return json(await inventoryG42JournalProbeTrial(env.JOURNAL, serviceId, g42.value));
    } catch {
      // Conformance authentication grants diagnostic access but does not make
      // internal Journal error text part of a public/protocol response.
      return json({ error: "G42 Journal probe could not complete", code: "g42_probe_unavailable" }, 503);
    }
  }
  try {
    await assertFinalCutoverFenceIfConfigured(env);
  } catch {
    return json({ error: "G32 cutover fence is unavailable", code: "g32_cutover_fence_invalid" }, 503);
  }
  if (url.pathname === "/conformance/v1/g53-scope-mismatch") {
    const configured = serviceIdentity(env);
    const mismatchedServiceId = configured === "g53-mismatch" ? "g53-other" : "g53-mismatch";
    return runtimeFetch(new Request(`https://runtime.internal/bootstrap/${encodeURIComponent(mismatchedServiceId)}/state`), env, ctx);
  }
  if (url.pathname === "/conformance/v1/read-health") {
    if (request.method !== "GET") {
      return json({ error: "Read health requires GET", code: "validation_error" }, 405);
    }
    const configured = optionalServiceIdentity(env);
    if (configured === null) {
      return json({ error: "Read health bindings are unavailable", code: "projection_unavailable" }, 503);
    }
    try {
      return json(await readMeetingRoomHealth(env, configured));
    } catch {
      return json({ error: "Read health storage is unavailable", code: "projection_unavailable" }, 503);
    }
  }
  if (url.pathname === "/conformance/v1/internal/projection/lag") {
    // Keep the existing internal projection-lag semantics and storage
    // authority, but make the deployed proof bearer-gated like the G58
    // health surface. This does not create a public query policy.
    const target = new URL("https://runtime.internal/internal/projection/lag");
    target.search = url.search;
    return runtimeFetch(new Request(target.toString(), request), env, ctx);
  }
  if (url.pathname === "/conformance/v1/g26-config") {
    const config = readDirectDoorbellConfig(env as unknown as Record<string, unknown>, meetingRoomRuntimeConfig.deliveryClass, meetingRoomDeliveryPolicy);
    return json({
      task: "SDT-G26",
      viewCount: Number(env.G26_VIEW_COUNT ?? "2"),
      allowedViews: config.allowedViews,
      domainDeliveryClass: meetingRoomRuntimeConfig.deliveryClass,
      resolvedDeliveryClass: config.deliveryClass,
      domainViewDeliveryClasses: config.domainViewDeliveryClasses,
      directDoorbell: config.enabled,
      receiverMode: config.receiverMode,
      degradation: config.degradation,
      maxServiceBindingInvocations: config.maxServiceBindingInvocations,
    });
  }
  if (url.pathname === "/conformance/v1/g29-config") {
    const config = readDirectDoorbellConfig(env as unknown as Record<string, unknown>, meetingRoomRuntimeConfig.deliveryClass, meetingRoomDeliveryPolicy);
    return json({
      task: "SDT-G29",
      worker: "sekiban-dcb-meeting-room-cloudflare-only",
      sourceCommit: env.G29_SOURCE_COMMIT ?? null,
      serviceId: optionalServiceIdentity(env),
      viewCount: Number(env.G26_VIEW_COUNT ?? "2"),
      allowedViews: config.allowedViews,
      domainDeliveryClass: meetingRoomRuntimeConfig.deliveryClass,
      domainViewDeliveryClasses: config.domainViewDeliveryClasses,
      resolvedDeliveryClass: config.deliveryClass,
      directDoorbell: config.enabled,
      receiverMode: config.receiverMode,
      degradation: config.degradation,
      maxServiceBindingInvocations: config.maxServiceBindingInvocations,
      pipelineDatabaseId: "3c3b1641-7969-4d72-97a9-2ea65085c9bb",
      materializedViewDatabaseId: "5db45136-f1dd-4f4d-bfe3-b6328193a1ac",
      queue: "sekiban-dcb-meeting-room-cloudflare-outbox",
      generation: "v2",
    });
  }
  if (url.pathname === "/conformance/v1/g31-config") {
    const config = readDirectDoorbellConfig(env as unknown as Record<string, unknown>, meetingRoomRuntimeConfig.deliveryClass, meetingRoomDeliveryPolicy);
    return json({
      task: "SDT-G31",
      worker: "sekiban-dcb-meeting-room-cloudflare-only",
      sourceCommit: env.G31_SOURCE_COMMIT ?? null,
      serviceId: optionalServiceIdentity(env),
      pipelineDatabaseId: "3c3b1641-7969-4d72-97a9-2ea65085c9bb",
      materializedViewDatabaseId: "5db45136-f1dd-4f4d-bfe3-b6328193a1ac",
      queue: "sekiban-dcb-meeting-room-cloudflare-outbox",
      generation: "v2",
      waitFor: {
        sourceTarget: "unique-indexed-point-read",
        activeReceipt: "generation-definition-bound",
        safeHead: "unique-source-required",
        maxPointReads: 254,
      },
      directDoorbell: config.enabled,
      allowedViews: config.allowedViews,
    });
  }
  if (url.pathname === "/conformance/v1/g32-config") {
    const config = readDirectDoorbellConfig(env as unknown as Record<string, unknown>, meetingRoomRuntimeConfig.deliveryClass, meetingRoomDeliveryPolicy);
    return json({
      task: "SDT-G32",
      phase: env.G32_CUTOVER_PHASE ?? null,
      sourceCommit: env.G32_SOURCE_COMMIT ?? null,
      worker: "sekiban-dcb-meeting-room-cloudflare-only",
      component: env.G32_COMPONENT ?? null,
      configDigest: env.G32_CONFIG_DIGEST ?? null,
      serviceId: optionalServiceIdentity(env),
      pipelineDatabaseId: env.G32_PIPELINE_DATABASE_ID ?? null,
      materializedViewDatabaseId: env.G32_MATERIALIZED_VIEW_DATABASE_ID ?? null,
      queue: env.G32_QUEUE_NAME ?? null,
      freezeRelease: env.G32_FREEZE_RELEASE ?? null,
      cutoverFenceFingerprint: env.G32_CUTOVER_FENCE_FINGERPRINT ?? null,
      sortableUniqueId: { digits: 30, format: "dotnet-ticks-19-plus-crypto-id-11", legacyUnsupported: true },
      eventRecord: { eventType: "eventPayloadName", payload: "utf8-json-byte-identical", id: "uuid-v7", tags: "family:value-emission-order" },
      directDoorbell: config.enabled,
      allowedViews: config.allowedViews,
      rawV1PublicStatus: 404,
    });
  }
  if (url.pathname === "/conformance/v1/g32-store-state") {
    if (env.D1 === undefined || env.D1_MV === undefined) {
      return json({ error: "G32 new-store bindings are unavailable", code: "g32_store_unavailable" }, 503);
    }
    const serviceId = optionalServiceIdentity(env);
    if (serviceId === null) {
      return json({ error: "G32 new-store bindings are unavailable", code: "g32_store_unavailable" }, 503);
    }
    const [events, ops, legacy, mvRows, mvReceipts] = await Promise.all([
      env.D1.prepare("SELECT COUNT(*) AS count FROM dcb_events WHERE \"ServiceId\" = ?").bind(serviceId).first<{ count: number }>(),
      env.D1.prepare("SELECT COUNT(*) AS count FROM dcb_event_ops WHERE \"ServiceId\" = ?").bind(serviceId).first<{ count: number }>(),
      env.D1.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'serialized_dcb_events'").first<{ name: string }>(),
      env.D1_MV.prepare("SELECT COUNT(*) AS count FROM mv_rows WHERE service_id = ?").bind(serviceId).first<{ count: number }>(),
      env.D1_MV.prepare("SELECT COUNT(*) AS count FROM mv_wait_receipts WHERE service_id = ?").bind(serviceId).first<{ count: number }>(),
    ]);
    return json({
      task: "SDT-G32",
      serviceId,
      eventCount: Number(events?.count ?? 0),
      eventOpsCount: Number(ops?.count ?? 0),
      materializedViewRowCount: Number(mvRows?.count ?? 0),
      materializedViewReceiptCount: Number(mvReceipts?.count ?? 0),
      legacySerializedEventTablePresent: legacy !== null,
    });
  }
  if (url.pathname === "/conformance/v1/g31-wait-state") {
    const suid = url.searchParams.get("suid");
    if (suid === null || suid.length === 0) {
      return json({ error: "suid is required", code: "validation_error" }, 400);
    }
    if (env.D1 === undefined || env.D1_MV === undefined) {
      return json({ error: "G31 wait-state bindings are unavailable", code: "projection_unavailable" }, 503);
    }
    // This authenticated diagnostic reads the same two point-lookup ports as
    // the list-query wait. It deliberately fixes the opted-in list view so a
    // witness cannot turn arbitrary request data into a storage selector.
    const source = new D1EventStore(env.D1);
    const views = new D1MaterializedViewStore(env.D1_MV);
    await Promise.all([source.initialize(), views.initialize()]);
    const serviceId = optionalServiceIdentity(env);
    if (serviceId === null) {
      return json({ error: "G31 wait-state bindings are unavailable", code: "projection_unavailable" }, 503);
    }
    const target = await source.readWaitForTarget(serviceId, suid);
    const state = await views.readWaitForState(serviceId, "ReservationProjector", {
      ...(target.kind === "stored" ? { eventId: target.eventId } : {}),
      suid,
    });
    return json({
      task: "SDT-G31",
      serviceId,
      viewId: "ReservationProjector",
      target,
      state,
    });
  }
  url.pathname = url.pathname.slice("/conformance/v1".length) || "/";
  const allowedRuntimePaths = new Set([
    "/api/sekiban/serialized/commit",
    "/api/sekiban/serialized/tag-latest-sortable",
    "/api/sekiban/serialized/tag-state",
    "/api/sekiban/serialized/query",
    "/api/sekiban/serialized/list-query",
  ]);
  if (!allowedRuntimePaths.has(url.pathname)) {
    return json({ error: "Conformance route is not allowlisted", code: "conformance_route_not_allowed" }, 404);
  }
  return runtimeFetch(new Request(url.toString(), request), { ...env, G11_VERIFICATION_ENABLED: "true" }, ctx);
}

async function bootstrapOperator(request: Request, env: MeetingRoomCloudflareEnv, ctx: ExecutionContext): Promise<Response> {
  const componentReject = rejectUnlessPrimaryComponent(env, "bootstrap-operator");
  if (componentReject !== undefined) return componentReject;
  try {
    await assertFinalCutoverFenceIfConfigured(env);
  } catch {
    return json({ error: "G32 cutover fence is unavailable", code: "g32_cutover_fence_invalid" }, 503);
  }
  const url = new URL(request.url); const headers = new Headers(); const authorization = request.headers.get("authorization");
  if (authorization !== null) headers.set("authorization", authorization);
  if (request.method !== "GET") headers.set("content-type", "application/json");
  return runtimeFetch(new Request(`https://runtime.internal${url.pathname}`, request.method === "GET" ? { method: "GET", headers } : { method: request.method, headers, body: await request.text() }), env, ctx);
}

async function repairOperator(request: Request, env: MeetingRoomCloudflareEnv, ctx: ExecutionContext): Promise<Response> {
  const componentReject = rejectUnlessPrimaryComponent(env, "repair-operator");
  if (componentReject !== undefined) return componentReject;
  try {
    await assertFinalCutoverFenceIfConfigured(env);
  } catch {
    return json({ error: "G32 cutover fence is unavailable", code: "g32_cutover_fence_invalid" }, 503);
  }
  const headers = new Headers();
  const authorization = request.headers.get("authorization");
  if (authorization !== null) headers.set("authorization", authorization);
  if (request.method !== "GET") headers.set("content-type", "application/json");
  return runtimeFetch(new Request("https://runtime.internal/operator/repair", request.method === "GET" ? { method: "GET", headers } : { method: request.method, headers, body: await request.text() }), env, ctx);
}

const worker: ExportedHandler<MeetingRoomCloudflareEnv> = {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/conformance/v1" || path.startsWith("/conformance/v1/")) return conformance(request, env, ctx);
    if (path.startsWith("/operator/bootstrap/")) return bootstrapOperator(request, env, ctx);
    if (path === "/operator/repair") return repairOperator(request, env, ctx);
    if (path.startsWith("/api/commands/")) {
      const componentReject = rejectUnlessPrimaryComponent(env, "command");
      if (componentReject !== undefined) return componentReject;
      return ctx.tracing.enterSpan(G51_P1_PROBE_SPAN, (span) => {
        span.setAttribute(G51_PROBE_ATTRIBUTE, "p1");
        return command(request, env, ctx);
      });
    }
    try {
      await assertFinalCutoverFenceIfConfigured(env);
    } catch {
      return json({ error: "G32 cutover fence is unavailable", code: "g32_cutover_fence_invalid" }, 503);
    }
    if (path === "/api/sekiban/serialized" || path.startsWith("/api/sekiban/serialized/")) return json({ error: "Raw V1 routes are available only through the authenticated conformance lane", code: "not_found" }, 404);
    if (path === "/api/read/room" || path === "/api/read/reservation") return readProjection(request, env, ctx);
    if (path === "/api/read/reservations" || path === "/api/read/room-query") return readQuery(request, env, ctx);
    if (env.ASSETS !== undefined) return env.ASSETS.fetch(request);
    if (path === "/" || path === "/index.html") return new Response("Meeting-room sample", { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response("Not found", { status: 404 });
  },
  async queue(batch, env, ctx) {
    await assertFinalCutoverFenceIfConfigured(env);
    await runtime.queue?.(batch, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    await assertFinalCutoverFenceIfConfigured(env);
    // The runtime reconciles G44 first, then invokes the sample's safe-lane
    // hook with that fresh coverage, and finally polls live projections in the
    // same scheduled tick. Keeping this call direct avoids an extra stale
    // frontier pass before the fresh reconciliation.
    await runtime.scheduled?.(controller, env, ctx);
  },
};

export default worker;
