import { describe, expect, it } from "vitest";
import { assertRawDiagnosticContract, diagnosticQuadrant, rawDiagnosticFields } from "../samples/meeting-room/src/raw-diagnostics";

const quadrants = [
  {
    id: "fresh-version-match",
    value: { rawSourceTimestamp: 100, observedTimestamp: 120, checkpoint: "suid-1", head: "suid-2", expectedVersion: 2, actualVersion: 2 },
  },
  {
    id: "fresh-version-mismatch",
    value: { rawSourceTimestamp: 101, observedTimestamp: 120, checkpoint: "suid-2", head: "suid-2", expectedVersion: 3, actualVersion: 2 },
  },
  {
    id: "stale-version-match",
    value: { rawSourceTimestamp: 200, observedTimestamp: 120, checkpoint: "suid-3", head: "suid-4", expectedVersion: 2, actualVersion: 2 },
  },
  {
    id: "stale-version-mismatch",
    value: { rawSourceTimestamp: 201, observedTimestamp: 120, checkpoint: "suid-4", head: "suid-4", expectedVersion: 4, actualVersion: 2 },
  },
] as const;

const fixture = quadrants[1].value;

describe("SDT-G29 raw diagnostic axes", () => {
  it("keeps six raw fields", () => {
    expect(rawDiagnosticFields()).toEqual([
      "rawSourceTimestamp", "observedTimestamp", "checkpoint", "head", "expectedVersion", "actualVersion",
    ]);
  });

  it.each(quadrants)("derives the independent $id quadrant", ({ id, value }) => {
    const parsed = assertRawDiagnosticContract(value);
    expect(parsed).toEqual(value);
    expect(diagnosticQuadrant(parsed)).toBe(id);
  });

  it.each([
    "rawSourceTimestamp", "observedTimestamp", "checkpoint", "head", "expectedVersion", "actualVersion",
  ])("fails at the dropped raw field %s", (field) => {
    const copy = { ...fixture };
    delete copy[field as keyof typeof copy];
    expect(() => assertRawDiagnosticContract(copy)).toThrow(`G29_DIAGNOSTIC_FIELD_MISSING:${field}`);
  });

  it("rejects merged axes and caller-provided derived enum authority", () => {
    expect(() => assertRawDiagnosticContract({ ...fixture, axis: "checkpoint" })).toThrow("G29_DIAGNOSTIC_DERIVED_FIELD_FORBIDDEN:axis");
    expect(() => assertRawDiagnosticContract({ ...fixture, quadrant: "wrong" })).toThrow("G29_DIAGNOSTIC_DERIVED_FIELD_FORBIDDEN:quadrant");
  });
});
