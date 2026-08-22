export type CompatibilityLane =
  | "old-to-old"
  | "old-to-new"
  | "new-to-new"
  | "new-to-old"
  | "upgrade-downgrade-replay";

export type CompatibilityOutcome = "accepted" | "typed-rejected";

export const LEGACY_MIGRATION_MARKER = "sekiban-dcb-pre-g27-migration-v1";

export function compatibilityOutcome(lane: CompatibilityLane): CompatibilityOutcome {
  return lane === "new-to-old" ? "typed-rejected" : "accepted";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The old V1 runtime has no canonical-identity storage lane.  New clients
 * therefore get a typed rejection instead of an identity-bearing request
 * being silently downgraded into a legacy row.
 */
export function oldRuntimeAdmission(value: unknown): CompatibilityOutcome {
  if (!isRecord(value) || !Array.isArray(value.eventCandidates)) return "typed-rejected";
  const identityBearing = value.eventCandidates.some((candidate) =>
    isRecord(candidate) && (Object.prototype.hasOwnProperty.call(candidate, "eventType") || Object.prototype.hasOwnProperty.call(candidate, "provenance") || Object.prototype.hasOwnProperty.call(candidate, "eventPayloadVersion")));
  return identityBearing ? "typed-rejected" : "accepted";
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

export interface CompatibilityReplayRecord {
  readonly eventId: string;
  readonly suid: string;
  readonly payload: unknown;
  readonly eventType?: string;
  readonly provenance?: "g27" | "pre-g27";
}

function payloadRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("G29_REPLAY_PAYLOAD_INVALID");
  return value;
}

function canonicalEventType(name: string): string {
  if (name.includes(":")) return name;
  return name + ":1";
}

/**
 * Old stored rows are replayed by the new runtime only after the immutable
 * migration marker has been supplied by the fixture. Canonical G27 rows use
 * their stored identity and never sniff payload fields.
 */
export function replayOldHistoryToNewRuntime(
  record: CompatibilityReplayRecord,
  legacyMigrationMarker?: string,
): { readonly kind: "accepted"; readonly eventType: string; readonly usedLegacyDiscriminator: boolean } {
  if (record.eventType !== undefined && record.provenance === "g27") {
    return Object.freeze({ kind: "accepted", eventType: record.eventType, usedLegacyDiscriminator: false });
  }
  if (record.provenance === "pre-g27" && legacyMigrationMarker === LEGACY_MIGRATION_MARKER) {
    const legacyName = payloadRecord(record.payload).eventType;
    if (typeof legacyName !== "string" || legacyName.length === 0) throw new Error("G29_STORAGE_IDENTITY_MISSING");
    return Object.freeze({ kind: "accepted", eventType: canonicalEventType(legacyName), usedLegacyDiscriminator: true });
  }
  throw new Error("G29_STORAGE_IDENTITY_MISSING");
}

/**
 * The old runtime compatibility shim consumes a canonical record by mapping
 * only its additive G27 identity to the old event name. It rejects a record
 * that would require payload sniffing without a canonical identity.
 */
export function replayNewHistoryToOldRuntime(
  record: CompatibilityReplayRecord,
): { readonly kind: "accepted"; readonly eventName: string; readonly legacyDiscriminator: string } {
  if (record.provenance !== "g27" || typeof record.eventType !== "string" || !record.eventType.includes(":")) {
    throw new Error("G29_OLD_RUNTIME_IDENTITY_REQUIRED");
  }
  const eventName = record.eventType.slice(0, record.eventType.lastIndexOf(":"));
  return Object.freeze({ kind: "accepted", eventName, legacyDiscriminator: eventName });
}

export function downgradeReplay(
  records: readonly CompatibilityReplayRecord[],
  legacyMigrationMarker: string,
): { readonly kind: "accepted"; readonly writes: 0; readonly eventTypes: readonly string[] } {
  const eventTypes = records.map((record) => replayOldHistoryToNewRuntime(record, legacyMigrationMarker).eventType);
  return Object.freeze({ kind: "accepted", writes: 0, eventTypes: Object.freeze(eventTypes) });
}

export function compatibilityLaneIds(): readonly CompatibilityLane[] {
  return Object.freeze([
    "old-to-old",
    "old-to-new",
    "new-to-new",
    "new-to-old",
    "upgrade-downgrade-replay",
  ]);
}
