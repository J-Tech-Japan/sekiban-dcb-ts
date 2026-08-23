/**
 * Sekiban.Dcb SortableUniqueId parity primitives.
 *
 * A value is deliberately represented as its canonical 30 ASCII decimal
 * characters. The first nineteen characters are .NET DateTime ticks and
 * the final eleven are the allocator-owned random suffix. Keeping both
 * components as bigint avoids accidental IEEE-754 rounding at large clocks.
 */

export const SORTABLE_UNIQUE_ID_TICKS_DIGITS = 19;
export const SORTABLE_UNIQUE_ID_RANDOM_DIGITS = 11;
export const SORTABLE_UNIQUE_ID_DIGITS =
  SORTABLE_UNIQUE_ID_TICKS_DIGITS + SORTABLE_UNIQUE_ID_RANDOM_DIGITS;
export const DOTNET_UNIX_EPOCH_TICKS = 621_355_968_000_000_000n;
export const DOTNET_MAX_TICKS = 3_155_378_975_999_999_999n;
export const DOTNET_TICKS_PER_MILLISECOND = 10_000n;
export const SORTABLE_UNIQUE_ID_RANDOM_LIMIT = 10n ** BigInt(SORTABLE_UNIQUE_ID_RANDOM_DIGITS);
export const MAX_UNIX_MILLISECONDS = (DOTNET_MAX_TICKS - DOTNET_UNIX_EPOCH_TICKS) / DOTNET_TICKS_PER_MILLISECOND;

export type SortableUniqueIdErrorCode =
  | "SUID_INVALID"
  | "SUID_LEGACY_FORMAT_RETIRED"
  | "SUID_TICKS_INVALID"
  | "SUID_RANDOM_INVALID"
  | "SUID_UNIX_MILLISECONDS_INVALID"
  | "SUID_RANGE_EXHAUSTED"
  | "SUID_RANDOM_UNAVAILABLE";

export class SortableUniqueIdError extends Error {
  constructor(
    readonly code: SortableUniqueIdErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SortableUniqueIdError";
  }
}

export interface ParsedSortableUniqueId {
  readonly value: string;
  readonly ticks: bigint;
  readonly random: bigint;
}

/**
 * A G32 ingress must not silently treat an old prefixed SUID as merely an
 * arbitrary malformed string.  Keeping this classification at the one
 * shared validator makes the retired-format boundary observable to every
 * ingress without creating a compatibility lane.
 */
const LEGACY_PREFIXED_SUID = /^suid-[0-9]+$/;

const LEGACY_DECISION_OBSERVER = Symbol.for("@sekiban/dcb-runtime/legacy-sortable-unique-id-observer");
type GlobalWithLegacyDecisionObserver = typeof globalThis & {
  [LEGACY_DECISION_OBSERVER]?: (value: string) => void;
};

function legacyDecisionObserver(): ((value: string) => void) | undefined {
  return (globalThis as GlobalWithLegacyDecisionObserver)[LEGACY_DECISION_OBSERVER];
}

/**
 * Test-only observation seam for the single retired-SUID decision point.
 * Production never installs an observer; the validator still fail-closes
 * before any durable actor is acquired.
 */
export async function observeLegacySortableUniqueIdDecision<T>(
  observer: (value: string) => void,
  run: () => Promise<T> | T,
): Promise<T> {
  const globals = globalThis as GlobalWithLegacyDecisionObserver;
  const previous = globals[LEGACY_DECISION_OBSERVER];
  globals[LEGACY_DECISION_OBSERVER] = observer;
  try {
    return await run();
  } finally {
    globals[LEGACY_DECISION_OBSERVER] = previous;
  }
}

function canonicalDecimal(value: string, name: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new SortableUniqueIdError("SUID_UNIX_MILLISECONDS_INVALID", `${name} must be canonical ASCII decimal text`);
  }
  return BigInt(value);
}

function asUnixMilliseconds(value: number | string | bigint): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SortableUniqueIdError("SUID_UNIX_MILLISECONDS_INVALID", "Unix milliseconds must be a non-negative safe integer");
    }
    return BigInt(value);
  }
  if (typeof value === "string") return canonicalDecimal(value, "Unix milliseconds");
  if (value < 0n) {
    throw new SortableUniqueIdError("SUID_UNIX_MILLISECONDS_INVALID", "Unix milliseconds must be non-negative");
  }
  return value;
}

