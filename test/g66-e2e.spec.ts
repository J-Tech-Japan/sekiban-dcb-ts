import { describe, expect, it } from "vitest";
import { inspectG66Receipt } from "../scripts/g66-e2e-guard.mjs";

type G66Fixture = {
  schema: string;
  contract: { coldFirst: boolean; minimumInterSampleMs: number };
  healthSnapshots: G66HealthSnapshot[];
  commands: G66Command[];
};

type G66HealthSnapshot = {
  coverage: { kind: string };
  coverageHistory: unknown[] | null;
  safeLanePasses: unknown[];
};

type G66Command = {
  commit: {
    status: number;
    kind: string;
    suid: string;
    responseMs: number;
    executor: { readMode: string };
  };
  healthSnapshots: G66HealthSnapshot[];
  tagReads: Array<{ status: number }>;
  queryReads: { room: { status: number }; reservations: { status: number } };
  unsafe: { disposition: string };
  safe: { disposition: string };
};

function fixture(): G66Fixture {
  const health = { coverage: { kind: "SETTLED" }, coverageHistory: [], safeLanePasses: [] };
  return {
    schema: "sdt-g66-public-e2e/v1",
    contract: { coldFirst: true, minimumInterSampleMs: 10_000 },
    healthSnapshots: [health],
    commands: Array.from({ length: 10 }, (_, index) => ({
      commit: { status: 200, kind: "committed", suid: String(index + 1).padStart(30, "0"), responseMs: 1, executor: { readMode: index === 0 ? "read-through" : "snapshot-only" } },
      healthSnapshots: [health],
      tagReads: [{ status: 200 }],
      queryReads: { room: { status: 200 }, reservations: { status: 200 } },
      unsafe: { disposition: "pass" },
      safe: { disposition: "pass" },
    })),
  };
}

describe("SDT-G66 public e2e guard", () => {
  it("accepts a complete cold-first receipt", () => {
    expect(inspectG66Receipt(fixture()).passed).toBe(true);
  });

  it("fails closed for censored safe visibility", () => {
    const receipt = fixture();
    receipt.commands[0].safe = { disposition: "censored" };
    expect(inspectG66Receipt(receipt).passed).toBe(false);
  });

  it("rejects a paused command and missing per-tick coverage", () => {
    const receipt = fixture();
    receipt.commands[0].commit.status = 504;
    expect(() => inspectG66Receipt(receipt)).toThrow();
    const coverage = fixture();
    coverage.commands[0].healthSnapshots[0].coverageHistory = null;
    expect(() => inspectG66Receipt(coverage)).toThrow();
  });
});
