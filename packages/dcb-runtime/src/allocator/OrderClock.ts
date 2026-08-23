import {
  DOTNET_MAX_TICKS,
  SORTABLE_UNIQUE_ID_DIGITS,
  SortableUniqueIdError,
  assertSortableUniqueId,
  cryptoRandomSortableUniqueIdSuffix,
  dotNetTicksToUnixMs,
  formatSortableUniqueId,
  unixMsToDotNetTicks,
} from "./SortableUniqueId";

/**
 * The only allocator time seam. A tick is a Unix millisecond; conversion to
 * the .NET tick representation happens exactly once at allocation admission.
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

/** Compatibility export names now denote the C# fixed-width 30-digit format. */
export const ORDER_SUID_DIGITS = SORTABLE_UNIQUE_ID_DIGITS;
export const ORDER_SUID_PREFIX = "";
export const ORDER_SUID_LIMIT = DOTNET_MAX_TICKS + 1n;

/** @deprecated Use formatSortableUniqueId. The ordinal is a .NET tick value. */
export function encodeOrderOrdinal(value: bigint): string {
  return formatSortableUniqueId(value, 0n);
}

/** @deprecated Use assertSortableUniqueId(value).ticks. */
export function decodeOrderOrdinal(value: string): bigint {
  try {
    return assertSortableUniqueId(value).ticks;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid SortableUniqueId";
    throw new OrderClockReadError(detail, { cause: error });
  }
}

export interface OrderAllocationRange {
  /** Logical .NET tick allocation base. */
  readonly base: bigint;
  readonly baseTicks: bigint;
  readonly physicalTicks: bigint;
  readonly observedTicks: bigint | null;
  readonly watermark: string;
  readonly suids: readonly string[];
}

export interface OrderAllocationOptions {
  /** Deterministic test injection; production omits this and uses crypto. */
  readonly suffixes?: readonly bigint[];
}

function asOrderClockError(error: unknown): OrderClockReadError {
  if (error instanceof OrderClockReadError) return error;
  const detail = error instanceof Error ? error.message : "SortableUniqueId allocation failed";
  return new OrderClockReadError(detail, { cause: error });
}

/**
 * Pure range oracle used by the DO and deterministic fixtures. Watermark
 * authority is only its leading nineteen tick digits; its random suffix is
 * retained durably for replay but never participates in the monotone base.
 */
export function allocateOrderRange(
  watermark: string | null,
  count: number,
  clockTick: bigint,
  options: OrderAllocationOptions = {},
): OrderAllocationRange {
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new OrderClockReadError("An order allocation requires a positive candidate count");
  }
  try {
    const physicalTicks = unixMsToDotNetTicks(clockTick);
    const observedTicks = watermark === null ? null : assertSortableUniqueId(watermark).ticks;
    const baseTicks = observedTicks === null || physicalTicks > observedTicks + 1n
      ? physicalTicks
      : observedTicks + 1n;
    const lastTicks = baseTicks + BigInt(count) - 1n;
    if (lastTicks > DOTNET_MAX_TICKS) {
      throw new SortableUniqueIdError("SUID_RANGE_EXHAUSTED", "Allocator SortableUniqueId range is exhausted before write");
    }
    if (options.suffixes !== undefined && options.suffixes.length !== count) {
      throw new OrderClockReadError("A deterministic SortableUniqueId suffix is required for every candidate");
    }
    const suids = Array.from({ length: count }, (_, index) =>
      formatSortableUniqueId(baseTicks + BigInt(index), options.suffixes?.[index] ?? cryptoRandomSortableUniqueIdSuffix()),
    );
    return Object.freeze({
      base: baseTicks,
      baseTicks,
      physicalTicks,
      observedTicks,
      watermark: suids.at(-1)!,
      suids: Object.freeze(suids),
    });
  } catch (error) {
    if (error instanceof SortableUniqueIdError) throw error;
    throw asOrderClockError(error);
  }
}

/** Diagnostic only; it derives from allocated ticks, never a second clock. */
export function diagnosticAllocatedAt(ticks: bigint): string {
  try {
    const milliseconds = dotNetTicksToUnixMs(ticks);
    if (milliseconds <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return new Date(Number(milliseconds)).toISOString();
    }
  } catch {
    // Preserve a non-authoritative diagnostic for values beyond Date's range.
  }
  return `ticks:${ticks.toString()}`;
}
