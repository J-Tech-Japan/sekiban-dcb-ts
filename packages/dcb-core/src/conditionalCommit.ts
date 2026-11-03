/**
 * Conditional-commit wire values and deterministic helpers for the public
 * versioned conditional-commit route.
 */

export const CONDITIONAL_COMMIT_VERSION = 1 as const;
export const CONDITIONAL_COMMIT_DERIVATION_VERSION = 2 as const;
export const CONDITIONAL_COMMIT_CANONICALIZATION_VERSION = 1 as const;
export const CONDITIONAL_COMMIT_DOMAIN_SEPARATOR =
  "sekiban.dcb.conditional-append.unique-key" as const;
export const CONDITIONAL_COMMIT_MAX_UTF8_FIELD_BYTES = 512 as const;
export const CONDITIONAL_COMMIT_MAX_PAYLOAD_BYTES = 192 * 1024;
export const CONDITIONAL_COMMIT_MAX_REQUEST_BYTES = 320 * 1024;

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_INDEX = new Map<string, number>([...BASE64_ALPHABET].map((char, index) => [char, index]));

export type ConditionalCommitValidationCode =
  | "conditional_commit_invalid_json"
  | "conditional_commit_unknown_member"
  | "conditional_commit_invalid_version"
  | "conditional_commit_invalid_envelope"
  | "conditional_commit_invalid_key"
  | "conditional_commit_invalid_candidate"
  | "conditional_commit_invalid_base64"
  | "conditional_commit_invalid_utf8"
  | "conditional_commit_invalid_payload_json"
  | "conditional_commit_payload_root_not_object"
  | "conditional_commit_payload_not_canonicalizable"
  | "conditional_commit_event_not_registered"
  | "conditional_commit_invalid_tag_count"
  | "conditional_commit_size_limit_exceeded";

export type ConditionalCommitInDoubtReason =
  | "winner_unreadable"
  | "ambiguous_after_append"
  | "committed_state_unverified"
  | "live_precondition_blocked"
  | "bootstrap_epoch_changed";

export interface SerializedConditionalEventCandidate {
  readonly payload: string;
  readonly eventPayloadName: string;
  readonly tags: readonly [string];
}

export interface SerializedConditionalCommitRequest {
  readonly version: 1;
  readonly idempotencyKey: string;
  readonly eventCandidate: SerializedConditionalEventCandidate;
}

export interface ConditionalCommitReceipt {
  readonly winnerEventId: string;
  readonly winnerSortableUniqueId: string;
  readonly operationFingerprint: string;
}

export interface ConditionalWrittenEvent {
  readonly payload: string;
  readonly sortableUniqueIdValue: string;
  readonly id: string;
  readonly eventMetadata: {
    readonly causationId: string;
    readonly correlationId: "SerializedCommit";
    readonly executedUser: "SerializedSekibanExecutor";
  };
  readonly tags: readonly [string];
  readonly eventPayloadName: string;
}

export type ConditionalCommitResult =
  | {
      readonly version: 1;
      readonly outcome: "Appended";
      readonly receipt: ConditionalCommitReceipt;
      readonly writtenEvents: readonly [ConditionalWrittenEvent];
    }
  | {
      readonly version: 1;
      readonly outcome: "AlreadyCommittedSameOperation";
      readonly receipt: ConditionalCommitReceipt;
      readonly writtenEvents: readonly [];
    }
  | {
      readonly version: 1;
      readonly outcome: "KeyReuseConflict";
      readonly code: "conditional_commit_key_reuse_conflict";
      readonly error: "The idempotency key is already bound to a different operation.";
      readonly retryable: false;
    }
  | {
      readonly version: 1;
      readonly outcome: "Unsupported";
      readonly code: "conditional_commit_unsupported";
      readonly error: "Conditional commit is not supported by this deployment.";
      readonly retryable: false;
    };

export type ConditionalCommitErrorResponse =
  | {
      readonly version: 1;
      readonly code: ConditionalCommitValidationCode;
      readonly error: string;
      readonly retryable: false;
    }
  | {
      readonly version: 1;
      readonly code: "conditional_commit_in_doubt";
      readonly error: "The conditional commit outcome is not yet verified; resend the same prepared request.";
      readonly retryable: true;
      readonly reason: ConditionalCommitInDoubtReason;
    }
  | {
      readonly version: 1;
      readonly code: "conditional_commit_committed_state_corrupt";
      readonly error: "The durable conditional commit state could not be verified.";
      readonly retryable: false;
    };

