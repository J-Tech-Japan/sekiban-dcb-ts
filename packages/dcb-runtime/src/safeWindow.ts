/** Published read-side SafeWindow bounds from the SDT-G11 ruling. */
export const PUBLISHED_SAFE_WINDOW_MS = 20_000;
export const MAX_PUBLISHED_SAFE_WINDOW_MS = 120_000;

/**
 * A lag sample is a current estimate, not a high-water mark.  The estimate
 * therefore loses one millisecond for every millisecond it has been idle and
 * never falls below the published floor.
 */
export function decayedLagEstimateMs(estimateMs: number, observedAtMs: number, nowMs: number): number {
  const elapsed = Math.max(0, nowMs - observedAtMs);
  return Math.max(0, estimateMs - elapsed);
}

/** Clamp a valid estimate to the wire-visible SafeWindow ceiling. */
export function safeWindowMs(dynamicLagBoundMs: number): number {
  return Math.min(MAX_PUBLISHED_SAFE_WINDOW_MS, Math.max(PUBLISHED_SAFE_WINDOW_MS, dynamicLagBoundMs));
}

export function safeWindowCeilingExceeded(dynamicLagBoundMs: number): boolean {
  return dynamicLagBoundMs > MAX_PUBLISHED_SAFE_WINDOW_MS;
}

/**
 * C# parity utility only: build the SafeWindow frontier in .NET ticks rather
 * than substituting the historical 5-second helper or a wall-clock string.
 * The minimum random suffix makes equality include every event at the cutoff
 * tick; callers compare only validated 30-digit SUIDs.
 */
export function safeWindowCutoffSuid(nowMs: number, dynamicLagBoundMs: number): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("SafeWindow now must be a non-negative safe integer");
  const cutoffMs = Math.max(0, nowMs - safeWindowMs(dynamicLagBoundMs));
  return formatSortableUniqueId(unixMsToDotNetTicks(cutoffMs), 0n);
}

export function isSortableUniqueIdSafeAt(
  suid: string,
  nowMs: number,
  dynamicLagBoundMs: number,
): boolean {
  assertSortableUniqueId(suid);
  return compareSortableUniqueId(suid, safeWindowCutoffSuid(nowMs, dynamicLagBoundMs)) <= 0;
}
import {
  assertSortableUniqueId,
  compareSortableUniqueId,
  formatSortableUniqueId,
  unixMsToDotNetTicks,
} from "./allocator/SortableUniqueId";
