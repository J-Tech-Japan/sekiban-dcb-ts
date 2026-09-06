/**
 * One-isolate coalescing for event-driven safe-lane passes.
 *
 * A delivery that arrives while a pass is running marks the pass for one
 * follow-up instead of starting a concurrent catch-up. The follow-up is
 * important: a pass may begin before a later recordDelivery commits, so a
 * bare "already running" return would lose that kick. The caller owns the
 * waitUntil boundary; this helper only provides the single-flight promise.
 */
export function createSafeLaneKickScheduler(
  pass: (request: SafeLaneKickRequest) => Promise<void>,
  onIdle?: () => void,
  onCoalesced?: (request: SafeLaneKickRequest) => void,
): (request: SafeLaneKickRequest) => Promise<void> {
  let active: {
    rerun: boolean;
    pendingRequest: SafeLaneKickRequest;
    promise: Promise<void>;
  } | undefined;

  return (request) => {
    if (active !== undefined) {
      active.rerun = true;
      // The next pass must be attributed to the latest committed delivery,
      // not to the request that happened to start the already-running pass.
      // This remains one-flight: only the request identity changes.
      active.pendingRequest = request;
      onCoalesced?.(request);
      return active.promise;
    }

    const state = {
      rerun: false,
      pendingRequest: request,
      promise: undefined as unknown as Promise<void>,
    };
    state.promise = (async () => {
      do {
        state.rerun = false;
        const runRequest = state.pendingRequest;
        await pass(runRequest);
      } while (state.rerun);
    })().finally(() => {
      if (active?.promise === state.promise) active = undefined;
      onIdle?.();
    });
    active = state;
    return state.promise;
  };
}

/** Identity for one requested kick, persisted independently of the runner. */
export interface SafeLaneKickRequest {
  readonly passId: string;
  readonly scheduledAt: number;
  readonly trigger?: SafeLanePassTrigger;
  readonly retryCount?: number;
  readonly owner?: SafeLaneKickOwner;
  /**
   * In-memory execution context only.  A coalesced request must carry the
   * pass implementation that produced its coverage context; otherwise a
   * delivery arriving behind a cron pass can accidentally execute the cron
   * callback and reuse its stale scan result.  This is never serialized into
   * the durable pass ledger.
   */
  readonly runPass?: (request: SafeLaneKickRequest) => Promise<void>;
}

/** Durable provenance for one safe-lane execution request. */
export type SafeLanePassTrigger = "kick" | "delivery" | "fence-expiry" | "coverage-retry" | "cron";

/** Source identity carried by a Queue delivery into pass attribution. */
export interface SafeLaneKickOwner {
  readonly eventId: string;
  readonly suid: string;
  readonly attemptId: string;
  readonly partitionTag: string;
  readonly obligationSequence: number | null;
}
