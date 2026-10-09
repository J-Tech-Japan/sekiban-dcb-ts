#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, openSync, readFileSync, closeSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "../../node_modules/postgres/cjs/src/index.js";

const INPUT_FORMAT = "sekiban-dcb-postgres-tag-rebuild-input";
const CORRECTION_FORMAT = "sekiban-dcb-postgres-tag-correction";
const RECEIPT_FORMAT = "sekiban-dcb-postgres-tag-rebuild-receipt";
const DIGEST_CONTRACT = "sekiban-dcb-ts/eventDigest/v2";
const LOCK_KEY = 1_274_121_274;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUID = /^[0-9]{30}$/;
const SHA = /^sha256:[0-9a-f]{64}$/;
const UTC = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{1,7})Z$/;
const encoder = new TextEncoder();

function fail(message) { throw new Error(`postgres-tags-rebuild: ${message}`); }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value) { return Object.keys(value); }
function sameKeys(value, expected, context) {
  if (!isObject(value)) fail(`${context} must be an object`);
  const actual = keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${context} has unknown or missing keys (received ${actual.join(",") || "<none>"}; expected ${wanted.join(",")})`);
  }
}
function nonEmptyString(value, context) { if (typeof value !== "string" || value.length === 0) fail(`${context} must be a non-empty string`); return value; }
function integer(value, context, { min = 0 } = {}) { if (!Number.isSafeInteger(value) || value < min) fail(`${context} must be a safe integer >= ${min}`); return value; }
function digest(value, context) { if (typeof value !== "string" || !SHA.test(value)) fail(`${context} must be sha256:<64 lowercase hex>`); return value; }
function byteCompare(a, b) { const left = encoder.encode(a); const right = encoder.encode(b); for (let i = 0; i < Math.min(left.length, right.length); i += 1) if (left[i] !== right[i]) return left[i] - right[i]; return left.length - right.length; }
function sha256(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

// This parser is intentionally a parsing boundary, rather than JSON.parse with a later check.
class JsonParser {
  constructor(text) { this.text = text; this.index = 0; }
  error(message) { fail(`invalid JSON: ${message} at byte ${this.index}`); }
  whitespace() { while (/[ \t\r\n]/.test(this.text[this.index] ?? "")) this.index += 1; }
  value() {
    this.whitespace();
    const c = this.text[this.index];
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"') return this.string();
    if (this.text.startsWith("true", this.index)) { this.index += 4; return true; }
    if (this.text.startsWith("false", this.index)) { this.index += 5; return false; }
    if (this.text.startsWith("null", this.index)) { this.index += 4; return null; }
    const match = /^-?(?:0|[1-9][0-9]*)/.exec(this.text.slice(this.index));
    if (match) { this.index += match[0].length; const number = Number(match[0]); if (!Number.isSafeInteger(number)) this.error("number is not a safe integer"); return number; }
    if (c === "-" || c === "." || /[0-9]/.test(c ?? "")) this.error("only safe integer numbers are accepted");
    this.error("unexpected token");
  }
  string() {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const c = this.text[this.index];
      if (c === "\\") { this.index += 2; continue; }
      if (c === '"') { this.index += 1; try { return JSON.parse(this.text.slice(start, this.index)); } catch { this.error("invalid string"); } }
      if (c < " ") this.error("control character in string");
      this.index += 1;
    }
    this.error("unterminated string");
  }
  array() { this.index += 1; const result = []; this.whitespace(); if (this.text[this.index] === "]") { this.index += 1; return result; } while (true) { result.push(this.value()); this.whitespace(); if (this.text[this.index] === "]") { this.index += 1; return result; } if (this.text[this.index] !== ",") this.error("expected comma"); this.index += 1; } }
  object() {
    this.index += 1; const result = Object.create(null); const seen = new Set(); this.whitespace();
    if (this.text[this.index] === "}") { this.index += 1; return result; }
    while (true) {
      this.whitespace(); if (this.text[this.index] !== '"') this.error("object key must be a string");
      const key = this.string(); if (seen.has(key)) this.error(`duplicate object key ${key}`); seen.add(key);
      this.whitespace(); if (this.text[this.index] !== ":") this.error("expected colon"); this.index += 1;
      result[key] = this.value(); this.whitespace();
      if (this.text[this.index] === "}") { this.index += 1; return result; }
      if (this.text[this.index] !== ",") this.error("expected comma"); this.index += 1;
    }
  }
  parse() { const result = this.value(); this.whitespace(); if (this.index !== this.text.length) this.error("trailing data"); return result; }
}

function parseJson(buffer, sourceName) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch { fail(`${sourceName} is not valid UTF-8`); }
  return { text, value: new JsonParser(text).parse() };
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isSafeInteger(value)) fail("canonical JSON only accepts safe integers"); return String(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort(byteCompare).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  fail("canonical JSON encountered a non-JSON value");
}

function canonicalTagSet(value, context) {
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === "string" && tag.length > 0)) fail(`${context} must contain non-empty strings`);
  const result = [...new Set(value)].sort(byteCompare);
  return result;
}
function recordTimestamp(value, context) {
  if (typeof value !== "string" || !UTC.test(value) || Number.isNaN(Date.parse(value))) fail(`${context} must be canonical UTC text`);
  return value;
}
function validateRecord(record, serviceId, index) {
  const context = `events[${index}].record`;
  sameKeys(record, ["serviceId", "id", "sortableUniqueId", "eventType", "payload", "tags", "timestamp", "causationId", "correlationId", "executedUser"], context);
  if (record.serviceId !== serviceId) fail(`${context}.serviceId differs from input serviceId`);
  if (typeof record.id !== "string" || !UUID.test(record.id)) fail(`${context}.id must be an RFC 4122 UUID`);
  if (typeof record.sortableUniqueId !== "string" || !SUID.test(record.sortableUniqueId)) fail(`${context}.sortableUniqueId must be 30 ASCII digits`);
  nonEmptyString(record.eventType, `${context}.eventType`); if (record.eventType.includes(":")) fail(`${context}.eventType must not contain ':'`);
  nonEmptyString(record.payload, `${context}.payload`); parseJson(encoder.encode(record.payload), `${context}.payload`);
  if (!Array.isArray(record.tags) || !record.tags.every((tag) => typeof tag === "string" && tag.length > 0)) fail(`${context}.tags must contain non-empty strings`);
  recordTimestamp(record.timestamp, `${context}.timestamp`);
  for (const field of ["causationId", "correlationId", "executedUser"]) if (record[field] !== null && typeof record[field] !== "string") fail(`${context}.${field} must be string or null`);
}
function lengthPrefix(length) { return Uint8Array.of((length >>> 24) & 255, (length >>> 16) & 255, (length >>> 8) & 255, length & 255); }
function concat(parts) { const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0)); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; }
function field(name, value, present = true) { const nameBytes = encoder.encode(name); const bytes = value ?? new Uint8Array(); return concat([Uint8Array.of(present ? 1 : 0), lengthPrefix(nameBytes.length), nameBytes, lengthPrefix(bytes.length), bytes]); }
function eventDigestBytes(record, digestInfo, declaredTagSet) {
  const tagBytes = concat(declaredTagSet.map((tag) => { const bytes = encoder.encode(tag); return concat([lengthPrefix(bytes.length), bytes]); }));
  const fields = [
    field("serviceId", encoder.encode(record.serviceId)), field("eventId", encoder.encode(record.id)), field("sortableUniqueId", encoder.encode(record.sortableUniqueId)),
    field("eventType", encoder.encode(record.eventType)), field("timestamp", encoder.encode(record.timestamp)),
    own(digestInfo, "allocatorLineageId") ? field("allocatorLineageId", encoder.encode(digestInfo.allocatorLineageId)) : field("allocatorLineageId", undefined, false),
    field("attemptId", encoder.encode(digestInfo.attemptId)), field("declaredTagSet", tagBytes), field("payload", encoder.encode(record.payload)),
  ];
  return concat([encoder.encode(DIGEST_CONTRACT), Uint8Array.of(0), ...fields]);
}
export function eventDigestForRecord(record, digestInfo, declaredTagSet) {
  const bytes = eventDigestBytes(record, digestInfo, canonicalTagSet(declaredTagSet, "declaredTagSet"));
  return { canonicalBytesBase64: Buffer.from(bytes).toString("base64"), eventDigest: createHash("sha256").update(bytes).digest("hex") };
}
function hex(bytes) { return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(""); }
function validateInputObject(input) {
  sameKeys(input, ["format", "version", "serviceId", "seal", "health", "summary", "events"], "input");
  if (input.format !== INPUT_FORMAT || input.version !== 1) fail("input format/version is not version 1");
  const serviceId = nonEmptyString(input.serviceId, "input.serviceId");
  sameKeys(input.seal, ["state", "canonicalization", "contentDigest", "sealedAtMs"], "input.seal");
  if (input.seal.state !== "SEALED" || input.seal.canonicalization !== "utf8-json-sorted-keys-v1") fail("input seal is not SEALED with the supported canonicalization");
  digest(input.seal.contentDigest, "input.seal.contentDigest"); integer(input.seal.sealedAtMs, "input.seal.sealedAtMs");
  sameKeys(input.health, ["status", "scannerVersion", "lastFullScanAtMs", "staleAfterMs", "openFindingCount", "lastSettledFrontierSuid", "coveredEventCount", "coveredMembershipCount"], "input.health");
  if (input.health.status !== "HEALTHY") fail(`input health status ${input.health.status} is not HEALTHY`);
  nonEmptyString(input.health.scannerVersion, "input.health.scannerVersion"); integer(input.health.lastFullScanAtMs, "input.health.lastFullScanAtMs"); integer(input.health.staleAfterMs, "input.health.staleAfterMs");
  integer(input.health.openFindingCount, "input.health.openFindingCount"); if (input.health.openFindingCount !== 0) fail("input health has open findings");
  if (input.health.lastSettledFrontierSuid !== null && (typeof input.health.lastSettledFrontierSuid !== "string" || !SUID.test(input.health.lastSettledFrontierSuid))) fail("input health frontier is invalid");
  integer(input.health.coveredEventCount, "input.health.coveredEventCount"); integer(input.health.coveredMembershipCount, "input.health.coveredMembershipCount");
  if (input.health.lastFullScanAtMs > input.seal.sealedAtMs || input.seal.sealedAtMs - input.health.lastFullScanAtMs > input.health.staleAfterMs) fail("input health evidence was stale at seal time");
  sameKeys(input.summary, ["eventCount", "declaredMembershipCount", "committedMembershipCount"], "input.summary");
  for (const key of ["eventCount", "declaredMembershipCount", "committedMembershipCount"]) integer(input.summary[key], `input.summary.${key}`);
  if (!Array.isArray(input.events)) fail("input.events must be an array");
  const ids = new Set(), suids = new Set(), allEvents = [], membership = [];
  let previousSuid = "";
  input.events.forEach((entry, index) => {
    sameKeys(entry, ["record", "digest", "declaredTagSet", "committedMembership"], `input.events[${index}]`);
    validateRecord(entry.record, serviceId, index);
    if (previousSuid && entry.record.sortableUniqueId <= previousSuid) fail("events must be strictly SUID ascending"); previousSuid = entry.record.sortableUniqueId;
    if (ids.has(entry.record.id)) fail(`duplicate event identity ${entry.record.id}`); ids.add(entry.record.id); if (suids.has(entry.record.sortableUniqueId)) fail(`duplicate SUID ${entry.record.sortableUniqueId}`); suids.add(entry.record.sortableUniqueId);
    sameKeys(entry.digest, ["contract", "attemptId", "canonicalBytesBase64", "eventDigest", "allocatorLineageId"].filter((key) => key !== "allocatorLineageId" || own(entry.digest, key)), `input.events[${index}].digest`);
    if (entry.digest.contract !== DIGEST_CONTRACT) fail(`input.events[${index}].digest.contract is invalid`); nonEmptyString(entry.digest.attemptId, `input.events[${index}].digest.attemptId`); nonEmptyString(entry.digest.canonicalBytesBase64, `input.events[${index}].digest.canonicalBytesBase64`);
    if (!/^[0-9a-f]{64}$/.test(entry.digest.eventDigest)) fail(`input.events[${index}].digest.eventDigest must be lowercase SHA-256 hex`); if (own(entry.digest, "allocatorLineageId") && (typeof entry.digest.allocatorLineageId !== "string" || entry.digest.allocatorLineageId.length === 0)) fail(`input.events[${index}].digest.allocatorLineageId must be a non-empty string when present`);
    let canonicalBytes; try { canonicalBytes = Uint8Array.from(Buffer.from(entry.digest.canonicalBytesBase64, "base64")); } catch { fail(`input.events[${index}].digest.canonicalBytesBase64 is invalid`); }
    if (Buffer.from(canonicalBytes).toString("base64") !== entry.digest.canonicalBytesBase64 || canonicalBytes.length === 0) fail(`input.events[${index}].digest.canonicalBytesBase64 is not valid base64`);
    const declared = canonicalTagSet(entry.declaredTagSet, `input.events[${index}].declaredTagSet`); if (canonicalJson(declared) !== canonicalJson(entry.declaredTagSet)) fail(`input.events[${index}].declaredTagSet is not its UTF-8 sorted unique set`); if (canonicalJson(declared) !== canonicalJson(canonicalTagSet(entry.record.tags, `input.events[${index}].record.tags`))) fail(`input.events[${index}] declaredTagSet differs from record.tags`);
    const committed = entry.committedMembership; if (!Array.isArray(committed) || committed.length === 0 || !committed.every((tag) => typeof tag === "string" && tag.length > 0)) fail(`input.events[${index}].committedMembership must be non-empty strings`);
    if (new Set(committed).size !== committed.length) fail(`input.events[${index}] has duplicate committed membership`); for (const tag of committed) if (!declared.includes(tag)) fail(`input.events[${index}] membership ${tag} is outside declaredTagSet`);
    const computedBytes = eventDigestBytes(entry.record, entry.digest, declared); if (Buffer.compare(Buffer.from(computedBytes), Buffer.from(canonicalBytes)) !== 0) fail(`input.events[${index}] canonical event bytes do not match the logical record`); if (hex(new Uint8Array(createHash("sha256").update(computedBytes).digest())) !== entry.digest.eventDigest) fail(`input.events[${index}] event digest does not match canonical bytes`);
    allEvents.push({ entry, declared, committed }); for (const tag of committed) membership.push({ event: entry, tag });
  });
  if (input.summary.eventCount !== input.events.length || input.summary.declaredMembershipCount !== input.events.reduce((n, e) => n + e.declaredTagSet.length, 0) || input.summary.committedMembershipCount !== membership.length) fail("input summary counts do not match events");
  if (input.health.coveredEventCount !== input.summary.eventCount || input.health.coveredMembershipCount !== input.summary.committedMembershipCount || input.health.lastSettledFrontierSuid !== (input.events.at(-1)?.record.sortableUniqueId ?? null)) fail("input health coverage does not match the sealed frontier");
  return { serviceId, events: allEvents, membership, input };
}
export function validateInput(buffer, sourceName = "input") {
  const fileSha256 = sha256(buffer); const parsed = parseJson(buffer, sourceName); const checked = validateInputObject(parsed.value);
  const unsigned = structuredClone(parsed.value); unsigned.seal.contentDigest = ""; const computed = sha256(encoder.encode(canonicalJson(unsigned))); if (computed !== checked.input.seal.contentDigest) fail(`input content digest mismatch: expected ${checked.input.seal.contentDigest}, computed ${computed}`);
  return { ...checked, fileSha256, contentDigest: computed, text: parsed.text, buffer };
}
function validateCorrection(buffer, inputState, suppliedDigest, sourceName = "correction") {
  const fileSha256 = sha256(buffer); if (suppliedDigest !== undefined && suppliedDigest !== fileSha256) fail(`correction file digest mismatch: expected ${suppliedDigest}, computed ${fileSha256}`);
  const parsed = parseJson(buffer, sourceName); const correction = parsed.value; sameKeys(correction, ["format", "version", "correctionId", "serviceId", "inputContentDigest", "reason", "addMembership"], "correction");
  if (correction.format !== CORRECTION_FORMAT || correction.version !== 1) fail("correction format/version is not version 1"); nonEmptyString(correction.correctionId, "correction.correctionId"); if (correction.serviceId !== inputState.serviceId) fail("correction serviceId differs from input"); if (correction.inputContentDigest !== inputState.contentDigest) fail("correction inputContentDigest differs from input"); nonEmptyString(correction.reason, "correction.reason"); if (!Array.isArray(correction.addMembership) || correction.addMembership.length === 0) fail("correction.addMembership must be non-empty");
  const seen = new Set(); const additions = [];
  for (const [index, addition] of correction.addMembership.entries()) { sameKeys(addition, ["eventId", "eventDigest", "tag"], `correction.addMembership[${index}]`); if (!UUID.test(addition.eventId) || !/^[0-9a-f]{64}$/.test(addition.eventDigest) || typeof addition.tag !== "string" || addition.tag.length === 0) fail(`correction.addMembership[${index}] is invalid`); const eventId = addition.eventId.toLowerCase(); const key = `${eventId}\u0000${addition.eventDigest}\u0000${addition.tag}`; if (seen.has(key)) fail(`correction has duplicate addition ${key}`); seen.add(key); const found = inputState.events.find(({ entry }) => entry.record.id.toLowerCase() === eventId); if (!found) fail(`correction names unknown event ${addition.eventId}`); if (found.entry.digest.eventDigest !== addition.eventDigest) fail(`correction digest does not match event ${addition.eventId}`); if (!found.declared.includes(addition.tag)) fail(`correction tag ${addition.tag} is not declared for ${addition.eventId}`); if (found.committed.includes(addition.tag)) fail(`correction tag ${addition.tag} is already committed for ${addition.eventId}`); additions.push({ event: found.entry, tag: addition.tag }); }
  return { correction, additions, fileSha256, text: parsed.text, buffer };
}
function sortedMembership(state, correctionState) { return [...state.membership, ...(correctionState?.additions ?? [])].sort((a, b) => a.event.record.sortableUniqueId.localeCompare(b.event.record.sortableUniqueId) || byteCompare(a.tag, b.tag) || byteCompare(a.event.record.id, b.event.record.id)); }
function eventById(state) { return new Map(state.events.map((item) => [item.entry.record.id.toLowerCase(), item])); }
function timestampMicros(text) { const match = UTC.exec(text); if (!match) fail(`invalid timestamp ${text}`); const milliseconds = Date.parse(`${match[1]}.${match[2].slice(0, 3).padEnd(3, "0")}Z`); return BigInt(milliseconds) * 1000n + BigInt(match[2].slice(3).padEnd(3, "0")); }
function normalizeDbTimestamp(value) { return String(value).replace(/\s+/, "T").replace(/\+00$/, "Z").replace(/\+00:00$/, "Z"); }
function logicalMatches(row, item) {
  const record = item.entry.record; if (String(row.id).toLowerCase() !== record.id.toLowerCase()) return `event identity (target ${row.id}, sealed ${record.id})`; if (row.service_id !== record.serviceId) return `serviceId (target ${row.service_id}, sealed ${record.serviceId})`; if (row.suid !== record.sortableUniqueId) return `sortableUniqueId (target ${row.suid}, sealed ${record.sortableUniqueId})`; if (row.event_type !== record.eventType) return `eventType (target ${row.event_type}, sealed ${record.eventType})`; if (row.payload !== record.payload) return `payload bytes (target ${JSON.stringify(row.payload)}, sealed ${JSON.stringify(record.payload)})`;
  let tags; try { tags = typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags; } catch { return `ordered declared tags (target ${row.tags})`; } if (canonicalJson(tags) !== canonicalJson(record.tags)) return `ordered declared tags (target ${canonicalJson(tags)}, sealed ${canonicalJson(record.tags)})`;
  if ((row.causation_id ?? null) !== record.causationId || (row.correlation_id ?? null) !== record.correlationId || (row.executed_user ?? null) !== record.executedUser) return `nullable event metadata (target ${JSON.stringify([row.causation_id, row.correlation_id, row.executed_user])}, sealed ${JSON.stringify([record.causationId, record.correlationId, record.executedUser])})`;
  if (timestampMicros(normalizeDbTimestamp(row.timestamp)) !== timestampMicros(record.timestamp)) return `timestamp instant (target ${row.timestamp}, sealed ${record.timestamp})`;
  return null;
}
async function schemaCheck(sql) {
  const expected = {
    dcb_events: { ServiceId: ["character varying", 64], Id: ["uuid"], SortableUniqueId: ["character varying", 100], EventType: ["text"], Payload: ["json"], Tags: ["jsonb"], Timestamp: ["timestamp with time zone"], CausationId: ["text"], CorrelationId: ["text"], ExecutedUser: ["text"] },
    dcb_tags: { Id: ["bigint"], ServiceId: ["character varying", 64], Tag: ["text"], TagGroup: ["text"], EventType: ["text"], SortableUniqueId: ["character varying", 100], EventId: ["uuid"], CreatedAt: ["timestamp with time zone"] },
  };
  for (const [table, columns] of Object.entries(expected)) {
    const rows = await sql`SELECT column_name, data_type, character_maximum_length FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table}`;
    const byName = new Map(rows.map((row) => [row.column_name, row])); for (const [name, type] of Object.entries(columns)) { const row = byName.get(name); if (!row || row.data_type !== type[0] || (type[1] !== undefined && row.character_maximum_length !== type[1])) fail(`target schema ${table}.${name} is missing or has the wrong type`); }
    if (byName.size !== Object.keys(columns).length) fail(`target schema ${table} has unexpected columns`);
  }
}
async function validateProvenanceSchema(sql) {
  const rows = await sql`SELECT column_name, data_type, character_maximum_length, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'dcb_tag_rebuild_provenance'`;
  const expected = { rebuild_id: ["text", null], service_id: ["character varying", 64], contract_version: ["integer", null], input_file_sha256: ["text", null], input_content_digest: ["text", null], correction_manifest_sha256: ["text", null], correction_manifest_json: ["text", null], applied_at: ["timestamp with time zone", null], receipt_sha256: ["text", null], receipt_json: ["text", null] };
  if (rows.length !== Object.keys(expected).length || rows.some((row) => expected[row.column_name]?.[0] !== row.data_type || (expected[row.column_name]?.[1] ?? null) !== (row.character_maximum_length ?? null))) fail("provenance table schema does not match version 1");
  const nullability = new Map(rows.map((row) => [row.column_name, row.is_nullable]));
  if (["rebuild_id", "service_id", "contract_version", "input_file_sha256", "input_content_digest", "applied_at", "receipt_sha256", "receipt_json"].some((name) => nullability.get(name) !== "NO") || nullability.get("correction_manifest_sha256") !== "YES" || nullability.get("correction_manifest_json") !== "YES") fail("provenance nullability does not match version 1");
  const constraints = await sql`SELECT contype, pg_get_constraintdef(pg_constraint.oid) AS definition FROM pg_constraint JOIN pg_class ON pg_class.oid = pg_constraint.conrelid JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace WHERE pg_namespace.nspname = 'public' AND pg_class.relname = 'dcb_tag_rebuild_provenance'`;
  const checks = constraints.filter((row) => row.contype === "c").map((row) => row.definition.toLowerCase());
  if (!constraints.some((row) => row.contype === "p" && /\(rebuild_id\)/i.test(row.definition)) || !constraints.some((row) => row.contype === "u" && /\(service_id\)/i.test(row.definition)) || !checks.some((definition) => definition.includes("contract_version") && definition.includes("1")) || !checks.some((definition) => definition.includes("input_file_sha256") && definition.includes("sha256")) || !checks.some((definition) => definition.includes("input_content_digest") && definition.includes("sha256")) || !checks.some((definition) => definition.includes("correction_manifest_sha256") && definition.includes("sha256")) || !checks.some((definition) => definition.includes("correction_manifest_sha256") && definition.includes("correction_manifest_json"))) fail("provenance table constraints do not match version 1");
}
async function targetEvents(sql, serviceId) { return sql`SELECT "ServiceId" AS service_id, "Id"::text AS id, "SortableUniqueId" AS suid, "EventType" AS event_type, "Payload"::text AS payload, "Tags"::text AS tags, to_char("Timestamp" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS timestamp, "CausationId" AS causation_id, "CorrelationId" AS correlation_id, "ExecutedUser" AS executed_user FROM dcb_events WHERE "ServiceId" = ${serviceId} ORDER BY "SortableUniqueId", "Id"`; }
async function targetTags(sql, serviceId) { return sql`SELECT t."ServiceId" AS service_id, t."Tag" AS tag, t."TagGroup" AS tag_group, t."EventType" AS event_type, t."SortableUniqueId" AS suid, t."EventId"::text AS event_id, to_char(t."CreatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at, e."Id"::text AS joined_event_id, e."ServiceId" AS joined_service_id FROM dcb_tags t LEFT JOIN dcb_events e ON e."ServiceId" = t."ServiceId" AND e."Id" = t."EventId" WHERE t."ServiceId" = ${serviceId} ORDER BY t."SortableUniqueId", t."Tag", t."EventId"`; }
function validateTargetEvents(rows, state) {
  if (rows.length !== state.events.length) fail(`target event count ${rows.length} differs from sealed count ${state.events.length}`);
  const map = eventById(state);
  const seen = new Set();
  for (const row of rows) {
    const id = String(row.id).toLowerCase();
    const item = map.get(id);
    if (!item || seen.has(id)) fail(`target event set differs at event ${row.id}`);
    const mismatch = logicalMatches(row, item);
    if (mismatch) fail(`target ${mismatch} mismatch for event ${row.id}`);
    seen.add(id);
  }
  if (seen.size !== map.size) fail("target event set is incomplete");
}
function setDigests(rows, state) {
  const byId = eventById(state); const events = [...state.events].map((item) => ({ eventId: item.entry.record.id, eventDigest: item.entry.digest.eventDigest })).sort((a, b) => byteCompare(a.eventId, b.eventId));
  const memberships = rows.map((row) => ({ eventId: row.event_id, eventDigest: byId.get(row.event_id.toLowerCase())?.entry.digest.eventDigest, tag: row.tag })).sort((a, b) => byteCompare(a.eventId, b.eventId) || byteCompare(a.eventDigest ?? "", b.eventDigest ?? "") || byteCompare(a.tag, b.tag));
  if (memberships.some((row) => row.eventDigest === undefined)) fail("observed membership has no validated event digest");
  return { eventSetDigest: sha256(encoder.encode(canonicalJson(events))), membershipSetDigest: sha256(encoder.encode(canonicalJson(memberships))) };
}
function validateTargetTags(rows, state, correctionState, appliedAt) {
  const expected = sortedMembership(state, correctionState); if (rows.length !== expected.length) fail(`target membership count ${rows.length} differs from expected ${expected.length}`); const used = new Set();
  for (const row of rows) { if (row.joined_event_id === null) fail(`orphan dcb_tags EventId ${row.event_id}`); const index = expected.findIndex((item, i) => !used.has(i) && item.event.record.id.toLowerCase() === row.event_id.toLowerCase() && item.tag === row.tag); if (index < 0) fail(`target membership differs at ${row.event_id}/${row.tag}`); used.add(index); const item = expected[index]; const record = item.event.record; if (row.service_id !== state.serviceId || row.tag_group !== (item.tag.split(":", 1)[0] || item.tag) || row.event_type !== record.eventType || row.suid !== record.sortableUniqueId || row.event_id.toLowerCase() !== record.id.toLowerCase()) fail(`target provider fields mismatch for ${row.event_id}/${row.tag}`); if (appliedAt !== undefined && timestampMicros(normalizeDbTimestamp(row.created_at)) !== timestampMicros(appliedAt)) fail(`target CreatedAt mismatch for ${row.event_id}/${row.tag}: target ${row.created_at}, appliedAt ${appliedAt}`); }
  if (used.size !== expected.length) fail("target membership set is incomplete"); return setDigests(rows, state);
}
function rebuildId(serviceId, inputFileSha256, correctionSha256) { return sha256(encoder.encode(canonicalJson({ contractVersion: 1, serviceId, inputFileSha256, correctionManifestSha256: correctionSha256 ?? null }))); }
function receiptBytes(state, correctionState, inputFileSha256, appliedAt, target, rebuild) {
  const input = state.input; const correction = correctionState ? { correctionId: correctionState.correction.correctionId, reason: correctionState.correction.reason, manifestSha256: correctionState.fileSha256, addedMembershipCount: correctionState.additions.length } : null;
  const value = { format: RECEIPT_FORMAT, version: 1, rebuildId: rebuild, serviceId: state.serviceId, contractVersion: 1, appliedAt, input: { fileSha256: inputFileSha256, contentDigest: state.contentDigest, sealedAtMs: input.seal.sealedAtMs, health: input.health, eventCount: input.summary.eventCount, declaredMembershipCount: input.summary.declaredMembershipCount, committedMembershipCount: input.summary.committedMembershipCount }, correction, target: { eventCount: state.events.length, membershipCount: target.membershipCount, eventSetDigest: target.eventSetDigest, membershipSetDigest: target.membershipSetDigest }, verification: { globalToTagToGlobal: "equal", payloadBytes: "equal", sealedEventDigestBinding: "matched-logical-record", membershipCount: "equal", membershipSet: "equal" } };
  return `${canonicalJson(value)}\n`;
}
function validateStoredReceipt(text, prior, state, correctionState, rebuild) {
  const parsed = parseJson(Buffer.from(text, "utf8"), "stored receipt").value;
  sameKeys(parsed, ["format", "version", "rebuildId", "serviceId", "contractVersion", "appliedAt", "input", "correction", "target", "verification"], "stored receipt");
  if (parsed.format !== RECEIPT_FORMAT || parsed.version !== 1 || parsed.rebuildId !== rebuild || parsed.serviceId !== state.serviceId || parsed.contractVersion !== 1) fail("stored receipt identity is invalid");
  if (typeof parsed.appliedAt !== "string" || timestampMicros(parsed.appliedAt) !== timestampMicros(normalizeDbTimestamp(prior.applied_at))) fail("stored receipt appliedAt differs from provenance");
  sameKeys(parsed.input, ["fileSha256", "contentDigest", "sealedAtMs", "health", "eventCount", "declaredMembershipCount", "committedMembershipCount"], "stored receipt.input");
  if (parsed.input.fileSha256 !== state.fileSha256 || parsed.input.contentDigest !== state.contentDigest || parsed.input.sealedAtMs !== state.input.seal.sealedAtMs || canonicalJson(parsed.input.health) !== canonicalJson(state.input.health) || parsed.input.eventCount !== state.input.summary.eventCount || parsed.input.declaredMembershipCount !== state.input.summary.declaredMembershipCount || parsed.input.committedMembershipCount !== state.input.summary.committedMembershipCount) fail("stored receipt input evidence differs");
  const expectedCorrection = correctionState ? { correctionId: correctionState.correction.correctionId, reason: correctionState.correction.reason, manifestSha256: correctionState.fileSha256, addedMembershipCount: correctionState.additions.length } : null;
  if (canonicalJson(parsed.correction) !== canonicalJson(expectedCorrection)) fail("stored receipt correction differs");
  sameKeys(parsed.target, ["eventCount", "membershipCount", "eventSetDigest", "membershipSetDigest"], "stored receipt.target");
  for (const key of ["eventSetDigest", "membershipSetDigest"]) digest(parsed.target[key], `stored receipt.target.${key}`);
  sameKeys(parsed.verification, ["globalToTagToGlobal", "payloadBytes", "sealedEventDigestBinding", "membershipCount", "membershipSet"], "stored receipt.verification");
  if (canonicalJson(parsed.verification) !== canonicalJson({ globalToTagToGlobal: "equal", payloadBytes: "equal", sealedEventDigestBinding: "matched-logical-record", membershipCount: "equal", membershipSet: "equal" })) fail("stored receipt verification is invalid");
  if (`${canonicalJson(parsed)}\n` !== text) fail("stored receipt is not canonical JSON");
  return parsed;
}
function writeReceipt(path, text) { const bytes = Buffer.from(text, "utf8"); if (existsSync(path)) { const existing = readFileSync(path); if (!existing.equals(bytes)) fail(`receipt path already contains different bytes: ${path}`); return; } let descriptor; try { descriptor = openSync(path, "wx"); writeSync(descriptor, bytes); } catch (error) { if (error.code === "EEXIST") { if (!readFileSync(path).equals(bytes)) fail(`receipt path already contains different bytes: ${path}`); return; } throw error; } finally { if (descriptor !== undefined) closeSync(descriptor); } }
function parseArgs(argv) { const options = { apply: false }; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === "--apply") options.apply = true; else if (["--input", "--input-sha256", "--receipt", "--correction-manifest", "--correction-sha256"].includes(arg)) { const value = argv[++i]; if (!value) fail(`${arg} requires a value`); options[arg.slice(2).replaceAll("-", "_")] = value; } else fail(`unknown argument ${arg}`); } if (!options.input) fail("--input is required"); if (options.apply && (!options.input_sha256 || !options.receipt)) fail("apply requires --input-sha256 and --receipt"); if (options.input_sha256 !== undefined) digest(options.input_sha256, "--input-sha256"); if (options.correction_sha256 !== undefined) digest(options.correction_sha256, "--correction-sha256"); if (options.correction_sha256 !== undefined && !options.correction_manifest) fail("--correction-sha256 requires --correction-manifest"); return options; }
async function inspectTarget(sql, state, correctionState, appliedAt) { const eventRows = await targetEvents(sql, state.serviceId); validateTargetEvents(eventRows, state); const tagRows = await targetTags(sql, state.serviceId); const target = validateTargetTags(tagRows, state, correctionState, appliedAt); return { eventCount: eventRows.length, membershipCount: tagRows.length, ...target }; }
async function apply(options, state, correctionState) {
  const receiptAlreadyExists = existsSync(options.receipt);
  const sql = postgres(process.env.POSTGRES_URL, { max: 1, fetch_types: false }); let receipt;
  try { await sql.begin("isolation level read committed", async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
    await transaction.unsafe(`CREATE TABLE IF NOT EXISTS dcb_tag_rebuild_provenance (rebuild_id TEXT PRIMARY KEY, service_id VARCHAR(64) NOT NULL UNIQUE, contract_version INTEGER NOT NULL CHECK (contract_version = 1), input_file_sha256 TEXT NOT NULL CHECK (input_file_sha256 ~ '^sha256:[0-9a-f]{64}$'), input_content_digest TEXT NOT NULL CHECK (input_content_digest ~ '^sha256:[0-9a-f]{64}$'), correction_manifest_sha256 TEXT NULL CHECK (correction_manifest_sha256 IS NULL OR correction_manifest_sha256 ~ '^sha256:[0-9a-f]{64}$'), correction_manifest_json TEXT NULL, applied_at TIMESTAMPTZ NOT NULL, receipt_sha256 TEXT NOT NULL CHECK (receipt_sha256 ~ '^sha256:[0-9a-f]{64}$'), receipt_json TEXT NOT NULL, CHECK ((correction_manifest_sha256 IS NULL) = (correction_manifest_json IS NULL)))`);
    await validateProvenanceSchema(transaction); const priorRows = await transaction`SELECT rebuild_id FROM dcb_tag_rebuild_provenance WHERE service_id = ${state.serviceId}`; if (priorRows.length > 1) fail(`multiple provenance rows exist for ${state.serviceId}`); const rebuild = rebuildId(state.serviceId, state.fileSha256, correctionState?.fileSha256);
    await transaction.unsafe('LOCK TABLE dcb_events IN SHARE ROW EXCLUSIVE MODE'); await transaction.unsafe('LOCK TABLE dcb_tags IN SHARE ROW EXCLUSIVE MODE');
    await schemaCheck(transaction); const observedEvents = await targetEvents(transaction, state.serviceId); validateTargetEvents(observedEvents, state); validateInput(state.buffer, "input"); if (correctionState) validateCorrection(correctionState.buffer, state, correctionState.fileSha256, "correction");
    const lockedPriorRows = await transaction`SELECT rebuild_id, service_id, contract_version, input_file_sha256, input_content_digest, correction_manifest_sha256, correction_manifest_json, to_char(applied_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS applied_at, receipt_sha256, receipt_json FROM dcb_tag_rebuild_provenance WHERE service_id = ${state.serviceId}`;
    if (lockedPriorRows.length > 1) fail(`multiple provenance rows exist for ${state.serviceId}`);
    if (lockedPriorRows.length === 1) {
      const prior = lockedPriorRows[0]; if (prior.rebuild_id !== rebuild || prior.input_file_sha256 !== state.fileSha256 || prior.input_content_digest !== state.contentDigest || (prior.correction_manifest_sha256 ?? null) !== (correctionState?.fileSha256 ?? null)) fail("prior provenance belongs to different input or correction bytes"); if ((prior.correction_manifest_json ?? null) !== (correctionState?.text ?? null)) fail("prior correction manifest text differs"); if (sha256(Buffer.from(prior.receipt_json, "utf8")) !== prior.receipt_sha256) fail("stored receipt digest is invalid"); const stored = validateStoredReceipt(prior.receipt_json, prior, state, correctionState, rebuild); const target = await inspectTarget(transaction, state, correctionState, stored.appliedAt); receipt = prior.receipt_json; if (target.eventSetDigest !== stored.target.eventSetDigest || target.membershipSetDigest !== stored.target.membershipSetDigest || target.eventCount !== stored.target.eventCount || target.membershipCount !== stored.target.membershipCount) fail("stored receipt target differs from the observed target"); return;
    }
    if (receiptAlreadyExists) fail(`receipt path already exists before first apply: ${options.receipt}`);
    const existingTags = await transaction`SELECT COUNT(*)::int AS count FROM dcb_tags WHERE "ServiceId" = ${state.serviceId}`; if (Number(existingTags[0].count) !== 0) fail("first apply requires zero target tag rows for the service");
    const appliedAtRow = await transaction`SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS applied_at`; const appliedAt = appliedAtRow[0].applied_at;
    const rows = sortedMembership(state, correctionState); for (const item of rows) { const record = item.event.record; await transaction`INSERT INTO dcb_tags ("ServiceId", "Tag", "TagGroup", "EventType", "SortableUniqueId", "EventId", "CreatedAt") VALUES (${state.serviceId}, ${item.tag}, ${item.tag.split(":", 1)[0] || item.tag}, ${record.eventType}, ${record.sortableUniqueId}, ${record.id}, transaction_timestamp())`; }
    const observed = await targetTags(transaction, state.serviceId); const target = validateTargetTags(observed, state, correctionState, appliedAt); const receiptText = receiptBytes(state, correctionState, state.fileSha256, appliedAt, { ...target, membershipCount: observed.length }, rebuild); const receiptSha256 = sha256(Buffer.from(receiptText, "utf8")); await transaction`INSERT INTO dcb_tag_rebuild_provenance (rebuild_id, service_id, contract_version, input_file_sha256, input_content_digest, correction_manifest_sha256, correction_manifest_json, applied_at, receipt_sha256, receipt_json) VALUES (${rebuild}, ${state.serviceId}, 1, ${state.fileSha256}, ${state.contentDigest}, ${correctionState?.fileSha256 ?? null}, ${correctionState?.text ?? null}, transaction_timestamp(), ${receiptSha256}, ${receiptText})`; receipt = receiptText;
  });
  } finally { await sql.end({ timeout: 5 }); }
  writeReceipt(options.receipt, receipt); return `mode=apply\nserviceId=${state.serviceId}\ninputFileSha256=${state.fileSha256}\ninputContentDigest=${state.contentDigest}\nreceiptSha256=${sha256(Buffer.from(receipt, "utf8"))}\nreceipt=${options.receipt}\n`;
}
async function dryRun(options, state, correctionState) {
  const sql = postgres(process.env.POSTGRES_URL, { max: 1, fetch_types: false }); try { await schemaCheck(sql); const eventRows = await targetEvents(sql, state.serviceId); validateTargetEvents(eventRows, state); const tagRows = await targetTags(sql, state.serviceId); if (tagRows.length > 0) validateTargetTags(tagRows, state, correctionState); const proposed = sortedMembership(state, correctionState); return `${canonicalJson({ format: "sekiban-dcb-postgres-tag-rebuild-dry-run", version: 1, serviceId: state.serviceId, input: { fileSha256: state.fileSha256, contentDigest: state.contentDigest }, correction: correctionState ? { manifestSha256: correctionState.fileSha256, correctionId: correctionState.correction.correctionId, additionCount: correctionState.additions.length } : null, target: { eventCount: eventRows.length, membershipCount: tagRows.length }, proposedMembership: proposed.map(({ event, tag }) => ({ eventId: event.record.id, tag })) })}\n`; } finally { await sql.end({ timeout: 5 }); }
}
export async function runCommand(argv) {
  const options = parseArgs(argv); const inputBuffer = readFileSync(resolve(options.input)); const state = validateInput(inputBuffer, options.input); if (options.apply && options.input_sha256 !== state.fileSha256) fail(`input file digest mismatch: expected ${options.input_sha256}, computed ${state.fileSha256}`); let correctionState;
  if (options.correction_manifest) { const correctionBuffer = readFileSync(resolve(options.correction_manifest)); correctionState = validateCorrection(correctionBuffer, state, options.correction_sha256, options.correction_manifest); if (options.apply && options.correction_sha256 === undefined) fail("apply with correction requires --correction-sha256"); }
  if (!process.env.POSTGRES_URL) fail("POSTGRES_URL is required"); return options.apply ? apply(options, state, correctionState) : dryRun(options, state, correctionState);
}
if (import.meta.url === `file://${process.argv[1]}`) runCommand(process.argv.slice(2)).then((output) => process.stdout.write(output)).catch((error) => { console.error(error.message); process.exitCode = 1; });