/** Convert an exact Unix-millisecond value to C# DateTime ticks. */
export function unixMsToDotNetTicks(value: number | string | bigint): bigint {
  const milliseconds = asUnixMilliseconds(value);
  // BigInt conversion intentionally happens before multiplying. Do not
  // collapse this into Number arithmetic: M3 covers the 2^53 boundary.
  const ticks = milliseconds * DOTNET_TICKS_PER_MILLISECOND + DOTNET_UNIX_EPOCH_TICKS;
  if (ticks < 0n || ticks > DOTNET_MAX_TICKS) {
    throw new SortableUniqueIdError("SUID_TICKS_INVALID", "Unix milliseconds are outside the .NET DateTime tick range");
  }
  return ticks;
}

/** Inverse C# parity helper; fractional 100ns ticks truncate toward zero. */
export function dotNetTicksToUnixMs(ticks: bigint): bigint {
  assertDotNetTicks(ticks);
  if (ticks < DOTNET_UNIX_EPOCH_TICKS) {
    throw new SortableUniqueIdError("SUID_TICKS_INVALID", "SortableUniqueId ticks predate the Unix epoch");
  }
  return (ticks - DOTNET_UNIX_EPOCH_TICKS) / DOTNET_TICKS_PER_MILLISECOND;
}

export function assertDotNetTicks(ticks: bigint): bigint {
  // C# uses the fixed-width `TickFormatter` when it serializes a tick.  A
  // numeric tick before the year in which DateTime.Ticks reaches 10^18 is
  // therefore intentionally shorter than nineteen digits before formatting.
  // Validate the numeric .NET range here and the exact 19-character field at
  // the string ingress below.
  if (ticks < 0n || ticks > DOTNET_MAX_TICKS) {
    throw new SortableUniqueIdError("SUID_TICKS_INVALID", "SortableUniqueId ticks are outside the .NET DateTime range");
  }
  return ticks;
}

export function assertSortableUniqueId(value: string): ParsedSortableUniqueId {
  if (typeof value === "string" && LEGACY_PREFIXED_SUID.test(value)) {
    legacyDecisionObserver()?.(value);
    throw new SortableUniqueIdError(
      "SUID_LEGACY_FORMAT_RETIRED",
      "Legacy prefixed SortableUniqueId is retired; G32 requires exactly 30 ASCII decimal digits",
    );
  }
  if (typeof value !== "string" || !new RegExp(`^[0-9]{${SORTABLE_UNIQUE_ID_DIGITS}}$`).test(value)) {
    throw new SortableUniqueIdError("SUID_INVALID", "SortableUniqueId must be exactly 30 ASCII decimal digits");
  }
  const ticksText = value.slice(0, SORTABLE_UNIQUE_ID_TICKS_DIGITS);
  const randomText = value.slice(SORTABLE_UNIQUE_ID_TICKS_DIGITS);
  // Keep the 19-character field check separate from the numeric check.  In
  // particular, `0006213559680000000` is the valid Unix-epoch tick field and
  // must not be rejected merely because BigInt removes its leading zero.
  const ticks = assertDotNetTicks(BigInt(ticksText));
  const random = BigInt(randomText);
  if (random < 0n || random >= SORTABLE_UNIQUE_ID_RANDOM_LIMIT) {
    throw new SortableUniqueIdError("SUID_RANDOM_INVALID", "SortableUniqueId random suffix is outside its 11-digit range");
  }
  return Object.freeze({ value, ticks, random });
}

export function isSortableUniqueId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    assertSortableUniqueId(value);
    return true;
  } catch {
    return false;
  }
}

export function formatSortableUniqueId(ticks: bigint, random: bigint): string {
  assertDotNetTicks(ticks);
  if (random < 0n || random >= SORTABLE_UNIQUE_ID_RANDOM_LIMIT) {
    throw new SortableUniqueIdError("SUID_RANDOM_INVALID", "SortableUniqueId random suffix is outside its 11-digit range");
  }
  return `${ticks.toString().padStart(SORTABLE_UNIQUE_ID_TICKS_DIGITS, "0")}${random.toString().padStart(SORTABLE_UNIQUE_ID_RANDOM_DIGITS, "0")}`;
}

/**
 * C# parity requires a crypto-derived, non-negative 31-bit suffix. The
 * modulo is retained literally because it is part of the required contract.
 */
export function cryptoRandomSortableUniqueIdSuffix(): bigint {
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new SortableUniqueIdError("SUID_RANDOM_UNAVAILABLE", "crypto.getRandomValues is required for SortableUniqueId allocation");
  }
  const words = new Uint32Array(1);
  globalThis.crypto.getRandomValues(words);
  return BigInt(words[0]! & 0x7fff_ffff) % SORTABLE_UNIQUE_ID_RANDOM_LIMIT;
}

export function compareSortableUniqueId(left: string, right: string): number {
  const leftValue = assertSortableUniqueId(left).value;
  const rightValue = assertSortableUniqueId(right).value;
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}
