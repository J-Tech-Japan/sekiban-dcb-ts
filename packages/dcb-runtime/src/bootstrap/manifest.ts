import type { BootstrapDump, BootstrapEventRecord, BootstrapManifest } from "./types";
import { assertCanonicalEventType } from "../eventIdentity";

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
  if (!nonEmpty(value.source.serviceId) || !(nonEmpty(value.source.lineageId) || value.source.lineageId === "unknown-legacy") || !nonEmpty(value.target.serviceId) || !nonEmpty(value.target.allocatorLineageId) || (typeof value.highWatermark !== "string" && value.highWatermark !== null) || typeof eventCount !== "number" || !Number.isSafeInteger(eventCount) || eventCount < 0 || !Object.entries(tagCounts).every(([tag, count]) => nonEmpty(tag) && typeof count === "number" && Number.isSafeInteger(count) && count >= 0)) throw new BootstrapManifestError("manifest_invalid", "manifest field is invalid");
  return value as unknown as BootstrapManifest;
}
function parseEvent(value: unknown): BootstrapEventRecord {
  if (!isObject(value)) throw new BootstrapManifestError("record_invalid", "event record must be an object");
  const allowed = ["eventId", "eventTags", "eventType", "payload", "provenance", "suid"]; if (Object.keys(value).some((key) => !allowed.includes(key)) || !nonEmpty(value.eventId) || !nonEmpty(value.suid) || typeof value.payload !== "string" || !Array.isArray(value.eventTags) || !value.eventTags.every(nonEmpty) || new Set(value.eventTags).size !== value.eventTags.length || (value.provenance !== undefined && !isObject(value.provenance)) || (value.eventType !== undefined && !nonEmpty(value.eventType))) throw new BootstrapManifestError("record_invalid", "event record is invalid");
  if (value.eventType !== undefined) {
    try { assertCanonicalEventType(value.eventType); } catch { throw new BootstrapManifestError("record_invalid", "eventType is not canonical"); }
    if (isObject(value.provenance) && value.provenance.origin !== undefined && value.provenance.origin !== "g27") throw new BootstrapManifestError("record_invalid", "canonical eventType requires g27 provenance");
  }
  if (isObject(value.provenance) && value.provenance.origin !== undefined && value.provenance.origin !== "pre-g27" && value.provenance.origin !== "g27") throw new BootstrapManifestError("record_invalid", "event provenance origin is invalid");
  return { eventId: value.eventId, suid: value.suid, payload: value.payload, eventTags: [...value.eventTags].sort(), ...(value.eventType === undefined ? {} : { eventType: value.eventType }), ...(value.provenance === undefined ? {} : { provenance: value.provenance as Record<string, string> }) };
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
