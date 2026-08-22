import { describe, expect, it } from "vitest";
import { assertSourceCommit, assertWitnessStable } from "../scripts/deploy/g29-witness.mjs";
import { summarizeMeasurements } from "../scripts/deploy/g29-measure.mjs";
// @ts-expect-error JavaScript topology CLI is exercised directly by Vitest.
import { assertPrimaryConsumerExclusive, needsReceiverConsumerRemoval } from "../scripts/deploy/g29-receiver-consumer-topology.mjs";
// @ts-expect-error Vite raw receiver deployment config fixture.
import receiverDeployConfigText from "../samples/meeting-room/wrangler.meeting-room-doorbell-production.jsonc?raw";
// @ts-expect-error Vite raw primary deployment config fixture.
import primaryDeployConfigText from "../samples/meeting-room/wrangler.cloudflare-only-doorbell.jsonc?raw";
// @ts-expect-error Vite raw deployment script fixture.
import deployScriptText from "../scripts/deploy/g29-deploy-witness.sh?raw";

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
    data: {
      digest: "data-witness",
      listQuery: { status: 200, body: { resultJson: "{\"count\":1,\"scope\":\"fixture\",\"nested\":{\"count\":7}}" } },
      reservationList: { status: 200, body: { itemsJson: "[{\"reservationId\":\"fixture-reservation\",\"roomId\":\"fixture-room\",\"status\":\"reserved\",\"version\":1}]", totalCount: 1, currentPage: 1, pageSize: 100 } },
      knownRooms: [{ roomId: "fixture-room", status: 200, body: { state: { roomId: "fixture-room", status: "created" }, lastSortedUniqueId: "suid-room" } }],
      knownReservations: [{ reservationId: "fixture-reservation", status: 200, body: { state: { reservationId: "fixture-reservation", status: "reserved" }, lastSortedUniqueId: "suid-reservation" } }],
      eventHeads: { rooms: { "fixture-room": "suid-room" }, reservations: { "fixture-reservation": "suid-reservation" } },
    },
    rawV1: { status: 404 },
  };
}

describe("SDT-G29 witnessed deploy and measurement oracles", () => {
  it("requires stable topology, raw V1 closure, and preservation of the pre-captured witness set", () => {
    expect(assertWitnessStable(witness(), witness(), expected).stable).toBe(true);
    expect(() => assertWitnessStable({ ...witness(), serviceId: "fresh-service" }, witness(), expected)).toThrow("serviceId");
    const added = witness();
    added.data.reservationList.body.itemsJson = "[{\"reservationId\":\"fixture-reservation\",\"roomId\":\"fixture-room\",\"status\":\"reserved\",\"version\":1},{\"reservationId\":\"post-probe\",\"roomId\":\"post-room\",\"status\":\"reserved\",\"version\":1}]";
    added.data.reservationList.body.totalCount = 2;
    added.data.listQuery.body.resultJson = "{\"count\":2,\"scope\":\"fixture\",\"nested\":{\"count\":7}}";
    expect(assertWitnessStable(witness(), added, expected).dataPreservation.countDelta.reservations).toBe(1);
    const missing = witness();
    missing.data.reservationList.body.itemsJson = "[]";
    expect(() => assertWitnessStable(witness(), missing, expected)).toThrow("reservation list missing");
    const changedHead = witness();
    changedHead.data.eventHeads.rooms["fixture-room"] = "suid-changed";
    expect(() => assertWitnessStable(witness(), changedHead, expected)).toThrow("event heads changed");
    const changedNestedCount = witness();
    changedNestedCount.data.listQuery.body.resultJson = "{\"count\":1,\"scope\":\"fixture\",\"nested\":{\"count\":8}}";
    expect(() => assertWitnessStable(witness(), changedNestedCount, expected)).toThrow("list query changed");
    const missingItems = witness();
    Reflect.deleteProperty(missingItems.data.reservationList.body, "itemsJson");
    expect(() => assertWitnessStable(witness(), missingItems, expected)).toThrow("items are missing");
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

  it("keeps the Queue consumer on the primary and deploys the receiver with no consumer block", () => {
    const receiverDeployConfig = JSON.parse(receiverDeployConfigText);
    const primaryConfig = JSON.parse(primaryDeployConfigText);
    expect(receiverDeployConfig.queues).toBeUndefined();
    expect(primaryConfig.queues.consumers).toHaveLength(1);
    expect(deployScriptText).toContain("wrangler.meeting-room-doorbell-production.jsonc");
    const primary = "sekiban-dcb-meeting-room-cloudflare-only";
    const receiver = "sekiban-dcb-meeting-room-doorbell";
    expect(needsReceiverConsumerRemoval([{ script: receiver }, { script: primary }], receiver, primary)).toBe(true);
    expect(assertPrimaryConsumerExclusive([{ script: primary }], receiver, primary).consumerCount).toBe(1);
    expect(() => assertPrimaryConsumerExclusive([{ script: receiver }, { script: primary }], receiver, primary)).toThrow("must not be a Queue consumer");
  });

});
