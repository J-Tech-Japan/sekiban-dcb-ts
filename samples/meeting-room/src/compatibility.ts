export type CompatibilityLane =
  | "old-client-new-runtime"
  | "new-client-old-runtime"
  | "old-history-new-replay"
  | "new-history-old-replay"
  | "downgrade-replay";

export type CompatibilityOutcome = "accepted" | "typed-rejected";

export const LEGACY_MIGRATION_MARKER = "sekiban-dcb-pre-g27-migration-v1";

export function compatibilityOutcome(lane: CompatibilityLane): CompatibilityOutcome {
  return lane === "new-client-old-runtime" ? "typed-rejected" : "accepted";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Storage is fail-closed unless G27 identity or an immutable legacy marker is present. */
export function assertStoredIdentity(value: unknown): void {
  if (!isRecord(value)) throw new Error("G29_STORAGE_IDENTITY_MISSING");
  const eventType = value.eventType;
  const provenance = value.provenance;
  const marker = value.legacyMigrationMarker;
  if (typeof eventType === "string" && eventType.length > 0 && provenance === "g27") return;
  if (provenance === "pre-g27" && marker === LEGACY_MIGRATION_MARKER) return;
  throw new Error("G29_STORAGE_IDENTITY_MISSING");
}

export function compatibilityLaneIds(): readonly CompatibilityLane[] {
  return Object.freeze([
    "old-client-new-runtime",
    "new-client-old-runtime",
    "old-history-new-replay",
    "new-history-old-replay",
    "downgrade-replay",
  ]);
}
