/** C# serialized-path constants used by every G32 logical event record. */
export const SERIALIZED_COMMIT_CORRELATION_ID = "SerializedCommit" as const;
export const SERIALIZED_SEKIBAN_EXECUTOR = "SerializedSekibanExecutor" as const;

export interface SerializedEventMetadata {
  readonly causationId: string;
  readonly correlationId: typeof SERIALIZED_COMMIT_CORRELATION_ID;
  readonly executedUser: typeof SERIALIZED_SEKIBAN_EXECUTOR;
}

export function serializedEventMetadata(eventId: string): SerializedEventMetadata {
  return Object.freeze({
    causationId: eventId,
    correlationId: SERIALIZED_COMMIT_CORRELATION_ID,
    executedUser: SERIALIZED_SEKIBAN_EXECUTOR,
  });
}

/**
 * UUID version 7 following the RFC 9562 layout used by Guid.CreateVersion7:
 * 48 bits Unix milliseconds, version 7, RFC4122 variant, then crypto bits.
 */
export function createUuidV7(nowMs: number = Date.now()): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 0xffff_ffff_ffff) {
    throw new Error("UUIDv7 time must be a non-negative 48-bit safe integer");
  }
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new Error("crypto.getRandomValues is required for UUIDv7");
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let time = BigInt(nowMs);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(time & 0xffn);
    time >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isRfc4122Uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isUuidV7(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

/** ISO-8601 UTC spelling required by D1's logical C# record. */
export function writeTimestampUtc(nowMs: number = Date.now()): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Write timestamp requires a non-negative safe Unix millisecond value");
  return new Date(nowMs).toISOString();
}
