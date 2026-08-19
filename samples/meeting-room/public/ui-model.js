/* global TextEncoder */

// The browser decides projection visibility from V1's opaque ordinal only.
// This file is deliberately plain JavaScript: it is served as a static asset
// and is also imported by the focused Vitest oracle.
export const UI_SAFE_WINDOW_BOUND_MS = 120_000;

export function compareV1Ordinal(left, right) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

export function visibilityState({ commitSortableUniqueId, lastSortedUniqueId, startedAt, now }) {
  const elapsed = typeof startedAt === "number" && typeof now === "number" ? now - startedAt : undefined;
  if (elapsed !== undefined && elapsed > UI_SAFE_WINDOW_BOUND_MS) return "timeout";
  if (
    typeof commitSortableUniqueId === "string" &&
    typeof lastSortedUniqueId === "string" &&
    compareV1Ordinal(lastSortedUniqueId, commitSortableUniqueId) >= 0
  ) {
    return "visible";
  }
  if (elapsed !== undefined && elapsed >= UI_SAFE_WINDOW_BOUND_MS) {
    return "timeout";
  }
  return "pending";
}

export function commandOutcome(status, body) {
  const kind = body && typeof body.kind === "string" ? body.kind : undefined;
  const code = body && typeof body.code === "string" ? body.code : undefined;
  if (kind === "conflict" || status === 409 || code === "consistency_conflict") return "conflict";
  if (kind === "partial" || code === "partial_write") return "partial";
  if (kind === "rejected" || kind === "invalid" || (status >= 400 && status < 500)) return "rejected";
  if (kind === "timeout" || status === 504 || code === "timeout") return "timeout";
  if (kind === "unavailable" || status === 503 || code === "projection_unavailable") return "unavailable";
  if (kind === "transport" || status >= 500) return "transport";
  if (kind === "noop") return "noop";
  return status >= 200 && status < 300 ? "committed" : "rejected";
}
