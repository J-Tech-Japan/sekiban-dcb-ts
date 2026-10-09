#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import postgres from "../../node_modules/postgres/cjs/src/index.js";
import CONTRACT from "../../contracts/postgres-tag-rebuild.json" with { type: "json" };
const SCHEMAS = CONTRACT.schemas;
const INPUT_FORMAT = SCHEMAS.input.format;
const CORRECTION_FORMAT = SCHEMAS.correction.format;
const RECEIPT_FORMAT = SCHEMAS.receipt.format;
const CONTRACT_VERSION = CONTRACT.version;
const DIGEST_CONTRACT = "sekiban-dcb-ts/eventDigest/v2";
const LOCK_KEY = 1_274_121_274;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUID = /^[0-9]{30}$/;
const SHA = /^sha256:[0-9a-f]{64}$/;
const UTC = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{1,7})Z$/;
const encoder = new TextEncoder();
let receiptWriteHookForTests;
let receiptPublicationHooksForTests = {};

export function setReceiptWriteHookForTests(hook) {
  receiptWriteHookForTests = hook;
}

export function setReceiptPublicationHooksForTests(hooks) {
  receiptPublicationHooksForTests = hooks ?? {};
}

function fail(message) {
  throw new Error(`postgres-tags-rebuild: ${message}`);
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function contractKeys(schema) {
  return {
    required: schema.requiredKeys ?? schema.requiredColumns ?? [],
    optional: schema.optionalKeys ?? schema.optionalColumns ?? [],
  };
}

function validateContractObject(value, schema, context) {
  if (!isObject(value)) {
    fail(`${context} must be an object`);
  }
  const { required, optional } = contractKeys(schema);
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value).sort();
  const missing = required.filter((key) => !own(value, key));
  const unknown = actual.filter((key) => !allowed.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    fail(
      `${context} has unknown or missing keys (missing ${
        missing.join(",") || "<none>"
      }; unknown ${unknown.join(",") || "<none>"})`,
    );
  }
}

function contractTargets(value, path, context) {
  let targets = [value];
  for (const component of path.split(".")) {
    const isArray = component.endsWith("[]");
    const key = isArray ? component.slice(0, -2) : component;
    const next = [];
    for (const target of targets) {
      if (!isObject(target) || !own(target, key)) {
        fail(`${context}.${path} is missing`);
      }
      const child = target[key];
      if (isArray) {
        if (!Array.isArray(child)) {
          fail(`${context}.${path} must be an array`);
        }
        next.push(...child);
      } else {
        next.push(child);
      }
    }
    targets = next;
  }
  return targets;
}

function validateContractNode(value, schema, context) {
  if (value === null) {
    if (schema.nullable) {
      return;
    }
    fail(`${context} must not be null`);
  }
  validateContractObject(value, schema, context);
}

export function validateContractValue(
  value,
  schemaName,
  context = schemaName,
  contract = CONTRACT,
) {
  const schema = contract.schemas?.[schemaName];
  if (!schema) {
    fail(`contract schema ${schemaName} is missing`);
  }
  validateContractNode(value, schema, context);
  for (const [nestedPath, nestedSchema] of Object.entries(schema.nested ?? {})) {
    const targets = contractTargets(value, nestedPath, context);
    for (const [index, target] of targets.entries()) {
      validateContractNode(
        target,
        nestedSchema,
        `${context}.${nestedPath}${targets.length > 1 ? `[${index}]` : ""}`,
      );
    }
  }
  return value;
}

function sameSchemaKeys(value, schemaName, context, nestedName) {
  const schema = nestedName
    ? SCHEMAS[schemaName].nested[nestedName]
    : SCHEMAS[schemaName];
  if (!schema) {
    fail(`contract schema ${schemaName}${nestedName ? `.${nestedName}` : ""} is missing`);
  }
  validateContractNode(value, schema, context);
}