export interface ConditionalCommitFingerprintInput {
  readonly serviceId: string;
  readonly idempotencyKey: string;
  readonly eventPayloadName: string;
  readonly canonicalPayload: Uint8Array;
  readonly tag: string;
}

const VALIDATION_MESSAGES: Readonly<Record<ConditionalCommitValidationCode, string>> = Object.freeze({
  conditional_commit_invalid_json: "The request body is not valid JSON.",
  conditional_commit_unknown_member: "The request contains an unknown member.",
  conditional_commit_invalid_version: "The conditional commit version is not supported.",
  conditional_commit_invalid_envelope: "The conditional commit envelope is invalid.",
  conditional_commit_invalid_key: "The idempotency key is invalid.",
  conditional_commit_invalid_candidate: "The event candidate is invalid.",
  conditional_commit_invalid_base64: "The event payload is not valid base64.",
  conditional_commit_invalid_utf8: "The event payload is not valid UTF-8.",
  conditional_commit_invalid_payload_json: "The event payload is not valid JSON.",
  conditional_commit_payload_root_not_object: "The event payload root must be a plain object.",
  conditional_commit_payload_not_canonicalizable: "The event payload cannot be canonicalized.",
  conditional_commit_event_not_registered: "The event payload name is not registered.",
  conditional_commit_invalid_tag_count: "Conditional commit requires exactly one tag.",
  conditional_commit_size_limit_exceeded: "The conditional commit request exceeds a size limit.",
});

export class ConditionalCommitProtocolError extends Error {
  readonly code: ConditionalCommitValidationCode;
  readonly retryable = false;

  constructor(code: ConditionalCommitValidationCode) {
    super(VALIDATION_MESSAGES[code]);
    this.name = "ConditionalCommitProtocolError";
    this.code = code;
  }
}

function fail(code: ConditionalCommitValidationCode): never {
  throw new ConditionalCommitProtocolError(code);
}

/** Ill-formed UTF-16 must fail before trim, NFC, or UTF-8 replacement. */
function assertWellFormedUtf16(value: string, code: ConditionalCommitValidationCode): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) fail(code);
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) fail(code);
  }
}

function isTrimCodePoint(codePoint: number): boolean {
  return (codePoint >= 0x0009 && codePoint <= 0x000d)
    || codePoint === 0x0020
    || codePoint === 0x0085
    || codePoint === 0x00a0
    || codePoint === 0x1680
    || (codePoint >= 0x2000 && codePoint <= 0x200a)
    || codePoint === 0x2028
    || codePoint === 0x2029
    || codePoint === 0x202f
    || codePoint === 0x205f
    || codePoint === 0x3000;
}

function trimDotNet(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end) {
    const codePoint = value.codePointAt(start);
    if (codePoint === undefined || !isTrimCodePoint(codePoint)) break;
    start += codePoint > 0xffff ? 2 : 1;
  }
  while (end > start) {
    const previous = value.charCodeAt(end - 1);
    let codePoint = previous;
    let width = 1;
    if (previous >= 0xdc00 && previous <= 0xdfff && end >= 2) {
      const high = value.charCodeAt(end - 2);
      if (high >= 0xd800 && high <= 0xdbff) {
        codePoint = value.codePointAt(end - 2) ?? previous;
        width = 2;
      }
    }
    if (!isTrimCodePoint(codePoint)) break;
    end -= width;
  }
  return value.slice(start, end);
}

export function normalizeConditionalCommitKey(value: string): string {
  if (typeof value !== "string") fail("conditional_commit_invalid_key");
  assertWellFormedUtf16(value, "conditional_commit_invalid_key");
  const normalized = trimDotNet(value).normalize("NFC");
  const size = new TextEncoder().encode(normalized).byteLength;
  if (size < 1 || size > CONDITIONAL_COMMIT_MAX_UTF8_FIELD_BYTES) fail("conditional_commit_invalid_key");
  return normalized;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function emitValue(value: unknown, active: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertWellFormedUtf16(value, "conditional_commit_payload_not_canonicalizable");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("conditional_commit_payload_not_canonicalizable");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") fail("conditional_commit_payload_not_canonicalizable");
  if (Array.isArray(value)) return emitArray(value, active);
  if (!isPlainRecord(value)) fail("conditional_commit_payload_not_canonicalizable");
  return emitRecord(value, active);
}

function emitArray(value: unknown[], active: WeakSet<object>): string {
  if (active.has(value)) fail("conditional_commit_payload_not_canonicalizable");
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined
    || lengthDescriptor.enumerable === true
    || lengthDescriptor.get !== undefined
    || lengthDescriptor.set !== undefined
  ) {
    fail("conditional_commit_payload_not_canonicalizable");
  }
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
      fail("conditional_commit_payload_not_canonicalizable");
    }
  }
  const parts: string[] = [];
  active.add(value);
  try {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined
        || descriptor.enumerable !== true
        || descriptor.get !== undefined
        || descriptor.set !== undefined
        || !("value" in descriptor)
      ) {
        fail("conditional_commit_payload_not_canonicalizable");
      }
      parts.push(emitValue(descriptor.value, active));
    }
  } finally {
    active.delete(value);
  }
  return `[${parts.join(",")}]`;
}

