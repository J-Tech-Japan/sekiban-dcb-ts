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
  pass: () => Promise<void>,
  onIdle?: () => void,
): () => Promise<void> {
  let active: { rerun: boolean; promise: Promise<void> } | undefined;

  return () => {
    if (active !== undefined) {
      active.rerun = true;
      return active.promise;
    }

    const state = { rerun: false, promise: undefined as unknown as Promise<void> };
    state.promise = (async () => {
      do {
        state.rerun = false;
        await pass();
      } while (state.rerun);
    })().finally(() => {
      if (active?.promise === state.promise) active = undefined;
      onIdle?.();
    });
    active = state;
    return state.promise;
  };
}