function nonEmptyString(value, context) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${context} must be a non-empty string`);
  }
  return value;
}

function integer(value, context, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) {
    fail(`${context} must be a safe integer >= ${min}`);
  }
  return value;
}

function digest(value, context) {
  if (typeof value !== "string" || !SHA.test(value)) {
    fail(`${context} must be sha256:<64 lowercase hex>`);
  }
  return value;
}

function byteCompare(left, right) {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const shared = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < shared; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] - rightBytes[index];
    }
  }
  return leftBytes.length - rightBytes.length;
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

// This parser is a parsing boundary, rather than JSON.parse with a later check.
class JsonParser {
  constructor(text) {
    this.text = text;
    this.index = 0;
  }

  error(message) {
    fail(`invalid JSON: ${message} at byte ${this.index}`);
  }

  whitespace() {
    while (/[ \t\r\n]/.test(this.text[this.index] ?? "")) {
      this.index += 1;
    }
  }

  value() {
    this.whitespace();
    const character = this.text[this.index];
    if (character === "{") return this.object();
    if (character === "[") return this.array();
    if (character === '"') return this.string();
    if (this.text.startsWith("true", this.index)) {
      this.index += 4;
      return true;
    }
    if (this.text.startsWith("false", this.index)) {
      this.index += 5;
      return false;
    }
    if (this.text.startsWith("null", this.index)) {
      this.index += 4;
      return null;
    }
    const match = /^-?(?:0|[1-9][0-9]*)/.exec(this.text.slice(this.index));
    if (match) {
      this.index += match[0].length;
      const number = Number(match[0]);
      if (!Number.isSafeInteger(number)) {
        this.error("number is not a safe integer");
      }
      return number;
    }
    if (character === "-" || character === "." || /[0-9]/.test(character ?? "")) {
      this.error("only safe integer numbers are accepted");
    }
    this.error("unexpected token");
  }

  string() {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      if (character === "\\") {
        this.index += 2;
        continue;
      }
      if (character === '"') {
        this.index += 1;
        try {
          return JSON.parse(this.text.slice(start, this.index));
        } catch {
          this.error("invalid string");
        }
      }
      if (character < " ") {
        this.error("control character in string");
      }
      this.index += 1;
    }
    this.error("unterminated string");
  }

  array() {
    this.index += 1;
    const result = [];
    this.whitespace();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return result;
    }
    while (true) {
      result.push(this.value());
      this.whitespace();
      if (this.text[this.index] === "]") {
        this.index += 1;
        return result;
      }
      if (this.text[this.index] !== ",") {
        this.error("expected comma");
      }
      this.index += 1;
    }
  }

  object() {
    this.index += 1;
    const result = Object.create(null);
    const seen = new Set();
    this.whitespace();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return result;
    }
    while (true) {
      this.whitespace();
      if (this.text[this.index] !== '"') {
        this.error("object key must be a string");
      }
      const key = this.string();
      if (seen.has(key)) {
        this.error(`duplicate object key ${key}`);
      }
      seen.add(key);
      this.whitespace();
      if (this.text[this.index] !== ":") {
        this.error("expected colon");
      }
      this.index += 1;
      result[key] = this.value();
      this.whitespace();
      if (this.text[this.index] === "}") {
        this.index += 1;
        return result;
      }
      if (this.text[this.index] !== ",") {
        this.error("expected comma");
      }
      this.index += 1;
    }
  }

  parse() {
    const result = this.value();
    this.whitespace();
    if (this.index !== this.text.length) {
      this.error("trailing data");
    }
    return result;
  }
}

function parseJson(buffer, sourceName) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    fail(`${sourceName} is not valid UTF-8`);
  }
  return { text, value: new JsonParser(text).parse() };
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail("canonical JSON only accepts safe integers");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort(byteCompare)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  fail("canonical JSON encountered a non-JSON value");
}

function canonicalTagSet(value, context) {
  if (
    !Array.isArray(value) ||
    !value.every((tag) => typeof tag === "string" && tag.length > 0)
  ) {
    fail(`${context} must contain non-empty strings`);
  }
  return [...new Set(value)].sort(byteCompare);
}

function recordTimestamp(value, context) {
  if (
    typeof value !== "string" ||
    !UTC.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    fail(`${context} must be canonical UTC text`);
  }
  return value;
}

function validateRecord(record, serviceId, index) {
  const context = `events[${index}].record`;
  sameSchemaKeys(record, "input", context, "events[].record");
  if (record.serviceId !== serviceId) {
    fail(`${context}.serviceId differs from input serviceId`);
  }
  if (typeof record.id !== "string" || !UUID.test(record.id)) {
    fail(`${context}.id must be an RFC 4122 UUID`);
  }
  if (
    typeof record.sortableUniqueId !== "string" ||
    !SUID.test(record.sortableUniqueId)
  ) {
    fail(`${context}.sortableUniqueId must be 30 ASCII digits`);
  }
  nonEmptyString(record.eventType, `${context}.eventType`);
  if (record.eventType.includes(":")) {
    fail(`${context}.eventType must not contain ':'`);
  }
  nonEmptyString(record.payload, `${context}.payload`);
  parseJson(encoder.encode(record.payload), `${context}.payload`);
  if (
    !Array.isArray(record.tags) ||
    !record.tags.every((tag) => typeof tag === "string" && tag.length > 0)
  ) {
    fail(`${context}.tags must contain non-empty strings`);
  }
  recordTimestamp(record.timestamp, `${context}.timestamp`);
  for (const field of ["causationId", "correlationId", "executedUser"]) {
    if (record[field] !== null && typeof record[field] !== "string") {
      fail(`${context}.${field} must be string or null`);
    }
  }
}

function lengthPrefix(length) {
  return Uint8Array.of(
    (length >>> 24) & 255,
    (length >>> 16) & 255,
    (length >>> 8) & 255,
    length & 255,
  );
}

function concat(parts) {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function field(name, value, present = true) {
  const nameBytes = encoder.encode(name);
  const bytes = value ?? new Uint8Array();
  return concat([
    Uint8Array.of(present ? 1 : 0),
    lengthPrefix(nameBytes.length),
    nameBytes,
    lengthPrefix(bytes.length),
    bytes,
  ]);
}

function eventDigestBytes(record, digestInfo, declaredTagSet) {
  const tagBytes = concat(
    declaredTagSet.map((tag) => {
      const bytes = encoder.encode(tag);
      return concat([lengthPrefix(bytes.length), bytes]);
    }),
  );
  const fields = [
    field("serviceId", encoder.encode(record.serviceId)),
    field("eventId", encoder.encode(record.id)),
    field("sortableUniqueId", encoder.encode(record.sortableUniqueId)),
    field("eventType", encoder.encode(record.eventType)),
    field("timestamp", encoder.encode(record.timestamp)),
    own(digestInfo, "allocatorLineageId")
      ? field("allocatorLineageId", encoder.encode(digestInfo.allocatorLineageId))
      : field("allocatorLineageId", undefined, false),
    field("attemptId", encoder.encode(digestInfo.attemptId)),
    field("declaredTagSet", tagBytes),
    field("payload", encoder.encode(record.payload)),
  ];
  return concat([encoder.encode(DIGEST_CONTRACT), Uint8Array.of(0), ...fields]);
}

export function eventDigestForRecord(record, digestInfo, declaredTagSet) {
  const bytes = eventDigestBytes(
    record,
    digestInfo,
    canonicalTagSet(declaredTagSet, "declaredTagSet"),
  );
  return {
    canonicalBytesBase64: Buffer.from(bytes).toString("base64"),
    eventDigest: createHash("sha256").update(bytes).digest("hex"),
  };
}

function validateSeal(seal) {
  sameSchemaKeys(seal, "input", "input.seal", "seal");
  if (seal.state !== "SEALED") {
    fail("input seal state is not SEALED");
  }
  if (seal.canonicalization !== "utf8-json-sorted-keys-v1") {
    fail("input seal canonicalization is unsupported");
  }
  digest(seal.contentDigest, "input.seal.contentDigest");
  integer(seal.sealedAtMs, "input.seal.sealedAtMs");
}

function validateHealth(health, seal) {
  sameSchemaKeys(health, "input", "input.health", "health");
  if (health.status !== "HEALTHY") {
    fail(`input health status ${health.status} is not HEALTHY`);
  }
  nonEmptyString(health.scannerVersion, "input.health.scannerVersion");
  integer(health.lastFullScanAtMs, "input.health.lastFullScanAtMs");
  integer(health.staleAfterMs, "input.health.staleAfterMs");
  integer(health.openFindingCount, "input.health.openFindingCount");
  if (health.openFindingCount !== 0) {
    fail("input health has open findings");
  }
  if (
    health.lastSettledFrontierSuid !== null &&
    (typeof health.lastSettledFrontierSuid !== "string" ||
      !SUID.test(health.lastSettledFrontierSuid))
  ) {
    fail("input health frontier is invalid");
  }
  integer(health.coveredEventCount, "input.health.coveredEventCount");
  integer(health.coveredMembershipCount, "input.health.coveredMembershipCount");
  if (
    health.lastFullScanAtMs > seal.sealedAtMs ||
    seal.sealedAtMs - health.lastFullScanAtMs > health.staleAfterMs
  ) {
    fail("input health evidence was stale at seal time");
  }
}

function validateSummary(summary) {
  sameSchemaKeys(summary, "input", "input.summary", "summary");
  for (const key of ["eventCount", "declaredMembershipCount", "committedMembershipCount"]) {
    integer(summary[key], `input.summary.${key}`);
  }
}

function validateDigestInfo(digestInfo, index) {
  const context = `input.events[${index}].digest`;
  sameSchemaKeys(digestInfo, "input", context, "events[].digest");
  if (digestInfo.contract !== DIGEST_CONTRACT) {
    fail(`${context}.contract is invalid`);
  }
  nonEmptyString(digestInfo.attemptId, `${context}.attemptId`);
  nonEmptyString(digestInfo.canonicalBytesBase64, `${context}.canonicalBytesBase64`);
  if (!/^[0-9a-f]{64}$/.test(digestInfo.eventDigest)) {
    fail(`${context}.eventDigest must be lowercase SHA-256 hex`);
  }
  if (
    own(digestInfo, "allocatorLineageId") &&
    (typeof digestInfo.allocatorLineageId !== "string" ||
      digestInfo.allocatorLineageId.length === 0)
  ) {
    fail(`${context}.allocatorLineageId must be a non-empty string when present`);
  }
}

function decodeCanonicalBytes(value, context) {
  let bytes;
  try {
    bytes = Uint8Array.from(Buffer.from(value, "base64"));
  } catch {
    fail(`${context} is invalid`);
  }
  if (Buffer.from(bytes).toString("base64") !== value || bytes.length === 0) {
    fail(`${context} is not valid base64`);
  }
  return bytes;
}

function validateEventEntry(entry, serviceId, index, ids, suids, previousSuid) {
  const context = `input.events[${index}]`;
  sameSchemaKeys(entry, "input", context, "events[]");
  validateRecord(entry.record, serviceId, index);
  validateEventIdentity(entry.record, ids, suids, previousSuid);
  validateDigestInfo(entry.digest, index);
  const canonicalBytes = decodeCanonicalBytes(
    entry.digest.canonicalBytesBase64,
    `${context}.digest.canonicalBytesBase64`,
  );
  const declared = canonicalTagSet(entry.declaredTagSet, `${context}.declaredTagSet`);
  if (canonicalJson(declared) !== canonicalJson(entry.declaredTagSet)) {
    fail(`${context}.declaredTagSet is not its UTF-8 sorted unique set`);
  }
  if (
    canonicalJson(declared) !==
    canonicalJson(canonicalTagSet(entry.record.tags, `${context}.record.tags`))
  ) {
    fail(`${context} declaredTagSet differs from record.tags`);
  }
  const committed = validateCommittedMembership(
    entry.committedMembership,
    declared,
    context,
  );
  validateEventDigest(entry, declared, canonicalBytes, context);
  return {
    entry,
    declared,
    committed,
    nextSuid: entry.record.sortableUniqueId,
  };
}

function validateEventIdentity(record, ids, suids, previousSuid) {
  const eventId = record.id.toLowerCase();
  if (ids.has(eventId)) {
    fail(`duplicate event identity ${record.id}`);
  }
  if (suids.has(record.sortableUniqueId)) {
    fail(`duplicate SUID ${record.sortableUniqueId}`);
  }
  if (previousSuid && record.sortableUniqueId <= previousSuid) {
    fail("events must be strictly SUID ascending");
  }
  ids.add(eventId);
  suids.add(record.sortableUniqueId);
}

function validateCommittedMembership(committed, declared, context) {
  if (
    !Array.isArray(committed) ||
    committed.length === 0 ||
    !committed.every((tag) => typeof tag === "string" && tag.length > 0)
  ) {
    fail(`${context}.committedMembership must be non-empty strings`);
  }
  if (new Set(committed).size !== committed.length) {
    fail(`${context} has duplicate committed membership`);
  }
  for (const tag of committed) {
    if (!declared.includes(tag)) {
      fail(`${context} membership ${tag} is outside declaredTagSet`);
    }
  }
  return committed;
}

function validateEventDigest(entry, declared, canonicalBytes, context) {
  const computedBytes = eventDigestBytes(entry.record, entry.digest, declared);
  if (
    Buffer.compare(Buffer.from(computedBytes), Buffer.from(canonicalBytes)) !== 0
  ) {
    fail(`${context} canonical event bytes do not match the logical record`);
  }
  if (sha256(computedBytes).slice("sha256:".length) !== entry.digest.eventDigest) {
    fail(`${context} event digest does not match canonical bytes`);
  }
}

function validateInputObject(input) {
  validateContractValue(input, "input", "input");
  if (
    input.format !== INPUT_FORMAT ||
    input.version !== SCHEMAS.input.version
  ) {
    fail("input format/version is not version 1");
  }
  const serviceId = nonEmptyString(input.serviceId, "input.serviceId");
  validateSeal(input.seal);
  validateHealth(input.health, input.seal);
  validateSummary(input.summary);
  if (!Array.isArray(input.events)) {
    fail("input.events must be an array");
  }
  const ids = new Set();
  const suids = new Set();
  const events = [];
  const membership = [];
  let previousSuid = "";
  input.events.forEach((entry, index) => {
    const checked = validateEventEntry(
      entry,
      serviceId,
      index,
      ids,
      suids,
      previousSuid,
    );
    previousSuid = checked.nextSuid;
    events.push(checked);
    for (const tag of checked.committed) {
      membership.push({ event: entry, tag });
    }
  });
  validateSummaryCounts(input.summary, input.events, membership);
  validateHealthCoverage(input.health, input.summary, events);
  return { serviceId, events, membership, input };
}

function validateSummaryCounts(summary, events, membership) {
  const declaredMembershipCount = events.reduce(
    (count, event) => count + event.declaredTagSet.length,
    0,
  );
  if (
    summary.eventCount !== events.length ||
    summary.declaredMembershipCount !== declaredMembershipCount ||
    summary.committedMembershipCount !== membership.length
  ) {
    fail("input summary counts do not match events");
  }
}

function validateHealthCoverage(health, summary, events) {
  const frontier = events.at(-1)?.entry.record.sortableUniqueId ?? null;
  if (
    health.coveredEventCount !== summary.eventCount ||
    health.coveredMembershipCount !== summary.committedMembershipCount ||
    health.lastSettledFrontierSuid !== frontier
  ) {
    fail("input health coverage does not match the sealed frontier");
  }
}

export function validateInput(buffer, sourceName = "input") {
  const fileSha256 = sha256(buffer);
  const parsed = parseJson(buffer, sourceName);
  const checked = validateInputObject(parsed.value);
  const unsigned = structuredClone(parsed.value);
  unsigned.seal.contentDigest = "";
  const computed = sha256(encoder.encode(canonicalJson(unsigned)));
  if (computed !== checked.input.seal.contentDigest) {
    fail(
      `input content digest mismatch: expected ${checked.input.seal.contentDigest}, computed ${computed}`,
    );
  }
  return {
    ...checked,
    fileSha256,
    contentDigest: computed,
    text: parsed.text,
    buffer,
  };
}

function validateCorrection(buffer, inputState, suppliedDigest, sourceName = "correction") {
  const fileSha256 = sha256(buffer);
  if (suppliedDigest !== undefined && suppliedDigest !== fileSha256) {
    fail(
      `correction file digest mismatch: expected ${suppliedDigest}, computed ${fileSha256}`,
    );
  }
  const parsed = parseJson(buffer, sourceName);
  const correction = parsed.value;
  validateContractValue(correction, "correction", "correction");
  if (
    correction.format !== CORRECTION_FORMAT ||
    correction.version !== SCHEMAS.correction.version
  ) {
    fail("correction format/version is not version 1");
  }
  nonEmptyString(correction.correctionId, "correction.correctionId");
  if (correction.serviceId !== inputState.serviceId) {
    fail("correction serviceId differs from input");
  }
  if (correction.inputContentDigest !== inputState.contentDigest) {
    fail("correction inputContentDigest differs from input");
  }
  nonEmptyString(correction.reason, "correction.reason");
  const additions = validateCorrectionAdditions(
    correction.addMembership,
    inputState,
  );
  return { correction, additions, fileSha256, text: parsed.text, buffer };
}

function validateCorrectionAdditions(addMembership, inputState) {
  if (!Array.isArray(addMembership) || addMembership.length === 0) {
    fail("correction.addMembership must be non-empty");
  }
  const seen = new Set();
  const additions = [];
  for (const [index, addition] of addMembership.entries()) {
    additions.push(
      validateCorrectionAddition(addition, index, inputState, seen),
    );
  }
  return additions;
}

function validateCorrectionAddition(addition, index, inputState, seen) {
  const context = `correction.addMembership[${index}]`;
  sameSchemaKeys(addition, "correction", context, "addMembership[]");
  if (
    !UUID.test(addition.eventId) ||
    !/^[0-9a-f]{64}$/.test(addition.eventDigest) ||
    typeof addition.tag !== "string" ||
    addition.tag.length === 0
  ) {
    fail(`${context} is invalid`);
  }
  const eventId = addition.eventId.toLowerCase();
  const key = `${eventId}\u0000${addition.eventDigest}\u0000${addition.tag}`;
  if (seen.has(key)) {
    fail(`correction has duplicate addition ${key}`);
  }
  seen.add(key);
  const found = inputState.events.find(
    ({ entry }) => entry.record.id.toLowerCase() === eventId,
  );
  if (!found) {
    fail(`correction names unknown event ${addition.eventId}`);
  }
  if (found.entry.digest.eventDigest !== addition.eventDigest) {
    fail(`correction digest does not match event ${addition.eventId}`);
  }
  if (!found.declared.includes(addition.tag)) {
    fail(`correction tag ${addition.tag} is not declared for ${addition.eventId}`);
  }
  if (found.committed.includes(addition.tag)) {
    fail(`correction tag ${addition.tag} is already committed for ${addition.eventId}`);
  }
  return { event: found.entry, tag: addition.tag };
}

function sortedMembership(state, correctionState) {
  return [...state.membership, ...(correctionState?.additions ?? [])].sort(
    (left, right) =>
      left.event.record.sortableUniqueId.localeCompare(right.event.record.sortableUniqueId) ||
      byteCompare(left.tag, right.tag) ||
      byteCompare(left.event.record.id, right.event.record.id),
  );
}

function eventById(state) {
  return new Map(state.events.map((item) => [item.entry.record.id.toLowerCase(), item]));
}

function timestampMicros(text) {
  const match = UTC.exec(text);
  if (!match) {
    fail(`invalid timestamp ${text}`);
  }
  const milliseconds = Date.parse(
    `${match[1]}.${match[2].slice(0, 3).padEnd(3, "0")}Z`,
  );
  return BigInt(milliseconds) * 1000n + BigInt(match[2].slice(3).padEnd(3, "0"));
}

function normalizeDbTimestamp(value) {
  return String(value).replace(/\s+/, "T").replace(/\+00$/, "Z").replace(/\+00:00$/, "Z");
}

function logicalMatches(row, item) {
  const record = item.entry.record;
  if (String(row.id).toLowerCase() !== record.id.toLowerCase()) {
    return `event identity (target ${row.id}, sealed ${record.id})`;
  }
  if (row.service_id !== record.serviceId) {
    return `serviceId (target ${row.service_id}, sealed ${record.serviceId})`;
  }
  if (row.suid !== record.sortableUniqueId) {
    return `sortableUniqueId (target ${row.suid}, sealed ${record.sortableUniqueId})`;
  }
  if (row.event_type !== record.eventType) {
    return `eventType (target ${row.event_type}, sealed ${record.eventType})`;
  }
  if (row.payload !== record.payload) {
    return `payload bytes (target ${JSON.stringify(row.payload)}, sealed ${JSON.stringify(record.payload)})`;
  }
  let tags;
  try {
    tags = typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags;
  } catch {
    return `ordered declared tags (target ${row.tags})`;
  }
  if (canonicalJson(tags) !== canonicalJson(record.tags)) {
    return `ordered declared tags (target ${canonicalJson(tags)}, sealed ${canonicalJson(record.tags)})`;
  }
  if (
    (row.causation_id ?? null) !== record.causationId ||
    (row.correlation_id ?? null) !== record.correlationId ||
    (row.executed_user ?? null) !== record.executedUser
  ) {
    return `nullable event metadata (target ${JSON.stringify([
      row.causation_id,
      row.correlation_id,
      row.executed_user,
    ])}, sealed ${JSON.stringify([
      record.causationId,
      record.correlationId,
      record.executedUser,
    ])})`;
  }
  if (
    timestampMicros(normalizeDbTimestamp(row.timestamp)) !==
    timestampMicros(record.timestamp)
  ) {
    return `timestamp instant (target ${row.timestamp}, sealed ${record.timestamp})`;
  }
  return null;
}

const TARGET_COLUMNS = {
  dcb_events: {
    ServiceId: ["character varying", 64],
    Id: ["uuid"],
    SortableUniqueId: ["character varying", 100],
    EventType: ["text"],
    Payload: ["json"],
    Tags: ["jsonb"],
    Timestamp: ["timestamp with time zone"],
    CausationId: ["text"],
    CorrelationId: ["text"],
    ExecutedUser: ["text"],
  },
  dcb_tags: {
    Id: ["bigint"],
    ServiceId: ["character varying", 64],
    Tag: ["text"],
    TagGroup: ["text"],
    EventType: ["text"],
    SortableUniqueId: ["character varying", 100],
    EventId: ["uuid"],
    CreatedAt: ["timestamp with time zone"],
  },
};

async function schemaCheck(sql) {
  for (const [table, columns] of Object.entries(TARGET_COLUMNS)) {
    const rows = await sql`
      SELECT column_name, data_type, character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${table}
    `;
    const byName = new Map(rows.map((row) => [row.column_name, row]));
    for (const [name, type] of Object.entries(columns)) {
      const row = byName.get(name);
      if (
        !row ||
        row.data_type !== type[0] ||
        (type[1] !== undefined && row.character_maximum_length !== type[1])
      ) {
        fail(`target schema ${table}.${name} is missing or has the wrong type`);
      }
    }
    if (byName.size !== Object.keys(columns).length) {
      fail(`target schema ${table} has unexpected columns`);
    }
  }
}

async function validateProvenanceSchema(sql) {
  const rows = await sql`
    SELECT column_name, data_type, character_maximum_length, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'dcb_tag_rebuild_provenance'
  `;
  const expected = SCHEMAS.provenance.columnTypes;
  const expectedColumns = new Set(SCHEMAS.provenance.requiredColumns);
  if (
    rows.length !== expectedColumns.size ||
    rows.some(
      (row) =>
        !expectedColumns.has(row.column_name) ||
        expected[row.column_name]?.[0] !== row.data_type ||
        (expected[row.column_name]?.[1] ?? null) !==
          (row.character_maximum_length ?? null),
    )
  ) {
    fail("provenance table schema does not match version 1");
  }
  const nullability = new Map(rows.map((row) => [row.column_name, row.is_nullable]));
  if (
    SCHEMAS.provenance.requiredNotNullColumns.some(
      (name) => nullability.get(name) !== "NO",
    ) ||
    SCHEMAS.provenance.nullableColumns.some(
      (name) => nullability.get(name) !== "YES",
    )
  ) {
    fail("provenance nullability does not match version 1");
  }
  const constraints = await sql`
    SELECT contype, pg_get_constraintdef(pg_constraint.oid) AS definition
    FROM pg_constraint
    JOIN pg_class ON pg_class.oid = pg_constraint.conrelid
    JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
    WHERE pg_namespace.nspname = 'public'
      AND pg_class.relname = 'dcb_tag_rebuild_provenance'
  `;
  const checks = constraints
    .filter((row) => row.contype === "c")
    .map((row) => row.definition.toLowerCase());
  if (
    !constraints.some((row) => row.contype === "p" && /\(rebuild_id\)/i.test(row.definition)) ||
    !constraints.some((row) => row.contype === "u" && /\(service_id\)/i.test(row.definition)) ||
    !checks.some((definition) => definition.includes("contract_version") && definition.includes("1")) ||
    !checks.some((definition) => definition.includes("input_file_sha256") && definition.includes("sha256")) ||
    !checks.some((definition) => definition.includes("input_content_digest") && definition.includes("sha256")) ||
    !checks.some((definition) => definition.includes("correction_manifest_sha256") && definition.includes("sha256")) ||
    !checks.some(
      (definition) =>
        definition.includes("correction_manifest_sha256") &&
        definition.includes("correction_manifest_json"),
    )
  ) {
    fail("provenance table constraints do not match version 1");
  }
}

async function targetEvents(sql, serviceId) {
  return sql`
    SELECT
      "ServiceId" AS service_id,
      "Id"::text AS id,
      "SortableUniqueId" AS suid,
      "EventType" AS event_type,
      "Payload"::text AS payload,
      "Tags"::text AS tags,
      to_char(
        "Timestamp" AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) AS timestamp,
      "CausationId" AS causation_id,
      "CorrelationId" AS correlation_id,
      "ExecutedUser" AS executed_user
    FROM dcb_events
    WHERE "ServiceId" = ${serviceId}
    ORDER BY "SortableUniqueId", "Id"
  `;
}

async function targetTags(sql, serviceId) {
  return sql`
    SELECT
      t."ServiceId" AS service_id,
      t."Tag" AS tag,
      t."TagGroup" AS tag_group,
      t."EventType" AS event_type,
      t."SortableUniqueId" AS suid,
      t."EventId"::text AS event_id,
      to_char(
        t."CreatedAt" AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) AS created_at,
      e."Id"::text AS joined_event_id,
      e."ServiceId" AS joined_service_id,
      e."SortableUniqueId" AS joined_suid,
      e."EventType" AS joined_event_type,
      e."Payload"::text AS joined_payload,
      e."Tags"::text AS joined_tags,
      to_char(
        e."Timestamp" AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) AS joined_timestamp,
      e."CausationId" AS joined_causation_id,
      e."CorrelationId" AS joined_correlation_id,
      e."ExecutedUser" AS joined_executed_user
    FROM dcb_tags t
    LEFT JOIN dcb_events e
      ON e."ServiceId" = t."ServiceId"
     AND e."Id" = t."EventId"
    WHERE t."ServiceId" = ${serviceId}
    ORDER BY t."SortableUniqueId", t."Tag", t."EventId"
  `;
}

function validateTargetEvents(rows, state) {
  if (rows.length !== state.events.length) {
    fail(`target event count ${rows.length} differs from sealed count ${state.events.length}`);
  }
  const map = eventById(state);
  const seen = new Set();
  for (const row of rows) {
    const id = String(row.id).toLowerCase();
    const item = map.get(id);
    if (!item || seen.has(id)) {
      fail(`target event set differs at event ${row.id}`);
    }
    const mismatch = logicalMatches(row, item);
    if (mismatch) {
      fail(`target ${mismatch} mismatch for event ${row.id}`);
    }
    seen.add(id);
  }
  if (seen.size !== map.size) {
    fail("target event set is incomplete");
  }
}

function joinedEventRow(row) {
  return {
    id: row.joined_event_id,
    service_id: row.joined_service_id,
    suid: row.joined_suid,
    event_type: row.joined_event_type,
    payload: row.joined_payload,
    tags: row.joined_tags,
    timestamp: row.joined_timestamp,
    causation_id: row.joined_causation_id,
    correlation_id: row.joined_correlation_id,
    executed_user: row.joined_executed_user,
  };
}

function observedEventSet(rows, state) {
  const byId = eventById(state);
  const observed = new Map();
  for (const row of rows) {
    if (row.joined_event_id === null) {
      fail(`orphan dcb_tags EventId ${row.event_id}`);
    }
    const id = String(row.joined_event_id).toLowerCase();
    const item = byId.get(id);
    if (!item) {
      fail(`observed membership has no validated event digest for ${row.event_id}`);
    }
    if (!observed.has(id)) {
      observed.set(id, {
        eventId: row.joined_event_id,
        eventDigest: item.entry.digest.eventDigest,
      });
    }
  }
  return [...observed.values()].sort((left, right) => byteCompare(left.eventId, right.eventId));
}

function setDigests(rows, state) {
  const events = observedEventSet(rows, state);
  const byId = eventById(state);
  const memberships = rows
    .map((row) => {
      const item = byId.get(String(row.joined_event_id).toLowerCase());
      if (!item) {
        fail(`observed membership has no validated event digest for ${row.event_id}`);
      }
      return {
        eventId: row.joined_event_id,
        eventDigest: item.entry.digest.eventDigest,
        tag: row.tag,
      };
    })
    .sort(
      (left, right) =>
        byteCompare(left.eventId, right.eventId) ||
        byteCompare(left.eventDigest, right.eventDigest) ||
        byteCompare(left.tag, right.tag),
    );
  return {
    eventSetDigest: sha256(encoder.encode(canonicalJson(events))),
    membershipSetDigest: sha256(encoder.encode(canonicalJson(memberships))),
  };
}

function validateTargetTags(rows, state, correctionState, appliedAt) {
  const expected = sortedMembership(state, correctionState);
  for (const row of rows) {
    if (row.joined_event_id === null) {
      fail(`orphan dcb_tags EventId ${row.event_id}`);
    }
  }
  const matchedRows = rows.filter((row) => row.joined_event_id !== null);
  if (rows.length !== matchedRows.length) {
    fail(
      `target raw tag count ${rows.length} differs from matched join count ${matchedRows.length}`,
    );
  }
  if (matchedRows.length !== expected.length) {
    fail(
      `target membership count ${matchedRows.length} differs from expected ${expected.length}`,
    );
  }
  const used = new Set();
  for (const row of rows) {
    validatedJoinedEvent(row, state);
    const index = expected.findIndex(
      (candidate, candidateIndex) =>
        !used.has(candidateIndex) &&
        candidate.event.record.id.toLowerCase() === row.event_id.toLowerCase() &&
        candidate.tag === row.tag,
    );
    if (index < 0) {
      fail(`target membership differs at ${row.event_id}/${row.tag}`);
    }
    used.add(index);
    const itemForTag = expected[index];
    validateProviderFields(row, itemForTag, state, appliedAt);
  }
  if (used.size !== expected.length) {
    fail("target membership set is incomplete");
  }
  return setDigests(rows, state);
}

function validatedJoinedEvent(row, state) {
  if (row.joined_event_id === null) {
    fail(`orphan dcb_tags EventId ${row.event_id}`);
  }
  const item = eventById(state).get(String(row.joined_event_id).toLowerCase());
  if (!item) {
    fail(`target membership names unknown event ${row.joined_event_id}`);
  }
  const logicalMismatch = logicalMatches(joinedEventRow(row), item);
  if (logicalMismatch) {
    fail(`target joined ${logicalMismatch} mismatch for tag ${row.tag}`);
  }
  return item;
}

function validateProviderFields(row, item, state, appliedAt) {
  const record = item.event.record;
  if (
    row.service_id !== state.serviceId ||
    row.tag_group !== (row.tag.split(":", 1)[0] || row.tag) ||
    row.event_type !== record.eventType ||
    row.suid !== record.sortableUniqueId ||
    row.event_id.toLowerCase() !== record.id.toLowerCase()
  ) {
    fail(`target provider fields mismatch for ${row.event_id}/${row.tag}`);
  }
  if (
    appliedAt !== undefined &&
    timestampMicros(normalizeDbTimestamp(row.created_at)) !==
      timestampMicros(appliedAt)
  ) {
    fail(
      `target CreatedAt mismatch for ${row.event_id}/${row.tag}: ` +
        `target ${row.created_at}, appliedAt ${appliedAt}`,
    );
  }
}

function rebuildId(serviceId, inputFileSha256, correctionSha256) {
  return sha256(
    encoder.encode(
      canonicalJson({
        contractVersion: CONTRACT_VERSION,
        serviceId,
        inputFileSha256,
        correctionManifestSha256: correctionSha256 ?? null,
      }),
    ),
  );
}

function receiptBytes(state, correctionState, inputFileSha256, appliedAt, target, rebuild) {
  const input = state.input;
  const correction = correctionState
    ? {
        correctionId: correctionState.correction.correctionId,
        reason: correctionState.correction.reason,
        manifestSha256: correctionState.fileSha256,
        addedMembershipCount: correctionState.additions.length,
      }
    : null;
  const value = {
    format: RECEIPT_FORMAT,
    version: SCHEMAS.receipt.version,
    rebuildId: rebuild,
    serviceId: state.serviceId,
    contractVersion: CONTRACT_VERSION,
    appliedAt,
    input: {
      fileSha256: inputFileSha256,
      contentDigest: state.contentDigest,
      sealedAtMs: input.seal.sealedAtMs,
      health: input.health,
      eventCount: input.summary.eventCount,
      declaredMembershipCount: input.summary.declaredMembershipCount,
      committedMembershipCount: input.summary.committedMembershipCount,
    },
    correction,
    target: {
      eventCount: state.events.length,
      membershipCount: target.membershipCount,
      eventSetDigest: target.eventSetDigest,
      membershipSetDigest: target.membershipSetDigest,
    },
    verification: {
      globalToTagToGlobal: "equal",
      payloadBytes: "equal",
      sealedEventDigestBinding: "matched-logical-record",
      membershipCount: "equal",
      membershipSet: "equal",
    },
  };
  validateContractValue(value, "receipt", "receipt");
  return `${canonicalJson(value)}\n`;
}

function validateStoredReceipt(text, prior, state, correctionState, rebuild) {
  const parsed = parseJson(Buffer.from(text, "utf8"), "stored receipt").value;
  validateContractValue(parsed, "receipt", "stored receipt");
  if (
    parsed.format !== RECEIPT_FORMAT ||
    parsed.version !== SCHEMAS.receipt.version ||
    parsed.rebuildId !== rebuild ||
    parsed.serviceId !== state.serviceId ||
    parsed.contractVersion !== CONTRACT_VERSION
  ) {
    fail("stored receipt identity is invalid");
  }
  if (
    typeof parsed.appliedAt !== "string" ||
    timestampMicros(parsed.appliedAt) !== timestampMicros(normalizeDbTimestamp(prior.applied_at))
  ) {
    fail("stored receipt appliedAt differs from provenance");
  }
  sameSchemaKeys(parsed.input, "receipt", "stored receipt.input", "input");
  sameSchemaKeys(parsed.input.health, "receipt", "stored receipt.input.health", "input.health");
  if (
    parsed.input.fileSha256 !== state.fileSha256 ||
    parsed.input.contentDigest !== state.contentDigest ||
    parsed.input.sealedAtMs !== state.input.seal.sealedAtMs ||
    canonicalJson(parsed.input.health) !== canonicalJson(state.input.health) ||
    parsed.input.eventCount !== state.input.summary.eventCount ||
    parsed.input.declaredMembershipCount !== state.input.summary.declaredMembershipCount ||
    parsed.input.committedMembershipCount !== state.input.summary.committedMembershipCount
  ) {
    fail("stored receipt input evidence differs");
  }
  const expectedCorrection = correctionState
    ? {
        correctionId: correctionState.correction.correctionId,
        reason: correctionState.correction.reason,
        manifestSha256: correctionState.fileSha256,
        addedMembershipCount: correctionState.additions.length,
      }
    : null;
  if (expectedCorrection === null) {
    if (parsed.correction !== null) {
      fail("stored receipt correction differs");
    }
  } else {
    sameSchemaKeys(parsed.correction, "receipt", "stored receipt.correction", "correction");
    if (canonicalJson(parsed.correction) !== canonicalJson(expectedCorrection)) {
      fail("stored receipt correction differs");
    }
  }
  sameSchemaKeys(parsed.target, "receipt", "stored receipt.target", "target");
  for (const key of ["eventSetDigest", "membershipSetDigest"]) {
    digest(parsed.target[key], `stored receipt.target.${key}`);
  }
  sameSchemaKeys(parsed.verification, "receipt", "stored receipt.verification", "verification");
  if (
    canonicalJson(parsed.verification) !==
    canonicalJson({
      globalToTagToGlobal: "equal",
      payloadBytes: "equal",
      sealedEventDigestBinding: "matched-logical-record",
      membershipCount: "equal",
      membershipSet: "equal",
    })
  ) {
    fail("stored receipt verification is invalid");
  }
  if (`${canonicalJson(parsed)}\n` !== text) {
    fail("stored receipt is not canonical JSON");
  }
  return parsed;
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const length = bytes.length - offset;
    const requested =
      receiptPublicationHooksForTests.writeChunk?.({
        descriptor,
        bytes,
        offset,
        length,
      }) ?? length;
    const writeLength = Math.min(requested, length);
    const chunk = bytes.subarray(offset, offset + writeLength);
    const written = writeSync(descriptor, Buffer.from(chunk));
    if (written <= 0) {
      fail("receipt write made no progress");
    }
    offset += written;
  }
  fsyncSync(descriptor);
}

function writeReceipt(path, text) {
  const bytes = Buffer.from(text, "utf8");
  if (existsSync(path)) {
    const existing = readFileSync(path);
    if (!existing.equals(bytes)) {
      fail(`receipt path already contains different bytes: ${path}`);
    }
    return;
  }
  const absolutePath = resolve(path);
  const directory = dirname(absolutePath);
  const temporaryPath = `${directory}/.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const readyPath = `${temporaryPath}.ready`;
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeAll(descriptor, bytes);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, readyPath);
    receiptPublicationHooksForTests.afterStaging?.({
      path,
      stagedPath: readyPath,
      bytes,
    });
    // link is the no-replace publication primitive; rename never overwrites
    // a different receipt path.
    try {
      linkSync(readyPath, absolutePath);
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      const existing = readFileSync(absolutePath);
      if (!existing.equals(bytes)) {
        fail(`receipt path already contains different bytes: ${path}`);
      }
      return;
    }
    const directoryDescriptor = openSync(directory, "r");
    fsyncSync(directoryDescriptor);
    closeSync(directoryDescriptor);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
    if (existsSync(readyPath)) {
      unlinkSync(readyPath);
    }
  }
}