/** Object keys are emitted in UTF-16 order. JSON.stringify would reorder integer-like names. */
function emitRecord(value: object, active: WeakSet<object>): string {
  if (active.has(value)) fail("conditional_commit_payload_not_canonicalizable");
  const keys = Reflect.ownKeys(value);
  const names: string[] = [];
  const values = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string") fail("conditional_commit_payload_not_canonicalizable");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || !("value" in descriptor)
    ) {
      fail("conditional_commit_payload_not_canonicalizable");
    }
    names.push(key);
    values.set(key, descriptor.value);
  }
  names.sort();
  const parts: string[] = [];
  active.add(value);
  try {
    for (const key of names) {
      parts.push(`${JSON.stringify(key)}:${emitValue(values.get(key), active)}`);
    }
  } finally {
    active.delete(value);
  }
  return `{${parts.join(",")}}`;
}

export function canonicalizeConditionalCommitPayload(value: unknown): Uint8Array {
  if (!isPlainRecord(value)) fail("conditional_commit_payload_root_not_object");
  const bytes = new TextEncoder().encode(emitRecord(value, new WeakSet()));
  if (bytes.byteLength > CONDITIONAL_COMMIT_MAX_PAYLOAD_BYTES) fail("conditional_commit_size_limit_exceeded");
  return bytes;
}

function appendInt32BE(target: number[], value: number): void {
  if (!Number.isSafeInteger(value) || value < INT32_MIN || value > INT32_MAX) {
    fail("conditional_commit_size_limit_exceeded");
  }
  target.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function appendUtf8(target: number[], value: string, code: ConditionalCommitValidationCode, maxBytes?: number): void {
  if (typeof value !== "string") fail(code);
  assertWellFormedUtf16(value, code);
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength < 1) fail(code);
  if (maxBytes !== undefined && bytes.byteLength > maxBytes) fail("conditional_commit_size_limit_exceeded");
  appendInt32BE(target, bytes.byteLength);
  for (const byte of bytes) target.push(byte);
}

function appendPayload(target: number[], payload: Uint8Array): void {
  if (!(payload instanceof Uint8Array)) fail("conditional_commit_payload_not_canonicalizable");
  if (!Number.isSafeInteger(payload.byteLength) || payload.byteLength < 0) {
    fail("conditional_commit_size_limit_exceeded");
  }
  if (payload.byteLength > CONDITIONAL_COMMIT_MAX_PAYLOAD_BYTES) fail("conditional_commit_size_limit_exceeded");
  appendInt32BE(target, payload.byteLength);
  for (let index = 0; index < payload.byteLength; index += 1) {
    const byte = payload[index];
    if (byte === undefined) fail("conditional_commit_payload_not_canonicalizable");
    target.push(byte);
  }
}

export function conditionalCommitFingerprintPreimage(input: ConditionalCommitFingerprintInput): Uint8Array {
  if (typeof input !== "object" || input === null) fail("conditional_commit_invalid_envelope");
  const key = normalizeConditionalCommitKey(input.idempotencyKey);
  const bytes: number[] = [];
  appendInt32BE(bytes, CONDITIONAL_COMMIT_DERIVATION_VERSION);
  appendInt32BE(bytes, CONDITIONAL_COMMIT_CANONICALIZATION_VERSION);
  appendUtf8(bytes, CONDITIONAL_COMMIT_DOMAIN_SEPARATOR, "conditional_commit_invalid_envelope");
  appendUtf8(bytes, input.serviceId, "conditional_commit_invalid_envelope");
  appendUtf8(bytes, key, "conditional_commit_invalid_key", CONDITIONAL_COMMIT_MAX_UTF8_FIELD_BYTES);
  appendUtf8(bytes, input.eventPayloadName, "conditional_commit_invalid_candidate", CONDITIONAL_COMMIT_MAX_UTF8_FIELD_BYTES);
  appendPayload(bytes, input.canonicalPayload);
  appendInt32BE(bytes, 1);
  appendUtf8(bytes, input.tag, "conditional_commit_invalid_candidate", CONDITIONAL_COMMIT_MAX_UTF8_FIELD_BYTES);
  return Uint8Array.from(bytes);
}

