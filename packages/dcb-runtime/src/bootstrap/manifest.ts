import type { BootstrapDump, BootstrapEventRecord, BootstrapManifest } from "./types";
import { assertCanonicalEventType } from "../eventIdentity";
import { assertSortableUniqueId } from "../allocator/SortableUniqueId";
import { CANONICAL_UTC_TIMESTAMP_PATTERN, isRfc4122Uuid, serializedEventMetadata } from "../eventRecord";

export class BootstrapManifestError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

type ObjectValue = Record<string, unknown>;
const isObject = (value: unknown): value is ObjectValue => typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const exactKeys = (value: ObjectValue, keys: readonly string[], name: string): void => {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new BootstrapManifestError("unknown_or_missing_field", `${name} has unknown or missing fields`);
};
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};

/** A small deterministic digest for portable validation. It is deliberately not a security primitive. */
export function bootstrapDigest(value: unknown): string {
  let hash = 2166136261;
  for (const char of canonical(value)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function parseManifest(value: unknown): BootstrapManifest {
  if (!isObject(value)) throw new BootstrapManifestError("manifest_invalid", "manifest must be an object");
  exactKeys(value, ["canonicalization", "contentDigest", "eventCount", "format", "highWatermark", "source", "tagCounts", "target", "version"], "manifest");
  if (value.format !== "sekiban-dcb-bootstrap" || value.version !== 1 || value.canonicalization !== "utf8-json-sorted-keys-v1" || !nonEmpty(value.contentDigest) || !isObject(value.source) || !isObject(value.target) || !isObject(value.tagCounts)) throw new BootstrapManifestError("manifest_invalid", "manifest has an invalid format or version");
  exactKeys(value.source, ["lineageId", "serviceId"], "manifest.source"); exactKeys(value.target, ["allocatorLineageId", "serviceId"], "manifest.target");
  const eventCount = value.eventCount; const tagCounts = value.tagCounts;
  if (!nonEmpty(value.source.serviceId) || !nonEmpty(value.source.lineageId) || !nonEmpty(value.target.serviceId) || !nonEmpty(value.target.allocatorLineageId) || (typeof value.highWatermark !== "string" && value.highWatermark !== null) || typeof eventCount !== "number" || !Number.isSafeInteger(eventCount) || eventCount < 0 || !Object.entries(tagCounts).every(([tag, count]) => nonEmpty(tag) && typeof count === "number" && Number.isSafeInteger(count) && count >= 0)) throw new BootstrapManifestError("manifest_invalid", "manifest field is invalid");
  return value as unknown as BootstrapManifest;
}
function parseEvent(value: unknown): BootstrapEventRecord {
  if (!isObject(value)) throw new BootstrapManifestError("record_invalid", "event record must be an object");
  const allowed = ["causationId", "correlationId", "eventId", "eventTags", "eventType", "executedUser", "payload", "provenance", "suid", "timestamp"];
  if (Object.keys(value).some((key) => !allowed.includes(key)) || !nonEmpty(value.eventId) || !nonEmpty(value.suid) ||
    typeof value.payload !== "string" || !Array.isArray(value.eventTags) || !value.eventTags.every(nonEmpty) ||
    new Set(value.eventTags).size !== value.eventTags.length || !nonEmpty(value.eventType) ||
    !isObject(value.provenance) || value.provenance.origin !== "g32" || !nonEmpty(value.timestamp) ||
    ![value.causationId, value.correlationId, value.executedUser].every((metadata) => metadata === null || nonEmpty(metadata))) {
    throw new BootstrapManifestError("record_invalid", "event record is invalid");
  }
  try {
    assertSortableUniqueId(value.suid);
    // A C# import is permitted to contain any RFC 4122 Id. New commit
    // admission remains UUID v7; this parser is the migration boundary.
    if (!isRfc4122Uuid(value.eventId)) throw new Error("event id");
    assertCanonicalEventType(value.eventType);
    JSON.parse(value.payload);
  } catch {
    throw new BootstrapManifestError("record_invalid", "G32 record identity or payload is invalid");
  }
  if (!CANONICAL_UTC_TIMESTAMP_PATTERN.test(value.timestamp)) {
    throw new BootstrapManifestError("record_invalid", "record timestamp is not UTC");
  }
  const metadata = serializedEventMetadata(value.eventId);
  const nullableMetadata = value.causationId === null && value.correlationId === null && value.executedUser === null;
  const serializedMetadata = value.causationId === metadata.causationId && value.correlationId === metadata.correlationId && value.executedUser === metadata.executedUser;
  if (!nullableMetadata && !serializedMetadata) {
    throw new BootstrapManifestError("record_invalid", "record metadata must be all null or use the serialized C# constants");
  }
  return {
    eventId: value.eventId,
    suid: value.suid,
    payload: value.payload,
    // C# Tags preserve emission order; do not sort the durable record.
    eventTags: [...value.eventTags],
    eventType: value.eventType,
    provenance: { origin: "g32" },
    timestamp: value.timestamp,
    causationId: value.causationId as string | null,
    correlationId: value.correlationId as string | null,
    executedUser: value.executedUser as string | null,
  };
}

/** Parses and validates the complete dump before a coordinator can mutate a target. */
export function parseBootstrapDump(value: unknown): BootstrapDump {
  if (!isObject(value)) throw new BootstrapManifestError("dump_invalid", "dump must be an object");
  exactKeys(value, ["events", "manifest"], "dump"); if (!Array.isArray(value.events)) throw new BootstrapManifestError("dump_invalid", "events must be an array");
  const manifest = parseManifest(value.manifest); const events = value.events.map(parseEvent);
  if (events.length !== manifest.eventCount || new Set(events.map((event) => event.eventId)).size !== events.length || events.some((event, index) => index > 0 && events[index - 1]!.suid >= event.suid)) throw new BootstrapManifestError("record_order_or_duplicate", "event records must be unique and strictly SUID-ascending");
  const counts: Record<string, number> = {}; for (const event of events) for (const tag of event.eventTags) counts[tag] = (counts[tag] ?? 0) + 1;
  if (canonical(counts) !== canonical(manifest.tagCounts) || (events.at(-1)?.suid ?? null) !== manifest.highWatermark) throw new BootstrapManifestError("manifest_mismatch", "manifest counts or high watermark do not match records");
  if (bootstrapDigest({ manifest: { ...manifest, contentDigest: "" }, events }) !== manifest.contentDigest) throw new BootstrapManifestError("digest_mismatch", "dump content digest does not match");
  return { manifest, events };
}