function parseArgs(argv) {
  const options = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (["--input", "--input-sha256", "--receipt", "--correction-manifest", "--correction-sha256"].includes(arg)) {
      const value = argv[index + 1];
      if (!value) {
        fail(`${arg} requires a value`);
      }
      index += 1;
      options[arg.slice(2).replaceAll("-", "_")] = value;
      continue;
    }
    fail(`unknown argument ${arg}`);
  }
  if (!options.input) {
    fail("--input is required");
  }
  if (options.apply && (!options.input_sha256 || !options.receipt)) {
    fail("apply requires --input-sha256 and --receipt");
  }
  if (options.input_sha256 !== undefined) {
    digest(options.input_sha256, "--input-sha256");
  }
  if (options.correction_sha256 !== undefined) {
    digest(options.correction_sha256, "--correction-sha256");
  }
  if (options.correction_sha256 !== undefined && !options.correction_manifest) {
    fail("--correction-sha256 requires --correction-manifest");
  }
  return options;
}

function readExactFile(path, label) {
  try {
    return readFileSync(resolve(path));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(`${label} file cannot be read: ${path} (${reason})`);
  }
}

async function inspectTarget(sql, state, correctionState, appliedAt) {
  const eventRows = await targetEvents(sql, state.serviceId);
  validateTargetEvents(eventRows, state);
  const tagRows = await targetTags(sql, state.serviceId);
  const target = validateTargetTags(tagRows, state, correctionState, appliedAt);
  return {
    eventCount: eventRows.length,
    membershipCount: tagRows.length,
    ...target,
  };
}

