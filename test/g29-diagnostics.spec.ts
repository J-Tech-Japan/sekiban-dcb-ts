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

describe("SDT-G29 raw diagnostic axes", () => {
  it("keeps six raw fields and derives the four-way quadrant", () => {
    expect(rawDiagnosticFields()).toEqual([
      "rawSourceTimestamp", "observedTimestamp", "checkpoint", "head", "expectedVersion", "actualVersion",
    ]);
    expect(diagnosticQuadrant(assertRawDiagnosticContract(fixture))).toBe("source-before-observed_checkpoint-behind-head");
    expect(diagnosticQuadrant(assertRawDiagnosticContract({ ...fixture, rawSourceTimestamp: 200, checkpoint: "suid-2" })))
      .toBe("source-after-observed_checkpoint-at-head");
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
