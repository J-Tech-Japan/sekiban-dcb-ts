import { describe, expect, it } from "vitest";
import { assertRawDiagnosticContract, diagnosticQuadrant, rawDiagnosticFields } from "../samples/meeting-room/src/raw-diagnostics";

const fixture = {
  rawSourceTimestamp: 100,
  observedTimestamp: 120,
  checkpoint: "suid-1",
  head: "suid-2",
  expectedVersion: 3,
  actualVersion: 2,
};

const quadrants = [
  {
    id: "source-before-observed_checkpoint-behind-head",
    value: fixture,
  },
  {
    id: "source-before-observed_checkpoint-at-head",
    value: { ...fixture, checkpoint: "suid-2" },
  },
  {
    id: "source-after-observed_checkpoint-behind-head",
    value: { ...fixture, rawSourceTimestamp: 200 },
  },
  {
    id: "source-after-observed_checkpoint-at-head",
    value: { ...fixture, rawSourceTimestamp: 200, checkpoint: "suid-2" },
  },
] as const;

describe("SDT-G29 raw diagnostic axes", () => {
  it("keeps six raw fields", () => {
    expect(rawDiagnosticFields()).toEqual([
      "rawSourceTimestamp", "observedTimestamp", "checkpoint", "head", "expectedVersion", "actualVersion",
    ]);
  });

  it.each(quadrants)("derives the independent $id quadrant", ({ id, value }) => {
    expect(diagnosticQuadrant(assertRawDiagnosticContract(value))).toBe(id);
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