function compareCommittedProvenance(stored, expected) {
  const fields = [
    ["rebuild_id", expected.rebuildId],
    ["service_id", expected.serviceId],
    ["contract_version", expected.contractVersion],
    ["input_file_sha256", expected.inputFileSha256],
    ["input_content_digest", expected.inputContentDigest],
    ["correction_manifest_sha256", expected.correctionManifestSha256],
    ["correction_manifest_json", expected.correctionManifestJson],
    ["applied_at", expected.appliedAt],
    ["receipt_sha256", expected.receiptSha256],
    ["receipt_json", expected.receiptJson],
  ];
  for (const [field, value] of fields) {
    if ((stored[field] ?? null) !== (value ?? null)) {
      fail(`committed provenance ${field} differs from transaction-computed value`);
    }
  }
}

async function storedReceiptAfterCommit(
  sql,
  state,
  correctionState,
  rebuild,
  expected,
) {
  const rows = await sql`
    SELECT
      rebuild_id,
      service_id,
      contract_version,
      input_file_sha256,
      input_content_digest,
      correction_manifest_sha256,
      correction_manifest_json,
      to_char(applied_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS applied_at,
      receipt_sha256,
      receipt_json
    FROM dcb_tag_rebuild_provenance
    WHERE service_id = ${state.serviceId}
  `;
  if (rows.length !== 1) {
    fail("committed provenance row could not be read back");
  }
  const stored = rows[0];
  compareCommittedProvenance(stored, expected);
  if (sha256(Buffer.from(stored.receipt_json, "utf8")) !== stored.receipt_sha256) {
    fail("stored receipt digest is invalid after commit");
  }
  const parsed = validateStoredReceipt(
    stored.receipt_json,
    stored,
    state,
    correctionState,
    rebuild,
  );
  if (canonicalJson(parsed.target) !== canonicalJson(expected.target)) {
    fail("committed receipt target differs from transaction-computed target");
  }
  return stored.receipt_json;
}

