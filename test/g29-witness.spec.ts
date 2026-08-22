import { describe, expect, it } from "vitest";
import { assertSourceCommit, assertWitnessStable } from "../scripts/deploy/g29-witness.mjs";
import { summarizeMeasurements } from "../scripts/deploy/g29-measure.mjs";

const expected = {
  worker: "sekiban-dcb-meeting-room-cloudflare-only",
  serviceId: "g25-38219c8-20260820f",
  viewCount: 2,
  allowedViews: ["RoomProjector", "ReservationProjector"],
  domainDeliveryClass: "immediate-preferred",
  resolvedDeliveryClass: "immediate-preferred",
  domainViewDeliveryClasses: { RoomProjector: "immediate-preferred", ReservationProjector: "immediate-preferred" },
  directDoorbell: true,
  receiverMode: "separate",
  degradation: "queued-degraded",
  maxServiceBindingInvocations: 32,
  pipelineDatabaseId: "3c3b1641-7969-4d72-97a9-2ea65085c9bb",
  materializedViewDatabaseId: "5db45136-f1dd-4f4d-bfe3-b6328193a1ac",
  queue: "sekiban-dcb-meeting-room-cloudflare-outbox",
  generation: "v2",
};

const legacyExpected = {
  ...expected,
  allowedViews: ["RoomProjector"],
  domainViewDeliveryClasses: { RoomProjector: "immediate-preferred", ReservationProjector: "queued" },
};

function witness() {
  return {
    ...expected,
    identityVerified: true,
    sourceCommit: "c".repeat(40),
    data: { digest: "data-witness", rows: [{ id: "fixture", status: "created" }], heads: { fixture: "suid-1" }, counts: { rows: 1 }, list: ["fixture"] },
    rawV1: { status: 404 },
  };
}

describe("SDT-G29 witnessed deploy and measurement oracles", () => {
  it("requires stable topology, raw V1 closure, and data witness", () => {
    expect(assertWitnessStable(witness(), witness(), expected).stable).toBe(true);
    expect(() => assertWitnessStable({ ...witness(), serviceId: "fresh-service" }, witness(), expected)).toThrow("serviceId");
    expect(() => assertWitnessStable(witness(), { ...witness(), data: { digest: "changed" } }, expected)).toThrow("data witness");
    expect(() => assertWitnessStable(witness(), { ...witness(), data: { digest: "data-witness", rows: [{ id: "fixture", status: "released" }], heads: { fixture: "suid-1" }, counts: { rows: 1 }, list: ["fixture"] } }, expected)).toThrow("raw data witness");
    expect(() => assertWitnessStable(witness(), { ...witness(), rawV1: { status: 200 } }, expected)).toThrow("public V1");
    expect(() => assertWitnessStable({ ...witness(), identityVerified: false }, witness(), expected)).toThrow("full G29 topology");
    expect(assertSourceCommit(witness(), "c".repeat(40))).toEqual({ sourceCommit: "c".repeat(40), match: true });
    expect(() => assertSourceCommit(witness(), "d".repeat(40))).toThrow("sourceCommit mismatch");
  });

  it("allows only the declared C3-to-C4 delivery policy transition", () => {
    const legacy = { ...witness(), ...legacyExpected };
    expect(assertWitnessStable(legacy, witness(), expected, legacyExpected).stable).toBe(true);
    expect(() => assertWitnessStable({ ...legacy, serviceId: "other-service" }, witness(), expected, legacyExpected)).toThrow("before");
    expect(() => assertWitnessStable(legacy, { ...witness(), domainViewDeliveryClasses: legacyExpected.domainViewDeliveryClasses }, expected, legacyExpected)).toThrow("after");
  });

  it("keeps three timing distributions and status/fallback raw evidence", () => {
    const values = Array.from({ length: 10 }, (_, index) => ({
      commandStartToResponseMs: 1200 + index,
      responseToVisibleMs: 100 + index,
      commandStartToVisibleMs: 1300 + index,
      status: 200,
      kind: "committed",
      fallback: false,
    }));
    const summary = summarizeMeasurements(values);
    expect(summary.sampleCount).toBe(10);
    expect(summary.commandStartToResponseMs.samples).toBe(10);
    expect(summary.responseToVisibleMs.p50).toBe(104);
    expect(summary.commandStartToVisibleMs.p50).toBe(1304);
    expect(summary.errorCount).toBe(0);
    expect(summary.fallbackCount).toBe(0);
    expect(summary.statusRaw).toHaveLength(10);
  });
});