export async function computeConditionalCommitFingerprint(input: ConditionalCommitFingerprintInput): Promise<string> {
  const preimage = conditionalCommitFingerprintPreimage(input);
  const buffer = new ArrayBuffer(preimage.byteLength);
  new Uint8Array(buffer).set(preimage);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

const REQUEST_KEYS = ["version", "idempotencyKey", "eventCandidate"] as const;
const CANDIDATE_KEYS = ["payload", "eventPayloadName", "tags"] as const;

function descriptorValue(value: object, key: string, code: ConditionalCommitValidationCode): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined
    || descriptor.enumerable !== true
    || descriptor.get !== undefined
    || descriptor.set !== undefined
    || !("value" in descriptor)
  ) {
    fail(code);
  }
  return descriptor.value;
}

function assertClosedKeys(value: object, allowed: readonly string[], shapeCode: ConditionalCommitValidationCode): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) fail("conditional_commit_unknown_member");
    descriptorValue(value, key, shapeCode);
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(shapeCode);
  }
}

function readTag(value: unknown): string {
  if (!Array.isArray(value)) fail("conditional_commit_invalid_candidate");
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) fail("conditional_commit_unknown_member");
  if (value.length !== 1) fail("conditional_commit_invalid_tag_count");
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined
    || lengthDescriptor.enumerable === true
    || lengthDescriptor.get !== undefined
    || lengthDescriptor.set !== undefined
  ) {
    fail("conditional_commit_invalid_candidate");
  }
  for (const key of keys) {
    if (key === "length") continue;
    if (key !== "0") fail("conditional_commit_invalid_candidate");
  }
  const tag = descriptorValue(value, "0", "conditional_commit_invalid_candidate");
  if (typeof tag !== "string") fail("conditional_commit_invalid_candidate");
  return tag;
}

function boundedField(value: unknown, code: ConditionalCommitValidationCode): string {
  if (typeof value !== "string") fail(code);
  assertWellFormedUtf16(value, code);
  const size = new TextEncoder().encode(value).byteLength;
  if (size < 1) fail(code);
  if (size > CONDITIONAL_COMMIT_MAX_UTF8_FIELD_BYTES) fail("conditional_commit_size_limit_exceeded");
  return value;
}

function encodeBase64(bytes: Uint8Array): string {
  let output = "";
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const chunk = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    output += BASE64_ALPHABET[(chunk >>> 18) & 63]
      + BASE64_ALPHABET[(chunk >>> 12) & 63]
      + BASE64_ALPHABET[(chunk >>> 6) & 63]
      + BASE64_ALPHABET[chunk & 63];
  }
  if (index < bytes.length) {
    const first = bytes[index] ?? 0;
    const second = index + 1 < bytes.length ? bytes[index + 1] ?? 0 : 0;
    const chunk = (first << 16) | (second << 8);
    output += BASE64_ALPHABET[(chunk >>> 18) & 63];
    output += BASE64_ALPHABET[(chunk >>> 12) & 63];
    output += index + 1 < bytes.length ? BASE64_ALPHABET[(chunk >>> 6) & 63] : "=";
    output += "=";
  }
  return output;
}