async function apply(options, state, correctionState) {
  const receiptAlreadyExists = existsSync(options.receipt);
  const sql = postgres(process.env.POSTGRES_URL, { max: 1, fetch_types: false });
  const rebuild = rebuildId(state.serviceId, state.fileSha256, correctionState?.fileSha256);
  let committedProvenance;
  try {
    await sql.begin("isolation level read committed", async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
      await transaction.unsafe(CONTRACT.provenanceDdl);
      await validateProvenanceSchema(transaction);
      const priorRows = await transaction`
        SELECT rebuild_id
        FROM dcb_tag_rebuild_provenance
        WHERE service_id = ${state.serviceId}
      `;
      if (priorRows.length > 1) {
        fail(`multiple provenance rows exist for ${state.serviceId}`);
      }
      await transaction.unsafe("LOCK TABLE dcb_events IN SHARE ROW EXCLUSIVE MODE");
      await transaction.unsafe("LOCK TABLE dcb_tags IN SHARE ROW EXCLUSIVE MODE");
      await schemaCheck(transaction);
      const observedEvents = await targetEvents(transaction, state.serviceId);
      validateTargetEvents(observedEvents, state);
      validateInput(state.buffer, "input");
      if (correctionState) {
        validateCorrection(correctionState.buffer, state, correctionState.fileSha256, "correction");
      }
      const lockedPriorRows = await transaction`
        SELECT
          rebuild_id,
          service_id,
          contract_version,
          input_file_sha256,
          input_content_digest,
          correction_manifest_sha256,
          correction_manifest_json,
          to_char(applied_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS applied_at,
          receipt_sha256,
          receipt_json
        FROM dcb_tag_rebuild_provenance
        WHERE service_id = ${state.serviceId}
      `;
      if (lockedPriorRows.length > 1) {
        fail(`multiple provenance rows exist for ${state.serviceId}`);
      }
      if (lockedPriorRows.length === 1) {
        const prior = lockedPriorRows[0];
        if (
          prior.rebuild_id !== rebuild ||
          prior.input_file_sha256 !== state.fileSha256 ||
          prior.input_content_digest !== state.contentDigest ||
          (prior.correction_manifest_sha256 ?? null) !== (correctionState?.fileSha256 ?? null)
        ) {
          fail("prior provenance belongs to different input or correction bytes");
        }
        if ((prior.correction_manifest_json ?? null) !== (correctionState?.text ?? null)) {
          fail("prior correction manifest text differs");
        }
        const stored = validateStoredReceipt(
          prior.receipt_json,
          prior,
          state,
          correctionState,
          rebuild,
        );
        const target = await inspectTarget(transaction, state, correctionState, stored.appliedAt);
        if (
          target.eventSetDigest !== stored.target.eventSetDigest ||
          target.membershipSetDigest !== stored.target.membershipSetDigest ||
          target.eventCount !== stored.target.eventCount ||
          target.membershipCount !== stored.target.membershipCount
        ) {
          fail("stored receipt target differs from the observed target");
        }
        committedProvenance = {
          rebuildId: prior.rebuild_id,
          serviceId: prior.service_id,
          contractVersion: prior.contract_version,
          inputFileSha256: prior.input_file_sha256,
          inputContentDigest: prior.input_content_digest,
          correctionManifestSha256: prior.correction_manifest_sha256,
          correctionManifestJson: prior.correction_manifest_json,
          appliedAt: prior.applied_at,
          receiptSha256: prior.receipt_sha256,
          receiptJson: prior.receipt_json,
          target: stored.target,
        };
        return;
      }
      if (receiptAlreadyExists) {
        fail(`receipt path already exists before first apply: ${options.receipt}`);
      }
      const existingTags = await transaction`
        SELECT COUNT(*)::int AS count
        FROM dcb_tags
        WHERE "ServiceId" = ${state.serviceId}
      `;
      if (Number(existingTags[0].count) !== 0) {
        fail("target tag rows exist without provenance");
      }
      const appliedAtRow = await transaction`
        SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS applied_at
      `;
      const appliedAt = appliedAtRow[0].applied_at;
      for (const item of sortedMembership(state, correctionState)) {
        const record = item.event.record;
        await transaction`
          INSERT INTO dcb_tags
            ("ServiceId", "Tag", "TagGroup", "EventType", "SortableUniqueId", "EventId", "CreatedAt")
          VALUES
            (${state.serviceId}, ${item.tag}, ${item.tag.split(":", 1)[0] || item.tag},
             ${record.eventType}, ${record.sortableUniqueId}, ${record.id}, transaction_timestamp())
        `;
      }
      const observed = await targetTags(transaction, state.serviceId);
      const target = validateTargetTags(observed, state, correctionState, appliedAt);
      const receiptText = receiptBytes(
        state,
        correctionState,
        state.fileSha256,
        appliedAt,
        { ...target, membershipCount: observed.length },
        rebuild,
      );
      const receiptSha256 = sha256(Buffer.from(receiptText, "utf8"));
      committedProvenance = {
        rebuildId: rebuild,
        serviceId: state.serviceId,
        contractVersion: CONTRACT_VERSION,
        inputFileSha256: state.fileSha256,
        inputContentDigest: state.contentDigest,
        correctionManifestSha256: correctionState?.fileSha256 ?? null,
        correctionManifestJson: correctionState?.text ?? null,
        appliedAt,
        receiptSha256,
        receiptJson: receiptText,
        target: {
          eventCount: state.events.length,
          membershipCount: observed.length,
          eventSetDigest: target.eventSetDigest,
          membershipSetDigest: target.membershipSetDigest,
        },
      };
      await transaction`
        INSERT INTO dcb_tag_rebuild_provenance
          (rebuild_id, service_id, contract_version, input_file_sha256, input_content_digest,
           correction_manifest_sha256, correction_manifest_json, applied_at, receipt_sha256, receipt_json)
        VALUES
          (${rebuild}, ${state.serviceId}, ${CONTRACT_VERSION}, ${state.fileSha256}, ${state.contentDigest},
           ${correctionState?.fileSha256 ?? null}, ${correctionState?.text ?? null},
           transaction_timestamp(), ${receiptSha256}, ${receiptText})
      `;
    });
    const receipt = await storedReceiptAfterCommit(
      sql,
      state,
      correctionState,
      rebuild,
      committedProvenance,
    );
    if (receiptWriteHookForTests) {
      await receiptWriteHookForTests({ path: options.receipt, receipt });
    }
    writeReceipt(options.receipt, receipt);
    return [
      "mode=apply",
      `serviceId=${state.serviceId}`,
      `inputFileSha256=${state.fileSha256}`,
      `inputContentDigest=${state.contentDigest}`,
      `receiptSha256=${sha256(Buffer.from(receipt, "utf8"))}`,
      `receipt=${options.receipt}`,
      "",
    ].join("\n");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function dryRun(options, state, correctionState) {
  const sql = postgres(process.env.POSTGRES_URL, { max: 1, fetch_types: false });
  try {
    await schemaCheck(sql);
    const eventRows = await targetEvents(sql, state.serviceId);
    validateTargetEvents(eventRows, state);
    const tagRows = await targetTags(sql, state.serviceId);
    if (tagRows.length > 0) {
      validateTargetTags(tagRows, state, correctionState);
    }
    const proposed = sortedMembership(state, correctionState);
    const report = {
      format: SCHEMAS.dryRunReport.format,
      version: SCHEMAS.dryRunReport.version,
      serviceId: state.serviceId,
      input: { fileSha256: state.fileSha256, contentDigest: state.contentDigest },
      correction: correctionState
        ? {
            manifestSha256: correctionState.fileSha256,
            correctionId: correctionState.correction.correctionId,
            additionCount: correctionState.additions.length,
          }
        : null,
      target: { eventCount: eventRows.length, membershipCount: tagRows.length },
      proposedMembership: proposed.map(({ event, tag }) => ({ eventId: event.record.id, tag })),
    };
    validateContractValue(report, "dryRunReport", "dry-run report");
    return `${canonicalJson(report)}\n`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function runCommand(argv) {
  const options = parseArgs(argv);
  const inputBuffer = readExactFile(options.input, "input");
  const state = validateInput(inputBuffer, options.input);
  if (options.apply && options.input_sha256 !== state.fileSha256) {
    fail(`input file digest mismatch: expected ${options.input_sha256}, computed ${state.fileSha256}`);
  }
  let correctionState;
  if (options.correction_manifest) {
    const correctionBuffer = readExactFile(
      options.correction_manifest,
      "correction",
    );
    correctionState = validateCorrection(
      correctionBuffer,
      state,
      options.correction_sha256,
      options.correction_manifest,
    );
    if (options.apply && options.correction_sha256 === undefined) {
      fail("apply with correction requires --correction-sha256");
    }
  }
  if (!process.env.POSTGRES_URL) {
    fail("POSTGRES_URL is required");
  }
  return options.apply
    ? apply(options, state, correctionState)
    : dryRun(options, state, correctionState);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCommand(process.argv.slice(2))
    .then((output) => process.stdout.write(output))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
