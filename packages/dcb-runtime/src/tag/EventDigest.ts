/**
 * Runtime implementation of the packet-owned G43 eventDigest v2 byte
 * contract. The companion checker deliberately reimplements this framing
 * from `contracts/g43-digest-spec.json`; do not share helpers with it.
 */
export const EVENT_DIGEST_DOMAIN_SEPARATOR = "sekiban-dcb-ts/eventDigest/v2";

export interface EventDigestInput {
  readonly serviceId: string;
  readonly eventId: string;
  readonly sortableUniqueId: string;
  readonly eventType: string;
  /** Exact persisted UTC spelling; this encoder never reparses it. */
  readonly timestamp: string;
  readonly allocatorLineageId?: string;
  readonly attemptId: string;
  readonly declaredTagSet: readonly string[];
  /** Exact persisted payload bytes. Never decoded or text-normalised. */
  readonly payload: Uint8Array;
  /** Closed, explicitly excluded delivery-envelope fields. */
  readonly causationId?: unknown;
  readonly correlationId?: unknown;
  readonly executedUser?: unknown;
}

export class EventDigestValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "EventDigestValidationError";
  }
}

const encoder = new TextEncoder();
const requiredFieldNames = [
  "serviceId",
  "eventId",
  "sortableUniqueId",
  "eventType",
  "timestamp",
  "attemptId",
  "declaredTagSet",
  "payload",
] as const;
const optionalFieldNames = ["allocatorLineageId"] as const;
const excludedFieldNames = ["causationId", "correlationId", "executedUser"] as const;
const allowedFieldNames = new Set<string>([...requiredFieldNames, ...optionalFieldNames, ...excludedFieldNames]);

function byteCompare(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const delta = left[index]! - right[index]!;
    if (delta !== 0) return delta;
  }
  return left.byteLength - right.byteLength;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function lengthPrefix(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffff_ffff) {
    throw new EventDigestValidationError("eventDigest field length is outside uint32 range");
  }
  return Uint8Array.of(
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
  );
}

function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

function hasOwn(input: object, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, name);
}

function requiredUtf8(input: EventDigestInput, name: (typeof requiredFieldNames)[number]): Uint8Array {
  const value = input[name];
  if (typeof value !== "string") {
    throw new EventDigestValidationError(`eventDigest required field ${name} is absent or not a string`);
  }
  return utf8(value);
}

function tagSetBytes(tags: readonly string[]): Uint8Array {
  const canonical = canonicalDeclaredTagSet(tags);
  return concat(canonical.map((tag) => {
    const bytes = utf8(tag);
    return concat([lengthPrefix(bytes.byteLength), bytes]);
  }));
}

/**
 * Canonical set semantics are intentionally byte based: sorting uses UTF-8
 * code units and exact byte-equal duplicates collapse to one element. Empty
 * tag strings are representable by the byte contract even though normal tag
 * admission rejects them before an event reaches this encoder.
 */
export function canonicalDeclaredTagSet(tags: readonly string[]): readonly string[] {
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) {
    throw new EventDigestValidationError("eventDigest declaredTagSet must contain only strings");
  }
  const encoded = tags
    .map((tag) => ({ tag, bytes: utf8(tag) }))
    .sort((left, right) => byteCompare(left.bytes, right.bytes));
  const unique: string[] = [];
  let previous: Uint8Array | undefined;
  for (const item of encoded) {
    if (previous !== undefined && byteCompare(previous, item.bytes) === 0) continue;
    unique.push(item.tag);
    previous = item.bytes;
  }
  return Object.freeze(unique);
}

function assertClosedProjection(input: EventDigestInput): void {
  for (const name of Object.keys(input)) {
    if (!allowedFieldNames.has(name)) {
      throw new EventDigestValidationError(`eventDigest field ${name} is neither included nor explicitly excluded`);
    }
  }
  for (const name of requiredFieldNames) {
    if (!hasOwn(input, name)) {
      throw new EventDigestValidationError(`eventDigest required field ${name} is absent`);
    }
  }
  if (!Array.isArray(input.declaredTagSet)) {
    throw new EventDigestValidationError("eventDigest required field declaredTagSet is absent or invalid");
  }
  if (!(input.payload instanceof Uint8Array)) {
    throw new EventDigestValidationError("eventDigest required field payload is absent or not raw bytes");
  }
  if (hasOwn(input, "allocatorLineageId") && typeof input.allocatorLineageId !== "string") {
    throw new EventDigestValidationError("eventDigest optional field allocatorLineageId must be absent or a string");
  }
}

/** `encodeField` exactly as specified by contracts/g43-digest-spec.json. */
function encodeField(name: string, value: Uint8Array | undefined): Uint8Array {
  const nameBytes = utf8(name);
  const present = value === undefined ? Uint8Array.of(0x00) : Uint8Array.of(0x01);
  const valueBytes = value ?? new Uint8Array();
  return concat([
    present,
    lengthPrefix(nameBytes.byteLength),
    nameBytes,
    lengthPrefix(valueBytes.byteLength),
    valueBytes,
  ]);
}

/**
 * Produces the exact preimage bytes that are stored alongside an obligation.
 * The caller can retain these canonical bytes while `eventDigestHex` hashes
 * them without applying a second serialization.
 */
export function eventDigestBytes(input: EventDigestInput): Uint8Array {
  assertClosedProjection(input);
  const fields: readonly [string, Uint8Array | undefined][] = [
    ["serviceId", requiredUtf8(input, "serviceId")],
    ["eventId", requiredUtf8(input, "eventId")],
    ["sortableUniqueId", requiredUtf8(input, "sortableUniqueId")],
    ["eventType", requiredUtf8(input, "eventType")],
    ["timestamp", requiredUtf8(input, "timestamp")],
    ["allocatorLineageId", hasOwn(input, "allocatorLineageId") ? utf8(input.allocatorLineageId!) : undefined],
    ["attemptId", requiredUtf8(input, "attemptId")],
    ["declaredTagSet", tagSetBytes(input.declaredTagSet)],
    ["payload", input.payload],
  ];
  return concat([
    utf8(EVENT_DIGEST_DOMAIN_SEPARATOR),
    Uint8Array.of(0x00),
    ...fields.map(([name, value]) => encodeField(name, value)),
  ]);
}

export async function eventDigestHex(input: EventDigestInput): Promise<string> {
  const bytes = eventDigestBytes(input);
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", source);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