function decodeCanonicalBase64(text: string): Uint8Array {
  if (typeof text !== "string" || text.length === 0 || text.length % 4 !== 0) fail("conditional_commit_invalid_base64");
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  if (padding === 1 && text.endsWith("==")) fail("conditional_commit_invalid_base64");
  const body = text.slice(0, text.length - padding);
  if (body.includes("=")) fail("conditional_commit_invalid_base64");
  for (const char of body) {
    if (!BASE64_INDEX.has(char)) fail("conditional_commit_invalid_base64");
  }
  const decodedLength = (text.length / 4) * 3 - padding;
  if (!Number.isSafeInteger(decodedLength) || decodedLength < 0) fail("conditional_commit_invalid_base64");
  if (decodedLength > CONDITIONAL_COMMIT_MAX_PAYLOAD_BYTES) fail("conditional_commit_size_limit_exceeded");
  const bytes = new Uint8Array(decodedLength);
  let offset = 0;
  for (let index = 0; index < text.length; index += 4) {
    const last = index + 4 >= text.length;
    const a = BASE64_INDEX.get(text[index] ?? "");
    const b = BASE64_INDEX.get(text[index + 1] ?? "");
    const cChar = text[index + 2] ?? "";
    const dChar = text[index + 3] ?? "";
    const c = last && cChar === "=" ? 0 : BASE64_INDEX.get(cChar);
    const d = last && dChar === "=" ? 0 : BASE64_INDEX.get(dChar);
    if (a === undefined || b === undefined || c === undefined || d === undefined) fail("conditional_commit_invalid_base64");
    const chunk = (a << 18) | (b << 12) | (c << 6) | d;
    const produced = last ? 3 - padding : 3;
    bytes[offset] = (chunk >>> 16) & 0xff;
    if (produced > 1) bytes[offset + 1] = (chunk >>> 8) & 0xff;
    if (produced > 2) bytes[offset + 2] = chunk & 0xff;
    offset += produced;
  }
  if (offset !== decodedLength || encodeBase64(bytes) !== text) fail("conditional_commit_invalid_base64");
  return bytes;
}

function decodeStrictUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("conditional_commit_invalid_utf8");
  }
}

export function parseSerializedConditionalCommitRequest(value: unknown): SerializedConditionalCommitRequest {
  if (!isPlainRecord(value)) fail("conditional_commit_invalid_envelope");
  assertClosedKeys(value, REQUEST_KEYS, "conditional_commit_invalid_envelope");
  if (descriptorValue(value, "version", "conditional_commit_invalid_envelope") !== 1) {
    fail("conditional_commit_invalid_version");
  }
  const idempotencyKey = normalizeConditionalCommitKey(
    descriptorValue(value, "idempotencyKey", "conditional_commit_invalid_key") as string,
  );
  const candidate = descriptorValue(value, "eventCandidate", "conditional_commit_invalid_candidate");
  if (!isPlainRecord(candidate)) fail("conditional_commit_invalid_candidate");
  assertClosedKeys(candidate, CANDIDATE_KEYS, "conditional_commit_invalid_candidate");
  const payloadText = descriptorValue(candidate, "payload", "conditional_commit_invalid_candidate");
  if (typeof payloadText !== "string") fail("conditional_commit_invalid_candidate");
  const eventPayloadName = boundedField(
    descriptorValue(candidate, "eventPayloadName", "conditional_commit_invalid_candidate"),
    "conditional_commit_invalid_candidate",
  );
  const tag = boundedField(readTag(descriptorValue(candidate, "tags", "conditional_commit_invalid_candidate")), "conditional_commit_invalid_candidate");
  const decoded = decodeCanonicalBase64(payloadText);
  const jsonText = decodeStrictUtf8(decoded);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    fail("conditional_commit_invalid_payload_json");
  }
  if (!isPlainRecord(parsed)) fail("conditional_commit_payload_root_not_object");
  canonicalizeConditionalCommitPayload(parsed);
  return {
    version: 1,
    idempotencyKey,
    eventCandidate: {
      payload: payloadText,
      eventPayloadName,
      tags: [tag],
    },
  };
}

export function parseSerializedConditionalCommitRequestBody(body: string | Uint8Array): SerializedConditionalCommitRequest {
  let text: string;
  if (typeof body === "string") {
    assertWellFormedUtf16(body, "conditional_commit_invalid_json");
    if (new TextEncoder().encode(body).byteLength > CONDITIONAL_COMMIT_MAX_REQUEST_BYTES) {
      fail("conditional_commit_size_limit_exceeded");
    }
    text = body;
  } else if (body instanceof Uint8Array) {
    if (body.byteLength > CONDITIONAL_COMMIT_MAX_REQUEST_BYTES) fail("conditional_commit_size_limit_exceeded");
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      fail("conditional_commit_invalid_json");
    }
  } else {
    fail("conditional_commit_invalid_json");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("conditional_commit_invalid_json");
  }
  return parseSerializedConditionalCommitRequest(value);
}
