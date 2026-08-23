/**
 * SDT-G32 bridge contract.
 *
 * This module deliberately has no dependency on the G32 event-record code.
 * Candidate B runs against the pre-cutover stores and does one thing only:
 * fence every writer while the replacement databases and service identity are
 * prepared.  The final candidate C owns the 30-digit/event-record change.
 */

export const G32_BRIDGE_COMPONENTS = Object.freeze(["primary", "receiver"] as const);
export type G32BridgeComponent = (typeof G32_BRIDGE_COMPONENTS)[number];

export const G32_BRIDGE_WRITER_ENTRYPOINTS = Object.freeze([
  Object.freeze({ id: "commit-http", component: "primary" }),
  Object.freeze({ id: "queue-consumer", component: "primary" }),
  Object.freeze({ id: "tag-do-outbox-alarm", component: "primary" }),
  Object.freeze({ id: "cron", component: "primary" }),
  Object.freeze({ id: "bootstrap-import-dump-restore", component: "primary" }),
  Object.freeze({ id: "mv-apply", component: "primary" }),
  Object.freeze({ id: "doorbell-receiver", component: "receiver" }),
] as const);

export interface G32BridgeIdentity {
  readonly sourceCommit: string;
  readonly configDigest: string;
  readonly tokenFingerprint: string;
  readonly component: G32BridgeComponent;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isCommit(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

export function parseG32BridgeComponent(value: unknown): G32BridgeComponent | undefined {
  return value === "primary" || value === "receiver" ? value : undefined;
}

/** A bridge acknowledgement is useful only when it is tied to all three seals. */
export function assertG32BridgeIdentity(value: unknown): asserts value is G32BridgeIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("G32_BRIDGE_IDENTITY_INVALID");
  const record = value as Record<string, unknown>;
  if (
    !isCommit(record.sourceCommit) ||
    !isSha256(record.configDigest) ||
    !isSha256(record.tokenFingerprint) ||
    parseG32BridgeComponent(record.component) === undefined
  ) throw new Error("G32_BRIDGE_IDENTITY_INVALID");
}

export function bridgeWriterEntrypoints(component: G32BridgeComponent): readonly string[] {
  return Object.freeze(G32_BRIDGE_WRITER_ENTRYPOINTS
    .filter((entry) => entry.component === component)
    .map((entry) => entry.id));
}

export function frozenBridgeResponse(component: string, entrypoint: string): Response {
  return new Response(JSON.stringify({
    error: "SDT-G32 bridge freeze is active",
    code: "g32_cutover_frozen",
    component,
    entrypoint,
  }), {
    status: 503,
    headers: { "content-type": "application/json; charset=utf-8", "retry-after": "60", "cache-control": "no-store" },
  });
}
