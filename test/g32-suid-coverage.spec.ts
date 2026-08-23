import { describe, expect, it } from "vitest";
// @ts-expect-error The fixture is an independently reviewable allocator oracle table.
import goldenSource from "../fixtures/suid-allocator-golden.json?raw";

type Golden = { readonly requiredRowIds: readonly string[] };
const golden = JSON.parse(goldenSource as string) as Golden;

/**
 * This list is intentionally explicit instead of deriving from the fixture.
 * A new fixture row cannot turn the coverage gate green until it gets a named
 * oracle below and an implementation assertion in g32-parity.spec.ts.
 */
export const G32_SUID_ORACLE_ROWS = Object.freeze([
  { rowId: "M1", oracle: "full-30-digit-watermark-decode" },
  { rowId: "M2", oracle: "unix-ms-to-dotnet-ticks" },
  { rowId: "M2a", oracle: "physical-ticks-branch" },
  { rowId: "M2b", oracle: "observed-plus-one-branch" },
  { rowId: "M3", oracle: "bigint-before-multiply" },
  { rowId: "M4", oracle: "attempt-replay-vector" },
  { rowId: "M5", oracle: "atomic-vector-watermark-write" },
  { rowId: "M6", oracle: "old-state-fail-before-write" },
  { rowId: "M7", oracle: "ceiling-fail-before-write" },
  { rowId: "M8", oracle: "twenty-second-safewindow-ticks" },
  { rowId: "M9", oracle: "all-ingress-30-digit-gates" },
  { rowId: "M10", oracle: "clock-failure-zero-diff" },
  { rowId: "M11", oracle: "rollback-warning-window" },
  { rowId: "M12", oracle: "clock-not-business-order" },
] as const);

describe("SDT-G32 SUID oracle coverage", () => {
  it("has a one-to-one named oracle for every immutable allocator fixture row", () => {
    const expected = [...golden.requiredRowIds].sort();
    const actual = G32_SUID_ORACLE_ROWS.map((entry) => entry.rowId).sort();
    expect(new Set(actual).size).toBe(actual.length);
    expect(actual).toEqual(expected);
  });
});
