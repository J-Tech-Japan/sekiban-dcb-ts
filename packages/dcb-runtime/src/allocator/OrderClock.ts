/**
 * The sole allocator time seam.  A tick is the Unix millisecond ordinal; the
 * allocator's durable SUID encoding supplies the fixed 32-digit representation
 * at the persistence boundary.  No request, payload, or provider may replace
 * this authority in production.
 */
export interface OrderClock {
  tick(): bigint;
}

export class OrderClockReadError extends Error {
  readonly code = "ALLOCATOR_ORDER_CLOCK_FAILED" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OrderClockReadError";
  }
}

export const systemOrderClock: OrderClock = Object.freeze({
  tick(): bigint {
    const milliseconds = Date.now();
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new OrderClockReadError("System Unix millisecond clock returned an invalid value");
    }
    return BigInt(milliseconds);
  },
});

export const ORDER_SUID_DIGITS = 32;
export const ORDER_SUID_PREFIX = "suid-";
export const ORDER_SUID_LIMIT = 10n ** BigInt(ORDER_SUID_DIGITS);

export function encodeOrderOrdinal(value: bigint): string {
  if (value < 0n || value >= ORDER_SUID_LIMIT) {
    throw new OrderClockReadError("Order ordinal is outside the 32-digit SUID domain");
  }
  return `${ORDER_SUID_PREFIX}${value.toString().padStart(ORDER_SUID_DIGITS, "0")}`;
}

export function decodeOrderOrdinal(value: string): bigint {
  const digits = value.startsWith(ORDER_SUID_PREFIX) ? value.slice(ORDER_SUID_PREFIX.length) : "";
  if (!new RegExp(`^\\d{${ORDER_SUID_DIGITS}}$`).test(digits)) {
    throw new OrderClockReadError("Allocator watermark is not a valid 32-digit SUID");
  }
  return BigInt(digits);
}

export interface OrderAllocationRange {
  readonly base: bigint;
  readonly watermark: string;
  readonly suids: readonly string[];
}

/** Pure range oracle used by the DO and by deterministic clock fixtures. */
export function allocateOrderRange(
  watermark: string | null,
  count: number,
  clockTick: bigint,
): OrderAllocationRange {
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new OrderClockReadError("An order allocation requires a positive candidate count");
  }
  if (clockTick < 0n || clockTick >= ORDER_SUID_LIMIT) {
    throw new OrderClockReadError("Order clock tick is outside the 32-digit SUID domain");
  }
  const watermarkOrdinal = watermark === null ? -1n : decodeOrderOrdinal(watermark);
  const base = clockTick > watermarkOrdinal + 1n ? clockTick : watermarkOrdinal + 1n;
  const endExclusive = base + BigInt(count);
  if (endExclusive > ORDER_SUID_LIMIT) {
    throw new OrderClockReadError("Allocator SUID range is exhausted");
  }
  const suids = Array.from({ length: count }, (_, index) => encodeOrderOrdinal(base + BigInt(index)));
  return Object.freeze({ base, watermark: suids[suids.length - 1]!, suids: Object.freeze(suids) });
}

/** Diagnostic only: derived from the allocated ordinal, never a second clock. */
export function diagnosticAllocatedAt(orderOrdinal: bigint): string {
  const milliseconds = Number(orderOrdinal);
  if (Number.isSafeInteger(milliseconds) && milliseconds >= 0 && milliseconds <= 8_640_000_000_000_000) {
    return new Date(milliseconds).toISOString();
  }
  return `order:${encodeOrderOrdinal(orderOrdinal)}`;
}
