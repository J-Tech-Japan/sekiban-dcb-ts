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

function parsedJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function readHeadFrom(body) {
  for (const key of ["lastSortedUniqueId", "lastSortableUniqueId", "readHead"]) {
    if (typeof body?.[key] === "string") return body[key];
  }
  return undefined;
}

function queryError(status, body) {
  return {
    kind: "error",
    status,
    code: typeof body?.code === "string" ? body.code : "transport",
    error: typeof body?.error === "string" ? body.error : `HTTP ${status}`,
  };
}

export function reservationListView(status, body) {
  if (status < 200 || status >= 300 || typeof body?.error === "string") {
    return queryError(status, body);
  }
  const items = parsedJson(body?.itemsJson ?? body?.items);
  if (!Array.isArray(items)) return queryError(502, { error: "Reservation list returned an invalid items array", code: "transport" });
  const rows = items.map((item) => ({
    reservationId: typeof item?.reservationId === "string" ? item.reservationId : "",
    roomId: typeof item?.roomId === "string" ? item.roomId : "",
    status: typeof item?.status === "string" ? item.status : "unknown",
    version: typeof item?.version === "number" ? item.version : 0,
  }));
  return {
    kind: rows.length === 0 ? "empty" : "ready",
    rows,
    readHead: readHeadFrom(body),
    continuation: body?.continuation,
    totalCount: typeof body?.totalCount === "number" ? body.totalCount : rows.length,
  };
}

export function roomQueryView(status, body) {
  if (status < 200 || status >= 300 || typeof body?.error === "string") {
    return queryError(status, body);
  }
  const result = parsedJson(body?.resultJson ?? body?.result ?? body);
  if (result === undefined) return queryError(502, { error: "Room query returned invalid resultJson", code: "transport" });
  return { kind: "ready", result, readHead: readHeadFrom(body) };
}
